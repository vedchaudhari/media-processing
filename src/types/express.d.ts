/**
 * Augments Express's Request with `user`, populated by requireAuth
 * (middleware/auth.middleware.ts) from a verified JWT. Every authenticated
 * route reads `req.user` instead of re-parsing the Authorization header.
 */
import type { AuthTokenPayload } from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export {};
