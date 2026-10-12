import { test } from "node:test";
import assert from "node:assert/strict";
import { csp } from "../vite.config.ts";
import { contentSecurityPolicy, policyProblem, policyTag } from "./csp.ts";
import { chainIdOf, rpcUrl } from "./network.ts";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );

test("the built page loads only its own scripts, styles and fonts and talks only to its configured services", () => {
  const policy = directives(contentSecurityPolicy({}));
  assert.deepEqual(policy["default-src"], ["'self'"]);
  assert.deepEqual(policy["script-src"], ["'self'"], "no inline, no eval");
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["base-uri"], ["'none'"]);
  assert.deepEqual(policy["form-action"], ["'none'"]);
  // Mainnet by default: its public RPC and its API, and no chat server.
  assert.deepEqual(policy["connect-src"], [
    "'self'",
    "https://rpc.hyperliquid.xyz",
    "https://api.hyperliquid.xyz",
  ]);
  // Nothing comes from a third party: the page uses the visitor's system fonts.
  assert.deepEqual(policy["style-src"], ["'self'"]);
  assert.deepEqual(policy["font-src"], ["'self'"]);
  const text = contentSecurityPolicy({});
  for (const loose of ["unsafe-inline", "unsafe-eval", "*", "data:", "blob:"])
    assert.ok(!text.includes(loose), loose);
  // Whatever is loaded, not fetched by script, comes from this site.
  for (const [name, sources] of Object.entries(policy))
    if (name !== "connect-src")
      assert.ok(
        sources.every((source) => source === "'self'" || source === "'none'"),
        name,
      );
  assert.ok(!text.includes("frame-ancestors"), "ignored in a meta tag");
});

test("connect-src follows the chain, the RPC and the chat server of the build", () => {
  const connect = (env: Parameters<typeof contentSecurityPolicy>[0]) =>
    directives(contentSecurityPolicy(env))["connect-src"];
  assert.deepEqual(connect({ VITE_CHAIN_ID: "998" }), [
    "'self'",
    "https://rpc.hyperliquid-testnet.xyz",
    "https://api.hyperliquid-testnet.xyz",
  ]);
  // A local chain has no HyperCore behind it: no API origin at all.
  assert.deepEqual(connect({ VITE_CHAIN_ID: "31337" }), [
    "'self'",
    "http://127.0.0.1:8545",
  ]);
  // Only the origin of a URL is named, and one origin is named once.
  assert.deepEqual(
    connect({
      VITE_CHAIN_ID: "999",
      VITE_RPC_URL: "https://rpc.example.com/v1/secret-key?x=1",
      VITE_CHAT_URL: "https://chat.example.com:8443/",
    }),
    [
      "'self'",
      "https://rpc.example.com",
      "https://api.hyperliquid.xyz",
      "https://chat.example.com:8443",
    ],
  );
  assert.deepEqual(
    connect({
      VITE_CHAIN_ID: "31337",
      VITE_RPC_URL: "http://127.0.0.1:8545/",
      VITE_CHAT_URL: "http://127.0.0.1:8545",
    }),
    ["'self'", "http://127.0.0.1:8545"],
  );
  // The page reads the same RPC the policy allows.
  assert.equal(rpcUrl(998), "https://rpc.hyperliquid-testnet.xyz/evm");
  assert.equal(
    rpcUrl(998, "https://rpc.example.com/x"),
    "https://rpc.example.com/x",
  );
});

test("a build with settings the policy cannot name fails instead of shipping a loose one", () => {
  assert.throws(
    () => contentSecurityPolicy({ VITE_CHAIN_ID: "1" }),
    /not a supported chain/,
  );
  assert.throws(
    () => contentSecurityPolicy({ VITE_CHAT_URL: "chat.example.com" }),
    /VITE_CHAT_URL must be an absolute URL/,
  );
  assert.throws(
    () => contentSecurityPolicy({ VITE_RPC_URL: "/rpc" }),
    /VITE_RPC_URL must be an absolute URL/,
  );
  assert.throws(
    () => contentSecurityPolicy({ VITE_CHAT_URL: "javascript:alert(1)" }),
    /must be an http\(s\) URL/,
  );
  for (const url of ["wss://rpc.example.com", "data:text/plain,hi"])
    assert.throws(
      () => contentSecurityPolicy({ VITE_RPC_URL: url }),
      /must be an http\(s\) URL/,
      url,
    );
});

