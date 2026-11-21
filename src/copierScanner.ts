import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toEndpoints, type CopierEndpoint, type ScanOutput } from './copierScan';

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

/** Runs the bundled copier-scan script and turns its JSON into endpoint records. */
export async function runCopierScan(scriptPath: string, watcherId: string, pc: string): Promise<CopierEndpoint[]> {
  const outFile = path.join(os.tmpdir(), `copier-scan-${process.pid}-${Date.now()}.json`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-OutFile', outFile],
        { timeout: SCAN_TIMEOUT_MS, windowsHide: true },
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message}${stderr ? `: ${stderr.trim()}` : ''}`)) : resolve()),
      );
    });
    const raw = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '')) as ScanOutput;
    return toEndpoints({ ...raw, terminals: raw.terminals ?? [] }, watcherId, pc);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/** First run after `firstDelayMs`, then every `everyMs`; a tick is skipped while a run is still going. */
export function startCopierSchedule(run: () => Promise<void>, firstDelayMs = 180_000, everyMs = 86_400_000): () => void {
  let busy = false;
  let interval: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await run(); } catch { /* run logs its own errors */ } finally { busy = false; }
  };
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), everyMs);
  }, firstDelayMs);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
