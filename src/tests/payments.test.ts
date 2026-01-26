import assert from "node:assert/strict";
import { computeSplitCents, getWebhookEventKey, hashPayload } from "../payments.js";

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
  const totalCents = 10000;
  const split = computeSplitCents([makeStore("s1", totalCents)], totalCents);
  const fixedTotal = split.storeSplits.reduce((acc, item) => acc + item.fixedValueCents, 0);
  assert.ok(split.platform.expectedPlatformNetCents >= 0);
  assert.equal(fixedTotal + split.platform.expectedPlatformRemainderCents, totalCents);
  assert.ok(split.storeSplits[0].fixedValueCents > 0);
};

const testMultiStoreSplit = () => {
  const stores = [makeStore("s1", 6000), makeStore("s2", 4000)];
  const totalCents = 10000;
  const split = computeSplitCents(stores, totalCents);
  const fixedTotal = split.storeSplits.reduce((acc, item) => acc + item.fixedValueCents, 0);
  assert.equal(split.platform.platformShareCents, 800);
  assert.equal(fixedTotal + split.platform.expectedPlatformRemainderCents, totalCents);
  assert.equal(split.ledger.totalCents, totalCents);
};

const testWebhookKey = () => {
  const payload = { eventId: "evt_123", payment: { id: "pay_1" } };
  assert.equal(getWebhookEventKey(payload), "evt_123");
  const payloadNoId = { payment: { id: "pay_2" } };
  assert.equal(getWebhookEventKey(payloadNoId), hashPayload(payloadNoId));
};

const run = () => {
  testSingleStoreSplit();
  testMultiStoreSplit();
  testWebhookKey();
  console.log("payments.test.ts: OK");
};

run();
