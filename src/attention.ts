/**
 * The queue of things the watcher could not handle on its own.
 *
 * Every one of these used to be a single WARN line in a log file nobody reads,
 * with the data dropped. The operator's standing request is the opposite:
 * show me what didn't match, so I can match it myself. So items persist until
 * they are dealt with, and the files behind an unmatched account are held on
 * disk rather than discarded.
 *
 * Two kinds of item live here:
 *  - RAISED items are events the watcher recorded (an unmatched account, a
 *    rejected timestamp, a symbol that resolved to nothing). They persist.
 *  - DERIVED items are computed from current account health each time the
 *    screen is drawn, so a feed that comes back to life clears its own
 *    warning without anything having to remember to retract it.
 */

import type { AccountHealthSnapshot } from './accountHealth';
import { formatAge, labelFor } from './accountHealth';

export type AttentionKind =
  | 'unmatched-account'
  | 'stale-feed'
  | 'broker-time'
  | 'symbol-miss'
  | 'truncated-file'
  | 'send-failed';

export type AttentionSeverity = 'severe' | 'warn';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  /** Epoch ms first raised. */
  at: number;
  /** Set once the condition cleared; kept on screen for the record. */
  resolvedAt: number | null;
  /** Actions the UI should offer, by name. */
  actions: string[];
  /** Present for items tied to one account. */
  accountNumber?: string;
  /** Present for unmatched accounts: where the held files are. */
  folder?: string;
  heldFiles?: number;
  /** Muted until this epoch ms. */
  mutedUntil?: number;
}

const MAX_RESOLVED = 40;

export class AttentionCenter {
  private raised = new Map<string, AttentionItem>();
  private resolved: AttentionItem[] = [];
  private muted = new Map<string, number>();

  constructor(private now: () => number = () => Date.now()) {}

  private put(item: Omit<AttentionItem, 'at' | 'resolvedAt'>): void {
    const existing = this.raised.get(item.id);
    if (existing) {
      // Same problem seen again: refresh the wording, keep the original time
      // so the operator can see how long it has been going on.
      existing.title = item.title;
      existing.detail = item.detail;
      existing.severity = item.severity;
      existing.heldFiles = item.heldFiles;
      return;
    }
    this.raised.set(item.id, { ...item, at: this.now(), resolvedAt: null });
  }

  public unmatchedAccount(accountNumber: string, heldFiles: number, folder: string, extra?: string): void {
    this.put({
      id: `unmatched:${accountNumber}`,
      kind: 'unmatched-account',
      severity: 'severe',
      title: `Account ${accountNumber} has no match in the web app`,
      detail: `${heldFiles} file${heldFiles === 1 ? '' : 's'} held${extra ? ` · ${extra}` : ''}`,
      actions: ['link', 'ignore'],
      accountNumber,
      folder,
      heldFiles,
    });
  }

  public brokerTimeRejection(accountNumber: string, fileName: string, driftText: string): void {
    this.put({
      id: `brokertime:${accountNumber}`,
      kind: 'broker-time',
      severity: 'warn',
      title: `Timestamps rejected — broker server time is stale`,
      detail: `${fileName} · ${driftText}`,
      actions: ['view'],
      accountNumber,
    });
  }

  public truncatedFile(accountNumber: string, fileName: string): void {
    this.put({
      id: `truncated:${accountNumber}`,
      kind: 'truncated-file',
      severity: 'warn',
      title: `File arrived truncated`,
      detail: `${fileName} — the EA was still writing, or the write was interrupted`,
      actions: ['view'],
      accountNumber,
    });
  }

  public symbolMiss(symbol: string, accountNumber?: string): void {
    this.put({
      id: `symbol:${symbol}`,
      kind: 'symbol-miss',
      severity: 'warn',
      title: `Broker symbol ${symbol} resolved to nothing`,
      detail: `No canonical symbol or suffix rule matched. Trades on it cannot be linked.`,
      actions: ['view'],
      accountNumber,
    });
  }

  public sendFailed(endpoint: string, error: string): void {
    this.put({
      id: `send:${endpoint}`,
      kind: 'send-failed',
      severity: 'severe',
      title: `${endpoint} is failing`,
      detail: error,
      actions: ['retry'],
    });
  }

  /** The operator dealt with it, or the condition cleared. */
  public resolve(id: string): boolean {
    const item = this.raised.get(id);
    if (!item) return false;
    item.resolvedAt = this.now();
    this.resolved.unshift(item);
    if (this.resolved.length > MAX_RESOLVED) this.resolved.pop();
    this.raised.delete(id);
    return true;
  }

  public mute(id: string, ms: number): void {
    this.muted.set(id, this.now() + ms);
  }

  /** Clears any raised item whose id starts with the prefix. */
  public resolveByPrefix(prefix: string): void {
    for (const id of [...this.raised.keys()]) {
      if (id.startsWith(prefix)) this.resolve(id);
    }
  }

  /**
   * Derives the feed warnings from current health, then merges them with the
   * raised items. Derived items are not stored, so an account that recovers
   * simply stops producing one.
   */
  public snapshot(health: AccountHealthSnapshot[]): { open: AttentionItem[]; resolved: AttentionItem[] } {
    const now = this.now();
    const derived: AttentionItem[] = [];

    for (const a of health) {
      if (a.status !== 'stale' && a.status !== 'down') continue;
      const worst = a.feeds
        .filter(f => f.lastAt !== null && f.overdue)
        .sort((x, y) => (y.overdueFactor ?? 0) - (x.overdueFactor ?? 0))[0];
      if (!worst) continue;

      const id = `stale:${a.accountNumber}:${worst.kind}`;
      const mutedUntil = this.muted.get(id);
      if (mutedUntil && mutedUntil > now) continue;

      const who = a.accountName ?? `Account ${a.accountNumber}`;
      derived.push({
        id,
        kind: 'stale-feed',
        severity: a.status === 'down' ? 'severe' : 'warn',
        title: `${who} stopped exporting ${labelFor(worst.kind)}s`,
        detail:
          `Expected every ${Math.round(worst.cadenceMs / 1000)}s, last write ` +
          `${formatAge(worst.age)} ago. Reattaching the EA usually fixes this.`,
        at: worst.lastAt ?? now,
        resolvedAt: null,
        actions: ['open-folder', 'mute'],
        accountNumber: a.accountNumber,
      });
    }

    const open = [...this.raised.values()]
      .filter(i => {
        const m = this.muted.get(i.id);
        return !(m && m > now);
      })
      .concat(derived)
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'severe' ? -1 : 1;
        return b.at - a.at;
      });

    return { open, resolved: this.resolved };
  }

  public openCount(health: AccountHealthSnapshot[]): number {
    return this.snapshot(health).open.length;
  }
}
