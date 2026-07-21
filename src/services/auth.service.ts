/**
 * Password hashing and JWT issuing/verification for user accounts.
 *
 * Kept separate from the controller so the hashing cost factor and token
 * shape live in one place instead of being re-decided at every call site.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/envconfig.js";
import type { UserRole } from "../models/user.model.js";

const SALT_ROUNDS = 10;

/** Shape encoded into (and decoded out of) the JWT payload. */
export interface AuthTokenPayload {
  id: string;
  email: string;
  role: UserRole;
}

/** Hashes a plaintext password for storage. Never store the plaintext itself. */
export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, SALT_ROUNDS);

/** Compares a plaintext password against a stored hash. */
export const verifyPassword = (
  plain: string,
  hash: string
): Promise<boolean> => bcrypt.compare(plain, hash);

/** Signs a JWT carrying the user's id/email/role, expiring per `env.auth.jwtExpiresIn`. */
export const signToken = (payload: AuthTokenPayload): string =>
  jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: env.auth.jwtExpiresIn,
  } as jwt.SignOptions);

/**
 * Verifies a JWT and returns its payload, or null if it's missing/expired/
 * tampered. Callers treat null as "not authenticated" rather than throwing.
 */
export const verifyToken = (token: string): AuthTokenPayload | null => {
  try {
    return jwt.verify(token, env.auth.jwtSecret) as AuthTokenPayload;
  } catch {
    return null;
  }
};
