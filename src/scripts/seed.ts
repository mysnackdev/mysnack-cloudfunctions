import { db } from "../shared/admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import QRCode from "qrcode";

const QR_APP_BASE_URL = process.env.QR_APP_BASE_URL || "https://mysnack-client-6fb29.web.app";

function buildQrCodeData(mallId: string, storeId: string, tableNumber: number) {
  try {
    const url = new URL("/scan", QR_APP_BASE_URL);
    url.searchParams.set("mallId", mallId);
    url.searchParams.set("storeId", storeId);
    url.searchParams.set("table", String(tableNumber));
    url.searchParams.set("qr", `mysnack://table/${mallId}/${tableNumber}`);
    return url.toString();
  } catch (error) {
    console.error("[seed] Failed to build QR code URL", error);
    return `mysnack://table/${mallId}/${tableNumber}`;
  }
}

async function upsert(docRef: FirebaseFirestore.DocumentReference, data: any) {
  const snap = await docRef.get();
  if (snap.exists) {
    await docRef.set({ ...snap.data(), ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } else {
    await docRef.set({ ...data, createdAt: FieldValue.serverTimestamp() });
  }
}

async function seed() {
  // Categories (12 fixas)
  const categories = ["lanches","japonesa","pizza","doces","salgados","saudavel","bebidas","sobremesas","vegetariano","vegano","fit","acai"];
  for (const id of categories) {
    await upsert(db.collection("categories").doc(id), { id, name: id });
  }

  // Mall
  const mallRef = db.collection("malls").doc("mall-01");
  await upsert(mallRef, { name: "MySnack Shopping", city: "São Paulo", state: "SP", address: "Av. Central, 1000" });

  // Stores
  const stores = [
    { name: "Burger King", category: "lanches", rating: 4.5, deliveryTime: 20 },
    { name: "McDonald's", category: "lanches", rating: 4.4, deliveryTime: 18 },
    { name: "Spoleto", category: "massas", rating: 4.3, deliveryTime: 25 },
    { name: "Subway", category: "lanches", rating: 4.1, deliveryTime: 15 }
  ];
  const storeRefs: Record<string, string> = {};
  for (const s of stores) {
    const ref = db.collection("stores").doc();
    await upsert(ref, {
      ...s,
      shoppingId: mallRef.id,
      status: "active",
      config: { ordersEnabled: true, soundEnabled: true, autoAcceptOrders: false },
      deliveryConfig: { deliveryType: "table-only", tableDeliveryEnabled: true, externalDeliveryEnabled: false }
    });
    storeRefs[s.name] = ref.id;
  }

  // Products per store
  const sampleProducts: Record<string, Array<{name:string; price:number; category:string}>> = {
    "Burger King": [
      { name: "Whopper", price: 32.9, category: "lanches" },
      { name: "Batata Média", price: 12.9, category: "lanches" }
    ],
    "McDonald's": [
      { name: "Big Mac", price: 31.9, category: "lanches" },
      { name: "McFritas Média", price: 11.9, category: "lanches" }
    ],
    "Spoleto": [
      { name: "Massa ao Sugo", price: 29.9, category: "massas" }
    ],
    "Subway": [
      { name: "Sub Frango", price: 27.9, category: "lanches" }
    ]
  };
  for (const [storeName, items] of Object.entries(sampleProducts)) {
    const storeId = storeRefs[storeName];
    const menuRef = db.collection("menus").doc(storeId);
    const categoryRefs: Record<string, FirebaseFirestore.DocumentReference> = {};

    for (const p of items) {
      const categoryKey = p.category.toLowerCase();
      if (!categoryRefs[categoryKey]) {
        const categoryRef = menuRef.collection("categories").doc(categoryKey);
        await categoryRef.set(
          {
            name: p.category,
            available: true,
            order: Object.keys(categoryRefs).length,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        categoryRefs[categoryKey] = categoryRef;
      }

      await categoryRefs[categoryKey].collection("items").add({
        storeId,
        name: p.name,
        price: p.price,
        category: p.category,
        available: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  // Chairs ~20 per store with QR uploaded (best effort)
  const bucket = getStorage().bucket();
  for (const storeId of Object.values(storeRefs)) {
    for (let i=1;i<=20;i++) {
      const qrCodeData = buildQrCodeData(mallRef.id, storeId, i);
      let qrCodeUrl: string | undefined;
      try {
        const png = await QRCode.toBuffer(qrCodeData, { width: 512 });
        const filename = `qrcodes/${storeId}/table-${i}.png`;
        const file = bucket.file(filename);
        await file.save(png, { contentType: "image/png", resumable: false });
        qrCodeUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      } catch (e) {
        qrCodeUrl = await QRCode.toDataURL(qrCodeData);
      }
      await db.collection("chairs").add({
        storeId, tableNumber: i, qrCodeData, qrCodeUrl, active: true, createdAt: FieldValue.serverTimestamp()
      });
    }
  }

  // Promos
  for (const storeId of Object.values(storeRefs)) {
    await db.collection("promos").add({
      storeId, title: "Promo do Dia", description: "Desconto especial", price: 19.9, active: true, createdAt: FieldValue.serverTimestamp()
    });
  }

  // Users (roles) — OBS: ajuste UIDs depois conforme necessário
  const sampleUsers = [
    { uid: "admin-uid", role: "shopping-admin", email: "admin@mysnack.dev", name: "Admin" },
    { uid: "bk-operator", role: "store-operator", email: "bk@mysnack.dev", name: "BK Op", storeName: "Burger King" }
  ] as any[];
  for (const u of sampleUsers) {
    await upsert(db.collection("users").doc(u.uid), {
      email: u.email, name: u.name, role: u.role, storeId: u.storeName ? storeRefs[u.storeName] : null, status: "approved"
    });
  }

  // Orders examples
  const st = Object.values(storeRefs)[0];
  const items = [{ itemId: "p1", name: "Item Teste", price: 10, qty: 2 }];
  const subtotal = items.reduce((a,i)=>a+i.price*i.qty,0);
  const fee = +(subtotal * 0.08).toFixed(2);
  const total = +(subtotal + fee).toFixed(2);
  const orderIds: string[] = [];
  for (const status of ["pending","accepted","preparing","ready","on-the-way","delivered","cancelled"]) {
    const ref = await db.collection("orders").add({
      storeId: st, orderNumber: `${Math.floor(Math.random()*100000)}`, status,
      tableNumber: 1, items, subtotal, fee, total, paymentMethod: "card", createdAt: FieldValue.serverTimestamp()
    });
    orderIds.push(ref.id);
  }

  // Notifications examples
  for (const id of ["admin-uid","bk-operator"]) {
    await db.collection("notifications").add({
      userId: id, type: "system", title: "Bem-vindo", message: "MySnack pronto!", read: false, createdAt: FieldValue.serverTimestamp()
    });
  }

  console.log("Seed concluído.");
}

seed().then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(1); });
