/**
 * Per-account feed health.
 *
 * The watcher's stats used to be nine global counters — files processed,
 * trades imported, errors. Those numbers keep climbing while one terminal is
 * dead, because the other accounts keep writing, so they can never answer the
 * only question that matters when something breaks: WHICH account stopped.
 *
 * This module keys everything by account number instead, and tracks the three
 * EA exports separately. They run on independent timers and fail
 * independently: the recurring MT4 fault where a trade stops updating until
 * the EA is reattached shows up as the open-trades feed going cold while the
 * closed-trades feed still looks recent. A single "last seen" would stay green
 * through the whole failure.
 *
 * Cadence is LEARNED from observed intervals rather than read from the EA
 * inputs, because the EA compiled onto a chart months ago may not have the
 * inputs this source declares. The EA defaults are only the starting guess.
 */

export type FeedKind = 'closed' | 'open' | 'state';

/** EA input defaults, used until three intervals have been observed. */
export const DEFAULT_CADENCE_MS: Record<FeedKind, number> = {
  closed: 60_000, // ExportIntervalMinutes = 1
  open: 30_000, // OpenTradesIntervalSeconds = 30
  state: 60_000, // AccountStateIntervalSeconds = 60
};

/** Overdue by this multiple of the cadence => stale. */
export const STALE_FACTOR = 3;
/** Overdue by this multiple => the terminal is presumed gone, not late. */
export const DOWN_FACTOR = 20;

export type AccountStatus = 'live' | 'stale' | 'down' | 'unmatched' | 'waiting';

export interface FeedSnapshot {
  kind: FeedKind;
  /** Epoch ms of the last file of this kind we processed, null if never. */
  lastAt: number | null;
  /** Milliseconds since that file, null if never. */
  age: number | null;
  /** Current cadence estimate. */
  cadenceMs: number;
  /** True once age exceeds STALE_FACTOR x cadence. */
  overdue: boolean;
  /** How many multiples of cadence late, for the "14x overdue" wording. */
  overdueFactor: number | null;
}

export interface AccountHealthSnapshot {
  accountNumber: string;
  accountId: string | null;
  accountName: string | null;
  /** 'Prop' | 'Broker' as the web app classifies it, null until linked. */
  accountType: string | null;
  /** Watch folder the files arrived in. */
  folder: string | null;
  feeds: FeedSnapshot[];
  openTrades: number;
  /** Short human line: "2 open · XAUUSD 0.40 lots". */
  detail: string | null;
  status: AccountStatus;
  /** Why the status is what it is, written for the operator. */
  reason: string;
  /** Files held on disk because the account could not be linked. */
  heldFiles: number;
  /** Set when the account state file arrives but the POST has never succeeded. */
  statePostedAt: number | null;
}

interface FeedState {
  lastAt: number | null;
  /** Gaps between consecutive files, newest last, capped at SAMPLE_CAP. */
  intervals: number[];
}

interface AccountRecord {
  accountNumber: string;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  folder: string | null;
  feeds: Record<FeedKind, FeedState>;
  openTrades: number;
  detail: string | null;
  heldFiles: number;
  statePostedAt: number | null;
  /** True when a lookup returned no matching account in the web app. */
  unmatched: boolean;
  firstSeenAt: number;
}

const SAMPLE_CAP = 12;
const FEED_KINDS: FeedKind[] = ['closed', 'open', 'state'];

