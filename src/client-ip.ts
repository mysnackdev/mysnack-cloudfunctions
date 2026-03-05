import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { handleErrors } from "./shared/errors.js";

const normalizeText = (value: unknown) => {
  if (!value) return "";
  return String(value).trim();
};

const resolveClientIp = (req: Request): string | null => {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate =
    normalizeText(forwardedValue?.split?.(",")?.[0]) ||
    normalizeText((req as any).ip) ||
    normalizeText(req.socket?.remoteAddress);
  return candidate || null;
};

export const getClientIpHttp = async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    return { ip: resolveClientIp(req) };
  });
  res.status(resp.success ? 200 : 400).json(resp);
};
