import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import { createOrderSchema, updateOrderStatusSchema } from "./shared/validators.js";

const FEE_RATE = 0.08;
const DEFAULT_STORE_TIMEZONE = "America/Sao_Paulo";
const WEEKDAY_PT_BR = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado"
] as const;

function calcTotals(items: Array<{ price: number; qty: number }>) {
  const subtotal = items.reduce((acc, it) => acc + (Number(it.price) * Number(it.qty)), 0);
  const fee = +(subtotal * FEE_RATE).toFixed(2);
  const total = +subtotal.toFixed(2);
  return { subtotal, fee, total };
}

function statusTimestampField(status: string) {
  switch(status) {
    case 'accepted': return 'acceptedAt';
    case 'preparing': return 'preparingAt';
    case 'ready': return 'readyAt';
    case 'on-the-way': return 'onTheWayAt';
    case 'delivered': return 'deliveredAt';
    case 'cancelled': return 'cancelledAt';
    default: return 'updatedAt';
  }
}

function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getNowInStoreTimezone(timeZone?: string | null) {
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: timeZone || DEFAULT_STORE_TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const weekdayRaw = parts.find((p) => p.type === "weekday")?.value || "";
  const hourRaw = parts.find((p) => p.type === "hour")?.value || "00";
  const minuteRaw = parts.find((p) => p.type === "minute")?.value || "00";
  const normalizedWeekday = weekdayRaw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const weekdayIndex = WEEKDAY_PT_BR.findIndex((label) =>
    label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === normalizedWeekday
  );
  return {
    weekdayIndex: weekdayIndex >= 0 ? weekdayIndex : new Date().getDay(),
    nowMinutes: (Number(hourRaw) || 0) * 60 + (Number(minuteRaw) || 0)
  };
}

function assertStoreCanReceiveOrders(storeData: Record<string, any>) {
  const isOnline = storeData.isOnline;
  if (isOnline === false) {
    throw new Error("store-closed");
  }

  const openingHours = Array.isArray(storeData.openingHours) ? storeData.openingHours : [];
  if (!openingHours.length) return;

  const timeZone = typeof storeData.timezone === "string" ? storeData.timezone : DEFAULT_STORE_TIMEZONE;
  const { weekdayIndex, nowMinutes } = getNowInStoreTimezone(timeZone);
  const todayLabel = WEEKDAY_PT_BR[weekdayIndex] || WEEKDAY_PT_BR[new Date().getDay()];

  const dayConfig = openingHours.find((item: any) => {
    const rawDay = String(item?.day || "").trim();
    if (!rawDay) return false;
    const normalizedRaw = rawDay.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const normalizedTarget = todayLabel.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return normalizedRaw === normalizedTarget;
  });

  if (!dayConfig) return;
  if (!dayConfig.isOpen) {
    throw new Error("store-closed");
  }

  const openMinutes = parseTimeToMinutes(dayConfig.openTime);
  const closeMinutes = parseTimeToMinutes(dayConfig.closeTime);
  if (openMinutes == null || closeMinutes == null) return;

  const isOpenNow = nowMinutes >= openMinutes && nowMinutes < closeMinutes;
  if (!isOpenNow) {
    throw new Error("store-closed");
  }

  const breakStartMinutes = parseTimeToMinutes(dayConfig.breakStart);
  const breakEndMinutes = parseTimeToMinutes(dayConfig.breakEnd);
  if (
    breakStartMinutes != null &&
    breakEndMinutes != null &&
    nowMinutes >= breakStartMinutes &&
    nowMinutes < breakEndMinutes
  ) {
    throw new Error("store-closed");
  }
}

