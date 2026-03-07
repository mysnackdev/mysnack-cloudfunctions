import assert from "node:assert/strict";

process.env.FIREBASE_DATABASE_URL ||= "http://127.0.0.1:9000?ns=demo-test";
process.env.FIREBASE_CONFIG ||= JSON.stringify({
  projectId: "demo-test",
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const {
  resolveCreateUserProfileInput
} = await import("../auth.functions.js");

const {
  normalizeUpsertOwnerStoreInput
} = await import("../stores.js");

const testResolveCreateUserProfileInputForOwnerWithCnpj = () => {
  const result = resolveCreateUserProfileInput({
    auth: { uid: "u1", token: { email: "owner@test.com", role: "store-owner" } },
    data: {
      cpfCnpj: "07.698.982/0001-86",
      storeName: "Mei Mei",
      razaoSocial: "Mei Mei Culinaria",
      shoppingId: "shop-1"
    }
  });
  assert.equal(result.uid, "u1");
  assert.equal(result.role, "store-owner");
  assert.equal(result.cpfCnpj, "07698982000186");
  assert.equal(result.cnpj, "07698982000186");
  assert.equal(result.personType, "JURIDICA");
  assert.equal(result.storeId, "07698982000186");
};

const testResolveCreateUserProfileInputUsesBirthdateAlias = () => {
  const result = resolveCreateUserProfileInput({
    auth: { uid: "u2", token: { email: "user@test.com" } },
    data: {
      birthdate: "2000-01-30"
    }
  });
  assert.equal(result.birthDate, "2000-01-30");
};

const testResolveCreateUserProfileInputDefaultsRoleAndStatus = () => {
  const result = resolveCreateUserProfileInput({
    auth: { uid: "u3", token: { email: "consumer@test.com", role: "invalid-role" } },
    data: {}
  });
  assert.equal(result.role, "consumer");
  assert.equal(result.status, "active");
};

const testNormalizeUpsertOwnerStoreInputSuccess = () => {
  const result = normalizeUpsertOwnerStoreInput({
    cpfCnpj: "07.698.982/0001-86",
    storeName: "Mei Mei",
    razaoSocial: "Mei Mei Culinaria",
    shoppingId: "shop-1",
    category: "japonesa",
    logoUrl: " https://cdn.test/logo.png "
  });
  assert.equal(result.resolvedCpfCnpj, "07698982000186");
  assert.equal(result.category, "japonesa");
  assert.equal(result.logoUrl, "https://cdn.test/logo.png");
  assert.equal(result.hasLogoField, true);
};

const testNormalizeUpsertOwnerStoreInputRejectsInvalidDocument = () => {
  assert.throws(() => {
    normalizeUpsertOwnerStoreInput({
      cpfCnpj: "123",
      storeName: "Loja",
      razaoSocial: "Razao",
      shoppingId: "shop-1",
      category: "japonesa"
    });
  }, /invalid-cpf-cnpj/);
};

const testNormalizeUpsertOwnerStoreInputRejectsMissingRequiredFields = () => {
  assert.throws(() => {
    normalizeUpsertOwnerStoreInput({
      cpfCnpj: "07.698.982/0001-86",
      razaoSocial: "Razao",
      shoppingId: "shop-1",
      category: "japonesa"
    });
  }, /invalid-payload/);
};

const testNormalizeUpsertOwnerStoreInputRejectsInvalidCategory = () => {
  assert.throws(() => {
    normalizeUpsertOwnerStoreInput({
      cpfCnpj: "07.698.982/0001-86",
      storeName: "Loja",
      razaoSocial: "Razao",
      shoppingId: "shop-1",
      category: "xpto"
    });
  }, /Invalid enum value|invalid-category/);
};

const run = () => {
  testResolveCreateUserProfileInputForOwnerWithCnpj();
  testResolveCreateUserProfileInputUsesBirthdateAlias();
  testResolveCreateUserProfileInputDefaultsRoleAndStatus();
  testNormalizeUpsertOwnerStoreInputSuccess();
  testNormalizeUpsertOwnerStoreInputRejectsInvalidDocument();
  testNormalizeUpsertOwnerStoreInputRejectsMissingRequiredFields();
  testNormalizeUpsertOwnerStoreInputRejectsInvalidCategory();
  console.log("account-creation.test.ts: OK");
};

run();
