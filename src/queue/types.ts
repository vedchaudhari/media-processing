export interface InspectVideoJob {
  videoId: string;
  objectKey: string;
}

export interface PlanVideoJob {
  videoId: string;
}

export interface TranscodeVideoJob {
  videoId: string;
}

export interface GenerateThumbnailJob {
  videoId: string;
}

export interface TranscribeVideoJob {
  videoId: string;
}

export interface GenerateSummaryJob {
  videoId: string;
}

export interface GenerateEmbeddingsJob {
  videoId: string;
}
