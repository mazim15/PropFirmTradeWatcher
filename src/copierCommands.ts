import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Dashboard → watcher commands (set an FX Blue receiver's lot, rename a channel, repair a
 * link, rescan). The watcher
 * polls for claimed commands, runs them one at a time, posts the outcome and never retries.
 */

// Copied from the web app's app/utils/copierCommands.ts.
export type CommandType = 'setReceiverLot' | 'rescan' | 'renameChannel' | 'repair' | 'openTerminal';
export type RepairAction = 'attachExporter' | 'attachSender' | 'attachBoth' | 'pointSender' | 'invertOn';
export type CommandStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'expired';
export type WatcherCommand = {
  id: string; watcherId: string; type: CommandType; status: CommandStatus;
  payload: { accountNumber?: string; channel?: string; lot?: number;
             propLogin?: string; brokerLogin?: string;
             oldChannel?: string; newChannel?: string; action?: RepairAction;
             /** Open broker tickets copied from other accounts; they don't block this change. */
             otherTickets?: string[] };
  createdAt: string; claimedAt: string | null; finishedAt: string | null;
  result: { oldLot?: number; newLot?: number; before?: Record<string, string>; after?: Record<string, string> } | null;
  error: string | null;
};
/** What scripts/copier-set-input.ps1 writes: the -Set keys' values before and on read-back. */
export type SetInputResult = {
  ok: boolean; before: Record<string, string> | null; after: Record<string, string> | null;
  chartFile: string | null; step: string | null; error: string | null;
};
export type SetInputArgs = { role: 'receiver' | 'sender'; channel?: string; login?: string; set: Record<string, string> };
/** A receiver lot change's outcome. */
export type SetLotResult = {
  ok: boolean; oldLot: number | null; newLot: number | null; chartFile: string | null;
  step: string | null; error: string | null;
};
/** What scripts/copier-attach.ps1 writes. */
export type AttachResult = { ok: boolean; step: string | null; error: string | null };
export type AttachArgs = { login: string; ea: 'exporter' | 'sender'; channel?: string; baseSet?: string };
export type ResultBody = { status: 'done' | 'failed'; result?: object; error?: string };
export type DispatchDeps = {
  /** Open positions on a login, not counting the `ignore` tickets; null if unknown. */
  openPositions(login: string, ignore?: string[]): Promise<number | null>;
  runSetLot(channel: string, lot: number): Promise<SetLotResult>;
  runSetInput(args: SetInputArgs): Promise<SetInputResult>;
  runAttach(args: AttachArgs): Promise<AttachResult>;
  /** Starts this login's closed terminal and waits for it to log in. */
  runOpenTerminal(login: string): Promise<AttachResult>;
  /** The sender settings the last scan kept for this login, or null. */
  keptSenderSet(login: string): string | null;
  wait(ms: number): Promise<void>;
  rescan(): Promise<void>;
  postResult: (id: string, body: ResultBody) => Promise<boolean>;
};

const SET_LOT_TIMEOUT_MS = 3 * 60 * 1000;
const FRESH_TRADES_MS = 5 * 60 * 1000;
/** While gold is closed the exporter stops writing; its last file is trusted only if this recent. */
const CLOSED_MAX_AGE_MS = 72 * 3600 * 1000;

const BAD_PAYLOAD: ResultBody = { status: 'failed', error: 'Bad command payload' };
const OPEN_TRADE: ResultBody = { status: 'failed', error: 'Open trade or no fresh trade data' };
const why = (r: { step: string | null; error: string | null }) => `${r.step ?? 'unknown'}: ${r.error ?? 'failed'}`;

/**
 * Re-check just before touching MT4/MT5: the server's check may be seconds old. Only the broker tickets
 * the server proved belong to other accounts are ignored, so a trade opened since then still refuses.
 */
async function flat(deps: DispatchDeps, propLogin: string, brokerLogin: string, otherTickets?: string[]): Promise<boolean> {
  const [prop, broker] = await Promise.all([deps.openPositions(propLogin), deps.openPositions(brokerLogin, otherTickets)]);
  return prop === 0 && broker === 0;
}

/** Receiver first, then sender; if the sender fails, put the receiver's old name back. */
async function renameChannel(cmd: WatcherCommand, deps: DispatchDeps): Promise<ResultBody> {
  const { propLogin, brokerLogin, oldChannel, newChannel } = cmd.payload;
  if (!propLogin || !brokerLogin || !oldChannel || !newChannel) return BAD_PAYLOAD;
  if (!(await flat(deps, propLogin, brokerLogin, cmd.payload.otherTickets))) return OPEN_TRADE;
  const recv = await deps.runSetInput({ role: 'receiver', channel: oldChannel, set: { Channel: newChannel } });
  if (!recv.ok) {
    // It failed after OK (read-back or persist) and the new name is live: put the old one back.
    const live = recv.after?.Channel;
    if (!live || live === oldChannel) return { status: 'failed', error: `receiver: ${why(recv)}` };
    const undo = await deps.runSetInput({ role: 'receiver', channel: live, set: { Channel: oldChannel } });
    if (undo.ok) return { status: 'failed', error: `receiver: ${why(recv)} (receiver restored)` };
    return { status: 'failed', error: `MISMATCH: receiver ${live}, sender ${oldChannel}` };
  }
  const send = await deps.runSetInput({ role: 'sender', login: propLogin, set: { Channel: newChannel } });
  if (send.ok) return { status: 'done', result: { before: { Channel: oldChannel }, after: { Channel: newChannel } } };
  const back = await deps.runSetInput({ role: 'receiver', channel: newChannel, set: { Channel: oldChannel } });
  if (back.ok) return { status: 'failed', error: `sender: ${why(send)} (receiver restored)` };
  return { status: 'failed', error: `MISMATCH: receiver ${newChannel}, sender ${oldChannel}` };
}

