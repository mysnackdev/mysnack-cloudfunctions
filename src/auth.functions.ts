import { user } from "firebase-functions/v1/auth";
import { onCall } from "firebase-functions/v2/https";
import { db, rtdb } from "./shared/admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { handleErrors } from "./shared/errors.js";
import { normalizeRole, getDefaultStatusForRole } from "./shared/auth.js";

export const onUserCreate = user().onCreate(async (userRecord) => {
  const ref = db.collection("users").doc(userRecord.uid);
  const existing = await ref.get();
  if (existing.exists) return;
  const normalizedName = (userRecord.displayName || userRecord.email?.split("@")[0] || "Usuário").trim();
  const role = normalizeRole((userRecord.customClaims as any)?.role);
  await ref.set({
    email: userRecord.email,
    name: normalizedName || "Usuário",
    role,
    status: getDefaultStatusForRole(role),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
});

export const getUserProfile = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();

    const email = req.auth?.token?.email ?? null;
    const name = (req.auth?.token?.name ?? email ?? "Usuário").trim();
    const authRole = normalizeRole(req.auth?.token?.role);

    if (!snap.exists) {
      const role = authRole;
      const status = getDefaultStatusForRole(role);
      const nowIso = new Date().toISOString();
      await ref.set({
        email,
        name,
        role,
        status,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { id: uid, email, name, role, status, createdAt: nowIso, updatedAt: nowIso };
    }

    const data = snap.data() || {};
    const role = normalizeRole(data.role ?? authRole);
    const status = data.status || getDefaultStatusForRole(role);
    if (data.role !== role || data.status !== status) {
      await ref.set({ role, status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { id: snap.id, ...data, role, status };
  });
});

export const updateUserProfile = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");
    const payload = (req.data || {}) as any;
    if (!payload || typeof payload !== "object") throw new Error("invalid-payload");
    const updates: Record<string, unknown> = {};
    if (payload.name) updates.name = String(payload.name);
    if (payload.email) updates.email = String(payload.email);
    if (payload.phone) updates.phone = String(payload.phone);
    if (payload.photoURL) updates.photoURL = String(payload.photoURL);
    if (payload.role) updates.role = String(payload.role);
    if (payload.status) updates.status = String(payload.status);
    if (payload.document) updates.document = String(payload.document);
    if (payload.birthdate) updates.birthdate = String(payload.birthdate);
    if (payload.storeName) updates.storeName = String(payload.storeName);
    if (payload.razaoSocial) updates.razaoSocial = String(payload.razaoSocial);
    if (payload.cnpj) updates.cnpj = String(payload.cnpj).replace(/\D/g, "");
    if (payload.shoppingId) updates.shoppingId = String(payload.shoppingId);
    if (typeof payload.receiveOffers === "boolean") updates.receiveOffers = Boolean(payload.receiveOffers);
    if (payload.address && typeof payload.address === "object") updates.address = payload.address;
    updates.updatedAt = FieldValue.serverTimestamp();
    await db.collection("users").doc(uid).set(updates, { merge: true });
    return { ok: true };
  });
});

export const createUserProfile = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const authUid = req.auth?.uid;
    const data = (req.data || {}) as any;
    const uid = String(data.uid || authUid || "");
    if (!uid) throw new Error("uid-required");

    const email = data.email ? String(data.email).trim() : (req.auth?.token?.email ?? null);
    const rawName = data.name ?? req.auth?.token?.name ?? email ?? "Usuário";
    const name = String(rawName).trim() || "Usuário";
    const role = normalizeRole(data.role ?? req.auth?.token?.role);
    const statusInput = data.status ? String(data.status).trim() : "";
    const status = statusInput || getDefaultStatusForRole(role);
    const storeName = data.storeName ? String(data.storeName).trim() : null;
    const razaoSocial = data.razaoSocial ? String(data.razaoSocial).trim() : null;
    const cnpj = data.cnpj ? String(data.cnpj).replace(/\D/g, "") : null;
    const storeId = data.storeId
      ? String(data.storeId)
      : role === "store-owner" && cnpj
        ? cnpj
        : null;
    const shoppingId = data.shoppingId ? String(data.shoppingId) : null;
    const phone = data.phone ? String(data.phone) : null;
    const photoURL = data.photoURL ? String(data.photoURL) : null;
    const timestamp = new Date().toISOString();

    const userRef = db.collection("users").doc(uid);
    const existingSnapshot = await userRef.get();
    const timestamps: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (!existingSnapshot.exists) {
      timestamps.createdAt = FieldValue.serverTimestamp();
    }

    await userRef.set({
      email,
      name,
      role,
      status,
      phone,
      photoURL,
      storeName,
      razaoSocial,
      cnpj,
      storeId,
      shoppingId,
      ...timestamps,
    }, { merge: true });

    const now = Date.now();

    if (role === "store-owner") {
      await rtdb.ref(`storeOwners/${uid}`).set({
        fullName: name,
        storeName: storeName || null,
        razaoSocial: razaoSocial || null,
        cnpj: cnpj || null,
        email,
        status,
        updatedAt: now,
        createdAt: timestamp
      });
    } else if (role === "store-operator") {
      await rtdb.ref(`storeOperators/${uid}`).set({
        fullName: name,
        cnpj: cnpj || null,
        email,
        status,
        updatedAt: now,
        createdAt: timestamp
      });
    } else if (role === "waiter") {
      await rtdb.ref(`waiters/${uid}`).set({
        fullName: name,
        shoppingId: data.shoppingId || null,
        email,
        status,
        updatedAt: now,
        createdAt: timestamp
      });
    }

    return { ok: true };
  });
});

