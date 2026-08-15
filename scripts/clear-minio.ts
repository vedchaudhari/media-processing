import * as Minio from "minio";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const endPoint = process.env.MINIO_ENDPOINT || "localhost";
const port = Number(process.env.MINIO_PORT) || 9000;
const bucket = process.env.MINIO_BUCKET || "videos";

const minioClient = new Minio.Client({
  endPoint,
  port,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
});

function listAllKeys(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = [];

    const stream = minioClient.listObjectsV2(bucket, "", true);
    stream.on("data", (obj) => {
      if (obj.name) keys.push(obj.name);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(keys));
  });
}

async function clearMinio() {
  const exists = await minioClient.bucketExists(bucket);
  if (!exists) {
    console.log(`Bucket "${bucket}" does not exist — nothing to clear.`);
    return;
  }

  const keys = await listAllKeys();
  if (keys.length === 0) {
    console.log(`Bucket "${bucket}" is already empty.`);
    return;
  }

  await minioClient.removeObjects(bucket, keys);
  console.log(`✅ Cleared bucket "${bucket}": ${keys.length} objects removed.`);
}

clearMinio().catch((err) => {
  console.error("✗ clear-minio failed:", err);
  process.exit(1);
});
