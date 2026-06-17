import mongoose, { Schema, Document, Model } from "mongoose";

export type VideoStatus =
  | "uploading"
  | "uploaded"
  | "inspecting"
  | "inspected"
  | "planning"
  | "planned"
  | "transcoding"
  | "completed"
  | "failed";

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

export interface IVideo extends Document {
  title?: string;
  objectKey?: string;
  status: VideoStatus;
  metadata?: IVideoMetadata;
  variants?: IVideoVariant[];
  generatedFiles?: IGeneratedFile[];
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String },
    objectKey: { type: String },
    status: {
      type: String,
      default: "uploading",
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
  },
  {
    timestamps: true,
  }
);

const Video: Model<IVideo> = mongoose.model<IVideo>("Video", videoSchema);

export default Video;
