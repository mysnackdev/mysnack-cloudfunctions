import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { sanitizeCustomizationGroups } from "./shared/customizations.js";

const col = (storeId: string) => db.collection("menus").doc(storeId).collection("categories");

export const getMenuHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    const catSnap = await col(storeId).orderBy("order","asc").get();
    const categories = await Promise.all(catSnap.docs.map(async cd => {
      const itemsSnap = await cd.ref.collection("items").orderBy("name").get();
      return { id: cd.id, ...cd.data(), items: itemsSnap.docs.map(d=>({ id: d.id, ...d.data() })) };
    }));
    return { categories };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const createMenuCategoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, name, description, available=true, order=0 } = req.body || {};
    if (!storeId || !name) throw new Error("invalid-payload");
    const ref = await col(storeId).add({ name, description, available, order, createdAt: FieldValue.serverTimestamp() });
    return { id: ref.id };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const updateMenuCategoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, ...rest } = req.body || {};
    if (!storeId || !categoryId) throw new Error("invalid-payload");
    await col(storeId).doc(categoryId).update({ ...rest, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const deleteMenuCategoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId } = req.body || {};
    if (!storeId || !categoryId) throw new Error("invalid-payload");
    await col(storeId).doc(categoryId).delete();
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const createMenuItemHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, name, description, price, available=true, imageUrl, preparationTime, deliveryTime, modifiers, category, customizations } = req.body || {};
    if (!storeId || !categoryId || !name || price == null) throw new Error("invalid-payload");
    const sanitizedCustomizations = sanitizeCustomizationGroups(customizations);
    const payload: Record<string, any> = {
      storeId,
      name,
      description,
      price,
      available,
      imageUrl,
      category,
      preparationTime,
      deliveryTime,
      modifiers,
      createdAt: FieldValue.serverTimestamp(),
    };
    if (sanitizedCustomizations.length) {
      payload.customizations = sanitizedCustomizations;
      payload.accompaniments = sanitizedCustomizations;
    }
    const ref = await col(storeId).doc(categoryId).collection("items").add(payload);
    return { id: ref.id };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const updateMenuItemHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, itemId, customizations, ...rest } = req.body || {};
    if (!storeId || !categoryId || !itemId) throw new Error("invalid-payload");
    const sanitizedCustomizations = sanitizeCustomizationGroups(customizations);
    await col(storeId).doc(categoryId).collection("items").doc(itemId).update({
      ...rest,
      customizations: sanitizedCustomizations.length ? sanitizedCustomizations : FieldValue.delete(),
      accompaniments: sanitizedCustomizations.length ? sanitizedCustomizations : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const deleteMenuItemHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, itemId } = req.body || {};
    if (!storeId || !categoryId || !itemId) throw new Error("invalid-payload");
    await col(storeId).doc(categoryId).collection("items").doc(itemId).delete();
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const toggleItemAvailabilityHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, itemId, available } = req.body || {};
    if (!storeId || !categoryId || !itemId || available == null) throw new Error("invalid-payload");
    await col(storeId).doc(categoryId).collection("items").doc(itemId).update({ available });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const toggleCategoryAvailabilityHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { storeId, categoryId, available } = req.body || {};
    if (!storeId || !categoryId || available == null) throw new Error("invalid-payload");
    await col(storeId).doc(categoryId).update({ available });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

import { onCall } from "firebase-functions/v2/https";

export const getMenu = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    const catSnap = await db.collection("menus").doc(storeId).collection("categories").orderBy("order","asc").get();
    const categories = await Promise.all(catSnap.docs.map(async cd => {
      const itemsSnap = await cd.ref.collection("items").orderBy("name").get();
      return { id: cd.id, ...cd.data(), items: itemsSnap.docs.map(d=>({ id: d.id, ...d.data() })) };
    }));
    return { categories };
  });
});

export const createMenuCategory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, name, description, available=true, order=0 } = req.data || {};
    if (!storeId || !name) throw new Error("invalid-payload");
    const ref = await db.collection("menus").doc(storeId).collection("categories").add({ name, description, available, order, createdAt: FieldValue.serverTimestamp() });
    return { id: ref.id };
  });
});

export const updateMenuCategory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, ...rest } = req.data || {};
    if (!storeId || !categoryId) throw new Error("invalid-payload");
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).update({ ...rest, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

export const deleteMenuCategory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId } = req.data || {};
    if (!storeId || !categoryId) throw new Error("invalid-payload");
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).delete();
    return { ok: true };
  });
});

export const createMenuItem = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, name, description, price, available=true, imageUrl, preparationTime, deliveryTime, modifiers, category, customizations } = req.data || {};
    if (!storeId || !categoryId || !name || price == null) throw new Error("invalid-payload");
    const sanitizedCustomizations = sanitizeCustomizationGroups(customizations);
    const payload: Record<string, any> = {
      storeId,
      name,
      description,
      price,
      available,
      imageUrl,
      category,
      preparationTime,
      deliveryTime,
      modifiers,
      createdAt: FieldValue.serverTimestamp(),
    };
    if (sanitizedCustomizations.length) {
      payload.customizations = sanitizedCustomizations;
      payload.accompaniments = sanitizedCustomizations;
    }
    const ref = await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).collection("items").add(payload);
    return { id: ref.id };
  });
});

export const updateMenuItem = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, itemId, customizations, ...rest } = req.data || {};
    if (!storeId || !categoryId || !itemId) throw new Error("invalid-payload");
    const sanitizedCustomizations = sanitizeCustomizationGroups(customizations);
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).collection("items").doc(itemId).update({
      ...rest,
      customizations: sanitizedCustomizations.length ? sanitizedCustomizations : FieldValue.delete(),
      accompaniments: sanitizedCustomizations.length ? sanitizedCustomizations : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true };
  });
});

export const deleteMenuItem = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, itemId } = req.data || {};
    if (!storeId || !categoryId || !itemId) throw new Error("invalid-payload");
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).collection("items").doc(itemId).delete();
    return { ok: true };
  });
});

export const toggleItemAvailability = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, itemId, available } = req.data || {};
    if (!storeId || !categoryId || !itemId || available == null) throw new Error("invalid-payload");
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).collection("items").doc(itemId).update({ available });
    return { ok: true };
  });
});

export const toggleCategoryAvailability = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { storeId, categoryId, available } = req.data || {};
    if (!storeId || !categoryId || available == null) throw new Error("invalid-payload");
    await db.collection("menus").doc(storeId).collection("categories").doc(categoryId).update({ available });
    return { ok: true };
  });
});
