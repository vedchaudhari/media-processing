/**
 * Shared types for the AI layer — inputs and outputs of the LLM summary step,
 * provider-agnostic so any provider implementation returns the same shape.
 */

/** A timestamped transcript line fed to the model so it can anchor chapters. */
export interface TranscriptSegmentInput {
  start: number;
  text: string;
}

/** Input to `generateSummary`: full transcript text, optionally with segments. */
export interface SummaryInput {
  transcript: string;
  // `| undefined` is required because tsconfig has exactOptionalPropertyTypes:
  // callers pass `video.transcript?.segments`, which may be undefined.
  segments?: TranscriptSegmentInput[] | undefined;
}

/** A chapter marker the model produces (start time + short title). */
export interface Chapter {
  start: number;
  title: string;
}

/** Structured result of `generateSummary`. `chapters` is always an array. */
export interface SummaryOutput {
  summary: string;
  keyTakeaways: string[];
  technologies: string[];
  chapters: Chapter[];
}
