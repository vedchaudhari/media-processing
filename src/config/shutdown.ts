import type { Server } from "node:http";
import mongoose from "mongoose";
import type { Queue, Worker } from "bullmq";
import { redisConnection } from "./redis.js";

interface ShutdownResources {
  // HTTP server (API process only).
  server?: Server;
  // BullMQ worker (worker processes). close() drains the in-flight job first.
  worker?: Worker;
  // Any queues this process produces to, so their resources are released.
  queues?: Queue[];
  // Runs BEFORE server.close(). Use it to end responses that never finish on
  // their own — an open SSE stream keeps its socket alive indefinitely, so
  // server.close() would hang on it until the force-exit timer fires.
  beforeServerClose?: () => void | Promise<void>;
}

// How long to wait for a graceful close before forcing exit. A worker draining
// a long FFmpeg job can legitimately take a while, but we never hang forever.
const FORCE_EXIT_MS = 30_000;

/**
 * Registers SIGINT/SIGTERM handlers that close the process's resources in a
 * sane order (hang up long-lived streams → stop accepting new work → drain
 * in-flight → disconnect Mongo → quit Redis) so restarts/deploys don't drop
 * jobs or leak connections.
 *
 * Idempotent: a second signal while already shutting down is ignored.
 */
export function registerGracefulShutdown(resources: ShutdownResources = {}): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down gracefully...`);

    // Safety net: if a close hangs, force-exit so we don't wedge forever.
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
        // waits for the active job to finish before resolving
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
