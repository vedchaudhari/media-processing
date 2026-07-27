
/**
 * The Video document — the single source of truth for a video's state.
 *
 * Every pipeline stage (inspection → planning → transcoding, plus the
 * thumbnail / transcript / AI / vector side-branches) reads and writes this
 * one document, and the API serves its fields to the frontend. The nested
 * sub-objects below mirror the outputs of each stage.
 */
import mongoose, { Schema, Document, Model } from "mongoose";
import { publishPipelineEvent } from "../services/events.service.js";

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

/** Union of every valid `status` value, derived from VIDEO_STATUSES. */
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Technical properties probed from the source file by ffprobe (inspection stage). */
export interface IVideoMetadata {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
}

/** One rung of the transcode ladder the planner decides to produce. */
export interface IVideoVariant {
  height?: number;
  width?: number;
  bitrate?: number;
  codec?: string;
}

/** Bookkeeping for a generated rendition file, keyed by height. */
export interface IGeneratedFile {
  height?: number;
  objectKey?: string;
}

/** One rendition entry in the finished HLS output: resolution + its playlist key. */
export interface IStreamingVariant {
  resolution?: string;
  playlist?: string;
}

/** The finished HLS package: the master playlist plus each rendition's playlist. */
export interface IStreaming {
  masterPlaylist?: string;
  variants?: IStreamingVariant[];
}

/**
 * When each main-pipeline stage started/finished. Purely observational — no
 * code branches on these — they exist so the admin dashboard can show
 * average time-per-stage, which is otherwise uncomputable (only
 * createdAt/updatedAt/failedAt existed before).
 */
export interface IStageTimestamps {
  inspectionStartedAt?: Date;
  inspectionCompletedAt?: Date;
  planningCompletedAt?: Date;
  transcodingStartedAt?: Date;
  transcodingCompletedAt?: Date;
}

/** One timestamped line of the transcript — powers the click-to-seek UI. */
export interface ITranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Speech-to-text output, with its own independent status lifecycle. */
export interface ITranscript {
  status: "pending" | "processing" | "completed" | "failed";
  text?: string;
  segments?: ITranscriptSegment[];
  objectKey?: string;
  error?: string;
}

/** An AI-generated chapter marker: a start time and a title. */
export interface IChapter {
  start: number;
  title: string;
}

/** LLM-generated insights derived from the transcript (summary, takeaways, chapters). */
export interface IAISummary {
  // "skipped" = there was no transcript text to summarize (e.g. a video with
  // no speech); a terminal, non-error outcome distinct from "failed".
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  summary?: string;
  keyTakeaways?: string[];
  technologies?: string[];
  chapters?: IChapter[];
  error?: string;
}

/** Tracks whether the transcript has been embedded into the vector store for search. */
export interface IVectorIndex {
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  error?: string;
}

// "upload" = the client initiated an upload but never completed it (marked by
// the stale-upload sweeper in startup/, since the presigned URL has expired).
export type FailedStage = "upload" | "inspection" | "planning" | "transcoding";

/**
 * The full Video document as stored in MongoDB.
 *
 * Fields are populated incrementally as the video moves through the pipeline:
 * `objectKey` at upload, `metadata` after inspection, `variants` after
 * planning, `streaming`/`progress` during and after transcoding, and the
 * `transcript`/`aiSummary`/`vectorIndex` side-branches independently. Nearly
 * everything is optional because at any given moment only the stages that have
 * run so far have written their part.
 */
export interface IVideo extends Document {
  title?: string;
  objectKey?: string;
  // The account that uploaded this video. Every video route scopes reads/
  // writes to `owner === req.user.id`, except the admin API which sees all.
  owner: mongoose.Types.ObjectId;
  status: VideoStatus;
  // 0–100 transcoding progress; meaningful while status is "transcoding".
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

/**
 * Mongoose schema backing IVideo.
 *
 * `timestamps: true` auto-manages `createdAt`/`updatedAt`. The nested objects
 * (`transcript`, `aiSummary`, `vectorIndex`) each default their `status` to
 * "pending", so a freshly created document already reflects "not started yet"
 * for every side-branch without any extra initialization.
 */
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

/**
 * Announces every write to this collection so the admin dashboard's SSE stream
 * can push a fresh snapshot (see services/stats-broadcast.service.ts).
 *
 * Hooked at the schema rather than at the ~25 call sites that move a video
 * through the pipeline: those live across seven worker processes plus the
 * controllers, and any new stage added later would have to remember to notify.
 * Here it cannot be forgotten.
 *
 * The event carries no data — the API server recomputes the dashboard payload
 * itself — so a hook firing on a write the dashboard doesn't display costs at
 * most one redundant, deduplicated refresh.
 */
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

/** The `Video` model — import this everywhere to query/update video documents. */
const Video: Model<IVideo> = mongoose.model<IVideo>("Video", videoSchema);

export default Video;
