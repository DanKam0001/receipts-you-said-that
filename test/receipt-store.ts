import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { ReceiptStore } from "../src/receipt-store.js";

const root = ".tmp/receipt-store-test";
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const store = new ReceiptStore(root), id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const wav = Buffer.from("RIFF-local-clip");
const count = await store.save({ id, quote: "I said it.", timestamp: 12.5, quoteEnd: 13, clipStart: 11, clipEnd: 14,
  requester: "viewer", outcome: "RECEIPT FOUND", score: 0.988, candidateId: "u4-5", retrievalScore: 0.77 }, wav);
assert.equal(count, 1);
const rows = await store.list();
assert.equal(rows.length, 1);
assert.equal(rows[0]!.quote, "I said it.");
assert.equal(rows[0]!.requester, "viewer");
assert.equal(rows[0]!.score, 0.988);
assert.equal(rows[0]!.outcome, "RECEIPT FOUND");
assert.deepEqual(await store.clip(id), wav);
assert.equal(await store.clip("../bad"), undefined);
await rm(root, { recursive: true, force: true });
console.log("ok - receipt archive persists WAV and JSON metadata with safe ID lookup");
