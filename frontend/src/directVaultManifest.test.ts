import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDirectVaults } from "./directVaultManifest.ts";
const a = "0x1111111111111111111111111111111111111111";
const valid = {
  name: "HYPE Vault",
  vault: a,
  asset: a,
  bridge: a,
  controller: a,
  implementation: a,
  verifier: a,
  router: "0x0000000000000000000000000000000000000000",
};
test("empty deployment list never invents a live Vault", () => {
  assert.deepEqual(parseDirectVaults("[]"), []);
  assert.equal(parseDirectVaults(JSON.stringify([valid]))[0]!.vault, a);
});
test("manifest rejects incomplete, zero, duplicate and malformed trust anchors", () => {
  for (const input of [
    {},
    [valid, valid],
    [{ ...valid, asset: valid.router }],
    [{ ...valid, controller: undefined }],
    [{ ...valid, vault: "arbitrary" }],
    [{ ...valid, name: " " }],
  ])
    assert.throws(() => parseDirectVaults(JSON.stringify(input)));
});
test("v2 entries name both the share token and the accountant", () => {
  const b = "0x2222222222222222222222222222222222222222";
  const v2 = { ...valid, share: b, accountant: b };
  assert.equal(parseDirectVaults(JSON.stringify([v2]))[0]!.share, b);
  for (const input of [
    [{ ...valid, share: b }],
    [{ ...valid, accountant: b }],
    [{ ...v2, share: valid.router }],
    [{ ...v2, accountant: "arbitrary" }],
  ])
    assert.throws(() => parseDirectVaults(JSON.stringify(input)));
});
test("v6 entries may name a Lens and the deployment block; both are checked", () => {
  const lens = "0x2222222222222222222222222222222222222222";
  const ok = parseDirectVaults(
    JSON.stringify([{ ...valid, lens, fromBlock: 48356436 }]),
  )[0]!;
  assert.equal(ok.lens, lens);
  assert.equal(ok.fromBlock, 48356436);
  assert.equal(parseDirectVaults(JSON.stringify([valid]))[0]!.lens, undefined);
  for (const bad of [
    { lens: "0x0000000000000000000000000000000000000000" },
    { lens: "nope" },
    { fromBlock: -1 },
    { fromBlock: 1.5 },
    { fromBlock: "48356436" },
  ])
    assert.throws(() =>
      parseDirectVaults(JSON.stringify([{ ...valid, ...bad }])),
    );
});
