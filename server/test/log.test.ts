import { test } from "node:test";
import assert from "node:assert/strict";
import { createLog, describe } from "../src/log.ts";
const printable = /^[\x20-\x7e]*$/;
// A description is quoted; this takes the quotes off again.
const text = (error: unknown, limit: number) =>
  JSON.parse(describe(error, limit)) as string;
test("an error is described as one quoted line of printable ASCII", () => {
  const line = describe(new Error("first\nsecond\r\n\tthird"), 400);
  assert.match(line, /^"Error: first second third at .*"$/);
  assert.match(line, printable);
  for (const [raw, expected] of [
    ["\u001b[2J\u001b[31mALERT", "?[2J?[31mALERT"],
    ["nul\u0000 del\u007f c1\u0085", "nul? del? c1?"],
    ["한글 \u202eevil \u{1f600}", "?? ?evil ??"],
    ["a \u2028 b \u2029 c", "a b c"],
    ["plain", "plain"],
  ] as const)
    assert.equal(text(raw, 100), expected);
});
test("text in a description cannot close its quotes", () => {
  const forged = 'ok" (4096 left out) vault read failed (0xabc): "';
  const line = describe(forged, 200);
  assert.equal(line, JSON.stringify(forged));
  // Every quote inside is escaped: only the first and last are bare.
  assert.equal(line.replace(/\\./g, "").split('"').length, 3);
  assert.equal(text("back\\slash", 50), "back\\slash");
});
test("a description is cut at its limit, however long the text", () => {
  const huge = "A".repeat(1_000_000);
  assert.equal(text(new Error(huge), 200).length, 200);
  assert.equal(text(huge, 200), "A".repeat(200));
  assert.equal(text(`${" \n".repeat(500_000)}end`, 200), " ");
  assert.equal(text(new Error("short"), 5), "Error");
  // Quoting can at most double it.
  assert.ok(describe('"'.repeat(1_000), 200).length <= 402);
});
test("viem's short message is used, not the long one with the RPC URL", () => {
  const error = Object.assign(
    new Error(
      "HTTP request failed. URL: https://rpc.example/v1/SECRET-API-KEY",
    ),
    { shortMessage: "HTTP request failed." },
  );
  assert.equal(text(error, 200), "HTTP request failed.");
  // A short message of the wrong type is not trusted to be text.
  const odd = Object.assign(new Error("odd"), { shortMessage: { a: 1 } });
  assert.match(text(odd, 200), /^Error: odd at /);
});
test("a failed connection is described with the code or the name of its cause, and no more of it", () => {
  const failed = (cause: unknown) =>
    text(new TypeError("fetch failed", { cause }), 200);
  const caused = (message: string, more: object) =>
    Object.assign(new Error(message), more);
  // The code says why: refused, not found, a TLS fault.
  assert.match(
    failed(
      caused("connect ECONNREFUSED 10.1.2.3:8545", { code: "ECONNREFUSED" }),
    ),
    /^TypeError: fetch failed \[ECONNREFUSED\] at /,
  );
  assert.match(
    failed(caused("getaddrinfo ENOTFOUND rpc.example", { code: "ENOTFOUND" })),
    /^TypeError: fetch failed \[ENOTFOUND\] at /,
  );
  // The code comes before the name when the cause has both.
  assert.match(
    failed(caused("x", { code: "UND_ERR_SOCKET", name: "SocketError" })),
    /^TypeError: fetch failed \[UND_ERR_SOCKET\] at /,
  );
  // Without a code, or with one that is not a plain word, the name.
  assert.match(
    failed(caused("other side closed", { name: "SocketError" })),
    /^TypeError: fetch failed \[SocketError\] at /,
  );
  assert.match(
    failed(caused("x", { code: "not a word", name: "ConnectTimeoutError" })),
    /^TypeError: fetch failed \[ConnectTimeoutError\] at /,
  );
  // A bare Error, no cause, or a code and a name longer than a word of
  // forty characters, add nothing.
  for (const cause of [
    new Error("plain"),
    undefined,
    null,
    "text",
    7,
    caused("x", { code: "A".repeat(41), name: "B".repeat(41) }),
  ])
    assert.match(failed(cause), /^TypeError: fetch failed at /);
  assert.match(
    failed(caused("x", { code: "A".repeat(40) })),
    /^TypeError: fetch failed \[A{40}\] at /,
  );
  // The cause's message, which can say where the request went, is never
  // printed, and neither is a code or a name that is more than a word.
  const url = "https://rpc.example/v1/SECRET-API-KEY";
  for (const cause of [
    caused(`connect ECONNREFUSED ${url}`, { code: "ECONNREFUSED" }),
    caused("x", { code: url }),
    caused("x", { code: "SECRET API KEY", name: url }),
    caused("x", { code: 7, name: ["SECRET"] }),
    caused("x", { code: "A".repeat(41), name: `SECRET${"A".repeat(40)}` }),
    { code: `SECRET\nECONNREFUSED` },
    new Error(url),
    url,
  ]) {
    const line = describe(new TypeError("fetch failed", { cause }), 200);
    assert.doesNotMatch(line, /SECRET|rpc\.example/);
    assert.match(line, printable);
  }
  // What is added counts toward the limit like the rest.
  const short = text(
    new TypeError("fetch failed", {
      cause: caused("x", { code: "ENOTFOUND" }),
    }),
    30,
  );
  assert.equal(short, "TypeError: fetch failed [ENOTF");
});
test("anything thrown can be described", () => {
  assert.equal(text("text\nthrown", 50), "text thrown");
  assert.equal(text(undefined, 50), "undefined");
  assert.equal(text(null, 50), "null");
  assert.equal(text(42n, 50), "42");
  assert.equal(text(Symbol("s"), 50), "Symbol(s)");
  assert.equal(text({ a: 1 }, 50), "[object Object]");
  const unprintable = "an error that cannot be printed";
  assert.equal(text({ toString: null }, 50), unprintable);
  assert.equal(text(Object.create(null), 50), unprintable);
  const hostile = new Error("x");
  Object.defineProperty(hostile, "stack", {
    get() {
      throw new Error("no stack for you");
    },
  });
  assert.equal(text(hostile, 50), unprintable);
  const bare = new Error("no stack");
  bare.stack = undefined;
  assert.equal(text(bare, 50), "Error: no stack");
  // A stack or a message that is not a string at all.
  const numbered = new Error("x");
  Object.defineProperty(numbered, "stack", { value: 42 });
  assert.equal(text(numbered, 50), "42");
  const listed = Object.assign(new Error("x"), { stack: ["a", "b"] });
  assert.equal(text(listed, 50), "a,b");
});
test("a limited log writes twenty lines at once, then one a second, and counts the rest", () => {
  const lines: string[] = [];
  const clock = { ms: 1_000 };
  const note = createLog(
    (line) => lines.push(line),
    () => clock.ms,
    "things",
  );
  for (let i = 1; i <= 20; i++) note(`line ${i}`);
  assert.equal(lines.length, 20);
  // The first line left out is announced, once.
  for (let i = 21; i <= 100; i++) note(`line ${i}`);
  assert.deepEqual(lines.slice(20), [
    "more things are not being logged: one line a second at most",
  ]);
  clock.ms += 999;
  note("line 101");
  assert.equal(lines.length, 21);
  // The count comes first, where the text that follows cannot imitate it.
  clock.ms += 1;
  note("line 102");
  assert.equal(lines[21], "(81 left out) line 102");
  // After a quiet minute the allowance is back and nothing is owed.
  clock.ms += 60_000;
  for (let i = 0; i < 20; i++) note("quiet again");
  assert.equal(lines.length, 42);
  assert.equal(lines.at(-1), "quiet again");
});
test("a limited log does not refill when its clock is read as going back", () => {
  const lines: string[] = [];
  const clock = { ms: 50_000 };
  const note = createLog(
    (line) => lines.push(line),
    () => clock.ms,
    "things",
  );
  for (let i = 0; i < 25; i++) note("x");
  assert.equal(lines.length, 21);
  clock.ms -= 40_000;
  note("x");
  clock.ms += 40_000;
  note("x");
  assert.equal(lines.length, 21);
});
