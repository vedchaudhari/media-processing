import { minioClient } from "../config/minio.js";

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
 * Uploads a local file to MinIO storage under the given object key.
 */
export const uploadObject = async (
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  await minioClient.fPutObject(bucketName, objectKey, localPath);
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
