/**
 * Wipes every document from the MongoDB database (all collections).
 *
 * Run with `npm run clear:db`. Development convenience for resetting to an
 * empty DB — clears videos, users, and any other collections wholesale. Runs
 * immediately with no confirmation (matches scripts/delete-qdrant.ts).
 *
 * NOTE: this only clears MongoDB. It does NOT touch MinIO objects (uploaded
 * originals, HLS output, thumbnails) or Qdrant vectors — after running this
 * those become orphans. Run `npm run clear:qdrant` for vectors, and clear the
 * MinIO bucket separately, if you want a full clean slate.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function clearDatabase() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("✗ MONGO_URI is not set in .env.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("No database handle after connect");

    const collections = await db.collections();
    if (collections.length === 0) {
      console.log("No collections found — database is already empty.");
      return;
    }

    for (const collection of collections) {
      const { deletedCount } = await collection.deleteMany({});
      console.log(`Cleared ${collection.collectionName}: ${deletedCount} documents removed`);
    }

    console.log("✅ Database cleared.");
  } finally {
    await mongoose.disconnect();
  }
}

clearDatabase().catch((err) => {
  console.error("✗ clear-database failed:", err);
  process.exit(1);
});
