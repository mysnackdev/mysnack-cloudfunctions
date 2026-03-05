import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { Query, DocumentData } from "firebase-admin/firestore";
import { db, FIRESTORE_DATABASE_ID } from "./shared/admin.js";
import { syncOrderToRealtime } from "./shared/realtime-orders.js";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";

export const getUserNotificationsHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const uid = (req as any).auth?.uid || req.headers["x-mock-uid"];
    const sessionHeader = req.headers["x-session-id"];
    const sessionId =
      (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ||
      (typeof req.query?.sessionId === "string" ? req.query.sessionId : undefined);

    if (!uid && !sessionId) throw new Error("auth required");

    const after = String(req.query.after || "").trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));

    let baseQuery: Query<DocumentData> = db.collection("notifications");
    if (uid) {
      baseQuery = baseQuery.where("userId","==",uid);
    } else if (sessionId) {
      baseQuery = baseQuery.where("sessionId","==",sessionId);
    }
    baseQuery = baseQuery.orderBy("createdAt","desc").limit(limit);

    if (after) {
      const afterDoc = await db.collection("notifications").doc(after).get();
      if (afterDoc.exists) {
        baseQuery = baseQuery.startAfter(afterDoc);
      }
    }

    let snap = await baseQuery.get();
    if (uid && snap.empty && sessionId) {
      const fallbackQuery = db.collection("notifications")
        .where("sessionId","==",sessionId)
        .orderBy("createdAt","desc")
        .limit(limit);
      snap = await fallbackQuery.get();
    }
    const olderThan = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    const moreQuery = olderThan
      ? await db.collection("notifications")
        .where(uid && !snap.empty ? "userId" : "sessionId","==", uid && !snap.empty ? uid : sessionId)
        .orderBy("createdAt","desc")
        .startAfter(olderThan)
        .limit(1)
        .get()
      : null;

    return {
      items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
      hasMore: Boolean(moreQuery && !moreQuery.empty)
    };
  });
  res.status(resp.success ? 200 : 401).json(resp);
}));

export const markNotificationAsReadHttp = onRequest({ region: "southamerica-east1" }, withCors(async (req: Request, res: Response) => {
  const resp = await handleErrors(async () => {
    const payload = req.body || {};
    const id = payload.id || payload.notificationId;
    if (!id) throw new Error("id required");
    await db.collection("notifications").doc(String(id)).update({
      read: true,
      readAt: FieldValue.serverTimestamp()
    });
    return { ok: true };
  });
  res.status(resp.success ? 200 : 400).json(resp);
}));

const firestoreTriggerOptions = {
  document: "orders/{orderId}",
  database: FIRESTORE_DATABASE_ID,
};

export const onOrderCreate = onDocumentCreated(firestoreTriggerOptions, async (event) => {
  const data: any = event.data?.data();
  if (!data) return;
  const storeId = data.storeId;
  const usersSnap = await db.collection("users").where("storeId","==",storeId).get();
  const batch = db.batch();
  usersSnap.docs.forEach(u => {
    const nref = db.collection("notifications").doc();
    batch.set(nref, {
      userId: u.id,
      type: "new-order",
      title: "Novo pedido",
      message: `Pedido #${data.orderNumber} recebido`,
      read: false,
      data: { orderId: event.params?.orderId, storeId },
      createdAt: FieldValue.serverTimestamp()
    });
  });

  if (data.customerId) {
    const customerNotificationRef = db.collection("notifications").doc();
    batch.set(customerNotificationRef, {
      userId: data.customerId,
      type: "order-status-change",
      title: "Pedido recebido",
      message: `Seu pedido #${data.orderNumber} foi recebido pela loja ${data.storeName || ""}.`,
      read: false,
      data: {
        orderId: event.params?.orderId,
        status: data.status ?? "pending",
        storeId,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  if (!data.customerId && data.customerSessionId) {
    const sessionNotificationRef = db.collection("notifications").doc();
    batch.set(sessionNotificationRef, {
      sessionId: data.customerSessionId,
      type: "order-status-change",
      title: "Pedido recebido",
      message: `Seu pedido #${data.orderNumber} foi recebido pela loja ${data.storeName || ""}.`,
      read: false,
      data: {
        orderId: event.params?.orderId,
        status: data.status ?? "pending",
        storeId,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  if (event.params?.orderId) {
    await syncOrderToRealtime(event.params.orderId, data, { isNew: true });
  }
});

export const onOrderStatusChange = onDocumentUpdated(firestoreTriggerOptions, async (event) => {
  const before: any = event.data?.before.data();
  const after: any = event.data?.after.data();
  if (!before || !after) return;
  if (event.params?.orderId) {
    await syncOrderToRealtime(event.params.orderId, after, {
      previousStatus: before.status,
      isNew: false
    });
  }
  if (before.status === after.status) return;
  const storeId = after.storeId;
  const usersSnap = await db.collection("users").where("storeId","==",storeId).get();
  const batch = db.batch();
  const statusMessage = statusToFriendlyMessage(after.status);
  usersSnap.docs.forEach(u => {
    const nref = db.collection("notifications").doc();
    batch.set(nref, {
      userId: u.id,
      type: "order-status-change",
      title: "Status do pedido atualizado",
      message: `Pedido #${after.orderNumber}: ${after.status}`,
      read: false,
      data: { orderId: event.params?.orderId, status: after.status },
      createdAt: FieldValue.serverTimestamp()
    });
  });

  if (after.customerId) {
    const customerNotificationRef = db.collection("notifications").doc();
    batch.set(customerNotificationRef, {
      userId: after.customerId,
      type: "order-status-change",
      title: "Atualização do seu pedido",
      message: statusMessage
        ? `Pedido #${after.orderNumber}: ${statusMessage}`
        : `Pedido #${after.orderNumber} agora está ${after.status}.`,
      read: false,
      data: {
        orderId: event.params?.orderId,
        status: after.status,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  } else if (after.customerSessionId) {
    const sessionNotificationRef = db.collection("notifications").doc();
    batch.set(sessionNotificationRef, {
      sessionId: after.customerSessionId,
      type: "order-status-change",
      title: "Atualização do seu pedido",
      message: statusMessage
        ? `Pedido #${after.orderNumber}: ${statusMessage}`
        : `Pedido #${after.orderNumber} agora está ${after.status}.`,
      read: false,
      data: {
        orderId: event.params?.orderId,
        status: after.status,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
});

function statusToFriendlyMessage(status: string) {
  switch (status) {
    case "accepted":
      return "seu pedido foi confirmado pela loja";
    case "preparing":
      return "a loja está preparando seu pedido";
    case "ready":
      return "seu pedido ficou pronto";
    case "on-the-way":
      return "o pedido está a caminho da sua mesa";
    case "delivered":
      return "seu pedido foi entregue";
    case "cancelled":
      return "seu pedido foi cancelado";
    default:
      return null;
  }
}
