import { Document } from "mongoose";

export type UserRole = "user" | "admin";

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}
