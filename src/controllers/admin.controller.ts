/**
 * Admin-only controllers: cross-user visibility into videos, users, and the
 * BullMQ pipeline. Every export here is mounted behind requireAuth +
 * requireAdmin (see routes/admin.routes.ts) — none of these check ownership,
 * by design, since admins can see everything.
 */
import { type Request, type Response } from "express";
import Video from "../models/video.model.js";
import User from "../models/user.model.js";
import { computeAdminStats } from "../services/admin-stats.service.js";
import { openSseStream } from "../services/sse.service.js";
import {
  addStatsClient,
  removeStatsClient,
} from "../services/stats-broadcast.service.js";

/**
 * One-shot pipeline-health overview.
 *
 * The dashboard streams these numbers over `/stats/stream` instead of polling
 * this route, but it's kept as the plain-HTTP path: it's the initial render's
 * fallback if the stream can't be established (a proxy that buffers
 * `text/event-stream`, say), and it stays trivially usable from curl.
 */
export const getStats = async (_req: Request, res: Response) => {
  try {
    const stats = await computeAdminStats();
    return res.status(200).json({ success: true, ...stats });
  } catch (error) {
    console.error("getStats failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Live pipeline-health stream (SSE).
 *
 * Holds the response open and emits a `stats` event with the same payload as
 * getStats: once immediately on connect, then whenever the pipeline actually
 * moves. Replaces the dashboard's 5-second poll — see
 * services/stats-broadcast.service.ts for what drives the pushes.
 *
 * This is an ordinary GET, so it inherits requireAuth + requireAdmin from the
 * router like every other admin route.
 */
export const streamStats = (req: Request, res: Response) => {
  const client = openSseStream(req, res, () => removeStatsClient(client));
  addStatsClient(client);
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
