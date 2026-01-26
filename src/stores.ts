import { onCall, onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { db, rtdb } from "./shared/admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { normalizeRole } from "./shared/auth.js";
import { sanitizePaymentMethods } from "./shared/payment-methods.js";
import {
  paginationSchema,
  categoryParam,
  limitParam,
  storeIdParam,
  openingHoursUpdateSchema,
  paymentMethodsUpdateSchema,
  togglePaymentMethodSchema,
  deliveryConfigUpdateSchema,
  storeInfoUpdateSchema,
  storeConfigUpdateSchema,
  dayScheduleSchema
} from "./shared/validators.js";

const WEEK_DAYS = [
  { key: "monday", label: "Segunda-feira" },
  { key: "tuesday", label: "Terça-feira" },
  { key: "wednesday", label: "Quarta-feira" },
  { key: "thursday", label: "Quinta-feira" },
  { key: "friday", label: "Sexta-feira" },
  { key: "saturday", label: "Sábado" },
  { key: "sunday", label: "Domingo" }
] as const;

const DEFAULT_OPENING_HOURS = [
  { day: "Segunda-feira", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "Terça-feira", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "Quarta-feira", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "Quinta-feira", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "Sexta-feira", isOpen: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Sábado", isOpen: true, openTime: "10:00", closeTime: "22:00" },
  { day: "Domingo", isOpen: false, openTime: "10:00", closeTime: "16:00" }
] as const;

const DEFAULT_DELIVERY_CONFIG = {
  tableServiceEnabled: true,
  manualOrderBypassEnabled: true,
  externalDeliveryEnabled: false,
  estimatedTime: 10,
  tableRanges: [] as Array<{ start: number; end: number }>
};

const STORE_CATEGORY_OPTIONS = [
  { id: "happy-hour", name: "Happy Hour" },
  { id: "brasileira", name: "Brasileira" },
  { id: "cafe", name: "Café" },
  { id: "lanches", name: "Lanches" },
  { id: "fitness", name: "Fitness" },
  { id: "salgados", name: "Salgados" },
  { id: "doces", name: "Doces" },
  { id: "padarias", name: "Padarias" },
  { id: "pizza", name: "Pizza" },
  { id: "sorvete", name: "Sorvete" },
  { id: "macarrao", name: "Macarrão" },
  { id: "japonesa", name: "Japonesa" },
  { id: "bebidas", name: "Bebidas" },
  { id: "saudavel", name: "Saudável" }
] as const;

const STORE_CATEGORY_IDS = new Set<string>(STORE_CATEGORY_OPTIONS.map((category) => category.id));

const callableOptions = {
  region: "southamerica-east1",
  cors: true
} as const;

const toISOString = (value: any) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value.toDate) return value.toDate().toISOString();
  return null;
};

const sanitizeLogoInput = (raw: unknown): string | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
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

async function serializeStore(doc: FirebaseFirestore.DocumentSnapshot) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    name: data.name || data.displayName || data.storeName || "",
    storeName: data.storeName || data.name || "",
    shoppingId: data.shoppingId || null,
    shoppingName: data.shoppingName || null,
    category: data.category || data.categoryId || null,
    categoryId: data.category || data.categoryId || null,
    status: data.status || "pending",
    isOnline: typeof data.isOnline === "boolean" ? Boolean(data.isOnline) : (data.status === "active"),
    ownerId: data.ownerId || null,
    ownerName: data.ownerName || null,
    ownerEmail: data.ownerEmail || null,
    phone: data.phone || null,
    description: data.description || null,
    cnpj: data.cnpj || null,
    razaoSocial: data.razaoSocial || null,
    createdAt: toISOString(data.createdAt),
    updatedAt: toISOString(data.updatedAt)
  };
}

const normalizeDayKey = (day: string) => day.toLowerCase().replace(/[^a-z]/g, "");

