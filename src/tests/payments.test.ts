import assert from "node:assert/strict";

process.env.FIREBASE_DATABASE_URL ||= "http://127.0.0.1:9000?ns=demo-test";
process.env.FIREBASE_CONFIG ||= JSON.stringify({
  projectId: "demo-test",
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const {
  buildSubaccountPayload,
  computeSplitCents,
  getWebhookEventKey,
  hashPayload,
  normalizeIntentItem,
  resolvePaymentFeeConfig
} = await import("../payments.js");

type StoreTotals = {
  storeId: string;
  storeName: string;
  items: any[];
  subtotalCents: number;
  walletId: string;
};

const makeStore = (storeId: string, subtotalCents: number): StoreTotals => ({
  storeId,
  storeName: storeId,
  items: [],
  subtotalCents,
  walletId: `wallet-${storeId}`
});

const testSingleStoreSplit = () => {
  const subtotalCents = 10000;
  const totalCents = subtotalCents + 800 + 99;
  const split = computeSplitCents([makeStore("s1", subtotalCents)], totalCents, {
    fixedFeeCents: 99,
    cardFeeRate: 0
  });
  const fixedTotal = split.storeSplits.reduce((acc, item) => acc + item.fixedValueCents, 0);
  assert.ok(split.platform.expectedPlatformNetCents >= 0);
  assert.equal(fixedTotal + split.platform.platformShareCents + split.platform.expectedPlatformRemainderCents, totalCents);
  assert.ok(split.storeSplits[0].fixedValueCents > 0);
};

const testMultiStoreSplit = () => {
  const stores = [makeStore("s1", 6000), makeStore("s2", 4000)];
  const subtotalCents = 10000;
  const totalCents = subtotalCents + 800 + 99;
  const split = computeSplitCents(stores, totalCents, {
    fixedFeeCents: 99,
    cardFeeRate: 0
  });
  const fixedTotal = split.storeSplits.reduce((acc, item) => acc + item.fixedValueCents, 0);
  assert.equal(split.platform.platformShareCents, 899);
  assert.equal(fixedTotal + split.platform.platformShareCents + split.platform.expectedPlatformRemainderCents, totalCents);
  assert.equal(split.ledger.totalCents, totalCents);
};

const testWebhookKey = () => {
  const payload = { eventId: "evt_123", payment: { id: "pay_1" } };
  assert.equal(getWebhookEventKey(payload), "evt_123");
  const payloadNoId = { payment: { id: "pay_2" } };
  assert.equal(getWebhookEventKey(payloadNoId), hashPayload(payloadNoId));
};

const testIntegralFeeConfig = () => {
  const pixConfig = resolvePaymentFeeConfig("pix");
  const creditConfig = resolvePaymentFeeConfig("credit");
  assert.equal(pixConfig.fixedFeeCents, 99);
  assert.equal(creditConfig.fixedFeeCents, 99);
};

const testNormalizeIntentItemPreservesDescriptionAndNotes = () => {
  const normalized = normalizeIntentItem({
    itemId: "p1",
    productId: "p1",
    name: "Trio Chicken",
    price: 5,
    qty: 2,
    description: "Hamburguer de frango, maionese, alface e tomate",
    notes: "sem cebola"
  });
  assert.equal(normalized.description, "Hamburguer de frango, maionese, alface e tomate");
  assert.equal(normalized.notes, "sem cebola");
  assert.equal(normalized.qty, 2);
};

const testNormalizeIntentItemSupportsLegacyAliases = () => {
  const normalized = normalizeIntentItem({
    id: "prod-22",
    title: "Coca Cola",
    price: "4.00",
    quantity: "1",
    productDescription: "teste descricao",
    observacao: "com gelo"
  });
  assert.equal(normalized.itemId, "prod-22");
  assert.equal(normalized.productId, "prod-22");
  assert.equal(normalized.name, "Coca Cola");
  assert.equal(normalized.description, "teste descricao");
  assert.equal(normalized.notes, "com gelo");
};

const testBuildSubaccountPayloadPrefersCommercialCityState = () => {
  const payload = buildSubaccountPayload({
    cnpj: "12.345.678/0001-99",
    city: "Loja Cidade",
    state: "RJ",
    asaasCommercialInfo: {
      companyName: "Empresa XPTO",
      email: "empresa@xpto.com",
      city: "Comercial Cidade",
      state: "SP"
    }
  });
  assert.equal(payload.city, "Comercial Cidade");
  assert.equal(payload.state, "SP");
};

const testBuildSubaccountPayloadFallsBackToStoreCityState = () => {
  const payload = buildSubaccountPayload({
    cpfCnpj: "123.456.789-09",
    city: "Niteroi",
    state: "RJ",
    asaasCommercialInfo: {
      companyName: "Loja 1",
      email: "loja1@mysnack.com"
    }
  });
  assert.equal(payload.city, "Niteroi");
  assert.equal(payload.state, "RJ");
};

const testBuildSubaccountPayloadRequiresCpfCnpj = () => {
  assert.throws(() => {
    buildSubaccountPayload({
      city: "Sao Paulo",
      state: "SP",
      asaasCommercialInfo: {
        companyName: "Sem doc"
      }
    });
  }, /missing-cpf-cnpj/);
};

const run = () => {
  testSingleStoreSplit();
  testMultiStoreSplit();
  testWebhookKey();
  testIntegralFeeConfig();
  testNormalizeIntentItemPreservesDescriptionAndNotes();
  testNormalizeIntentItemSupportsLegacyAliases();
  testBuildSubaccountPayloadPrefersCommercialCityState();
  testBuildSubaccountPayloadFallsBackToStoreCityState();
  testBuildSubaccountPayloadRequiresCpfCnpj();
  console.log("payments.test.ts: OK");
};

run();
