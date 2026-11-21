import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOpenRows, dispatch, startCommandPoller, type DispatchDeps, type SetLotResult, type WatcherCommand } from './copierCommands';

const cmd = (p: Partial<WatcherCommand> = {}): WatcherCommand => ({
  id: 'c1', watcherId: 'w1', type: 'setReceiverLot', status: 'claimed',
  payload: { accountNumber: '12150589', channel: 'FN2', lot: 0.24, propLogin: '12150589', brokerLogin: '13003534' },
  createdAt: '2026-11-21T10:00:00Z', claimedAt: '2026-11-21T10:00:01Z', finishedAt: null, result: null, error: null, ...p,
});

function fakes(o: { open?: Record<string, number | null>; setLot?: SetLotResult } = {}) {
  const calls = { setLot: 0, rescan: 0, order: [] as string[], posted: [] as Array<{ id: string; body: { status: string; result?: object; error?: string } }> };
  const deps: DispatchDeps = {
    openPositions: async login => (o.open && login in o.open ? o.open[login] : 0),
    runSetLot: async () => { calls.setLot++; return o.setLot ?? { ok: true, oldLot: 0.23, newLot: 0.24, chartFile: 'chart06.chr', step: null, error: null }; },
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
