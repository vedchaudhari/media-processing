import * as Minio from "minio";
import { env } from "./envconfig.js";

export const minioClient = new Minio.Client({
  endPoint: env.minio.endPoint,
  port: env.minio.port,
  useSSL: false,
  accessKey: env.minio.accessKey,
  secretKey: env.minio.secretKey,
});

export const VIDEO_BUCKET = env.minio.bucket;
