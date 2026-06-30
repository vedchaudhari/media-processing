import { env } from "../../config/envconfig.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { OllamaProvider } from "./providers/ollama.provider.js";
import { OpenAIProvider } from "./providers/openai.provider.js";
import type { AIProvider } from "./ai-provider.js";
import type { SummaryInput, SummaryOutput } from "./types.js";

export class AIService {
  private static provider: AIProvider;

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

  static async generateSummary(input: SummaryInput): Promise<SummaryOutput> {
    return this.getProvider().generateSummary(input);
  }
}
