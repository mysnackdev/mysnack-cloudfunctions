import { rtdb } from "./admin.js";

const ORDER_STATUS_KEYS = [
  "pending",
  "accepted",
  "preparing",
  "ready",
  "on-the-way",
  "delivered",
  "cancelled"
] as const;

type OrderStatusKey = typeof ORDER_STATUS_KEYS[number];

type OrderRealtimePayload = {
  orderId: string;
  orderNumber: string;
  status: OrderStatusKey;
  storeId: string;
  storeName?: string | null;
  shoppingId?: string | null;
  shoppingName?: string | null;
  tableNumber?: number | string | null;
  customerName?: string | null;
  customerId?: string | null;
  customerSessionId?: string | null;
  total?: number | null;
  paymentMethod?: string | null;
  estimatedTime?: number | null;
  assignedWaiterId?: string | null;
  assignedWaiterName?: string | null;
  assignedWaiterAt?: number | null;
  items: Array<{
    id: string | null;
    itemId?: string | null;
    productId?: string | null;
    name: string;
    description?: string | null;
    qty: number;
    price?: number | null;
    image?: string | null;
    notes?: string | null;
  }>;
  createdAt: number;
  updatedAt: number;
};

const INITIAL_COUNTS: Record<OrderStatusKey, number> = ORDER_STATUS_KEYS.reduce(
  (acc, key) => {
    acc[key] = 0;
    return acc;
  },
  {} as Record<OrderStatusKey, number>
);

const statusOrDefault = (value: any): OrderStatusKey => {
  const normalized = typeof value === "string" ? value : "";
  return ORDER_STATUS_KEYS.includes(normalized as OrderStatusKey) ? (normalized as OrderStatusKey) : "pending";
};

const timestampToMillis = (value: any): number => {
  if (!value) return Date.now();
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  }
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return Date.now();
};

const parseQuantity = (value: any): number => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric);
  }
  return 1;
};

const parsePrice = (item: any): number | null => {
  const candidates = [
    item.price,
    item.unitPrice,
    item.unit_price,
    item.basePrice,
    item.base_price,
    item.total,
    item.subtotal,
    item.amount,
    item.value,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

const looksLikeUsableImageRef = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("gs://") ||
    trimmed.includes("/") ||
    trimmed.includes(".")
  ) {
    return true;
  }
  return false;
};

const resolveItemImage = (input: any, seen: WeakSet<object> = new WeakSet()): string | null => {
  if (!input) return null;

  if (typeof input === "string") {
    const trimmed = input.trim();
    return looksLikeUsableImageRef(trimmed) ? trimmed : null;
  }

  if (Array.isArray(input)) {
    for (const entry of input) {
      const resolved = resolveItemImage(entry, seen);
      if (resolved) return resolved;
    }
    return null;
  }

  if (typeof input === "object") {
    if (seen.has(input)) return null;
    seen.add(input);

    const candidates = [
      (input as any).downloadURL,
      (input as any).downloadUrl,
      (input as any).image,
      (input as any).imageUrl,
      (input as any).imageURL,
      (input as any).photo,
      (input as any).picture,
      (input as any).thumbnail,
      (input as any).thumb,
      (input as any).url,
      (input as any).src,
      (input as any).path,
      (input as any).fullPath,
      (input as any).file,
      (input as any).media,
      (input as any).images,
      (input as any).main,
      (input as any).primary,
      (input as any).value,
    ];

    for (const candidate of candidates) {
      const resolved = resolveItemImage(candidate, seen);
      if (resolved) return resolved;
    }

    for (const value of Object.values(input)) {
      const resolved = resolveItemImage(value, seen);
      if (resolved) return resolved;
    }
  }

  return null;
};

const resolveIdentifiers = (item: any, fallbackIndex: number): { persistedId: string; itemId: string | null; productId: string | null } => {
  const itemIdCandidates = [
    item.itemId,
    item.itemID,
    item.lineId,
    item.lineID,
    item.id,
  ];

  let persistedId: string | null = null;
  let itemId: string | null = null;

  for (const candidate of itemIdCandidates) {
    if (candidate == null) continue;
    const str = String(candidate).trim();
    if (!str) continue;
    if (!persistedId) persistedId = str;
    if (!itemId) itemId = str;
    if (persistedId && itemId) break;
  }

  const productCandidates = [
    item.productId,
    item.productID,
    item.menuItemId,
    item.menuItemID,
    item.productReferenceId,
    item.productReferenceID,
    item.catalogItemId,
    item.catalogItemID,
    item.sku,
    item.code,
  ];

  let productId: string | null = null;
  for (const candidate of productCandidates) {
    if (candidate == null) continue;
    const str = String(candidate).trim();
    if (str) {
      productId = str;
      break;
    }
  }

  if (!persistedId) {
    persistedId = productId || String(fallbackIndex);
  }

  if (!itemId && productId) {
    itemId = productId;
  }

  return {
    persistedId,
    itemId,
    productId,
  };
};