function sanitizeOpeningHours(raw: any): Array<{ day: string; isOpen: boolean; openTime?: string; closeTime?: string; breakStart?: string | null; breakEnd?: string | null }> {
  const parsed = Array.isArray(raw) ? raw : [];
  const mapped = new Map<string, ReturnType<typeof dayScheduleSchema.parse>>();
  parsed.forEach((item) => {
    try {
      const normalized = { ...item };
      if (normalized.breakStart === "" || normalized.breakStart === null) delete normalized.breakStart;
      if (normalized.breakEnd === "" || normalized.breakEnd === null) delete normalized.breakEnd;
      if (normalized.openTime === "" || normalized.openTime === null) delete normalized.openTime;
      if (normalized.closeTime === "" || normalized.closeTime === null) delete normalized.closeTime;
      const valid = dayScheduleSchema.parse(normalized);
      mapped.set(normalizeDayKey(valid.day), valid);
    } catch (err) {
      // ignore invalid entries
    }
  });
  return WEEK_DAYS.map((day) => {
    const existing = mapped.get(normalizeDayKey(day.label));
    if (existing) return existing;
    const fallback = DEFAULT_OPENING_HOURS.find((d) => normalizeDayKey(d.day) === normalizeDayKey(day.label));
    return fallback || { day: day.label, isOpen: false, openTime: "09:00", closeTime: "18:00" };
  });
}

const deliveryConfigSchema = deliveryConfigUpdateSchema.omit({ storeId: true });

function sanitizeDeliveryConfig(raw: any) {
  const parsed = deliveryConfigSchema.parse(raw ?? {});
  const ranges = Array.isArray(parsed.tableRanges) ? parsed.tableRanges.map((range) => ({
    start: Number(range.start),
    end: Number(range.end)
  })) : [];
  ranges.sort((a, b) => a.start - b.start);
  return {
    tableServiceEnabled: Boolean(parsed.tableServiceEnabled),
    manualOrderBypassEnabled: Boolean(parsed.manualOrderBypassEnabled),
    externalDeliveryEnabled: Boolean(parsed.externalDeliveryEnabled),
    estimatedTime: parsed.estimatedTime ?? DEFAULT_DELIVERY_CONFIG.estimatedTime,
    tableRanges: ranges
  };
}

async function _list(query: any) {
  const { page, pageSize } = paginationSchema.parse(query);
  let q: FirebaseFirestore.Query = db.collection("stores").where("status","in",["approved","active"]);
  const shoppingId = typeof query.shoppingId === "string" ? String(query.shoppingId).trim() : "";
  if (shoppingId) {
    q = q.where("shoppingId","==", shoppingId);
  }
  if (query.category) {
    const { category } = categoryParam.parse({ category: query.category });
    q = q.where("category","==",category);
  }
  const snap = await q.limit(pageSize).get();
  const items = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => {
      const nameA = String(a.name || a.storeName || "").toLowerCase();
      const nameB = String(b.name || b.storeName || "").toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
  const total = items.length;
  return { items, page, pageSize, total, hasMore: total === pageSize };
}

async function _getStore(storeId: string) {
  const d = await db.collection("stores").doc(storeId).get();
  if (!d.exists) throw new Error("store-not-found");
  return { id: d.id, ...d.data() };
}

async function _featured(limit = 8) {
  const snap = await db.collection("stores")
    .where("status","in",["approved","active"])
    .orderBy("rating","desc")
    .limit(limit).get();
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
}

export const getStoreCategoriesHttp = onRequest({ region: "southamerica-east1" }, withCors(async (_req: Request, res: Response) => {
  const resp = await handleErrors(async () => ({ items: STORE_CATEGORY_OPTIONS }));
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getStoresHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(() => _list(req.query));
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getStoreHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    return _getStore(storeId);
  });
  res.status(resp.success ? 200 : 404).json(resp);
}));

export const getStoresByCategoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => _list(req.query));
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getFeaturedStoresHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { limit } = limitParam.parse({ limit: req.query.limit ?? 8 });
    return _featured(limit);
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getStores = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => _list(req.data ?? {}));
});

