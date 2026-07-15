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

const collectionName = "video_transcripts";

interface Chunk {
  text: string;
  start: number;
  end: number;
}

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

      // 2. Ensure Qdrant collection exists matching the active provider dimensions (with auto-healing for mismatches)
      const collections = await qdrantClient.getCollections();
      const exists = collections.collections.some((c) => c.name === collectionName);
      const expectedDimensions = EmbeddingService.getDimension();
      let shouldCreate = !exists;

      if (exists) {
        try {
          const info = await qdrantClient.getCollection(collectionName);
          const currentSize = (info.config?.params?.vectors as any)?.size;
          if (currentSize && currentSize !== expectedDimensions) {
            console.warn(`[Embeddings] Vector dimension mismatch for "${collectionName}": expected ${expectedDimensions}, found ${currentSize}. Re-creating collection...`);
            await qdrantClient.deleteCollection(collectionName);
            shouldCreate = true;
          }
        } catch (err) {
          console.error(`[Embeddings] Failed to fetch collection info, recreating...`, err);
          await qdrantClient.deleteCollection(collectionName).catch(() => {});
          shouldCreate = true;
        }
      }

      if (shouldCreate) {
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
      await Video.findByIdAndUpdate(videoId, {
        "vectorIndex.status": "failed",
        "vectorIndex.error": err instanceof Error ? err.message : String(err),
      });
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
