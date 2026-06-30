export const buildSummaryPrompt = (transcript: string): string => {
  return `You are an AI video content analyzer. Your task is to analyze the following video transcript and generate a structured summary in JSON format.

Transcript:
"""
${transcript}
"""

You MUST respond with a JSON object matching this schema:
{
  "summary": "A concise paragraph summarizing the main topics, insights, and context of the video.",
  "keyTakeaways": ["Key takeaway bullet point 1", "Key takeaway bullet point 2", "Key takeaway bullet point 3"],
  "technologies": ["List of technologies, frameworks, libraries, programming languages, or tools mentioned in the transcript"]
}

Your output must be valid JSON and contain NO other text, markdown formatting blocks (like \`\`\`json), or explanations. Just return the JSON object directly.`;
};