export const listOperatorApprovals = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const operatorSnap = await db.collection("users").doc(uid).get();
    if (!operatorSnap.exists) throw new Error("user-not-found");

    const operatorData = operatorSnap.data() || {};
    if (operatorData.role !== "store-owner") throw new Error("permission-denied");

    const cnpj = (operatorData.cnpj || "").toString();
    if (!cnpj) throw new Error("cnpj-not-found");

    const approvalsRef = rtdb.ref("operatorApprovals");
    const approvalsSnap = await approvalsRef.get();
    const items: Array<Record<string, any>> = [];

    approvalsSnap.forEach((child) => {
      const val = child.val() || {};
      if (val.cnpj === cnpj) {
        items.push({
          userId: child.key,
          ...val,
        });
      }
    });

    return {
      approvals: items.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")),
    };
  });
});

export const updateOperatorApproval = onCall({ region: "southamerica-east1" }, async (req) => {
  return handleErrors(async () => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("auth-required");

    const data = (req.data || {}) as any;
    const operatorId = String(data.operatorId || "");
    const action = String(data.action || "").toLowerCase();
    const reason = data.reason ? String(data.reason) : null;

    if (!operatorId) throw new Error("operator-required");
    if (!["approve", "reject", "suspend", "activate"].includes(action)) throw new Error("invalid-action");

    const ownerSnap = await db.collection("users").doc(uid).get();
    if (!ownerSnap.exists) throw new Error("user-not-found");
    const owner = ownerSnap.data() || {};
    if (owner.role !== "store-owner") throw new Error("permission-denied");

    const approvalRef = rtdb.ref(`operatorApprovals/${operatorId}`);
    const approvalSnap = await approvalRef.get();
    if (!approvalSnap.exists()) throw new Error("approval-not-found");

    const approvalData = approvalSnap.val() || {};
    if (approvalData.cnpj !== (owner.cnpj || "").toString()) throw new Error("cnpj-mismatch");

    const now = new Date().toISOString();
    const approverName = owner.name || "Operação";
    const storeId = owner.storeId || owner.cnpj || uid;
    const storeName = owner.storeName || owner.razaoSocial || approverName;

    const currentStatus = (approvalData.status || "").toString();

    if (action === "approve") {
      if (currentStatus === "approved") {
        return { ok: true };
      }
      await approvalRef.update({
        status: "approved",
        updatedAt: now,
        approverId: uid,
        approverName,
        storeId,
        storeName,
        reason: null
      });

      await db.collection("users").doc(operatorId).set({
        status: "approved",
        role: "store-operator",
        storeId,
        storeName,
        cnpj: owner.cnpj || null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await rtdb.ref(`storeOperators/${operatorId}`).update({
        status: "approved",
        updatedAt: now,
        storeId,
        storeName,
        reason: null
      });
    } else if (action === "suspend") {
      if (currentStatus !== "approved") throw new Error("suspend-not-allowed");

      await approvalRef.update({
        status: "suspended",
        updatedAt: now,
        approverId: uid,
        approverName,
        storeId,
        storeName,
        reason: reason || null,
      });

      await db.collection("users").doc(operatorId).set({
        status: "suspended",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await rtdb.ref(`storeOperators/${operatorId}`).update({
        status: "suspended",
        updatedAt: now,
        storeId,
        storeName,
        reason: reason || null
      });
    } else if (action === "activate") {
      if (currentStatus !== "suspended") throw new Error("activate-not-allowed");

      await approvalRef.update({
        status: "approved",
        updatedAt: now,
        approverId: uid,
        approverName,
        storeId,
        storeName,
        reason: null,
      });

      await db.collection("users").doc(operatorId).set({
        status: "approved",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await rtdb.ref(`storeOperators/${operatorId}`).update({
        status: "approved",
        updatedAt: now,
        storeId,
        storeName,
        reason: null
      });
    } else {
      await approvalRef.update({
        status: "rejected",
        updatedAt: now,
        approverId: uid,
        approverName,
        reason,
      });

      await db.collection("users").doc(operatorId).set({
        status: "rejected",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      await rtdb.ref(`storeOperators/${operatorId}`).update({
        status: "rejected",
        updatedAt: now,
        reason: reason || null
      });
    }

    return { ok: true };
  });
});
