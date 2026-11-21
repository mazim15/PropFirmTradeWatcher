import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOpenRows, dispatch, goldClosed, openPositionsIn, setLotFromInput, startCommandPoller, type DispatchDeps, type SetInputArgs, type SetInputResult, type SetLotResult, type WatcherCommand } from './copierCommands';

const cmd = (p: Partial<WatcherCommand> = {}): WatcherCommand => ({
  id: 'c1', watcherId: 'w1', type: 'setReceiverLot', status: 'claimed',
  payload: { accountNumber: '12150589', channel: 'FN2', lot: 0.24, propLogin: '12150589', brokerLogin: '13003534' },
  createdAt: '2026-11-21T10:00:00Z', claimedAt: '2026-11-21T10:00:01Z', finishedAt: null, result: null, error: null, ...p,
});

const okInput = (set: Record<string, string>): SetInputResult => ({ ok: true, before: {}, after: set, chartFile: null, step: null, error: null });
const failInput = (step: string, error: string): SetInputResult => ({ ok: false, before: null, after: null, chartFile: null, step, error });

function fakes(o: { open?: Record<string, number | null>; setLot?: SetLotResult; setInput?: SetInputResult[]; kept?: string | null } = {}) {
  const calls = { setLot: 0, rescan: 0, order: [] as string[], posted: [] as Array<{ id: string; body: { status: string; result?: object; error?: string } }>,
                  setInput: [] as SetInputArgs[], attach: [] as Array<Parameters<DispatchDeps['runAttach']>[0]> };
  const inputs = [...(o.setInput ?? [])];
  const deps: DispatchDeps = {
    openPositions: async login => (o.open && login in o.open ? o.open[login] : 0),
    runSetLot: async () => { calls.setLot++; return o.setLot ?? { ok: true, oldLot: 0.23, newLot: 0.24, chartFile: 'chart06.chr', step: null, error: null }; },
    runSetInput: async a => { calls.setInput.push(a); return inputs.shift() ?? okInput(a.set); },
    runAttach: async a => { calls.attach.push(a); return { ok: true, step: null, error: null }; },
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

test('set lot success posts done with old and new lot, then rescans', async () => {
  const { deps, calls } = fakes();
  await dispatch(cmd(), deps);
  assert.equal(calls.setLot, 1);
  assert.deepEqual(calls.posted, [{ id: 'c1', body: { status: 'done', result: { oldLot: 0.23, newLot: 0.24 } } }]);
  assert.deepEqual(calls.order, ['post', 'rescan']); // result first: a scan can take minutes
});

test('set lot read-back mismatch posts failed with the step and still rescans', async () => {
  const { deps, calls } = fakes({ setLot: { ok: false, oldLot: 0.23, newLot: 0.23, chartFile: null, step: 'read-back', error: 'READ-BACK MISMATCH' } });
  await dispatch(cmd(), deps);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'read-back: READ-BACK MISMATCH');
  assert.equal(calls.rescan, 1);
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

test('set lot does not wait for the follow-up rescan, so the poller can claim the next command', async () => {
  const { deps, calls } = fakes();
  let finishScan: () => void = () => undefined;
  deps.rescan = () => { calls.rescan++; return new Promise<void>(r => { finishScan = r; }); };
  await dispatch(cmd(), deps); // would hang if it awaited the scan
  assert.equal(calls.rescan, 1);
  assert.equal(calls.posted[0].body.status, 'done');
  finishScan();
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
  assert.equal(calls.rescan, 1);
});

test('rename restores the receiver when the sender fails', async () => {
  const { deps, calls } = fakes({ setInput: [okInput({ Channel: 'FN2T' }), failInput('find', 'Expert List did not open')] });
  await dispatch(rename(), deps);
  assert.deepEqual(calls.setInput[2], { role: 'receiver', channel: 'FN2T', set: { Channel: 'FN2' } });
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.posted[0].body.error, 'sender: find: Expert List did not open (receiver restored)');
  assert.equal(calls.rescan, 1);
});

test('rename reports a mismatch when the restore also fails', async () => {
  const { deps, calls } = fakes({ setInput: [okInput({ Channel: 'FN2T' }), failInput('ok', 'x'), failInput('find', 'y')] });
  await dispatch(rename(), deps);
  assert.equal(calls.posted[0].body.error, 'MISMATCH: receiver FN2T, sender FN2');
  assert.equal(calls.rescan, 1);
});

test('rename fails on the receiver step without touching the sender', async () => {
  const { deps, calls } = fakes({ setInput: [failInput('find', 'no receiver with channel FN2')] });
  await dispatch(rename(), deps);
  assert.equal(calls.setInput.length, 1);
  assert.equal(calls.posted[0].body.error, 'receiver: find: no receiver with channel FN2');
  assert.equal(calls.rescan, 1);
});

test('rename with an open trade fails without running a script', async () => {
  const { deps, calls } = fakes({ open: { '13003534': 1 } });
  await dispatch(rename(), deps);
  assert.equal(calls.setInput.length, 0);
  assert.equal(calls.posted[0].body.error, 'Open trade or no fresh trade data');
  assert.equal(calls.rescan, 1);
});

test('attach exporter runs even with an open trade', async () => {
  const { deps, calls } = fakes({ open: { '12150589': 1 } });
  await dispatch(repair('attachExporter'), deps);
  assert.deepEqual(calls.attach, [{ login: '12150589', ea: 'exporter' }]);
  assert.equal(calls.posted[0].body.status, 'done');
  assert.equal(calls.rescan, 1);
});

test('attach sender passes the kept settings file when there is one', async () => {
  const kept = fakes({ kept: 'C:\\sets\\12150589-sender.set' });
  await dispatch(repair('attachSender', { newChannel: 'Areeb' }), kept.deps);
  assert.deepEqual(kept.calls.attach, [{ login: '12150589', ea: 'sender', channel: 'Areeb', baseSet: 'C:\\sets\\12150589-sender.set' }]);
  assert.equal(kept.calls.rescan, 1);
  const none = fakes({ kept: null });
  await dispatch(repair('attachSender', { newChannel: 'Areeb' }), none.deps);
  assert.equal(none.calls.attach[0].baseSet, undefined);
  assert.equal(none.calls.rescan, 1);
});

test('point sender with an open trade fails without running a script', async () => {
  const { deps, calls } = fakes({ open: { '12150589': 1 } });
  await dispatch(repair('pointSender', { newChannel: 'Areeb' }), deps);
  assert.equal(calls.setInput.length, 0);
  assert.equal(calls.posted[0].body.status, 'failed');
  assert.equal(calls.rescan, 1);
});

test('point sender sets the sender channel; invert on sets the receiver', async () => {
  const a = fakes();
  await dispatch(repair('pointSender', { newChannel: 'Areeb' }), a.deps);
  assert.deepEqual(a.calls.setInput, [{ role: 'sender', login: '12150589', set: { Channel: 'Areeb' } }]);
  assert.equal(a.calls.rescan, 1);
  const b = fakes();
  await dispatch(repair('invertOn', { channel: 'FN2' }), b.deps);
  assert.deepEqual(b.calls.setInput, [{ role: 'receiver', channel: 'FN2', set: { InvertTrades: 'true' } }]);
  assert.equal(b.calls.posted[0].body.status, 'done');
  assert.equal(b.calls.rescan, 1);
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
  assert.equal(calls.rescan, 1);
});

test('rename reports a mismatch when a live receiver change cannot be restored', async () => {
  const live: SetInputResult = { ok: false, before: { Channel: 'FN2' }, after: { Channel: 'FN2T' }, chartFile: null, step: 'persist', error: 'x' };
  const { deps, calls } = fakes({ setInput: [live, failInput('find', 'y')] });
  await dispatch(rename(), deps);
  assert.equal(calls.posted[0].body.error, 'MISMATCH: receiver FN2T, sender FN2');
});
