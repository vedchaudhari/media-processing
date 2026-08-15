import type { Redis } from "ioredis";
import { redisConnection } from "../config/redis.js";

const PIPELINE_CHANNEL = "pipeline:events";

export type PipelineEvent = { type: "video-changed" };

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

export const publishPipelineEvent = (event: PipelineEvent): void => {
  getPublisher()
    .publish(PIPELINE_CHANNEL, JSON.stringify(event))
    .catch((error) => console.error("Failed to publish pipeline event:", error));
};

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

      console.error("Ignoring unparseable pipeline event:", raw);
    }
  });

  return async () => {
    await subscriber.quit();
  };
};
