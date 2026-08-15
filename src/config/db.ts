import mongoose from "mongoose";
import { env } from "./envconfig.js";

export const connectDB = async (): Promise<void> => {
  console.log("Connecting to MongoDB...");

  try {
    await mongoose.connect(env.mongoUri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
