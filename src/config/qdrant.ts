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

export const qdrantClient = new QdrantClient(params);
