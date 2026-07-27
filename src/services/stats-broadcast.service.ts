/**
 * Fan-out of admin dashboard stats to every connected SSE client.
 *
 * Replaces the old model, where each open dashboard tab re-ran the full stats
 * aggregation every 5 seconds regardless of whether anything had changed. Now
 * the work is driven by actual pipeline activity and shared across viewers:
 * one recompute serves every connected client, and an idle pipeline costs
 * nothing at all.
 *
 * Two things trigger a recompute:
 *
 *  1. A `video-changed` event published by whichever process wrote the video
 *     (see events.service.ts + the hook in models/video.model.ts). This is the
 *     push path — the dashboard reflects a stage transition within ~300ms.
 *  2. A slow periodic tick, because queue depths move without any video write:
 *     a job leaving `waiting` for `active`, or BullMQ trimming completed jobs,
 *     changes the numbers with nothing to publish. The tick is the safety net
 *     for those, and for a missed pub/sub message.
 *
 * Everything is reference-counted on the client set: no clients means no
 * subscription, no timer, and no queries.
 */
import { computeAdminStats } from "./admin-stats.service.js";
import { subscribeToPipelineEvents } from "./events.service.js";
import type { SseClient } from "./sse.service.js";

// Pipeline writes arrive in bursts (a worker updates status, then metadata,
// then enqueues the next stage). Coalesce them into one recompute.
const DEBOUNCE_MS = 300;

// Backstop refresh for changes that produce no event — mainly queue depths.
// Deliberately far slower than the old 5s poll: the push path handles anything
// a user would notice as "laggy".
const TICK_MS = 10_000;

const clients = new Set<SseClient>();

let unsubscribe: (() => Promise<void>) | null = null;
let tick: NodeJS.Timeout | null = null;
let debounce: NodeJS.Timeout | null = null;

// Serialized form of the last payload sent. Identical snapshots are dropped so
// an idle pipeline produces zero traffic even while the tick keeps running.
let lastSent: string | null = null;

// Guards against overlapping recomputes: a burst of events while a query is
// already in flight sets `refreshQueued` instead of starting a second query.
let refreshing = false;
let refreshQueued = false;

/**
 * Recomputes the snapshot and sends it to every client.
 *
 * @param force Send even if the payload is byte-identical to the last one.
 *              Used when a client joins mid-stream, so the newcomer and the
 *              existing clients end up on the same snapshot.
 */
const refresh = async (force = false): Promise<void> => {
  if (clients.size === 0) return;

  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;

  try {
    const stats = await computeAdminStats();
    const serialized = JSON.stringify(stats);

    if (force || serialized !== lastSent) {
      lastSent = serialized;
      for (const client of clients) client.send("stats", stats);
    }
  } catch (error) {
    console.error("Failed to compute admin stats for SSE:", error);
    // Tell clients the snapshot is stale rather than leaving them staring at
    // numbers that silently stopped updating.
    for (const client of clients) {
      client.send("error", { message: "Failed to refresh stats" });
    }
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh();
    }
  }
};

/** Coalesces a burst of change events into a single recompute. */
const scheduleRefresh = (): void => {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void refresh();
  }, DEBOUNCE_MS);
  debounce.unref();
};

/** Wires up the event subscription and the safety tick. Called for the first client. */
const start = (): void => {
  unsubscribe = subscribeToPipelineEvents(() => scheduleRefresh());
  tick = setInterval(() => void refresh(), TICK_MS);
  tick.unref();
};

/** Tears both back down. Called when the last client disconnects. */
const stop = (): void => {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
  if (unsubscribe) {
    void unsubscribe().catch((error) =>
      console.error("Failed to unsubscribe from pipeline events:", error)
    );
    unsubscribe = null;
  }
  // The next client starts from a clean slate rather than being deduped
  // against a snapshot from a previous session.
  lastSent = null;
};

/**
 * Registers a client and immediately pushes it a fresh snapshot, so the
 * dashboard has data the moment the stream opens — no separate first fetch.
 */
export const addStatsClient = (client: SseClient): void => {
  const isFirst = clients.size === 0;
  clients.add(client);
  if (isFirst) start();
  void refresh(true);
};

/** Deregisters a disconnected client, shutting the machinery down if it was the last. */
export const removeStatsClient = (client: SseClient): void => {
  if (!clients.delete(client)) return;
  if (clients.size === 0) stop();
};

/**
 * Ends every open stream. Must run *before* `server.close()` on shutdown —
 * SSE responses never finish on their own, so Node would otherwise wait for
 * them until the force-exit timer fires. See config/shutdown.ts.
 */
export const closeStatsBroadcast = (): void => {
  // Copy first: each close() calls back into removeStatsClient, which mutates
  // the set we'd otherwise be iterating.
  for (const client of [...clients]) client.close();
  clients.clear();
  stop();
};
