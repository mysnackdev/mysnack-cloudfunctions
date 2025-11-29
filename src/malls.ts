import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { normalizeRole } from "./shared/auth.js";
import { mallCreateSchema, mallUpdateSchema, mallToggleSchema, mallIdParam, mallPaymentMethodsUpdateSchema, mallTogglePaymentMethodSchema } from "./shared/validators.js";
import { sanitizePaymentMethods } from "./shared/payment-methods.js";

const callableOptions = {
  region: "southamerica-east1",
  cors: true
} as const;

export const listMallsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (_req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const snap = await db.collection("malls").orderBy("name").get();
    const items = await Promise.all(snap.docs.map((doc) => serializeMall(doc)));
    const activeItems = items.filter((mall) => mall.isActive);
    return { items: activeItems };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getMallHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const mallId = String(req.query.mallId || "").trim();
    if (!mallId) throw new Error("mallId-required");
    const doc = await db.collection("malls").doc(mallId).get();
    if (!doc.exists) throw new Error("mall-not-found");
    return await serializeMall(doc);
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

function parseQrData(raw: string) {
  const qr = String(raw || "").trim();
  if (!qr) throw new Error("invalid-qr");

  const legacyMatch = qr.match(/^mysnack:\/\/table\/([^\/]+)\/(\d+)$/i);
  if (legacyMatch) {
    return {
      mallId: legacyMatch[1],
      tableNumber: Number(legacyMatch[2]),
    };
  }

  try {
    const url = new URL(qr);

    // Allow QR codes to embed another payload via ?qr=
    const embedded = url.searchParams.get("qr");
    if (embedded) {
      return parseQrData(embedded);
    }

    const mallId = url.searchParams.get("mallId");
    const storeId = url.searchParams.get("storeId") || undefined;
    const tableParam = url.searchParams.get("table") || url.searchParams.get("tableNumber");

    if (!mallId || !tableParam) {
      throw new Error("invalid-url-qr");
    }

    const tableNumber = Number(tableParam);
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      throw new Error("invalid-qr");
    }

    return { mallId, tableNumber, storeId };
  } catch (error) {
    console.warn("[parseQrData] failed to parse QR", qr, error);
    throw new Error("invalid-qr");
  }
}

const toISOString = (value: any) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value.toDate) return value.toDate().toISOString();
  return null;
};

const sanitizeMediaInput = (raw: unknown): string | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }
  return null;
};

const sanitizeLogoInput = (raw: unknown): string | null | undefined => sanitizeMediaInput(raw);
const sanitizeBannerInput = (raw: unknown): string | null | undefined => sanitizeMediaInput(raw);

const resolveLogoFromData = (data: Record<string, any>): string | null => {
  const candidates = [
    data.logoUrl,
    data.logoURL,
    data.logo,
    data.logoPath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
};

const resolveBannerFromData = (data: Record<string, any>): string | null => {
  const candidates = [
    data.bannerUrl,
    data.bannerURL,
    data.banner,
    data.bannerPath,
    data.coverImage,
    data.coverUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
};

async function getUserRole(uid: string | undefined | null) {
  if (!uid) return null;
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return null;
  const role = userSnap.get("role") || null;
  return role ? normalizeRole(role) : null;
}

async function ensureShoppingAdmin(uid: string | undefined | null) {
  if (!uid) throw new Error("auth-required");
  const role = await getUserRole(uid);
  if (role !== "shopping-admin") throw new Error("permission-denied");
}

async function serializeMall(doc: FirebaseFirestore.DocumentSnapshot, options?: { includeStats?: boolean }) {
  const data = doc.data() || {};
  const includeStats = options?.includeStats ?? false;
  let storesCount = data.storesCount ?? 0;
  let chairsCount = data.chairsCount ?? 0;
  const logoUrl = resolveLogoFromData(data);
  const bannerUrl = resolveBannerFromData(data);

  if (includeStats) {
    const storesSnap = await db.collection("stores").where("shoppingId","==",doc.id).get();
    storesCount = storesSnap.size;
    const chairsSnap = await db.collection("chairs").where("shoppingId","==",doc.id).get();
    chairsCount = chairsSnap.size;
  }

  return {
    id: doc.id,
    name: data.name || "",
    address: data.address || "",
    city: data.city || "",
    state: data.state || "",
    zipCode: data.zipCode || "",
    description: data.description || null,
    isActive: data.isActive !== false,
    storesCount,
    chairsCount,
    createdAt: toISOString(data.createdAt),
    updatedAt: toISOString(data.updatedAt),
    logoUrl,
    bannerUrl,
  };
}

export const getMallByQRCodeHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const qr = String(req.query.qr || "");
    if (!qr) throw new Error("qr-required");
    const { mallId } = parseQrData(qr);
    const d = await db.collection("malls").doc(mallId).get();
    if (!d.exists) throw new Error("mall-not-found");
    return await serializeMall(d);
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getTableInfoHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const qr = String(req.query.qr || "");
    if (!qr) throw new Error("qr-required");
    const { mallId, tableNumber, storeId } = parseQrData(qr);

    let chairDoc: QueryDocumentSnapshot | null = null;
    if (storeId) {
      const snap = await db
        .collection("chairs")
        .where("storeId", "==", storeId)
        .where("tableNumber", "==", tableNumber)
        .limit(1)
        .get();
      if (!snap.empty) {
        chairDoc = snap.docs[0];
      }
    }

    if (!chairDoc) {
      const chairSnap = await db.collection("chairs").where("tableNumber","==",tableNumber).get();
      chairDoc = chairSnap.docs.find((doc) => {
        const data = doc.data() || {};
        const qrCodeData = String((data as any).qrCodeData || "");
        return qrCodeData.includes(mallId);
      }) || null;
    }

    if (!chairDoc) throw new Error("table-not-found");

    const chair = { id: chairDoc.id, ...chairDoc.data() };
    if (!chair) throw new Error("table-not-found");

    const storeIdToLoad = storeId || (chair as any).storeId;
    const store = await db.collection("stores").doc(String(storeIdToLoad)).get();
    const mallSnap = await db.collection("malls").doc(mallId).get();
    const mall = mallSnap.exists ? await serializeMall(mallSnap) : null;
    return { chair, store: { id: store.id, ...store.data() }, mallId, mall, tableNumber };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const validateTableHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { qr } = req.body || {};
    if (!qr) throw new Error("qr-required");
    const { mallId, tableNumber, storeId } = parseQrData(qr);

    let chairDoc: QueryDocumentSnapshot | null = null;
    if (storeId) {
      const snap = await db
        .collection("chairs")
        .where("storeId", "==", storeId)
        .where("tableNumber", "==", tableNumber)
        .where("active", "==", true)
        .limit(1)
        .get();
      if (!snap.empty) chairDoc = snap.docs[0];
    }

    if (!chairDoc) {
      const chairSnap = await db
        .collection("chairs")
        .where("tableNumber","==",tableNumber)
        .where("active","==",true)
        .get();
      chairDoc = chairSnap.docs.find((doc) => {
        const data = doc.data() || {};
        const qrCodeData = String((data as any).qrCodeData || "");
        return qrCodeData.includes(mallId);
      }) || null;
    }

    const chair = chairDoc ? { id: chairDoc.id, ...chairDoc.data() } : null;
    return { valid: !!chair, tableNumber, mallId };
  });
  res.status(200).json(resp);
}));

