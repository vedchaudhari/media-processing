import type { AIProvider } from "../ai-provider.js";
import type { SummaryInput, SummaryOutput } from "../types.js";
import { buildSummaryPrompt } from "../prompts.js";
import { env } from "../../../config/envconfig.js";

export class OpenAIProvider implements AIProvider {
  async generateSummary(input: SummaryInput): Promise<SummaryOutput> {
    const prompt = buildSummaryPrompt(input.transcript);
    const apiKey = env.ai.openaiApiKey;
    const model = env.ai.openaiModel;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: prompt,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Responses API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      output?: Array<{
        type?: string;
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    const outputMessage = data.output?.find((item) => item.type === "message");
    const outputTextObj = outputMessage?.content?.find((part) => part.type === "output_text");
    let cleanText = (outputTextObj?.text || "").trim();

    // Safely parse JSON by cleaning markdown fences if present
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
}
