/**
 * MongoDB connection setup (Mongoose).
 *
 * Imported by every process entry point — the API server and each worker —
 * so they all share one connection lifecycle.
 */
import mongoose from "mongoose";
import { env } from "./envconfig.js";

/**
 * Establishes the process-wide MongoDB connection via Mongoose.
 *
 * Called exactly once at startup by each entry point (API + every worker)
 * before any DB access. Mongoose keeps a single shared connection pool per
 * process afterward, so callers just import models and use them — no
 * connection is ever passed around.
 *
 * Fails fast: if the initial connect fails, the process exits with code 1
 * rather than running in a broken state (a supervisor/orchestrator is
 * expected to restart it). Transient drops *after* a successful connect are
 * handled by Mongoose's own reconnection logic, not here.
 *
 * @returns Resolves once connected.
 * @throws  Never returns on failure — calls process.exit(1).
 */
export const connectDB = async (): Promise<void> => {
  console.log("Connecting to MongoDB...");

  try {
    await mongoose.connect(env.mongoUri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
