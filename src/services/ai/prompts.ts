import type { TranscriptSegmentInput } from "./types.js";

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
