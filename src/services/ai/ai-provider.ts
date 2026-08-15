import type { SummaryInput, SummaryOutput } from "./types.js";

export interface AIProvider {

  generateSummary(input: SummaryInput): Promise<SummaryOutput>;

  askQuestion(context: string, question: string): Promise<string>;
}