async function repair(cmd: WatcherCommand, deps: DispatchDeps): Promise<ResultBody> {
  const { action, propLogin, brokerLogin, newChannel, channel } = cmd.payload;
  if (!propLogin) return BAD_PAYLOAD;
  // The exporter doesn't touch the link, and a missing exporter during a trade is exactly when it's needed.
  if (action === 'attachExporter') {
    const r = await deps.runAttach({ login: propLogin, ea: 'exporter' });
    return r.ok ? { status: 'done' } : { status: 'failed', error: why(r) };
  }
  if (!brokerLogin) return BAD_PAYLOAD;
  const needs = action === 'invertOn' ? channel : newChannel;
  if (!needs || (action !== 'attachSender' && action !== 'attachBoth' && action !== 'pointSender' && action !== 'invertOn')) return BAD_PAYLOAD;
  const attaching = action === 'attachSender' || action === 'attachBoth';
  const baseSet = attaching ? deps.keptSenderSet(propLogin) : null;
  if (attaching && !baseSet) return { status: 'failed', error: 'No saved sender settings on this PC' };
  // The flat check needs the exporter's file, so the exporter goes first and its first file is awaited.
  const said = action === 'attachBoth' ? 'exporter attached; sender: ' : '';
  if (action === 'attachBoth') {
    const r = await deps.runAttach({ login: propLogin, ea: 'exporter' });
    if (!r.ok) return { status: 'failed', error: `exporter: ${why(r)}` };
    for (let i = 0; i < 18 && (await deps.openPositions(propLogin)) === null; i++) await deps.wait(5000);
  }
  // Pointing a sender takes over a receiver that may hold another account's trade, so nothing is ignored there.
  // For an attach the server sends tickets to ignore only when it is the account's own last channel.
  if (!(await flat(deps, propLogin, brokerLogin, action === 'pointSender' ? undefined : cmd.payload.otherTickets))) {
    return { ...OPEN_TRADE, error: said + OPEN_TRADE.error };
  }
  if (attaching) {
    const r = await deps.runAttach({ login: propLogin, ea: 'sender', channel: needs, baseSet: baseSet ?? undefined });
    return r.ok ? { status: 'done' } : { status: 'failed', error: said + why(r) };
  }
  const r = action === 'pointSender'
    ? await deps.runSetInput({ role: 'sender', login: propLogin, set: { Channel: needs } })
    : await deps.runSetInput({ role: 'receiver', channel: needs, set: { InvertTrades: 'true' } });
  return r.ok
    ? { status: 'done', result: { before: r.before ?? undefined, after: r.after ?? undefined } }
    : { status: 'failed', error: why(r) };
}

async function run(cmd: WatcherCommand, deps: DispatchDeps): Promise<ResultBody> {
  if (cmd.type === 'rescan') {
    await deps.rescan();
    return { status: 'done' };
  }
  if (cmd.type === 'renameChannel') return renameChannel(cmd, deps);
  if (cmd.type === 'repair') return repair(cmd, deps);
  if (cmd.type === 'openTerminal') {
    const login = cmd.payload.accountNumber;
    if (!login || !/^\d+$/.test(login)) return BAD_PAYLOAD;
    const r = await deps.runOpenTerminal(login);
    return r.ok ? { status: 'done' } : { status: 'failed', error: why(r) };
  }
  if (cmd.type !== 'setReceiverLot') return { status: 'failed', error: 'Unknown command' };
  const { propLogin, brokerLogin, channel, lot } = cmd.payload;
  if (!propLogin || !brokerLogin || !channel || typeof lot !== 'number') return BAD_PAYLOAD;
  if (!(await flat(deps, propLogin, brokerLogin, cmd.payload.otherTickets))) return OPEN_TRADE;
  const r = await deps.runSetLot(channel, lot);
  if (r.ok) return { status: 'done', result: { oldLot: r.oldLot ?? undefined, newLot: r.newLot ?? undefined } };
  return { status: 'failed', error: why(r) };
}

/** Commands that change a copier EA or start a terminal, so the board needs a fresh scan afterwards. */
const CHANGES: ReadonlySet<CommandType> = new Set(['setReceiverLot', 'renameChannel', 'repair', 'openTerminal']);

