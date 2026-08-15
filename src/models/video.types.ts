import mongoose, { Document } from "mongoose";

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

export interface IStageTimestamps {
  inspectionStartedAt?: Date;
  inspectionCompletedAt?: Date;
  planningCompletedAt?: Date;
  transcodingStartedAt?: Date;
  transcodingCompletedAt?: Date;
}

export interface ITranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ITranscript {
  status: "pending" | "processing" | "completed" | "failed";
  text?: string;
  segments?: ITranscriptSegment[];
  objectKey?: string;
  error?: string;
}

export interface IChapter {
  start: number;
  title: string;
}

export interface IAISummary {

  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  summary?: string;
  keyTakeaways?: string[];
  technologies?: string[];
  chapters?: IChapter[];
  error?: string;
}

export interface IVectorIndex {
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  error?: string;
}

export type FailedStage = "upload" | "inspection" | "planning" | "transcoding";

export interface IVideo extends Document {
  title?: string;
  objectKey?: string;

  owner: mongoose.Types.ObjectId;
  status: VideoStatus;

  progress?: number;
  thumbnail?: string;
  transcript?: ITranscript;
  aiSummary?: IAISummary;
  vectorIndex?: IVectorIndex;
  metadata?: IVideoMetadata;
  variants?: IVideoVariant[];
  generatedFiles?: IGeneratedFile[];
  streaming?: IStreaming;
  failedStage?: FailedStage;
  error?: string;
  failedAt?: Date;
  stageTimestamps?: IStageTimestamps;
  createdAt: Date;
  updatedAt: Date;
}
