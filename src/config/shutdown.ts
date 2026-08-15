import type { Server } from "node:http";
import mongoose from "mongoose";
import type { Queue, Worker } from "bullmq";
import { redisConnection } from "./redis.js";

interface ShutdownResources {

  server?: Server;

  worker?: Worker;

  queues?: Queue[];

  beforeServerClose?: () => void | Promise<void>;
}

const FORCE_EXIT_MS = 30_000;

export function registerGracefulShutdown(resources: ShutdownResources = {}): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down gracefully...`);

    const forceTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out — forcing exit.");
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    try {
      if (resources.beforeServerClose) {
        await resources.beforeServerClose();
      }

      if (resources.server) {
        await new Promise<void>((resolve, reject) => {
          resources.server!.close((err) => (err ? reject(err) : resolve()));
        });
        console.log("HTTP server closed");
      }

      if (resources.worker) {

        await resources.worker.close();
        console.log("Worker closed");
      }

      for (const queue of resources.queues ?? []) {
        await queue.close();
      }

      await mongoose.disconnect();
      console.log("MongoDB disconnected");

      await redisConnection.quit();
      console.log("Redis disconnected");
    } catch (err) {
      console.error("Error during graceful shutdown:", err);
      process.exitCode = 1;
    } finally {
      clearTimeout(forceTimer);
      process.exit(process.exitCode ?? 0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
