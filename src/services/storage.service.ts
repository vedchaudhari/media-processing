import fs from "node:fs";
import path from "node:path";
import { minioClient } from "../config/minio.js";

// Content types so players/browsers serve HLS assets correctly.
const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

const contentTypeFor = (fileName: string): Record<string, string> => {
  const type = CONTENT_TYPES[path.extname(fileName)];
  return type ? { "Content-Type": type } : {};
};

/**
 * Creates a MinIO bucket if it does not already exist.
 */
export const createBucket = async (bucketName: string): Promise<void> => {
  const exists = await minioClient.bucketExists(bucketName);
  if (exists) return;
  await minioClient.makeBucket(bucketName);
};

/**
 * Grants anonymous read-only access to public assets — HLS outputs and
 * thumbnails — leaving everything else (e.g. `original.mp4`) private.
 *
 * HLS playlists reference their child playlists and .ts segments by relative
 * path, so the signature on a presigned URL is lost on those follow-up
 * requests. Making the whole hls/ tree public-readable lets a browser/HLS.js
 * fetch every file directly. Thumbnails are also public so the frontend can
 * display them without presigned URLs.
 */
export const setPublicReadPolicy = async (
  bucketName: string
): Promise<void> => {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [
          `arn:aws:s3:::${bucketName}/*/hls/*`,
          `arn:aws:s3:::${bucketName}/*/thumbnail.jpg`,
        ],
      },
    ],
  };
  await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
};

/**
 * Returns true if an object exists in the bucket. Used to confirm a client
 * actually uploaded the file before we kick off processing.
 */
export const objectExists = async (
  bucketName: string,
  objectKey: string
): Promise<boolean> => {
  try {
    await minioClient.statObject(bucketName, objectKey);
    return true;
  } catch (err) {
    // MinIO throws a NotFound/code "NoSuchKey" error when the object is absent
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") return false;
    }
    throw err; // anything else (auth, network) is a real error
  }
};

/**
 * Downloads an object from MinIO storage to a local file path.
 */
export const downloadObject = async (
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  await minioClient.fGetObject(bucketName, objectKey, localPath);
};

/**
 * Uploads a local file to MinIO storage under the given object key. The
 * content type is inferred from the file extension when recognised.
 */
export const uploadObject = async (
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  await minioClient.fPutObject(
    bucketName,
    objectKey,
    localPath,
    contentTypeFor(objectKey)
  );
};

/**
 * Recursively uploads every file in a local directory under the given key
 * prefix, preserving the subdirectory structure (used for HLS output: a
 * playlist plus its .ts segments). Returns the list of object keys written so
 * the caller can roll them back on failure.
 */
export const uploadDirectory = async (
  bucketName: string,
  localDir: string,
  keyPrefix: string
): Promise<string[]> => {
  const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
  const uploaded: string[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(localDir, entry.name);
      const entryKey = `${keyPrefix}/${entry.name}`;

      if (entry.isDirectory()) {
        uploaded.push(...(await uploadDirectory(bucketName, entryPath, entryKey)));
      } else {
        await minioClient.fPutObject(
          bucketName,
          entryKey,
          entryPath,
          contentTypeFor(entry.name)
        );
        uploaded.push(entryKey);
      }
    })
  );

  return uploaded;
};

/**
 * Removes one or more objects from MinIO storage. Used to clean up partial
 * uploads when a multi-step job fails midway.
 */
export const removeObjects = async (
  bucketName: string,
  objectKeys: string[]
): Promise<void> => {
  if (objectKeys.length === 0) return;
  await minioClient.removeObjects(bucketName, objectKeys);
};
