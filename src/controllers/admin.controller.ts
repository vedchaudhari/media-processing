/**
 * Admin-only controllers: cross-user visibility into videos, users, and the
 * BullMQ pipeline. Every export here is mounted behind requireAuth +
 * requireAdmin (see routes/admin.routes.ts) — none of these check ownership,
 * by design, since admins can see everything.
 */
import { type Request, type Response } from "express";
import Video, { VIDEO_STATUSES } from "../models/video.model.js";
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

/**
 * Pipeline-health overview: video counts by status/failedStage, per-queue job
 * counts (waiting/active/failed/etc.), user totals, and the most recent
 * failures across every user's videos — the single screen for "is anything
 * stuck or broken right now."
 */
export const getStats = async (_req: Request, res: Response) => {
  try {
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

    // fill in every status/stage with 0 so the frontend never has to guess
    // about ones with no videos yet, instead of just the ones that occurred
    const byStatus: Record<string, number> = Object.fromEntries(
      VIDEO_STATUSES.map((s) => [s, 0])
    );
    for (const row of statusCounts) byStatus[row._id] = row.count;

    const byFailedStage: Record<string, number> = {};
    for (const row of failedStageCounts) byFailedStage[row._id] = row.count;

    const queues = Object.fromEntries(queueEntries);

    return res.status(200).json({
      success: true,
      totalUsers,
      totalVideos,
      byStatus,
      byFailedStage,
      queues,
      recentFailures,
    });
  } catch (error) {
    console.error("getStats failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/** Lists every video across every user, newest first, paginated. */
export const listAllVideos = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const [videos, total] = await Promise.all([
      Video.find()
        .select("title status progress failedStage createdAt owner")
        .populate("owner", "email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Video.countDocuments(),
    ]);

    return res.status(200).json({ success: true, videos, total, page, limit });
  } catch (error) {
    console.error("listAllVideos failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/** Lists every user account with their video count. */
export const listUsers = async (_req: Request, res: Response) => {
  try {
    const users = await User.aggregate([
      {
        $lookup: {
          from: "videos",
          localField: "_id",
          foreignField: "owner",
          as: "videos",
        },
      },
      {
        $project: {
          email: 1,
          role: 1,
          createdAt: 1,
          videoCount: { $size: "$videos" },
        },
      },
      { $sort: { createdAt: 1 } },
    ]);

    return res.status(200).json({ success: true, users });
  } catch (error) {
    console.error("listUsers failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
