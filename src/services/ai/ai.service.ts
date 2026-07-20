import { env } from "../../config/envconfig.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { OllamaProvider } from "./providers/ollama.provider.js";
import { OpenAIProvider } from "./providers/openai.provider.js";
import type { AIProvider } from "./ai-provider.js";
import type { SummaryInput, SummaryOutput } from "./types.js";
import { cleanThinkingTags } from "./prompts.js";

/**
 * Facade over the configured AI provider.
 *
 * Callers (the AI worker, the Q&A endpoint) use these static methods and never
 * touch a concrete provider. The provider is chosen from config and cached on
 * first use (lazy singleton), and this layer normalizes provider output —
 * guaranteeing `chapters` is an array and scrubbing reasoning leakage from
 * answers — so downstream code gets consistent, clean results.
 */
export class AIService {
  private static provider: AIProvider;

  /**
   * Lazily instantiates and caches the provider selected by `env.ai.providerType`.
   * @throws If the configured provider type is unknown.
   */
  private static getProvider(): AIProvider {
    if (!this.provider) {
      const type = env.ai.providerType;
      console.log(`[AI] Initializing ${type} provider...`);
      switch (type) {
        case "gemini":
          this.provider = new GeminiProvider();
          break;
        case "openai":
          this.provider = new OpenAIProvider();
          break;
        case "ollama":
          this.provider = new OllamaProvider();
          break;
        default:
          throw new Error(`Unknown AI provider type: ${type}`);
      }
    }
    return this.provider;
  }

  /**
   * Summarizes a transcript via the active provider, guaranteeing a valid
   * `chapters` array even if the model omits the field.
   */
  static async generateSummary(input: SummaryInput): Promise<SummaryOutput> {
    const out = await this.getProvider().generateSummary(input);
    // Guarantee chapters is always an array even if a model omits the field.
    return { ...out, chapters: Array.isArray(out.chapters) ? out.chapters : [] };
  }

  /**
   * Answers a question grounded in transcript excerpts, with any model
   * reasoning/monologue stripped from the reply.
   */
  static async askQuestion(context: string, question: string): Promise<string> {
    const rawAnswer = await this.getProvider().askQuestion(context, question);
    console.log("[AI] Raw answer from provider:", JSON.stringify(rawAnswer));
    const cleaned = cleanThinkingTags(rawAnswer);
    console.log("[AI] Cleaned answer:", JSON.stringify(cleaned));
    return cleaned;
  }
}
