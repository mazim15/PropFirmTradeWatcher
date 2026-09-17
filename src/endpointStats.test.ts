import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointStats, TRACKED_ENDPOINTS } from './endpointStats';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('an endpoint that is never called still has a row saying so', () => {
  // The whole reason this module exists: a missing row and a zero row look
  // identical in a table, and only the zero row is evidence.
  const s = new EndpointStats();
  const snap = s.snapshot();
  assert.equal(snap.length, TRACKED_ENDPOINTS.length);

  const state = snap.find(e => e.path === '/api/accounts/state')!;
  assert.equal(state.neverCalled, true);
  assert.equal(state.calls24h, 0);
  assert.equal(state.lastOkAt, null);
});

test('account lookups collapse onto one row instead of one row per account', () => {
  const s = new EndpointStats();
  s.record('/api/accounts/match-by-number/5241188', true);
  s.record('/api/accounts/match-by-number/130159224', true);
  s.record('/api/accounts/match-by-number/4418203', true);

  const row = s.snapshot().find(e => e.path === '/api/accounts/match-by-number')!;
  assert.equal(row.calls24h, 3);
  assert.equal(s.snapshot().length, TRACKED_ENDPOINTS.length);
});

test('a failure records the error without clearing the last success', () => {
  const c = clock();
  const s = new EndpointStats(c.now);
  s.record('/api/import/batch', true);
  const okAt = c.now();

  c.advance(1000);
  s.record('/api/import/batch', false, 'connect ETIMEDOUT');

  const row = s.snapshot().find(e => e.path === '/api/import/batch')!;
  assert.equal(row.lastOkAt, okAt);
  assert.equal(row.lastError, 'connect ETIMEDOUT');
  assert.equal(row.fails24h, 1);
  assert.equal(row.calls24h, 2);
  assert.equal(row.neverCalled, false);
});

test('calls older than 24 hours fall out of the count', () => {
  const c = clock();
  const s = new EndpointStats(c.now);
  for (let i = 0; i < 5; i++) {
    s.record('/api/watcher/heartbeat', true);
    c.advance(60 * 60 * 1000);
  }
  assert.equal(s.snapshot().find(e => e.path === '/api/watcher/heartbeat')!.calls24h, 5);

  c.advance(24 * 60 * 60 * 1000);
  const row = s.snapshot().find(e => e.path === '/api/watcher/heartbeat')!;
  assert.equal(row.calls24h, 0);
  // Still not "never called" — it ran, it just ran a while ago.
  assert.equal(row.neverCalled, false);
});

test('the sparkline always has 24 hourly buckets, oldest first', () => {
  const c = clock();
  const s = new EndpointStats(c.now);
  s.record('/api/import/open-trades', true);
  c.advance(2 * 60 * 60 * 1000);
  s.record('/api/import/open-trades', true);
  s.record('/api/import/open-trades', true);

  const row = s.snapshot().find(e => e.path === '/api/import/open-trades')!;
  assert.equal(row.buckets.length, 24);
  assert.equal(row.buckets[row.buckets.length - 1], 2);
  assert.equal(row.buckets[row.buckets.length - 3], 1);
});

test('an unknown URL is ignored rather than inventing a row', () => {
  const s = new EndpointStats();
  s.record('/api/something/else', true);
  assert.equal(s.totalCalls24h(), 0);
  assert.equal(EndpointStats.normalise('/api/something/else'), null);
});

test('query strings and trailing slashes do not split a row in two', () => {
  const s = new EndpointStats();
  s.record('/api/settings/symbol-map?fresh=1', true);
  s.record('/api/settings/symbol-map/', true);
  assert.equal(s.snapshot().find(e => e.path === '/api/settings/symbol-map')!.calls24h, 2);
});
