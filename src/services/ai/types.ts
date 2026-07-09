export interface TranscriptSegmentInput {
  start: number;
  text: string;
}

export interface SummaryInput {
  transcript: string;
  // `| undefined` is required because tsconfig has exactOptionalPropertyTypes:
  // callers pass `video.transcript?.segments`, which may be undefined.
  segments?: TranscriptSegmentInput[] | undefined;
}

export interface Chapter {
  start: number;
  title: string;
}

export interface SummaryOutput {
  summary: string;
  keyTakeaways: string[];
  technologies: string[];
  chapters: Chapter[];
}
