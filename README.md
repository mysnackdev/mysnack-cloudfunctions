# MySnack Cloud Functions (Gen2) — API & Setup

**Projeto Firebase**: `my-snack-e52ae`  
**Região**: `southamerica-east1`  
**Firestore DB Id**: `db-my-snack` (não usar `(default)`)  
**RTDB Emulator Porta**: `9001`

> A mesma Functions atende **client** e **backoffice**. Todas as rotas HTTP abaixo têm equivalentes **Callable** com o mesmo nome sem `/api/`.

---

## 🔌 Base URLs

- **Emulador**: `http://127.0.0.1:5001/my-snack-e52ae/southamerica-east1/api`
- **Produção** (Hosting): `https://<seu-domínio>/api` (rewrite para `apiGateway`).

---

## 🧰 Endpoints HTTP

### A) QR / Malls / Tables
- `GET /getMallByQRCode?qr=mysnack://table/{mallId}/{tableNumber}`
- `GET /getTableInfo?qr=mysnack://table/{mallId}/{tableNumber}`
- `POST /validateTable` → `{ qr }`

### B) Stores
- `GET /getStores?page=1&pageSize=20`
- `GET /getStore?storeId=<id>`
- `GET /getStoresByCategory?category=<id>&page=1&pageSize=20`
- `GET /getFeaturedStores?limit=8`

### C) Products
- `GET /getProductsByStore?storeId=<id>`
- `GET /getProduct?productId=<id>`
- `GET /searchProducts?query=<q>`
- `GET /getProductsByCategory?category=<id>`
- `GET /getFeaturedProducts?limit=12`
- `GET /getCheapDeals?limit=12`

### D) Orders
- `GET /getUserOrders` *(autenticado)*
- `GET /getOrders?storeId=<id>&status=pending&status=accepted&limit=50`
- `GET /getOrder?orderId=<id>`
- `POST /createOrder` → `{ storeId, tableNumber, items[], paymentMethod, notes? }`
- `POST /updateOrderStatus` → `{ orderId, status, cancelReason? }`
- `POST /cancelOrder` → `{ orderId, reason? }`
- `GET /getActiveOrders?storeId=<id>`
- `GET /getOrderHistory?storeId=<id>`
- `GET /getOrdersStats?storeId=<id>`

### E) Menus
- `GET /getMenu?storeId=<id>`
- `POST /createMenuCategory`
- `POST /updateMenuCategory`
- `POST /deleteMenuCategory`
- `POST /createMenuItem`
- `POST /updateMenuItem`
- `POST /deleteMenuItem`
- `POST /toggleItemAvailability`
- `POST /toggleCategoryAvailability`

### F) Chairs (Mesas)
- `GET /getChairs?storeId=<id>`
- `POST /createChair`
- `POST /updateChair`
- `POST /deleteChair`
- `POST /generateChairQRCode`

### G) Notifications
- `GET /getUserNotifications` *(autenticado)*
- `POST /markNotificationAsRead`

### H) Promos
- `GET /getActivePromos`
- `GET /getPromosByStore?storeId=<id>`

### I) Auth / Perfil (Callables)
- `getUserProfile`, `updateUserProfile`
- Triggers: `onUserCreate` → cria `/users/{uid}`

---

## 📦 Resposta padrão (`ApiResponse`)

```jsonc
{ "success": true,  "data": { ... }, "message": "ok" }
// ou
{ "success": false, "error": { "code": "string", "message": "string", "details": {} } }
```

---

## 🧪 cURL — Exemplos

```sh
# Stores (lista)
curl "$API/getStores?page=1&pageSize=20"

# Produto específico
curl "$API/getProduct?productId=abc123"

# Buscar produtos por nome
curl "$API/searchProducts?query=big%20mac"

# Criar pedido
curl -X POST "$API/createOrder" -H "Content-Type: application/json" -d '{
  "storeId":"STORE_ID",
  "tableNumber":12,
  "items":[{"itemId":"p1","name":"Whopper","price":32.9,"qty":1}],
  "paymentMethod":"card"
}'

# Atualizar status
curl -X POST "$API/updateOrderStatus" -H "Content-Type: application/json" -d '{
  "orderId":"ORDER_ID",
  "status":"preparing"
}'
```

> **Auth**: endpoints que exigem usuário usam `req.auth` (em produção via Firebase Auth). Em dev, você pode simular com header `x-mock-uid: <uid>` se necessário.

---

## ⚙️ Setup — Emuladores

```bash
cd functions
npm i
npm run build
firebase emulators:start --only functions,firestore,database,auth
# (opcional) seed
npm run seed
```

**Vars úteis**:
```
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
FIRESTORE_DB_ID=db-my-snack
DATABASE_URL=https://my-snack-e52ae-default-rtdb.firebaseio.com
```

---

## 🔐 Regras & Índices

- Firestore **(databaseId: `db-my-snack`)** — regras já incluídas em `firestore.rules` (apenas leitura pública para catálogos; `orders` somente via Functions; `users` dono/admin).
- Índices essenciais em `firestore.indexes.json`:
  - `orders`: `storeId ASC, status ASC, createdAt DESC`
  - `products`: `storeId ASC, available ASC, category ASC`
  - `stores`: `category ASC, status ASC, name ASC`

---

## ✅ TypeScript (strict) — checagem

Ativei **strict** e adicionei script de typecheck:

```bash
npm run typecheck
# ou
tsc -p tsconfig.json --noEmit
```

> Corrija quaisquer mensagens reportadas; o build (`npm run build`) deve permanecer verde.

---

## 🧭 Convenções

- **Gen2 Functions** (`v2/https`, `v2/auth`, `v2/firestore`).
- **HTTP + Callable** sempre com mesma lógica interna.
- **CORS** a partir da env `ALLOWED_ORIGINS`.
- **Taxa**: 8% por pedido (calculada no backend).

---

Boas-vindas ao MySnack 🚀
