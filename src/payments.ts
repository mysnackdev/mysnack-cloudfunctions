import { onRequest, onCall } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import crypto from "crypto";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./shared/admin.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";
import {
  createSubaccount,
  createSubaccountAccessToken,
  getSubaccount,
  createCustomer,
  updateCustomer,
  createCharge,
  getCharge,
  getPixQrCode,
  getAccountStatus,
  getAccountCommercialInfo,
  updateAccountCommercialInfo,
  listAccountDocuments,
  submitAccountDocumentFile,
  getAccountDocumentFile,
  updateAccountDocumentFile,
  deleteAccountDocumentFile,
  getAccountNumber,
  listWallets,
  getBalance,
  getMainBalance,
  listFinancialTransactions,
  verifyWebhookToken,
  updateCharge,
  listWebhooks,
  createWebhook,
  updateWebhook,
  tokenizeCreditCard
} from "./payments/asaas.js";

const PLATFORM_FEE_RATE = 0.08;
const PAYMENT_FEE_CONFIG: Record<string, { fixedFeeCents: number; cardFeeRate: number }> = {
  pix: { fixedFeeCents: 99, cardFeeRate: 0 },
  credit: { fixedFeeCents: 99, cardFeeRate: 0.0299 },
  debit: { fixedFeeCents: 35, cardFeeRate: 0.0189 }
};
const WEBHOOK_PAYMENT_EVENTS = [
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_APPROVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_CANCELED",
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK",
  "PAYMENT_EXPIRED"
];
const WEBHOOK_PAID_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_APPROVED"]);
const WEBHOOK_FAILED_EVENTS = new Set(["PAYMENT_OVERDUE", "PAYMENT_CANCELED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK"]);
const TOKEN_SECRET = normalizeText("$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjFmNGUyZDMwLTcwNDAtNDEzNy1iMmJjLWZkMTI3NjhmYThlMjo6JGFhY2hfY2Y0ZmNjMGEtM2Y1MC00OGMxLWIzODEtZjFiYTM0ZTk5ZDlm");

const callableOptions = {
  region: "southamerica-east1",
  cors: true
} as const;

type StoreTotals = {
  storeId: string;
  storeName: string;
  items: any[];
  subtotalCents: number;
  walletId: string;
  platformFeeRate?: number;
};

type PaymentNotificationStatus = "PAID" | "EXPIRED" | "FAILED";

const toCents = (value: number) => Math.round(value * 100);
const fromCents = (value: number) => Number((value / 100).toFixed(2));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function normalizePlatformFeeRate(value: any, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(numeric, 0, 0.5);
}

export function resolvePaymentFeeConfig(paymentMethod: string | null | undefined) {
  const method = normalizeText(paymentMethod || "pix").toLowerCase();
  return PAYMENT_FEE_CONFIG[method] || PAYMENT_FEE_CONFIG.pix;
}

function normalizeText(value: any): string {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function normalizeCpfCnpj(value: any): string | null {
  const raw = normalizeText(value).replace(/\D/g, "");
  if (raw.length === 11 || raw.length === 14) return raw;
  return null;
}

function normalizeAccountNumber(value: any): Record<string, any> | null {
  if (value == null) return null;
  if (typeof value === "object") return value;
  const text = normalizeText(value);
  if (!text) return null;
  return { accountNumber: text };
}

function toMillis(value: any): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value?.toMillis === "function") return value.toMillis();
  return null;
}

function isFresh(value: any, ttlMs: number): boolean {
  const millis = toMillis(value);
  if (!millis) return false;
  return Date.now() - millis <= ttlMs;
}

function pickText(...values: any[]): string | null {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return null;
}

function pickValue<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function headerToString(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  if (value == null) return "";
  return String(value);
}

function isLocalhostRequest(req: Request): boolean {
  const sources = [
    headerToString(req.headers.origin),
    headerToString(req.headers.host),
    headerToString(req.headers.referer),
    headerToString(req.headers["x-forwarded-host"])
  ].map((entry) => entry.toLowerCase());
  return sources.some((entry) => entry.includes("localhost") || entry.includes("127.0.0.1"));
}

export function normalizeIntentItem(raw: any): Record<string, any> {
  const item = typeof raw === "object" && raw ? raw : {};
  const itemId = pickText(item.itemId, item.itemID, item.id, item.productId, item.productID);
  const productId = pickText(item.productId, item.productID, item.itemId, item.itemID, item.id);
  const name = pickText(item.name, item.title, item.label) || "Item";
  const notes = pickText(item.notes, item.observation, item.observacao);
  const description = pickText(item.description, item.productDescription, item.desc, item.details);
  const qtyRaw = Number(item.qty ?? item.quantity ?? item.amount ?? 1);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : 1;
  const priceRaw = Number(item.price ?? 0);
  const price = Number.isFinite(priceRaw) ? priceRaw : 0;

  return {
    ...item,
    ...(itemId ? { itemId } : {}),
    ...(productId ? { productId } : {}),
    name,
    qty,
    price,
    ...(notes ? { notes } : {}),
    ...(description ? { description } : {}),
  };
}

