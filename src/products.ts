import { onRequest, onCall } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldPath } from "firebase-admin/firestore";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { storeIdParam, productIdParam, searchQueryParam, categoryParam, limitParam } from "./shared/validators.js";
import { normalizeCustomizationGroups } from "./shared/customizations.js";

interface StoreCandidate {
  id: string;
  name: string;
}

type MenuItem = Record<string, any> & {
  id: string;
  storeId: string;
  storeName?: string;
  categoryId: string;
  name: string;
  price: number;
  available: boolean;
  description?: string | null;
  image?: string | null;
  createdAt?: any;
  preparationTime?: number | null;
  deliveryTime?: number | null;
};

function normalizePrice(value: any): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMinutes(value: any): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeBoolean(value: any): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return Boolean(value);
}

function extractStoreInfoFromPath(doc: FirebaseFirestore.QueryDocumentSnapshot): { storeId: string; categoryId: string } {
  const categoryRef = doc.ref.parent;
  const storeRef = categoryRef.parent?.parent;
  const storeId = storeRef?.id || "";
  return {
    storeId,
    categoryId: categoryRef.id,
  };
}

function resolveMediaValue(input: any): string | null {
  if (!input) return null;

  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const resolved = resolveMediaValue(entry);
      if (resolved) return resolved;
    }
    return null;
  }

  if (typeof input === "object") {
    const candidates = [
      input.url,
      input.secureUrl,
      input.secureURL,
      input.downloadURL,
      input.downloadUrl,
      input.href,
      input.src,
      input.path,
      input.fullPath,
      input.filePath,
      input.imageUrl,
      input.imageURL,
      input.image,
      input.main,
      input.value,
    ];

    for (const candidate of candidates) {
      const resolved = resolveMediaValue(candidate);
      if (resolved) return resolved;
    }
  }

  return null;
}

function mapMenuItem(doc: FirebaseFirestore.QueryDocumentSnapshot, store?: StoreCandidate): MenuItem {
  const data = doc.data() || {};
  const { storeId: pathStoreId, categoryId } = extractStoreInfoFromPath(doc);
  const rest = { ...data } as Record<string, any>;
  delete rest.customizations;
  delete rest.modifiers;
  delete rest.accompaniments;

  const storeId = rest.storeId || store?.id || pathStoreId;
  const createdAt = rest.createdAt?.toDate?.() ?? doc.createTime?.toDate?.() ?? null;
  const customizations = normalizeCustomizationGroups(data.customizations ?? data.modifiers ?? data.accompaniments);

  const preparationTime = normalizeMinutes(rest.preparationTime);
  const deliveryTime = normalizeMinutes(rest.deliveryTime);
  const imageValue =
    resolveMediaValue(rest.imageUrl) ??
    resolveMediaValue(rest.imageURL) ??
    resolveMediaValue(rest.image) ??
    resolveMediaValue(rest.thumbnail) ??
    resolveMediaValue(rest.photo) ??
    resolveMediaValue(rest.picture) ??
    resolveMediaValue(rest.media) ??
    resolveMediaValue(rest.images);

  const item: MenuItem = {
    ...rest,
    id: doc.id,
    storeId,
    storeName: rest.storeName || store?.name || "",
    categoryId,
    name: rest.name || "",
    description: rest.description || null,
    price: normalizePrice(rest.price),
    available: rest.available === undefined ? true : normalizeBoolean(rest.available),
    createdAt,
  };
  if (imageValue) {
    item.image = imageValue;
    (item as any).imageUrl = imageValue;
  } else {
    delete (item as any).image;
    delete (item as any).imageUrl;
  }

  if (preparationTime != null) item.preparationTime = preparationTime;
  else delete (item as any).preparationTime;

  if (deliveryTime != null) item.deliveryTime = deliveryTime;
  else delete (item as any).deliveryTime;

  if (customizations) {
    (item as any).customizations = customizations;
    (item as any).accompaniments = customizations;
  }

  return item;
}

async function getStoreMeta(storeId: string): Promise<StoreCandidate> {
  const snap = await db.collection("stores").doc(storeId).get();
  const data = snap.data() || {};
  return {
    id: storeId,
    name: data.name || data.displayName || data.storeName || "",
  };
}

async function getMenuItemsForStore(storeId: string): Promise<MenuItem[]> {
  const storeMeta = await getStoreMeta(storeId).catch(() => ({ id: storeId, name: "" }));
  const categoriesSnap = await db.collection("menus").doc(storeId).collection("categories").get();
  if (categoriesSnap.empty) return [];

  const itemsPerCategory = await Promise.all(
    categoriesSnap.docs.map(async (categoryDoc) => {
      const itemsSnap = await categoryDoc.ref.collection("items").get();
      return itemsSnap.docs
        .map((itemDoc) => mapMenuItem(itemDoc, storeMeta))
        .filter((item) => item.available !== false && item.storeId);
    }),
  );

  return itemsPerCategory.flat();
}

async function getAllMenuItems(): Promise<MenuItem[]> {
  const snap = await db.collectionGroup("items").get();
  const storeCache = new Map<string, StoreCandidate>();

  const resolveStore = async (storeId: string) => {
    if (!storeId) return { id: storeId, name: "" };
    if (storeCache.has(storeId)) return storeCache.get(storeId)!;
    const meta = await getStoreMeta(storeId).catch(() => ({ id: storeId, name: "" }));
    storeCache.set(storeId, meta);
    return meta;
  };

  const items: MenuItem[] = [];
  for (const doc of snap.docs) {
    const { storeId } = extractStoreInfoFromPath(doc);
    const storeMeta = await resolveStore(storeId);
    const mapped = mapMenuItem(doc, storeMeta);
    if (mapped.available !== false && mapped.storeId) {
      items.push(mapped);
    }
  }
  return items;
}

