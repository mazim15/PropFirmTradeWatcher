import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countOpenRows, dispatch, goldClosed, openPositionsIn, setLotFromInput, startCommandPoller, type DispatchDeps, type SetInputArgs, type SetInputResult, type SetLotResult, type WatcherCommand } from './copierCommands';

const cmd = (p: Partial<WatcherCommand> = {}): WatcherCommand => ({
  id: 'c1', watcherId: 'w1', type: 'setReceiverLot', status: 'claimed',
  payload: { accountNumber: '12150589', channel: 'FN2', lot: 0.24, propLogin: '12150589', brokerLogin: '13003534' },
  createdAt: '2026-11-21T10:00:00Z', claimedAt: '2026-11-21T10:00:01Z', finishedAt: null, result: null, error: null, ...p,
});

const okInput = (set: Record<string, string>): SetInputResult => ({ ok: true, before: {}, after: set, chartFile: null, step: null, error: null });
const failInput = (step: string, error: string): SetInputResult => ({ ok: false, before: null, after: null, chartFile: null, step, error });

function fakes(o: { open?: Record<string, number | null>; setLot?: SetLotResult; setInput?: SetInputResult[]; kept?: string | null; openTerminal?: { ok: boolean; step: string | null; error: string | null } } = {}) {
  const calls = { setLot: 0, rescan: 0, order: [] as string[], posted: [] as Array<{ id: string; body: { status: string; result?: object; error?: string } }>,
                  setInput: [] as SetInputArgs[], attach: [] as Array<Parameters<DispatchDeps['runAttach']>[0]>, opened: [] as string[], waits: 0 };
  const inputs = [...(o.setInput ?? [])];
  const deps: DispatchDeps = {
    openPositions: async login => (o.open && login in o.open ? o.open[login] : 0),
    runSetLot: async () => { calls.setLot++; return o.setLot ?? { ok: true, oldLot: 0.23, newLot: 0.24, chartFile: 'chart06.chr', step: null, error: null }; },
    runSetInput: async a => { calls.setInput.push(a); return inputs.shift() ?? okInput(a.set); },
    runAttach: async a => { calls.attach.push(a); return { ok: true, step: null, error: null }; },
    runOpenTerminal: async login => { calls.opened.push(login); return o.openTerminal ?? { ok: true, step: null, error: null }; },
    wait: async () => { calls.waits++; },
    keptSenderSet: () => (o.kept === undefined ? null : o.kept),
    rescan: async () => { calls.rescan++; calls.order.push('rescan'); },
    postResult: async (id, body) => { calls.posted.push({ id, body }); calls.order.push('post'); return true; },
  };
  return { deps, calls };
}

test('rescan command rescans and reports done', async () => {
  const { deps, calls } = fakes();
  await dispatch(cmd({ type: 'rescan', payload: {} }), deps);
  assert.equal(calls.rescan, 1);
  assert.deepEqual(calls.posted, [{ id: 'c1', body: { status: 'done' } }]);
});

test('set lot with an open prop trade fails without running the script', async () => {
  const { deps, calls } = fakes({ open: { '12150589': 1 } });
  await dispatch(cmd(), deps);
  assert.equal(calls.setLot, 0);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'Open trade or no fresh trade data');
});

test('set lot with no fresh trade data fails without running the script', async () => {
  const { deps, calls } = fakes({ open: { '13003534': null } });
  await dispatch(cmd(), deps);
  assert.equal(calls.setLot, 0);
  assert.equal(calls.posted[0].body.status, 'failed');
});

test('set lot success posts done with old and new lot and does not rescan', async () => {
  const { deps, calls } = fakes();
  await dispatch(cmd(), deps);
  assert.equal(calls.setLot, 1);
  assert.deepEqual(calls.posted, [{ id: 'c1', body: { status: 'done', result: { oldLot: 0.23, newLot: 0.24 } } }]);
  assert.deepEqual(calls.order, ['post']); // only the Rescan button scans
});

test('set lot read-back mismatch posts failed with the step', async () => {
  const { deps, calls } = fakes({ setLot: { ok: false, oldLot: 0.23, newLot: 0.23, chartFile: null, step: 'read-back', error: 'READ-BACK MISMATCH' } });
  await dispatch(cmd(), deps);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'read-back: READ-BACK MISMATCH');
  assert.equal(calls.rescan, 0);
  assert.equal(calls.setLot, 1); // never retried
});

