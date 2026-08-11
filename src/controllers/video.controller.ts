import { type Request, type Response } from "express";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import Video from "../models/video.model.js";
import { env } from "../config/envconfig.js";
import { minioClient, VIDEO_BUCKET } from "../config/minio.js";
import { objectExists, removeObjects } from "../services/storage.service.js";
import { inspectionQueue } from "../queue/inspection.queue.js";
import { transcriptQueue } from "../queue/transcript.queue.js";
import { aiQueue } from "../queue/ai.queue.js";
import { embeddingQueue } from "../queue/embedding.queue.js";
import { qdrantClient } from "../config/qdrant.js";
import { AIService } from "../services/ai/ai.service.js";
import { EmbeddingService } from "../services/ai/embedding.service.js";
import type { IVideo } from "../models/video.model.js";
import type { AuthTokenPayload } from "../services/auth.service.js";

/**
 * True if `user` may read/act on `video` — its owner, or any admin. Every
 * per-video route (besides the owner-setting initiateUpload) checks this
 * before returning data, so one user can never see another's videos.
 */
const canAccessVideo = (video: IVideo, user: AuthTokenPayload): boolean =>
  video.owner.toString() === user.id || user.role === "admin";


/**
 * Step 1 of upload: reserves a Video record and returns a presigned PUT URL.
 *
 * Creates the record in "uploading" state and hands the client a 1-hour
 * presigned URL to upload the file straight to MinIO — bytes never pass through
 * the API. The client then calls completeUpload to start processing.
 */
