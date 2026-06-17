import { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import Video from "../models/video.model.js";
import { minioClient, VIDEO_BUCKET } from "../config/minio.js";
import { objectExists } from "../services/storage.service.js";
import { inspectionQueue } from "../queue/inspection.queue.js";

export const initiateUpload = async (req: Request, res: Response) => {
  try {
    const { title } = req.body;

    const objectKey = `videos/${uuidv4()}/original.mp4`;

    // create the video record (status defaults to "uploading")
    const video = await Video.create({ title, objectKey });

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

export const completeUpload = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    if (typeof videoId !== "string") {
      return res.status(400).json({ success: false, message: "Invalid video id" });
    }

    const video = await Video.findById(videoId);

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
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
      // lost the race: another request already completed this video. Report
      // its current status without enqueuing a duplicate job.
      const current = await Video.findById(videoId);
      return res.status(200).json({
        success: true,
        videoId,
        status: current?.status,
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
