import mongoose, { Schema, Model } from "mongoose";
import { publishPipelineEvent } from "../services/events.service.js";
import { VIDEO_STATUSES, type IVideo } from "./video.types.js";

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String },
    objectKey: { type: String },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: {
      type: String,
      enum: [...VIDEO_STATUSES],
      default: "uploading",
    },
    progress: { type: Number, default: 0 },
    thumbnail: { type: String },
    transcript: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
      },
      text: { type: String },
      segments: [
        {
          start: { type: Number },
          end: { type: Number },
          text: { type: String },
        },
      ],
      objectKey: { type: String },
      error: { type: String },
    },
    aiSummary: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed", "skipped"],
        default: "pending",
      },
      summary: { type: String },
      keyTakeaways: [{ type: String }],
      technologies: [{ type: String }],
      chapters: [
        {
          start: { type: Number },
          title: { type: String },
        },
      ],
      error: { type: String },
    },
    vectorIndex: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed", "skipped"],
        default: "pending",
      },
      error: { type: String },
    },
    metadata: {
      width: { type: Number },
      height: { type: Number },
      duration: { type: Number },
      fps: { type: Number },
      videoCodec: { type: String },
      audioCodec: { type: String },
      bitrate: { type: Number },
    },
    variants: [
      {
        height: { type: Number },
        width: { type: Number },
        bitrate: { type: Number },
        codec: { type: String },
      },
    ],
    generatedFiles: [
      {
        height: { type: Number },
        objectKey: { type: String },
      },
    ],
    streaming: {
      masterPlaylist: { type: String },
      variants: [
        {
          resolution: { type: String },
          playlist: { type: String },
        },
      ],
    },
    failedStage: { type: String },
    error: { type: String },
    failedAt: { type: Date },
    stageTimestamps: {
      inspectionStartedAt: { type: Date },
      inspectionCompletedAt: { type: Date },
      planningCompletedAt: { type: Date },
      transcodingStartedAt: { type: Date },
      transcodingCompletedAt: { type: Date },
    },
  },
  {
    timestamps: true,
  }
);

const notifyVideoChanged = (): void => {
  publishPipelineEvent({ type: "video-changed" });
};

videoSchema.post("save", notifyVideoChanged);
videoSchema.post("insertMany", notifyVideoChanged);
videoSchema.post("findOneAndUpdate", notifyVideoChanged);
videoSchema.post("findOneAndDelete", notifyVideoChanged);
videoSchema.post("updateOne", notifyVideoChanged);
videoSchema.post("updateMany", notifyVideoChanged);
videoSchema.post("deleteOne", notifyVideoChanged);
videoSchema.post("deleteMany", notifyVideoChanged);

const Video: Model<IVideo> = mongoose.model<IVideo>("Video", videoSchema);

export default Video;
