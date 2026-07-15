import { QdrantClient } from "@qdrant/js-client-rest";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

async function deleteEverything() {
  try {
    const collections = await client.getCollections();

    if (collections.collections.length === 0) {
      console.log("No collections found.");
      return;
    }

    for (const collection of collections.collections) {
      console.log(`Deleting collection: ${collection.name}`);
      await client.deleteCollection(collection.name);
    }

    console.log("✅ All collections deleted.");
  } catch (error) {
    console.error("Error:", error);
  }
}

deleteEverything();
