import type { KeyValueStore } from "../env";
import { rateLimited } from "../http";

/**
 * How often one installation, or one address, may file a report.
 *
 * A fixed window rather than a sliding one. A sliding window needs either a
 * timestamp list per key or a durable counter, and a fixed hour is enough for
 * what this is actually defending against: somebody holding down a submit
 * button, and a script pointed at a public endpoint. Neither is stopped any
 * better by a smoother curve.
 *
 * ## Without KV
 *
 * The in-memory fallback counts per isolate, and a platform may run several.
 * That is a real weakness and it is stated rather than papered over: it raises
 * the cost of abuse without eliminating it. A deployment that expects to be
 * found should bind a KV namespace, and the README says so.
 */

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window ends. */
  resetIn: number;
}

const WINDOW_SECONDS = 3600;

/** Per-isolate counters, used when no KV namespace is bound. */
const memory = new Map<string, { count: number; windowStart: number }>();

function windowOf(now: number): number {
  return Math.floor(now / (WINDOW_SECONDS * 1000));
}

/**
 * Counts one use against a key.
 *
 * Read-then-write, which can undercount under exactly simultaneous requests
 * from one key. That race costs at most a request or two per window and the
 * alternative is a durable object per reporter, which is a great deal of
 * machinery for a bug reporting endpoint.
 */
export async function consume(
  key: string,
  limit: number,
  store: KeyValueStore | undefined,
  now = Date.now(),
): Promise<RateDecision> {
  if (!key || limit <= 0) {
    return { allowed: true, remaining: limit, resetIn: 0 };
  }
  const window = windowOf(now);
  const resetIn = Math.ceil(((window + 1) * WINDOW_SECONDS * 1000 - now) / 1000);

  if (store) {
    const storeKey = `rate:${key}:${window}`;
    const current = Number.parseInt((await store.get(storeKey)) ?? "0", 10) || 0;
    if (current >= limit) return { allowed: false, remaining: 0, resetIn };
    await store.put(storeKey, String(current + 1), {
      // Expires with its window, so nothing has to sweep old counters.
      expirationTtl: WINDOW_SECONDS + 60,
    });
    return { allowed: true, remaining: limit - current - 1, resetIn };
  }

  const entry = memory.get(key);
  if (!entry || entry.windowStart !== window) {
    memory.set(key, { count: 1, windowStart: window });
    pruneMemory(window);
    return { allowed: true, remaining: limit - 1, resetIn };
  }
  if (entry.count >= limit) return { allowed: false, remaining: 0, resetIn };
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, resetIn };
}

/** Keeps the fallback map from growing for the life of the isolate. */
function pruneMemory(window: number): void {
  if (memory.size < 5000) return;
  for (const [key, entry] of memory) {
    if (entry.windowStart !== window) memory.delete(key);
  }
}

/** Consumes and throws the 429 the client knows how to read. */
export async function enforce(
  key: string,
  limit: number,
  store: KeyValueStore | undefined,
  what: string,
  now = Date.now(),
): Promise<void> {
  const decision = await consume(key, limit, store, now);
  if (decision.allowed) return;
  throw rateLimited(
    `Too many reports have been sent from ${what} recently. Try again a little later.`,
    decision.resetIn,
  );
}

/** Exposed for tests, which must not inherit counters from each other. */
export function resetMemoryCounters(): void {
  memory.clear();
}