const buildOrderRealtimePayload = (orderId: string, data: Record<string, any>): OrderRealtimePayload => {
  const items = Array.isArray(data.items)
    ? data.items.map((item: any, index: number) => ({
        ...(() => {
          const identifiers = resolveIdentifiers(item, index);
          const qty = parseQuantity(item.qty ?? item.quantity ?? item.amount ?? 1);
          const price = parsePrice(item);
          const image = resolveItemImage(item);
          return {
            id: identifiers.persistedId,
            itemId: identifiers.itemId,
            productId: identifiers.productId,
            name: String(item.name || item.title || "Item"),
            description: item.description != null ? String(item.description) : null,
            qty,
            price,
            image,
            notes: item.notes != null ? String(item.notes) : null,
          };
        })()
      }))
    : [];

  return {
    orderId,
    orderNumber: String(data.orderNumber || orderId),
    status: statusOrDefault(data.status),
    storeId: String(data.storeId || ""),
    storeName: data.storeName || data.store?.name || null,
    shoppingId: data.shoppingId || null,
    shoppingName: data.shoppingName || null,
    tableNumber: data.tableNumber ?? data.table ?? null,
    customerName: data.customerName || data.customer?.name || null,
    customerId: data.customerId ? String(data.customerId) : null,
    customerSessionId: data.customerSessionId ? String(data.customerSessionId) : null,
    total: data.total != null ? Number(data.total) : null,
    paymentMethod: data.paymentMethod || null,
    estimatedTime: data.estimatedTime != null ? Number(data.estimatedTime) : null,
    assignedWaiterId: data.assignedWaiterId || null,
    assignedWaiterName: data.assignedWaiterName || null,
    assignedWaiterAt: data.assignedWaiterAt ? timestampToMillis(data.assignedWaiterAt) : null,
    items,
    createdAt: timestampToMillis(data.createdAt),
    updatedAt: Date.now()
  };
};

type SyncOptions = {
  previousStatus?: string | null;
  isNew?: boolean;
};

function updateSummaryCounts(
  counts: Record<string, number>,
  nextStatus: OrderStatusKey,
  previousStatus: OrderStatusKey | null,
  isNew: boolean
) {
  if (isNew) {
    counts[nextStatus] = (counts[nextStatus] || 0) + 1;
    return;
  }
  if (previousStatus && previousStatus !== nextStatus) {
    counts[previousStatus] = Math.max(0, (counts[previousStatus] || 0) - 1);
    counts[nextStatus] = (counts[nextStatus] || 0) + 1;
  }
}

async function syncScopeRealtime(
  scope: "store" | "shopping",
  scopeId: string,
  payload: OrderRealtimePayload,
  previousStatus: OrderStatusKey,
  nextStatus: OrderStatusKey,
  isNew: boolean,
  statusChanged: boolean
) {
  const basePath = scope === "store" ? "storeOrders" : "shoppingOrders";
  const metaPath = scope === "store" ? "storeOrdersMeta" : "shoppingOrdersMeta";
  const orderRef = rtdb.ref(`${basePath}/${scopeId}/${payload.orderId}`);
  await orderRef.set(payload);

  const metaRef = rtdb.ref(`${metaPath}/${scopeId}`);
  await metaRef.transaction((current) => {
    const base = {
      counts: { ...INITIAL_COUNTS },
      updatedAt: Date.now(),
      lastEvent: null as null | Record<string, any>
    };

    if (!current) {
      updateSummaryCounts(base.counts, nextStatus, statusChanged ? previousStatus : null, isNew);
      base.lastEvent = {
        type: isNew ? "created" : statusChanged ? "status" : "updated",
        orderId: payload.orderId,
        orderNumber: payload.orderNumber,
        status: nextStatus,
        previousStatus: statusChanged ? previousStatus : null,
        tableNumber: payload.tableNumber ?? null,
        total: payload.total ?? null,
        storeId: payload.storeId,
        storeName: payload.storeName || null,
        shoppingId: payload.shoppingId || null,
        timestamp: Date.now()
      };
      base.updatedAt = Date.now();
      return base;
    }

    const counts = { ...INITIAL_COUNTS, ...(current.counts || {}) };
    updateSummaryCounts(counts, nextStatus, statusChanged ? previousStatus : null, isNew);

    return {
      counts,
      updatedAt: Date.now(),
      lastEvent: {
        type: isNew ? "created" : statusChanged ? "status" : "updated",
        orderId: payload.orderId,
        orderNumber: payload.orderNumber,
        status: nextStatus,
        previousStatus: statusChanged ? previousStatus : null,
        tableNumber: payload.tableNumber ?? null,
        total: payload.total ?? null,
        storeId: payload.storeId,
        storeName: payload.storeName || null,
        shoppingId: payload.shoppingId || null,
        timestamp: Date.now()
      }
    };
  });
}

async function syncCustomerRealtime(payload: OrderRealtimePayload) {
  const targets: Array<{ path: string }> = [];

  if (payload.customerId) {
    targets.push({ path: `customerOrders/users/${payload.customerId}` });
  }
  if (payload.customerSessionId) {
    targets.push({ path: `customerOrders/sessions/${payload.customerSessionId}` });
  }

  await Promise.all(
    targets.map(async ({ path }) => {
      const orderRef = rtdb.ref(`${path}/${payload.orderId}`);
      await orderRef.set(payload);
    }),
  );
}

export async function syncOrderToRealtime(
  orderId: string,
  data: Record<string, any>,
  options?: SyncOptions
) {
  const storeId = String(data?.storeId || "");
  if (!storeId) return;

  const payload = buildOrderRealtimePayload(orderId, data);
  const previousStatus = statusOrDefault(options?.previousStatus);
  const isNew = Boolean(options?.isNew);
  const nextStatus = payload.status;
  const statusChanged = !isNew && (previousStatus !== nextStatus);

  await syncScopeRealtime("store", storeId, payload, previousStatus, nextStatus, isNew, statusChanged);

  if (payload.shoppingId) {
    await syncScopeRealtime("shopping", String(payload.shoppingId), payload, previousStatus, nextStatus, isNew, statusChanged);
  }

  await syncCustomerRealtime(payload);
}
