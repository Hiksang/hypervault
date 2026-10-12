import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  chatApi,
  chatError,
  sessionTypedDataFor,
  signError,
  signInTime,
  statement,
  toMessage,
  validText,
} from "./chatRules.ts";
// The server's own modules and test harness (stub chain, in-memory database,
// hand-moved clock), imported so the client and the server cannot drift apart.
// They resolve viem from server/node_modules: run npm ci in server/ first.
import * as server from "../../server/src/auth.ts";
import { statuses } from "../../server/src/errors.ts";
import { parseText } from "../../server/src/rules.ts";
import {
  chainId,
  startChat,
  stranger,
  vault,
  type Wallet,
} from "../../server/test/helpers.ts";
const korean = /[가-힣]/;
const fallback = chatError("NO_SUCH_CODE").message;
function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    assert.match(error.message, korean);
    return true;
  });
}
test("message text is trimmed, 1 to 1000 code points, with line feed as the only control character", () => {
  assert.equal(validText("  안녕하세요\n"), "안녕하세요");
  assert.equal(validText("두 줄\n메시지"), "두 줄\n메시지");
  assert.equal(validText("x".repeat(1000)).length, 1000);
  assert.equal(validText("😀".repeat(1000)).length, 2000);
  for (const bad of [
    "",
    "   ",
    "\n",
    "x".repeat(1001),
    "😀".repeat(1001),
    "a\tb",
    "a\rb",
    "a\x00b",
    "a\x7fb",
    "a\x9fb",
    "a\ud800b",
  ])
    assert.throws(
      () => validText(bad),
      (error: Error & { code?: string }) =>
        korean.test(error.message) && error.code === "INVALID_TEXT",
      JSON.stringify(bad),
    );
});
test("message text refuses invisible and direction-changing characters and more than twenty line breaks", () => {
  const refusal = (text: string) => {
    try {
      validText(text);
    } catch (error) {
      assert.equal((error as { code?: string }).code, "INVALID_TEXT");
      return (error as Error).message;
    }
    return null;
  };
  const invisible = refusal("\u200b");
  assert.match(invisible ?? "", korean);
  for (const bad of [
    "zero\u200bwidth",
    "send funds to \u202eevil",
    "\u2066isolated\u2069",
    "word\u2060joiner",
    "left\u200eto right",
    "a\u200db",
    "\u{1f600}\u200d",
    "byte\ufefforder",
    "line\u2028separator",
  ])
    assert.equal(refusal(bad), invisible, JSON.stringify(bad));
  // A joiner that builds an emoji is not hidden text: a shrugging man, a
  // family, an astronaut with a skin tone.
  for (const emoji of [
    "\u{1f937}\u200d\u2642\ufe0f",
    "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
    "\u{1f9d1}\u{1f3fd}\u200d\u{1f680}",
  ])
    assert.equal(validText(emoji), emoji);
  // Arabic letter mark and a deprecated format control: direction, unseen.
  assert.equal(refusal("a\u061cb"), invisible);
  assert.equal(refusal("a\u206ab"), invisible);
  // A message of fillers, blank braille or bare combining marks would look
  // empty, and is refused as an empty one is.
  const empty = refusal("   ");
  for (const blank of [
    "\u3164",
    "\uffa0",
    "\u2800\u2800",
    "\u00ad",
    "\ufe0f",
    "\u0301\u0301",
    "\u{e0041}\u{e0042}",
    // Format characters that act on their neighbours and draw nothing alone.
    "\u0600",
    "\u06dd",
    "\u070f",
    "\ufff9\ufffa\ufffb",
    "\u{110bd}",
  ])
    assert.equal(refusal(blank), empty, JSON.stringify(blank));
  assert.equal(validText("a\u3164"), "a\u3164");
  assert.equal(validText("\u0600123"), "\u0600123");
  const tall = (breaks: number) => `a${"\n".repeat(breaks)}b`;
  assert.equal(validText(tall(20)), tall(20));
  const tooTall = refusal(tall(21));
  assert.match(tooTall ?? "", /20/);
  assert.notEqual(tooTall, invisible);
  assert.equal(refusal(tall(998)), tooTall);
  // More than four stacking marks on one character run over the lines
  // around it. Marks that sit beside the character are not counted.
  const stack = (count: number) =>
    `a${String.fromCodePoint(0x0301).repeat(count)}`;
  assert.equal(validText(stack(4)), stack(4));
  const stacked = refusal(stack(5));
  assert.match(stacked ?? "", korean);
  assert.match(stacked ?? "", /4/);
  assert.notEqual(stacked, invisible);
  assert.equal(refusal(stack(999)), stacked);
  const beside = `a${String.fromCodePoint(0x0903).repeat(9)}`;
  assert.equal(validText(beside), beside);
  // A character that draws nothing between groups of four does not start
  // the count again: a tag, the Mongolian vowel separator, a soft hyphen.
  for (const between of [0xe0041, 0x180e, 0xad])
    assert.equal(
      refusal(
        `a${(stack(4).slice(1) + String.fromCodePoint(between)).repeat(15)}`,
      ),
      stacked,
      between.toString(16),
    );
});
test("the client and the server give the same verdict on every text", () => {
  const samples = [
    "",
    " ",
    "\n \n",
    "\ufeff",
    "\u00a0x\u00a0",
    "  padded  ",
    "line\nfeed",
    "zero\u200dwidth",
    "😀",
    "\ud83d",
    "\ude00",
    "x\ud83d",
    "x".repeat(999),
    "x".repeat(1000),
    "x".repeat(1001),
    ` ${"x".repeat(1000)} `,
    "😀".repeat(1000),
    "😀".repeat(1001),
    "한".repeat(1000),
    "한".repeat(1001),
  ];
  for (let code = 0; code < 0x100; code++)
    samples.push(`a${String.fromCharCode(code)}b`);
  // Every character around the zero-width and directional ranges, alone and
  // inside text, and the byte order mark with its neighbours.
  for (const [first, last] of [
    [0x0300, 0x0303],
    [0x0610, 0x0620],
    [0x115e, 0x1161],
    [0x2000, 0x2071],
    [0x27ff, 0x2801],
    [0x3000, 0x3001],
    [0x3163, 0x3165],
    [0xfe00, 0xfe0f],
    [0xfefc, 0xff01],
    [0xff9f, 0xffa1],
    [0xe0000, 0xe0002],
    [0xe0040, 0xe0042],
  ] as const)
    for (let code = first; code <= last; code++) {
      const character = String.fromCodePoint(code);
      samples.push(character, character.repeat(3), `a${character}b`);
    }
  const joiner = "\u200d";
  samples.push(
    `\u{1f937}${joiner}\u2642\ufe0f`,
    `\u{1f468}${joiner}\u{1f469}${joiner}\u{1f467}`,
    `\u{1f469}${joiner}\u2764\ufe0f${joiner}\u{1f48b}${joiner}\u{1f468}`,
    `\u{1f9d1}\u{1f3fd}${joiner}\u{1f680}`,
    `\u{1f3f3}\ufe0f${joiner}\u26a7\ufe0f`,
    `\u{1f600}${joiner}`,
    `${joiner}\u{1f600}`,
    `\u{1f600}${joiner}b`,
    `a${joiner}\u{1f600}`,
    `\u{1f600}${joiner}${joiner}\u{1f600}`,
    `\u{1f600}\ufe0f\ufe0f${joiner}\u{1f600}`,
  );
  for (const breaks of [0, 1, 19, 20, 21, 22, 500, 998])
    samples.push(`a${"\n".repeat(breaks)}b`, `${"\n".repeat(breaks)}a\nb`);
  // Stacks of combining marks around the limit of four, alike and mixed.
  const mark = String.fromCodePoint(0x0301);
  for (const count of [1, 3, 4, 5, 6, 999])
    samples.push(
      `a${mark.repeat(count)}`,
      `a${mark.repeat(4)}b${mark.repeat(count)}`,
    );
  // Groups of four with a character that draws nothing between them, and
  // with one that does.
  for (const between of [
    0xe0041, 0x180e, 0x1d173, 0xad, 0x3164, 0x115f, 0xfe0f, 0x034f, 0x17b4,
    0xfff9, 0x1bca0, 0x0600, 0xa0, 0x62, 0x093e,
  ])
    for (const groups of [1, 2, 15])
      samples.push(
        `a${(mark.repeat(4) + String.fromCodePoint(between)).repeat(groups)}`,
        `a${(mark.repeat(2) + String.fromCodePoint(between)).repeat(groups)}`,
      );
  // Nonspacing and enclosing marks count together; a spacing mark does not
  // count and ends the run.
  samples.push(
    String.fromCodePoint(0x61, 0x0301, 0x20dd, 0x0302, 0x0300),
    String.fromCodePoint(0x61, 0x0301, 0x20dd, 0x0302, 0x0300, 0x0301),
    String.fromCodePoint(0x61, 0x0301, 0x20dd, 0xfe0f, 0x0300, 0x0301),
    String.fromCodePoint(0x61, 0x0301, 0x20dd, 0x0903, 0xfe0f, 0x0300, 0x0301),
    `a${String.fromCodePoint(0x0903).repeat(9)}`,
    String.fromCodePoint(0x1000, 0x103c, 0x103d, 0x1031, 0x1038),
  );
  for (const sample of samples) {
    let verdict: string | null = null;
    try {
      verdict = validText(sample);
    } catch {
      // Refused: null, like the server.
    }
    assert.equal(verdict, parseText(sample), JSON.stringify(sample));
  }
});
test("the server accepts a session signed over the client's typed data, for its own audience only", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const issuedAt = 1_800_000_000n;
  // The server's CHAT_AUDIENCE. The client may be given it with a slash.
  const audience = "https://chat.example.com";
  assert.equal(statement, server.statement);
  for (const chain of [999, 998, 31337])
    for (const configured of [audience, `${audience}/`, `${audience}//`]) {
      const typedData = chatApi(configured).sessionTypedData(
        chain,
        account.address,
        issuedAt,
      );
      assert.deepEqual(
        typedData,
        server.sessionTypedData(
          { chainId: chain, audience },
          account.address,
          issuedAt,
        ),
      );
      const signature = await account.signTypedData(typedData);
      const accepted = (realm: server.Realm) =>
        server.signedBy(realm, account.address, Number(issuedAt), signature);
      assert.equal(await accepted({ chainId: chain, audience }), true);
      // The signature is bound to the chain and to the server it names.
      assert.equal(await accepted({ chainId: chain + 1, audience }), false);
      assert.equal(
        await accepted({ chainId: chain, audience: "https://other.example" }),
        false,
      );
    }
});
test("a client configured with another URL signs for another audience", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const issuedAt = 1_800_000_000n;
  const realm = { chainId: 999, audience: "https://chat.example.com" };
  for (const configured of [
    "https://other.example",
    "https://chat.example.com.other.example",
    "http://chat.example.com",
    "https://CHAT.example.com",
    "https://chat.example.com:443",
    "https://chat.example.com/api",
    "",
  ]) {
    const signature = await account.signTypedData(
      chatApi(configured).sessionTypedData(999, account.address, issuedAt),
    );
    assert.equal(
      await server.signedBy(
        realm,
        account.address,
        Number(issuedAt),
        signature,
      ),
      false,
      configured,
    );
  }
  // The pure builder puts in exactly the audience it is given.
  assert.equal(
    sessionTypedDataFor(999, "https://chat.example.com/", account.address, 1n)
      .message.audience,
    "https://chat.example.com/",
  );
});
test("every server error code has its own short Korean message", () => {
  for (const code of Object.keys(statuses)) {
    const error = chatError(code);
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.notEqual(error.message, fallback, code);
    assert.match(error.message, korean);
    assert.ok(error.message.length <= 60, code);
  }
});
test("an unknown error code falls back to a generic message", () => {
  assert.match(fallback, korean);
  for (const unknown of [
    "NO_SUCH_CODE",
    "constructor",
    "__proto__",
    "toString",
    "",
    undefined,
    null,
    42,
    {},
  ]) {
    const error = chatError(unknown);
    assert.equal(error.message, fallback);
    assert.equal(error.code, "UNKNOWN");
  }
});
test("a signature the user declined is told apart from one that failed", () => {
  const declined = Object.assign(new Error("User rejected the request."), {
    code: 4001,
  });
  assert.equal(signError(declined).code, "SIGN_REJECTED");
  const wrapped = new Error("request failed", { cause: declined });
  assert.equal(signError(wrapped).code, "SIGN_REJECTED");
  assert.equal(signError(wrapped).cause, wrapped);
  for (const other of [new Error("device locked"), "nope", undefined])
    assert.equal(signError(other).code, "SIGN_FAILED");
  assert.match(signError(declined).message, korean);
});
test("a message from the server is checked before it reaches the UI", () => {
  const message = {
    id: 1,
    vault,
    author: stranger,
    role: "depositor",
    text: "hello",
    createdAt: 1_800_000_000,
    hidden: false,
  };
  assert.deepEqual(toMessage({ ...message, extra: true }), message);
  assert.equal(toMessage({ ...message, text: null, hidden: true }).text, null);
  for (const broken of [
    null,
    "message",
    [],
    { ...message, id: "1" },
    { ...message, id: 1.5 },
    { ...message, vault: "0x1234" },
    { ...message, author: vault.toUpperCase() },
    { ...message, role: "admin" },
    { ...message, text: { toString: () => "x" } },
    { ...message, text: undefined },
    { ...message, createdAt: -1 },
    { ...message, hidden: 0 },
  ])
    assert.throws(
      () => toMessage(broken),
      (error: Error & { code?: string }) => error.code === "BAD_RESPONSE",
      JSON.stringify(broken),
    );
});
test("the client and the real server: sign in, role, post, page and hide", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  // The server's audience is the URL it is reached at. A trailing slash in
  // VITE_CHAT_URL is tolerated, for requests and for the audience alike.
  const api = chatApi(`${chat.url}/`);
  const signIn = async (wallet: Wallet) => {
    const issuedAt = BigInt(chat.seconds());
    const signature = await wallet.account.signTypedData(
      api.sessionTypedData(chainId, wallet.account.address, issuedAt),
    );
    return api.openSession(wallet.account.address, issuedAt, signature);
  };
  const { owner, depositor, visitor } = chat;
  assert.deepEqual(await api.fetchRole(vault, depositor.account.address), {
    role: "depositor",
    canPost: true,
  });
  assert.deepEqual(await api.fetchRole(vault, visitor.address), {
    role: "visitor",
    canPost: false,
  });
  assert.deepEqual(await api.fetchMessages(vault), []);
  const mine = await signIn(depositor);
  assert.deepEqual(Object.keys(mine).sort(), ["address", "expiresAt", "token"]);
  assert.equal(mine.address, depositor.address);
  assert.equal(mine.expiresAt, chat.seconds() + 12 * 60 * 60);
  const first = await api.postMessage(mine, vault, "  첫 메시지\n");
  assert.deepEqual(first, {
    id: 1,
    vault,
    author: depositor.address,
    role: "depositor",
    text: "첫 메시지",
    createdAt: chat.seconds(),
    hidden: false,
  });
  await rejects(api.postMessage(mine, vault, "너무 빨리"), "RATE_LIMITED");
  // Text the client refuses is never sent, so no chain read happens either.
  const reads = chat.ledger.reads;
  await rejects(api.postMessage(mine, vault, "   "), "INVALID_TEXT");
  await rejects(api.postMessage(mine, vault, "tab\there"), "INVALID_TEXT");
  assert.equal(chat.ledger.reads, reads);
  chat.clock.ms += 3_000;
  const operator = await signIn(owner);
  const second = await api.postMessage(operator, vault, "운용자 답변");
  assert.equal(second.role, "owner");
  assert.deepEqual(await api.fetchMessages(vault), [first, second]);
  assert.deepEqual(await api.fetchMessages(vault, { after: 1 }), [second]);
  assert.deepEqual(await api.fetchMessages(vault, { after: 2 }), []);
  assert.deepEqual(await api.fetchMessages(vault, { before: 2, limit: 1 }), [
    first,
  ]);
  assert.deepEqual(await api.fetchMessages(vault, { limit: 1 }), [second]);
  await rejects(api.fetchMessages(vault, { limit: 101 }), "INVALID_REQUEST");
  await rejects(api.setHidden(mine, vault, first.id, true), "NOT_MODERATOR");
  const hidden = { ...first, text: null, hidden: true };
  assert.deepEqual(
    await api.setHidden(operator, vault, first.id, true),
    hidden,
  );
  assert.deepEqual(await api.fetchMessages(vault), [hidden, second]);
  assert.deepEqual(
    await api.setHidden(operator, vault, first.id, false),
    first,
  );
  await rejects(api.setHidden(operator, vault, 99, true), "MESSAGE_NOT_FOUND");
  await rejects(
    api.postMessage(await signIn(visitor), vault, "방문자"),
    "POSTING_NOT_ALLOWED",
  );
  await rejects(api.fetchMessages(stranger), "NOT_A_VAULT");
  await rejects(api.fetchRole(vault, "0x1234"), "INVALID_ADDRESS");
  await rejects(api.fetchMessages("../session" as never), "INVALID_ADDRESS");
  chat.ledger.failing = true;
  await rejects(api.fetchRole(vault, stranger), "CHAIN_UNAVAILABLE");
  chat.ledger.failing = false;
  // A wrong signer is refused by the server, an expired session too.
  const issuedAt = BigInt(chat.seconds());
  const forged = await visitor.account.signTypedData(
    api.sessionTypedData(chainId, owner.account.address, issuedAt),
  );
  await rejects(
    api.openSession(owner.account.address, issuedAt, forged),
    "BAD_SIGNATURE",
  );
  chat.clock.ms += 12 * 60 * 60 * 1000;
  await rejects(api.postMessage(mine, vault, "만료 후"), "UNAUTHORIZED");
  for (const token of ["", "not a token", "line\nbreak", `${mine.token}x`])
    await rejects(
      api.postMessage({ ...mine, token }, vault, "위조"),
      "UNAUTHORIZED",
    );
  assert.equal((await api.fetchMessages(vault)).length, 2);
});
test("a client whose URL is not the server's audience cannot sign in", async (t) => {
  const audience = "https://chat.example.com";
  const chat = await startChat({ audience });
  t.after(chat.close);
  // The client reaches the server at an address the server does not go by.
  const api = chatApi(chat.url);
  const { account, address } = chat.depositor;
  const issuedAt = BigInt(chat.seconds());
  const mine = await account.signTypedData(
    api.sessionTypedData(chainId, account.address, issuedAt),
  );
  await rejects(
    api.openSession(account.address, issuedAt, mine),
    "BAD_SIGNATURE",
  );
  // The same wallet, naming the audience the server is configured with.
  const named = await account.signTypedData(
    sessionTypedDataFor(chainId, audience, account.address, issuedAt),
  );
  const session = await api.openSession(account.address, issuedAt, named);
  assert.equal(session.address, address);
});
test("a busy server is offered the same signature again, without asking the wallet", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const { account } = chat.depositor;
  const issuedAt = BigInt(chat.seconds());
  const signature = await account.signTypedData(
    chatApi(chat.url).sessionTypedData(chainId, account.address, issuedAt),
  );
  // Use the server's whole allowance of signature checks up.
  const body = JSON.stringify({
    address: account.address,
    issuedAt: Number(issuedAt),
    signature,
  });
  for (let i = 0; i < 200; i++) {
    const reply = await fetch(`${chat.url}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(reply.status, 200);
    await reply.arrayBuffer();
  }
  // While the server stays busy the client waits twice, then says so.
  const waits: number[] = [];
  const stuck = chatApi(chat.url, async (ms) => {
    waits.push(ms);
  });
  await rejects(
    stuck.openSession(account.address, issuedAt, signature),
    "BUSY",
  );
  assert.deepEqual(waits, [300, 1_000]);
  // When the allowance returns during a wait, the next try succeeds.
  const patient = chatApi(chat.url, async (ms) => {
    waits.push(ms);
    chat.clock.ms += ms;
  });
  const session = await patient.openSession(
    account.address,
    issuedAt,
    signature,
  );
  assert.equal(session.address, chat.depositor.address);
  assert.deepEqual(waits, [300, 1_000, 300]);
  // Nothing else is tried again: a refusal is final.
  const forged = await chat.visitor.account.signTypedData(
    patient.sessionTypedData(chainId, account.address, issuedAt),
  );
  await rejects(
    patient.openSession(account.address, issuedAt, forged),
    "BAD_SIGNATURE",
  );
  assert.equal(waits.length, 3);
});
test("a sign-in is dated thirty seconds back, so a browser clock may be a minute fast", async (t) => {
  assert.equal(signInTime(1_800_000_030_999), 1_800_000_000n);
  const chat = await startChat();
  t.after(chat.close);
  const api = chatApi(chat.url);
  const { account } = chat.depositor;
  // The browser's clock is `skew` seconds ahead of the server's.
  const signIn = async (skew: number) => {
    const issuedAt = signInTime((chat.seconds() + skew) * 1000);
    const signature = await account.signTypedData(
      api.sessionTypedData(chainId, account.address, issuedAt),
    );
    return api.openSession(account.address, issuedAt, signature);
  };
  for (const skew of [0, 60, -270])
    assert.equal((await signIn(skew)).address, chat.depositor.address);
  await rejects(signIn(61), "SIGNATURE_EXPIRED");
  await rejects(signIn(-271), "SIGNATURE_EXPIRED");
  // The session still runs twelve hours from the time that was signed.
  const session = await signIn(0);
  assert.equal(session.expiresAt, chat.seconds() - 30 + 12 * 60 * 60);
});
test("a missing, unreachable or foreign server becomes a Korean error", async (t) => {
  await rejects(chatApi("").fetchMessages(vault), "NOT_CONFIGURED");
  // Something that is not the chat server answers at the configured URL.
  const other = createServer((req, res) => {
    res.writeHead(req.url?.endsWith("/role?address=" + stranger) ? 500 : 200, {
      "Content-Type": "text/html",
    });
    res.end("<html>not the chat</html>");
  });
  await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
  t.after(() => other.close());
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  await rejects(chatApi(url).fetchMessages(vault), "BAD_RESPONSE");
  const failed = chatApi(url).fetchRole(vault, stranger);
  await assert.rejects(failed, { message: fallback, code: "UNKNOWN" });
  // Nothing listens once it is closed.
  other.closeAllConnections();
  await new Promise((done) => other.close(done));
  await rejects(chatApi(url).fetchMessages(vault), "UNREACHABLE");
});
