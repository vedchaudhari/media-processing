import mongoose, { Schema, Document, Model } from "mongoose";

// Single source of truth for valid statuses. The TS union and the Mongoose
// schema `enum` are both derived from this array so they can never drift.
export const VIDEO_STATUSES = [
  "uploading",
  "uploaded",
  "inspecting",
  "inspected",
  "planning",
  "planned",
  "transcoding",
  "completed",
  "failed",
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export interface IVideoMetadata {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
}

export interface IVideoVariant {
  height?: number;
  width?: number;
  bitrate?: number;
  codec?: string;
}

export interface IGeneratedFile {
  height?: number;
  objectKey?: string;
}

export interface IStreamingVariant {
  resolution?: string;
  playlist?: string;
}

export interface IStreaming {
  masterPlaylist?: string;
  variants?: IStreamingVariant[];
}

export type FailedStage = "inspection" | "planning" | "transcoding";

export interface IVideo extends Document {
  title?: string;
  objectKey?: string;
  status: VideoStatus;
  // 0–100 transcoding progress; meaningful while status is "transcoding".
  progress?: number;
  metadata?: IVideoMetadata;
  variants?: IVideoVariant[];
  generatedFiles?: IGeneratedFile[];
  streaming?: IStreaming;
  failedStage?: FailedStage;
  error?: string;
  failedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String },
    objectKey: { type: String },
    status: {
      type: String,
      enum: [...VIDEO_STATUSES],
      default: "uploading",
    },
    progress: { type: Number, default: 0 },
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
  },
  {
    timestamps: true,
  }
);

const Video: Model<IVideo> = mongoose.model<IVideo>("Video", videoSchema);

export default Video;
