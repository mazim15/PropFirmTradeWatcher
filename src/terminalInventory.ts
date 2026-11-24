import type { AttachResult } from './copierCommands';
import { runPsScript } from './copierCommands';

/**
 * Installed MT4/MT5 terminals on this PC, posted every minute so the board sees a closed one,
 * and starting one for an account. The terminal is always picked here, from this PC's own list.
 */

// Copied from the web app's app/utils/terminalInventory.ts.
export type TerminalEntry = { kind: 'mt4' | 'mt5'; path: string; login: string; running: boolean; lastUsed: string };

export async function runInventoryScript(scriptPath: string): Promise<TerminalEntry[]> {
  const raw = await runPsScript<{ terminals: TerminalEntry[] | null }>(scriptPath, [], 45_000);
  return raw.terminals ?? [];
}

/** The script waits up to 75s for the login line. */
export function runOpenScript(scriptPath: string, exe: string, login: string): Promise<AttachResult> {
  return runPsScript<AttachResult>(scriptPath, ['-Path', exe, '-Login', login], 120_000);
}

export async function openTerminal(login: string, deps: {
  inventory(): Promise<TerminalEntry[]>;
  start(exe: string, login: string): Promise<AttachResult>;
  /** Posts a fresh inventory, so the board's button is gone before the command's result lands. */
  post(): Promise<unknown>;
}): Promise<AttachResult> {
  const mine = (await deps.inventory()).filter(t => t.login === login);
  if (mine.some(t => t.running)) return { ok: true, step: null, error: null };
  if (!mine.length) return { ok: false, step: 'find', error: `No closed terminal for ${login}` };
  const newest = mine.reduce((a, b) => ((Date.parse(b.lastUsed) || 0) > (Date.parse(a.lastUsed) || 0) ? b : a));
  try {
    return await deps.start(newest.path, login);
  } finally {
    await deps.post();
  }
}
