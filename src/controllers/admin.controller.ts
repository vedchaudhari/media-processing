import { type Request, type Response } from "express";
import Video from "../models/video.model.js";
import User from "../models/user.model.js";
import { computeAdminStats } from "../services/admin-stats.service.js";
import { openSseStream } from "../services/sse.service.js";
import {
  addStatsClient,
  removeStatsClient,
} from "../services/stats-broadcast.service.js";

export const getStats = async (_req: Request, res: Response) => {
  try {
    const stats = await computeAdminStats();
    return res.status(200).json({ success: true, ...stats });
  } catch (error) {
    console.error("getStats failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const streamStats = (req: Request, res: Response) => {
  const client = openSseStream(req, res, () => removeStatsClient(client));
  addStatsClient(client);
};

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
