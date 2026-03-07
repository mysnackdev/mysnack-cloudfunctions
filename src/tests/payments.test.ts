import assert from "node:assert/strict";

process.env.FIREBASE_DATABASE_URL ||= "http://127.0.0.1:9000?ns=demo-test";
process.env.FIREBASE_CONFIG ||= JSON.stringify({
  projectId: "demo-test",
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const {
  buildSubaccountPayload,
  computeSplitCents,
  ensureStoreAsaasAccountForStore,
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

const testBuildSubaccountPayloadNormalizesCompanyTypeFromObject = () => {
  const payload = buildSubaccountPayload({
    cnpj: "12.345.678/0001-99",
    asaasCommercialInfo: {
      companyType: { value: "MEI" }
    }
  });
  assert.equal(payload.companyType, "MEI");
};

const testBuildSubaccountPayloadFallsBackToStoreCompanyType = () => {
  const payload = buildSubaccountPayload({
    cnpj: "12.345.678/0001-99",
    asaasCompanyType: "INDIVIDUAL",
    asaasCommercialInfo: {}
  });
  assert.equal(payload.companyType, "INDIVIDUAL");
};

const makeStoreSnap = (id: string, storeData: Record<string, any>) => {
  const updates: Record<string, any>[] = [];
  return {
    id,
    data: () => storeData,
    ref: {
      update: async (payload: Record<string, any>) => {
        updates.push(payload);
      }
    },
    __updates: updates
  } as any;
};

const testEnsureStoreAsaasAccountCreatesAccountForNewStore = async () => {
  const storeSnap = makeStoreSnap("store-1", {
    cnpj: "12.345.678/0001-99",
    city: "Sao Paulo",
    state: "SP",
    asaasCommercialInfo: {
      companyType: "MEI",
      companyName: "Loja Teste",
      email: "contato@loja.com"
    }
  });
  const calls: string[] = [];
  const result = await ensureStoreAsaasAccountForStore(storeSnap, {
    createSubaccount: async (payload: Record<string, any>) => {
      calls.push(`createSubaccount:${payload.companyType}`);
      return {
        id: "acc_123",
        walletId: "wallet_created",
        accountNumber: "000123",
        accessToken: { apiKey: "asaas_token_1" }
      };
    },
    getSubaccount: async () => ({ id: "acc_123", wallet: { id: "wallet_remote" } }),
    createSubaccountAccessToken: async () => {
      calls.push("createSubaccountAccessToken");
      return { accessToken: "asaas_token_2" };
    },
    listWallets: async () => ({ data: [{ id: "wallet_fallback" }] }),
    fetchStoreAsaasSummary: async () => ({
      asaasAccountStatus: "APPROVED",
      asaasAccountNumber: "999888",
      asaasBalance: { available: 10 },
      asaasPendingDocuments: [],
      asaasOnboardingUrls: [],
      cached: false
    }),
    encryptToken: () => ({ apiKeyEnc: "enc-value" } as any)
  });
  assert.equal(result.asaasAccountId, "acc_123");
  assert.equal(result.asaasWalletId, "wallet_created");
  assert.equal(result.asaasAccountStatus, "APPROVED");
  assert.deepEqual(calls, ["createSubaccount:MEI"]);
  assert.equal(storeSnap.__updates.length, 1);
  assert.equal(storeSnap.__updates[0].asaasAccountId, "acc_123");
  assert.equal(storeSnap.__updates[0].asaasAccountData.apiKeyEnc, "enc-value");
};

const testEnsureStoreAsaasAccountCreatesTokenWhenMissing = async () => {
  const storeSnap = makeStoreSnap("store-2", {
    cnpj: "12.345.678/0001-99",
    city: "Rio",
    state: "RJ",
    asaasCommercialInfo: { companyType: "LIMITED" }
  });
  let tokenCalls = 0;
  const result = await ensureStoreAsaasAccountForStore(storeSnap, {
    createSubaccount: async () => ({
      id: "acc_456",
      walletId: "wallet_created"
    }),
    getSubaccount: async () => ({ id: "acc_456", walletId: "wallet_remote" }),
    createSubaccountAccessToken: async () => {
      tokenCalls += 1;
      return { accessToken: "new_token_value" };
    },
    listWallets: async () => ({ data: [{ id: "wallet_fallback" }] }),
    fetchStoreAsaasSummary: async () => ({
      asaasAccountStatus: "PENDING",
      asaasAccountNumber: null,
      asaasBalance: null,
      asaasPendingDocuments: [],
      asaasOnboardingUrls: [],
      cached: false
    }),
    encryptToken: () => ({ apiKeyEnc: "enc-token" } as any)
  });
  assert.equal(tokenCalls, 1);
  assert.equal(result.asaasAccountId, "acc_456");
  assert.equal(result.asaasWalletId, "wallet_created");
};

const testEnsureStoreAsaasAccountUsesExistingAccountAndWalletFallback = async () => {
  const storeSnap = makeStoreSnap("store-3", {
    cnpj: "12.345.678/0001-99",
    asaasAccountId: "acc_existing",
    asaasAccountData: {},
    asaasCommercialInfo: { companyType: "INDIVIDUAL" }
  });
  let createCalls = 0;
  const result = await ensureStoreAsaasAccountForStore(storeSnap, {
    createSubaccount: async () => {
      createCalls += 1;
      return { id: "acc_unexpected" };
    },
    getSubaccount: async () => ({ id: "acc_existing" }),
    createSubaccountAccessToken: async () => ({ accessToken: "existing_token" }),
    listWallets: async () => ({ data: [{ id: "wallet_from_list" }] }),
    fetchStoreAsaasSummary: async () => ({
      asaasAccountStatus: "APPROVED",
      asaasAccountNumber: null,
      asaasBalance: null,
      asaasPendingDocuments: [],
      asaasOnboardingUrls: [],
      cached: false
    }),
    encryptToken: () => ({ apiKeyEnc: "enc-existing" } as any)
  });
  assert.equal(createCalls, 0);
  assert.equal(result.asaasAccountId, "acc_existing");
  assert.equal(result.asaasWalletId, "wallet_from_list");
};

const testEnsureStoreAsaasAccountFailsWithoutCpfCnpj = async () => {
  const storeSnap = makeStoreSnap("store-4", {
    city: "Sao Paulo",
    state: "SP",
    asaasCommercialInfo: { companyType: "MEI" }
  });
  await assert.rejects(
    async () => ensureStoreAsaasAccountForStore(storeSnap, {
      createSubaccount: async () => ({ id: "should-not-run" }),
      getSubaccount: async () => ({ id: "should-not-run" }),
      createSubaccountAccessToken: async () => ({ accessToken: "x" }),
      listWallets: async () => ({ data: [] }),
      fetchStoreAsaasSummary: async () => ({
        asaasAccountStatus: null,
        asaasAccountNumber: null,
        asaasBalance: null,
        asaasPendingDocuments: [],
        asaasOnboardingUrls: [],
        cached: false
      }),
      encryptToken: () => ({ apiKeyEnc: "x" } as any)
    }),
    /missing-cpf-cnpj/
  );
};

const run = async () => {
  testSingleStoreSplit();
  testMultiStoreSplit();
  testWebhookKey();
  testIntegralFeeConfig();
  testNormalizeIntentItemPreservesDescriptionAndNotes();
  testNormalizeIntentItemSupportsLegacyAliases();
  testBuildSubaccountPayloadPrefersCommercialCityState();
  testBuildSubaccountPayloadFallsBackToStoreCityState();
  testBuildSubaccountPayloadRequiresCpfCnpj();
  testBuildSubaccountPayloadNormalizesCompanyTypeFromObject();
  testBuildSubaccountPayloadFallsBackToStoreCompanyType();
  await testEnsureStoreAsaasAccountCreatesAccountForNewStore();
  await testEnsureStoreAsaasAccountCreatesTokenWhenMissing();
  await testEnsureStoreAsaasAccountUsesExistingAccountAndWalletFallback();
  await testEnsureStoreAsaasAccountFailsWithoutCpfCnpj();
  console.log("payments.test.ts: OK");
};

await run();