test('a throwing dispatch posts failed with the message', async () => {
  const { deps, calls } = fakes();
  deps.runSetLot = async () => { throw new Error('powershell exploded'); };
  await dispatch(cmd(), deps);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'powershell exploded');
});

test('unknown command type fails', async () => {
  const { deps, calls } = fakes();
  await dispatch(cmd({ type: 'boom' as WatcherCommand['type'] }), deps);
  assert.deepEqual(calls.posted, [{ id: 'c1', body: { status: 'failed', error: 'Unknown command' } }]);
});

test('startCommandPoller handles commands one at a time', async () => {
  const log: string[] = [];
  let served = false;
  const stop = startCommandPoller(
    async () => { if (served) return []; served = true; return [cmd({ id: 'a' }), cmd({ id: 'b' })]; },
    async c => { log.push(`start ${c.id}`); await new Promise(r => setTimeout(r, 30)); log.push(`end ${c.id}`); },
    5,
  );
  await new Promise(r => setTimeout(r, 120));
  stop();
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
});

test('countOpenRows counts data rows after the header', () => {
  const head = '# Open Trades Export\n# Account Number,1\n\nTicket,OpenTime,Type,Size,Symbol,OpenPrice,StopLoss,TakeProfit,CurrentPrice,Commission,Swap,UnrealizedPnl,Comment,Status,Magic\n';
  assert.equal(countOpenRows(head), 0);
  assert.equal(countOpenRows(head + '123,2026.11.21,buy,0.1,XAUUSD,1,0,0,1,0,0,0,,Open,0\n\n'), 1);
  assert.equal(countOpenRows('garbage'), null);
});

