import type { SummaryInput, SummaryOutput } from "./types.js";

export interface AIProvider {
  generateSummary(input: SummaryInput): Promise<SummaryOutput>;
}
