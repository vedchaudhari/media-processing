import type { AuthTokenPayload } from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export {};
