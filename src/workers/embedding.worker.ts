/**
 * Embedding worker — non-blocking side branch (vector indexing for Ask-AI).
 *
 * Consumes "generate-embeddings" jobs: chunks the transcript segments, embeds
 * each chunk (EmbeddingService), ensures the dimension-scoped Qdrant collection
 * exists, and upserts the vectors keyed by videoId. A transcript with no
 * segments is marked "skipped".
 *
 * Marks the vector index "failed" only once retries are exhausted. Runs as its
 * own process.
 */
import { Worker, type Job } from "bullmq";
import { redisConnection } from "../config/redis.js";
import { EMBEDDING_QUEUE } from "../queue/embedding.queue.js";
import { connectDB } from "../config/db.js";
import { registerGracefulShutdown } from "../config/shutdown.js";
import Video from "../models/video.model.js";
import { qdrantClient } from "../config/qdrant.js";
import { v4 as uuidv4 } from "uuid";
import { EmbeddingService } from "../services/ai/embedding.service.js";

await connectDB();

// Dimension-scoped name (e.g. video_transcripts_768): a provider switch uses a
// new collection rather than requiring the old one to be deleted.
const collectionName = EmbeddingService.getCollectionName();

interface Chunk {
  text: string;
  start: number;
  end: number;
}

/**
 * Groups consecutive transcript segments into ~`maxChunkLength`-char chunks,
 * preserving each chunk's start/end times. Chunking keeps every embedded unit
 * semantically coherent and within the embedding model's ideal input size,
 * while the retained timestamps let search results link back to the video.
 */
function chunkTranscript(
  segments: Array<{ text: string; start: number; end: number }>,
  maxChunkLength = 500
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentStart = 0;
  let currentEnd = 0;

  for (const seg of segments) {
    if (!currentText) {
      currentStart = seg.start;
      currentText = seg.text;
      currentEnd = seg.end;
    } else if (currentText.length + seg.text.length + 1 <= maxChunkLength) {
      currentText += " " + seg.text;
      currentEnd = seg.end;
    } else {
      chunks.push({ text: currentText, start: currentStart, end: currentEnd });
      currentStart = seg.start;
      currentText = seg.text;
      currentEnd = seg.end;
    }
  }

  if (currentText) {
    chunks.push({ text: currentText, start: currentStart, end: currentEnd });
  }

  return chunks;
}

const embeddingWorker = new Worker(
  EMBEDDING_QUEUE,
  async (job: Job) => {
    const { videoId } = job.data;
    console.log(`[Embeddings] Processing job for videoId: ${videoId}`);

    try {
      await Video.findByIdAndUpdate(videoId, {
        "vectorIndex.status": "processing",
      });

      const video = await Video.findById(videoId);
      if (!video) {
        throw new Error(`Video ${videoId} not found`);
      }

      const segments = video.transcript?.segments;
      if (!segments || segments.length === 0) {
        console.log(`[Embeddings] No transcript segments for ${videoId}; skipping embedding`);
        await Video.findByIdAndUpdate(videoId, {
          "vectorIndex.status": "skipped",
        });
        return;
      }

      // Convert mongoose subdocument array to standard array
      const plainSegments = segments.map(s => ({
        text: s.text ?? "",
        start: s.start ?? 0,
        end: s.end ?? 0,
      }));

      // 1. Chunk transcript segments
      const chunks = chunkTranscript(plainSegments);

      // 2. Ensure the Qdrant collection exists. The name embeds the vector
      // dimension, so a dimension mismatch is impossible by construction — no
      // destructive delete-and-recreate needed.
      const collections = await qdrantClient.getCollections();
      const exists = collections.collections.some((c) => c.name === collectionName);
      const expectedDimensions = EmbeddingService.getDimension();

      if (!exists) {
        console.log(`[Embeddings] Creating collection "${collectionName}" with ${expectedDimensions} dimensions...`);
        await qdrantClient.createCollection(collectionName, {
          vectors: { size: expectedDimensions, distance: "Cosine" },
        });
        console.log(`[Embeddings] Creating payload index for "videoId"...`);
        await qdrantClient.createPayloadIndex(collectionName, {
          field_name: "videoId",
          field_schema: "keyword",
        });
      }

      // 3. Generate vectors using EmbeddingService
      console.log(`[Embeddings] Generating vectors for ${chunks.length} chunks...`);
      const points = [];
      for (const chunk of chunks) {
        const vector = await EmbeddingService.embedText(chunk.text, "document");

        points.push({
          id: uuidv4(),
          vector,
          payload: {
            videoId: videoId.toString(),
            text: chunk.text,
            start: chunk.start,
            end: chunk.end,
          },
        });
      }

      // 4. Upsert points to Qdrant
      console.log(`[Embeddings] Upserting ${points.length} points to Qdrant...`);
      await qdrantClient.upsert(collectionName, {
        wait: true,
        points,
      });

      console.log(`[Embeddings] Embedding successfully indexed in Qdrant for videoId: ${videoId}`);
      await Video.findByIdAndUpdate(videoId, {
        "vectorIndex.status": "completed",
      });
    } catch (err) {
      console.error(`[Embeddings] Embedding failed for ${videoId}:`, err);
      // Only mark "failed" once retries are exhausted — an intermediate
      // "failed" makes the frontend stop polling and miss a later success.
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await Video.findByIdAndUpdate(videoId, {
          "vectorIndex.status": "failed",
          "vectorIndex.error": err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

registerGracefulShutdown({ worker: embeddingWorker });

console.log("Embedding Worker started");

export default embeddingWorker;