function newFeedState(): FeedState {
  return { lastAt: null, intervals: [] };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class AccountHealthTracker {
  private accounts = new Map<string, AccountRecord>();

  /** Injectable so the staleness rules are testable without waiting. */
  constructor(private now: () => number = () => Date.now()) {}

  private record(accountNumber: string): AccountRecord {
    let rec = this.accounts.get(accountNumber);
    if (!rec) {
      rec = {
        accountNumber,
        accountId: null,
        accountName: null,
        accountType: null,
        folder: null,
        feeds: { closed: newFeedState(), open: newFeedState(), state: newFeedState() },
        openTrades: 0,
        detail: null,
        heldFiles: 0,
        statePostedAt: null,
        unmatched: false,
        firstSeenAt: this.now(),
      };
      this.accounts.set(accountNumber, rec);
    }
    return rec;
  }

  /**
   * A file of `kind` for this account was processed. Called once per file,
   * after parsing succeeds — a file that fails to parse is not a healthy feed.
   */
  public recordFeed(accountNumber: string, kind: FeedKind, folder?: string): void {
    const rec = this.record(accountNumber);
    const feed = rec.feeds[kind];
    const at = this.now();

    if (feed.lastAt !== null) {
      const gap = at - feed.lastAt;
      // Ignore sub-second repeats; chokidar can fire twice for one write and
      // a zero gap would drag the cadence estimate to nothing.
      if (gap >= 1000) {
        feed.intervals.push(gap);
        if (feed.intervals.length > SAMPLE_CAP) feed.intervals.shift();
      }
    }
    feed.lastAt = at;
    if (folder) rec.folder = folder;
  }

  /** The web app matched this account number to a real account. */
  public link(
    accountNumber: string,
    account: { id: string; name?: string; accountType?: string },
  ): void {
    const rec = this.record(accountNumber);
    rec.accountId = account.id;
    rec.accountName = account.name ?? null;
    rec.accountType = account.accountType ?? null;
    rec.unmatched = false;
  }

  /** The web app has no account with this number. */
  public markUnmatched(accountNumber: string, heldFiles: number): void {
    const rec = this.record(accountNumber);
    rec.unmatched = true;
    rec.accountId = null;
    rec.heldFiles = heldFiles;
  }

  /** An account state POST succeeded, as distinct from the file arriving. */
  public recordStatePosted(accountNumber: string): void {
    this.record(accountNumber).statePostedAt = this.now();
  }

  /** Open-trade count and a one-line description for the Live row. */
  public recordOpenPositions(accountNumber: string, count: number, detail: string | null): void {
    const rec = this.record(accountNumber);
    rec.openTrades = count;
    rec.detail = detail;
  }

  public cadenceFor(rec: AccountRecord, kind: FeedKind): number {
    const feed = rec.feeds[kind];
    if (feed.intervals.length < 3) return DEFAULT_CADENCE_MS[kind];
    // Median, not mean: one long gap from a closed terminal must not
    // permanently inflate the expectation and hide the next outage.
    return Math.max(1000, median(feed.intervals));
  }

  private snapshotFeed(rec: AccountRecord, kind: FeedKind): FeedSnapshot {
    const feed = rec.feeds[kind];
    const cadenceMs = this.cadenceFor(rec, kind);
    const age = feed.lastAt === null ? null : this.now() - feed.lastAt;
    const overdueFactor = age === null ? null : age / cadenceMs;
    return {
      kind,
      lastAt: feed.lastAt,
      age,
      cadenceMs,
      overdue: overdueFactor !== null && overdueFactor >= STALE_FACTOR,
      overdueFactor,
    };
  }

  /**
   * Status is the worst thing true of the account, in this order:
   * unmatched (we are throwing data away) > down > stale > live.
   *
   * A feed that has NEVER produced a file is deliberately not counted as
   * stale. On a broker account with no closed trades yet, or an EA built
   * before the account-state export existed, "never" is a fact about the
   * setup rather than a fault that appeared — it is reported as its own
   * thing so it can be read as "the EA isn't sending this" rather than
   * "the watcher stopped receiving it".
   */
  private statusFor(rec: AccountRecord, feeds: FeedSnapshot[]): { status: AccountStatus; reason: string } {
    if (rec.unmatched) {
      return {
        status: 'unmatched',
        reason: `wrote ${rec.heldFiles} file${rec.heldFiles === 1 ? '' : 's'}, no account in the web app`,
      };
    }

    const seen = feeds.filter(f => f.lastAt !== null);
    if (seen.length === 0) {
      return { status: 'waiting', reason: 'no files yet' };
    }

    const down = seen.filter(f => f.overdueFactor !== null && f.overdueFactor >= DOWN_FACTOR);
    // Every feed gone at once is a dead terminal, not three coincidental EA faults.
    if (down.length === seen.length) {
      const worst = down.reduce((a, b) => ((a.age ?? 0) > (b.age ?? 0) ? a : b));
      return { status: 'down', reason: `no file for ${formatAge(worst.age)} — terminal closed?` };
    }
    if (down.length > 0) {
      const f = down[0];
      return { status: 'down', reason: `${labelFor(f.kind)} stopped ${formatAge(f.age)} ago` };
    }

    const stale = seen.filter(f => f.overdue);
    if (stale.length > 0) {
      const f = stale.reduce((a, b) => ((a.overdueFactor ?? 0) > (b.overdueFactor ?? 0) ? a : b));
      const times = Math.floor(f.overdueFactor ?? 0);
      return {
        status: 'stale',
        reason: `${labelFor(f.kind)} export ${times}× overdue — reattach the EA`,
      };
    }

    const never = feeds.filter(f => f.lastAt === null).map(f => labelFor(f.kind));
    if (never.length > 0) {
      return { status: 'live', reason: `${never.join(' and ')} never sent by the EA` };
    }
    return { status: 'live', reason: rec.detail ?? 'all feeds current' };
  }

  public snapshot(): AccountHealthSnapshot[] {
    const out: AccountHealthSnapshot[] = [];
    for (const rec of this.accounts.values()) {
      const feeds = FEED_KINDS.map(k => this.snapshotFeed(rec, k));
      const { status, reason } = this.statusFor(rec, feeds);
      out.push({
        accountNumber: rec.accountNumber,
        accountId: rec.accountId,
        accountName: rec.accountName,
        accountType: rec.accountType,
        folder: rec.folder,
        feeds,
        openTrades: rec.openTrades,
        detail: rec.detail,
        status,
        reason,
        heldFiles: rec.heldFiles,
        statePostedAt: rec.statePostedAt,
      });
    }
    // Worst first, so the thing that needs attention is at the top of the list.
    const rank: Record<AccountStatus, number> = { unmatched: 0, down: 1, stale: 2, waiting: 3, live: 4 };
    out.sort((a, b) => rank[a.status] - rank[b.status] || a.accountNumber.localeCompare(b.accountNumber));
    return out;
  }

  /** Accounts whose feeds are all current, over the total we have ever seen. */
  public feedingCount(): { feeding: number; total: number } {
    const snap = this.snapshot();
    return { feeding: snap.filter(a => a.status === 'live').length, total: snap.length };
  }

  /** Restores counts across restarts; feeds intentionally start empty. */
  public knownAccountNumbers(): string[] {
    return [...this.accounts.keys()];
  }
}

export function labelFor(kind: FeedKind): string {
  return kind === 'closed' ? 'closed-trade' : kind === 'open' ? 'open-trade' : 'account-state';
}

/** "4s", "6m", "1h 09m", "16h 48m" — compact enough for a table cell. */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${h}h ${String(rem).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
