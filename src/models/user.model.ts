/**
 * The User document — an account that owns videos and authenticates via JWT.
 *
 * Passwords are never stored in plaintext; only `passwordHash` (bcryptjs) is
 * persisted (see services/auth.service.ts). `role` gates the admin API/dashboard
 * — see auth.service.ts#resolveInitialRole for how a user becomes an admin.
 */
import mongoose, { Schema, Document, Model } from "mongoose";

/** Union of every valid `role` value. "admin" can see/manage every user's videos. */
export type UserRole = "user" | "admin";

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
  },
  {
    timestamps: true,
  }
);

/** The `User` model — import this everywhere to query/update accounts. */
const User: Model<IUser> = mongoose.model<IUser>("User", userSchema);

export default User;
