import { GoogleGenAI } from "@google/genai";
import type { AIProvider } from "../ai-provider.js";
import type { SummaryInput, SummaryOutput } from "../types.js";
import { buildSummaryPrompt } from "../prompts.js";

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!,
    });
  }

  async generateSummary(input: SummaryInput): Promise<SummaryOutput> {
    const prompt = buildSummaryPrompt(input.transcript, input.segments);

    const response = await this.client.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
    });

    if (!response.text) {
      throw new Error("Gemini returned empty response");
    }

    // Safely parse JSON by cleaning markdown fences if present
    let cleanText = response.text.trim();
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