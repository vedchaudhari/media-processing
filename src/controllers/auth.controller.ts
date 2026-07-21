import { type Request, type Response } from "express";
import User from "../models/user.model.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  resolveInitialRole,
} from "../services/auth.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shape returned to the client for the logged-in user — never the passwordHash. */
const toPublicUser = (user: { _id: unknown; email: string; role: string }) => ({
  id: user._id,
  email: user.email,
  role: user.role,
});

/**
 * Creates a new account and returns a JWT for it.
 *
 * The first account ever created (and any email in ADMIN_EMAILS) becomes an
 * admin automatically — see auth.service.ts#resolveInitialRole — so a fresh
 * install always has one without a manual DB edit.
 */
export const register = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    // decide the role BEFORE creating the doc — resolveInitialRole checks
    // whether any user exists yet, so it must run before this insert
    const role = await resolveInitialRole(normalizedEmail);
    const passwordHash = await hashPassword(password);

    const user = await User.create({ email: normalizedEmail, passwordHash, role });
    const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });

    return res.status(201).json({ success: true, token, user: toPublicUser(user) });
  } catch (error) {
    console.error("register failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/** Verifies email/password and returns a fresh JWT. */
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      // don't reveal which of email/password was wrong
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });
    return res.status(200).json({ success: true, token, user: toPublicUser(user) });
  } catch (error) {
    console.error("login failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/** Returns the currently authenticated user (requires requireAuth to have run). */
export const getMe = async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.user!.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({ success: true, user: toPublicUser(user) });
  } catch (error) {
    console.error("getMe failed:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
