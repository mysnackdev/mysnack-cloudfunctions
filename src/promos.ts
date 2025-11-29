import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";

export const getActivePromosHttp = onRequest({ region: "southamerica-east1" }, withCors(async (_req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const now = new Date();
    const snap = await db.collection("promos").where("active","==",true).get();
    const items = snap.docs.map(d=>({ id: d.id, ...d.data() })).filter((p:any)=>{
      const starts = p.startsAt?.toDate ? p.startsAt.toDate() : p.startsAt ? new Date(p.startsAt) : null;
      const ends = p.endsAt?.toDate ? p.endsAt.toDate() : p.endsAt ? new Date(p.endsAt) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    });
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getPromosByStoreHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const now = new Date();
    const snap = await db.collection("promos").where("storeId","==",storeId).where("active","==",true).get();
    const items = snap.docs.map(d=>({ id: d.id, ...d.data() })).filter((p:any)=>{
      const starts = p.startsAt?.toDate ? p.startsAt.toDate() : p.startsAt ? new Date(p.startsAt) : null;
      const ends = p.endsAt?.toDate ? p.endsAt.toDate() : p.endsAt ? new Date(p.endsAt) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    });
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

import { onCall } from "firebase-functions/v2/https";

export const getActivePromos = onCall({ region: "southamerica-east1" }, async () => {
  return handleErrors(async () => {
    const now = new Date();
    const snap = await db.collection("promos").where("active","==",true).get();
    const items = snap.docs.map(d=>({ id: d.id, ...d.data() })).filter((p:any)=>{
      const starts = p.startsAt?.toDate ? p.startsAt.toDate() : p.startsAt ? new Date(p.startsAt) : null;
      const ends = p.endsAt?.toDate ? p.endsAt.toDate() : p.endsAt ? new Date(p.endsAt) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    });
    return { items };
  });
});

export const getPromosByStore = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const now = new Date();
    const snap = await db.collection("promos").where("storeId","==",storeId).where("active","==",true).get();
    const items = snap.docs.map(d=>({ id: d.id, ...d.data() })).filter((p:any)=>{
      const starts = p.startsAt?.toDate ? p.startsAt.toDate() : p.startsAt ? new Date(p.startsAt) : null;
      const ends = p.endsAt?.toDate ? p.endsAt.toDate() : p.endsAt ? new Date(p.endsAt) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    });
    return { items };
  });
});
