import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pack } from "./msgpack.ts";
import { actionHash, signL1Action } from "./signing.ts";

// Vectors from the official SDK: hyperliquid-python-sdk tests/signing_test.py.
const wallet = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const order = (extra: object = {}) => ({
  type: "order",
  orders: [
    {
      a: 1,
      b: true,
      p: "100",
      s: "100",
      r: false,
      t: { limit: { tif: "Gtc" } },
      ...extra,
    },
  ],
  grouping: "na",
});
async function signed(
  action: unknown,
  mainnet: boolean,
  vault: `0x${string}` | null = null,
) {
  const { r, s, v } = await signL1Action(wallet, action, 0, mainnet, vault);
  return [BigInt(r), BigInt(s), v];
}

test("msgpack uses the smallest encoding and keeps key order", () => {
  const hex = (value: unknown) => bytesToHex(pack(value)).slice(2);
  assert.equal(hex(null), "c0");
  assert.equal(hex([true, false]), "92c3c2");
  assert.equal(hex(127), "7f");
  assert.equal(hex(128), "cc80");
  assert.equal(hex(65535), "cdffff");
  assert.equal(hex(65536), "ce00010000");
  assert.equal(hex(100000000000), "cf000000174876e800");
  assert.equal(hex(-1), "ff");
  assert.equal(hex(-33), "d0df");
  assert.equal(hex("Gtc"), "a3477463");
  assert.equal(hex("가"), "a3eab080");
  assert.equal(hex("x".repeat(32)), "d920" + "78".repeat(32));
  assert.equal(hex({ b: 1, a: 2 }), "82a16201a16102");
  assert.equal(hex(new Array(16).fill(0)), "dc0010" + "00".repeat(16));
  for (const bad of [1.5, undefined, 2 ** 53, () => 0])
    assert.throws(() => pack(bad));
  assert.throws(() => pack({ a: undefined }));
});

test("action hash matches the production phantom agent", () => {
  const action = {
    type: "order",
    orders: [
      {
        a: 4,
        b: true,
        p: "1670.1",
        s: "0.0147",
        r: false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  };
  assert.equal(
    actionHash(action, 1677777606040),
    "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
  );
});

test("L1 signatures match the official SDK on mainnet and testnet", async () => {
  const dummy = { type: "dummy", num: 100000000000 };
  assert.deepEqual(await signed(dummy, true), [
    0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298n,
    0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8n,
    27,
  ]);
  assert.deepEqual(await signed(dummy, false), [
    0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510n,
    0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613n,
    28,
  ]);
  assert.deepEqual(await signed(order(), true), [
    0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78en,
    0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940en,
    28,
  ]);
  assert.deepEqual(await signed(order(), false), [
    0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54n,
    0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5n,
    27,
  ]);
});

test("client order id and vault address change the signed bytes as in the SDK", async () => {
  const withCloid = order({ c: "0x00000000000000000000000000000001" });
  assert.deepEqual(await signed(withCloid, true), [
    0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3n,
    0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116dan,
    27,
  ]);
  const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
  const dummy = { type: "dummy", num: 100000000000 };
  assert.deepEqual(await signed(dummy, true, vault), [
    0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239n,
    0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2cn,
    28,
  ]);
  assert.deepEqual(await signed(dummy, false, vault), [
    0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362bn,
    0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60n,
    27,
  ]);
});

test("an expiry is part of what is signed", () => {
  const action = order();
  assert.notEqual(actionHash(action, 5), actionHash(action, 5, null, 60_000));
  assert.notEqual(
    actionHash(action, 5, null, 60_000),
    actionHash(action, 5, null, 60_001),
  );
});
