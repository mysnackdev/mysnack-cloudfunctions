import { onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { withCors } from "./shared/cors.js";
import { handleErrors } from "./shared/errors.js";

// Stores
import { getStoresHttp, getStoreHttp, getStoresByCategoryHttp, getFeaturedStoresHttp, getStoreCategoriesHttp } from "./stores.js";
// Products
import { getProductsByStoreHttp, getProductHttp, searchProductsHttp, getProductsByCategoryHttp, getFeaturedProductsHttp, getCheapDealsHttp } from "./products.js";
// Orders
import { getUserOrdersHttp, getOrdersHttp, getOrderHttp, createOrderHttp, updateOrderStatusHttp, cancelOrderHttp, getActiveOrdersHttp, getOrderHistoryHttp, getOrdersStatsHttp } from "./orders.js";
// Menus
import { getMenuHttp, createMenuCategoryHttp, updateMenuCategoryHttp, deleteMenuCategoryHttp, createMenuItemHttp, updateMenuItemHttp, deleteMenuItemHttp, toggleItemAvailabilityHttp, toggleCategoryAvailabilityHttp } from "./menus.js";
// Chairs
import { getChairsHttp, createChairHttp, updateChairHttp, deleteChairHttp, generateChairQRCodeHttp } from "./chairs.js";
// Notifications (HTTP)
import { getUserNotificationsHttp, markNotificationAsReadHttp } from "./notifications.js";
// Malls / Tables
import { getMallByQRCodeHttp, getTableInfoHttp, validateTableHttp, listMallsHttp, getMallPaymentMethodsHttp, getMallHttp } from "./malls.js";
import { createPaymentHttp, getPaymentStatusHttp, asaasWebhookHttp } from "./payments.js";

const handler = withCors(async (req: Request, res: Response) => {
  const p = req.path.replace(/^\/api\/?/, "").replace(/^\//, "").split("?")[0];

  const routes: Record<string, (req: Request, res: Response) => void | Promise<void>> = {
    // Stores
    "getStores": getStoresHttp,
    "getStore": getStoreHttp,
    "getStoresByCategory": getStoresByCategoryHttp,
    "getFeaturedStores": getFeaturedStoresHttp,
    "getStoreCategories": getStoreCategoriesHttp,
    // Products
    "getProductsByStore": getProductsByStoreHttp,
    "getProduct": getProductHttp,
    "searchProducts": searchProductsHttp,
    "getProductsByCategory": getProductsByCategoryHttp,
    "getFeaturedProducts": getFeaturedProductsHttp,
    "getCheapDeals": getCheapDealsHttp,
    // Orders
    "getUserOrders": getUserOrdersHttp,
    "getOrders": getOrdersHttp,
    "getOrder": getOrderHttp,
    "createOrder": createOrderHttp,
    "updateOrderStatus": updateOrderStatusHttp,
    "cancelOrder": cancelOrderHttp,
    "getActiveOrders": getActiveOrdersHttp,
    "getOrderHistory": getOrderHistoryHttp,
    "getOrdersStats": getOrdersStatsHttp,
    // Payments (Asaas)
    "createPayment": createPaymentHttp,
    "getPaymentStatus": getPaymentStatusHttp,
    "asaasWebhook": asaasWebhookHttp,
    // Menus
    "getMenu": getMenuHttp,
    "createMenuCategory": createMenuCategoryHttp,
    "updateMenuCategory": updateMenuCategoryHttp,
    "deleteMenuCategory": deleteMenuCategoryHttp,
    "createMenuItem": createMenuItemHttp,
    "updateMenuItem": updateMenuItemHttp,
    "deleteMenuItem": deleteMenuItemHttp,
    "toggleItemAvailability": toggleItemAvailabilityHttp,
    "toggleCategoryAvailability": toggleCategoryAvailabilityHttp,
    // Chairs
    "getChairs": getChairsHttp,
    "createChair": createChairHttp,
    "updateChair": updateChairHttp,
    "deleteChair": deleteChairHttp,
    "generateChairQRCode": generateChairQRCodeHttp,
    // Notifications
    "getUserNotifications": getUserNotificationsHttp,
    "markNotificationAsRead": markNotificationAsReadHttp,
    // Malls/Tables
    "getMallByQRCode": getMallByQRCodeHttp,
    "getMall": getMallHttp,
    "getTableInfo": getTableInfoHttp,
    "validateTable": validateTableHttp,
    "listMalls": listMallsHttp,
    "getMallPaymentMethods": getMallPaymentMethodsHttp,
  };

  const routeHandler = routes[p];
  if (!routeHandler) {
    const notFound = await handleErrors(async () => {
      throw new Error(`Rota não encontrada: ${p}`);
    });
    res.status(404).json(notFound);
    return;
  }

  await routeHandler(req, res);
});

export const apiGateway = onRequest({ region: "southamerica-east1" }, handler);
export const api = onRequest({ region: "southamerica-east1" }, handler);

export { onUserCreate, getUserProfile, updateUserProfile, createUserProfile, listOperatorApprovals, updateOperatorApproval } from "./auth.functions.js";
export { onOrderCreate, onOrderStatusChange } from "./notifications.js";

export * from "./stores.js";
export * from "./products.js";
export * from "./orders.js";
export * from "./menus.js";
export * from "./chairs.js";
export * from "./promos.js";
export * from "./malls.js";
export * from "./payments.js";