export const getStore = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    return _getStore(storeId);
  });
});

export const getStoresByCategory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => _list(req.data ?? {}));
});

export const getFeaturedStores = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const limit = Number(req.data?.limit ?? 8);
    return _featured(limit);
  });
});

export const getStoreCategories = onCall({ region: "southamerica-east1" }, async () => {
  return handleErrors(async () => ({ items: STORE_CATEGORY_OPTIONS }));
});

export const getOwnerStore = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw Object.assign(new Error("auth-required"), { status: 401 });

    const ownerSnap = await db.collection("users").doc(uid).get();
    if (!ownerSnap.exists) throw new Error("user-not-found");
    const owner = ownerSnap.data() || {};
    if (owner.role !== "store-owner") throw new Error("permission-denied");

    const storeId = owner.storeId || owner.cnpj || uid;
    if (!storeId) return null;

    const storeSnap = await db.collection("stores").doc(String(storeId)).get();
    if (!storeSnap.exists) return null;
    return { id: storeSnap.id, ...storeSnap.data() };
  });
});

export const upsertOwnerStore = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw Object.assign(new Error("auth-required"), { status: 401 });

    const data = req.data || {};
    const hasLogoField = Object.prototype.hasOwnProperty.call(data, "logoUrl");
    let logoUrl: string | null | undefined;
    if (hasLogoField) {
      if (data.logoUrl === null || (typeof data.logoUrl === "string" && data.logoUrl.trim().length === 0)) {
        logoUrl = null;
      } else if (typeof data.logoUrl === "string") {
        logoUrl = data.logoUrl.trim();
      }
    }
    const rawCpfCnpj = String(data.cpfCnpj || data.cnpj || "").replace(/\D/g, "");
    const rawCnpj = rawCpfCnpj.length === 14 ? rawCpfCnpj : String(data.cnpj || "").replace(/\D/g, "");
    const storeName = String(data.storeName || "").trim();
    const razaoSocial = String(data.razaoSocial || "").trim();
    const shoppingId = String(data.shoppingId || "").trim();
    const shoppingName = data.shoppingName ? String(data.shoppingName) : null;
    const phone = data.phone ? String(data.phone) : null;
    const description = data.description ? String(data.description) : null;
    const rawCategory = String(data.categoryId ?? data.category ?? "").trim().toLowerCase();
    const { category } = categoryParam.parse({ category: rawCategory });
    if (!STORE_CATEGORY_IDS.has(category)) {
      throw new Error("invalid-category");
    }

    const resolvedCpfCnpj = rawCpfCnpj || rawCnpj;
    if (!resolvedCpfCnpj || (resolvedCpfCnpj.length !== 11 && resolvedCpfCnpj.length !== 14)) {
      throw new Error("invalid-cpf-cnpj");
    }

    if (!storeName || !razaoSocial || !shoppingId) {
      throw new Error("invalid-payload");
    }

    const ownerSnap = await db.collection("users").doc(uid).get();
    if (!ownerSnap.exists) throw new Error("user-not-found");
    const owner = ownerSnap.data() || {};
    if (owner.role !== "store-owner") throw new Error("permission-denied");

    const storeId = owner.storeId || resolvedCpfCnpj || rawCnpj || uid;
    const storeRef = db.collection("stores").doc(storeId);
    const existingStoreSnap = await storeRef.get();
    const existingStore = existingStoreSnap.exists ? (existingStoreSnap.data() || {}) : {};
    const previousShoppingId = existingStore.shoppingId ? String(existingStore.shoppingId) : null;
    const previousStatus = existingStore.status ? String(existingStore.status) : null;
    const ownerStatus = owner.status ? String(owner.status) : null;
    const shoppingChanged = previousShoppingId !== shoppingId || !existingStoreSnap.exists;
    const shouldResetStatus = shoppingChanged || previousStatus === "rejected" || ownerStatus === "rejected";
    const status = shouldResetStatus
      ? "pending"
      : (previousStatus || ownerStatus || "pending");
    const now = FieldValue.serverTimestamp();

    const storePayload: Record<string, any> = {
      name: storeName,
      displayName: storeName,
      description,
      phone,
      ownerId: uid,
      ownerName: owner.name || storeName,
      ownerEmail: owner.email || null,
      shoppingId,
      shoppingName,
      cnpj: resolvedCpfCnpj.length === 14 ? resolvedCpfCnpj : null,
      cpfCnpj: resolvedCpfCnpj,
      personType: resolvedCpfCnpj.length === 11 ? "FISICA" : "JURIDICA",
      razaoSocial,
      category,
      status,
      updatedAt: now,
      createdAt: owner.createdAt || now,
      ...(status === "pending" ? { approvedAt: FieldValue.delete(), activatedAt: FieldValue.delete() } : {})
    };

    if (hasLogoField) {
      if (logoUrl) {
        storePayload.logoUrl = logoUrl;
        storePayload.logoURL = logoUrl;
      } else {
        storePayload.logoUrl = FieldValue.delete();
        storePayload.logoURL = FieldValue.delete();
      }
    }

    await storeRef.set(storePayload, { merge: true });

    const userPayload: Record<string, any> = {
      storeId,
      storeName,
      shoppingId,
      shoppingName,
      cnpj: rawCnpj,
      razaoSocial,
      phone,
      categoryId: category,
      status,
      updatedAt: now,
    };

    if (hasLogoField) {
      if (logoUrl) {
        userPayload.logoUrl = logoUrl;
        userPayload.logoURL = logoUrl;
        userPayload.photoURL = logoUrl;
      } else {
        userPayload.logoUrl = FieldValue.delete();
        userPayload.logoURL = FieldValue.delete();
        userPayload.photoURL = FieldValue.delete();
      }
    }

    await db.collection("users").doc(uid).set(userPayload, { merge: true });

    const ownerPayload: Record<string, any> = {
      fullName: owner.name || storeName,
      storeName,
      razaoSocial,
      cnpj: rawCnpj,
      email: owner.email || null,
      status,
      storeId,
      shoppingId,
      shoppingName,
      category,
      updatedAt: Date.now()
    };

    if (hasLogoField) {
      ownerPayload.logoUrl = logoUrl || null;
    }

    await rtdb.ref(`storeOwners/${uid}`).update(ownerPayload);

    return { id: storeId, storeName, shoppingId, shoppingName, category };
  });
});