async function getCandidateStores(maxStores = 25): Promise<StoreCandidate[]> {
  const snap = await db
    .collection("stores")
    .where("status", "in", ["approved", "active"])
    .limit(maxStores)
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() || {} }))
    .filter(({ data }) => {
      const ordersEnabled = data.config?.ordersEnabled;
      const tableServiceEnabled = data.deliveryConfig?.tableDeliveryEnabled;
      const isExplicitOnline = data.isOnline !== false;
      return ordersEnabled !== false && tableServiceEnabled !== false && isExplicitOnline;
    })
    .map(({ id, data }) => ({
      id,
      name: data.name || data.displayName || data.storeName || "",
    }));
}

async function fetchStoreMenuItems(store: StoreCandidate, maxItemsPerStore = 5): Promise<MenuItem[]> {
  const categoriesSnap = await db.collection("menus").doc(store.id).collection("categories").get();
  if (categoriesSnap.empty) return [];

  const perCategoryItems = await Promise.all(
    categoriesSnap.docs.map(async (categoryDoc) => {
      const itemsSnap = await categoryDoc.ref.collection("items").get();
      return itemsSnap.docs
        .map((itemDoc) => mapMenuItem(itemDoc, store))
        .filter((item) => item && item.available !== false && typeof item.price === "number");
    }),
  );

  const items = perCategoryItems.flat();
  if (!items.length) return [];

  items.sort((a, b) => a.price - b.price);

  return items.slice(0, maxItemsPerStore);
}

async function collectCheapDeals(limit: number): Promise<MenuItem[]> {
  const stores = await getCandidateStores(Math.max(limit * 2, 20));
  if (!stores.length) return [];

  const maxItemsPerStore = Math.max(2, Math.ceil(limit / stores.length) * 2);
  const storeItems = await Promise.all(stores.map((store) => fetchStoreMenuItems(store, maxItemsPerStore)));
  const combined = storeItems.flat();

  combined.sort((a, b) => a.price - b.price);
  return combined.slice(0, limit);
}

export const getProductsByStoreHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId } = storeIdParam.parse({ storeId: String(req.query.storeId || "") });
    const items = await getMenuItemsForStore(storeId);
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getProductHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { productId } = productIdParam.parse({ productId: String(req.query.productId || "") });
    let snap = await db.collectionGroup("items")
      .where(FieldPath.documentId(), "==", productId)
      .limit(1)
      .get();
    if (snap.empty) {
      const fallbackFields = ["id", "productId", "legacyId", "itemId"] as const;
      for (const field of fallbackFields) {
        snap = await db.collectionGroup("items")
          .where(field, "==", productId)
          .limit(1)
          .get();
        if (!snap.empty) break;
      }
    }
    if (snap.empty) throw new Error("product-not-found");

    const doc = snap.docs[0];
    const storeRef = doc.ref.parent.parent?.parent;
    const storeMeta = storeRef ? await getStoreMeta(storeRef.id) : undefined;
    return mapMenuItem(doc, storeMeta);
  });
  res.status(resp.success ? 200 : 404).json(resp);
}));

export const searchProductsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { query } = searchQueryParam.parse({ query: String(req.query.query || "") });
    const q = query.toLowerCase();
    const items = (await getAllMenuItems()).filter((item) => String(item.name).toLowerCase().includes(q));
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getProductsByCategoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { category } = categoryParam.parse({ category: String(req.query.category || "") });
    const normalized = category.toLowerCase();
    const items = (await getAllMenuItems()).filter((item) => {
      const itemCategory = String(item.category || item.categoryId || "").toLowerCase();
      return itemCategory === normalized;
    });
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getFeaturedProductsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { limit } = limitParam.parse({ limit: req.query.limit ?? 12 });
    const items = (await getAllMenuItems())
      .sort((a, b) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, limit);
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getCheapDealsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const limitValue = Number(req.query.limit ?? 12);
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.floor(limitValue), 1), 50) : 12;
    const items = await collectCheapDeals(limit);
    return { items };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getProductsByStore = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const items = await getMenuItemsForStore(storeId);
    return { items };
  });
});

export const getProduct = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const productId = String(req.data?.productId || "");
    if (!productId) throw new Error("productId required");
    const snap = await db.collectionGroup("items")
      .where(FieldPath.documentId(), "==", productId)
      .limit(1)
      .get();
    if (snap.empty) throw new Error("product-not-found");
    return mapMenuItem(snap.docs[0]);
  });
});

export const searchProducts = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const query = String(req.data?.query || "");
    const q = query.toLowerCase();
    const items = (await getAllMenuItems()).filter((item) => String(item.name).toLowerCase().includes(q));
    return { items };
  });
});

export const getProductsByCategory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const category = String(req.data?.category || "");
    const normalized = category.toLowerCase();
    const items = (await getAllMenuItems()).filter((item) => {
      const itemCategory = String(item.category || item.categoryId || "").toLowerCase();
      return itemCategory === normalized;
    });
    return { items };
  });
});

export const getFeaturedProducts = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const limit = Number(req.data?.limit ?? 12);
    const items = (await getAllMenuItems())
      .sort((a, b) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, limit);
    return { items };
  });
});

export const getCheapDeals = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const limitValue = Number(req.data?.limit ?? 12);
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.floor(limitValue), 1), 50) : 12;
    const items = await collectCheapDeals(limit);
    return { items };
  });
});
