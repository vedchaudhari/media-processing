/**
 * Text-embedding service backing transcript vector search.
 *
 * Turns transcript text into vectors for the Qdrant store. Each provider emits
 * a different vector dimension, so both the dimension and the collection name
 * are provider-scoped (see getCollectionName) to prevent mixing incompatible
 * vectors. For Ollama/default it returns a Qdrant server-side inference config
 * instead of a raw vector (Qdrant embeds on its side).
 */
import { env } from "../../config/envconfig.js";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: env.ai.geminiApiKey,
});

export class EmbeddingService {
  /**
   * Vector dimension for the active provider: gemini 768, openai 1536,
   * ollama/default 384 (Qdrant server-side inference).
   */
  static getDimension(): number {
    const provider = env.ai.providerType;
    if (provider === "gemini") return 768;
    if (provider === "openai") return 1536;
    return 384; // ollama/default -> falls back to Qdrant server-side inference (384)
  }

  /**
   * Collection name scoped to the active provider's vector dimension.
   * Switching AI providers therefore lands in a different collection instead
   * of colliding with (or destroying) vectors indexed under another dimension.
   */
  static getCollectionName(): string {
    return `video_transcripts_${this.getDimension()}`;
  }

  /**
   * Generates a vector embedding or returns a Qdrant built-in inference configuration.
   */
  static async embedText(
    text: string,
    taskType: "query" | "document"
  ): Promise<number[] | { text: string; model: string }> {
    const provider = env.ai.providerType;

    if (provider === "gemini") {
      const embedRes = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: text,
        config: {
          taskType: taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: 768,
        },
      });
      const vector = embedRes.embeddings?.[0]?.values;
      if (!vector) {
        throw new Error("Failed to generate Gemini embedding");
      }
      return vector;
    }

    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.ai.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI embedding failed: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding: number[] }>;
      };
      const vector = data.data?.[0]?.embedding;
      if (!vector) {
        throw new Error("Failed to generate OpenAI embedding");
      }
      return vector;
    }

    // Default / Ollama -> Return Qdrant built-in server-side inference structure
    return {
      text,
      model: "sentence-transformers/all-MiniLM-L6-v2",
    };
  }
}
