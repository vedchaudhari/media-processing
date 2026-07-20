/**
 * MinIO (S3-compatible) client setup.
 *
 * MinIO is the object store for everything binary in the pipeline: uploaded
 * originals, transcoded HLS segments/playlists, thumbnails, and transcripts.
 * The client and bucket name are created once here and imported by the
 * controllers, storage service, and workers.
 */
import * as Minio from "minio";
import { env } from "./envconfig.js";

/**
 * The process-wide MinIO client.
 *
 * `useSSL: false` because we talk to MinIO over plain HTTP inside the trusted
 * network (local dev / Docker network). Credentials and endpoint come from
 * `env` so the same code points at a local MinIO or a managed S3-compatible
 * store without change.
 */
export const minioClient = new Minio.Client({
  endPoint: env.minio.endPoint,
  port: env.minio.port,
  useSSL: false,
  accessKey: env.minio.accessKey,
  secretKey: env.minio.secretKey,
});

/**
 * Name of the single bucket all media objects live in.
 *
 * Object *keys* namespace each video (e.g. `videos/<id>/original.mp4`,
 * `videos/<id>/hls/...`), so one bucket holds every video's files.
 */
export const VIDEO_BUCKET = env.minio.bucket;
