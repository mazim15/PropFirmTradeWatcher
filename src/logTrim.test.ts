import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { trimLog } from './logTrim';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'a.log');

test('a log over the limit keeps its newest whole lines', () => {
  const f = tmp();
  fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')}\n`).join('')); // 9 bytes each
  assert.equal(trimLog(f, 500, 100), true);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  assert.equal(lines[0], 'line 089');
  assert.equal(lines[lines.length - 2], 'line 099');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['a.log']);
});

test('a log under the limit, or missing, is left alone', () => {
  const f = tmp();
  assert.equal(trimLog(f, 500, 100), false);
  fs.writeFileSync(f, 'x\n');
  assert.equal(trimLog(f, 500, 100), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'x\n');
});
