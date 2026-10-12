import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyLimit } from "../src/http.ts";
import { chainId, origin, sign, startChat, vault } from "./helpers.ts";
import type { Chat, Wallet } from "./helpers.ts";
// These tests speak plain fetch to the listening server, the way a browser
// would, rather than going through the harness helpers.
const room = `/vaults/${vault}`;
async function request(chat: Chat, path: string, body?: unknown, token = "") {
  const response = await fetch(chat.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}
async function signIn(chat: Chat, from: Wallet): Promise<string> {
  const issuedAt = chat.seconds();
  const signature = await sign(from, issuedAt, chat.config.audience);
  const reply = await request(chat, "/session", {
    address: from.account.address,
    issuedAt,
    signature,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.address, from.address);
  return reply.body.token as string;
}
test("sign in, post, list and hide over HTTP", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const { owner, depositor } = chat;
  const at = chat.seconds();
  assert.deepEqual(await request(chat, "/health"), {
    status: 200,
    body: { ok: true, chainId },
  });
  assert.deepEqual(
    await request(chat, `${room}/role?address=${depositor.address}`),
    { status: 200, body: { role: "depositor", canPost: true } },
  );
  assert.deepEqual(await request(chat, `${room}/messages`), {
    status: 200,
    body: { messages: [] },
  });
  const depositorToken = await signIn(chat, depositor);
  const question = {
    id: 1,
    vault,
    author: depositor.address,
    role: "depositor",
    text: "입금했습니다. 이번 주 운용 계획이 궁금합니다.",
    createdAt: at,
    hidden: false,
  };
  assert.deepEqual(
    await request(
      chat,
      `${room}/messages`,
      { text: `  ${question.text}\n` },
      depositorToken,
    ),
    { status: 201, body: { message: question } },
  );
  chat.clock.ms += 4_000;
  const ownerToken = await signIn(chat, owner);
  const answer = {
    id: 2,
    vault,
    author: owner.address,
    role: "owner",
    text: "이번 주는 현금 비중을 유지합니다.",
    createdAt: at + 4,
    hidden: false,
  };
  assert.deepEqual(
    await request(chat, `${room}/messages`, { text: answer.text }, ownerToken),
    { status: 201, body: { message: answer } },
  );
  assert.deepEqual(await request(chat, `${room}/messages`), {
    status: 200,
    body: { messages: [question, answer] },
  });
  // A client that has seen the first message polls for what came after it.
  assert.deepEqual(await request(chat, `${room}/messages?after=1`), {
    status: 200,
    body: { messages: [answer] },
  });
  assert.deepEqual(await request(chat, `${room}/messages?before=2&limit=1`), {
    status: 200,
    body: { messages: [question] },
  });
  const hidden = { ...question, text: null, hidden: true };
  assert.deepEqual(
    await request(
      chat,
      `${room}/messages/1/hide`,
      { hidden: true },
      depositorToken,
    ),
    { status: 403, body: { error: "NOT_MODERATOR" } },
  );
  assert.deepEqual(
    await request(
      chat,
      `${room}/messages/1/hide`,
      { hidden: true },
      ownerToken,
    ),
    { status: 200, body: { message: hidden } },
  );
  assert.deepEqual(await request(chat, `${room}/messages`), {
    status: 200,
    body: { messages: [hidden, answer] },
  });
  assert.deepEqual(
    await request(
      chat,
      `${room}/messages/1/hide`,
      { hidden: false },
      ownerToken,
    ),
    { status: 200, body: { message: question } },
  );
  assert.deepEqual(chat.logs, []);
});
test("a browser preflight is answered for an allowlisted origin only", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const preflight = (from: string, path: string, method: string) =>
    fetch(chat.url + path, {
      method: "OPTIONS",
      headers: {
        Origin: from,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
  for (const [path, method] of [
    ["/session", "POST"],
    [`${room}/messages`, "POST"],
    [`${room}/messages/1/hide`, "POST"],
    [`${room}/role`, "GET"],
  ] as const) {
    const allowed = await preflight(origin, path, method);
    assert.equal(allowed.status, 204);
    assert.equal(await allowed.text(), "");
    assert.deepEqual(
      [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-max-age",
        "access-control-allow-credentials",
        "vary",
        "set-cookie",
      ].map((name) => allowed.headers.get(name)),
      [
        origin,
        "GET, POST",
        "Authorization, Content-Type",
        "600",
        null,
        "Origin",
        null,
      ],
    );
    const denied = await preflight("https://evil.example", path, method);
    assert.equal(denied.status, 204);
    for (const name of [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
    ])
      assert.equal(denied.headers.get(name), null);
  }
  // The request the preflight allowed is then answered with the origin echoed.
  const actual = await fetch(`${chat.url}${room}/messages`, {
    headers: { Origin: origin },
  });
  assert.equal(actual.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    actual.headers.get("access-control-expose-headers"),
    "Retry-After",
  );
});
test("a body over 16 KB is refused with 413 and nothing is stored", async (t) => {
  const chat = await startChat();
  t.after(chat.close);
  const token = await chat.signIn(chat.depositor);
  const sized = (bytes: number) =>
    JSON.stringify({ text: "x".repeat(bytes - '{"text":""}'.length) });
  const send = (body: string | ReadableStream<Uint8Array>) =>
    fetch(`${chat.url}${room}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      duplex: "half",
    });
  const outcome = async (response: Response) => [
    response.status,
    await response.json(),
  ];
  assert.equal(bodyLimit, 16 * 1024);
  assert.equal(Buffer.byteLength(sized(bodyLimit)), bodyLimit);
  // At the limit the body is read, and refused for its text rather than its size.
  assert.deepEqual(await outcome(await send(sized(bodyLimit))), [
    400,
    { error: "INVALID_TEXT" },
  ]);
  assert.deepEqual(await outcome(await send(sized(bodyLimit + 1))), [
    413,
    { error: "BODY_TOO_LARGE" },
  ]);
  assert.deepEqual(await outcome(await send(sized(8 * bodyLimit))), [
    413,
    { error: "BODY_TOO_LARGE" },
  ]);
  // Without a Content-Length the bytes are counted as they arrive.
  const chunks = Array.from({ length: 5 }, () =>
    new TextEncoder().encode(" ".repeat(4096)),
  );
  const streamed = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.pop();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  assert.deepEqual(await outcome(await send(streamed)), [
    413,
    { error: "BODY_TOO_LARGE" },
  ]);
  // Far past the limit the connection is dropped instead of read to the end,
  // and the server goes on serving.
  await assert.rejects(send("x".repeat(64 * bodyLimit)), TypeError);
  assert.deepEqual(await request(chat, "/health"), {
    status: 200,
    body: { ok: true, chainId },
  });
  assert.deepEqual(await chat.messages(), []);
  assert.deepEqual(chat.logs, []);
});
