import crypto from "crypto";

type AsaasConfig = {
  apiKey: string;
  baseUrl: string;
};

const DEFAULT_BASE_URL = "https://api.asaas.com/v3";

function resolveConfig(apiKeyOverride?: string): AsaasConfig {
  const apiKey = apiKeyOverride || "$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmUwNGQzODRkLTE3MmYtNDY2OS04ZDMyLWEzNTE0OWJjN2ZlODo6JGFhY2hfODI2MTcyMjAtZjZhZS00ODc5LWJkZDYtODhkMGYwMWU5NWMx";
  if (!apiKey) throw new Error("missing-asaas-api-key");
  const baseUrl = process.env.ASAAS_BASE_URL || DEFAULT_BASE_URL;
  return { apiKey, baseUrl };
}

async function asaasRequest<T>(
  path: string,
  options: RequestInit = {},
  apiKeyOverride?: string
): Promise<T> {
  const config = resolveConfig(apiKeyOverride);
  const url = `${config.baseUrl}${path}`;
  const headers = new Headers(options.headers as any);
  const FormDataCtor = (globalThis as any)?.FormData;
  const isFormData = FormDataCtor && options.body instanceof FormDataCtor;
  if (!isFormData) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("access_token", config.apiKey);

  const res = await fetch(url, {
    ...options,
    headers
  });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.errors?.[0]?.description || body?.message || "asaas-request-failed";
    const error: any = new Error(String(message));
    error.code = body?.errors?.[0]?.code || res.status;
    error.details = body;
    throw error;
  }
  return body as T;
}

async function asaasFileRequest(
  path: string,
  options: RequestInit = {},
  apiKeyOverride?: string
): Promise<{ contentType: string; dataBase64: string }> {
  const config = resolveConfig(apiKeyOverride);
  const url = `${config.baseUrl}${path}`;
  const headers = new Headers(options.headers as any);
  headers.set("access_token", config.apiKey);

  const res = await fetch(url, {
    ...options,
    headers
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    const message = body?.errors?.[0]?.description || body?.message || "asaas-request-failed";
    const error: any = new Error(String(message));
    error.code = body?.errors?.[0]?.code || res.status;
    error.details = body;
    throw error;
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { contentType, dataBase64: buffer.toString("base64") };
}

export function verifyWebhookToken(headerValue?: string | string[]): boolean {
  const secret = process.env.ASAAS_WEBHOOK_SECRET || "";
  if (!secret || !headerValue) return false;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}

export async function createSubaccount(payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>("/accounts", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function createSubaccountAccessToken(accountId: string, payload: Record<string, any> = {}) {
  return asaasRequest<Record<string, any>>(`/accounts/${accountId}/accessTokens`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getSubaccount(accountId: string) {
  return asaasRequest<Record<string, any>>(`/accounts/${accountId}`, { method: "GET" });
}


export async function createCharge(payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>("/payments", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function createCustomer(payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>("/customers", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateCustomer(customerId: string, payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>(`/customers/${customerId}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateCharge(paymentId: string, payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>(`/payments/${paymentId}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getCharge(paymentId: string) {
  return asaasRequest<Record<string, any>>(`/payments/${paymentId}`, { method: "GET" });
}

export async function getPixQrCode(paymentId: string) {
  return asaasRequest<Record<string, any>>(`/payments/${paymentId}/pixQrCode`, { method: "GET" });
}

export async function tokenizeCreditCard(payload: Record<string, any>) {
  try {
    return await asaasRequest<Record<string, any>>("/creditCard/tokenizeCreditCard", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return await asaasRequest<Record<string, any>>("/creditCard/tokenize", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }
}

// Subaccount endpoints (use apiKeyOverride from subaccount)
export async function getAccountStatus(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/myAccount/status", { method: "GET" }, apiKeyOverride);
}

export async function getAccountCommercialInfo(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/myAccount/commercialInfo", { method: "GET" }, apiKeyOverride);
}

export async function updateAccountCommercialInfo(payload: Record<string, any>, apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/myAccount/commercialInfo", {
    method: "POST",
    body: JSON.stringify(payload)
  }, apiKeyOverride);
}

export async function listAccountDocuments(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/myAccount/documents", { method: "GET" }, apiKeyOverride);
}

export async function submitAccountDocumentFile(
  documentId: string,
  fileUrl: string,
  type: string | undefined,
  apiKeyOverride: string
) {
  const FormDataCtor = (globalThis as any)?.FormData;
  if (!FormDataCtor) throw new Error("form-data-not-supported");
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error("document-download-failed");
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const data = await response.arrayBuffer();
  const fileName = fileUrl.split("/").pop() || "document";
  const BlobCtor = (globalThis as any)?.Blob;
  const blob = BlobCtor ? new BlobCtor([data], { type: contentType }) : data;
  const form = new FormDataCtor();
  form.append("documentFile", blob as any, fileName);
  if (type) form.append("type", type);
  return asaasRequest<Record<string, any>>(`/myAccount/documents/${documentId}`, {
    method: "POST",
    body: form
  }, apiKeyOverride);
}

export async function getAccountDocumentFile(fileId: string, apiKeyOverride: string) {
  return asaasFileRequest(`/myAccount/documents/files/${fileId}`, { method: "GET" }, apiKeyOverride);
}

export async function updateAccountDocumentFile(fileId: string, fileUrl: string, apiKeyOverride: string) {
  const FormDataCtor = (globalThis as any)?.FormData;
  if (!FormDataCtor) throw new Error("form-data-not-supported");
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error("document-download-failed");
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const data = await response.arrayBuffer();
  const fileName = fileUrl.split("/").pop() || "document";
  const BlobCtor = (globalThis as any)?.Blob;
  const blob = BlobCtor ? new BlobCtor([data], { type: contentType }) : data;
  const form = new FormDataCtor();
  form.append("documentFile", blob as any, fileName);
  return asaasRequest<Record<string, any>>(`/myAccount/documents/files/${fileId}`, {
    method: "POST",
    body: form
  }, apiKeyOverride);
}

export async function deleteAccountDocumentFile(fileId: string, apiKeyOverride: string) {
  return asaasRequest(`/myAccount/documents/files/${fileId}`, { method: "DELETE" }, apiKeyOverride);
}

export async function getAccountNumber(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/myAccount/accountNumber", { method: "GET" }, apiKeyOverride);
}

export async function listWallets(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/wallets", { method: "GET" }, apiKeyOverride);
}

export async function getBalance(apiKeyOverride: string) {
  return asaasRequest<Record<string, any>>("/finance/balance", { method: "GET" }, apiKeyOverride);
}

export async function getMainBalance() {
  return asaasRequest<Record<string, any>>("/finance/balance", { method: "GET" });
}

export async function listFinancialTransactions(apiKeyOverride: string, params: { limit?: number; offset?: number } = {}) {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.offset != null) query.set("offset", String(params.offset));
  const suffix = query.toString();
  return asaasRequest<Record<string, any>>(`/financialTransactions${suffix ? `?${suffix}` : ""}`, { method: "GET" }, apiKeyOverride);
}

export async function listWebhooks() {
  return asaasRequest<Record<string, any>>("/webhooks", { method: "GET" });
}

export async function createWebhook(payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>("/webhooks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateWebhook(webhookId: string, payload: Record<string, any>) {
  return asaasRequest<Record<string, any>>(`/webhooks/${webhookId}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
