import cors from "cors";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { applyAuthContext } from "./auth-context.js";

const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://mysnack-backoffice-6fb29.web.app",
  "https://mysnack-client-6fb29.web.app",
  "https://mysnack-backoffice.firebaseapp.com",
  "https://mysnack-client.firebaseapp.com"
];

const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envAllowedOrigins]));

export const withCors = (handler: (req: Request, res: Response) => Promise<void>) => {
  const mw = cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET","POST","OPTIONS"],
    credentials: true
  });
  return async (req: Request, res: Response) => {
    await new Promise<void>((resolve) => mw(req, res, () => resolve()));
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    await applyAuthContext(req);
    await handler(req, res);
  };
};