export const toggleStoreOnline = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw Object.assign(new Error("auth-required"), { status: 401 });

    const ownerSnap = await db.collection("users").doc(uid).get();
    if (!ownerSnap.exists) throw new Error("user-not-found");
    const owner = ownerSnap.data() || {};
    if (owner.role !== "store-owner") throw new Error("permission-denied");

    const payload = req.data || {};
    const desiredOnline =
      typeof payload.isOnline === "boolean"
        ? Boolean(payload.isOnline)
        : typeof payload.online === "boolean"
          ? Boolean(payload.online)
          : typeof payload.active === "boolean"
            ? Boolean(payload.active)
            : null;

    if (desiredOnline === null) {
      throw new Error("invalid-payload");
    }

    const storeId = owner.storeId || owner.cnpj || uid;
    if (!storeId) throw new Error("store-not-found");

    const storeRef = db.collection("stores").doc(String(storeId));
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const storeData = storeSnap.data() || {};
    const hasValidCategory = typeof storeData.category === "string"
      ? STORE_CATEGORY_IDS.has(String(storeData.category).toLowerCase())
      : typeof storeData.categoryId === "string"
        ? STORE_CATEGORY_IDS.has(String(storeData.categoryId).toLowerCase())
        : false;
    if (desiredOnline && !hasValidCategory) {
      throw new Error("category-required");
    }

    const currentStatus = String(storeData.status || owner.status || "").toLowerCase();
    if (desiredOnline && !["approved", "active"].includes(currentStatus)) {
      throw new Error("store-not-approved");
    }

    const nextStatus = desiredOnline
      ? "active"
      : currentStatus === "active"
        ? "approved"
        : currentStatus || "approved";

    const updates: Record<string, unknown> = {
      isOnline: desiredOnline,
      status: nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (desiredOnline) {
      updates.activatedAt = FieldValue.serverTimestamp();
      updates.deactivatedAt = FieldValue.delete();
    } else {
      updates.deactivatedAt = FieldValue.serverTimestamp();
    }

    await storeRef.set(updates, { merge: true });

    await db.collection("users").doc(uid).set({
      status: nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
      isOnline: desiredOnline,
    }, { merge: true });

    await rtdb.ref(`storeOwners/${uid}`).update({
      status: nextStatus,
      isOnline: desiredOnline,
      updatedAt: Date.now(),
      storeId,
    });

    const updatedSnap = await storeRef.get();
    const updatedData = updatedSnap.data() || {};
    return {
      id: updatedSnap.id,
      ...updatedData,
      isOnline: desiredOnline,
      status: nextStatus,
    };
  });
});

