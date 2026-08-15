import Video from "../models/video.model.js";
import { VIDEO_STATUSES } from "../models/video.types.js";
import User from "../models/user.model.js";
import { inspectionQueue } from "../queue/inspection.queue.js";
import { plannerQueue } from "../queue/planner.queue.js";
import { transcoderQueue } from "../queue/transcoder.queue.js";
import { thumbnailQueue } from "../queue/thumbnail.queue.js";
import { transcriptQueue } from "../queue/transcript.queue.js";
import { aiQueue } from "../queue/ai.queue.js";
import { embeddingQueue } from "../queue/embedding.queue.js";

const QUEUES = {
  inspection: inspectionQueue,
  planner: plannerQueue,
  transcoder: transcoderQueue,
  thumbnail: thumbnailQueue,
  transcript: transcriptQueue,
  ai: aiQueue,
  embedding: embeddingQueue,
} as const;

export interface AdminStats {
  totalUsers: number;
  totalVideos: number;
  byStatus: Record<string, number>;
  byFailedStage: Record<string, number>;
  queues: Record<string, Record<string, number>>;
  recentFailures: unknown[];
}

export const computeAdminStats = async (): Promise<AdminStats> => {
  const [statusCounts, failedStageCounts, totalUsers, totalVideos, recentFailures, queueEntries] =
    await Promise.all([
      Video.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Video.aggregate([
        { $match: { failedStage: { $exists: true } } },
        { $group: { _id: "$failedStage", count: { $sum: 1 } } },
      ]),
      User.countDocuments(),
      Video.countDocuments(),
      Video.find({ status: "failed" })
        .select("title failedStage error failedAt owner")
        .populate("owner", "email")
        .sort({ failedAt: -1 })
        .limit(20)
        .lean(),
      Promise.all(
        Object.entries(QUEUES).map(async ([name, queue]) => [
          name,
          await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
        ] as const)
      ),
    ]);

  const byStatus: Record<string, number> = Object.fromEntries(
    VIDEO_STATUSES.map((s) => [s, 0])
  );
  for (const row of statusCounts) byStatus[row._id] = row.count;

  const byFailedStage: Record<string, number> = {};
  for (const row of failedStageCounts) byFailedStage[row._id] = row.count;

  return {
    totalUsers,
    totalVideos,
    byStatus,
    byFailedStage,
    queues: Object.fromEntries(queueEntries),
    recentFailures,
  };
};
