import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
// The entry point itself, as `npm start` runs it. The RPC URL points at a
// closed loopback port and is never contacted: the chain is read lazily.
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const base = {
  CHAIN_ID: "998",
  RPC_URL: "http://127.0.0.1:9",
  FACTORY_ADDRESS: `0x${"f0".repeat(20)}`,
  DATABASE_PATH: ":memory:",
  PORT: "0",
};
const secret = "k".repeat(32);
const audience = "https://chat.example.com";
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--experimental-strip-types", main], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { out: "", err: "" };
  child.stdout.setEncoding("utf8").on("data", (text) => (output.out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (output.err += text));
  // Resolves with the first match in stdout, or rejects if the process ends.
  const printed = (pattern: RegExp) =>
    new Promise<string>((resolve, reject) => {
      child.stdout.on("data", () => {
        const found = pattern.exec(output.out)?.[0];
        if (found) resolve(found);
      });
      child.once("close", () => reject(new Error(output.err)));
    });
  return { child, output, printed };
}
test("the server refuses to start without a session secret or an audience", async () => {
  for (const [env, message] of [
    [{ CHAT_AUDIENCE: audience }, "SESSION_SECRET must be at least 32"],
    [
      { CHAT_AUDIENCE: audience, SESSION_SECRET: "short-secret-value" },
      "SESSION_SECRET must be at least 32",
    ],
    [{ SESSION_SECRET: secret }, "CHAT_AUDIENCE must be the public URL"],
    [
      { SESSION_SECRET: secret, CHAT_AUDIENCE: `${audience}/` },
      "CHAT_AUDIENCE must be the public URL",
    ],
  ] as const) {
    const { child, output } = start(env);
    const [code] = await once(child, "close");
    assert.equal(code, 1);
    assert.equal(output.out, "");
    assert.ok(output.err.includes(message), output.err);
    assert.equal(output.err.includes("short-secret-value"), false);
    assert.equal(output.err.includes(secret), false);
    // A configuration mistake is reported as one line, not as a stack trace.
    assert.equal(/^\s+at /m.test(output.err), false);
  }
});
test("the server starts, answers /health and stops on SIGTERM", async (t) => {
  const { child, output, printed } = start({
    SESSION_SECRET: secret,
    CHAT_AUDIENCE: audience,
  });
  t.after(() => child.kill("SIGKILL"));
  const url = await printed(/http:\/\/127\.0\.0\.1:[0-9]+/);
  assert.match(
    output.out,
    /chain 998, audience https:\/\/chat\.example\.com, posting members/,
  );
  assert.equal(output.out.includes(secret), false);
  const health = await fetch(`${url}/health`);
  assert.deepEqual(
    [health.status, await health.json()],
    [200, { ok: true, chainId: 998 }],
  );
  child.kill("SIGTERM");
  assert.deepEqual(await once(child, "close"), [0, null]);
});