export const getOpeningHours = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId } = storeIdParam.parse({ storeId: String(req.data?.storeId || "") });
    const ref = db.collection("stores").doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("store-not-found");
    const sanitized = sanitizeOpeningHours(snap.get("openingHours"));
    return sanitized;
  });
});

export const updateOpeningHours = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, hours } = openingHoursUpdateSchema.parse(req.data || {});
    const normalized = sanitizeOpeningHours(hours);
    const ref = db.collection("stores").doc(storeId);
    await ref.set({
      openingHours: normalized,
      config: {
        openingHoursConfigured: normalized.some((item) => item.isOpen)
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return normalized;
  });
});

export const getPaymentMethods = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId } = storeIdParam.parse({ storeId: String(req.data?.storeId || "") });
    const ref = db.collection("stores").doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("store-not-found");
    const sanitized = sanitizePaymentMethods(snap.get("paymentMethods"));
    return sanitized;
  });
});

export const updatePaymentMethods = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, methods } = paymentMethodsUpdateSchema.parse(req.data || {});
    const sanitized = sanitizePaymentMethods(methods);
    const ref = db.collection("stores").doc(storeId);
    await ref.set({
      paymentMethods: sanitized,
      config: {
        paymentMethodsConfigured: sanitized.some((method) => method.enabled)
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return sanitized;
  });
});

export const togglePaymentMethod = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, methodId, enabled } = togglePaymentMethodSchema.parse(req.data || {});
    const ref = db.collection("stores").doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("store-not-found");
    const current = sanitizePaymentMethods(snap.get("paymentMethods"));
    const updated = current.map((method) => method.id === methodId ? { ...method, enabled } : method);
    await ref.set({
      paymentMethods: updated,
      config: {
        paymentMethodsConfigured: updated.some((method) => method.enabled)
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const changed = updated.find((method) => method.id === methodId);
    if (!changed) throw new Error("payment-method-not-found");
    return changed;
  });
});

export const getDeliveryConfig = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId } = storeIdParam.parse({ storeId: String(req.data?.storeId || "") });
    const ref = db.collection("stores").doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("store-not-found");
    const sanitized = sanitizeDeliveryConfig(snap.get("deliveryConfig"));
    return sanitized;
  });
});

export const updateDeliveryConfig = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, ...rest } = deliveryConfigUpdateSchema.parse(req.data || {});
    const sanitized = sanitizeDeliveryConfig(rest);
    const ref = db.collection("stores").doc(storeId);
    await ref.set({
      deliveryConfig: sanitized,
      config: {
        deliveryConfigured: sanitized.tableServiceEnabled && (sanitized.tableRanges?.length || 0) > 0
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return sanitized;
  });
});

