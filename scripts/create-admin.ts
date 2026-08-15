import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SALT_ROUNDS = 10;

async function createAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const mongoUri = process.env.MONGO_URI;

  if (!email || !password) {
    console.error(
      "✗ ADMIN_EMAIL and ADMIN_PASSWORD must both be set in .env before seeding an admin."
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("✗ ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }
  if (!mongoUri) {
    console.error("✗ MONGO_URI is not set in .env.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  try {

    const users = mongoose.connection.collection("users");
    const existing = await users.findOne({ email });

    if (existing) {
      if (existing.role === "admin") {
        console.log(`✓ Admin already exists: ${email} (no change)`);
      } else {
        await users.updateOne({ _id: existing._id }, { $set: { role: "admin", updatedAt: new Date() } });
        console.log(`✓ Promoted existing user to admin: ${email}`);
      }
      return;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const now = new Date();
    await users.insertOne({
      email,
      passwordHash,
      role: "admin",
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    console.log(`✓ Created admin account: ${email}`);
  } finally {
    await mongoose.disconnect();
  }
}

createAdmin().catch((err) => {
  console.error("✗ create-admin failed:", err);
  process.exit(1);
});
