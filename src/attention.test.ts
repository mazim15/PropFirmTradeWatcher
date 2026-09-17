import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionCenter } from './attention';
import { AccountHealthTracker } from './accountHealth';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Health with one account whose open-trade feed has gone cold. */
function staleHealth(c: ReturnType<typeof clock>) {
  const h = new AccountHealthTracker(c.now);
  h.link('130174565', { id: 'a', name: 'Alpha Capital 50K', accountType: 'Prop' });
  h.recordFeed('130174565', 'closed');
  h.recordFeed('130174565', 'open');
  h.recordFeed('130174565', 'state');
  c.advance(3 * 60 * 1000);
  h.recordFeed('130174565', 'closed');
  h.recordFeed('130174565', 'state');
  return h;
}

test('an unmatched account is raised as severe and names the held count', () => {
  const a = new AttentionCenter();
  a.unmatchedAccount('9903471', 6, 'C:\\Common\\Files', 'balance 24918.40');

  const { open } = a.snapshot([]);
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, 'severe');
  assert.equal(open[0].heldFiles, 6);
  assert.match(open[0].title, /9903471/);
  assert.match(open[0].detail, /6 files held/);
  assert.ok(open[0].actions.includes('link'));
});

test('the same problem seen twice keeps its original raise time', () => {
  const c = clock();
  const a = new AttentionCenter(c.now);
  a.unmatchedAccount('9903471', 1, 'C:\\x');
  const raisedAt = a.snapshot([]).open[0].at;

  c.advance(60 * 60 * 1000);
  a.unmatchedAccount('9903471', 7, 'C:\\x');

  const { open } = a.snapshot([]);
  assert.equal(open.length, 1, 'must not stack one card per file');
  assert.equal(open[0].at, raisedAt, 'so the operator can see how long it has run');
  assert.equal(open[0].heldFiles, 7, 'but the count is current');
});

test('a stale feed is derived from health rather than stored', () => {
  const c = clock();
  const h = staleHealth(c);
  const a = new AttentionCenter(c.now);

  let open = a.snapshot(h.snapshot()).open;
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'stale-feed');
  assert.match(open[0].title, /Alpha Capital 50K/);
  assert.match(open[0].detail, /Reattaching the EA/);

  // The EA is reattached and the feed comes back. Nothing had to remember to
  // retract the warning — it simply stops being derived.
  h.recordFeed('130174565', 'open');
  open = a.snapshot(h.snapshot()).open;
  assert.equal(open.length, 0);
});

test('muting a derived item hides it without losing the underlying fault', () => {
  const c = clock();
  const h = staleHealth(c);
  const a = new AttentionCenter(c.now);

  const id = a.snapshot(h.snapshot()).open[0].id;
  a.mute(id, 60 * 60 * 1000);
  assert.equal(a.snapshot(h.snapshot()).open.length, 0);

  // Health still reports the account as stale — only the alert is muted.
  assert.equal(h.snapshot()[0].status, 'stale');

  c.advance(61 * 60 * 1000);
  assert.equal(a.snapshot(h.snapshot()).open.length, 1, 'the mute expires');
});

test('resolving moves an item to the record instead of deleting it', () => {
  const a = new AttentionCenter();
  a.unmatchedAccount('9903471', 2, 'C:\\x');
  assert.equal(a.resolve('unmatched:9903471'), true);

  const { open, resolved } = a.snapshot([]);
  assert.equal(open.length, 0);
  assert.equal(resolved.length, 1);
  assert.notEqual(resolved[0].resolvedAt, null);
});

test('resolving something that was never raised is a no-op, not a crash', () => {
  const a = new AttentionCenter();
  assert.equal(a.resolve('unmatched:does-not-exist'), false);
});

test('severe items sort above warnings', () => {
  const c = clock();
  const a = new AttentionCenter(c.now);
  a.truncatedFile('111', 'trades_111_latest.csv');
  c.advance(1000);
  a.unmatchedAccount('9903471', 1, 'C:\\x');

  const { open } = a.snapshot([]);
  assert.equal(open[0].kind, 'unmatched-account');
  assert.equal(open[1].kind, 'truncated-file');
});

test('a healthy desk produces nothing at all', () => {
  const c = clock();
  const h = new AccountHealthTracker(c.now);
  h.link('1', { id: 'a', name: 'Fine' });
  h.recordFeed('1', 'closed');
  h.recordFeed('1', 'open');
  h.recordFeed('1', 'state');

  const a = new AttentionCenter(c.now);
  const { open, resolved } = a.snapshot(h.snapshot());
  assert.equal(open.length, 0);
  assert.equal(resolved.length, 0);
});