export const getStoreConfig = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const requestedStoreId = typeof req.data?.storeId === "string" ? String(req.data.storeId).trim() : "";

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) throw new Error("user-not-found");
    const userData = userSnap.data() || {};
    const role = normalizeRole(userData.role);

    const allowedRoles = new Set(["store-owner", "store-manager", "store-operator", "shopping-admin", "operation", "operator"]);
    if (!allowedRoles.has(role)) throw new Error("permission-denied");

    const resolvedStoreId = requestedStoreId || userData.storeId || userData.cnpj || null;
    if (!resolvedStoreId) throw new Error("store-not-found");

    const storeRef = db.collection("stores").doc(String(resolvedStoreId));
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) throw new Error("store-not-found");

    const storeData = storeSnap.data() || {};
    const configData = (storeData.config && typeof storeData.config === "object") ? { ...storeData.config } : {};

    const sanitizedOpeningHours = sanitizeOpeningHours(storeData.openingHours);
    const sanitizedPaymentMethods = sanitizePaymentMethods(storeData.paymentMethods);
    const sanitizedDelivery = sanitizeDeliveryConfig(storeData.deliveryConfig);

    const logoUrl = (() => {
      const candidates = [storeData.logoUrl, storeData.logoURL, storeData.logo];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
      return null;
    })();

    const bannerUrl = (() => {
      const candidates = [storeData.bannerURL, storeData.bannerUrl, storeData.banner];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
      return null;
    })();

    const hasMenu = Boolean(
      configData.menuConfigured ??
        storeData.menuConfigured ??
        (Array.isArray(storeData.menu?.categories) && storeData.menu.categories.length > 0)
    );
    const hasOpeningHours = Boolean(
      configData.openingHoursConfigured ??
        storeData.openingHoursConfigured ??
        sanitizedOpeningHours.some((item) => item.isOpen)
    );
    const hasPaymentMethods = Boolean(
      configData.paymentMethodsConfigured ??
        storeData.paymentMethodsConfigured ??
        sanitizedPaymentMethods.some((method) => method.enabled)
    );
    const hasDeliveryConfig = Boolean(
      configData.deliveryConfigured ??
        storeData.deliveryConfigured ??
        (sanitizedDelivery.tableServiceEnabled && (sanitizedDelivery.tableRanges?.length || 0) > 0)
    );

    const result = {
      id: storeSnap.id,
      storeId: storeSnap.id,
      status: storeData.status || userData.status || "pending",
      categoryId: storeData.category || storeData.categoryId || null,
      category: storeData.category || storeData.categoryId || null,
      shoppingId: storeData.shoppingId || null,
      shoppingName: storeData.shoppingName || null,
      storeName: storeData.storeName || storeData.name || "",
      storeDescription: storeData.description || storeData.storeDescription || null,
      logoURL: logoUrl,
      logoUrl,
      bannerURL: bannerUrl,
      phone: storeData.phone || userData.phone || null,
      email: storeData.ownerEmail || userData.email || null,
      hasMenu,
      hasOpeningHours,
      hasPaymentMethods,
      hasDeliveryConfig,
      isOrdersActive: Boolean(
        storeData.isOnline ??
          configData.ordersActive ??
          (storeData.status && ["approved", "active"].includes(String(storeData.status).toLowerCase()))
      ),
      autoAcceptOrders: Boolean(
        configData.autoAcceptOrders ??
          storeData.autoAcceptOrders ??
          false
      ),
      openingHours: sanitizedOpeningHours,
      paymentMethods: sanitizedPaymentMethods,
      deliveryConfig: sanitizedDelivery,
      updatedAt: toISOString(storeData.updatedAt),
      createdAt: toISOString(storeData.createdAt),
      config: {
        ...configData,
      },
    };

    return result;
  });
});