export const initiateUpload = async (req: Request, res: Response) => {
  try {
    const { title } = req.body;

    const objectKey = `videos/${uuidv4()}/original.mp4`;

    // create the video record (status defaults to "uploading"), owned by the
    // authenticated caller (requireAuth guarantees req.user is set)
    const video = await Video.create({ title, objectKey, owner: req.user!.id });

    // presigned PUT url valid for 1 hour
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

/**
 * Step 2 of upload: confirms the file landed in storage and starts the pipeline.
 *
 * Verifies the object exists in MinIO, then atomically flips the record from
 * "uploading" to "uploaded" and enqueues inspection. The atomic check-and-set
 * makes this idempotent and race-safe — concurrent or duplicate calls can't
 * start the pipeline twice.
 */
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

    // idempotency guard: only an "uploading" record can be completed. A repeat
    // call (or a call on an already-processing video) is a no-op, not a
    // duplicate pipeline run.
    if (video.status !== "uploading") {
      return res.status(200).json({
        success: true,
        videoId: video._id,
        status: video.status,
      });
    }

    // don't trust the client: confirm the file actually landed in storage
    // before we mark it uploaded and kick off processing.
    if (!video.objectKey || !(await objectExists(VIDEO_BUCKET, video.objectKey))) {
      return res.status(409).json({
        success: false,
        message: "Upload not found in storage; complete the file upload first",
      });
    }

    // Atomic check-and-set: flip to "uploaded" only if the record is STILL
    // "uploading", returning the updated doc. This is the real guard — two
    // simultaneous completes can't both match, so only the first wins (gets a
    // non-null doc) and enqueues. The checks above just produce friendlier
    // responses for the common (non-racing) cases.
    const claimed = await Video.findOneAndUpdate(
      { _id: videoId, status: "uploading" },
      { status: "uploaded" },
      { returnDocument: "after" }
    );

    if (!claimed) {
      // lost the race: another request already completed this video, or it
      // was cancelled (and deleted) out from under us. Report its current
      // status without enqueuing a duplicate job.
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

    // queue the uploaded video for inspection;
    // the inspection worker enqueues planning once metadata is ready
    await inspectionQueue.add("inspect-video", {
      videoId: claimed._id,
      objectKey: claimed.objectKey,
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

/**
 * Cancels an in-progress upload: deletes the "uploading" record outright, as
 * if it never happened. Safe against the race with completeUpload — only a
 * record still in "uploading" is deleted, mirroring completeUpload's atomic
 * check-and-set. Also does a best-effort cleanup of the storage object in
 * case the file actually finished uploading moments before this arrived.
 */
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

    // Atomic check-and-delete: only remove the record if it's STILL
    // "uploading". If completeUpload already claimed it, this loses the race
    // on purpose — the upload is proceeding and cancelling is too late.
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

    // Best-effort: the PUT may have finished in storage a moment before this
    // request landed. Don't let a MinIO hiccup turn a successful cancel into
    // an error response.
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

type RetryStageName = "transcript" | "ai" | "embedding";

/**
 * Describes how to retry each of the three independent side-branch stages:
 * which field on the video doc holds its status, which queue/job re-runs it,
 * and (for the two that depend on the transcript) a precondition that must
 * hold before re-queueing is meaningful.
 */
const RETRY_STAGES: Record<
  RetryStageName,
  {
    field: "transcript" | "aiSummary" | "vectorIndex";
    queue: typeof transcriptQueue | typeof aiQueue | typeof embeddingQueue;
    jobName: string;
    precondition: (video: IVideo) => string | null; // returns an error message, or null if OK
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

/**
 * Retries one of the three independent side-branch stages (transcript, AI
 * insights, Ask-AI indexing) after it's reached a terminal "failed" state.
 * Atomically flips that stage's status from "failed" back to "pending" —
 * only if it's still "failed" at update time, so a double-click or a second
 * open tab can't queue the job twice — then re-adds it to the same queue the
 * automatic pipeline already uses.
 */
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
      // lost the race: another request already claimed this retry.
      return res.status(409).json({ success: false, message: "Already retrying" });
    }

    await config.queue.add(config.jobName, { videoId });

    return res.status(200).json({ success: true, stage, status: "pending" });
  } catch (error) {
    console.error("retryStage failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Lists all videos, newest first. Returns a lightweight projection (no heavy
 * metadata/variants/streaming) suitable for a list/dashboard view.
 */
export const listVideos = async (req: Request, res: Response) => {
  try {
    // only the caller's own videos — the admin API has the cross-user view
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

/**
 * Returns the URL the frontend (HLS.js) points at to play a finished video.
 *
 * The HLS outputs live under a public-read prefix (see setHlsPublicReadPolicy),
 * so we just hand back the master playlist's direct MinIO URL. The player
 * resolves the variant playlists and .ts segments from there on its own.
 */
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

    // only a fully transcoded video is playable; surface the current status so
    // the frontend can show "still processing" / "failed" instead of erroring.
    if (video.status !== "completed" || !video.streaming?.masterPlaylist) {
      // Include the same auxiliary fields as the 200 response — the frontend
      // reads them in its not-ready branch to show transcript/AI progress.
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

/**
 * Ask-AI endpoint: answers a natural-language question about a video.
 *
 * Retrieval-augmented: embeds the question, queries this video's transcript
 * vectors in Qdrant for the most relevant chunks, and asks the AI provider to
 * answer strictly from them — returning the answer plus timestamped source
 * segments. Short-circuits with a friendly message when the vector index is
 * still pending/failed/skipped or the collection doesn't exist yet.
 */
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
    // hard cap so a single question can't blow up the LLM call's token cost
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

    // Same dimension-scoped collection the embedding worker writes to. The
    // worker also creates the payload index at collection-creation time, so no
    // per-request index management is needed here.
    const collectionName = EmbeddingService.getCollectionName();

    // 1. Check if collection exists
    const collections = await qdrantClient.getCollections();
    const exists = collections.collections.some((c) => c.name === collectionName);
    if (!exists) {
      return res.status(200).json({
        success: true,
        answer: "AI search is still indexing this video's transcript. Please wait a moment and try again.",
        sources: [],
      });
    }

    // 2. Query Qdrant Cloud using Vector Embeddings
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

    // 3. Format and filter context segments by relevance score
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

    // Filter points: keep the best one, plus any others with score >= 0.4
    const filteredPoints = rawPoints.filter((p) => p.score === maxScore || p.score >= 0.4);

    const contextParts = filteredPoints.map((p) => {
      return `[Timestamp: ${formatTime(p.start)} - ${formatTime(p.end)}] ${p.text}`;
    });
    const context = contextParts.join("\n");

    // 4. Generate answer using AIService
    console.log(`[Ask AI] Asking provider with context...`);
    const answer = await AIService.askQuestion(context, question);

    // 5. Build source segments list (de-duplicated and sorted chronologically)
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

