import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/auth.service.js";

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }

  req.user = payload;
  next();
};

export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }
  next();
};
