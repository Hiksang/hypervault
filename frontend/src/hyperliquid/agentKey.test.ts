import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  loadAgent,
  newAgent,
  open,
  readAgent,
  saveAgent,
  seal,
  type SealedAgent,
} from "./agentKey.ts";

const VAULT: Address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PASSPHRASE = "correct horse battery";
function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

test("a sealed key opens with its passphrase and with no other", async () => {
  const agent = newAgent();
  const sealed = await seal(agent.privateKey, PASSPHRASE);
  assert.equal(sealed.address, agent.address);
  assert.deepEqual(
    [sealed.salt, sealed.iv, sealed.data].map((hex) => (hex.length - 2) / 2),
    [16, 12, 48],
  );
  assert.ok(!JSON.stringify(sealed).includes(agent.privateKey.slice(2)));
  assert.equal(await open(sealed, PASSPHRASE), agent.privateKey);
  await assert.rejects(
    open(sealed, PASSPHRASE + "!"),
    /암호가 올바르지 않습니다/,
  );
  await assert.rejects(seal(agent.privateKey, "short"), /12자 이상/);
});

test("a stored record of another shape is damaged: not a wrong passphrase, not an empty slot", async () => {
  const sealed = await seal(newAgent().privateKey, PASSPHRASE);
  const store = memory();
  assert.deepEqual(readAgent(store, 998, VAULT), {
    sealed: null,
    damaged: false,
  });
  saveAgent(store, 998, VAULT, sealed);
  assert.deepEqual(readAgent(store, 998, VAULT), { sealed, damaged: false });
  assert.deepEqual(loadAgent(store, 998, VAULT), sealed);
  assert.equal(readAgent(store, 999, VAULT).sealed, null, "kept per chain");
  const [slot] = store.keys();
  const shorter = (hex: Hex) => hex.slice(0, -2) as Hex;
  const damaged: [string, unknown][] = [
    ["data one byte short", { ...sealed, data: shorter(sealed.data) }],
    ["data one byte long", { ...sealed, data: `${sealed.data}00` }],
    ["data half a byte short", { ...sealed, data: sealed.data.slice(0, -1) }],
    ["empty data", { ...sealed, data: "0x" }],
    ["short salt", { ...sealed, salt: shorter(sealed.salt) }],
    ["short IV", { ...sealed, iv: shorter(sealed.iv) }],
    ["a 16-byte IV", { ...sealed, iv: `${sealed.iv}00000000` }],
    ["data that is not hex", { ...sealed, data: "0x" + "zz".repeat(48) }],
    ["no salt", { ...sealed, salt: undefined }],
    ["too few iterations", { ...sealed, iterations: 1000 }],
    ["too many iterations", { ...sealed, iterations: 600_000_000 }],
    ["no address", { ...sealed, address: "0x123" }],
    ["not a record", 7],
    ["null", null],
  ];
  for (const [label, record] of damaged) {
    const edited = memory({ [slot]: JSON.stringify(record) });
    assert.deepEqual(
      readAgent(edited, 998, VAULT),
      { sealed: null, damaged: true },
      label,
    );
    assert.equal(loadAgent(edited, 998, VAULT), null, label);
  }
  assert.deepEqual(readAgent(memory({ [slot]: "{not json" }), 998, VAULT), {
    sealed: null,
    damaged: true,
  });
  // Handed such a record all the same, the right passphrase is not called wrong.
  for (const record of [
    { ...sealed, data: shorter(sealed.data) },
    { ...sealed, iv: shorter(sealed.iv) },
    { ...sealed, salt: `${sealed.salt}00` },
  ] as SealedAgent[])
    await assert.rejects(open(record, PASSPHRASE), /기록이 손상되었습니다/);
  // A record of the right shape whose bytes changed cannot be told from a wrong passphrase.
  const flipped = `${sealed.data.slice(0, -2)}${sealed.data.endsWith("00") ? "01" : "00"}`;
  await assert.rejects(
    open({ ...sealed, data: flipped as Hex }, PASSPHRASE),
    /암호가 올바르지 않습니다/,
  );
});
