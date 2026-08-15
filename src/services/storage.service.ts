import fs from "node:fs";
import path from "node:path";
import { minioClient } from "../config/minio.js";

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

const contentTypeFor = (fileName: string): Record<string, string> => {
  const type = CONTENT_TYPES[path.extname(fileName)];
  return type ? { "Content-Type": type } : {};
};

export const createBucket = async (bucketName: string): Promise<void> => {
  const exists = await minioClient.bucketExists(bucketName);
  if (exists) return;
  await minioClient.makeBucket(bucketName);
};

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
          `arn:aws:s3:::${bucketName}/*/transcript.json`,
        ],
      },
    ],
  };
  await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
};

export const objectExists = async (
  bucketName: string,
  objectKey: string
): Promise<boolean> => {
  try {
    await minioClient.statObject(bucketName, objectKey);
    return true;
  } catch (err) {

    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") return false;
    }
    throw err;
  }
};

export const downloadObject = async (
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  await minioClient.fGetObject(bucketName, objectKey, localPath);
};

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

export const removeObjects = async (
  bucketName: string,
  objectKeys: string[]
): Promise<void> => {
  if (objectKeys.length === 0) return;
  await minioClient.removeObjects(bucketName, objectKeys);
};
