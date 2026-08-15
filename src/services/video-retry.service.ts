import { transcriptQueue } from "../queue/transcript.queue.js";
import { aiQueue } from "../queue/ai.queue.js";
import { embeddingQueue } from "../queue/embedding.queue.js";
import type { IVideo } from "../models/video.types.js";

export type RetryStageName = "transcript" | "ai" | "embedding";

export const RETRY_STAGES: Record<
  RetryStageName,
  {
    field: "transcript" | "aiSummary" | "vectorIndex";
    queue: typeof transcriptQueue | typeof aiQueue | typeof embeddingQueue;
    jobName: string;
    precondition: (video: IVideo) => string | null;
  }
> = {
  transcript: {
    field: "transcript",
    queue: transcriptQueue,
    jobName: "transcribe-video",
    precondition: () => null,
  },
  ai: {
    field: "aiSummary",
    queue: aiQueue,
    jobName: "generate-summary",
    precondition: (video) =>
      video.transcript?.status === "completed" && video.transcript.text?.trim()
        ? null
        : "Transcript must finish successfully before retrying AI insights.",
  },
  embedding: {
    field: "vectorIndex",
    queue: embeddingQueue,
    jobName: "generate-embeddings",
    precondition: (video) =>
      video.transcript?.status === "completed" && (video.transcript.segments?.length ?? 0) > 0
        ? null
        : "Transcript must finish successfully before retrying Ask AI indexing.",
  },
};
