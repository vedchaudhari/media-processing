import { computeAdminStats } from "./admin-stats.service.js";
import { subscribeToPipelineEvents } from "./events.service.js";
import type { SseClient } from "./sse.service.js";

const DEBOUNCE_MS = 300;

const TICK_MS = 10_000;

const clients = new Set<SseClient>();

let unsubscribe: (() => Promise<void>) | null = null;
let tick: NodeJS.Timeout | null = null;
let debounce: NodeJS.Timeout | null = null;

let lastSent: string | null = null;

let refreshing = false;
let refreshQueued = false;

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

const scheduleRefresh = (): void => {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void refresh();
  }, DEBOUNCE_MS);
  debounce.unref();
};

const start = (): void => {
  unsubscribe = subscribeToPipelineEvents(() => scheduleRefresh());
  tick = setInterval(() => void refresh(), TICK_MS);
  tick.unref();
};

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

  lastSent = null;
};

export const addStatsClient = (client: SseClient): void => {
  const isFirst = clients.size === 0;
  clients.add(client);
  if (isFirst) start();
  void refresh(true);
};

export const removeStatsClient = (client: SseClient): void => {
  if (!clients.delete(client)) return;
  if (clients.size === 0) stop();
};

export const closeStatsBroadcast = (): void => {

  for (const client of [...clients]) client.close();
  clients.clear();
  stop();
};
