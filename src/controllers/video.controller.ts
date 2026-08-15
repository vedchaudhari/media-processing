import { type Request, type Response } from "express";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import Video from "../models/video.model.js";
import { env } from "../config/envconfig.js";
import { minioClient, VIDEO_BUCKET } from "../config/minio.js";
import { objectExists, removeObjects } from "../services/storage.service.js";
import { inspectionQueue } from "../queue/inspection.queue.js";
import { RETRY_STAGES, type RetryStageName } from "../services/video-retry.service.js";
import { qdrantClient } from "../config/qdrant.js";
import { AIService } from "../services/ai/ai.service.js";
import { EmbeddingService } from "../services/ai/embedding.service.js";
import type { IVideo } from "../models/video.types.js";
import type { AuthTokenPayload } from "../services/auth.service.js";

const canAccessVideo = (video: IVideo, user: AuthTokenPayload): boolean =>
  video.owner.toString() === user.id || user.role === "admin";

export const initiateUpload = async (req: Request, res: Response) => {
  try {
    const { title } = req.body;

    const objectKey = `videos/${uuidv4()}/original.mp4`;

    const video = await Video.create({ title, objectKey, owner: req.user!.id });

    const uploadUrl = await minioClient.presignedPutObject(
      VIDEO_BUCKET,
      objectKey,
      60 * 60
    );

    return res.status(201).json({
      success: true,
      videoId: video._id,
      objectKey,
      uploadUrl,
    });
  } catch (error) {
    console.error("initiateUpload failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const completeUpload = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    if (!videoId || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ success: false, message: "Invalid video id" });
    }

    const video = await Video.findById(videoId);

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    if (!canAccessVideo(video, req.user!)) {
      return res.status(403).json({ success: false, message: "Not your video" });
    }

    if (video.status !== "uploading") {
      return res.status(200).json({
        success: true,
        videoId: video._id,
        status: video.status,
      });
    }

    if (!video.objectKey || !(await objectExists(VIDEO_BUCKET, video.objectKey))) {
      return res.status(409).json({
        success: false,
        message: "Upload not found in storage; complete the file upload first",
      });
    }

    const claimed = await Video.findOneAndUpdate(
      { _id: videoId, status: "uploading" },
      { status: "uploaded" },
      { returnDocument: "after" }
    );

    if (!claimed) {

      const current = await Video.findById(videoId);
      if (!current) {
        return res.status(404).json({ success: false, message: "Video was cancelled" });
      }
      return res.status(200).json({
        success: true,
        videoId,
        status: current.status,
      });
    }

    await inspectionQueue.add("inspect-video", {
      videoId: claimed._id.toString(),

      objectKey: claimed.objectKey!,
    });

    return res.status(200).json({
      success: true,
      videoId: claimed._id,
      status: claimed.status,
    });
  } catch (error) {
    console.error("completeUpload failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const cancelUpload = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    if (!videoId || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ success: false, message: "Invalid video id" });
    }

    const video = await Video.findById(videoId);

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    if (!canAccessVideo(video, req.user!)) {
      return res.status(403).json({ success: false, message: "Not your video" });
    }

    const deleted = await Video.findOneAndDelete({ _id: videoId, status: "uploading" });

    if (!deleted) {
      const current = await Video.findById(videoId);
      return res.status(200).json({
        success: true,
        cancelled: false,
        videoId,
        status: current?.status,
      });
    }

    try {
      if (deleted.objectKey && (await objectExists(VIDEO_BUCKET, deleted.objectKey))) {
        await removeObjects(VIDEO_BUCKET, [deleted.objectKey]);
      }
    } catch (cleanupError) {
      console.error("cancelUpload storage cleanup failed:", cleanupError);
    }

    return res.status(200).json({ success: true, cancelled: true, videoId });
  } catch (error) {
    console.error("cancelUpload failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const retryStage = async (req: Request, res: Response) => {
  try {
    const { videoId, stage } = req.params;

    if (!videoId || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ success: false, message: "Invalid video id" });
    }

    const config = RETRY_STAGES[stage as RetryStageName];
    if (!config) {
      return res.status(400).json({ success: false, message: "Invalid retry stage" });
    }

    const video = await Video.findById(videoId);

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    if (!canAccessVideo(video, req.user!)) {
      return res.status(403).json({ success: false, message: "Not your video" });
    }

    const currentStatus = video[config.field]?.status;
    if (currentStatus !== "failed") {
      return res.status(409).json({
        success: false,
        message: `${stage} is not in a failed state (currently: ${currentStatus ?? "unknown"})`,
      });
    }

    const preconditionError = config.precondition(video);
    if (preconditionError) {
      return res.status(409).json({ success: false, message: preconditionError });
    }

    const claimed = await Video.findOneAndUpdate(
      { _id: videoId, [`${config.field}.status`]: "failed" },
      { $set: { [`${config.field}.status`]: "pending", [`${config.field}.error`]: undefined } },
      { returnDocument: "after" }
    );

    if (!claimed) {

      return res.status(409).json({ success: false, message: "Already retrying" });
    }

    await config.queue.add(config.jobName, { videoId: videoId as string });

    return res.status(200).json({ success: true, stage, status: "pending" });
  } catch (error) {
    console.error("retryStage failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const listVideos = async (req: Request, res: Response) => {
  try {

    const videos = await Video.find({ owner: req.user!.id })
      .select("title status progress thumbnail createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const result = videos.map((v) => ({
      id: v._id,
      title: v.title,
      status: v.status,
      progress: v.progress ?? 0,
      thumbnailUrl: v.thumbnail
        ? `${env.minio.publicUrl}/${VIDEO_BUCKET}/${v.thumbnail}`
        : null,
      createdAt: v.createdAt,
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error("listVideos failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getPlay = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    if (!videoId || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ success: false, message: "Invalid video id" });
    }

    const video = await Video.findById(videoId);

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    if (!canAccessVideo(video, req.user!)) {
      return res.status(403).json({ success: false, message: "Not your video" });
    }

    if (video.status !== "completed" || !video.streaming?.masterPlaylist) {

      return res.status(409).json({
        success: false,
        videoId: video._id,
        status: video.status,
        progress: video.progress ?? 0,
        thumbnailUrl: video.thumbnail
          ? `${env.minio.publicUrl}/${VIDEO_BUCKET}/${video.thumbnail}`
          : null,
        transcript: video.transcript ?? null,
        aiSummary: video.aiSummary ?? null,
        vectorIndex: video.vectorIndex ?? null,
        message: "Video is not ready for playback",
      });
    }

    const playbackUrl = `${env.minio.publicUrl}/${VIDEO_BUCKET}/${video.streaming.masterPlaylist}`;

    return res.status(200).json({
      success: true,
      videoId: video._id,
      title: video.title,
      status: video.status,
      playbackUrl,
      thumbnailUrl: video.thumbnail
        ? `${env.minio.publicUrl}/${VIDEO_BUCKET}/${video.thumbnail}`
        : null,
      transcript: video.transcript ?? null,
      aiSummary: video.aiSummary ?? null,
      vectorIndex: video.vectorIndex ?? null,
    });
  } catch (error) {
    console.error("getPlay failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const askVideo = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    const { question } = req.body;

    if (!videoId || typeof videoId !== "string" || !mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ message: "Question is required" });
    }

    if (question.length > 2000) {
      return res.status(400).json({ message: "Question is too long (max 2000 characters)" });
    }

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ message: "Video not found" });
    }

    if (!canAccessVideo(video, req.user!)) {
      return res.status(403).json({ message: "Not your video" });
    }

    const indexStatus = video.vectorIndex?.status || "completed";
    if (indexStatus === "pending" || indexStatus === "processing") {
      return res.status(200).json({
        success: true,
        answer: "AI search is still indexing this video's transcript. Please wait a moment and try again.",
        sources: [],
      });
    }
    if (indexStatus === "failed") {
      return res.status(200).json({
        success: true,
        answer: "AI search indexing failed for this video. Ask AI is not available.",
        sources: [],
      });
    }
    if (indexStatus === "skipped") {
      return res.status(200).json({
        success: true,
        answer: "No speech was detected in this video, so Ask AI is not available.",
        sources: [],
      });
    }

    const collectionName = EmbeddingService.getCollectionName();

    const collections = await qdrantClient.getCollections();
    const exists = collections.collections.some((c) => c.name === collectionName);
    if (!exists) {
      return res.status(200).json({
        success: true,
        answer: "AI search is still indexing this video's transcript. Please wait a moment and try again.",
        sources: [],
      });
    }

    console.log(`[Ask AI] Querying Qdrant for videoId: ${videoId}, question: "${question}"`);
    const queryVector = await EmbeddingService.embedText(question, "query");

    const results = await qdrantClient.query(collectionName, {
      query: queryVector,
      filter: {
        must: [
          {
            key: "videoId",
            match: { value: videoId.toString() },
          },
        ],
      },
      with_payload: true,
      limit: 4,
    });

    if (!results.points || results.points.length === 0) {
      return res.status(200).json({
        success: true,
        answer: "I couldn't find any relevant sections in this video to answer that question.",
        sources: [],
      });
    }

    const formatTime = (secs: number) => {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return `${m}:${s.toString().padStart(2, "0")}`;
    };

    const rawPoints = results.points.map((p: any) => ({
      text: p.payload?.text ?? "",
      start: p.payload?.start ?? 0,
      end: p.payload?.end ?? 0,
      score: p.score ?? 0,
    }));

    const maxScore = rawPoints.length > 0 ? Math.max(...rawPoints.map((p) => p.score)) : 0;

    const filteredPoints = rawPoints.filter((p) => p.score === maxScore || p.score >= 0.4);

    const contextParts = filteredPoints.map((p) => {
      return `[Timestamp: ${formatTime(p.start)} - ${formatTime(p.end)}] ${p.text}`;
    });
    const context = contextParts.join("\n");

    console.log(`[Ask AI] Asking provider with context...`);
    const answer = await AIService.askQuestion(context, question);

    const seenStarts = new Set<number>();
    const sources = filteredPoints
      .filter((s) => {
        if (seenStarts.has(s.start)) return false;
        seenStarts.add(s.start);
        return true;
      })
      .sort((a, b) => a.start - b.start);

    return res.status(200).json({
      success: true,
      answer,
      sources,
    });
  } catch (error) {
    console.error("askVideo failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

