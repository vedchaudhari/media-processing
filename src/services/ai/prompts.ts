/**
 * Prompt builders and response sanitizers shared by all AI providers.
 *
 * Centralizing the prompt text here keeps every provider producing the same
 * output shape, so provider classes only differ in transport (HTTP/SDK), not
 * in what they ask the model.
 */
import type { TranscriptSegmentInput } from "./types.js";

/**
 * Builds the summary prompt: instructs the model to return strict JSON matching
 * SummaryOutput. Prefers timestamped `segments` (so chapter start times can be
 * copied verbatim); falls back to plain text. Truncates very long transcripts
 * to a ~150k-char safety limit to stay within context windows.
 */
export const buildSummaryPrompt = (
  transcript: string,
  segments?: TranscriptSegmentInput[]
): string => {
  const maxChars = 150_000; // ~30k words safety limit

  // Prefer a timestamped transcript so the model can anchor chapters to real
  // start times; fall back to plain text when segments aren't available.
  const body =
    segments && segments.length > 0
      ? segments.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join("\n")
      : transcript;

  const safeTranscript =
    body.length > maxChars
      ? body.substring(0, maxChars) + "\n\n[Transcript truncated due to length limits...]"
      : body;

  return `You are an AI video content analyzer. Analyze the following video transcript and generate a structured summary in JSON format.

Transcript (each line is prefixed with its start time in seconds):
"""
${safeTranscript}
"""

You MUST respond with a JSON object matching this schema:
{
  "summary": "A concise paragraph summarizing the main topics, insights, and context of the video.",
  "keyTakeaways": ["Key takeaway bullet point 1", "Key takeaway bullet point 2", "Key takeaway bullet point 3"],
  "technologies": ["List of technologies, frameworks, libraries, programming languages, or tools mentioned in the transcript"],
  "chapters": [{ "start": 0, "title": "Short chapter title" }]
}

Rules for "chapters":
- Produce 3 to 8 chapters that split the video into coherent topics.
- "start" MUST be copied exactly from one of the start times shown above (a number of seconds).
- The first chapter starts at or near 0. Order by ascending start; no overlaps or repeats.
- Titles are 2-6 words, descriptive, with no numbering.

Your output must be valid JSON and contain NO other text, markdown formatting blocks (like \`\`\`json), or explanations. Just return the JSON object directly.`;
};

/**
 * Builds the Q&A prompt: answer strictly from the provided transcript
 * excerpts, refuse when the answer isn't present, and emit no reasoning/
 * monologue — just the direct answer.
 */
export const buildAskPrompt = (context: string, question: string): string => {
  return `You are an AI video assistant. Answer the user's question based strictly on the provided video transcript excerpts.

Transcript Excerpts:
"""
${context}
"""

User Question:
"${question}"

Instructions:
1. Answer the question directly, concisely, and contextually using ONLY the transcript excerpts above.
2. If the answer is not present in the excerpts, say "I couldn't find the answer to that in the video."
3. Do not make up facts or use outside knowledge.
4. Keep the answer professional and easy to read.
5. Do NOT include any internal thoughts, reasoning steps, planning, or monologue. Output ONLY the direct answer.`;
};

/**
 * Strips chain-of-thought leakage from a model's answer.
 *
 * Some local/reasoning models emit `<think>...</think>` blocks or plain-text
 * "Hmm... Final decision:" monologue despite being told not to. This removes
 * those so only the user-facing answer remains. Defensive by design — safe to
 * run on output that has no thinking tags at all.
 *
 * @returns The cleaned, trimmed text.
 */
export function cleanThinkingTags(text: string): string {
  let cleanText = text;

  // 1. Strip <think>...</think> or <thinking>...</thinking> blocks case-insensitively
  cleanText = cleanText.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "");

  // 2. Strip any plain-text reasoning blocks that start with "Hmm" or "Thinking" and end with "Final decision: ...\n"
  cleanText = cleanText.replace(/^(?:Hmm|Thinking|Reasoning)[\s\S]*?(?:Final decision|So, the answer is):?[\s\S]*?\n+/i, "");

  // 3. Replace any standalone lingering tags just in case
  cleanText = cleanText.replace(/<\/?(think|thinking)>/gi, "");

  return cleanText.trim();
}
