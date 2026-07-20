import type { SummaryInput, SummaryOutput } from "./types.js";

/**
 * Contract every LLM provider (Gemini, OpenAI, Ollama) must implement.
 *
 * The rest of the app depends only on this interface, never on a concrete
 * provider — so switching provider is a config change, not a code change.
 */
export interface AIProvider {
  /** Summarize a transcript into structured insights (summary, takeaways, etc.). */
  generateSummary(input: SummaryInput): Promise<SummaryOutput>;
  /** Answer a free-form question grounded in the given transcript excerpts. */
  askQuestion(context: string, question: string): Promise<string>;
}