/**
 * Runs one command and posts its outcome. Never retries; a throw becomes `failed`.
 * After any change attempt (lot, rename, repair, open), whatever the outcome, it rescans so the
 * board shows the real state. The result is posted first and the rescan isn't awaited: a scan can take
 * minutes, and the poller must stay free to claim the next command before it expires.
 */
export async function dispatch(cmd: WatcherCommand, deps: DispatchDeps): Promise<void> {
  let body: ResultBody;
  try {
    body = await run(cmd, deps);
  } catch (error) {
    body = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  await deps.postResult(cmd.id, body);
  if (CHANGES.has(cmd.type)) void deps.rescan().catch(() => undefined);
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

/** Data rows after the exporter's `Ticket,…` header, skipping `ignore` tickets; null when there is no header. */
export function countOpenRows(text: string, ignore: string[] = []): number | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const h = lines.findIndex(l => l.startsWith('Ticket'));
  if (h < 0) return null;
  return lines.slice(h + 1).filter(l => l.trim() && !l.startsWith('#') && !ignore.includes(l.split(/[,;\t]/)[0].trim())).length;
}

/**
 * Gold's weekend close, Fri 22:00 → Sun 22:00 UTC. The real close is Fri 21:00/22:00 →
 * Sun 22:00/23:00 UTC depending on US daylight time, so this window always sits inside it.
 * ponytail: no holidays or daily break; those just refuse with "no fresh trade data".
 */
export function goldClosed(nowMs: number): boolean {
  const d = new Date(nowMs);
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22);
}

/**
 * Open positions for a login from the newest open_trades_<login>_latest.csv; null if it can't be trusted.
 * The exporter's timer runs on server time, which stops between ticks, so while gold is closed its last
 * file (from the close) is used as long as it's under 72h old. While open, it must be under 5 minutes old.
 */
export function openPositionsIn(folders: string[], login: string, nowMs = Date.now(), ignore: string[] = []): number | null {
  let newest: { file: string; mtime: number } | null = null;
  for (const folder of folders) {
    const file = path.join(folder, `open_trades_${login.trim()}_latest.csv`);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch { /* not in this folder */ }
  }
  const maxAge = goldClosed(nowMs) ? CLOSED_MAX_AGE_MS : FRESH_TRADES_MS;
  if (!newest || nowMs - newest.mtime > maxAge) return null;
  try { return countOpenRows(fs.readFileSync(newest.file, 'utf8'), ignore); } catch { return null; }
}

const lotOf = (m: Record<string, string> | null): number | null => {
  const n = Number(m?.UseFixedLotSize);
  return m?.UseFixedLotSize !== undefined && m.UseFixedLotSize !== '' && Number.isFinite(n) ? n : null;
};

/** A set-input run on UseFixedLotSize, as a lot change's result. */
export function setLotFromInput(r: SetInputResult): SetLotResult {
  return { ok: r.ok, oldLot: lotOf(r.before), newLot: lotOf(r.after), chartFile: r.chartFile, step: r.step, error: r.error };
}

/** Runs a bundled PowerShell script with `-OutFile <tmp>` appended and returns the JSON it wrote. */
export async function runPsScript<T>(scriptPath: string, args: string[], timeoutMs: number): Promise<T> {
  const outFile = path.join(os.tmpdir(), `${path.basename(scriptPath, '.ps1')}-${process.pid}-${Date.now()}.json`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath,
          ...args, '-OutFile', outFile],
        { timeout: timeoutMs, windowsHide: true },
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message}${stderr ? `: ${stderr.trim()}` : ''}`)) : resolve()),
      );
    });
    return JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')) as T;
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/** Runs the bundled copier-attach script. */
export function runAttachScript(scriptPath: string, a: AttachArgs): Promise<AttachResult> {
  const args = ['-Login', a.login, '-Expert', a.ea];
  if (a.channel) args.push('-Channel', a.channel);
  if (a.baseSet) args.push('-BaseSet', a.baseSet);
  return runPsScript<AttachResult>(scriptPath, args, SET_LOT_TIMEOUT_MS);
}

/** %LOCALAPPDATA%\copier\sets\<login>-sender.set, kept by the scan, if it exists. */
export function keptSenderSetPath(login: string, localAppData = process.env.LOCALAPPDATA ?? ''): string | null {
  if (!localAppData || !/^\d+$/.test(login.trim())) return null;
  const file = path.join(localAppData, 'copier', 'sets', `${login.trim()}-sender.set`);
  return fs.existsSync(file) ? file : null;
}

/** Runs the bundled copier-set-input script on one receiver or sender. */
export function runSetInputScript(scriptPath: string, a: SetInputArgs): Promise<SetInputResult> {
  const target = a.role === 'receiver' ? ['-Channel', a.channel ?? ''] : ['-Login', a.login ?? ''];
  const set = Object.entries(a.set).map(([k, v]) => `${k}=${v}`).join(';');
  return runPsScript<SetInputResult>(scriptPath, ['-Role', a.role, ...target, '-Set', set], SET_LOT_TIMEOUT_MS);
}
