import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import {
  builtFactory,
  codeDiffers,
  vaultAddressAt,
  vaultContractsAt,
  vaultIndexOf,
} from "./addresses.ts";

const DEPLOYER: Address = "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0";
// CREATE addresses of that deployer at nonces 3 to 8, from `cast compute-address --nonce`.
const CREATED: Address[] = [
  "0xffFd933A0bC612844eaF0C6Fe3E5b8E9B6C1d19c",
  "0x9148039fe618155A81280E687369A95453bF7D1d",
  "0x905220c078aE67eFB40f16417aaB7244DB48f2FE",
  "0x540be9293faAB11927525451c0000C2D35E61029",
  "0x8AFFF10ce1138d535EA31b9f34eF463e040b2b3e",
  "0x9e31B20812C551b25d249767Dc6bB94DE2B148dD",
];

test("a vault's controller, implementation and proxy sit at nonces 3i, 3i+1 and 3i+2", () => {
  assert.deepEqual(vaultContractsAt(DEPLOYER, 1n), {
    controller: CREATED[0],
    implementation: CREATED[1],
    vault: CREATED[2],
  });
  assert.deepEqual(vaultContractsAt(DEPLOYER, 2n), {
    controller: CREATED[3],
    implementation: CREATED[4],
    vault: CREATED[5],
  });
  assert.equal(vaultAddressAt(DEPLOYER, 1n), CREATED[2]);
  assert.equal(vaultAddressAt(DEPLOYER, 2n), CREATED[5]);
});

test("a vault's index is found only among the vaults the Factory has made", () => {
  const second = CREATED[5];
  assert.equal(vaultIndexOf(DEPLOYER, second, 1n), null, "not made yet");
  assert.equal(vaultIndexOf(DEPLOYER, second, 2n), 2n);
  assert.equal(
    vaultIndexOf(DEPLOYER, second.toLowerCase() as Address, 5n),
    2n,
    "addresses compare without case",
  );
  assert.equal(
    vaultIndexOf(DEPLOYER, second, 1n),
    null,
    "a remembered index beyond the count is not an answer",
  );
  assert.equal(vaultIndexOf(DEPLOYER, CREATED[2], 2n), 1n);
  // The controller and the implementation of a vault are not vaults.
  assert.equal(vaultIndexOf(DEPLOYER, CREATED[3], 2n), null);
  assert.equal(vaultIndexOf(DEPLOYER, CREATED[4], 2n), null);
  // Another deployer's vaults are not this Factory's.
  assert.equal(vaultIndexOf(CREATED[0], second, 2n), null);
  assert.equal(vaultIndexOf(DEPLOYER, second, 0n), null);
});

test("code differs when the implementation, the asset or the controller is not the one made", () => {
  const [controller, first, other, asset] = CREATED;
  const template = {
    implementation: first,
    first,
    asset,
    templateAsset: asset,
    controller,
    madeController: controller,
  };
  assert.equal(codeDiffers(template), false);
  assert.equal(
    codeDiffers({
      ...template,
      implementation: first.toLowerCase() as Address,
      asset: asset.toLowerCase() as Address,
      controller: controller.toLowerCase() as Address,
    }),
    false,
    "addresses compare without case",
  );
  assert.equal(codeDiffers({ ...template, implementation: other }), true);
  assert.equal(codeDiffers({ ...template, asset: other }), true);
  assert.equal(codeDiffers({ ...template, controller: other }), true);
  // The list reads only the controller's record: what was not read is not a difference.
  assert.equal(codeDiffers({ implementation: first, first }), false);
  assert.equal(codeDiffers({ implementation: other, first }), true);
  assert.equal(codeDiffers({ implementation: first, first, asset }), false);
  // The Vault's own code keeps a name within its rule: one outside it is another code's answer.
  assert.equal(codeDiffers({ ...template, name: "USDC Prime" }), false);
  assert.equal(codeDiffers({ ...template, name: "x".repeat(400_000) }), true);
  assert.equal(codeDiffers({ ...template, name: "" }), true);
  assert.equal(codeDiffers({ ...template, name: "줄\n바꿈" }), true);
  assert.equal(
    codeDiffers({ implementation: first, first, name: "한".repeat(33) }),
    true,
  );
});

test("a build that names a Factory fixes it, and one that names none leaves it to the visitor", () => {
  assert.deepEqual(builtFactory(undefined), {
    address: "",
    fixed: false,
    problem: "",
  });
  assert.deepEqual(builtFactory(""), {
    address: "",
    fixed: false,
    problem: "",
  });
  const named = builtFactory(DEPLOYER);
  assert.equal(named.fixed, true);
  assert.equal(named.problem, "");
  assert.equal(named.address.toLowerCase(), DEPLOYER);
  assert.notEqual(named.address, DEPLOYER, "normalized to its checksum form");
  // A setting that is no address is still the build's choice: no field appears in its place.
  for (const wrong of [
    "0x123",
    "factory",
    DEPLOYER.toUpperCase(),
    " " + DEPLOYER,
  ]) {
    const bad = builtFactory(wrong);
    assert.equal(bad.fixed, true, wrong);
    assert.equal(bad.address, "");
    assert.match(bad.problem, /VITE_FACTORY_ADDRESS/);
  }
});
