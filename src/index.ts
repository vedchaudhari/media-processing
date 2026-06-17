import express, { type Request, type Response } from "express";
import cors from "cors";
import { env } from "./config/envconfig.js";
import { connectDB } from "./config/db.js";
import videoRoutes from "./routes/video.routes.js";

const app = express();
const PORT = env.port;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "okay" });
});

// Routes
app.use("/api/videos", videoRoutes);

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});

export default app;
