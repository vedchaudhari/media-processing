export interface TranscriptSegmentInput {
  start: number;
  text: string;
}

export interface SummaryInput {
  transcript: string;

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
