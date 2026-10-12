import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
const factory = `0x${"Fa".repeat(20)}`;
const required = {
  CHAIN_ID: "999",
  RPC_URL: "http://127.0.0.1:8545",
  FACTORY_ADDRESS: factory,
  CHAT_AUDIENCE: "https://chat.example.com",
  SESSION_SECRET: "k".repeat(32),
};
test("defaults apply when only the required variables are set", () => {
  assert.deepEqual(loadConfig(required), {
    port: 8787,
    host: "127.0.0.1",
    chainId: 999,
    rpcUrl: "http://127.0.0.1:8545",
    factory: factory.toLowerCase(),
    audience: "https://chat.example.com",
    databasePath: "./chat.sqlite",
    sessionSecret: "k".repeat(32),
    corsOrigins: ["http://127.0.0.1:5173"],
    posting: "members",
    admin: null,
  });
});
test("every variable can be set, and an empty one counts as unset", () => {
  const config = loadConfig({
    ...required,
    PORT: "9000",
    HOST: "0.0.0.0",
    CHAIN_ID: "31337",
    DATABASE_PATH: "/var/lib/chat/chat.sqlite",
    CORS_ORIGIN: "https://vault.example, http://localhost:5173 ,",
    CHAT_POSTING: "open",
    CHAT_ADMIN: `0x${"AD".repeat(20)}`,
  });
  assert.equal(config.port, 9000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.chainId, 31337);
  assert.equal(config.databasePath, "/var/lib/chat/chat.sqlite");
  assert.deepEqual(config.corsOrigins, [
    "https://vault.example",
    "http://localhost:5173",
  ]);
  assert.equal(config.posting, "open");
  assert.equal(config.admin, `0x${"ad".repeat(20)}`);
  const blank = loadConfig({
    ...required,
    PORT: "",
    HOST: "",
    DATABASE_PATH: "",
    CORS_ORIGIN: "",
    CHAT_POSTING: "",
    CHAT_ADMIN: "",
  });
  assert.deepEqual(blank, loadConfig(required));
});
test("the server refuses to start without a session secret of 32 characters", () => {
  for (const SESSION_SECRET of [undefined, "", "short", "k".repeat(31)]) {
    assert.throws(
      () => loadConfig({ ...required, SESSION_SECRET }),
      (error: Error) =>
        error.message === "SESSION_SECRET must be at least 32 characters",
    );
  }
});
test("chain, RPC, factory and audience are required and checked", () => {
  for (const [name, values] of Object.entries({
    CHAIN_ID: [undefined, "", "1", "0x3e7", "999.0", "mainnet"],
    RPC_URL: [undefined, "", "rpc.hyperliquid.xyz", "ws://127.0.0.1:8545"],
    FACTORY_ADDRESS: [undefined, "", "0x1234", `0x${"g".repeat(40)}`],
    CHAT_AUDIENCE: [
      undefined,
      "",
      "chat.example.com",
      "/chat",
      "ws://x.example",
    ],
  }))
    for (const value of values)
      assert.throws(
        () => loadConfig({ ...required, [name]: value }),
        new RegExp(`^Error: ${name} must be `),
        `${name}=${value}`,
      );
});
test("malformed optional variables are refused rather than guessed", () => {
  for (const [name, values] of Object.entries({
    PORT: ["-1", "65536", "80.5", "http", "0x50"],
    CHAT_POSTING: ["everyone", "MEMBERS"],
    CHAT_ADMIN: ["0x1234", "admin"],
    CORS_ORIGIN: [
      "*",
      "null",
      "vault.example",
      "https://vault.example/",
      "https://vault.example/app",
      "https://ok.example,*",
    ],
  }))
    for (const value of values)
      assert.throws(
        () => loadConfig({ ...required, [name]: value }),
        new RegExp(`^Error: ${name} `),
        `${name}=${value}`,
      );
});
test("the audience is a URL written the one way clients will write it", () => {
  for (const CHAT_AUDIENCE of [
    "https://chat.example.com",
    "https://chat.example.com:8443",
    "https://example.com/chat",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ])
    assert.equal(
      loadConfig({ ...required, CHAT_AUDIENCE }).audience,
      CHAT_AUDIENCE,
    );
  for (const CHAT_AUDIENCE of [
    "https://chat.example.com/",
    "https://example.com/chat/",
    "https://chat.example.com:443",
    "http://chat.example.com:80",
    "HTTPS://chat.example.com",
    "https://Chat.Example.com",
    "https://chat.example.com?x=1",
    "https://chat.example.com#top",
    "https://user:pass@chat.example.com",
    "https://example.com/a/../chat",
  ])
    assert.throws(
      () => loadConfig({ ...required, CHAT_AUDIENCE }),
      /^Error: CHAT_AUDIENCE must be the public URL of this server/,
      CHAT_AUDIENCE,
    );
});
test("an error message never echoes the secret", () => {
  const secret = "hunter2-hunter2-hunter2";
  assert.throws(
    () => loadConfig({ ...required, SESSION_SECRET: secret }),
    (error: Error) => !error.message.includes(secret),
  );
});