async function resolveMenuItemDescription(
  storeId: string,
  productId: string,
  cache: Map<string, Promise<string | null>>
): Promise<string | null> {
  const normalizedStoreId = normalizeText(storeId);
  const normalizedProductId = normalizeText(productId);
  if (!normalizedStoreId || !normalizedProductId) return null;

  const cacheKey = `${normalizedStoreId}:${normalizedProductId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const lookup = (async () => {
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
  })();

  cache.set(cacheKey, lookup);
  return lookup;
}

function normalizeBalancePayload(balance: any): { available: number; blocked?: number; total?: number } | null {
  if (!balance) return null;
  if (typeof balance === "number") {
    return { available: balance, total: balance };
  }
  if (typeof balance === "object") {
    const available = Number(
      pickValue(balance.available, balance.balance, balance.value, balance.total, 0)
    );
    const blocked = balance.blocked != null ? Number(balance.blocked) : undefined;
    const total = blocked != null ? available + blocked : available;
    if (Number.isFinite(available)) {
      return { available, blocked: Number.isFinite(blocked as number) ? blocked : undefined, total };
    }
  }
  return null;
}

function resolveStoreApiKey(store: any): string | null {
  const candidate =
    store?.asaasAccountData?.apiKeyEnc ||
    store?.asaasAccountData?.apiKey ||
    store?.asaasAccountData?.accessToken ||
    store?.asaas?.apiKey ||
    store?.asaas?.accountData?.apiKey ||
    store?.asaasApiKey ||
    store?.asaasToken ||
    null;
  const normalized = normalizeText(candidate);
  if (!normalized) return null;
  if (store?.asaasAccountData?.apiKeyEnc) {
    const decrypted = decryptToken(normalized);
    return decrypted || null;
  }
  return normalized || null;
}

export function computeSplitCents(
  storeTotals: StoreTotals[],
  totalCents: number,
  options?: { fixedFeeCents?: number; cardFeeRate?: number }
) {
  const fixedFeeCents = Math.max(0, Number(options?.fixedFeeCents ?? 0));
  const cardFeeRate = Math.max(0, Number(options?.cardFeeRate ?? 0));

  let platformShareCents = storeTotals.reduce((acc, store) => {
    const rate = normalizePlatformFeeRate(store.platformFeeRate, PLATFORM_FEE_RATE);
    return acc + Math.round(store.subtotalCents * rate);
  }, 0);
  platformShareCents += fixedFeeCents;
  platformShareCents = Math.min(platformShareCents, totalCents);

  let platformFeeAllocated = 0;
  let storeNetAllocated = 0;
  let cardFeeAllocated = 0;
  const storeSplits = storeTotals.map((store, index) => {
    const isLast = index === storeTotals.length - 1;
    const rate = normalizePlatformFeeRate(store.platformFeeRate, PLATFORM_FEE_RATE);
    const storePlatformFee = isLast
      ? Math.max(0, platformShareCents - fixedFeeCents - platformFeeAllocated)
      : Math.round(store.subtotalCents * rate);
    platformFeeAllocated += storePlatformFee;

    const storeCardFee = Math.round(store.subtotalCents * cardFeeRate);
    cardFeeAllocated += storeCardFee;
    const storeNet = Math.max(0, store.subtotalCents - storeCardFee);
    storeNetAllocated += storeNet;

    return {
      storeId: store.storeId,
      walletId: store.walletId,
      subtotalCents: store.subtotalCents,
      platformFeeCents: storePlatformFee,
      cardFeeCents: storeCardFee,
      shareCents: storeNet,
      feeShareCents: 0,
      fixedValueCents: storeNet
    };
  });

  let fixedTotal = storeSplits.reduce((acc, split) => acc + split.fixedValueCents, 0);
  if (fixedTotal > totalCents) {
    const scale = totalCents / fixedTotal;
    let scaledAllocated = 0;
    storeSplits.forEach((split, index) => {
      const isLast = index === storeSplits.length - 1;
      const scaled = isLast ? totalCents - scaledAllocated : Math.floor(split.fixedValueCents * scale);
      split.fixedValueCents = Math.max(0, scaled);
      scaledAllocated += split.fixedValueCents;
    });
    fixedTotal = storeSplits.reduce((acc, split) => acc + split.fixedValueCents, 0);
  }

  return {
    storeSplits,
    platform: {
      platformShareCents,
      feeShareCents: fixedFeeCents,
      expectedPlatformNetCents: platformShareCents - fixedFeeCents,
      expectedPlatformRemainderCents: totalCents - (fixedTotal + platformShareCents)
    },
    ledger: {
      totalCents,
      platformShareCents,
      fixedFeeCents,
      cardFeeRate,
      cardFeeAllocatedCents: cardFeeAllocated,
      storeNetAllocatedCents: storeNetAllocated,
      fixedTotalCents: fixedTotal
    }
  };
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function hashPayload(payload: any): string {
  const raw = JSON.stringify(payload || {});
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function getWebhookEventKey(payload: any): string {
  const eventId = String(payload?.id || payload?.eventId || "");
  return eventId || hashPayload(payload);
}

export function getWebhookEventName(payload: any): string {
  return String(payload?.event || payload?.type || "").toUpperCase();
}

function deriveKey(secret: string) {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptToken(token: string): { apiKeyEnc: string } {
  if (!TOKEN_SECRET) return { apiKeyEnc: token };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(TOKEN_SECRET), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { apiKeyEnc: Buffer.concat([iv, tag, encrypted]).toString("base64") };
}

function decryptToken(tokenEnc: string): string | null {
  if (!TOKEN_SECRET) return tokenEnc;
  try {
    const raw = Buffer.from(tokenEnc, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(TOKEN_SECRET), iv);
    decipher.setAuthTag(tag);
    const decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return decoded;
  } catch {
    return null;
  }
}

async function writeAsaasAudit(action: string, payload: Record<string, any>) {
  await db.collection("asaasAuditLogs").add({
    action,
    payload,
    createdAt: FieldValue.serverTimestamp()
  });
}

function getIsoDateKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

async function recordTokenizeFailure(payload: {
  uid: string | null;
  reason: string;
  message: string;
  code?: string | number | null;
  details?: any;
  meta?: Record<string, any>;
}) {
  const dateKey = getIsoDateKey();
  const docRef = db.collection("asaasTokenizeFailures").doc(dateKey);
  const reasonKey = payload.reason || "unknown";
  await docRef.set(
    {
      date: dateKey,
      count: FieldValue.increment(1),
      reasons: {
        [reasonKey]: FieldValue.increment(1)
      },
      lastErrorAt: FieldValue.serverTimestamp(),
      lastErrorMessage: payload.message,
      lastErrorCode: payload.code || null,
      lastMeta: payload.meta || null
    },
    { merge: true }
  );
  await writeAsaasAudit("tokenize-failed", {
    uid: payload.uid,
    reason: reasonKey,
    message: payload.message,
    code: payload.code || null,
    details: payload.details || null,
    meta: payload.meta || null
  });
}

const paymentNotificationCopy: Record<PaymentNotificationStatus, { title: string; message: string }> = {
  PAID: {
    title: "Pagamento confirmado",
    message: "Recebemos o pagamento. Estamos preparando seu pedido."
  },
  EXPIRED: {
    title: "Pagamento expirado",
    message: "O pagamento expirou. Gere um novo pagamento para concluir o pedido."
  },
  FAILED: {
    title: "Pagamento cancelado",
    message: "O pagamento não foi confirmado. Tente novamente."
  }
};

const mapProfileErrorMessage = (
  message: string,
  context: "payment" | "card" = "card",
  options: { allowDocument?: boolean } = {}
) => {
  const normalized = String(message || "").toLowerCase();
  const allowDocument = options.allowDocument !== false;
  if (normalized.includes("missing-email") || normalized.includes("invalid-email") || normalized.includes("email")) {
    return context === "payment"
      ? "Atualize seu e-mail no cadastro antes de pagar."
      : "Atualize seu e-mail no cadastro antes de salvar o cartão.";
  }
  if (allowDocument && (normalized.includes("missing-document") || normalized.includes("cpf") || normalized.includes("cnpj") || normalized.includes("document"))) {
    return context === "payment"
      ? "Atualize seu CPF/CNPJ no cadastro antes de pagar."
      : "Atualize seu CPF/CNPJ no cadastro antes de salvar o cartão.";
  }
  if (normalized.includes("missing-address") || normalized.includes("zipcode") || normalized.includes("address")) {
    return context === "payment"
      ? "Atualize seu CEP e número do endereço no cadastro antes de pagar."
      : "Atualize seu CEP e número do endereço no cadastro antes de salvar o cartão.";
  }
  return null;
};

async function notifyPaymentStatus(
  intentDoc: FirebaseFirestore.QueryDocumentSnapshot,
  intent: Record<string, any>,
  status: PaymentNotificationStatus
) {
  const userId = intent.customerId || null;
  const sessionId = intent.customerSessionId || null;
  if (!userId && !sessionId) return;

  const notificationState = intent.paymentNotifications || {};
  if (notificationState[status]) return;

  const copy = paymentNotificationCopy[status];
  const notificationRef = db.collection("notifications").doc();
  await notificationRef.set({
    ...(userId ? { userId } : { sessionId }),
    type: "payment-status-change",
    title: copy.title,
    message: copy.message,
    read: false,
    data: {
      paymentIntentId: intentDoc.id,
      asaasPaymentId: intent.asaasPaymentId || null,
      status,
      orderIds: intent.orderIds || null
    },
    createdAt: FieldValue.serverTimestamp()
  });

  await intentDoc.ref.set(
    {
      paymentNotifications: { ...notificationState, [status]: true },
      lastPaymentNotificationAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

function isInvalidCustomerError(error: any): boolean {
  const raw = String(error?.message || "").toLowerCase();
  return raw.includes("customer") && (raw.includes("inválido") || raw.includes("invalido") || raw.includes("invalid"));
}

function normalizeDigits(value?: string): string {
  if (!value) return "";
  return String(value).replace(/\D/g, "");
}

async function buildCardHolderInfo(payload: Record<string, any>): Promise<Record<string, any>> {
  const userId = normalizeText(payload.customerId);
  if (!userId) throw new Error("customer-id-required");

  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new Error("customer-not-found");
  }

  const userData = userSnap.data() || {};
  const name = pickText(
    userData.name,
    userData.displayName,
    userData.fullName,
    userData.storeName,
    userData.email?.split?.("@")?.[0],
    "Cliente MySnack"
  );
  const email = pickText(userData.email, userData.ownerEmail);
  const cpfCnpj = normalizeCpfCnpj(
    payload.document ||
      userData.document ||
      userData.cpfCnpj ||
      userData.cnpj ||
      userData.cpf
  );
  const phone = pickText(userData.phone, userData.mobilePhone);
  const address = userData.address || {};

  if (!email) throw new Error("missing-email");

  const zipcode = normalizeDigits(address.zipcode);
  const addressNumber = address.number != null ? String(address.number) : "";
  if (!zipcode || !addressNumber) {
    throw new Error("missing-address");
  }

  return {
    name,
    email,
    ...(cpfCnpj ? { cpfCnpj } : {}),
    postalCode: zipcode,
    address: address.street || undefined,
    addressNumber,
    addressComplement: address.complement || undefined,
    province: address.neighborhood || undefined,
    city: address.city || undefined,
    state: address.state || undefined,
    phone: phone || undefined,
    mobilePhone: phone || undefined,
  };
}

async function resolveAsaasCustomerId(
  payload: Record<string, any>,
  options: { forceNew?: boolean } = {}
): Promise<string> {
  const provided = normalizeText(payload.asaasCustomerId);
  if (provided) return provided;

  const userId = normalizeText(payload.customerId);
  if (!userId) {
    throw new Error("customer-id-required");
  }

  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new Error("customer-not-found");
  }

  const userData = userSnap.data() || {};
  const cachedCustomerId = normalizeText(userData.asaasCustomerId);
  if (cachedCustomerId && !options.forceNew) {
    const cpfCnpj = normalizeCpfCnpj(
      payload.document ||
        userData.document ||
        userData.cpfCnpj ||
        userData.cnpj ||
        userData.cpf
    );
    try {
      await updateCustomer(
        cachedCustomerId,
        cpfCnpj
          ? { cpfCnpj, notificationDisabled: true }
          : { notificationDisabled: true }
      );
    } catch (error: any) {
      await writeAsaasAudit("customer-update-notifications-failed", {
        customerId: cachedCustomerId,
        uid: userId,
        message: error?.message || String(error)
      });
    }
    return cachedCustomerId;
  }

  const name = pickText(
    userData.name,
    userData.displayName,
    userData.fullName,
    userData.storeName,
    userData.email?.split?.("@")?.[0],
    "Cliente MySnack"
  );
  const email = pickText(userData.email, userData.ownerEmail);
  const cpfCnpj = normalizeCpfCnpj(
    payload.document ||
      userData.document ||
      userData.cpfCnpj ||
      userData.cnpj ||
      userData.cpf
  );
  const phone = pickText(userData.phone, userData.mobilePhone);



  if (!email) {
    throw new Error("missing-email");
  }

  const customerPayload: Record<string, any> = {
    name,
    email: email || undefined,
    ...(cpfCnpj ? { cpfCnpj } : {}),
    phone: phone || undefined,
    mobilePhone: phone || undefined,
    externalReference: userId,
    notificationDisabled: true
  };

  let customer: Record<string, any>;
  try {
    customer = await createCustomer(customerPayload);
  } catch (error: any) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("cpf") || message.includes("cnpj")) {
      throw new Error("invalid-cpf-cnpj");
    }
    if (message.includes("email")) {
      throw new Error("invalid-email");
    }
    throw error;
  }
  const createdId = normalizeText(customer?.id);
  if (!createdId) throw new Error("customer-create-failed");

  await userRef.set(
    {
      asaasCustomerId: createdId,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return createdId;
}

async function fetchStoreAsaasSummary(
  storeSnap: FirebaseFirestore.DocumentSnapshot,
  apiKey: string,
  options: { forceRefresh?: boolean } = {}
) {
  const store = storeSnap.data() || {};
  const cachedAccountNumber = normalizeAccountNumber(
    store.asaasAccountNumber ||
      store.asaasAccountCreated?.accountNumber ||
      store.asaasAccountData?.accountNumber
  );
  const cacheTtlMs = options.forceRefresh ? 0 : 5 * 60 * 1000;
  const cachedBalance = isFresh(store.asaasBalanceUpdatedAt, cacheTtlMs) ? store.asaasBalance : null;
  const cachedStatus = isFresh(store.asaasAccountStatusUpdatedAt, cacheTtlMs) ? store.asaasAccountStatus : null;
  let hadFailure = false;
  const tasks = await Promise.allSettled([
    cachedBalance ? Promise.resolve(cachedBalance) : getBalance(apiKey),
    cachedStatus ? Promise.resolve(cachedStatus) : getAccountStatus(apiKey),
    listAccountDocuments(apiKey),
    cachedAccountNumber ? Promise.resolve(cachedAccountNumber) : getAccountNumber(apiKey)
  ]);
  const balance = tasks[0].status === "fulfilled" ? tasks[0].value : cachedBalance;
  if (tasks[0].status === "rejected") hadFailure = true;
  const status = tasks[1].status === "fulfilled" ? tasks[1].value : cachedStatus;
  if (tasks[1].status === "rejected") hadFailure = true;
  const documents = tasks[2].status === "fulfilled" ? tasks[2].value : null;
  if (tasks[2].status === "rejected") hadFailure = true;
  const accountNumber = tasks[3].status === "fulfilled" ? tasks[3].value : cachedAccountNumber;
  if (tasks[3].status === "rejected") hadFailure = true;
  const documentsList = documents?.data || documents || null;
  const onboardingUrls = Array.isArray(documentsList)
    ? documentsList
        .filter((doc: any) => doc?.onboardingUrl)
        .map((doc: any) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title || null,
          onboardingUrl: doc.onboardingUrl,
          onboardingUrlExpirationDate: doc.onboardingUrlExpirationDate || null
        }))
    : [];

  const updatePayload: Record<string, any> = {
    asaasOnboardingUrls: onboardingUrls,
    updatedAt: FieldValue.serverTimestamp()
  };
  const normalizedBalance = normalizeBalancePayload(balance);
  if (normalizedBalance != null) {
    updatePayload.asaasBalance = normalizedBalance;
    updatePayload.asaasBalanceUpdatedAt = FieldValue.serverTimestamp();
  }
  const normalizedStatus =
    status && typeof status === "object"
      ? { ...(status as Record<string, any>) }
      : status;
  if (normalizedStatus != null) {
    updatePayload.asaasAccountStatus = normalizedStatus;
    updatePayload.asaasAccountStatusUpdatedAt = FieldValue.serverTimestamp();
  }
  if (documentsList != null) {
    updatePayload.asaasPendingDocuments = documentsList;
    updatePayload.asaasPendingDocumentsUpdatedAt = FieldValue.serverTimestamp();
  }
  const normalizedAccountNumber = (() => {
    if (!accountNumber) return null;
    if (typeof accountNumber === "string" || typeof accountNumber === "number") {
      return String(accountNumber);
    }
    if (typeof accountNumber === "object") {
      const unwrap = (value: any) => {
        if (!value || typeof value !== "object") return value;
        if (value.accountNumber && typeof value.accountNumber === "object") return value.accountNumber;
        if (value.account_number && typeof value.account_number === "object") return value.account_number;
        return value;
      };
      const toText = (value: any) => {
        if (value == null) return "";
        if (typeof value === "string" || typeof value === "number") return normalizeText(value);
        return "";
      };
      const source = unwrap(accountNumber);
      const agency = normalizeText(source?.agency);
      const account = normalizeText(source?.account);
      const accountDigit = normalizeText(source?.accountDigit || source?.account_digit);
      if (agency || account || accountDigit) {
        return {
          agency: agency || null,
          account: account || null,
          accountDigit: accountDigit || null
        };
      }
      const legacyValue = source?.accountNumber ?? source?.account_number;
      if (legacyValue && typeof legacyValue === "object") {
        const nested = legacyValue;
        const nestedAgency = normalizeText(nested.agency);
        const nestedAccount = normalizeText(nested.account);
        const nestedDigit = normalizeText(nested.accountDigit || nested.account_digit);
        if (nestedAgency || nestedAccount || nestedDigit) {
          return {
            agency: nestedAgency || null,
            account: nestedAccount || null,
            accountDigit: nestedDigit || null
          };
        }
        const nestedLegacy = toText(nested.accountNumber ?? nested.account_number);
        if (nestedLegacy) return nestedLegacy;
      }
      const legacy = toText(legacyValue);
      if (legacy) return legacy;
    }
    return null;
  })();
  if (normalizedAccountNumber != null) {
    updatePayload.asaasAccountNumber = normalizedAccountNumber;
  }

  if (normalizedAccountNumber && normalizedStatus && typeof normalizedStatus === "object") {
    const bankInfo = normalizeText(normalizedStatus.bankAccountInfo);
    if (!bankInfo || bankInfo === "PENDING") {
      normalizedStatus.bankAccountInfo = "APPROVED";
    }
  }

  await storeSnap.ref.update(updatePayload);

  return {
    asaasBalance: normalizedBalance || null,
    asaasAccountStatus: normalizedStatus || null,
    asaasPendingDocuments: documentsList,
    asaasAccountNumber: normalizedAccountNumber,
    asaasOnboardingUrls: onboardingUrls,
    cached: hadFailure
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (index < items.length) {
      const current = items[index++];
      const result = await handler(current);
      results.push(result);
    }
  });
  await Promise.all(workers);
  return results;
}

export function buildSubaccountPayload(store: Record<string, any>) {
  const commercial = store.asaasCommercialInfo || {};
  const cpfCnpj = normalizeCpfCnpj(store.cnpj || store.cpfCnpj || commercial.cpfCnpj);
  if (!cpfCnpj) throw new Error("missing-cpf-cnpj");
  const payload = {
    name: store.displayName || store.storeName || store.name || commercial.companyName,
    email: store.ownerEmail || store.email || commercial.email,
    cpfCnpj,
    phone: commercial.phone || store.phone,
    mobilePhone: commercial.mobilePhone || store.phone,
    birthDate: commercial.birthDate || store.birthDate || undefined,
    incomeValue: commercial.incomeValue != null
      ? Number(commercial.incomeValue || 0)
      : Number(store.monthlyRevenue || 0),
    companyType: commercial.companyType || store.asaasCompanyType || undefined,
    businessName: commercial.companyName || store.razaoSocial || store.storeName || store.name,
    postalCode: commercial.postalCode || store.addressZip || undefined,
    address: commercial.address || store.addressStreet || undefined,
    addressNumber: commercial.addressNumber || store.addressNumber || undefined,
    complement: commercial.complement || store.addressComplement || undefined,
    province: commercial.province || store.addressNeighborhood || undefined,
    city: commercial.city || store.city || undefined,
    state: commercial.state || store.state || undefined
  };
  return payload;
}

function buildAsaasSteps(store: Record<string, any>, summary: Record<string, any> | null, hasApiKey: boolean) {
  const pendingDocs = Array.isArray(summary?.asaasPendingDocuments)
    ? summary.asaasPendingDocuments
    : [];
  const hasDocs = pendingDocs.length > 0;
  const hasOnboarding = Array.isArray(summary?.asaasOnboardingUrls)
    ? summary.asaasOnboardingUrls.length > 0
    : false;

  return [
    {
      id: "account",
      label: "Conta criada",
      status: store.asaasAccountId ? "completed" : "pending"
    },
    {
      id: "token",
      label: "Token gerado",
      status: hasApiKey ? "completed" : "pending"
    },
    {
      id: "wallet",
      label: "Wallet vinculada",
      status: store.asaasWalletId ? "completed" : "pending"
    },
    {
      id: "status",
      label: "Status cadastral",
      status: summary?.asaasAccountStatus ? "completed" : "pending"
    },
    {
      id: "documents",
      label: "Documentos pendentes",
      status: hasDocs ? "attention" : "completed",
      count: hasDocs ? pendingDocs.length : 0
    },
    {
      id: "onboarding",
      label: "Links de onboarding",
      status: hasOnboarding ? "attention" : "completed",
      count: hasOnboarding ? summary?.asaasOnboardingUrls?.length || 0 : 0
    },
    {
      id: "balance",
      label: "Saldo",
      status: summary?.asaasBalance ? "completed" : "pending"
    }
  ];
}

async function buildCommercialFallback(uid: string, storeData: Record<string, any> | null) {
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  let ownerData: Record<string, any> = {};
  try {
    const ownerSnap = await rtdb.ref(`storeOwners/${uid}`).get();
    if (ownerSnap.exists()) ownerData = ownerSnap.val() || {};
  } catch {
    ownerData = {};
  }

  const storeFallback = {
    storeName: pickText(
      storeData?.storeName,
      storeData?.displayName,
      storeData?.name,
      userData?.storeName,
      userData?.displayName,
      userData?.name,
      ownerData?.storeName,
      ownerData?.fullName
    ),
    name: pickText(storeData?.name, userData?.name, ownerData?.fullName),
    personType: pickText(storeData?.personType, userData?.personType, ownerData?.personType),
    razaoSocial: pickText(storeData?.razaoSocial, userData?.razaoSocial, ownerData?.razaoSocial),
    cnpj: pickText(storeData?.cnpj, userData?.cnpj, ownerData?.cnpj),
    cpfCnpj: pickText(storeData?.cpfCnpj, userData?.cpfCnpj, ownerData?.cpfCnpj),
    birthDate: pickText(storeData?.birthDate, userData?.birthDate, ownerData?.birthDate),
    phone: pickText(storeData?.phone, userData?.phone, ownerData?.phone),
    email: pickText(storeData?.email, userData?.email, ownerData?.email),
    ownerEmail: pickText(storeData?.ownerEmail, userData?.ownerEmail, userData?.email, ownerData?.email),
    addressZip: pickText(storeData?.addressZip, userData?.addressZip, ownerData?.addressZip),
    addressStreet: pickText(storeData?.addressStreet, userData?.addressStreet, ownerData?.addressStreet),
    addressNumber: pickText(storeData?.addressNumber, userData?.addressNumber, ownerData?.addressNumber),
    addressComplement: pickText(storeData?.addressComplement, userData?.addressComplement, ownerData?.addressComplement),
    addressNeighborhood: pickText(storeData?.addressNeighborhood, userData?.addressNeighborhood, ownerData?.addressNeighborhood),
    city: pickText(storeData?.city, userData?.city, ownerData?.city),
    state: pickText(storeData?.state, userData?.state, ownerData?.state),
    monthlyRevenue: pickValue(storeData?.monthlyRevenue, userData?.monthlyRevenue, ownerData?.monthlyRevenue),
    asaasCompanyType: pickText(storeData?.asaasCompanyType, userData?.asaasCompanyType, ownerData?.asaasCompanyType)
  };

  const commercialInfo =
    storeData?.asaasCommercialInfo ||
    userData?.asaasCommercialInfo ||
    null;

  return { storeFallback, commercialInfo };
}

async function ensureStoreAsaasAccountForStore(storeSnap: FirebaseFirestore.DocumentSnapshot) {
  const store = storeSnap.data() || {};

  let asaasAccountId = store.asaasAccountId || null;
  let asaasWalletId = store.asaasWalletId || null;
  let asaasAccountData: any = store.asaasAccountData || null;
  let asaasAccountCreated: any = store.asaasAccountCreated || null;
  let asaasAccountTokenData: any = store.asaasAccountTokenData || null;
  let asaasAccountNumber = store.asaasAccountNumber || null;
  let asaasAccountStatus = store.asaasAccountStatus || null;
  let asaasApiKey = resolveStoreApiKey(store) || null;

  if (!asaasAccountId) {
    const payload = buildSubaccountPayload(store);
    const created = await createSubaccount(payload);
    asaasAccountId = created.id || null;
    asaasAccountData = created;
    asaasAccountCreated = created;
    asaasWalletId = asaasWalletId || created.walletId || created.wallet?.id || null;
    asaasAccountNumber = asaasAccountNumber || created.accountNumber || null;
    asaasApiKey = asaasApiKey || created.apiKey || created.accessToken?.apiKey || null;
    asaasAccountTokenData = asaasAccountTokenData || created.accessToken || null;
  }

  if (asaasAccountId) {
    try {
      const remote = await getSubaccount(asaasAccountId);
      asaasAccountData = remote || asaasAccountData;
      const remoteAccountNumber = remote?.accountNumber || null;
      if (remoteAccountNumber) asaasAccountNumber = remoteAccountNumber;
      const remoteWalletId = remote?.walletId || remote?.wallet?.id || null;
      if (remoteWalletId && !asaasWalletId) {
        asaasWalletId = remoteWalletId;
      }
    } catch {
      // Keep existing account data if lookup fails.
    }
  }

  if (asaasAccountId && !asaasApiKey) {
    const tokenResp = await createSubaccountAccessToken(asaasAccountId, { description: "MySnack" });
    asaasAccountTokenData = tokenResp || asaasAccountTokenData;
    asaasApiKey = tokenResp?.accessToken || tokenResp?.apiKey || tokenResp?.token || null;
  }

  let summary: any = null;
  if (asaasApiKey) {
    if (!asaasWalletId) {
      const derivedWalletId =
        asaasAccountCreated?.walletId ||
        asaasAccountData?.walletId ||
        asaasAccountData?.wallet?.id ||
        null;
      asaasWalletId = derivedWalletId || asaasWalletId;
    }
    if (!asaasWalletId) {
      const wallets = await listWallets(asaasApiKey);
      const first = Array.isArray(wallets?.data) ? wallets.data[0] : wallets?.data || wallets?.wallets?.[0];
      asaasWalletId = first?.id || asaasWalletId;
    }
    summary = await fetchStoreAsaasSummary(storeSnap, asaasApiKey);
    asaasAccountNumber = summary?.asaasAccountNumber || asaasAccountNumber;
    asaasAccountStatus = summary?.asaasAccountStatus || asaasAccountStatus;
  }

  const encrypted = asaasApiKey ? encryptToken(asaasApiKey) : null;
  const apiKeyLast4 = asaasApiKey ? String(asaasApiKey).slice(-4) : null;
  await storeSnap.ref.update({
    asaasAccountId,
    asaasWalletId,
    asaasAccountData: {
      ...asaasAccountData,
      ...(encrypted ? { apiKeyEnc: encrypted.apiKeyEnc } : {}),
      ...(asaasApiKey ? { apiKey: asaasApiKey } : {}),
      ...(apiKeyLast4 ? { apiKeyLast4 } : {})
    },
    ...(asaasAccountCreated ? { asaasAccountCreated } : {}),
    ...(asaasAccountTokenData ? { asaasAccountTokenData } : {}),
    ...(asaasApiKey ? { asaasApiKey } : {}),
    asaasAccountNumber,
    asaasAccountStatus,
    asaasAccountStatusUpdatedAt: FieldValue.serverTimestamp(),
    asaasSyncedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  const steps = buildAsaasSteps(
    {
      ...store,
      asaasAccountId,
      asaasWalletId
    },
    summary,
    Boolean(asaasApiKey)
  );

  return {
    storeId: storeSnap.id,
    asaasAccountId,
    asaasWalletId,
    asaasAccountNumber,
    asaasAccountStatus,
    ...summary,
    asaasSteps: steps
  };
}

async function processWebhookPayload(payload: any) {
  const paymentId = String(payload?.payment?.id || payload?.paymentId || payload?.id || "");
  if (!paymentId) throw new Error("payment-id-required");

  const eventKey = getWebhookEventKey(payload);
  const payloadHash = hashPayload(payload);
  const intentSnap = await db.collection("paymentIntents").where("asaasPaymentId", "==", paymentId).limit(1).get();
  if (intentSnap.empty) return { ok: true, skipped: true };
  const intentDoc = intentSnap.docs[0];
  const intent = intentDoc.data() || {};

  const eventName = String(payload?.event || payload?.type || "").toUpperCase();
  const rawEventType = payload?.type || null;
  const asaasStatus = payload?.payment?.status || payload?.status || null;
  const asaasStatusUpdatedAt = FieldValue.serverTimestamp();
  if (WEBHOOK_PAID_EVENTS.has(eventName)) {
    if (intent.status !== "PAID") {
      const ordersCreated = Array.isArray(intent.orderIds) && intent.orderIds.length > 0;
      if (!ordersCreated) {
        const orders: string[] = [];
        const itemsByStore: StoreTotals[] = Array.isArray(intent.itemsByStore) ? intent.itemsByStore : [];
        const descriptionCache = new Map<string, Promise<string | null>>();
        for (const storeTotals of itemsByStore) {
          const storeSnap = await db.collection("stores").doc(storeTotals.storeId).get();
          if (!storeSnap.exists) continue;
          const store = storeSnap.data() || {};
          const orderNumber = Math.floor(100000 + Math.random() * 900000).toString();
          const subtotal = fromCents(storeTotals.subtotalCents);
          const normalizedItems = await Promise.all(
            (Array.isArray(storeTotals.items) ? storeTotals.items : []).map(async (rawItem: any) => {
              const normalized = normalizeIntentItem(rawItem);
              const hasDescription = Boolean(pickText(normalized.description));
              if (hasDescription) return normalized;
              const productId = pickText(normalized.productId, normalized.itemId);
              if (!productId) return normalized;
              const menuDescription = await resolveMenuItemDescription(
                storeTotals.storeId,
                productId,
                descriptionCache
              );
              if (!menuDescription) return normalized;
              return {
                ...normalized,
                description: menuDescription,
              };
            })
          );
          const doc = {
            storeId: storeTotals.storeId,
            storeName: storeTotals.storeName,
            shoppingId: store.shoppingId || null,
            shoppingName: store.shoppingName || null,
            orderNumber,
            status: "pending",
            tableNumber: intent.tableNumber || null,
            chairId: intent.chairId || null,
            items: normalizedItems,
            subtotal,
            fee: 0,
            total: subtotal,
            paymentMethod: intent.paymentMethod || "pix",
            paymentProvider: "asaas",
            paymentStatus: "paid",
            asaasPaymentId: paymentId,
            paymentIntentId: intentDoc.id,
            splitComputed: intent.splitComputed || null,
            customerId: intent.customerId || null,
            customerSessionId: intent.customerSessionId || null,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          };
          const ref = await db.collection("orders").add(doc);
          orders.push(ref.id);
        }
        await intentDoc.ref.update({
          status: "PAID",
          paidAt: FieldValue.serverTimestamp(),
          orderIds: orders,
          asaasStatus,
          asaasEventName: eventName || null,
          asaasEventType: rawEventType,
          asaasEventKey: eventKey || null,
          asaasPayloadHash: payloadHash || null,
          asaasStatusUpdatedAt,
          updatedAt: FieldValue.serverTimestamp()
        });
      } else {
        await intentDoc.ref.update({
          status: "PAID",
          paidAt: FieldValue.serverTimestamp(),
          asaasStatus,
          asaasEventName: eventName || null,
          asaasEventType: rawEventType,
          asaasEventKey: eventKey || null,
          asaasPayloadHash: payloadHash || null,
          asaasStatusUpdatedAt,
          updatedAt: FieldValue.serverTimestamp()
        });
        if (Array.isArray(intent.orderIds) && intent.orderIds.length > 0) {
          await Promise.all(
            intent.orderIds.map((orderId: string) =>
              db.collection("orders").doc(orderId).update({
                paymentStatus: "paid",
                paymentProvider: "asaas",
                asaasPaymentId: paymentId,
                paymentIntentId: intentDoc.id,
                updatedAt: FieldValue.serverTimestamp()
              })
            )
          );
        }
      }
    }
    await notifyPaymentStatus(intentDoc, intent, "PAID");
    if (!intent.reconciledAt) {
      try {
        const charge = await getCharge(paymentId);
        const netValueCents = charge?.netValue ? toCents(Number(charge.netValue)) : null;
        const feeCents = charge?.fee ? toCents(Number(charge.fee)) : null;
        const computed = intent.splitComputed || {};
        const fixedTotalCents =
          computed?.ledger?.fixedTotalCents ||
          (Array.isArray(computed?.storeSplits)
            ? computed.storeSplits.reduce((acc: number, split: any) => acc + Number(split.fixedValueCents || 0), 0)
            : 0);
        const expectedRemainderCents =
          computed?.platform?.expectedPlatformRemainderCents ??
          (intent.totalCents ? Number(intent.totalCents) - fixedTotalCents : 0);
        const discrepancyCents =
          netValueCents != null ? netValueCents - expectedRemainderCents : null;

        const valueCents = charge?.value ? toCents(Number(charge.value)) : null;
        await intentDoc.ref.update({
          asaasChargeSnapshot: charge || null,
          valueCents,
          netValueCents,
          feeCents,
          expectedRemainderCents,
          expectedFixedTotalCents: fixedTotalCents,
          discrepancyCents,
          reconciledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        if (discrepancyCents != null && Math.abs(discrepancyCents) >= 2) {
          await writeAsaasAudit("split-discrepancy", {
            paymentId,
            discrepancyCents,
            expectedRemainderCents,
            netValueCents
          });
        }
      } catch (error) {
        await writeAsaasAudit("split-reconcile-error", { paymentId, error: (error as Error).message });
      }
    }
    return { ok: true, status: "PAID" };
  }

  if (eventName === "PAYMENT_EXPIRED") {
    await intentDoc.ref.update({
      status: "EXPIRED",
      asaasStatus,
      asaasEventName: eventName || null,
      asaasEventType: rawEventType,
      asaasEventKey: eventKey || null,
      asaasPayloadHash: payloadHash || null,
      asaasStatusUpdatedAt,
      updatedAt: FieldValue.serverTimestamp()
    });
    await notifyPaymentStatus(intentDoc, intent, "EXPIRED");
    if (Array.isArray(intent.orderIds) && intent.orderIds.length > 0) {
      await Promise.all(
        intent.orderIds.map((orderId: string) =>
          db.collection("orders").doc(orderId).update({
            paymentStatus: "pending",
            updatedAt: FieldValue.serverTimestamp()
          })
        )
      );
    }
    return { ok: true, status: "EXPIRED" };
  }

  if (WEBHOOK_FAILED_EVENTS.has(eventName)) {
    await intentDoc.ref.update({
      status: "FAILED",
      asaasStatus,
      asaasEventName: eventName || null,
      asaasEventType: rawEventType,
      asaasEventKey: eventKey || null,
      asaasPayloadHash: payloadHash || null,
      asaasStatusUpdatedAt,
      updatedAt: FieldValue.serverTimestamp()
    });
    await notifyPaymentStatus(intentDoc, intent, "FAILED");
    if (Array.isArray(intent.orderIds) && intent.orderIds.length > 0) {
      const updates = intent.orderIds.map((orderId: string) =>
        db.collection("orders").doc(orderId).update({
          paymentStatus: eventName === "PAYMENT_REFUNDED" || eventName === "PAYMENT_CHARGEBACK"
            ? "refunded"
            : "pending",
          updatedAt: FieldValue.serverTimestamp()
        })
      );
      await Promise.all(updates);
    }
    return { ok: true, status: "FAILED" };
  }

  return { ok: true, status: "IGNORED" };
}

export const createPaymentHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const payload = req.body || {};
    console.log("[createPaymentHttp] payload received", {
      paymentMethod: payload?.paymentMethod || null,
      customerId: payload?.customerId || null,
      hasDocument: Boolean(payload?.document),
      tableNumber: payload?.tableNumber || null,
      itemsCount: Array.isArray(payload?.items) ? payload.items.length : 0
    });
    const paymentMethod = String(payload.paymentMethod || "pix").toLowerCase();
    try {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) throw new Error("items-required");

    const itemsByStore = new Map<string, StoreTotals>();
    items.forEach((item: any) => {
      const normalizedItem = normalizeIntentItem(item);
      const storeId = String(normalizedItem.storeId || "");
      if (!storeId) return;
      const current = itemsByStore.get(storeId) || {
        storeId,
        storeName: String(normalizedItem.storeName || "Loja"),
        items: [],
        subtotalCents: 0,
        walletId: ""
      };
      const itemTotal = Number(normalizedItem.price || 0) * Number(normalizedItem.qty || 0);
      current.items.push(normalizedItem);
      current.subtotalCents += toCents(itemTotal);
      if (normalizedItem.storeName) current.storeName = String(normalizedItem.storeName);
      itemsByStore.set(storeId, current);
    });

    if (!itemsByStore.size) throw new Error("stores-required");

    const storeIds = Array.from(itemsByStore.keys());
    const storeSnaps = await Promise.all(storeIds.map((storeId) => db.collection("stores").doc(storeId).get()));
    storeSnaps.forEach((snap, index) => {
      const storeId = storeIds[index];
      if (!snap.exists) throw new Error(`store-not-found:${storeId}`);
      const data = snap.data() || {};
      const storeTotals = itemsByStore.get(storeId);
      if (!storeTotals) return;
      storeTotals.storeName = storeTotals.storeName || data.displayName || data.storeName || data.name || "Loja";
      storeTotals.walletId =
        data.asaasWalletId ||
        data.asaasAccountData?.walletId ||
        data.asaasAccountCreated?.walletId ||
        data.asaas?.walletId ||
        "";
      storeTotals.platformFeeRate = normalizePlatformFeeRate(
        data?.splitConfig?.platformFeeRate ?? data?.platformFeeRate,
        PLATFORM_FEE_RATE
      );
    });

    const shouldBypassAsaas = isLocalhostRequest(req) && payload?.mockLocalhostSuccess === true;
    if (shouldBypassAsaas) {
      const feeConfig = resolvePaymentFeeConfig(paymentMethod);
      const subtotalCents = Array.from(itemsByStore.values()).reduce((acc, store) => acc + store.subtotalCents, 0);
      const platformFeeCents = Array.from(itemsByStore.values()).reduce((acc, store) => {
        const rate = normalizePlatformFeeRate(store.platformFeeRate, PLATFORM_FEE_RATE);
        return acc + Math.round(store.subtotalCents * rate);
      }, 0);
      const totalCents = subtotalCents + platformFeeCents + feeConfig.fixedFeeCents;
      if (totalCents <= feeConfig.fixedFeeCents) throw new Error("total-too-low");

      const billingType = paymentMethod === "pix" ? "PIX" : "CREDIT_CARD";
      const mockPaymentId = `mock_local_${Date.now()}`;
      const descriptionCache = new Map<string, Promise<string | null>>();
      const createdOrderIds: string[] = [];

      for (const storeTotals of itemsByStore.values()) {
        const storeSnap = await db.collection("stores").doc(storeTotals.storeId).get();
        if (!storeSnap.exists) continue;
        const store = storeSnap.data() || {};
        const orderNumber = Math.floor(100000 + Math.random() * 900000).toString();
        const subtotal = fromCents(storeTotals.subtotalCents);
        const normalizedItems = await Promise.all(
          (Array.isArray(storeTotals.items) ? storeTotals.items : []).map(async (rawItem: any) => {
            const normalized = normalizeIntentItem(rawItem);
            const hasDescription = Boolean(pickText(normalized.description));
            if (hasDescription) return normalized;
            const productId = pickText(normalized.productId, normalized.itemId);
            if (!productId) return normalized;
            const menuDescription = await resolveMenuItemDescription(
              storeTotals.storeId,
              productId,
              descriptionCache
            );
            if (!menuDescription) return normalized;
            return { ...normalized, description: menuDescription };
          })
        );

        const orderDoc = {
          storeId: storeTotals.storeId,
          storeName: storeTotals.storeName,
          shoppingId: store.shoppingId || null,
          shoppingName: store.shoppingName || null,
          orderNumber,
          status: "pending",
          tableNumber: payload.tableNumber || null,
          chairId: payload.chairId || null,
          items: normalizedItems,
          subtotal,
          fee: 0,
          total: subtotal,
          paymentMethod,
          paymentProvider: "mock-localhost",
          paymentStatus: "paid",
          asaasPaymentId: mockPaymentId,
          splitComputed: null,
          customerId: payload.customerId || null,
          customerSessionId: payload.sessionId || null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };
        const orderRef = await db.collection("orders").add(orderDoc);
        createdOrderIds.push(orderRef.id);
      }

      const intentRef = await db.collection("paymentIntents").add({
        items,
        itemsByStore: Array.from(itemsByStore.values()),
        storeIds,
        totalCents,
        valueCents: totalCents,
        netValueCents: totalCents,
        billingType,
        paymentMethod,
        asaasPaymentId: mockPaymentId,
        invoiceUrl: null,
        splitComputed: null,
        splitAdjusted: null,
        status: "PAID",
        paidAt: FieldValue.serverTimestamp(),
        orderIds: createdOrderIds,
        customerId: payload.customerId || null,
        customerSessionId: payload.sessionId || null,
        asaasCustomerId: null,
        tableNumber: payload.tableNumber || null,
        chairId: payload.chairId || null,
        feeCents: feeConfig.fixedFeeCents,
        platformFeeRate: PLATFORM_FEE_RATE,
        mockBypass: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      return {
        paymentIntentId: intentRef.id,
        asaasPaymentId: mockPaymentId,
        invoiceUrl: null,
        billingType,
        mockBypass: true,
        pix: paymentMethod === "pix"
          ? {
              payload: "PAGAMENTO MOCK LOCALHOST",
              encodedImage: null,
              expirationDate: null
            }
          : null
      };
    }

    const invalidStore = Array.from(itemsByStore.values()).find((store) => !store.walletId);
    if (invalidStore) {
      throw new Error(`store-asaas-not-configured:${invalidStore.storeId}`);
    }

    const feeConfig = resolvePaymentFeeConfig(paymentMethod);
    const subtotalCents = Array.from(itemsByStore.values()).reduce((acc, store) => acc + store.subtotalCents, 0);
    const platformFeeCents = Array.from(itemsByStore.values()).reduce((acc, store) => {
      const rate = normalizePlatformFeeRate(store.platformFeeRate, PLATFORM_FEE_RATE);
      return acc + Math.round(store.subtotalCents * rate);
    }, 0);
    const totalCents = subtotalCents + platformFeeCents + feeConfig.fixedFeeCents;
    if (totalCents <= feeConfig.fixedFeeCents) throw new Error("total-too-low");

    const split = computeSplitCents(Array.from(itemsByStore.values()), totalCents, {
      fixedFeeCents: feeConfig.fixedFeeCents,
      cardFeeRate: feeConfig.cardFeeRate
    });
    const asaasSplit = split.storeSplits.map((store) => ({
      walletId: store.walletId,
      fixedValue: fromCents(store.fixedValueCents)
    }));

    const cardToken = normalizeText(payload.cardToken);
    const card = payload.card || null;
    const isDebit = paymentMethod === "debit";
    const allowInvoiceFallback = payload.allowInvoiceFallback === true;
    if (paymentMethod === "credit" && !cardToken && !card && !allowInvoiceFallback) {
      throw new Error("card-required");
    }

    const billingType = paymentMethod === "pix"
      ? "PIX"
      : "CREDIT_CARD";

    let asaasCustomerId = await resolveAsaasCustomerId(payload);
    console.log("[createPaymentHttp] resolved customer", {
      customerId: payload?.customerId || null,
      asaasCustomerId
    });
    const needsCardInfo = paymentMethod !== "pix" && !isDebit && (cardToken || card);
    const cardHolderInfo = needsCardInfo ? await buildCardHolderInfo(payload) : null;
    if (needsCardInfo) {
      console.log("[createPaymentHttp] card holder info ready", {
        hasHolderInfo: Boolean(cardHolderInfo),
        hasCpfCnpj: Boolean(cardHolderInfo?.cpfCnpj)
      });
    }

    const chargePayload: Record<string, any> = {
      value: fromCents(totalCents),
      description: "Pagamento MySnack",
      dueDate: formatDate(new Date()),
      billingType,
      split: asaasSplit,
      externalReference: payload.externalReference || undefined,
      customer: asaasCustomerId || undefined,
      creditCardToken: cardToken || undefined,
      remoteIp: normalizeText(payload.remoteIp) || undefined
    };
    if (card && !isDebit) {
      const holderName = normalizeText(card.holderName);
      const number = normalizeDigits(card.number);
      const expiryMonth = normalizeDigits(card.expiryMonth);
      const expiryYear = normalizeDigits(card.expiryYear);
      const ccv = normalizeDigits(card.ccv);
      if (!holderName || !number || !expiryMonth || !expiryYear || !ccv) {
        throw new Error("card-incomplete");
      }
      chargePayload.creditCard = {
        holderName,
        number,
        expiryMonth,
        expiryYear,
        ccv
      };
    }
    if (cardHolderInfo && !isDebit) {
      chargePayload.creditCardHolderInfo = cardHolderInfo;
    }
    const redactedPayload = {
      billingType: chargePayload.billingType,
      value: chargePayload.value,
      splitCount: Array.isArray(asaasSplit) ? asaasSplit.length : 0,
      hasCardToken: Boolean(cardToken),
      hasCreditCard: Boolean(chargePayload.creditCard),
      hasHolderInfo: Boolean(chargePayload.creditCardHolderInfo),
      customer: asaasCustomerId ? "***" : null,
      externalReference: chargePayload.externalReference || null
    };
    await writeAsaasAudit("charge-request", {
      paymentMethod,
      redactedPayload
    });

    let charge: Record<string, any>;
    try {
      charge = await createCharge(chargePayload);
    } catch (error: any) {
      await writeAsaasAudit("charge-error", {
        paymentMethod,
        message: error?.message || String(error),
        code: error?.code || null,
        details: error?.details || null,
        stage: "createCharge"
      });
      if (isInvalidCustomerError(error) && payload.customerId) {
        const userRef = db.collection("users").doc(String(payload.customerId));
        await userRef.set(
          { asaasCustomerId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
        asaasCustomerId = await resolveAsaasCustomerId(payload, { forceNew: true });
        await writeAsaasAudit("charge-request-retry", {
          paymentMethod,
          redactedPayload: { ...redactedPayload, retryReason: "invalid-customer" }
        });
        charge = await createCharge({ ...chargePayload, customer: asaasCustomerId });
      } else {
        throw error;
      }
    }
    await writeAsaasAudit("charge-response", {
      paymentMethod,
      asaasPaymentId: charge?.id || null,
      status: charge?.status || null
    });
    const fixedTotalCents = split.storeSplits.reduce((acc, item) => acc + item.fixedValueCents, 0);
    let splitAdjusted: any = null;
    if (charge?.netValue && fixedTotalCents > 0) {
      const netValueCents = toCents(Number(charge.netValue));
      if (netValueCents > 0 && fixedTotalCents > netValueCents) {
        let percentAllocated = 0;
        const percentSplits = split.storeSplits.map((store, index) => {
          const isLast = index === split.storeSplits.length - 1;
          const percent = isLast
            ? +(100 - percentAllocated).toFixed(2)
            : +((store.fixedValueCents / fixedTotalCents) * 100).toFixed(2);
          percentAllocated += percent;
          return { walletId: store.walletId, percentage: percent };
        });
        await updateCharge(String(charge.id), { split: percentSplits });
        splitAdjusted = {
          reason: "netValue-lower-than-fixed",
          netValueCents,
          fixedTotalCents,
          mode: "percentage",
          split: percentSplits
        };
      }
    }
    let pixPayload: any = null;
    if (billingType === "PIX") {
      pixPayload = await getPixQrCode(String(charge.id));
    }

    const valueCents = charge?.value ? toCents(Number(charge.value)) : totalCents;
    const netValueCents = charge?.netValue ? toCents(Number(charge.netValue)) : null;

    const intentRef = await db.collection("paymentIntents").add({
      items: items,
      itemsByStore: Array.from(itemsByStore.values()),
      storeIds: storeIds,
      totalCents,
      valueCents,
      netValueCents,
      billingType,
      paymentMethod,
      asaasPaymentId: charge.id || null,
      invoiceUrl: charge.invoiceUrl || null,
      splitComputed: split,
      splitAdjusted,
      status: "WAITING_PAYMENT",
      customerId: payload.customerId || null,
      customerSessionId: payload.sessionId || null,
      asaasCustomerId: asaasCustomerId || null,
      tableNumber: payload.tableNumber || null,
      chairId: payload.chairId || null,
      feeCents: feeConfig.fixedFeeCents,
      platformFeeRate: PLATFORM_FEE_RATE,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await writeAsaasAudit("payment-created", {
      paymentIntentId: intentRef.id,
      paymentMethod,
      billingType,
      totalCents,
      splitComputed: split
    });

      return {
        paymentIntentId: intentRef.id,
        asaasPaymentId: charge.id || null,
        invoiceUrl: charge.invoiceUrl || null,
        billingType,
        pix: pixPayload
          ? {
              payload: pixPayload.payload || pixPayload.qrCode || null,
              encodedImage: pixPayload.encodedImage || pixPayload.qrCode || null,
              expirationDate: pixPayload.expirationDate || null
            }
          : null
      };
    } catch (error: any) {
      await writeAsaasAudit("charge-error", {
        paymentMethod,
        message: error?.message || String(error),
        code: error?.code || null,
        details: error?.details || null,
        stage: "createPayment"
      });
      const mapped = mapProfileErrorMessage(
        error?.message,
        "payment",
        { allowDocument: paymentMethod !== "pix" }
      );
      if (mapped) throw new Error(mapped);
      throw error;
    }
  });

  res.status(resp.success ? 200 : 400).json(resp);
}));

export const tokenizeCardHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const mapTokenizeErrorMessage = (message: string, asaasError?: { code?: string; description?: string } | null) => {
    const combined = `${message} ${asaasError?.description || ""}`.toLowerCase();
    const mappedProfile = mapProfileErrorMessage(combined, "card");
    if (mappedProfile) return mappedProfile;
    if (combined.includes("gerente de conta") || combined.includes("gerente da conta")) {
      return "Cadastro de cartão indisponível no momento. Tente novamente mais tarde.";
    }
    if (combined.includes("forma de pagamento") && combined.includes("desativado")) {
      return "Cadastro de cartão temporariamente indisponível. Tente novamente mais tarde.";
    }
    return message;
  };

  const resp = await handleErrors(async () => {
    const uid = (req as any)?.auth?.uid || null;
    if (!uid) throw new Error("auth-required");
    const payload = req.body || {};
    const type = String(payload.type || "credit").toLowerCase();
    if (type === "debit") throw new Error("debit-not-supported");

    const card = payload.card || payload;
    const holderName = normalizeText(card.holderName || card.name);
    const number = normalizeDigits(card.number);
    const expiryMonth = normalizeDigits(card.expiryMonth || card.expiryMonth);
    const expiryYearRaw = normalizeDigits(card.expiryYear || card.expiryYear);
    const expiryYear = expiryYearRaw.length === 2 ? `20${expiryYearRaw}` : expiryYearRaw;
    const ccv = normalizeDigits(card.ccv || card.cvv);
    if (!holderName || !number || !expiryMonth || !expiryYear || !ccv) {
      throw new Error("card-incomplete");
    }

    const forwarded = req.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const remoteIp =
      normalizeText(payload.remoteIp) ||
      normalizeText(forwardedValue?.split?.(",")?.[0]) ||
      normalizeText((req as any).ip) ||
      normalizeText(req.socket?.remoteAddress);

    const asaasCustomerId = await resolveAsaasCustomerId({ customerId: uid });
    const cardHolderInfo = await buildCardHolderInfo({ customerId: uid });
    let tokenResponse: any;
    try {
      tokenResponse = await tokenizeCreditCard({
        customer: asaasCustomerId,
        creditCard: {
          holderName,
          number,
          expiryMonth,
          expiryYear,
          ccv
        },
        creditCardHolderInfo: cardHolderInfo,
        ...(remoteIp ? { remoteIp } : {})
      });
    } catch (error: any) {
      const message = error?.message || "tokenize-failed";
      const asaasError = error?.details?.errors?.[0] || null;
      const lastDigits = normalizeDigits(number).slice(-4);
      const reason = /preenchimento das formas de pagamento.*desativado/i.test(message)
        ? "payment-methods-disabled"
        : String(error?.code || asaasError?.code || "tokenize-error");
      await recordTokenizeFailure({
        uid,
        reason,
        message,
        code: error?.code || asaasError?.code || null,
        details: asaasError ? { code: asaasError.code, description: asaasError.description } : null,
        meta: {
          lastDigits,
          expiryMonth,
          expiryYear,
          hasHolderName: Boolean(holderName),
          holderNameLength: holderName?.length || 0,
          hasCustomer: Boolean(asaasCustomerId)
        }
      });
      await writeAsaasAudit("tokenize-error", {
        uid,
        code: asaasError?.code || error?.code || null,
        description: asaasError?.description || null,
        message,
        reason,
        hasCustomer: Boolean(asaasCustomerId)
      });
      const friendlyMessage = mapTokenizeErrorMessage(message, asaasError);
      if (friendlyMessage !== message) {
        throw new Error(friendlyMessage);
      }
      throw error;
    }

    const token = normalizeText(tokenResponse?.creditCardToken || tokenResponse?.token);
    if (!token) throw new Error("card-token-missing");
    const brand = normalizeText(tokenResponse?.creditCardBrand || payload.brand || "Cartão");
    const lastDigits = normalizeDigits(tokenResponse?.creditCardNumber || number).slice(-4);

    const cardsRef = db.collection("users").doc(uid).collection("savedCards");
    const shouldDefault = payload.isDefault === true;
    const existing = await cardsRef.limit(1).get();
    const isDefault = shouldDefault || existing.empty;
    if (shouldDefault) {
      const existingDefault = await cardsRef.where("isDefault", "==", true).get();
      if (!existingDefault.empty) {
        await Promise.all(existingDefault.docs.map((doc) => doc.ref.update({ isDefault: false })));
      }
    }

    const docRef = cardsRef.doc();
    const cardDoc = {
      brand: brand || "Cartão",
      lastDigits,
      expiryMonth,
      expiryYear,
      expiryDate: `${expiryMonth}/${expiryYear.slice(-2)}`,
      holderName,
      token,
      type: "credit",
      isDefault,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await docRef.set(cardDoc);

    return { id: docRef.id, ...cardDoc };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const listSavedCardsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    try {
      const uid = (req as any)?.auth?.uid || null;
      if (!uid) throw new Error("auth-required");
      const snap = await db.collection("users").doc(uid).collection("savedCards").orderBy("createdAt", "desc").get();
      return { items: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
    } catch (error: any) {
      const mapped = mapProfileErrorMessage(error?.message, "card");
      if (mapped) throw new Error(mapped);
      throw error;
    }
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const deleteSavedCardHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    try {
      const uid = (req as any)?.auth?.uid || null;
      if (!uid) throw new Error("auth-required");
      const cardId = String(req.body?.cardId || req.query?.cardId || "").trim();
      if (!cardId) throw new Error("card-id-required");
      const ref = db.collection("users").doc(uid).collection("savedCards").doc(cardId);
      const snap = await ref.get();
      if (!snap.exists) throw new Error("card-not-found");
      const wasDefault = Boolean(snap.get("isDefault"));

      await ref.delete();

      if (wasDefault) {
        const remaining = await db.collection("users").doc(uid).collection("savedCards")
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        if (!remaining.empty) {
          await remaining.docs[0].ref.update({ isDefault: true, updatedAt: FieldValue.serverTimestamp() });
        }
      }

      return { ok: true, id: cardId };
    } catch (error: any) {
      const mapped = mapProfileErrorMessage(error?.message, "card");
      if (mapped) throw new Error(mapped);
      throw error;
    }
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const getPaymentStatusHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    try {
      const intentId = String(req.query.intentId || req.query.paymentIntentId || "");
      if (!intentId) throw new Error("intentId-required");
      const snap = await db.collection("paymentIntents").doc(intentId).get();
      if (!snap.exists) throw new Error("payment-intent-not-found");
      return { id: snap.id, ...snap.data() };
    } catch (error: any) {
      const mapped = mapProfileErrorMessage(error?.message, "payment");
      if (mapped) throw new Error(mapped);
      throw error;
    }
  });
  res.status(resp.success ? 200 : 404).json(resp);
}));

export const getPaymentQuoteHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const payload = req.body || {};
    const paymentMethod = String(payload.paymentMethod || "pix").toLowerCase();
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) throw new Error("items-required");

    const itemsByStore = new Map<string, StoreTotals>();
    items.forEach((item: any) => {
      const storeId = String(item.storeId || "");
      if (!storeId) return;
      const current = itemsByStore.get(storeId) || {
        storeId,
        storeName: String(item.storeName || "Loja"),
        items: [],
        subtotalCents: 0,
        walletId: ""
      };
      const itemTotal = Number(item.price || 0) * Number(item.qty || 0);
      current.items.push(item);
      current.subtotalCents += toCents(itemTotal);
      if (item.storeName) current.storeName = String(item.storeName);
      itemsByStore.set(storeId, current);
    });

    if (!itemsByStore.size) throw new Error("stores-required");

    const storeIds = Array.from(itemsByStore.keys());
    const storeSnaps = await Promise.all(storeIds.map((storeId) => db.collection("stores").doc(storeId).get()));
    storeSnaps.forEach((snap, index) => {
      const storeId = storeIds[index];
      if (!snap.exists) return;
      const data = snap.data() || {};
      const storeTotals = itemsByStore.get(storeId);
      if (!storeTotals) return;
      storeTotals.storeName = storeTotals.storeName || data.displayName || data.storeName || data.name || "Loja";
      storeTotals.platformFeeRate = normalizePlatformFeeRate(
        data?.splitConfig?.platformFeeRate ?? data?.platformFeeRate,
        PLATFORM_FEE_RATE
      );
    });

    const feeConfig = resolvePaymentFeeConfig(paymentMethod);
    const subtotalCents = Array.from(itemsByStore.values()).reduce((acc, store) => acc + store.subtotalCents, 0);
    const platformFeeCents = Array.from(itemsByStore.values()).reduce((acc, store) => {
      const rate = normalizePlatformFeeRate(store.platformFeeRate, PLATFORM_FEE_RATE);
      return acc + Math.round(store.subtotalCents * rate);
    }, 0);
    const totalCents = subtotalCents + platformFeeCents + feeConfig.fixedFeeCents;
    if (totalCents <= feeConfig.fixedFeeCents) throw new Error("total-too-low");

    return {
      paymentMethod,
      subtotalCents,
      totalCents
    };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

export const asaasWebhookHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const token = req.headers["asaas-access-token"];
    if (!verifyWebhookToken(token)) throw new Error("unauthorized");

    const payload = req.body || {};
    const eventKey = getWebhookEventKey(payload);
    if (!eventKey) throw new Error("webhook-event-id-required");

    const eventName = getWebhookEventName(payload);
    const payloadHash = hashPayload(payload);
    const eventRef = db.collection("asaasWebhookEvents").doc(eventKey);
    const paymentId = String(payload?.payment?.id || payload?.paymentId || payload?.id || "");
    const eventLock = await db.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      const data = snap.data() || {};
      const status = data.status || "received";
      const lastAttemptFresh = isFresh(data.lastAttemptAt, 30 * 1000);

      if (snap.exists) {
        if (data.payloadHash === payloadHash && status === "processed") {
          return { duplicate: true, reason: "already-processed" };
        }
        if (status === "processing" && lastAttemptFresh) {
          return { duplicate: true, reason: "processing" };
        }
      }

      const attempts = Number(data.attempts || 0) + 1;
      tx.set(
        eventRef,
        {
          createdAt: data.createdAt || FieldValue.serverTimestamp(),
          receivedAt: data.receivedAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          lastAttemptAt: FieldValue.serverTimestamp(),
          attempts,
          paymentId: paymentId || null,
          eventName: eventName || null,
          payloadHash,
          payload,
          status: "processing"
        },
        { merge: true }
      );
      return { duplicate: false, attempts };
    });

    if (eventLock.duplicate) {
      await writeAsaasAudit("webhook-duplicate", {
        eventKey,
        paymentId: paymentId || null,
        reason: eventLock.reason
      });
      return { ok: true, duplicate: true };
    }

    await writeAsaasAudit("webhook-received", {
      eventKey,
      paymentId: paymentId || null,
      eventName: eventName || null,
      payloadStatus: payload?.status || payload?.payment?.status || null,
      type: payload?.event || payload?.type || null
    });

    try {
      const result = await processWebhookPayload(payload);
      await eventRef.set({
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: result?.skipped ? "skipped" : "processed",
        result
      }, { merge: true });
      await writeAsaasAudit("webhook-processed", {
        eventKey,
        status: result?.status || null,
        paymentId: paymentId || null,
        eventName: eventName || null
      });
      return { ...result, ok: true };
    } catch (error: any) {
      await eventRef.set({
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        status: "failed",
        error: error?.message || String(error)
      }, { merge: true });
      await writeAsaasAudit("webhook-failed", { eventKey, error: error?.message || String(error) });
      throw error;
    }
  });

  res.status(resp.success ? 200 : 401).json(resp);
}));

export const ensureStoreAsaasAccount = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const result = await ensureStoreAsaasAccountForStore(storeSnap);
    await writeAsaasAudit("ensure-store-account", { uid, storeId });
    return result;
  });
});

export const getStoreAsaasStatus = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const forceRefresh = Boolean(req.data?.forceRefresh);
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) {
      const userSnap = await db.collection("users").doc(uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const storeFallback = {
        storeName: userData.storeName || userData.displayName || userData.name || null,
        name: userData.name || null,
        razaoSocial: userData.razaoSocial || null,
        cnpj: userData.cnpj || null,
        cpfCnpj: userData.cpfCnpj || null,
        phone: userData.phone || null,
        email: userData.email || null,
        ownerEmail: userData.ownerEmail || userData.email || null,
        addressZip: userData.addressZip || null,
        addressStreet: userData.addressStreet || null,
        addressNumber: userData.addressNumber || null,
        addressComplement: userData.addressComplement || null,
        addressNeighborhood: userData.addressNeighborhood || null,
        city: userData.city || null,
        state: userData.state || null,
        monthlyRevenue: userData.monthlyRevenue || null,
        asaasCompanyType: userData.asaasCompanyType || null
      };
      return { storeId, commercialInfo: userData.asaasCommercialInfo || null, store: storeFallback };
    }
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const summary = await fetchStoreAsaasSummary(storeSnap, apiKey, { forceRefresh });
    const steps = buildAsaasSteps(store, summary, true);

    return {
      storeId,
      ...summary,
      asaasSteps: steps
    };
  });
});

export const getStoreAsaasDocuments = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const docs = await listAccountDocuments(apiKey);
    const data = Array.isArray(docs?.data) ? docs.data : docs || [];
    await storeSnap.ref.update({
      asaasPendingDocuments: data,
      asaasOnboardingUrls: data
        .filter((doc: any) => doc?.onboardingUrl)
        .map((doc: any) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title || null,
          onboardingUrl: doc.onboardingUrl,
          onboardingUrlExpirationDate: doc.onboardingUrlExpirationDate || null
        })),
      asaasPendingDocumentsUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { storeId, documents: data };
  });
});

export const submitStoreAsaasDocument = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const documentId = String(req.data?.documentId || "");
    const payload = req.data?.payload || {};
    if (!storeId) throw new Error("storeId-required");
    if (!documentId) throw new Error("documentId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const fileUrl = typeof payload?.fileUrl === "string" ? payload.fileUrl : "";
    if (!fileUrl) throw new Error("fileUrl-required");
    const docType = typeof payload?.type === "string" ? payload.type : undefined;

    const response = await submitAccountDocumentFile(documentId, fileUrl, docType, apiKey);
    await storeSnap.ref.update({
      asaasLastDocumentSubmission: {
        documentId,
        submittedAt: FieldValue.serverTimestamp(),
        response
      },
      updatedAt: FieldValue.serverTimestamp()
    });

    return { storeId, documentId, response };
  });
});

export const getStoreAsaasDocumentFile = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const fileId = String(req.data?.fileId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!fileId) throw new Error("fileId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const response = await getAccountDocumentFile(fileId, apiKey);
    return { storeId, fileId, ...response };
  });
});

export const updateStoreAsaasDocumentFile = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const fileId = String(req.data?.fileId || "");
    const payload = req.data?.payload || {};
    if (!storeId) throw new Error("storeId-required");
    if (!fileId) throw new Error("fileId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const fileUrl = typeof payload?.fileUrl === "string" ? payload.fileUrl : "";
    if (!fileUrl) throw new Error("fileUrl-required");

    const response = await updateAccountDocumentFile(fileId, fileUrl, apiKey);
    return { storeId, fileId, response };
  });
});

export const deleteStoreAsaasDocumentFile = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const fileId = String(req.data?.fileId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!fileId) throw new Error("fileId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const response = await deleteAccountDocumentFile(fileId, apiKey);
    return { storeId, fileId, response };
  });
});

export const deleteStoreAsaasAccount = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    await storeSnap.ref.update({
      asaasDisabled: true,
      asaasDisabledReason: "manual-disconnect",
      asaasDisabledAt: FieldValue.serverTimestamp(),
      asaasAccountId: FieldValue.delete(),
      asaasWalletId: FieldValue.delete(),
      asaasAccountData: FieldValue.delete(),
      asaasAccountNumber: FieldValue.delete(),
      asaasAccountStatus: FieldValue.delete(),
      asaasPendingDocuments: FieldValue.delete(),
      asaasAccountDeletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { storeId, disconnected: true };
  });
});

export const disconnectStoreAsaasAccount = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    await storeSnap.ref.update({
      asaasDisabled: true,
      asaasDisabledReason: "manual-disconnect",
      asaasDisabledAt: FieldValue.serverTimestamp(),
      asaasAccountId: FieldValue.delete(),
      asaasWalletId: FieldValue.delete(),
      asaasAccountData: FieldValue.delete(),
      asaasAccountNumber: FieldValue.delete(),
      asaasAccountStatus: FieldValue.delete(),
      asaasPendingDocuments: FieldValue.delete(),
      asaasAccountDeletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { storeId, disconnected: true };
  });
});

export const asaasStoreDashboardSummary = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    const summary = await fetchStoreAsaasSummary(storeSnap, apiKey);
    return { storeId, ...summary };
  });
});

export const asaasAdminConnectStoreAccount = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const accountId = String(req.data?.asaasAccountId || req.data?.accountId || "");
    const providedApiKey = normalizeText(req.data?.apiKey || req.data?.accessToken);
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");
    if (!accountId && !providedApiKey) throw new Error("missing-asaas-credentials");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");

    let asaasApiKey = providedApiKey;
    let asaasAccountTokenData: any = null;
    if (accountId && !asaasApiKey) {
      const tokenResp = await createSubaccountAccessToken(accountId, { description: "MySnack admin" });
      asaasAccountTokenData = tokenResp || null;
      asaasApiKey = tokenResp?.accessToken || tokenResp?.apiKey || tokenResp?.token || null;
    }
    if (!asaasApiKey) throw new Error("asaas-token-unavailable");

    const wallets = await listWallets(asaasApiKey);
    const first = Array.isArray(wallets?.data) ? wallets.data[0] : wallets?.data || wallets?.wallets?.[0];
    const asaasWalletId = first?.id || null;
    const accountNumber = await getAccountNumber(asaasApiKey);
    const status = await getAccountStatus(asaasApiKey);

    const existing = storeSnap.data() || {};
    const resolvedAccountId = accountId || existing.asaasAccountId || null;
    const encrypted = asaasApiKey ? encryptToken(asaasApiKey) : null;
    const apiKeyLast4 = asaasApiKey ? String(asaasApiKey).slice(-4) : null;
    let remoteAccount: any = null;
    if (resolvedAccountId) {
      try {
        remoteAccount = await getSubaccount(String(resolvedAccountId));
      } catch {
        remoteAccount = null;
      }
    }

    await storeSnap.ref.update({
      asaasAccountId: resolvedAccountId || FieldValue.delete(),
      asaasWalletId: asaasWalletId || existing.asaasWalletId || FieldValue.delete(),
      asaasAccountData: {
        ...(resolvedAccountId ? { id: resolvedAccountId } : {}),
        ...(remoteAccount ? remoteAccount : {}),
        ...(encrypted ? { apiKeyEnc: encrypted.apiKeyEnc } : {}),
        ...(asaasApiKey ? { apiKey: asaasApiKey } : {}),
        ...(apiKeyLast4 ? { apiKeyLast4 } : {})
      },
      ...(asaasAccountTokenData ? { asaasAccountTokenData } : {}),
      ...(asaasApiKey ? { asaasApiKey } : {}),
      asaasAccountNumber: accountNumber?.accountNumber || accountNumber?.account_number || null,
      asaasAccountStatus: status || null,
      asaasAccountStatusUpdatedAt: FieldValue.serverTimestamp(),
      asaasSyncedAt: FieldValue.serverTimestamp(),
      asaasDisabled: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await writeAsaasAudit("admin-connect-account", {
      uid,
      storeId,
      asaasAccountId: resolvedAccountId
    });

    return {
      storeId,
      asaasAccountId: accountId || null,
      asaasWalletId,
      asaasAccountNumber: accountNumber?.accountNumber || accountNumber?.account_number || null,
      asaasAccountStatus: status || null
    };
  });
});

export const asaasAdminDisconnectStoreAccount = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const reason = normalizeText(req.data?.reason || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");

    await storeSnap.ref.update({
      asaasDisabled: true,
      asaasDisabledReason: reason || null,
      asaasDisabledAt: FieldValue.serverTimestamp(),
      "asaasAccountData.apiKeyEnc": FieldValue.delete(),
      "asaasAccountData.apiKey": FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await writeAsaasAudit("admin-disconnect-account", { uid, storeId, reason: reason || null });

    return { storeId, disconnected: true };
  });
});

export const asaasAdminListStoresSummary = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const shoppingId = normalizeText(req.data?.shoppingId || "");
    const storeIds = Array.isArray(req.data?.storeIds) ? req.data.storeIds.map((id: any) => String(id)) : [];
    const limit = Math.min(100, Number(req.data?.limit ?? 50));
    const forceRefresh = Boolean(req.data?.forceRefresh);
    const cacheKey = shoppingId || (storeIds.length ? `stores-${storeIds.join(",")}` : "all");
    const cacheRef = db.collection("asaasAdminSummaryCache").doc(cacheKey);
    const ttlMs = 120000;

    if (!forceRefresh) {
      const cached = await cacheRef.get();
      if (cached.exists) {
        const data = cached.data() || {};
        if (data.expiresAt?.toDate && data.expiresAt.toDate().getTime() > Date.now()) {
          return { items: data.items || [], cached: true };
        }
      }
    }

    let query: FirebaseFirestore.Query = db.collection("stores");
    if (shoppingId) query = query.where("shoppingId", "==", shoppingId);
    if (storeIds.length) query = query.where(FieldPath.documentId(), "in", storeIds.slice(0, 10));
    const snap = await query.limit(limit).get();

    const items = await mapWithConcurrency(snap.docs, 5, async (doc) => {
      const store = doc.data() || {};
      const apiKey = resolveStoreApiKey(store);
      let summary: any = null;
      if (apiKey) {
        try {
          summary = await fetchStoreAsaasSummary(doc, apiKey);
        } catch (error) {
          summary = { error: (error as Error).message };
        }
      }
      const pendingDocs = Array.isArray(summary?.asaasPendingDocuments) ? summary.asaasPendingDocuments.length : null;
      return {
        storeId: doc.id,
        storeName: store.displayName || store.storeName || store.name || "Loja",
        shoppingId: store.shoppingId || null,
        asaasAccountId: store.asaasAccountId || null,
        asaasWalletId: store.asaasWalletId || null,
        asaasAccountNumber: summary?.asaasAccountNumber || store.asaasAccountNumber || null,
        asaasAccountStatus: summary?.asaasAccountStatus || store.asaasAccountStatus || null,
        asaasBalance: summary?.asaasBalance || null,
        pendingDocumentsCount: pendingDocs,
        error: summary?.error || null
      };
    });

    await cacheRef.set({
      items,
      expiresAt: Timestamp.fromMillis(Date.now() + ttlMs),
      updatedAt: FieldValue.serverTimestamp(),
      ttlMs
    }, { merge: true });

    return { items, cached: false };
  });
});

export const asaasAdminGetMainBalance = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");
    const balance = await getMainBalance();
    return { balance: balance || null };
  });
});

export const asaasAdminEnsureWebhookConfigured = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const webhookUrl = normalizeText(process.env.ASAAS_WEBHOOK_URL);
    const webhookSecret = normalizeText(process.env.ASAAS_WEBHOOK_SECRET);
    if (!webhookUrl) throw new Error("asaas-webhook-url-required");
    if (!webhookSecret) throw new Error("asaas-webhook-secret-required");

    const webhooks = await listWebhooks();
    const data = Array.isArray(webhooks?.data) ? webhooks.data : webhooks || [];
    const existing = data.find((hook: any) => String(hook?.url || hook?.endpoint) === webhookUrl);

    const payload = {
      url: webhookUrl,
      email: req.data?.email || undefined,
      enabled: true,
      authToken: webhookSecret,
      sendType: req.data?.sendType || "SEQUENTIALLY",
      events: WEBHOOK_PAYMENT_EVENTS
    };

    const response = existing?.id
      ? await updateWebhook(String(existing.id), payload)
      : await createWebhook(payload);

    await writeAsaasAudit("admin-ensure-webhook", { uid, webhookUrl, webhookId: response?.id || existing?.id || null });

    return { configured: true, webhookId: response?.id || existing?.id || null, response };
  });
});

export const asaasAdminListWebhookEvents = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const status = normalizeText(req.data?.status || "");
    const paymentId = normalizeText(req.data?.paymentId || "");
    const limit = Math.min(100, Number(req.data?.limit ?? 50));

    let query: FirebaseFirestore.Query = db.collection("asaasWebhookEvents").orderBy("createdAt", "desc");
    if (status) query = query.where("status", "==", status);
    if (paymentId) query = query.where("paymentId", "==", paymentId);
    const snap = await query.limit(limit).get();

    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { items };
  });
});

export const asaasAdminRotateStoreToken = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!uid) throw new Error("auth-required");
    if (!storeId) throw new Error("storeId-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const accountId = store.asaasAccountId;
    if (!accountId) throw new Error("asaas-account-not-configured");

    const tokenResp = await createSubaccountAccessToken(String(accountId), { description: "MySnack rotation" });
    const newToken = tokenResp?.accessToken || tokenResp?.apiKey || tokenResp?.token || null;
    if (!newToken) throw new Error("asaas-token-unavailable");

    const encrypted = encryptToken(newToken);
    await storeSnap.ref.update({
      "asaasAccountData.apiKeyEnc": encrypted.apiKeyEnc,
      "asaasAccountData.apiKey": newToken,
      asaasApiKey: newToken,
      ...(tokenResp ? { asaasAccountTokenData: tokenResp } : {}),
      asaasTokenRotatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await writeAsaasAudit("admin-rotate-token", { uid, storeId, asaasAccountId: accountId });

    return { storeId, rotated: true };
  });
});

export const asaasAdminListAuditLogs = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const action = normalizeText(req.data?.action || "");
    const storeId = normalizeText(req.data?.storeId || "");
    const limit = Math.min(200, Number(req.data?.limit ?? 50));

    let query: FirebaseFirestore.Query = db.collection("asaasAuditLogs").orderBy("createdAt", "desc");
    if (action) query = query.where("action", "==", action);
    if (storeId) query = query.where("payload.storeId", "==", storeId);

    const snap = await query.limit(limit).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { items };
  });
});

export const asaasAdminListPaymentReconciliations = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const limit = Math.min(100, Number(req.data?.limit ?? 50));
    const onlyDiscrepancy = Boolean(req.data?.onlyDiscrepancy);

    const snap = await db.collection("paymentIntents").orderBy("createdAt", "desc").limit(limit).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const filtered = onlyDiscrepancy
      ? items.filter((item: any) => item.discrepancyCents != null && Math.abs(item.discrepancyCents) >= 2)
      : items;
    return { items: filtered };
  });
});

export const asaasAdminListPayments = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const limit = Math.min(200, Number(req.data?.limit ?? 50));
    const status = normalizeText(req.data?.status || "");
    const storeId = normalizeText(req.data?.storeId || "");
    const billingType = normalizeText(req.data?.billingType || "");
    const paymentMethod = normalizeText(req.data?.paymentMethod || "");
    const search = normalizeText(req.data?.search || "");

    const snap = await db.collection("paymentIntents").orderBy("createdAt", "desc").limit(limit).get();
    let items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (status) {
      items = items.filter((item: any) => String(item.status || "").toUpperCase() === status.toUpperCase());
    }
    if (storeId) {
      items = items.filter((item: any) => Array.isArray(item.storeIds) && item.storeIds.includes(storeId));
    }
    if (billingType) {
      items = items.filter((item: any) => String(item.billingType || "").toUpperCase() === billingType.toUpperCase());
    }
    if (paymentMethod) {
      items = items.filter((item: any) => String(item.paymentMethod || "").toLowerCase() === paymentMethod.toLowerCase());
    }
    if (search) {
      items = items.filter((item: any) => {
        const haystack = [
          item.id,
          item.paymentIntentId,
          item.asaasPaymentId,
          item.invoiceUrl
        ]
          .map((value) => String(value || "").toLowerCase())
          .join(" ");
        return haystack.includes(search.toLowerCase());
      });
    }

    return { items };
  });
});

export const asaasAdminReprocessWebhook = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const eventKey = String(req.data?.eventKey || "");
    if (!uid) throw new Error("auth-required");
    if (!eventKey) throw new Error("eventKey-required");

    const eventRef = db.collection("asaasWebhookEvents").doc(eventKey);
    const snap = await eventRef.get();
    if (!snap.exists) throw new Error("webhook-event-not-found");
    const data = snap.data() || {};
    const payload = data.payload;
    if (!payload) throw new Error("webhook-payload-missing");

    const result = await processWebhookPayload(payload);
    await eventRef.set({
      reprocessedAt: FieldValue.serverTimestamp(),
      reprocessCount: FieldValue.increment(1),
      status: result?.skipped ? "skipped" : "processed",
      result
    }, { merge: true });

    await writeAsaasAudit("admin-reprocess-webhook", { uid, eventKey });

    return { ok: true, result };
  });
});

export const getStoreAsaasCommercialInfo = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    const store = storeSnap.exists ? storeSnap.data() || {} : null;
    const { storeFallback, commercialInfo } = await buildCommercialFallback(uid, store);
    const apiKey = store ? resolveStoreApiKey(store) : null;
    if (!apiKey) {
      return { storeId, commercialInfo, store: storeFallback };
    }

    const info = await getAccountCommercialInfo(apiKey);
    await storeSnap.ref.update({
      asaasCommercialInfo: info || null,
      asaasCommercialInfoUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { storeId, commercialInfo: info || null, store: storeFallback };
  });
});

export const updateStoreAsaasCommercialInfo = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const payload = req.data?.payload || {};
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    const store = storeSnap.exists ? storeSnap.data() || {} : null;
    const apiKey = store ? resolveStoreApiKey(store) : null;
    if (!apiKey) {
      await db.collection("users").doc(uid).set({
        asaasCommercialInfo: payload || null,
        asaasCommercialInfoUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      if (storeSnap.exists) {
        await storeSnap.ref.update({
          asaasCommercialInfo: payload || null,
          asaasCommercialInfoUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return { storeId, commercialInfo: payload || null, localOnly: true };
    }

    const response = await updateAccountCommercialInfo(payload, apiKey);
    await storeSnap.ref.update({
      asaasCommercialInfo: response || null,
      asaasCommercialInfoUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { storeId, commercialInfo: response || null };
  });
});

export const listStoreAsaasBalance = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    try {
      const balance = await getBalance(apiKey);
      if (balance != null) {
        await storeSnap.ref.update({
          asaasBalance: balance,
          asaasBalanceUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return { storeId, balance: balance || null };
    } catch (error) {
      const cached = store.asaasBalance || null;
      return { storeId, balance: cached, cached: true, error: (error as Error).message };
    }
  });
});

export const listStoreAsaasTransactions = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    const storeId = String(req.data?.storeId || "");
    const limit = Math.min(100, Number(req.data?.limit ?? 20));
    const offset = Math.max(0, Number(req.data?.offset ?? 0));
    if (!storeId) throw new Error("storeId-required");
    if (!uid) throw new Error("auth-required");

    const storeSnap = await db.collection("stores").doc(storeId).get();
    if (!storeSnap.exists) throw new Error("store-not-found");
    const store = storeSnap.data() || {};
    const apiKey = resolveStoreApiKey(store);
    if (!apiKey) throw new Error("asaas-store-token-required");

    try {
      const response = await listFinancialTransactions(apiKey, { limit, offset });
      const transactions = response?.data || response || [];
      if (Array.isArray(transactions) && transactions.length > 0) {
        await storeSnap.ref.update({
          asaasLastTransactions: transactions,
          asaasLastTransactionsUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return { storeId, transactions, responseMeta: response };
    } catch (error) {
      const cached = Array.isArray(store.asaasLastTransactions) ? store.asaasLastTransactions : [];
      return { storeId, transactions: cached, responseMeta: null, cached: true, error: (error as Error).message };
    }
  });
});

export const syncExistingStoresWithAsaas = onCall(callableOptions, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid || null;
    if (!uid) throw new Error("auth-required");

    const shoppingId = normalizeText(req.data?.shoppingId || "");
    const storeIds = Array.isArray(req.data?.storeIds) ? req.data.storeIds.map((id: any) => String(id)) : [];
    let query: FirebaseFirestore.Query = db.collection("stores");
    if (shoppingId) query = query.where("shoppingId", "==", shoppingId);
    if (storeIds.length) query = query.where(FieldPath.documentId(), "in", storeIds.slice(0, 10));
    const snap = await query.get();

    const synced = await mapWithConcurrency(snap.docs, 3, async (doc) => {
      try {
        const result = await ensureStoreAsaasAccountForStore(doc);
        return { storeId: doc.id, ok: true, result };
      } catch (error) {
        return { storeId: doc.id, ok: false, error: (error as Error).message };
      }
    });

    return { count: synced.length, items: synced };
  });
});
