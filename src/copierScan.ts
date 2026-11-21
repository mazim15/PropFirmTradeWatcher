/**
 * Copier management: turn the copier-scan script's output into endpoint records.
 *
 * The bundled scan script (scripts/copier-scan.ps1) reads each EA's settings in every
 * running MT4/MT5 terminal and saves them as `.set` text. This module parses that text
 * and builds one record per terminal plus one per copier EA (sender, receiver, exporter).
 */

export type CopierRole = 'terminal' | 'sender' | 'receiver' | 'exporter';
export type CopierEndpoint = {
  watcherId: string; pc: string; dataFolder: string; terminalPath: string;
  kind: 'mt4' | 'mt5'; login: string; role: CopierRole;
  channel: string | null; lot: number | null; invert: boolean | null; hbAlert: number | null;
  error: string | null; scannedAt: string; // ISO
};

export type ScanOutput = {
  scannedAt: string;
  terminals: Array<{
    kind: 'mt4' | 'mt5'; path: string; dataFolder: string; login: string; error: string | null;
    eas: Array<{ title: string; set: string | null }>;
  }>;
};

/** `key=value` lines; MT5 appends `||min||step||max||flag` to values, so cut at the first `|`. */
export function parseSetFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).split('|')[0].trim();
  }
  return out;
}

function roleOf(title: string): CopierRole | null {
  if (/TradeCopy Sender/.test(title)) return 'sender';
  if (/TradeCopy Receiver/.test(title)) return 'receiver';
  if (/TradeExporter/.test(title)) return 'exporter';
  return null;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toEndpoints(raw: ScanOutput, watcherId: string, pc: string): CopierEndpoint[] {
  const rows: CopierEndpoint[] = [];
  for (const t of raw.terminals) {
    const base = {
      watcherId, pc, dataFolder: t.dataFolder, terminalPath: t.path, kind: t.kind,
      login: t.login.trim(), scannedAt: raw.scannedAt,
    };
    const empty = { channel: null, lot: null, invert: null, hbAlert: null };
    rows.push({ ...base, ...empty, role: 'terminal', error: t.error });
    for (const ea of t.eas) {
      const role = roleOf(ea.title);
      if (!role) continue;
      if (ea.set === null) { rows.push({ ...base, ...empty, role, error: null }); continue; }
      const s = parseSetFile(ea.set);
      const recv = role === 'receiver';
      rows.push({
        ...base, role, error: null,
        channel: s.Channel ?? null,
        lot: recv ? num(s.UseFixedLotSize) : null,
        invert: recv ? s.InvertTrades === 'true' : null,
        hbAlert: recv ? num(s.AlertIfHeartbeatMissingSeconds) : null,
      });
    }
  }
  return rows;
}
