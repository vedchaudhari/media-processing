import { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import Video from "../models/video.model.js";
import { minioClient, VIDEO_BUCKET } from "../config/minio.js";
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
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const completeUpload = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    const video = await Video.findByIdAndUpdate(
      videoId,
      { status: "uploaded" },
      { returnDocument: "after" } // same as { new: true } in older Mongoose versions
    );

    if (!video) {
      return res.status(404).json({ success: false, message: "Video not found" });
    }

    // queue the uploaded video for inspection;
    // the inspection worker enqueues planning once metadata is ready
    await inspectionQueue.add("inspect-video", {
      videoId: video._id,
      objectKey: video.objectKey
    });

    return res.status(200).json({
      success: true,
      videoId: video._id,
      status: video.status,
    });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};
