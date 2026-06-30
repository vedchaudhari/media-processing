export interface SummaryInput {
  transcript: string;
}

export interface SummaryOutput {
  summary: string;
  keyTakeaways: string[];
  technologies: string[];
}