export const getMallPaymentMethodsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const mallId = String(req.query.mallId || "").trim();
    if (!mallId) throw new Error("mallId-required");
    const doc = await db.collection("malls").doc(mallId).get();
    if (!doc.exists) throw new Error("mall-not-found");
    const sanitized = sanitizePaymentMethods(doc.get("paymentMethods"));
    return { items: sanitized };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

import { onCall } from "firebase-functions/v2/https";

export const getMallByQRCode = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const qr = String(req.data?.qr || "");
    if (!qr) throw new Error("qr-required");
    const { mallId } = parseQrData(qr);
    const d = await db.collection("malls").doc(mallId).get();
    if (!d.exists) throw new Error("mall-not-found");
    return serializeMall(d);
  });
});

export const getTableInfo = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const qr = String(req.data?.qr || "");
    if (!qr) throw new Error("qr-required");
    const { mallId, tableNumber, storeId } = parseQrData(qr);

    let chairDoc: QueryDocumentSnapshot | null = null;
    if (storeId) {
      const snap = await db
        .collection("chairs")
        .where("storeId","==",storeId)
        .where("tableNumber","==",tableNumber)
        .limit(1)
        .get();
      if (!snap.empty) chairDoc = snap.docs[0];
    }

    if (!chairDoc) {
      const chairSnap = await db.collection("chairs").where("tableNumber","==",tableNumber).get();
      chairDoc = chairSnap.docs.find((doc) => {
        const data = doc.data() || {};
        const qrCodeData = String((data as any).qrCodeData || "");
        return qrCodeData.includes(mallId);
      }) || null;
    }

    if (!chairDoc) throw new Error("table-not-found");

    const chair = { id: chairDoc.id, ...chairDoc.data() };
    const storeRefId = storeId || (chair as any).storeId;
    const store = await db.collection("stores").doc(String(storeRefId)).get();
    const mallSnap = await db.collection("malls").doc(mallId).get();
    const mall = mallSnap.exists ? await serializeMall(mallSnap) : null;
    return { chair, store: { id: store.id, ...store.data() }, mallId, mall, tableNumber };
  });
});

export const validateTable = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const qr = String(req.data?.qr || "");
    if (!qr) throw new Error("qr-required");
    const { mallId, tableNumber, storeId } = parseQrData(qr);

    let chairDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    if (storeId) {
      const snap = await db.collection("chairs")
        .where("storeId","==",storeId)
        .where("tableNumber","==",tableNumber)
        .where("active","==",true)
        .limit(1)
        .get();
      if (!snap.empty) chairDoc = snap.docs[0];
    }

    if (!chairDoc) {
      const chairSnap = await db.collection("chairs")
        .where("tableNumber","==",tableNumber)
        .where("active","==",true)
        .get();
      chairDoc = chairSnap.docs.find((doc) => {
        const data = doc.data() || {};
        const qrCodeData = String((data as any).qrCodeData || "");
        return qrCodeData.includes(mallId);
      }) || null;
    }

    const chair = chairDoc ? { id: chairDoc.id, ...chairDoc.data() } : null;
    return { valid: !!chair, tableNumber, mallId };
  });
});

