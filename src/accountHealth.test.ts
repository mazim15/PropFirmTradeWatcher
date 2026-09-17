import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountHealthTracker, formatAge, DEFAULT_CADENCE_MS } from './accountHealth';

/** Clock we can drive forward, so staleness rules are testable in milliseconds. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('an account feeding all three exports is live', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('5241188', { id: 'acc1', name: 'FundingPips 25K', accountType: 'Prop' });
  h.recordFeed('5241188', 'closed');
  h.recordFeed('5241188', 'open');
  h.recordFeed('5241188', 'state');

  const [a] = h.snapshot();
  assert.equal(a.status, 'live');
  assert.equal(a.accountName, 'FundingPips 25K');
});

test('the open-trade feed going cold is caught while closed trades still look recent', () => {
  // This is the recurring MT4 fault: the trade stops updating until the EA is
  // reattached. A single "last seen" would stay green through it.
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('130174565', { id: 'acc2', name: 'Alpha Capital 50K', accountType: 'Prop' });
  h.recordFeed('130174565', 'closed');
  h.recordFeed('130174565', 'open');
  h.recordFeed('130174565', 'state');

  // Closed trades keep arriving on their own timer; open trades stop dead.
  for (let i = 0; i < 3; i++) {
    c.advance(DEFAULT_CADENCE_MS.closed);
    h.recordFeed('130174565', 'closed');
    h.recordFeed('130174565', 'state');
  }

  const [a] = h.snapshot();
  assert.equal(a.status, 'stale');
  assert.match(a.reason, /open-trade export \d+× overdue/);

  const open = a.feeds.find(f => f.kind === 'open')!;
  const closed = a.feeds.find(f => f.kind === 'closed')!;
  assert.equal(open.overdue, true);
  assert.equal(closed.overdue, false);
});

test('every feed gone at once reads as a closed terminal, not three EA faults', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('4418203', { id: 'acc3', name: 'Funded Next 50K', accountType: 'Prop' });
  h.recordFeed('4418203', 'closed');
  h.recordFeed('4418203', 'open');
  h.recordFeed('4418203', 'state');

  c.advance(16 * 60 * 60 * 1000);

  const [a] = h.snapshot();
  assert.equal(a.status, 'down');
  assert.match(a.reason, /terminal closed/);
});

test('a feed that never fired is reported as never sent, not as stale', () => {
  // An EA compiled before the account-state export existed sends two feeds
  // forever. That is a fact about the setup, not a fault that appeared, and
  // calling it stale would send the operator hunting the wrong thing.
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('7714902', { id: 'acc4', name: 'Blueberry Live', accountType: 'Broker' });
  h.recordFeed('7714902', 'closed');
  h.recordFeed('7714902', 'open');
  c.advance(6 * 60 * 60 * 1000);
  h.recordFeed('7714902', 'closed');
  h.recordFeed('7714902', 'open');

  const [a] = h.snapshot();
  assert.equal(a.status, 'live');
  assert.match(a.reason, /account-state never sent by the EA/);
  assert.equal(a.feeds.find(f => f.kind === 'state')!.lastAt, null);
});

test('cadence is learned from observed gaps, not assumed from EA defaults', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('1', { id: 'a', name: 'Slow EA' });

  // An EA configured to export every 5 minutes rather than the 30s default.
  const fiveMin = 5 * 60 * 1000;
  for (let i = 0; i < 5; i++) {
    h.recordFeed('1', 'open');
    c.advance(fiveMin);
  }
  h.recordFeed('1', 'open');

  // Two minutes late is nothing on a five-minute cadence, and would have been
  // four times overdue against the assumed 30s.
  c.advance(2 * 60 * 1000);
  const [a] = h.snapshot();
  const open = a.feeds.find(f => f.kind === 'open')!;
  assert.equal(open.cadenceMs, fiveMin);
  assert.equal(open.overdue, false);
});

test('one long outage does not permanently inflate the cadence estimate', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('2', { id: 'b' });

  for (let i = 0; i < 6; i++) {
    h.recordFeed('2', 'state');
    c.advance(60_000);
  }
  // Terminal off overnight.
  c.advance(8 * 60 * 60 * 1000);
  h.recordFeed('2', 'state');
  for (let i = 0; i < 4; i++) {
    c.advance(60_000);
    h.recordFeed('2', 'state');
  }

  const [a] = h.snapshot();
  // Median shrugs off the single 8h gap; a mean would have put the
  // expectation near an hour and hidden the next outage entirely.
  assert.equal(a.feeds.find(f => f.kind === 'state')!.cadenceMs, 60_000);
});

test('an unmatched account outranks everything and keeps its held file count', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('111', { id: 'ok', name: 'Healthy' });
  h.recordFeed('111', 'closed');
  h.recordFeed('111', 'open');
  h.recordFeed('111', 'state');

  h.recordFeed('9903471', 'closed');
  h.markUnmatched('9903471', 6);

  const snap = h.snapshot();
  assert.equal(snap[0].accountNumber, '9903471');
  assert.equal(snap[0].status, 'unmatched');
  assert.equal(snap[0].heldFiles, 6);
  assert.match(snap[0].reason, /no account in the web app/);
});

test('linking an account clears the unmatched state', () => {
  const h = new AccountHealthTracker();
  h.recordFeed('9903471', 'closed');
  h.markUnmatched('9903471', 3);
  assert.equal(h.snapshot()[0].status, 'unmatched');

  h.link('9903471', { id: 'new-id', name: 'Newly linked', accountType: 'Prop' });
  const [a] = h.snapshot();
  assert.notEqual(a.status, 'unmatched');
  assert.equal(a.accountId, 'new-id');
});

test('a state file arriving is tracked separately from the POST succeeding', () => {
  // The distinction that would have settled the balance investigation: file
  // present but never posted is a watcher fault; no file at all is the EA.
  const h = new AccountHealthTracker();
  h.link('5241188', { id: 'acc1' });
  h.recordFeed('5241188', 'state');

  let [a] = h.snapshot();
  assert.notEqual(a.feeds.find(f => f.kind === 'state')!.lastAt, null);
  assert.equal(a.statePostedAt, null);

  h.recordStatePosted('5241188');
  [a] = h.snapshot();
  assert.notEqual(a.statePostedAt, null);
});

test('duplicate chokidar events do not drag the cadence estimate to zero', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('3', { id: 'c' });
  for (let i = 0; i < 6; i++) {
    h.recordFeed('3', 'open');
    c.advance(10); // chokidar firing twice for one write
    h.recordFeed('3', 'open');
    c.advance(30_000);
  }
  const [a] = h.snapshot();
  assert.equal(a.feeds.find(f => f.kind === 'open')!.cadenceMs, 30_000);
});

test('formatAge stays compact across the range a table cell has to hold', () => {
  assert.equal(formatAge(null), 'never');
  assert.equal(formatAge(4_000), '4s');
  assert.equal(formatAge(6 * 60_000), '6m');
  assert.equal(formatAge(69 * 60_000), '1h 09m');
  assert.equal(formatAge(26 * 60 * 60_000), '1d 2h');
});

test('feedingCount is what the status strip shows', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  for (const n of ['1', '2', '3']) {
    h.link(n, { id: n });
    h.recordFeed(n, 'closed');
    h.recordFeed(n, 'open');
    h.recordFeed(n, 'state');
  }
  assert.deepEqual(h.feedingCount(), { feeding: 3, total: 3 });

  c.advance(60 * 60 * 1000);
  h.recordFeed('1', 'closed');
  h.recordFeed('1', 'open');
  h.recordFeed('1', 'state');
  assert.deepEqual(h.feedingCount(), { feeding: 1, total: 3 });
});
