import type { Request } from "firebase-functions/v2/https";
import { authAdmin } from "./admin.js";

const BEARER_REGEX = /^Bearer\s+/i;

export async function applyAuthContext(req: Request): Promise<void> {
  const header = req.headers?.authorization;
  if (!header || Array.isArray(header)) return;
  const token = header.replace(BEARER_REGEX, "").trim();
  if (!token) return;

  try {
    const decoded = await authAdmin.verifyIdToken(token);
    (req as any).auth = {
      uid: decoded.uid,
      token: decoded,
    };
  } catch (error) {
    console.warn("[auth] Failed to verify authorization token", error);
  }
}