test("a host that would widen the policy, or end its directive, is refused", () => {
  // A source in a policy is not a URL: `*` is a wildcard there and `;` starts a directive.
  for (const url of [
    "https://*.example.com/rpc",
    "https://*/rpc",
    "https://a.example;script-src-elem",
    "https://a.example,b.example",
    "https://rpc_node.example.com",
    "https://rpc.example.com./",
    "https://'self'",
  ])
    for (const name of ["VITE_RPC_URL", "VITE_CHAT_URL"])
      assert.throws(
        () => contentSecurityPolicy({ [name]: url }),
        /must name one plain host|must be an absolute URL/,
        `${name}=${url}`,
      );
  // A URL with a name and password in it is not printed back, and not shipped.
  assert.throws(
    () =>
      contentSecurityPolicy({
        VITE_RPC_URL: "https://user:hunter2@rpc.example.com/x",
      }),
    (e: Error) =>
      /must not carry credentials/.test(e.message) &&
      !e.message.includes("hunter2"),
  );
  // What a host name may be is still taken: any case, a default port, an address, a port.
  const connect = (url: string) =>
    /connect-src ([^;]*)/.exec(
      contentSecurityPolicy({ VITE_CHAT_URL: url }),
    )![1];
  assert.match(
    connect("HTTPS://Chat.Example.COM:443/"),
    / https:\/\/chat\.example\.com$/,
  );
  assert.match(
    connect("http://127.0.0.1:8787"),
    / http:\/\/127\.0\.0\.1:8787$/,
  );
  assert.match(connect("http://[::1]:8787/x"), / http:\/\/\[::1\]:8787$/);
  assert.match(
    connect("https://xn--9t4b11yi5a.example"),
    /xn--9t4b11yi5a\.example$/,
  );
});

test("the chain setting is read as plain digits, the same by the page and by its policy", () => {
  assert.equal(chainIdOf(undefined), 999);
  assert.equal(chainIdOf(""), 999);
  assert.equal(chainIdOf("998"), 998);
  assert.equal(chainIdOf("31337"), 31337);
  for (const odd of [
    " 999 ",
    "0x3e7",
    "999.0",
    "9.99e2",
    "+999",
    "0999",
    "1",
    "abc",
  ]) {
    assert.equal(chainIdOf(odd), null, JSON.stringify(odd));
    assert.throws(
      () => contentSecurityPolicy({ VITE_CHAIN_ID: odd }),
      /not a supported chain/,
      JSON.stringify(odd),
    );
  }
});

test("the plugin takes the settings the build resolved, and puts the policy first in the head", () => {
  const plugin = csp() as unknown as {
    apply: string;
    configResolved: (config: { env: Record<string, string> }) => void;
    transformIndexHtml: () => ReturnType<typeof policyTag>[];
  };
  assert.equal(plugin.apply, "build");
  const env = {
    VITE_CHAIN_ID: "998",
    VITE_RPC_URL: "https://rpc.from-the-env-dir.example/v1",
  };
  // Whatever directory the command runs in, and whatever its environment says.
  process.env.VITE_RPC_URL = "https://rpc.from-the-shell.example";
  try {
    plugin.configResolved({ env });
    assert.deepEqual(plugin.transformIndexHtml(), [
      policyTag(contentSecurityPolicy(env)),
    ]);
  } finally {
    delete process.env.VITE_RPC_URL;
  }
  const [tag] = plugin.transformIndexHtml();
  assert.equal(tag.injectTo, "head-prepend");
  assert.equal(tag.attrs["http-equiv"], "Content-Security-Policy");
  assert.ok(tag.attrs.content.includes("https://rpc.from-the-env-dir.example"));
  assert.ok(!tag.attrs.content.includes("from-the-shell"));
});

test("a built page is checked for the policy of its settings, first in its head", () => {
  const policy = contentSecurityPolicy({ VITE_CHAIN_ID: "998" });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll("'", "&#39;")}">`;
  const page = (head: string) =>
    `<!doctype html>\n<html lang="ko">\n  <head>${head}</head>\n  <body><div id="root"></div></body>\n</html>\n`;
  const rest = `\n    <meta charset="UTF-8" />\n    <script type="module" crossorigin src="/assets/index-x.js"></script>\n  `;
  assert.equal(policyProblem(page(`\n    ${meta}\n${rest}`), policy), "");
  // Shipped without one, with one that comes after something else, or with another build's.
  assert.match(policyProblem(page(rest), policy), /does not begin with/);
  assert.match(
    policyProblem(page(`\n    <meta charset="UTF-8" />\n    ${meta}`), policy),
    /does not begin with/,
  );
  assert.match(
    policyProblem(
      page(`<script src="https://cdn.example/x.js"></script>${meta}`),
      policy,
    ),
    /does not begin with/,
  );
  assert.match(
    policyProblem(page(meta), contentSecurityPolicy({ VITE_CHAIN_ID: "999" })),
    /not the one of these build settings/,
  );
  assert.match(
    policyProblem(
      page(meta.replace("connect-src ", "connect-src https://evil.example ")),
      policy,
    ),
    /not the one of these build settings/,
  );
  assert.match(policyProblem(page(meta + meta), policy), /second policy/);
  assert.match(policyProblem("<html><body></body></html>", policy), /no head/);
});

test("an optional log node is named in connect-src only when configured", () => {
  const connect = (env: Parameters<typeof contentSecurityPolicy>[0]) =>
    directives(contentSecurityPolicy(env))["connect-src"];
  assert.ok(
    !connect({ VITE_CHAIN_ID: "999" })!.includes("https://rpc.hypurrscan.io"),
  );
  assert.ok(
    connect({
      VITE_CHAIN_ID: "999",
      VITE_LOGS_RPC_URL: "https://rpc.hypurrscan.io/",
    })!.includes("https://rpc.hypurrscan.io"),
  );
});
