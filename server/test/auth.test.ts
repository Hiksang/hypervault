import { test } from "node:test";
import assert from "node:assert/strict";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
} from "viem";
import {
  fresh,
  issueToken,
  readToken,
  sessionTypedData,
  signedBy,
  statement,
} from "../src/auth.ts";
import { chainId, sign, wallet } from "./helpers.ts";
const audience = "https://chat.example.com";
const realm = { chainId, audience };
const key = { ...realm, secret: "s".repeat(32) };
const issuedAt = 1_800_000_000;
const hashed = (text: string) => keccak256(stringToHex(text));
test("the typed data is EIP-712: a name/version/chainId domain and a Session naming the audience", () => {
  const signer = `0x${"12".repeat(20)}` as Address;
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        hashed("EIP712Domain(string name,string version,uint256 chainId)"),
        hashed("Core Vault Chat"),
        hashed("1"),
        999n,
      ],
    ),
  );
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        hashed(
          "Session(address wallet,uint256 issuedAt,string audience,string statement)",
        ),
        signer,
        1_800_000_000n,
        hashed("https://chat.example.com"),
        hashed("Sign in to Core Vault chat. This does not send a transaction."),
      ],
    ),
  );
  assert.equal(
    hashTypedData(
      sessionTypedData(
        { chainId: 999, audience: "https://chat.example.com" },
        signer,
        1_800_000_000n,
      ),
    ),
    keccak256(concat(["0x1901", domain, struct])),
  );
  assert.equal(
    statement,
    "Sign in to Core Vault chat. This does not send a transaction.",
  );
});
test("a session signature is accepted only from the wallet it names", async () => {
  const alice = wallet();
  const mallory = wallet();
  const signature = await sign(alice, issuedAt, audience);
  assert.equal(await signedBy(realm, alice.address, issuedAt, signature), true);
  // Checksummed and lowercase forms name the same wallet.
  assert.equal(
    await signedBy(realm, alice.account.address, issuedAt, signature),
    true,
  );
  assert.equal(
    await signedBy(realm, mallory.address, issuedAt, signature),
    false,
  );
  // Mallory signs a message that names Alice.
  assert.equal(
    await signedBy(
      realm,
      alice.address,
      issuedAt,
      await sign(mallory, issuedAt, audience, { wallet: alice.address }),
    ),
    false,
  );
});
test("a session signature is bound to the chain id and to issuedAt", async () => {
  const alice = wallet();
  const signature = await sign(alice, issuedAt, audience);
  assert.equal(
    await signedBy(
      { ...realm, chainId: 999 },
      alice.address,
      issuedAt,
      signature,
    ),
    false,
  );
  assert.equal(
    await signedBy(realm, alice.address, issuedAt + 1, signature),
    false,
  );
});
test("a session signature is bound to the audience it was made for", async () => {
  const alice = wallet();
  // What another site would collect for its own sign-in.
  const elsewhere = await sign(alice, issuedAt, "https://other.example");
  assert.equal(
    await signedBy(realm, alice.address, issuedAt, elsewhere),
    false,
  );
  assert.equal(
    await signedBy(
      { chainId, audience: "https://other.example" },
      alice.address,
      issuedAt,
      elsewhere,
    ),
    true,
  );
  // The audience is compared as signed: a near miss is another audience.
  const signature = await sign(alice, issuedAt, audience);
  for (const near of [
    `${audience}/`,
    audience.toUpperCase(),
    audience.replace("https:", "http:"),
    `${audience}:443`,
    `${audience}.evil.example`,
    "",
  ])
    assert.equal(
      await signedBy(
        { chainId, audience: near },
        alice.address,
        issuedAt,
        signature,
      ),
      false,
      near,
    );
});
test("an unrecoverable signature is a refusal, not an exception", async () => {
  const alice = wallet();
  for (const signature of [
    `0x${"00".repeat(65)}`,
    `0x${"ff".repeat(65)}`,
    `0x${"11".repeat(64)}63`,
  ] as const)
    assert.equal(
      await signedBy(realm, alice.address, issuedAt, signature),
      false,
    );
});
test("issuedAt may be five minutes old and thirty seconds ahead, no more", () => {
  const now = issuedAt;
  assert.equal(fresh(now, now), true);
  assert.equal(fresh(now - 300, now), true);
  assert.equal(fresh(now - 301, now), false);
  assert.equal(fresh(now + 30, now), true);
  assert.equal(fresh(now + 31, now), false);
  // A signature dated five minutes ahead would be good for ten.
  assert.equal(fresh(now + 300, now), false);
});
test("a token round-trips until it expires", () => {
  const alice = wallet();
  const token = issueToken(key, alice.address, issuedAt + 10);
  assert.equal(readToken(key, token, issuedAt), alice.address);
  assert.equal(readToken(key, token, issuedAt + 9), alice.address);
  assert.equal(readToken(key, token, issuedAt + 10), null);
  assert.equal(readToken(key, token, issuedAt + 11), null);
});
test("a tampered or foreign token is refused", () => {
  const alice = wallet();
  const mallory = wallet();
  const token = issueToken(key, alice.address, issuedAt + 10);
  const [address = "", expiresAt = "", mac = ""] = token.split(".");
  const flipped = mac.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
  for (const forged of [
    `${mallory.address}.${expiresAt}.${mac}`,
    `${address}.${issuedAt + 11}.${mac}`,
    `${address}.${expiresAt}.${flipped}`,
    `${address}.${expiresAt}.${mac.slice(1)}`,
    `${address}.${expiresAt}.${mac}=`,
    `${address.toUpperCase()}.${expiresAt}.${mac}`,
    `${address}.0${expiresAt}.${mac}`,
    `${address}.${expiresAt}`,
    `${token}.extra`,
    ` ${token}`,
    "",
  ])
    assert.equal(readToken(key, forged, issuedAt), null, forged);
  assert.equal(
    readToken({ ...key, secret: "t".repeat(32) }, token, issuedAt),
    null,
  );
  assert.equal(readToken({ ...key, chainId: 999 }, token, issuedAt), null);
  assert.equal(readToken(key, token, issuedAt), alice.address);
});
test("a token is refused by another deployment that shares the secret", () => {
  const alice = wallet();
  const token = issueToken(key, alice.address, issuedAt + 10);
  for (const other of [
    "https://other.example",
    `${audience}/`,
    `${audience}:8443`,
    audience.replace("https:", "http:"),
    "",
  ])
    assert.equal(
      readToken({ ...key, audience: other }, token, issuedAt),
      null,
      other,
    );
  // The same deployment restarted, with the same settings, still accepts it.
  assert.equal(readToken({ ...key }, token, issuedAt), alice.address);
});