function pickText(...values: any[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

async function resolveMenuItemDescription(storeId: string, productId: string): Promise<string | null> {
  const normalizedStoreId = String(storeId || "").trim();
  const normalizedProductId = String(productId || "").trim();
  if (!normalizedStoreId || !normalizedProductId) return null;
  const categoriesSnap = await db.collection("menus").doc(normalizedStoreId).collection("categories").get();
  if (categoriesSnap.empty) return null;
  for (const categoryDoc of categoriesSnap.docs) {
    const itemSnap = await categoryDoc.ref.collection("items").doc(normalizedProductId).get();
    if (!itemSnap.exists) continue;
    const data = itemSnap.data() || {};
    const description = pickText(data.description, data.details, data.desc);
    if (description) return description;
  }
  return null;
}

type WaiterRole =
  | "waiter"
  | "shopping-admin"
  | "operation"
  | "operations"
  | "operator"
  | "store-operator"
  | "store-manager";

const WAITER_ALLOWED_ROLES: ReadonlyArray<WaiterRole> = [
  "waiter",
  "shopping-admin",
  "operation",
  "operations",
  "operator",
  "store-operator",
  "store-manager"
];

async function getWaiterContext(uid: string | undefined | null) {
  if (!uid) throw new Error("auth-required");
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) throw new Error("user-not-found");
  const user = userSnap.data() || {};
  const rawRole = typeof user.role === "string" ? user.role.toLowerCase().trim() : "";
  const normalizedRole = rawRole === "admin" || rawRole === "administrator"
    ? "shopping-admin"
    : rawRole;

  if (!WAITER_ALLOWED_ROLES.includes(normalizedRole as WaiterRole)) {
    throw new Error("permission-denied");
  }

  const effectiveRole = normalizedRole === "operations" ? "operation" : (normalizedRole as WaiterRole);

  const canAccessAllShoppings =
    effectiveRole === "shopping-admin" ||
    effectiveRole === "operation" ||
    effectiveRole === "operator";
  const shoppingId = user.shoppingId ? String(user.shoppingId) : null;
  if (!shoppingId && !canAccessAllShoppings) throw new Error("shopping-not-set");

  const name = user.name || (effectiveRole === "shopping-admin" ? "Administrador" : "Garçom");
  return {
    uid,
    name,
    shoppingId,
    user,
    role: effectiveRole,
    canAccessAllShoppings
  };
}

export const getUserOrdersHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const uid = (req as any).auth?.uid || req.headers["x-mock-uid"];
    const sessionHeader = req.headers["x-session-id"];
    const sessionId =
      (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ||
      (typeof req.query?.sessionId === "string" ? req.query.sessionId : undefined);

    let snap;
    if (uid) {
      snap = await db.collection("orders").where("customerId", "==", uid).orderBy("createdAt", "desc").limit(50).get();
    } else if (sessionId) {
      snap = await db.collection("orders").where("customerSessionId", "==", sessionId).orderBy("createdAt", "desc").limit(50).get();
    } else {
      throw new Error("auth required");
    }
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
  res.status(resp.success ? 200 : 401).json(resp);
}));

export const getOrdersHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId required");
    let q = db.collection("orders").where("storeId","==",storeId);
    const statuses = Array.isArray(req.query.status) ? req.query.status : (req.query.status ? [req.query.status] : []);
    if (statuses.length) q = q.where("status","in", statuses.slice(0,10));
    q = q.orderBy("createdAt","desc");
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    const snap = await q.limit(limit).get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getOrderHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const orderId = String(req.query.orderId || "");
    if (!orderId) throw new Error("orderId required");
    const d = await db.collection("orders").doc(orderId).get();
    if (!d.exists) throw new Error("order-not-found");
    return { id: d.id, ...d.data() };
  });
  res.status(resp.success ? 200 : 404).json(resp);
}));

