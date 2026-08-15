import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/envconfig.js";
import type { UserRole } from "../models/user.types.js";

const SALT_ROUNDS = 10;

export interface AuthTokenPayload {
  id: string;
  email: string;
  role: UserRole;
}

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, SALT_ROUNDS);

export const verifyPassword = (
  plain: string,
  hash: string
): Promise<boolean> => bcrypt.compare(plain, hash);

export const signToken = (payload: AuthTokenPayload): string =>
  jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: env.auth.jwtExpiresIn,
  } as jwt.SignOptions);

export const verifyToken = (token: string): AuthTokenPayload | null => {
  try {
    return jwt.verify(token, env.auth.jwtSecret) as AuthTokenPayload;
  } catch {
    return null;
  }
};
