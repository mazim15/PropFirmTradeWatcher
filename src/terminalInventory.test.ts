import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminal, type TerminalEntry } from './terminalInventory';

const term = (p: Partial<TerminalEntry> = {}): TerminalEntry =>
  ({ kind: 'mt5', path: 'C:\\MT5\\terminal64.exe', login: '12150589', running: false, lastUsed: '2026-11-20T00:00:00Z', ...p });

function fakes(...scans: TerminalEntry[][]) {
  const started: Array<[string, string]> = []; let posts = 0;
  return {
    started, posts: () => posts,
    deps: {
      inventory: async () => scans.length > 1 ? scans.shift()! : scans[0],
      start: async (path: string, login: string) => { started.push([path, login]); return { ok: true, step: null, error: null }; },
      post: async () => { posts++; },
      expired: () => false,
    },
  };
}

test('starts the closed terminal holding the login, newest used first, then posts the inventory', async () => {
  const f = fakes([term({ path: 'C:\\old' }), term({ path: 'C:\\new', lastUsed: '2026-11-23T00:00:00Z' }), term({ login: '5' })]);
  assert.equal((await openTerminal('12150589', f.deps)).ok, true);
  assert.deepEqual(f.started, [['C:\\new', '12150589']]);
  assert.equal(f.posts(), 1);
});

test('never starts a second copy when the login already runs', async () => {
  const f = fakes([term(), term({ path: 'D:\\x', running: true })]);
  assert.equal((await openTerminal('12150589', f.deps)).ok, true);
  assert.deepEqual(f.started, []);
  assert.equal(f.posts(), 1); // so the button goes
});

test('a command that waited too long is not started late', async () => {
  const f = fakes([term()]);
  f.deps.expired = () => true;
  assert.deepEqual(await openTerminal('12150589', f.deps), { ok: false, step: 'start', error: 'PC was busy, press Open again' });
  assert.deepEqual(f.started, []);
});

test('an unknown login is refused', async () => {
  const f = fakes([term()]);
  assert.deepEqual(await openTerminal('999', f.deps), { ok: false, step: 'find', error: 'No closed terminal for 999' });
  assert.deepEqual(f.started, []);
});

test('the inventory is posted even when the start fails', async () => {
  const f = fakes([term()]);
  f.deps.start = async () => { throw new Error('boom'); };
  await assert.rejects(openTerminal('12150589', f.deps), /boom/);
  assert.equal(f.posts(), 1);
});
