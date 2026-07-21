/**
 * Express middleware gating routes behind a valid user session.
 *
 * The session itself is stateless: a signed JWT in the `Authorization: Bearer`
 * header (see services/auth.service.ts) — no server-side session store, so
 * logout is purely client-side (the frontend just discards the token).
 */
import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/auth.service.js";

/**
 * Requires a valid `Authorization: Bearer <token>` header, verifies it, and
 * attaches the decoded payload as `req.user`. Responds 401 and stops the
 * request otherwise — every route after this one can assume `req.user` exists.
 */
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

/**
 * Requires `req.user.role === "admin"`. Must run after requireAuth (relies on
 * `req.user` already being populated) — responds 403 for a logged-in
 * non-admin, not 401, since they ARE authenticated, just not authorized.
 */
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
