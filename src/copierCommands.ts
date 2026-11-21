import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Dashboard → watcher commands (set an FX Blue receiver's lot, rescan). The watcher
 * polls for claimed commands, runs them one at a time, posts the outcome and never retries.
 */

// Copied from the web app's app/utils/copierCommands.ts.
export type CommandType = 'setReceiverLot' | 'rescan';
export type CommandStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'expired';
export type WatcherCommand = {
  id: string; watcherId: string; type: CommandType; status: CommandStatus;
  payload: { accountNumber?: string; channel?: string; lot?: number;
             propLogin?: string; brokerLogin?: string };
  createdAt: string; claimedAt: string | null; finishedAt: string | null;
  result: { oldLot?: number; newLot?: number } | null; error: string | null;
};
/** What scripts/copier-set-lot.ps1 writes. */
export type SetLotResult = {
  ok: boolean; oldLot: number | null; newLot: number | null; chartFile: string | null;
  step: string | null; error: string | null;
};
export type ResultBody = { status: 'done' | 'failed'; result?: object; error?: string };
export type DispatchDeps = {
  openPositions(login: string): Promise<number | null>;
  runSetLot(channel: string, lot: number): Promise<SetLotResult>;
  rescan(): Promise<void>;
  postResult: (id: string, body: ResultBody) => Promise<boolean>;
};

const SET_LOT_TIMEOUT_MS = 3 * 60 * 1000;
const FRESH_TRADES_MS = 5 * 60 * 1000;

async function run(cmd: WatcherCommand, deps: DispatchDeps): Promise<ResultBody> {
  if (cmd.type === 'rescan') {
    await deps.rescan();
    return { status: 'done' };
  }
  if (cmd.type !== 'setReceiverLot') return { status: 'failed', error: 'Unknown command' };
  const { propLogin, brokerLogin, channel, lot } = cmd.payload;
  if (!propLogin || !brokerLogin || !channel || typeof lot !== 'number') {
    return { status: 'failed', error: 'Bad command payload' };
  }
  // Re-check just before touching MT4: the server's check may be seconds old.
  const [prop, broker] = await Promise.all([deps.openPositions(propLogin), deps.openPositions(brokerLogin)]);
  if (prop !== 0 || broker !== 0) return { status: 'failed', error: 'Open trade or no fresh trade data' };
  const r = await deps.runSetLot(channel, lot);
  if (r.ok) return { status: 'done', result: { oldLot: r.oldLot ?? undefined, newLot: r.newLot ?? undefined } };
  return { status: 'failed', error: `${r.step ?? 'unknown'}: ${r.error ?? 'failed'}` };
}

/**
 * Runs one command and posts its outcome. Never retries; a throw becomes `failed`.
 * After a lot change attempt, whatever the outcome, it rescans so the board shows the
 * real lot. The result is posted first: a scan can take minutes.
 */
export async function dispatch(cmd: WatcherCommand, deps: DispatchDeps): Promise<void> {
  let body: ResultBody;
  try {
    body = await run(cmd, deps);
  } catch (error) {
    body = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  await deps.postResult(cmd.id, body);
  if (cmd.type === 'setReceiverLot') await deps.rescan().catch(() => undefined);
}

/** Polls every `everyMs`; runs the returned commands one at a time, oldest first, and skips a tick while busy. */
export function startCommandPoller(
  fetch: () => Promise<WatcherCommand[]>, handle: (c: WatcherCommand) => Promise<void>, everyMs = 5000,
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cmds = await fetch();
      for (const c of [...cmds].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
        try { await handle(c); } catch { /* handle logs its own errors */ }
      }
    } catch { /* fetch returns [] on error */ } finally { busy = false; }
  };
  const interval = setInterval(() => void tick(), everyMs);
  void tick();
  return () => clearInterval(interval);
}

/** Data rows after the exporter's `Ticket,…` header; null when there is no header. */
export function countOpenRows(text: string): number | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const h = lines.findIndex(l => l.startsWith('Ticket'));
  if (h < 0) return null;
  return lines.slice(h + 1).filter(l => l.trim() && !l.startsWith('#')).length;
}

/** Open positions for a login from the newest open_trades_<login>_latest.csv; null if none is fresh. */
export function openPositionsIn(folders: string[], login: string, nowMs = Date.now()): number | null {
  let newest: { file: string; mtime: number } | null = null;
  for (const folder of folders) {
    const file = path.join(folder, `open_trades_${login.trim()}_latest.csv`);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch { /* not in this folder */ }
  }
  if (!newest || nowMs - newest.mtime > FRESH_TRADES_MS) return null;
  try { return countOpenRows(fs.readFileSync(newest.file, 'utf8')); } catch { return null; }
}

/** Runs the bundled copier-set-lot script. */
export async function runSetLotScript(scriptPath: string, channel: string, lot: number): Promise<SetLotResult> {
  const outFile = path.join(os.tmpdir(), `copier-set-lot-${process.pid}-${Date.now()}.json`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath,
          '-Channel', channel, '-Lot', lot.toFixed(2), '-OutFile', outFile],
        { timeout: SET_LOT_TIMEOUT_MS, windowsHide: true },
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message}${stderr ? `: ${stderr.trim()}` : ''}`)) : resolve()),
      );
    });
    return JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '')) as SetLotResult;
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}
