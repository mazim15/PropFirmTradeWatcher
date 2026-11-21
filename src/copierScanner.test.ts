import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCopierSchedule } from './copierScanner';

test('startCopierSchedule skips a tick while a run is in flight', async () => {
  let started = 0;
  const stop = startCopierSchedule(() => { started++; return new Promise(r => setTimeout(r, 50)); }, 10, 10);
  await new Promise(r => setTimeout(r, 45));
  assert.equal(started, 1);
  stop();
});
