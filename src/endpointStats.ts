/**
 * Per-endpoint call health.
 *
 * Written because of one specific failure: the account-state export ran for
 * months posting nothing, and the app displayed no difference — the only way
 * to establish that /api/accounts/state had never been called was to read
 * Caddy's logs on the server. A "never called" row in the app answers that in
 * seconds.
 *
 * Endpoints are registered up front rather than created on first call, so an
 * endpoint that never fires still has a row. A missing row and a zero row look
 * identical in a table; only the zero row is evidence.
 */

export const TRACKED_ENDPOINTS = [
  '/api/watcher/auth-test',
  '/api/watcher/register',
  '/api/watcher/heartbeat',
  '/api/accounts/match-by-number',
  '/api/accounts/state',
  '/api/trades/check-duplicates',
  '/api/import/batch',
  '/api/import/open-trades',
  '/api/trades/update-closed-data',
  '/api/settings/symbol-map',
] as const;

export type TrackedEndpoint = (typeof TRACKED_ENDPOINTS)[number];

const BUCKET_MS = 60 * 60 * 1000; // one hour
const BUCKET_COUNT = 24;

export interface EndpointSnapshot {
  path: string;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  calls24h: number;
  fails24h: number;
  /** 24 hourly counts, oldest first, for the volume sparkline. */
  buckets: number[];
  /** No successful call has ever been observed this session. */
  neverCalled: boolean;
}

interface EndpointState {
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  /** Hour bucket index (epoch hours) -> count. Pruned on read. */
  buckets: Map<number, number>;
  fails: Map<number, number>;
}

function newState(): EndpointState {
  return { lastOkAt: null, lastFailAt: null, lastError: null, buckets: new Map(), fails: new Map() };
}

export class EndpointStats {
  private state = new Map<string, EndpointState>();

  constructor(private now: () => number = () => Date.now()) {
    for (const p of TRACKED_ENDPOINTS) this.state.set(p, newState());
  }

  /**
   * Maps a concrete request URL onto its tracked endpoint.
   * `/api/accounts/match-by-number/5241188` collapses onto the prefix, so one
   * row covers every account rather than one row per account number.
   */
  public static normalise(url: string): string | null {
    const path = url.split('?')[0].replace(/\/+$/, '');
    for (const p of TRACKED_ENDPOINTS) {
      if (path === p || path.startsWith(p + '/')) return p;
    }
    return null;
  }

  public record(url: string, ok: boolean, error?: string): void {
    const key = EndpointStats.normalise(url);
    if (!key) return;
    const s = this.state.get(key)!;
    const at = this.now();
    const bucket = Math.floor(at / BUCKET_MS);
    s.buckets.set(bucket, (s.buckets.get(bucket) ?? 0) + 1);
    if (ok) {
      s.lastOkAt = at;
    } else {
      s.lastFailAt = at;
      s.lastError = error ?? 'unknown error';
      s.fails.set(bucket, (s.fails.get(bucket) ?? 0) + 1);
    }
    this.prune(s, bucket);
  }

  private prune(s: EndpointState, currentBucket: number): void {
    const oldest = currentBucket - (BUCKET_COUNT - 1);
    for (const b of [...s.buckets.keys()]) if (b < oldest) s.buckets.delete(b);
    for (const b of [...s.fails.keys()]) if (b < oldest) s.fails.delete(b);
  }

  public snapshot(): EndpointSnapshot[] {
    const currentBucket = Math.floor(this.now() / BUCKET_MS);
    const oldest = currentBucket - (BUCKET_COUNT - 1);

    return TRACKED_ENDPOINTS.map(path => {
      const s = this.state.get(path)!;
      const buckets: number[] = [];
      let calls = 0;
      let fails = 0;
      for (let b = oldest; b <= currentBucket; b++) {
        const n = s.buckets.get(b) ?? 0;
        buckets.push(n);
        calls += n;
        fails += s.fails.get(b) ?? 0;
      }
      return {
        path,
        lastOkAt: s.lastOkAt,
        lastFailAt: s.lastFailAt,
        lastError: s.lastError,
        calls24h: calls,
        fails24h: fails,
        buckets,
        neverCalled: s.lastOkAt === null && s.lastFailAt === null,
      };
    });
  }

  public totalCalls24h(): number {
    return this.snapshot().reduce((n, e) => n + e.calls24h, 0);
  }
}
