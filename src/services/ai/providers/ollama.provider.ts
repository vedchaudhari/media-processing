/**
 * Ollama implementation of AIProvider — talks to a local Ollama daemon's
 * HTTP API for on-device models (the default in development).
 */
import type { AIProvider } from "../ai-provider.js";
import type { SummaryInput, SummaryOutput } from "../types.js";
import { buildSummaryPrompt, buildAskPrompt, cleanThinkingTags } from "../prompts.js";
import { env } from "../../../config/envconfig.js";

export class OllamaProvider implements AIProvider {
  /**
   * Summarizes a transcript via Ollama's `/api/generate` with `format: "json"`.
   * Falls back to the model's `thinking` field when `response` is empty, then
   * strips think-tags/code-fences before parsing JSON.
   * @throws If Ollama errors, returns no usable content, or emits invalid JSON.
   */
  async generateSummary(input: SummaryInput): Promise<SummaryOutput> {
    const prompt = buildSummaryPrompt(input.transcript, input.segments);
    const endpoint = env.ai.ollamaEndpoint;
    const model = env.ai.ollamaModel;

    const response = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        // Disable thinking/reasoning if supported by the model/API
        think: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      response?: string;
      thinking?: string;
      error?: string;
    };

    if (data.error) {
      throw new Error(`Ollama API error: ${data.error}`);
    }

    // Get output content, falling back to thinking/reasoning property if response is empty
    let cleanText = (data.response || "").trim();
    if (!cleanText && data.thinking) {
      console.log("[AI] Response was empty, using model's 'thinking' field as fallback");
      cleanText = data.thinking.trim();
    }

    cleanText = cleanThinkingTags(cleanText);

    if (!cleanText) {
      throw new Error(`Ollama returned no content in response or thinking. Full response: ${JSON.stringify(data)}`);
    }
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.substring(7);
    }
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.substring(3);
    }
    if (cleanText.endsWith("```")) {
      cleanText = cleanText.substring(0, cleanText.length - 3);
    }
    cleanText = cleanText.trim();

    return JSON.parse(cleanText) as SummaryOutput;
  }

  /**
   * Answers a question grounded in transcript excerpts (plain-text response).
   * @throws If Ollama returns an error response.
   */
  async askQuestion(context: string, question: string): Promise<string> {
    const prompt = buildAskPrompt(context, question);
    const endpoint = env.ai.ollamaEndpoint;
    const model = env.ai.ollamaModel;

    const response = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      response?: string;
      thinking?: string;
      error?: string;
    };

    if (data.error) {
      throw new Error(`Ollama API error: ${data.error}`);
    }

    let cleanText = (data.response || "").trim();
    if (!cleanText && data.thinking) {
      cleanText = data.thinking.trim();
    }

    return cleanText;
  }
}