export const listMalls = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const includeStatsRequested = Boolean(req.data?.includeStats);
    let includeStats = false;
    if (includeStatsRequested) {
      await ensureShoppingAdmin(req.auth?.uid);
      includeStats = true;
    }
    const snap = await db.collection("malls").orderBy("name").get();
    const items = await Promise.all(snap.docs.map((doc) => serializeMall(doc, { includeStats })));
    return { items };
  });
});

export const createMall = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const payload = mallCreateSchema.parse(req.data || {});
    const logoInput = sanitizeLogoInput(payload.logoUrl);
    const bannerInput = sanitizeBannerInput(payload.bannerUrl);
    const now = FieldValue.serverTimestamp();
    const docData: Record<string, any> = {
      name: payload.name,
      address: payload.address,
      city: payload.city,
      state: payload.state,
      zipCode: payload.zipCode,
      description: payload.description ?? null,
      isActive: true,
      storesCount: 0,
      chairsCount: 0,
      createdAt: now,
      updatedAt: now
    };
    if (logoInput) {
      docData.logoUrl = logoInput;
      docData.logoURL = logoInput;
    }
    if (bannerInput) {
      docData.bannerUrl = bannerInput;
      docData.bannerURL = bannerInput;
    }
    const docRef = await db.collection("malls").add(docData);
    const doc = await docRef.get();
    return serializeMall(doc, { includeStats: true });
  });
});

export const updateMall = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const { mallId, ...rest } = mallUpdateSchema.parse(req.data || {});
    if (!Object.keys(rest).length) throw new Error("invalid-payload");
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (rest.name !== undefined) update.name = rest.name;
    if (rest.address !== undefined) update.address = rest.address;
    if (rest.city !== undefined) update.city = rest.city;
    if (rest.state !== undefined) update.state = rest.state;
    if (rest.zipCode !== undefined) update.zipCode = rest.zipCode;
    if (rest.description !== undefined) update.description = rest.description ?? null;
    if (rest.logoUrl !== undefined) {
      const logoInput = sanitizeLogoInput(rest.logoUrl);
      if (logoInput) {
        update.logoUrl = logoInput;
        update.logoURL = logoInput;
      } else {
        update.logoUrl = FieldValue.delete();
        update.logoURL = FieldValue.delete();
      }
    }
    if (rest.bannerUrl !== undefined) {
      const bannerInput = sanitizeBannerInput(rest.bannerUrl);
      if (bannerInput) {
        update.bannerUrl = bannerInput;
        update.bannerURL = bannerInput;
      } else {
        update.bannerUrl = FieldValue.delete();
        update.bannerURL = FieldValue.delete();
      }
    }
    const ref = db.collection("malls").doc(mallId);
    await ref.set(update, { merge: true });
    const doc = await ref.get();
    return serializeMall(doc, { includeStats: true });
  });
});

export const toggleMallStatus = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const { mallId, isActive } = mallToggleSchema.parse(req.data || {});
    const ref = db.collection("malls").doc(mallId);
    await ref.set({
      isActive,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const doc = await ref.get();
    return serializeMall(doc, { includeStats: true });
  });
});

export const getMallPaymentMethods = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const mallId = String(req.data?.mallId || "").trim();
    if (!mallId) throw new Error("mallId-required");
    const ref = db.collection("malls").doc(mallId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("mall-not-found");
    const sanitized = sanitizePaymentMethods(snap.get("paymentMethods"));
    return sanitized;
  });
});

export const updateMallPaymentMethods = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const { mallId, methods } = mallPaymentMethodsUpdateSchema.parse(req.data || {});
    const ref = db.collection("malls").doc(mallId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("mall-not-found");
    const sanitized = sanitizePaymentMethods(methods);
    await ref.set({
      paymentMethods: sanitized,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return sanitized;
  });
});

export const toggleMallPaymentMethod = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const { mallId, methodId, enabled } = mallTogglePaymentMethodSchema.parse(req.data || {});
    const ref = db.collection("malls").doc(mallId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("mall-not-found");
    const current = sanitizePaymentMethods(snap.get("paymentMethods"));
    const updated = current.map((method) => method.id === methodId ? { ...method, enabled } : method);
    await ref.set({
      paymentMethods: updated,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const changed = updated.find((method) => method.id === methodId);
    if (!changed) throw new Error("payment-method-not-found");
    return changed;
  });
});

export const deleteMall = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const { mallId } = mallIdParam.parse({ mallId: String((req.data || {}).mallId || "") });
    const storesSnap = await db.collection("stores").where("shoppingId","==",mallId).limit(1).get();
    if (!storesSnap.empty) throw new Error("mall-has-stores");
    await db.collection("malls").doc(mallId).delete();
    return { ok: true };
  });
});