export const createOrderHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const payload = createOrderSchema.parse(req.body || {});
    const normalizedItems = await Promise.all(
      payload.items.map(async (item) => {
        const notes = pickText(item.notes, (item as any).observation, (item as any).observacao) || undefined;
        const descriptionFromPayload = pickText(
          (item as any).description,
          (item as any).productDescription,
          (item as any).desc,
          (item as any).details
        );
        if (descriptionFromPayload) {
          return {
            ...item,
            description: descriptionFromPayload,
            notes,
          };
        }
        const productId = pickText(item.productId, item.itemId);
        if (!productId) {
          return { ...item, notes };
        }
        const menuDescription = await resolveMenuItemDescription(payload.storeId, productId);
        return {
          ...item,
          ...(menuDescription ? { description: menuDescription } : {}),
          notes,
        };
      })
    );
    const { subtotal, fee, total } = calcTotals(normalizedItems);
    const customerId = (req as any).auth?.uid || req.headers["x-mock-uid"] || null;
    const sessionHeader = req.headers["x-session-id"];
    const customerSessionId =
      payload.sessionId ||
      (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ||
      null;
    const orderNumber = Math.floor(100000 + Math.random() * 900000).toString();
    const storeSnap = await db.collection("stores").doc(payload.storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const storeData = storeSnap.data() || {};
    assertStoreCanReceiveOrders(storeData);
    const storeName = storeData.displayName || storeData.storeName || storeData.name || "Loja";
    const shoppingId = storeData.shoppingId || null;
    const shoppingName = storeData.shoppingName || null;
    const doc = {
      storeId: payload.storeId,
      storeName,
      shoppingId,
      shoppingName,
      orderNumber,
      status: 'pending',
      tableNumber: payload.tableNumber,
      chairId: payload.chairId || null,
      items: normalizedItems,
      subtotal, fee, total,
      paymentMethod: payload.paymentMethod,
      estimatedTime: 0,
      customerId,
      customerSessionId,
      customerName: payload.customerName || null,
      notes: payload.notes || null,
      assignedWaiterId: null,
      assignedWaiterName: null,
      assignedWaiterAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    const ref = await db.collection("orders").add(doc);
    return { id: ref.id, ...doc };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const updateOrderStatusHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { orderId, status, cancelReason, estimatedTime } = updateOrderStatusSchema.parse(req.body || {});
    const ref = db.collection("orders").doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("order-not-found");
    const from = snap.get("status");
    const allowed: Record<string, string[]> = {
      'pending': ['accepted','cancelled'],
      'accepted': ['preparing','cancelled'],
      'preparing': ['ready','cancelled'],
      'ready': ['on-the-way','delivered','cancelled'],
      'on-the-way': ['delivered','cancelled'],
      'delivered': [],
      'cancelled': []
    };
    if (!allowed[from]?.includes(status)) throw new Error("invalid-transition");
    const tsField = statusTimestampField(status);
    const updates: Record<string, any> = {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      [tsField]: FieldValue.serverTimestamp(),
      cancelReason: status === 'cancelled' ? (cancelReason || 'Sem motivo') : FieldValue.delete()
    };
    if (estimatedTime !== undefined) {
      updates.estimatedTime = estimatedTime;
    }
    await ref.update(updates);
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const cancelOrderHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const { orderId, reason } = req.body || {};
    if (!orderId) throw new Error("orderId required");
    const ref = db.collection("orders").doc(String(orderId));
    await ref.update({ status: 'cancelled', cancelReason: reason || 'Sem motivo', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getActiveOrdersHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const active = ['pending','accepted','preparing','ready','on-the-way'];
    const snap = await db.collection("orders").where("storeId","==",storeId).where("status","in",active).orderBy("createdAt","desc").get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getOrderHistoryHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const hist = ['delivered','cancelled'];
    const snap = await db.collection("orders").where("storeId","==",storeId).where("status","in",hist).orderBy("createdAt","desc").limit(100).get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getOrdersStatsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const storeId = String(req.query.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const snap = await db.collection("orders").where("storeId","==",storeId).get();
    const items = snap.docs.map(d => d.data() as any);
    const totalOrders = items.length;
    const revenue = items.filter(o=>o.status==='delivered').reduce((acc,o)=>acc+Number(o.total||0),0);
    const pending = items.filter(o=>['pending','accepted','preparing','ready','on-the-way'].includes(o.status)).length;
    return { totalOrders, revenue, pending };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

import { onCall } from "firebase-functions/v2/https";

export const getUserOrders = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || (req.data && (req.data as any).uid);
    if (!uid) throw new Error("auth required");
    const snap = await db.collection("orders").where("customerId","==",uid).orderBy("createdAt","desc").limit(50).get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
});

export const getOrders = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    let q = db.collection("orders").where("storeId","==",storeId);
    const statuses = Array.isArray(req.data?.status) ? req.data?.status : (req.data?.status ? [req.data?.status] : []);
    if (statuses.length) q = q.where("status","in", statuses.slice(0,10));
    q = q.orderBy("createdAt","desc");
    const limit = Math.min(100, Number(req.data?.limit ?? 50));
    const snap = await q.limit(limit).get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
});

export const getOrder = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const orderId = String(req.data?.orderId || "");
    if (!orderId) throw new Error("orderId required");
    const d = await db.collection("orders").doc(orderId).get();
    if (!d.exists) throw new Error("order-not-found");
    return { id: d.id, ...d.data() };
  });
});