export const updateStoreConfig = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const payload = storeConfigUpdateSchema.parse(req.data || {});
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("user-not-found");

    const userData = userSnap.data() || {};
    const role = normalizeRole(userData.role);
    const allowedRoles = new Set(["store-owner", "store-manager", "store-operator", "shopping-admin", "operation", "operator"]);
    if (!allowedRoles.has(role)) throw new Error("permission-denied");

    const resolvedStoreId = payload.storeId || userData.storeId || userData.cnpj || null;
    if (!resolvedStoreId) throw new Error("store-not-found");

    const storeRef = db.collection("stores").doc(String(resolvedStoreId));
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const storeData = storeSnap.data() || {};
    const baseConfig =
      storeData.config && typeof storeData.config === "object"
        ? { ...(storeData.config as Record<string, any>) }
        : {};

    const now = FieldValue.serverTimestamp();
    const storeUpdates: Record<string, any> = { updatedAt: now };
    const userUpdates: Record<string, any> = { updatedAt: now };
    const ownerRealtimeUpdates: Record<string, any> = { updatedAt: Date.now() };
    const configUpdates: Record<string, any> = { ...baseConfig };
    let configDirty = false;

    const hasLogoField = Object.prototype.hasOwnProperty.call(payload, "logoUrl");
    if (hasLogoField) {
      const sanitizedLogo = sanitizeLogoInput(payload.logoUrl ?? null);
      if (sanitizedLogo) {
        storeUpdates.logoUrl = sanitizedLogo;
        storeUpdates.logoURL = sanitizedLogo;
        configUpdates.logoConfigured = true;
        configDirty = true;

        userUpdates.logoUrl = sanitizedLogo;
        userUpdates.logoURL = sanitizedLogo;
        userUpdates.photoURL = sanitizedLogo;

        ownerRealtimeUpdates.logoUrl = sanitizedLogo;
        ownerRealtimeUpdates.logoURL = sanitizedLogo;
        ownerRealtimeUpdates.photoURL = sanitizedLogo;
      } else {
        storeUpdates.logoUrl = FieldValue.delete();
        storeUpdates.logoURL = FieldValue.delete();
        configUpdates.logoConfigured = false;
        configDirty = true;

        userUpdates.logoUrl = FieldValue.delete();
        userUpdates.logoURL = FieldValue.delete();
        userUpdates.photoURL = FieldValue.delete();

        ownerRealtimeUpdates.logoUrl = null;
        ownerRealtimeUpdates.logoURL = null;
        ownerRealtimeUpdates.photoURL = null;
      }
    }

    if (payload.autoAcceptOrders !== undefined) {
      const normalized = Boolean(payload.autoAcceptOrders);
      configUpdates.autoAcceptOrders = normalized;
      storeUpdates.autoAcceptOrders = normalized;
      ownerRealtimeUpdates.autoAcceptOrders = normalized;
      configDirty = true;
    }

    if (configDirty) {
      storeUpdates.config = configUpdates;
    }

    const writes: Array<Promise<any>> = [
      storeRef.set(storeUpdates, { merge: true }),
      userRef.set(userUpdates, { merge: true })
    ];

    if (role === "store-owner") {
      writes.push(rtdb.ref(`storeOwners/${uid}`).update(ownerRealtimeUpdates));
    }

    await Promise.all(writes);

    const updatedStoreSnap = await storeRef.get();
    return { id: updatedStoreSnap.id, ...updatedStoreSnap.data() };
  });
});

