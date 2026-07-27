/**
 * Cross-process change notifications over Redis pub/sub.
 *
 * The pipeline runs as many processes: the API server plus one process per
 * worker (see package.json `dev:all`). Only the API server holds the
 * dashboard's SSE connections, but the *state changes worth pushing* happen
 * inside the workers. Redis is the one thing every process already talks to,
 * so it carries the "something changed" signal between them.
 *
 * Payloads are deliberately tiny — a notification, not the data. The API
 * server recomputes the dashboard snapshot itself, so a worker never has to
 * know what the dashboard renders.
 */
import type { Redis } from "ioredis";
import { redisConnection } from "../config/redis.js";

const PIPELINE_CHANNEL = "pipeline:events";

/**
 * Something changed that the dashboard may be showing. Currently the only
 * variant, but kept as a tagged union so new signals (e.g. `"user-changed"`)
 * can be added without changing every subscriber.
 */
export type PipelineEvent = { type: "video-changed" };

// A Redis connection in subscriber mode can't run normal commands, and the
// shared `redisConnection` is busy with BullMQ's blocking commands — so both
// directions get their own duplicated connection. Created lazily so a process
// that never publishes or subscribes (a one-off script, say) doesn't open one.
let publisher: Redis | null = null;

const getPublisher = (): Redis => {
  if (!publisher) {
    publisher = redisConnection.duplicate();
    publisher.on("error", (error) =>
      console.error("Pipeline event publisher error:", error)
    );
  }
  return publisher;
};

/**
 * Announces a change to every process. Fire-and-forget by design: this sits on
 * the hot path of pipeline writes, and a dropped notification must never fail
 * the write that triggered it (the dashboard's periodic refresh covers the gap).
 */
export const publishPipelineEvent = (event: PipelineEvent): void => {
  getPublisher()
    .publish(PIPELINE_CHANNEL, JSON.stringify(event))
    .catch((error) => console.error("Failed to publish pipeline event:", error));
};

/**
 * Subscribes to pipeline events on a dedicated connection.
 *
 * @returns An unsubscribe function that closes that connection. Call it on
 *          shutdown, or when the last consumer goes away.
 */
export const subscribeToPipelineEvents = (
  handler: (event: PipelineEvent) => void
): (() => Promise<void>) => {
  const subscriber = redisConnection.duplicate();

  subscriber.on("error", (error) =>
    console.error("Pipeline event subscriber error:", error)
  );

  subscriber.subscribe(PIPELINE_CHANNEL).catch((error) =>
    console.error("Failed to subscribe to pipeline events:", error)
  );

  subscriber.on("message", (channel, raw) => {
    if (channel !== PIPELINE_CHANNEL) return;
    try {
      handler(JSON.parse(raw) as PipelineEvent);
    } catch {
      // A malformed message must not take down the subscriber.
      console.error("Ignoring unparseable pipeline event:", raw);
    }
  });

  return async () => {
    await subscriber.quit();
  };
};
