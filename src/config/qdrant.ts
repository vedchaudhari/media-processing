/**
 * Qdrant (vector database) client setup.
 *
 * Backs transcript semantic search / Ask-AI: the embedding worker upserts
 * transcript-chunk vectors here, and the /ask endpoint queries them. Warns (but
 * does not throw) when QDRANT_URL is unset so the rest of the app still boots.
 */
import { QdrantClient, type QdrantClientParams } from "@qdrant/js-client-rest";
import { env } from "./envconfig.js";

if (!env.qdrant.url) {
  console.warn("[Qdrant] Warning: QDRANT_URL is not configured.");
}

const params: QdrantClientParams = {};
if (env.qdrant.url) {
  params.url = env.qdrant.url;
}
if (env.qdrant.apiKey) {
  params.apiKey = env.qdrant.apiKey;
}

/** The process-wide Qdrant client (config-driven URL + optional API key). */
export const qdrantClient = new QdrantClient(params);