test('openPositionsIn: fresh file required while gold is open, last file trusted while closed', () => {
  const fs = require('fs') as typeof import('fs'); const os = require('os') as typeof import('os'); const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
  const head = 'Ticket,OpenTime,Type,Size,Symbol,OpenPrice,StopLoss,TakeProfit,CurrentPrice,Commission,Swap,UnrealizedPnl,Comment,Status,Magic\n';
  const write = (login: string, rows: number, writtenIso: string) => {
    const f = path.join(dir, `open_trades_${login}_latest.csv`);
    fs.writeFileSync(f, head + '1,x,buy,0.1,XAUUSD,1,0,0,1,0,0,0,,Open,0\n'.repeat(rows));
    const t = new Date(writtenIso); fs.utimesSync(f, t, t);
  };
  const friClose = '2026-11-20T21:59:00Z';
  write('flat', 0, friClose);
  write('open', 1, friClose);
  write('old', 0, '2026-11-13T21:59:00Z');
  const sat = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(openPositionsIn([dir], 'flat', sat), 0);             // closed: last file trusted
  assert.equal(openPositionsIn([dir], 'open', sat), 1);             // closed, but it shows a trade
  assert.equal(openPositionsIn([dir], 'old', sat), null);           // closed, file from last week
  assert.equal(openPositionsIn([dir], 'flat', Date.parse('2026-11-23T10:00:00Z')), null); // Monday: stale
  assert.equal(openPositionsIn([dir], 'flat', Date.parse('2026-11-27T21:00:00Z')), null); // next Fri before 22:00 UTC: still open, file stale
  assert.equal(openPositionsIn([dir], 'missing', sat), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('goldClosed covers Fri 22:00 to Sun 22:00 UTC only', () => {
  assert.equal(goldClosed(Date.parse('2026-11-20T21:59:00Z')), false);
  assert.equal(goldClosed(Date.parse('2026-11-20T22:00:00Z')), true);
  assert.equal(goldClosed(Date.parse('2026-11-21T12:00:00Z')), true);
  assert.equal(goldClosed(Date.parse('2026-11-22T21:59:00Z')), true);
  assert.equal(goldClosed(Date.parse('2026-11-22T22:00:00Z')), false);
  assert.equal(goldClosed(Date.parse('2026-11-18T12:00:00Z')), false);
});

test('setLotFromInput maps the set-input result to old and new lot', () => {
  assert.deepEqual(
    setLotFromInput({ ok: true, before: { UseFixedLotSize: '0.23' }, after: { UseFixedLotSize: '0.24' }, chartFile: 'chart06.chr', step: null, error: null }),
    { ok: true, oldLot: 0.23, newLot: 0.24, chartFile: 'chart06.chr', step: null, error: null },
  );
  assert.deepEqual(
    setLotFromInput({ ok: false, before: null, after: null, chartFile: null, step: 'find', error: 'no receiver with channel FN2' }),
    { ok: false, oldLot: null, newLot: null, chartFile: null, step: 'find', error: 'no receiver with channel FN2' },
  );
});

const rename = (p: Partial<WatcherCommand> = {}) => cmd({
  type: 'renameChannel',
  payload: { accountNumber: '12150589', oldChannel: 'FN2', newChannel: 'FN2T', propLogin: '12150589', brokerLogin: '13003534' }, ...p,
});
const repair = (action: NonNullable<WatcherCommand['payload']['action']>, extra: Partial<WatcherCommand['payload']> = {}) => cmd({
  type: 'repair', payload: { accountNumber: '12150589', action, propLogin: '12150589', brokerLogin: '13003534', ...extra },
});

test('rename changes the receiver then the sender', async () => {
  const { deps, calls } = fakes();
  await dispatch(rename(), deps);
  assert.deepEqual(calls.setInput, [
    { role: 'receiver', channel: 'FN2', set: { Channel: 'FN2T' } },
    { role: 'sender', login: '12150589', set: { Channel: 'FN2T' } },
  ]);
  assert.equal(calls.posted[0].body.status, 'done');
  assert.equal(calls.rescan, 0);
});

test('rename restores the receiver when the sender fails', async () => {
  const { deps, calls } = fakes({ setInput: [okInput({ Channel: 'FN2T' }), failInput('find', 'Expert List did not open')] });
  await dispatch(rename(), deps);
  assert.deepEqual(calls.setInput[2], { role: 'receiver', channel: 'FN2T', set: { Channel: 'FN2' } });
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'sender: find: Expert List did not open (receiver restored)');
  assert.equal(calls.rescan, 0);
});

test('rename reports a mismatch when the restore also fails', async () => {
  const { deps, calls } = fakes({ setInput: [okInput({ Channel: 'FN2T' }), failInput('ok', 'x'), failInput('find', 'y')] });
  await dispatch(rename(), deps);
  assert.equal(calls.posted[0].body.error, 'MISMATCH: receiver FN2T, sender FN2');
  assert.equal(calls.rescan, 0);
});

test('rename fails on the receiver step without touching the sender', async () => {
  const { deps, calls } = fakes({ setInput: [failInput('find', 'no receiver with channel FN2')] });
  await dispatch(rename(), deps);
  assert.equal(calls.setInput.length, 1);
  assert.equal(calls.posted[0].body.error, 'receiver: find: no receiver with channel FN2');
  assert.equal(calls.rescan, 0);
});

test('rename with an open trade fails without running a script', async () => {
  const { deps, calls } = fakes({ open: { '13003534': 1 } });
  await dispatch(rename(), deps);
  assert.equal(calls.setInput.length, 0);
  assert.equal(calls.posted[0].body.error, 'Open trade or no fresh trade data');
  assert.equal(calls.rescan, 0);
});

test('attach exporter runs even with an open trade', async () => {
  const { deps, calls } = fakes({ open: { '12150589': 1 } });
  await dispatch(repair('attachExporter'), deps);
  assert.deepEqual(calls.attach, [{ login: '12150589', ea: 'exporter' }]);
  assert.equal(calls.posted[0].body.status, 'done');
  assert.equal(calls.rescan, 0);
});

test('attach sender passes the kept settings file when there is one', async () => {
  const kept = fakes({ kept: 'C:\\sets\\12150589-sender.set' });
  await dispatch(repair('attachSender', { newChannel: 'Areeb' }), kept.deps);
  assert.deepEqual(kept.calls.attach, [{ login: '12150589', ea: 'sender', channel: 'Areeb', baseSet: 'C:\\sets\\12150589-sender.set' }]);
  assert.equal(kept.calls.rescan, 0);
});

test('point sender with an open trade fails without running a script', async () => {
  const { deps, calls } = fakes({ open: { '12150589': 1 } });
  await dispatch(repair('pointSender', { newChannel: 'Areeb' }), deps);
  assert.equal(calls.setInput.length, 0);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.rescan, 0);
});

test('point sender sets the sender channel; invert on sets the receiver', async () => {
  const a = fakes();
  await dispatch(repair('pointSender', { newChannel: 'Areeb' }), a.deps);
  assert.deepEqual(a.calls.setInput, [{ role: 'sender', login: '12150589', set: { Channel: 'Areeb' } }]);
  assert.equal(a.calls.rescan, 0);
  const b = fakes();
  await dispatch(repair('invertOn', { channel: 'FN2' }), b.deps);
  assert.deepEqual(b.calls.setInput, [{ role: 'receiver', channel: 'FN2', set: { InvertTrades: 'true' } }]);
  assert.equal(b.calls.posted[0].body.status, 'done');
  assert.equal(b.calls.rescan, 0);
});

test('rename restores the receiver when its own step fails after the change went live', async () => {
  const live: SetInputResult = { ok: false, before: { Channel: 'FN2' }, after: { Channel: 'FN2T' }, chartFile: null, step: 'persist', error: 'no chart file' };
  const { deps, calls } = fakes({ setInput: [live] });
  await dispatch(rename(), deps);
  assert.deepEqual(calls.setInput, [
    { role: 'receiver', channel: 'FN2', set: { Channel: 'FN2T' } },
    { role: 'receiver', channel: 'FN2T', set: { Channel: 'FN2' } },
  ]);
  assert.equal(calls.posted[0].body.error, 'receiver: persist: no chart file (receiver restored)');
  assert.equal(calls.rescan, 0);
});

test('rename reports a mismatch when a live receiver change cannot be restored', async () => {
  const live: SetInputResult = { ok: false, before: { Channel: 'FN2' }, after: { Channel: 'FN2T' }, chartFile: null, step: 'persist', error: 'x' };
  const { deps, calls } = fakes({ setInput: [live, failInput('find', 'y')] });
  await dispatch(rename(), deps);
  assert.equal(calls.posted[0].body.error, 'MISMATCH: receiver FN2T, sender FN2');
});

test('countOpenRows skips only the tickets the server proved belong to other accounts', () => {
  const csv = 'Ticket;OpenTime;Type;Size\n900001;x;buy;0.06\n900002;x;sell;0.23\n';
  assert.equal(countOpenRows(csv), 2);
  assert.equal(countOpenRows(csv, ['900001']), 1);
  assert.equal(countOpenRows(csv, ['900001', '900002']), 0);
  assert.equal(countOpenRows(csv, ['90000']), 2);
  assert.equal(countOpenRows(csv.replace(/;/g, '\t'), ['900001', '900002']), 0); // older exporters use tabs
});

const asked = (type: WatcherCommand['type'], payload: WatcherCommand['payload']) => {
  const { deps, calls } = fakes();
  const seen: Record<string, string[] | undefined> = {};
  deps.openPositions = async (login, ignore) => { seen[login] = ignore; return 0; };
  return { seen, calls, done: dispatch(cmd({ type, payload }), deps) };
};

test('set lot ignores other accounts broker tickets, on the broker login only', async () => {
  const { seen, calls, done } = asked('setReceiverLot', { ...cmd().payload, otherTickets: ['9'] });
  await done;
  assert.deepEqual(seen, { '12150589': undefined, '13003534': ['9'] });
  assert.equal(calls.setLot, 1);
});

test('point sender still needs the whole broker login flat', async () => {
  const { seen, done } = asked('repair', { action: 'pointSender', propLogin: '12150589', brokerLogin: '13003534', newChannel: 'A', otherTickets: ['9'] });
  await done;
  assert.equal(seen['13003534'], undefined);
});

test('open terminal reports done and rescans', async () => {
  const { deps, calls } = fakes();
  await dispatch(cmd({ type: 'openTerminal', payload: { accountNumber: '12150589' } }), deps);
  assert.deepEqual(calls.opened, ['12150589']);
  assert.equal(calls.posted[0].body.status, 'done');
  assert.equal(calls.rescan, 0);
});

test('open terminal passes on why the login failed', async () => {
  const { deps, calls } = fakes({ openTerminal: { ok: false, step: 'login', error: 'authorization on X failed (Invalid account)' } });
  await dispatch(cmd({ type: 'openTerminal', payload: { accountNumber: '12150589' } }), deps);
  assert.deepEqual(calls.posted[0].body, { status: 'failed', error: 'login: authorization on X failed (Invalid account)' });
});

test('open terminal refuses a non-digit account number', async () => {
  const { deps, calls } = fakes();
  for (const accountNumber of [undefined, '', '12 & calc', 'C:\\x.exe']) {
    await dispatch(cmd({ type: 'openTerminal', payload: { accountNumber } }), deps);
  }
  assert.deepEqual(calls.opened, []);
  assert.ok(calls.posted.every(p => p.body.error === 'Bad command payload'));
});

const both = (extra: Partial<WatcherCommand['payload']> = {}) => cmd({ type: 'repair',
  payload: { accountNumber: '12150589', action: 'attachBoth', propLogin: '12150589', brokerLogin: '13003534', newChannel: 'FN2', ...extra } });

test('attach both: exporter first, then the sender once its trade data is back', async () => {
  const { deps, calls } = fakes({ kept: 'C:\\k.set' });
  let reads = 0;
  deps.openPositions = async login => (login === '12150589' && reads++ < 2 ? null : 0); // exporter's first file takes a moment
  await dispatch(both(), deps);
  assert.deepEqual(calls.attach.map(a => a.ea), ['exporter', 'sender']);
  assert.equal(calls.posted[0].body.status, 'done');
  assert.ok(calls.waits > 0);
});

test('attach both: an open trade keeps the sender off but the exporter stays', async () => {
  const { deps, calls } = fakes({ kept: 'C:\\k.set', open: { '12150589': 1 } });
  await dispatch(both(), deps);
  assert.deepEqual(calls.attach.map(a => a.ea), ['exporter']);
  assert.deepEqual(calls.posted[0].body, { status: 'failed', error: 'exporter attached; sender: Open trade or no fresh trade data' });
});

test('attach both: no trade data in time keeps the sender off', async () => {
  const { deps, calls } = fakes({ kept: 'C:\\k.set', open: { '12150589': null } });
  await dispatch(both(), deps);
  assert.deepEqual(calls.attach.map(a => a.ea), ['exporter']);
  assert.equal(calls.posted[0].body.status, 'failed');
});

test('a sender without kept settings is refused before anything is attached', async () => {
  for (const action of ['attachSender', 'attachBoth'] as const) {
    const { deps, calls } = fakes({ kept: null });
    await dispatch(both({ action }), deps);
    assert.deepEqual(calls.attach, []);
    assert.equal(calls.posted[0].body.error, 'No saved sender settings on this PC');
  }
});

test("attach sender ignores only the server's other-account tickets", async () => {
  const { deps } = fakes({ kept: 'C:\\k.set' });
  const seen: Array<string[] | undefined> = [];
  deps.openPositions = async (_l, ignore) => { seen.push(ignore); return 0; };
  await dispatch(both({ action: 'attachSender', otherTickets: ['1'] }), deps);
  assert.deepEqual(seen, [undefined, ['1']]);
});

test('attach both: an exporter file from before the attach does not prove the account is flat', async () => {
  const { deps, calls } = fakes({ kept: 'C:\\k.set' });
  const sinces: Array<number | undefined> = [];
  const t0 = Date.now();
  deps.openPositions = async (login, _i, since) => { if (login === '12150589') sinces.push(since); return 0; };
  await dispatch(both(), deps);
  assert.ok(sinces.length >= 2 && sinces.every(s => s !== undefined && s >= t0));
  assert.equal(calls.posted[0].body.status, 'done');
});

test('openPositionsIn ignores a file older than `since`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-'));
  const f = path.join(dir, 'open_trades_7_latest.csv');
  fs.writeFileSync(f, 'Ticket,X\n');
  const m = fs.statSync(f).mtimeMs;
  assert.equal(openPositionsIn([dir], '7', m + 1000), 0);
  assert.equal(openPositionsIn([dir], '7', m + 1000, [], m + 1), null);
  fs.rmSync(dir, { recursive: true });
});