export const updateStoreInfo = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const payload = storeInfoUpdateSchema.parse(req.data || {});
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("user-not-found");

    const userData = userSnap.data() || {};
    const role = normalizeRole(userData.role);
    const allowedRoles = new Set(["store-owner", "store-manager", "store-operator", "shopping-admin", "operation", "operator"]);
    if (!allowedRoles.has(role)) throw new Error("permission-denied");

    const resolvedStoreId = payload.storeId || userData.storeId || userData.cnpj || null;
    if (!resolvedStoreId) throw new Error("store-not-found");

    const storeRef = db.collection("stores").doc(String(resolvedStoreId));
    const storeSnap = await storeRef.get();
    if (!storeSnap.exists) throw new Error("store-not-found");

    const now = FieldValue.serverTimestamp();
    const storeUpdates: Record<string, any> = { updatedAt: now };
    const userUpdates: Record<string, any> = { updatedAt: now };
    const ownerRealtimeUpdates: Record<string, any> = { updatedAt: Date.now() };

    if (payload.storeName !== undefined) {
      const trimmed = payload.storeName?.trim();
      if (trimmed) {
        storeUpdates.name = trimmed;
        storeUpdates.displayName = trimmed;
        userUpdates.storeName = trimmed;
        userUpdates.name = trimmed;
        ownerRealtimeUpdates.storeName = trimmed;
        ownerRealtimeUpdates.fullName = trimmed;
      }
    }

    if (payload.storeDescription !== undefined) {
      const desc = payload.storeDescription?.trim();
      if (desc) {
        storeUpdates.description = desc;
        ownerRealtimeUpdates.description = desc;
      } else {
        storeUpdates.description = FieldValue.delete();
        ownerRealtimeUpdates.description = null;
      }
    }

    if (payload.phone !== undefined) {
      const phone = payload.phone?.trim();
      if (phone) {
        storeUpdates.phone = phone;
        userUpdates.phone = phone;
        ownerRealtimeUpdates.phone = phone;
      } else {
        storeUpdates.phone = FieldValue.delete();
        userUpdates.phone = FieldValue.delete();
        ownerRealtimeUpdates.phone = null;
      }
    }

    if (payload.email !== undefined) {
      const email = payload.email?.trim();
      if (email) {
        storeUpdates.ownerEmail = email;
        userUpdates.email = email;
        ownerRealtimeUpdates.email = email;
      } else {
        storeUpdates.ownerEmail = FieldValue.delete();
        userUpdates.email = FieldValue.delete();
        ownerRealtimeUpdates.email = null;
      }
    }

    await Promise.all([
      storeRef.set(storeUpdates, { merge: true }),
      userRef.set(userUpdates, { merge: true }),
      role === "store-owner" ? rtdb.ref(`storeOwners/${uid}`).update(ownerRealtimeUpdates) : Promise.resolve(),
    ]);

    const updatedStoreSnap = await storeRef.get();
    return { id: updatedStoreSnap.id, ...updatedStoreSnap.data() };
  });
});

const STORE_STATUS_VALUES = ["pending","approved","active","inactive","rejected"] as const;

export const listStoresForAdmin = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const shoppingId = req.data?.shoppingId ? String(req.data.shoppingId) : null;
    const statuses = Array.isArray(req.data?.statuses)
      ? (req.data.statuses as any[]).map((s) => String(s)).filter(Boolean)
      : [];

    let query: FirebaseFirestore.Query = db.collection("stores");
    if (shoppingId) query = query.where("shoppingId","==",shoppingId);
    if (statuses.length) query = query.where("status","in", statuses.slice(0, 10));

    const snap = await query.get();
    const items = await Promise.all(snap.docs.map((doc) => serializeStore(doc)));
    items.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    return { items };
  });
});

export const updateStoreStatus = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    await ensureShoppingAdmin(req.auth?.uid);
    const storeId = String(req.data?.storeId || "").trim();
    const statusInput = String(req.data?.status || "").toLowerCase();
    if (!storeId) throw new Error("storeId-required");
    if (!STORE_STATUS_VALUES.includes(statusInput as typeof STORE_STATUS_VALUES[number])) {
      throw new Error("invalid-status");
    }

    const ref = db.collection("stores").doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("store-not-found");
    const data = snap.data() || {};

    const updates: Record<string, unknown> = {
      status: statusInput,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (statusInput === "approved") updates.approvedAt = FieldValue.serverTimestamp();
    if (statusInput === "active") updates.activatedAt = FieldValue.serverTimestamp();

    await ref.set(updates, { merge: true });

    const ownerId = data.ownerId || null;
    if (ownerId) {
      await db.collection("users").doc(String(ownerId)).set({
        status: statusInput,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      await rtdb.ref(`storeOwners/${ownerId}`).update({
        status: statusInput,
        updatedAt: Date.now(),
        storeId
      });
    }

    const updatedSnap = await ref.get();
    return serializeStore(updatedSnap);
  });
});
