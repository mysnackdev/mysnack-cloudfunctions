import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import QRCode from "qrcode";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { chairCreateSchema } from "./shared/validators.js";

const QR_APP_BASE_URL = process.env.QR_APP_BASE_URL || "https://mysnack-client-6fb29.web.app";

function buildQrCodeData(params: { mallId: string; storeId: string; tableNumber: number }) {
  const { mallId, storeId, tableNumber } = params;
  try {
    const url = new URL("/scan", QR_APP_BASE_URL);
    url.searchParams.set("mallId", mallId);
    url.searchParams.set("storeId", storeId);
    url.searchParams.set("table", String(tableNumber));
    url.searchParams.set("qr", `mysnack://table/${mallId}/${tableNumber}`);
    return url.toString();
  } catch (error) {
    console.error("[chairs] Failed to build QR code URL", error);
    return `mysnack://table/${mallId}/${tableNumber}`;
  }
}

export const getChairsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    const snap = await db.collection("chairs").where("storeId","==",storeId).orderBy("tableNumber","asc").get();
    return { items: snap.docs.map(d=>({ id: d.id, ...d.data() })) };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const createChairHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, tableNumber, active, location } = chairCreateSchema.parse(req.body || {});
    // We assume a single mall for now; in real, store has shoppingId
    const storeDoc = await db.collection("stores").doc(storeId).get();
   if (!storeDoc.exists) throw new Error("store-not-found");
   const mallId = storeDoc.get("shoppingId") || "default-mall";
    const qrCodeData = buildQrCodeData({ mallId, storeId, tableNumber });

    // Generate QR PNG and attempt to upload
    const png = await QRCode.toBuffer(qrCodeData, { width: 512 });
    let qrCodeUrl: string | undefined;
    try {
      const bucket = getStorage().bucket(); // default bucket
      const filename = `qrcodes/${storeId}/table-${tableNumber}.png`;
      const file = bucket.file(filename);
      await file.save(png, { contentType: "image/png", resumable: false });
      qrCodeUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    } catch (e) {
      // fallback: data url (emulador/local)
      qrCodeUrl = await QRCode.toDataURL(qrCodeData);
    }

    const ref = await db.collection("chairs").add({
      storeId,
      shoppingId: mallId,
      tableNumber,
      qrCodeData,
      qrCodeUrl,
      active,
      location,
      createdAt: FieldValue.serverTimestamp()
    });
    return { id: ref.id, qrCodeUrl };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const updateChairHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { id, ...rest } = req.body || {};
    if (!id) throw new Error("id-required");
    await db.collection("chairs").doc(String(id)).update({ ...rest, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const deleteChairHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { id } = req.body || {};
    if (!id) throw new Error("id-required");
    await db.collection("chairs").doc(String(id)).delete();
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const generateChairQRCodeHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, tableNumber } = req.body || {};
    if (!storeId || !tableNumber) throw new Error("invalid-payload");
    const storeDoc = await db.collection("stores").doc(storeId).get();
    const mallId = storeDoc.get("shoppingId") || "default-mall";
    const qrCodeData = buildQrCodeData({ mallId, storeId, tableNumber: Number(tableNumber) });
    const dataURL = await QRCode.toDataURL(qrCodeData);
    return { dataURL };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

import { onCall } from "firebase-functions/v2/https";

export const getChairs = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    const snap = await db.collection("chairs").where("storeId","==",storeId).orderBy("tableNumber","asc").get();
    return { items: snap.docs.map(d=>({ id: d.id, ...d.data() })) };
  });
});

export const createChair = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, tableNumber, active=true, location } = (req.data || {}) as any;
    if (!storeId || !tableNumber) throw new Error("invalid-payload");
    const storeDoc = await db.collection("stores").doc(storeId).get();
    const mallId = storeDoc.get("shoppingId") || "default-mall";
    const qrCodeData = buildQrCodeData({ mallId, storeId, tableNumber: Number(tableNumber) });
    const dataURL = await QRCode.toDataURL(qrCodeData);
    const ref = await db.collection("chairs").add({
      storeId,
      shoppingId: mallId,
      tableNumber: Number(tableNumber),
      qrCodeData,
      qrCodeUrl: dataURL,
      active,
      location,
      createdAt: FieldValue.serverTimestamp()
    });
    return { id: ref.id, qrCodeUrl: dataURL };
  });
});

export const updateChair = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { id, ...rest } = (req.data || {}) as any;
    if (!id) throw new Error("id-required");
    await db.collection("chairs").doc(String(id)).update({ ...rest, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

export const deleteChair = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { id } = (req.data || {}) as any;
    if (!id) throw new Error("id-required");
    await db.collection("chairs").doc(String(id)).delete();
    return { ok: true };
  });
});

export const generateChairQRCode = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, tableNumber } = (req.data || {}) as any;
    if (!storeId || !tableNumber) throw new Error("invalid-payload");
    const storeDoc = await db.collection("stores").doc(storeId).get();
    const mallId = storeDoc.get("shoppingId") || "default-mall";
    const qrCodeData = buildQrCodeData({ mallId, storeId, tableNumber: Number(tableNumber) });
    const dataURL = await QRCode.toDataURL(qrCodeData);
    return { dataURL };
  });
});
