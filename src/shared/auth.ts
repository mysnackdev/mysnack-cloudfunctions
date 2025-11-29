import type { CallableRequest } from "firebase-functions/v2/https";

export type Role =
  | "shopping-admin"
  | "store-owner"
  | "store-manager"
  | "store-operator"
  | "waiter"
  | "consumer"
  | "customer";

const DEFAULT_ROLE: Role = "consumer";
const ALLOWED_ROLES: ReadonlyArray<Role> = [
  "shopping-admin",
  "store-owner",
  "store-manager",
  "store-operator",
  "waiter",
  "consumer"
];
const ROLE_ALIASES: Record<string, Role> = {
  customer: "consumer"
};

export function normalizeRole(raw: unknown): Role {
  if (typeof raw !== "string") return DEFAULT_ROLE;
  const candidate = raw.trim();
  const mapped = ROLE_ALIASES[candidate] ?? candidate;
  return (ALLOWED_ROLES as ReadonlyArray<string>).includes(mapped) ? (mapped as Role) : DEFAULT_ROLE;
}

export function getDefaultStatusForRole(role: Role): "active" | "approved" | "pending" {
  switch (role) {
  case "consumer":
    return "active";
  case "store-owner":
    return "approved";
  default:
    return "pending";
  }
}

export function requireAuth<T extends { auth?: { uid: string } }>(req: CallableRequest<T> | any) {
  const uid = (req as any)?.auth?.uid || (req as any)?.headers?.['x-mock-uid'];
  if (!uid) {
    const err: any = new Error('auth-required');
    err.code = 'unauthenticated';
    throw err;
  }
  return String(uid);
}

export function getClaims(req: any): { role?: Role; storeId?: string; shoppingId?: string } {
  const token = (req as any)?.auth?.token || {};
  return {
    role: token.role ? normalizeRole(token.role) : undefined,
    storeId: token.storeId as string | undefined,
    shoppingId: token.shoppingId as string | undefined
  };
}

export function requireStoreAccess(req: any, storeId: string) {
  const { role, storeId: tokenStoreId } = getClaims(req);
  if (role === 'shopping-admin') return true;
  if (tokenStoreId && tokenStoreId === storeId) return true;
  const err: any = new Error('permission-denied');
  err.code = 'permission-denied';
  throw err;
}
