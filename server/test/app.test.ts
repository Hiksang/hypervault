import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { issueToken } from "../src/auth.ts";
import { VaultFault, type Chain } from "../src/chain.ts";
import { statuses } from "../src/errors.ts";
import {
  chainId,
  origin,
  otherVault,
  refused,
  sign,
  startChat,
  stranger,
  until,
  vault,
  wallet,
} from "./helpers.ts";
const messagesPath = `/vaults/${vault}/messages`;
// `refused` reads a code's status from the service's own table, so the table
// is held here to what clients and a reverse proxy are told: a 429 is "come
// back later", a 503 is the chain.
test("each error code answers with the status the README gives it", () => {
  assert.deepEqual(statuses, {
    INVALID_JSON: 400,
    INVALID_REQUEST: 400,
    INVALID_ADDRESS: 400,
    INVALID_TEXT: 400,
    SIGNATURE_EXPIRED: 401,
    BAD_SIGNATURE: 401,
    UNAUTHORIZED: 401,
    POSTING_NOT_ALLOWED: 403,
    NOT_MODERATOR: 403,
    HIDDEN_BY_ADMIN: 403,
    NOT_A_VAULT: 404,
    MESSAGE_NOT_FOUND: 404,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    BODY_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    RATE_LIMITED: 429,
    BUSY: 429,
    INTERNAL: 500,
    CHAIN_BUSY: 503,
    CHAIN_UNAVAILABLE: 503,
  });
});
test("sign-in returns a twelve-hour token for the wallet that signed", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const issuedAt = chat.seconds();
  const reply = await chat.call("POST", "/session", {
    body: {
      address: chat.depositor.account.address,
      issuedAt,
      signature: await sign(chat.depositor, issuedAt, chat.config.audience),
    },
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(Object.keys(reply.body).sort(), [
    "address",
    "expiresAt",
    "token",
  ]);
  assert.equal(reply.body.address, chat.depositor.address);
  assert.equal(reply.body.expiresAt, issuedAt + 12 * 60 * 60);
  const posted = await chat.post(reply.body.token as string, "hello");
  assert.equal(posted.status, 201);
});
test("sign-in refuses a signature that is not the named wallet's", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const issuedAt = chat.seconds();
  const { owner, visitor } = chat;
  const { audience } = chat.config;
  for (const [address, signature] of [
    [
      owner.address,
      await sign(visitor, issuedAt, audience, { wallet: owner.address }),
    ],
    [owner.address, await sign(visitor, issuedAt, audience)],
    [visitor.address, await sign(owner, issuedAt, audience)],
    [owner.address, await sign(owner, issuedAt + 1, audience)],
    [owner.address, await sign(owner, issuedAt, audience, { chain: 999 })],
    [owner.address, `0x${"00".repeat(65)}`],
  ])
    refused(
      await chat.call("POST", "/session", {
        body: { address, issuedAt, signature },
      }),
      "BAD_SIGNATURE",
    );
});
test("sign-in refuses a signature made for another audience", async (t) => {
  const audience = "https://chat.example.com";
  const chat = await startChat({ audience });
  t.after(chat.close);
  const issuedAt = chat.seconds();
  const attempt = async (signedFor: string, extra: object = {}) =>
    chat.call("POST", "/session", {
      body: {
        address: chat.owner.address,
        issuedAt,
        signature: await sign(chat.owner, issuedAt, signedFor),
        ...extra,
      },
    });
  for (const other of [
    "https://evil.example",
    "https://chat.example.com.evil.example",
    "https://chat.example.com/",
    "https://chat.example.com:443",
    "https://CHAT.example.com",
    "http://chat.example.com",
    "chat.example.com",
    // The address this request really went to is not the configured one.
    chat.url,
    "",
  ])
    refused(await attempt(other), "BAD_SIGNATURE");
  // The server verifies against its own audience, never one a request names.
  const named = { audience: "https://evil.example" };
  refused(await attempt("https://evil.example", named), "BAD_SIGNATURE");
  assert.equal((await attempt(audience, named)).status, 200);
  assert.equal((await attempt(audience)).status, 200);
});
test("sign-in takes an issuedAt up to five minutes old or thirty seconds ahead", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const now = chat.seconds();
  const attempt = async (issuedAt: number) =>
    chat.call("POST", "/session", {
      body: {
        address: chat.owner.address,
        issuedAt,
        signature: await sign(chat.owner, issuedAt, chat.config.audience),
      },
    });
  refused(await attempt(now - 301), "SIGNATURE_EXPIRED");
  refused(await attempt(now + 31), "SIGNATURE_EXPIRED");
  refused(await attempt(now + 300), "SIGNATURE_EXPIRED");
  assert.equal((await attempt(now - 300)).status, 200);
  assert.equal((await attempt(now + 30)).status, 200);
  // The same signed message cannot be replayed once the window has passed.
  assert.equal((await attempt(now)).status, 200);
  chat.clock.ms += 301_000;
  refused(await attempt(now), "SIGNATURE_EXPIRED");
});
test("a session runs twelve hours from signing, however late it is exchanged", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const issuedAt = chat.seconds();
  const body = {
    address: chat.depositor.address,
    issuedAt,
    signature: await sign(chat.depositor, issuedAt, chat.config.audience),
  };
  const exchange = async () => {
    const reply = await chat.call("POST", "/session", { body });
    assert.equal(reply.status, 200);
    return reply.body as { token: string; expiresAt: number };
  };
  const first = await exchange();
  assert.equal(first.expiresAt, issuedAt + 12 * 60 * 60);
  // Exchanged again at the end of the window: the same expiry, not a later one.
  chat.clock.ms += 300_000;
  const late = await exchange();
  assert.deepEqual(late, first);
  // Twelve hours after signing both are over, though one was issued later.
  chat.clock.ms += (12 * 60 * 60 - 300 - 1) * 1000;
  assert.equal((await chat.post(late.token, "last second")).status, 201);
  chat.clock.ms += 1000;
  refused(await chat.post(late.token, "expired"), "UNAUTHORIZED");
});
test("sign-ins share an allowance of signature checks", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const { audience } = chat.config;
  const session = (body: object) => chat.call("POST", "/session", { body });
  const signed = async (issuedAt: number) => ({
    address: chat.owner.address,
    issuedAt,
    signature: await sign(chat.owner, issuedAt, audience),
  });
  const valid = await signed(chat.seconds());
  const forged = { ...valid, address: chat.visitor.address };
  // Requests refused before the signature is looked at cost nothing.
  for (let i = 0; i < 100; i++) {
    refused(
      await session({ ...valid, issuedAt: valid.issuedAt - 301 }),
      "SIGNATURE_EXPIRED",
    );
    refused(await session({ ...valid, signature: "0x12" }), "INVALID_REQUEST");
  }
  // Two hundred checks at once, whether the signature turns out good or bad.
  for (let i = 0; i < 100; i++) {
    assert.equal((await session(valid)).status, 200);
    refused(await session(forged), "BAD_SIGNATURE");
  }
  for (const body of [valid, forged]) {
    const busy = await session(body);
    refused(busy, "BUSY");
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "1");
  }
  // Two hundred a second come back: one every 5 ms.
  chat.clock.ms += 4;
  refused(await session(valid), "BUSY");
  chat.clock.ms += 1;
  assert.equal((await session(valid)).status, 200);
  refused(await session(valid), "BUSY");
  // The allowance runs on elapsed time: setting the wall clock forward an
  // hour, with a signature dated to match, gains nothing.
  chat.clock.wall += 3_600_000;
  refused(await session(await signed(chat.seconds())), "BUSY");
  chat.clock.ms += 1_000;
  const later = await signed(chat.seconds());
  for (let i = 0; i < 200; i++)
    assert.equal((await session(later)).status, 200);
  refused(await session(later), "BUSY");
  // Everything else keeps being served meanwhile.
  assert.equal((await chat.call("GET", "/health")).status, 200);
  assert.equal((await chat.messages()).length, 0);
});
test("sign-in refuses malformed requests", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const issuedAt = chat.seconds();
  const address = chat.owner.address;
  const signature = await sign(chat.owner, issuedAt, chat.config.audience);
  const session = (body: unknown) => chat.call("POST", "/session", { body });
  for (const bad of [undefined, "", "0x1234", address.slice(0, -1), 7])
    refused(
      await session({ address: bad, issuedAt, signature }),
      "INVALID_ADDRESS",
    );
  for (const bad of [undefined, null, String(issuedAt), 1.5, -1, 2 ** 53])
    refused(
      await session({ address, issuedAt: bad, signature }),
      "INVALID_REQUEST",
    );
  for (const bad of [undefined, "", "0x", signature.slice(0, -2), 5])
    refused(
      await session({ address, issuedAt, signature: bad }),
      "INVALID_REQUEST",
    );
  assert.equal((await session({ address, issuedAt, signature })).status, 200);
});
test("a missing, malformed, tampered or expired token is 401 and stores nothing", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const [, expiresAt = "", mac = ""] = token.split(".");
  const foreign = issueToken(
    {
      secret: "another-deployment-secret-0123456789",
      chainId,
      audience: chat.config.audience,
    },
    chat.depositor.address,
    Number(expiresAt),
  );
  for (const authorization of [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    "Bearer not-a-token",
    `Basic ${token}`,
    token,
    `Bearer ${token} extra`,
    `Bearer ${chat.owner.address}.${expiresAt}.${mac}`,
    `Bearer ${chat.depositor.address}.${Number(expiresAt) + 1}.${mac}`,
    `Bearer ${foreign}`,
  ]) {
    const reply = await chat.call("POST", messagesPath, {
      body: { text: "hello" },
      headers:
        authorization === undefined ? {} : { Authorization: authorization },
    });
    refused(reply, "UNAUTHORIZED");
    assert.equal(reply.headers.get("www-authenticate"), "Bearer");
  }
  refused(await chat.hide("not-a-token", 1, true), "UNAUTHORIZED");
  // One second before expiry the token still works; at expiry it does not.
  chat.clock.ms += (12 * 60 * 60 - 1) * 1000;
  assert.equal((await chat.post(token, "still valid")).status, 201);
  chat.clock.ms += 1000;
  refused(await chat.post(token, "expired"), "UNAUTHORIZED");
  assert.deepEqual(
    (await chat.messages()).map((message) => message.text),
    ["still valid"],
  );
});
test("the role endpoint reports the chain role and whether it may post", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const role = (address: string, at = vault) =>
    chat.call("GET", `/vaults/${at}/role?address=${address}`);
  assert.deepEqual((await role(chat.owner.address)).body, {
    role: "owner",
    canPost: true,
  });
  assert.deepEqual((await role(chat.depositor.account.address)).body, {
    role: "depositor",
    canPost: true,
  });
  assert.deepEqual((await role(chat.visitor.address)).body, {
    role: "visitor",
    canPost: false,
  });
  // Roles belong to a vault: this depositor owns the other one.
  assert.deepEqual((await role(chat.depositor.address, otherVault)).body, {
    role: "owner",
    canPost: true,
  });
  assert.deepEqual((await role(chat.owner.address, otherVault)).body, {
    role: "visitor",
    canPost: false,
  });
  refused(await role("0x1234"), "INVALID_ADDRESS");
  refused(await chat.call("GET", `/vaults/${vault}/role`), "INVALID_ADDRESS");
});
test("members mode: the owner and depositors post, visitors do not", async (t) => {
  const chat = await startChat({ posting: "members" });
  t.after(chat.close);
  const owner = await chat.signIn(chat.owner);
  const depositor = await chat.signIn(chat.depositor);
  const visitor = await chat.signIn(chat.visitor);
  const first = await chat.post(owner, "from the operator");
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.message, {
    id: 1,
    vault,
    author: chat.owner.address,
    role: "owner",
    text: "from the operator",
    createdAt: chat.seconds(),
    hidden: false,
  });
  const second = await chat.post(depositor, "from a depositor");
  assert.equal(second.status, 201);
  refused(await chat.post(visitor, "from outside"), "POSTING_NOT_ALLOWED");
  assert.deepEqual(
    (await chat.messages()).map(({ author, role }) => [author, role]),
    [
      [chat.owner.address, "owner"],
      [chat.depositor.address, "depositor"],
    ],
  );
});
test("open mode: a signed-in visitor posts too, and is recorded as a visitor", async (t) => {
  const chat = await startChat({ posting: "open" });
  t.after(chat.close);
  const role = await chat.call(
    "GET",
    `/vaults/${vault}/role?address=${chat.visitor.address}`,
  );
  assert.deepEqual(role.body, { role: "visitor", canPost: true });
  const message = await chat.say(await chat.signIn(chat.visitor), "hello");
  assert.equal(message.role, "visitor");
  assert.equal(
    (await chat.say(await chat.signIn(chat.owner), "hi")).role,
    "owner",
  );
  // Open posting still needs a session.
  refused(
    await chat.call("POST", messagesPath, { body: { text: "anonymous" } }),
    "UNAUTHORIZED",
  );
});
test("a message keeps the role its author had when posting", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  await chat.say(token, "while invested");
  chat.ledger.vaults.get(vault)?.depositors.clear();
  // Within thirty seconds the earlier chain read is still trusted.
  await chat.say(token, "just withdrew");
  chat.clock.ms += 30_000;
  refused(await chat.post(token, "after leaving"), "POSTING_NOT_ALLOWED");
  assert.deepEqual(
    (await chat.messages()).map(({ text, role }) => [text, role]),
    [
      ["while invested", "depositor"],
      ["just withdrew", "depositor"],
    ],
  );
});
test("a wallet that deposits can post within five seconds", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.visitor);
  refused(await chat.post(token, "too early"), "POSTING_NOT_ALLOWED");
  chat.ledger.vaults.get(vault)?.depositors.add(chat.visitor.address);
  chat.clock.ms += 5_000;
  assert.equal((await chat.say(token, "now a depositor")).role, "depositor");
});
test("an unreadable chain is 503 and stores nothing", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const role = () =>
    chat.call("GET", `/vaults/${vault}/role?address=${stranger}`);
  chat.ledger.failing = true;
  // The vault itself cannot be confirmed.
  refused(await chat.post(token, "hello"), "CHAIN_UNAVAILABLE");
  refused(await chat.call("GET", messagesPath), "CHAIN_UNAVAILABLE");
  refused(await role(), "CHAIN_UNAVAILABLE");
  chat.ledger.failing = false;
  assert.deepEqual(await chat.messages(), []);
  // The vault is known now, but the author's role cannot be read.
  chat.ledger.failing = true;
  refused(await chat.post(token, "hello"), "CHAIN_UNAVAILABLE");
  refused(await role(), "CHAIN_UNAVAILABLE");
  refused(
    await chat.hide(await chat.signIn(chat.owner), 1, true),
    "CHAIN_UNAVAILABLE",
  );
  // Reading messages of a known room needs no chain.
  assert.deepEqual(await chat.messages(), []);
  // The failure was not remembered: the moment the RPC is back, it is read.
  chat.ledger.failing = false;
  assert.equal((await chat.say(token, "hello")).role, "depositor");
  // The detail stays in the server log: for the same moment, one line for
  // the lookups at the Factory and one for the reads of the vault.
  assert.equal(chat.logs.length, 2);
  for (const line of chat.logs) {
    assert.match(
      line,
      /^chain read failed \(0x[0-9a-f]{40}\): "Error: stub RPC down /,
    );
    assert.match(line, /^[\x20-\x7e]+$/);
  }
});
test("a vault that will not answer is left alone for five seconds, and is never given a role", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const role = (address: string) =>
    chat.call("GET", `/vaults/${vault}/role?address=${address}`);
  assert.equal((await role(chat.depositor.address)).body.role, "depositor");
  // The vault's own reads start reverting, as an upgraded vault's can.
  chat.ledger.failure = new VaultFault(new Error("execution reverted"));
  chat.ledger.failing = true;
  chat.clock.ms += 30_000;
  const reads = chat.ledger.reads;
  refused(await role(chat.depositor.address), "CHAIN_UNAVAILABLE");
  assert.equal(chat.ledger.reads, reads + 1);
  // It would answer again at once, but it is left alone for a while: every
  // caller gets 503, with no read and no further log line.
  chat.ledger.failing = false;
  for (let i = 0; i < 50; i++) {
    const address = `0x${i.toString(16).padStart(40, "0")}`;
    refused(await role(address), "CHAIN_UNAVAILABLE");
  }
  refused(await chat.post(token, "hello"), "CHAIN_UNAVAILABLE");
  chat.clock.ms += 4_999;
  refused(await role(chat.depositor.address), "CHAIN_UNAVAILABLE");
  assert.equal(chat.ledger.reads, reads + 1);
  assert.equal(chat.logs.length, 1);
  assert.match(chat.logs[0] ?? "", /^vault read failed \(0x[0-9a-f]{40}\): "/);
  // Another vault was never affected.
  const elsewhere = await chat.call(
    "GET",
    `/vaults/${otherVault}/role?address=${chat.depositor.address}`,
  );
  assert.equal(elsewhere.body.role, "owner");
  chat.clock.ms += 1;
  assert.equal((await role(chat.depositor.address)).body.role, "depositor");
  assert.equal((await chat.post(token, "hello")).status, 201);
  assert.equal(chat.logs.length, 1);
});
test("when enough reads are out a request is told to come back, and a signed-in one is kept a place", async (t) => {
  // A chain whose balance reads are not answered until the test says so, and
  // where everybody then holds a deposit.
  const waiting: (() => void)[] = [];
  let answering = false;
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: async () => stranger,
    isDepositor: () =>
      answering
        ? Promise.resolve(true)
        : new Promise((resolve) => waiting.push(() => resolve(true))),
  };
  const chat = await startChat({}, { chain });
  t.after(chat.close);
  const role = (i: number, at = vault) =>
    chat.call(
      "GET",
      `/vaults/${at}/role?address=0x${i.toString(16).padStart(40, "0")}`,
    );
  const [first, second, third] = await Promise.all(
    [chat.depositor, chat.visitor, chat.owner].map(chat.signIn),
  );
  // Six lookups of one vault, which anyone may send, are out at the chain.
  const held = Array.from({ length: 6 }, (_, i) => role(i));
  await until(() => waiting.length === 6);
  // A seventh is not sent: 503, and when to come back.
  const busy = await role(6);
  refused(busy, "CHAIN_BUSY");
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal(waiting.length, 6);
  // Half a minute on, the owner has to be read again before anyone's role
  // is known. A request without a token is refused that read too, and a
  // signed-in wallet's hide is given it: the wallet is told it is no owner.
  chat.clock.ms += 30_000;
  refused(await role(7), "CHAIN_BUSY");
  refused(await chat.hide(third ?? "", 1, true), "NOT_MODERATOR");
  // The posts of two signed-in wallets are sent all the same, and wait for
  // the chain like the rest.
  const posts = [
    chat.post(first ?? "", "hello"),
    chat.post(second ?? "", "hi"),
  ];
  await until(() => waiting.length === 8);
  // With eight out, a token does not help either, and nothing is stored.
  const full = await chat.post(third ?? "", "no room");
  refused(full, "CHAIN_BUSY");
  assert.equal(full.headers.get("retry-after"), "1");
  assert.equal(waiting.length, 8);
  // The room next door is read as usual.
  const elsewhere = role(0, otherVault);
  await until(() => waiting.length === 9);
  // The chain answers: everyone held is served, and the vault is read again.
  answering = true;
  for (const answer of waiting) answer();
  for (const reply of await Promise.all([...held, elsewhere]))
    assert.deepEqual(reply.body, { role: "depositor", canPost: true });
  for (const reply of await Promise.all(posts)) assert.equal(reply.status, 201);
  assert.equal((await role(6)).body.role, "depositor");
  assert.equal((await chat.post(third ?? "", "room now")).status, 201);
  assert.deepEqual(
    (await chat.messages()).map((message) => message.text).sort(),
    ["hello", "hi", "room now"],
  );
  assert.equal(chat.logs.length, 0);
});
test("a signed-in request is kept a place at the Factory too", async (t) => {
  // A chain whose Factory does not answer until the test says so.
  const waiting: (() => void)[] = [];
  const chain: Chain = {
    isVault: () => new Promise((resolve) => waiting.push(() => resolve(true))),
    ownerOf: async () => stranger,
    isDepositor: async () => true,
  };
  const chat = await startChat({}, { chain });
  t.after(chat.close);
  const at = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
  const room = (i: number) => chat.call("GET", `/vaults/${at(i)}/messages`);
  const [first, second, third] = await Promise.all(
    [chat.depositor, chat.visitor, chat.owner].map(chat.signIn),
  );
  // Six rooms nobody has asked about before are being looked up.
  const held = Array.from({ length: 6 }, (_, i) => room(i));
  await until(() => waiting.length === 6);
  refused(await room(6), "CHAIN_BUSY");
  // A post and a hide in rooms not seen before are looked up all the same.
  const post = chat.post(first ?? "", "hello", at(7));
  const hide = chat.hide(second ?? "", 1, true, at(8));
  await until(() => waiting.length === 8);
  refused(await chat.post(third ?? "", "no room", at(9)), "CHAIN_BUSY");
  assert.equal(waiting.length, 8);
  for (const answer of waiting) answer();
  for (const reply of await Promise.all(held)) assert.equal(reply.status, 200);
  assert.equal((await post).status, 201);
  refused(await hide, "NOT_MODERATOR");
});
test("the log grows by a line a second at most, however many vaults' reads fail", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const at = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
  // A hundred and five rooms, each seen while the chain could be read.
  for (let i = 1; i <= 105; i++) {
    chat.ledger.vaults.set(at(i), { owner: stranger, depositors: new Set() });
    assert.equal((await chat.messages("", at(i))).length, 0);
  }
  const ask = (i: number) =>
    chat.call("GET", `/vaults/${at(i)}/role?address=${stranger}`);
  // The RPC goes down and a role is asked for in each room: every request
  // is a failed read of another vault.
  chat.ledger.failing = true;
  const reads = chat.ledger.reads;
  for (let i = 1; i <= 100; i++) refused(await ask(i), "CHAIN_UNAVAILABLE");
  assert.equal(chat.ledger.reads, reads + 100);
  // Twenty lines, then one saying that more are being left out.
  assert.equal(chat.logs.length, 21);
  assert.match(chat.logs[20] ?? "", /^more chain read failures are not being/);
  chat.clock.ms += 999;
  refused(await ask(101), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 21);
  // The next line says how many, ahead of anything a vault could word.
  chat.clock.ms += 1;
  refused(await ask(102), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 22);
  assert.match(chat.logs[21] ?? "", /^\(81 left out\) chain read failed \(0x/);
  assert.match(chat.logs[21] ?? "", /^[\x20-\x7e]+$/);
  // Setting the wall clock forward does not bring the allowance back.
  chat.clock.wall += 3_600_000;
  refused(await ask(103), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 23);
  assert.match(chat.logs[22] ?? "", /^more chain read failures are not being/);
  // Once it has been quiet the allowance returns and one line is owed.
  chat.clock.ms += 60_000;
  refused(await ask(104), "CHAIN_UNAVAILABLE");
  refused(await ask(105), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 25);
  assert.match(chat.logs[23] ?? "", /^\(1 left out\) chain read failed/);
  assert.doesNotMatch(chat.logs[24] ?? "", /left out/);
});
test("one vault asked about many times a second does not take the log from the others", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const role = (at: string, i: number) =>
    chat.call(
      "GET",
      `/vaults/${at}/role?address=0x${i.toString(16).padStart(40, "0")}`,
    );
  // Both rooms are known, and then the RPC fails every read.
  assert.equal((await role(vault, 0)).status, 200);
  assert.equal((await role(otherVault, 0)).status, 200);
  chat.ledger.failing = true;
  chat.clock.ms += 30_000;
  // A hundred requests for one vault in a minute: a line every five seconds.
  for (let i = 1; i <= 100; i++) {
    refused(await role(vault, i), "CHAIN_UNAVAILABLE");
    chat.clock.ms += 600;
  }
  assert.equal(chat.logs.length, 12);
  for (const line of chat.logs) assert.ok(line.includes(vault), line);
  // So the other vault's failure is still written out, in full and at once.
  refused(await role(otherVault, 1), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 13);
  assert.match(
    chat.logs[12] ?? "",
    new RegExp(`^chain read failed \\(${otherVault}\\): "`),
  );
});
test("an internal error is logged even while chain failures are being left out", async (t) => {
  const chat = await startChat(
    {},
    {
      db: (db) => ({
        ...db,
        list() {
          throw new Error("disk I/O error");
        },
      }),
    },
  );
  t.after(chat.close);
  const at = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
  const role = (i: number, address: string) =>
    chat.call("GET", `/vaults/${at(i)}/role?address=${address}`);
  // Fifty rooms, and the one whose messages cannot be listed, are known
  // before the RPC goes down.
  for (let i = 1; i <= 50; i++) {
    chat.ledger.vaults.set(at(i), { owner: stranger, depositors: new Set() });
    assert.equal((await role(i, at(1))).status, 200);
  }
  const known = await chat.call(
    "GET",
    `/vaults/${vault}/role?address=${stranger}`,
  );
  assert.equal(known.status, 200);
  chat.ledger.failing = true;
  for (let i = 1; i <= 50; i++)
    refused(await role(i, at(2)), "CHAIN_UNAVAILABLE");
  assert.equal(chat.logs.length, 21);
  // The room's own fault still reaches the log, on its own allowance.
  refused(await chat.call("GET", messagesPath), "INTERNAL");
  assert.equal(chat.logs.length, 22);
  assert.match(chat.logs[21] ?? "", /^request failed: "Error: disk I\/O error/);
  // Which is limited in the same way.
  for (let i = 0; i < 30; i++)
    refused(await chat.call("GET", messagesPath), "INTERNAL");
  assert.equal(chat.logs.length, 22 + 19 + 1);
  assert.match(chat.logs.at(-1) ?? "", /^more internal errors are not being/);
});
test("without a clock of its own to be given, the app still measures elapsed time", async (t) => {
  // The app is left on its default monotonic clock, as main.ts leaves it.
  const chat = await startChat({}, { ownClock: true });
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  assert.equal((await chat.post(token, "one")).status, 201);
  const reads = chat.ledger.reads;
  // The wall clock the app was given jumps an hour ahead. Had the limiter or
  // the role cache been wired to it, the gap would be over and the role stale.
  chat.clock.wall += 3_600_000;
  refused(await chat.post(token, "two"), "RATE_LIMITED");
  assert.equal(chat.ledger.reads, reads);
});
test("a wall clock set back does not keep a stale role or lock an author out", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const role = async () =>
    (
      await chat.call(
        "GET",
        `/vaults/${vault}/role?address=${chat.depositor.address}`,
      )
    ).body.role;
  assert.equal((await chat.post(token, "before the correction")).status, 201);
  // The clock is corrected back by an hour, and the wallet withdraws.
  chat.clock.ms -= 3_600_000;
  chat.ledger.vaults.get(vault)?.depositors.clear();
  refused(await chat.post(token, "too soon"), "RATE_LIMITED");
  // Three seconds later the gap has passed, whatever the wall clock says.
  chat.clock.ms += 3_000;
  const posted = await chat.post(token, "after the correction");
  assert.equal(posted.status, 201);
  // Timestamps and tokens follow the wall clock.
  assert.equal(
    (posted.body.message as { createdAt: number }).createdAt,
    chat.seconds(),
  );
  // The role read is thirty seconds old thirty seconds later, not in an hour.
  chat.clock.ms += 26_999;
  assert.equal(await role(), "depositor");
  chat.clock.ms += 1;
  assert.equal(await role(), "visitor");
  refused(await chat.post(token, "after leaving"), "POSTING_NOT_ALLOWED");
});
test("a wall clock set forward does not open the limiter or drop cached roles", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  assert.equal((await chat.post(token, "one")).status, 201);
  const reads = chat.ledger.reads;
  // An hour is added to the wall clock while no time passes.
  chat.clock.wall += 3_600_000;
  const early = await chat.post(token, "two");
  refused(early, "RATE_LIMITED");
  assert.equal(early.headers.get("retry-after"), "3");
  assert.equal(chat.ledger.reads, reads);
  chat.clock.ms += 3_000;
  assert.equal((await chat.post(token, "two")).status, 201);
  assert.equal(chat.ledger.reads, reads);
  // The token does follow the wall clock: twelve hours on it and it is over.
  chat.clock.wall += 11 * 3_600_000;
  refused(await chat.post(token, "three"), "UNAUTHORIZED");
});
test("a token from another deployment that shares the secret is refused", async (t) => {
  const sessionSecret = "one-secret-given-to-two-deployments-by-mistake";
  const here = await startChat({
    sessionSecret,
    audience: "https://a.example",
  });
  const there = await startChat({
    sessionSecret,
    audience: "https://b.example",
  });
  const again = await startChat({
    sessionSecret,
    audience: "https://a.example",
  });
  t.after(() => Promise.all([here.close(), there.close(), again.close()]));
  const token = await here.signIn(here.owner);
  assert.equal((await here.post(token, "at home")).status, 201);
  refused(await there.post(token, "abroad"), "UNAUTHORIZED");
  // The same deployment, restarted, accepts it: it gets as far as the role.
  refused(await again.post(token, "home again"), "POSTING_NOT_ALLOWED");
});
test("a role read is trusted for thirty seconds, then the chain decides again", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  await chat.say(token, "first");
  chat.ledger.failing = true;
  chat.clock.ms += 26_999;
  assert.equal((await chat.post(token, "cached")).status, 201);
  chat.clock.ms += 3_000;
  refused(await chat.post(token, "stale"), "CHAIN_UNAVAILABLE");
  assert.equal((await chat.messages()).length, 2);
});
test("text must be 1 to 1000 code points after trimming, without control or invisible characters", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  for (const text of [
    "",
    "   ",
    "\n\n",
    "x".repeat(1001),
    "😀".repeat(1001),
    "tab\there",
    "carriage\rreturn",
    "nul\u0000",
    "escape\u001b[31m",
    "lone\ud800surrogate",
    "\u200b",
    "zero\u200bwidth",
    "send funds to \u202eevil",
    "a\u200db",
    "\u3164",
    "\u2800\u2800",
    "a\u061cb",
    `a${"\n".repeat(21)}b`,
    undefined,
    null,
    42,
    ["text"],
    { text: "nested" },
  ])
    refused(await chat.post(token, text as string), "INVALID_TEXT");
  assert.deepEqual(await chat.messages(), []);
  assert.equal((await chat.say(token, "x".repeat(1000))).text?.length, 1000);
  assert.equal((await chat.say(token, "😀".repeat(1000))).text?.length, 2000);
  assert.equal(
    (await chat.say(token, "  두 줄\n메시지  ")).text,
    "두 줄\n메시지",
  );
  // A joiner inside an emoji is part of the emoji: this is a shrugging man.
  const shrug = "\u{1f937}\u200d\u2642\ufe0f";
  assert.equal((await chat.say(token, shrug)).text, shrug);
  const tall = `a${"\n".repeat(20)}b`;
  assert.equal((await chat.say(token, tall)).text, tall);
});
test("an author gets one message per three seconds in a vault", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  assert.equal((await chat.post(token, "one")).status, 201);
  const early = await chat.post(token, "two");
  refused(early, "RATE_LIMITED");
  assert.equal(early.status, 429);
  assert.equal(early.headers.get("retry-after"), "3");
  chat.clock.ms += 2_999;
  const almost = await chat.post(token, "two");
  refused(almost, "RATE_LIMITED");
  assert.equal(almost.headers.get("retry-after"), "1");
  chat.clock.ms += 1;
  assert.equal((await chat.post(token, "two")).status, 201);
  // Another author, and the same author in another vault, are not held back.
  const owner = await chat.signIn(chat.owner);
  assert.equal((await chat.post(owner, "operator")).status, 201);
  assert.equal((await chat.post(token, "elsewhere", otherVault)).status, 201);
  refused(await chat.post(token, "three"), "RATE_LIMITED");
  assert.equal((await chat.messages()).length, 3);
});
test("an author gets thirty messages per ten minutes in a vault", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const started = chat.clock.ms;
  for (let i = 1; i <= 30; i++) await chat.say(token, `message ${i}`);
  // 90 s in: the gap has passed but the window is full until the first leaves.
  const full = await chat.post(token, "message 31");
  refused(full, "RATE_LIMITED");
  assert.equal(full.headers.get("retry-after"), "510");
  chat.clock.ms = started + 599_999;
  refused(await chat.post(token, "message 31"), "RATE_LIMITED");
  chat.clock.ms = started + 600_000;
  assert.equal((await chat.post(token, "message 31")).status, 201);
  assert.equal((await chat.messages("?limit=100")).length, 31);
});
test("a refused post does not use up the allowance", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  refused(await chat.post(token, ""), "INVALID_TEXT");
  assert.equal((await chat.post(token, "valid")).status, 201);
  const visitor = await chat.signIn(chat.visitor);
  refused(await chat.post(visitor, "no"), "POSTING_NOT_ALLOWED");
  chat.ledger.vaults.get(vault)?.depositors.add(chat.visitor.address);
  chat.clock.ms += 5_000;
  assert.equal((await chat.post(visitor, "yes")).status, 201);
});
test("only the vault's owner hides and shows messages; hidden text is not served", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const owner = await chat.signIn(chat.owner);
  const depositor = await chat.signIn(chat.depositor);
  const visitor = await chat.signIn(chat.visitor);
  const secret = "text that must disappear";
  const original = await chat.say(depositor, secret);
  const { id } = original;
  await chat.say(owner, "kept");
  // Not the author, not a visitor, not an anonymous caller.
  refused(await chat.hide(depositor, id, true), "NOT_MODERATOR");
  refused(await chat.hide(visitor, id, true), "NOT_MODERATOR");
  refused(
    await chat.call("POST", `${messagesPath}/${id}/hide`, {
      body: { hidden: true },
    }),
    "UNAUTHORIZED",
  );
  assert.equal((await chat.messages())[0]?.text, secret);
  const hidden = await chat.hide(owner, id, true);
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body.message, {
    ...original,
    text: null,
    hidden: true,
  });
  for (const query of [
    "",
    "?after=0",
    `?before=${id + 1}`,
    "?limit=1&after=0",
  ]) {
    const listed = await chat.call("GET", messagesPath + query);
    assert.equal(JSON.stringify(listed.body).includes(secret), false);
    assert.deepEqual(
      (listed.body.messages as unknown[])[0],
      hidden.body.message,
    );
  }
  assert.equal((await chat.messages())[1]?.text, "kept");
  // Hiding twice changes nothing; showing brings the text back.
  assert.equal((await chat.hide(owner, id, true)).status, 200);
  const shown = await chat.hide(owner, id, false);
  assert.deepEqual([shown.status, shown.body.message], [200, original]);
  assert.deepEqual(
    (await chat.messages()).map(({ hidden, text }) => [hidden, text]),
    [
      [false, secret],
      [false, "kept"],
    ],
  );
});
test("hide is scoped to the room and validates its input", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const owner = await chat.signIn(chat.owner);
  // This wallet is a depositor of one vault and the owner of the other.
  const otherOwner = await chat.signIn(chat.depositor);
  const here = await chat.say(owner, "in the first room");
  const there = await chat.say(otherOwner, "in the second room", otherVault);
  refused(await chat.hide(owner, 999, true), "MESSAGE_NOT_FOUND");
  // A room's owner cannot reach another room's message through their own path.
  refused(await chat.hide(owner, there.id, true), "MESSAGE_NOT_FOUND");
  refused(
    await chat.hide(otherOwner, here.id, true, otherVault),
    "MESSAGE_NOT_FOUND",
  );
  refused(await chat.hide(otherOwner, here.id, true), "NOT_MODERATOR");
  refused(await chat.hide(owner, there.id, true, otherVault), "NOT_MODERATOR");
  assert.equal(
    (await chat.hide(otherOwner, there.id, true, otherVault)).status,
    200,
  );
  assert.equal((await chat.messages())[0]?.hidden, false);
  assert.equal((await chat.messages("", otherVault))[0]?.hidden, true);
  for (const id of ["abc", "-1", "1.5", "01", "1e2"])
    refused(
      await chat.call("POST", `${messagesPath}/${id}/hide`, {
        token: owner,
        body: { hidden: true },
      }),
      "INVALID_REQUEST",
    );
  for (const hidden of [undefined, null, "true", 1, 0])
    refused(
      await chat.call("POST", `${messagesPath}/${here.id}/hide`, {
        token: owner,
        body: { hidden },
      }),
      "INVALID_REQUEST",
    );
});
test("CHAT_ADMIN hides in every room and the owner cannot overrule it", async (t) => {
  const moderator = wallet();
  const chat = await startChat({ admin: moderator.address });
  t.after(chat.close);
  const admin = await chat.signIn(moderator);
  const owner = await chat.signIn(chat.owner);
  const otherOwner = await chat.signIn(chat.depositor);
  const mine = await chat.say(owner, "the operator's own message");
  const theirs = await chat.say(otherOwner, "another room", otherVault);
  assert.equal((await chat.hide(admin, mine.id, true)).status, 200);
  assert.equal(
    (await chat.hide(admin, theirs.id, true, otherVault)).status,
    200,
  );
  refused(await chat.hide(owner, mine.id, false), "HIDDEN_BY_ADMIN");
  refused(await chat.hide(owner, mine.id, true), "HIDDEN_BY_ADMIN");
  assert.equal((await chat.messages())[0]?.text, null);
  // The admin is not a member, so being admin does not allow posting.
  refused(await chat.post(admin, "announcement"), "POSTING_NOT_ALLOWED");
  assert.equal((await chat.hide(admin, mine.id, false)).status, 200);
  assert.equal((await chat.messages())[0]?.text, "the operator's own message");
  // What the owner hid, the admin may show and hide again.
  assert.equal((await chat.hide(owner, mine.id, true)).status, 200);
  assert.equal((await chat.hide(admin, mine.id, true)).status, 200);
  refused(await chat.hide(owner, mine.id, false), "HIDDEN_BY_ADMIN");
  // The admin needs no chain read once the room is known.
  chat.ledger.failing = true;
  chat.clock.ms += 60_000;
  assert.equal((await chat.hide(admin, mine.id, false)).status, 200);
  refused(await chat.hide(owner, mine.id, true), "CHAIN_UNAVAILABLE");
});
test("without CHAT_ADMIN nobody is the admin", async (t) => {
  const chat = await startChat({ admin: null });
  t.after(chat.close);
  const { id } = await chat.say(await chat.signIn(chat.owner), "hello");
  for (const outsider of [chat.depositor, chat.visitor, wallet()])
    refused(
      await chat.hide(await chat.signIn(outsider), id, true),
      "NOT_MODERATOR",
    );
});
test("messages page by id: newest by default, older with before, newer with after", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  for (let i = 1; i <= 120; i++)
    chat.db.add({
      vault: i % 10 === 0 ? otherVault : vault,
      author: stranger,
      role: "depositor",
      text: `m${i}`,
      createdAt: chat.seconds(),
    });
  const ids = async (query: string, at: Address = vault) =>
    (await chat.messages(query, at)).map((message) => message.id);
  const mine = Array.from({ length: 120 }, (_, i) => i + 1).filter(
    (id) => id % 10 !== 0,
  );
  assert.deepEqual(await ids(""), mine.slice(-50));
  assert.deepEqual(await ids("?limit=100"), mine.slice(-100));
  assert.deepEqual(await ids("?limit=3"), [117, 118, 119]);
  assert.deepEqual(await ids("?before=117&limit=3"), [114, 115, 116]);
  assert.deepEqual(await ids("?before=3"), [1, 2]);
  assert.deepEqual(await ids("?before=1"), []);
  assert.deepEqual(await ids("?after=116"), [117, 118, 119]);
  assert.deepEqual(await ids("?after=0&limit=3"), [1, 2, 3]);
  assert.deepEqual(await ids("?after=119"), []);
  assert.deepEqual(await ids("?after=9&before=14"), [11, 12, 13]);
  assert.deepEqual(await ids("?after=0&limit=100"), mine.slice(0, 100));
  assert.deepEqual(
    await ids("", otherVault),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
  );
  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=abc",
    "?limit=",
    "?after=-1",
    "?after=1.5",
    "?before=",
    "?before=latest",
  ])
    refused(await chat.call("GET", messagesPath + query), "INVALID_REQUEST");
});
test("a room exists only for a vault the Factory reports", async (t) => {
  const chat = await startChat({ posting: "open" });
  t.after(chat.close);
  const token = await chat.signIn(chat.owner);
  const path = `/vaults/${stranger}`;
  refused(await chat.call("GET", `${path}/messages`), "NOT_A_VAULT");
  refused(
    await chat.call("GET", `${path}/role?address=${chat.owner.address}`),
    "NOT_A_VAULT",
  );
  refused(await chat.post(token, "hello", stranger), "NOT_A_VAULT");
  refused(await chat.hide(token, 1, true, stranger), "NOT_A_VAULT");
  for (const bad of ["0x1234", "vault", `${vault}0`, vault.slice(2)]) {
    refused(
      await chat.call("GET", `/vaults/${bad}/messages`),
      "INVALID_ADDRESS",
    );
    refused(await chat.post(token, "hello", bad as Address), "INVALID_ADDRESS");
  }
  // "Not a vault" is not remembered: a vault created later gets its room.
  chat.ledger.vaults.set(stranger, {
    owner: chat.owner.address,
    depositors: new Set(),
  });
  assert.equal((await chat.post(token, "hello", stranger)).status, 201);
  // The address is the same room in any letter case.
  const upper = `0x${stranger.slice(2).toUpperCase()}` as Address;
  assert.equal((await chat.messages("", upper))[0]?.vault, stranger);
});
test("unknown routes are 404 and wrong methods are 405 with Allow", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  for (const path of [
    "/",
    "/health/",
    "//health",
    "/session/x",
    "/vaults",
    `/vaults/${vault}`,
    `/vaults/${vault}/messages/`,
    `/vaults/${vault}/messages/1`,
    `/vaults/${vault}/messages/1/hide/x`,
  ])
    refused(await chat.call("GET", path), "NOT_FOUND");
  assert.equal((await chat.call("GET", "/health?x=1")).status, 200);
  // HEAD has no body to carry the code.
  assert.equal((await chat.call("HEAD", "/health")).status, 405);
  for (const [method, path, allow] of [
    ["POST", "/health", "GET"],
    ["DELETE", "/health", "GET"],
    ["GET", "/session", "POST"],
    ["PUT", messagesPath, "GET, POST"],
    ["DELETE", messagesPath, "GET, POST"],
    ["POST", `/vaults/${vault}/role`, "GET"],
    ["GET", `${messagesPath}/1/hide`, "POST"],
  ] as const) {
    const reply = await chat.call(method, path);
    refused(reply, "METHOD_NOT_ALLOWED");
    assert.equal(reply.headers.get("allow"), allow);
  }
});
test("bodies must be JSON objects sent as application/json", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const send = (raw: string, type?: string) =>
    chat.call("POST", messagesPath, {
      token,
      raw,
      headers: type === undefined ? {} : { "Content-Type": type },
    });
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""])
    refused(await send('{"text":"hi"}', type), "UNSUPPORTED_MEDIA_TYPE");
  for (const raw of ["", "{", "text=hi", "[]", '["text"]', "null", '"hi"', "1"])
    refused(await send(raw), "INVALID_JSON");
  // Well-formed JSON around a byte that is not UTF-8.
  refused(
    await chat.call("POST", messagesPath, {
      token,
      raw: Buffer.concat([
        Buffer.from('{"text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    }),
    "INVALID_JSON",
  );
  assert.deepEqual(await chat.messages(), []);
  const accepted = await send(
    '{"text":"hi"}',
    "application/json; charset=utf-8",
  );
  assert.equal(accepted.status, 201);
});
test("responses are uncacheable JSON, set no cookie and expose no internals", async (t) => {
  const chat = await startChat(
    {},
    {
      db: (db) => ({
        ...db,
        list() {
          throw new Error("disk I/O error at /var/lib/chat/chat.sqlite");
        },
      }),
    },
  );
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const failed = await chat.call("GET", messagesPath);
  refused(failed, "INTERNAL");
  // The log gets the reason, as one bounded printable line.
  assert.equal(chat.logs.length, 1);
  assert.match(chat.logs[0] ?? "", /^request failed: "Error: disk I\/O error/);
  assert.match(chat.logs[0] ?? "", /^[\x20-\x7e]{1,430}$/);
  const replies = [
    failed,
    await chat.call("GET", "/health"),
    await chat.post(token, "hello"),
    await chat.call("GET", "/nowhere"),
  ];
  assert.deepEqual(
    replies.map((reply) => reply.status),
    [500, 200, 201, 404],
  );
  for (const reply of replies) {
    assert.equal(
      reply.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    assert.equal(reply.headers.get("set-cookie"), null);
    assert.equal(reply.headers.get("access-control-allow-credentials"), null);
  }
});
test("CORS echoes an allowlisted origin and nothing else", async (t) => {
  const chat = await startChat({
    corsOrigins: [origin, "https://vault.example"],
  });
  t.after(chat.close);
  const from = (value?: string) =>
    chat.call("GET", "/health", {
      headers: value === undefined ? {} : { Origin: value },
    });
  for (const allowed of [origin, "https://vault.example"]) {
    const reply = await from(allowed);
    assert.equal(reply.headers.get("access-control-allow-origin"), allowed);
    assert.equal(reply.headers.get("vary"), "Origin");
  }
  for (const other of [
    undefined,
    "https://evil.example",
    "http://127.0.0.1:5174",
    "https://vault.example.evil.example",
    "null",
    "*",
  ]) {
    const reply = await from(other);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("access-control-allow-origin"), null);
    assert.equal(reply.headers.get("vary"), "Origin");
  }
  // An error must be readable by the allowed page too.
  const failed = await chat.call("POST", messagesPath, {
    body: { text: "hi" },
    headers: { Origin: origin },
  });
  refused(failed, "UNAUTHORIZED");
  assert.equal(failed.headers.get("access-control-allow-origin"), origin);
});