export const createOrder = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const payload = req.data as any;
    if (!payload?.storeId || !Array.isArray(payload.items) || !payload.items.length) throw new Error("invalid-payload");
    const subtotal = (payload.items as any[]).reduce((acc, it) => acc + (Number(it.price) * Number(it.qty)), 0);
    const fee = +(subtotal * 0.08).toFixed(2);
    const total = +(subtotal + fee).toFixed(2);
    const customerId = req.auth?.uid || null;
    const orderNumber = Math.floor(100000 + Math.random() * 900000).toString();
    const storeSnap = await db.collection("stores").doc(String(payload.storeId)).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const storeData = storeSnap.data() || {};
    assertStoreCanReceiveOrders(storeData);
    const storeName = storeData.displayName || storeData.storeName || storeData.name || "Loja";
    const shoppingId = storeData.shoppingId || null;
    const shoppingName = storeData.shoppingName || null;
    const doc = {
      storeId: payload.storeId,
      storeName,
      shoppingId,
      shoppingName,
      orderNumber,
      status: 'pending',
      tableNumber: payload.tableNumber,
      chairId: payload.chairId || null,
      items: payload.items,
      subtotal, fee, total,
      paymentMethod: payload.paymentMethod,
      estimatedTime: 0,
      customerId,
      notes: payload.notes || null,
      assignedWaiterId: null,
      assignedWaiterName: null,
      assignedWaiterAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    const ref = await db.collection("orders").add(doc);
    return { id: ref.id, ...doc };
  });
});

export const updateOrderStatus = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { orderId, status, cancelReason, estimatedTime } = updateOrderStatusSchema.parse(req.data || {});
    if (!orderId || !status) throw new Error("invalid-payload");
    const ref = db.collection("orders").doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("order-not-found");
    const from = snap.get("status");
    const allowed: Record<string, string[]> = {
      'pending': ['accepted','cancelled'],
      'accepted': ['preparing','cancelled'],
      'preparing': ['ready','cancelled'],
      'ready': ['on-the-way','delivered','cancelled'],
      'on-the-way': ['delivered','cancelled'],
      'delivered': [],
      'cancelled': []
    };
    if (!allowed[from]?.includes(status)) throw new Error("invalid-transition");
    const tsField = status === 'accepted' ? 'acceptedAt' :
                    status === 'preparing' ? 'preparingAt' :
                    status === 'ready' ? 'readyAt' :
                    status === 'on-the-way' ? 'onTheWayAt' :
                    status === 'delivered' ? 'deliveredAt' :
                    status === 'cancelled' ? 'cancelledAt' : 'updatedAt';
    const updates: Record<string, any> = {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      [tsField]: FieldValue.serverTimestamp(),
      cancelReason: status === 'cancelled' ? (cancelReason || 'Sem motivo') : FieldValue.delete()
    };
    if (estimatedTime !== undefined) {
      updates.estimatedTime = estimatedTime;
    }
    await ref.update(updates);
    return { ok: true };
  });
});

export const cancelOrder = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const { orderId, reason } = req.data as any;
    if (!orderId) throw new Error("orderId required");
    const ref = db.collection("orders").doc(String(orderId));
    await ref.update({ status: 'cancelled', cancelReason: reason || 'Sem motivo', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

export const getActiveOrders = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const active = ['pending','accepted','preparing','ready','on-the-way'];
    const snap = await db.collection("orders").where("storeId","==",storeId).where("status","in",active).orderBy("createdAt","desc").get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
});

export const getOrderHistory = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const hist = ['delivered','cancelled'];
    const snap = await db.collection("orders").where("storeId","==",storeId).where("status","in",hist).orderBy("createdAt","desc").limit(100).get();
    return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  });
});

export const getOrdersStats = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const snap = await db.collection("orders").where("storeId","==",storeId).get();
    const items = snap.docs.map(d => d.data() as any);
    const totalOrders = items.length;
    const revenue = items.filter(o=>o.status==='delivered').reduce((acc,o)=>acc+Number(o.total||0),0);
    const pending = items.filter(o=>['pending','accepted','preparing','ready','on-the-way'].includes(o.status)).length;
    return { totalOrders, revenue, pending };
  });
});


export const getOrdersByStatus = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    if (!storeId) throw new Error("storeId required");
    const statuses = Array.isArray(req.data?.status) ? req.data?.status : [];
    let q = db.collection("orders").where("storeId","==",storeId);
    if (statuses.length) q = q.where("status","in", statuses.slice(0,10));
    q = q.orderBy("createdAt","desc");
    const snap = await q.limit(100).get();
    return { items: snap.docs.map(d=>({ id: d.id, ...d.data() })) };
  });
});

export const getOrdersByTable = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const storeId = String(req.data?.storeId || (req.auth?.token as any)?.storeId || "");
    const tableNumber = Number(req.data?.tableNumber || 0);
    if (!storeId || !tableNumber) throw new Error("storeId/tableNumber required");
    const snap = await db.collection("orders")
      .where("storeId","==",storeId)
      .where("tableNumber","==",tableNumber)
      .orderBy("createdAt","desc")
      .limit(50).get();
    return { items: snap.docs.map(d=>({ id: d.id, ...d.data() })) };
  });
});

export const listWaiterOrders = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const context = await getWaiterContext(req.auth?.uid);
    const readyQuery = db.collection("orders")
      .where("shoppingId","==",context.shoppingId)
      .where("status","in",["ready","on-the-way"])
      .orderBy("createdAt","desc")
      .limit(200);

    const deliveredQuery = db.collection("orders")
      .where("assignedWaiterId","==",context.uid)
      .where("status","==","delivered")
      .orderBy("deliveredAt","desc")
      .limit(100);

    const [readySnap, deliveredSnap] = await Promise.all([readyQuery.get(), deliveredQuery.get()]);

    const merged = new Map<string, any>();
    readySnap.docs.forEach((doc) => {
      merged.set(doc.id, { id: doc.id, ...doc.data() });
    });
    deliveredSnap.docs.forEach((doc) => {
      merged.set(doc.id, { id: doc.id, ...doc.data() });
    });

    const getMillis = (input: any): number => {
      if (!input) return 0;
      if (typeof input.toMillis === "function") return input.toMillis();
      if (typeof input.toDate === "function") return input.toDate().getTime();
      if (input instanceof Date) return input.getTime();
      if (typeof input === "number") return input;
      if (typeof input === "string") {
        const parsed = Date.parse(input);
        return Number.isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    const items = Array.from(merged.values()).sort((a, b) => {
      const aTime = getMillis(a.updatedAt) || getMillis(a.createdAt);
      const bTime = getMillis(b.updatedAt) || getMillis(b.createdAt);
      return bTime - aTime;
    });

    return { items };
  });
});

export const claimOrderForWaiter = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const context = await getWaiterContext(req.auth?.uid);
    const orderId = String(req.data?.orderId || "").trim();
    if (!orderId) throw new Error("orderId-required");

    await db.runTransaction(async (tx) => {
      const ref = db.collection("orders").doc(orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("order-not-found");
      const data = snap.data() || {};
      const orderShoppingId = data.shoppingId || null;
      const canOverride = context.canAccessAllShoppings;
      if (!canOverride && orderShoppingId !== context.shoppingId) throw new Error("permission-denied");
      if (data.status !== "ready") throw new Error("order-not-ready");
      if (data.assignedWaiterId && data.assignedWaiterId !== context.uid && !canOverride) throw new Error("order-already-assigned");

      tx.update(ref, {
        status: "on-the-way",
        assignedWaiterId: context.uid,
        assignedWaiterName: context.name,
        assignedWaiterAt: FieldValue.serverTimestamp(),
        onTheWayAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    const updatedSnap = await db.collection("orders").doc(orderId).get();
    return { id: updatedSnap.id, ...updatedSnap.data() };
  });
});

export const completeOrderDelivery = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const context = await getWaiterContext(req.auth?.uid);
    const orderId = String(req.data?.orderId || "").trim();
    if (!orderId) throw new Error("orderId-required");

    await db.runTransaction(async (tx) => {
      const ref = db.collection("orders").doc(orderId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("order-not-found");
      const data = snap.data() || {};
      const orderShoppingId = data.shoppingId || null;
      const canOverride = context.canAccessAllShoppings;
      if (!canOverride && orderShoppingId !== context.shoppingId) throw new Error("permission-denied");
    if (!data.assignedWaiterId) throw new Error("order-not-assigned");
    if (data.assignedWaiterId !== context.uid && !canOverride) throw new Error("order-assigned-other");
    if (data.status !== "on-the-way") throw new Error("order-not-ready-for-delivery");

      tx.update(ref, {
        status: "delivered",
        deliveredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    const updatedSnap = await db.collection("orders").doc(orderId).get();
    return { id: updatedSnap.id, ...updatedSnap.data() };
  });
});
