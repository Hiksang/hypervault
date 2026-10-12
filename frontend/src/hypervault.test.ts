import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  blockedText,
  planFor,
  noteData,
  stepGroup,
  coreAddressUrl,
  evmTxUrl,
  externalLink,
  fields,
  kindOf,
  loadPublished,
  parseEvidence,
  parseMonitor,
  parsePmComparison,
  parseStrategy,
  staleness,
} from "./hypervault.ts";

const example = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../public/hypervault/${name}.example.json`, import.meta.url),
      "utf8",
    ),
  );
const HASH = "0x" + "ab".repeat(32);
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

test("the committed example files follow their schemas and say they are examples", () => {
  const evidence = parseEvidence(example("evidence"));
  assert.equal(evidence.example, true);
  assert.equal(evidence.runs.length, 1);
  assert.equal(evidence.runs[0]!.steps.length, 4);
  assert.equal(parseMonitor(example("monitor")).example, true);
  assert.equal(parsePmComparison(example("pm-comparison")).example, true);
  const strategy = parseStrategy(example("strategy"));
  assert.equal(strategy.example, true);
  assert.equal(strategy.plans[0]!.mode, "dry-run");
});

test("extra fields are tolerated, and a missing example flag means real data", () => {
  const raw = { ...example("evidence"), extra: 1 };
  delete raw.example;
  raw.steps[0].extraField = "x";
  const evidence = parseEvidence(raw);
  assert.equal(evidence.example, false);
  assert.equal(evidence.runs[0]!.steps[0]!.id, "deposit");
});

test("a file that breaks its schema names what is wrong", () => {
  const evidence = example("evidence");
  assert.throws(() => parseEvidence(null), /expected an object/);
  assert.throws(
    () => parseEvidence({ ...evidence, schema: "other" }),
    /schema: expected "hypervault.evidence.v1"/,
  );
  assert.throws(
    () =>
      parseEvidence({
        ...evidence,
        steps: [{ ...evidence.steps[0], status: "ok" }],
      }),
    /evidence.steps\[0\].status: expected one of done, pending, failed, not-run/,
  );
  assert.throws(
    () => parseEvidence({ ...evidence, generatedAt: "yesterday" }),
    /generatedAt: expected an ISO 8601 time/,
  );
  assert.throws(
    () => parseEvidence({ ...evidence, example: "yes" }),
    /example: expected a boolean/,
  );
  const monitor = example("monitor");
  assert.throws(
    () => parseMonitor({ ...monitor, ai: { status: "maybe" } }),
    /ai.status/,
  );
  assert.throws(
    () => parseMonitor({ ...monitor, rules: {} }),
    /rules: expected an array/,
  );
  const pm = example("pm-comparison");
  assert.throws(
    () => parsePmComparison({ ...pm, columns: ["hypervault-pm"] }),
    /columns/,
  );
  assert.throws(
    () =>
      parsePmComparison({
        ...pm,
        rows: [{ ...pm.rows[0], "hypervault-pm": "12" }],
      }),
    /rows\[0\].hypervault-pm: expected a number/,
  );
  const strategy = example("strategy");
  assert.throws(
    () =>
      parseStrategy({
        ...strategy,
        plans: [{ ...strategy.plans[0], vault: "ETH" }],
      }),
    /plans\[0\].vault/,
  );
});

test("an unobserved value stays null and is never turned into zero", () => {
  const monitor = parseMonitor(example("monitor"));
  assert.equal(monitor.rules[2]!.observed, null);
  const pm = parsePmComparison(example("pm-comparison"));
  assert.equal(pm.rows[1]!["hypervault-pm"], null);
  assert.deepEqual(fields({ a: null, b: 0, c: { d: 1 }, e: [1] }), [
    ["a", "not observable"],
    ["b", "0"],
    ["c.d", "1"],
    ["e", "[1]"],
  ]);
});

test("an AI response candidate may be a line or name the rule it answers", () => {
  const monitor = example("monitor");
  const parsed = parseMonitor({
    ...monitor,
    ai: {
      ...monitor.ai,
      responseCandidates: [
        "plain",
        { ruleId: "nav", action: "wait" },
        { action: "x" },
      ],
    },
  });
  assert.deepEqual(parsed.ai.responseCandidates, ["plain", "nav: wait", "x"]);
  assert.throws(
    () =>
      parseMonitor({
        ...monitor,
        ai: { ...monitor.ai, responseCandidates: [{ ruleId: "nav" }] },
      }),
    /ai.responseCandidates\[0\].action: expected a string/,
  );
});

test("a monitor file older than 30 minutes is stale", () => {
  const at = Date.parse("2026-10-12T00:00:00Z");
  assert.deepEqual(staleness("2026-10-12T00:00:00Z", at + 30 * 60_000), {
    minutes: 30,
    stale: false,
  });
  assert.equal(
    staleness("2026-10-12T00:00:00Z", at + 30 * 60_000 + 1).stale,
    true,
  );
});

test("missing, empty, malformed and invalid files are distinct states", async () => {
  const reply =
    (body: string, status = 200): typeof fetch =>
    async () =>
      new Response(body, { status });
  const parse = parseEvidence;
  assert.deepEqual(await loadPublished("x", parse, reply("", 404)), {
    kind: "missing",
  });
  assert.deepEqual(await loadPublished("x", parse, reply("  ")), {
    kind: "missing",
  });
  // The dev server answers an unknown path with the page itself.
  assert.deepEqual(
    await loadPublished("x", parse, reply("<!doctype html><html>")),
    { kind: "missing" },
  );
  assert.deepEqual(await loadPublished("x", parse, reply("{oops")), {
    kind: "error",
    error: "malformed JSON",
  });
  assert.deepEqual(await loadPublished("x", parse, reply("{}", 500)), {
    kind: "error",
    error: "HTTP 500",
  });
  const invalid = await loadPublished("x", parse, reply('{"schema":"x"}'));
  assert.equal(invalid.kind, "error");
  const failing: typeof fetch = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await loadPublished("x", parse, failing), {
    kind: "error",
    error: "request failed: offline",
  });
  const ok = await loadPublished(
    "x",
    parse,
    reply(JSON.stringify(example("evidence"))),
  );
  assert.equal(ok.kind, "ok");
});

test("explorer links only for a real hash or address on a known network", () => {
  assert.equal(evmTxUrl(999, HASH), `https://hyperevmscan.io/tx/${HASH}`);
  assert.equal(evmTxUrl(998, HASH), null);
  assert.equal(evmTxUrl(999, "0x12"), null);
  assert.equal(evmTxUrl(999, undefined), null);
  assert.equal(
    coreAddressUrl("hyperliquid-mainnet", ADDRESS),
    `https://app.hyperliquid.xyz/explorer/address/${ADDRESS}`,
  );
  assert.equal(coreAddressUrl("local", ADDRESS), null);
  assert.equal(coreAddressUrl("hyperliquid-mainnet", "0x1"), null);
});

test("repo and video links are shown only for an https URL", () => {
  assert.equal(externalLink(""), null);
  assert.equal(externalLink(undefined), null);
  assert.equal(externalLink("javascript:alert(1)"), null);
  assert.equal(externalLink("http://example.com"), null);
  assert.equal(externalLink("not a url"), null);
  assert.equal(
    externalLink("https://github.com/org/repo"),
    "https://github.com/org/repo",
  );
});

test("a manifest entry is matched to its vault by kind or by an unambiguous name", () => {
  assert.equal(kindOf({ name: "HyperVault HYPE" }), "HYPE");
  assert.equal(kindOf({ name: "UBTC Vault" }), "BTC");
  assert.equal(kindOf({ name: "btc accumulator" }), "BTC");
  assert.equal(kindOf({ name: "USDC carry" }), "USDC");
  assert.equal(kindOf({ name: "HYPE/USDC" }), null);
  assert.equal(kindOf({ name: "Vault" }), null);
  assert.equal(kindOf({ name: "anything", kind: "UBTC" }), "BTC");
  assert.equal(kindOf({ name: "HYPE", kind: "ETH" }), null);
});

test("a NAV blocker is explained by its revert name, an unknown one is still named", () => {
  assert.match(blockedText("PriceDropCooldown"), /\(PriceDropCooldown\)$/);
  assert.equal(
    blockedText("Mystery"),
    "The contract refused to value the vault (Mystery).",
  );
});

test("several runs share the file's fields unless a run names its own", () => {
  const v1 = example("evidence");
  const { steps, limitations, ...top } = v1;
  const evidence = parseEvidence({
    ...top,
    runs: [
      { id: "rt1", title: "Round trip 1", steps, limitations },
      { id: "rt2", steps: [], network: "hyperliquid-mainnet", chainId: 999 },
    ],
  });
  assert.deepEqual(
    evidence.runs.map((r) => [r.id, r.network, r.steps.length]),
    [
      ["rt1", "local", 4],
      ["rt2", "hyperliquid-mainnet", 0],
    ],
  );
  assert.equal(evidence.runs[1]!.vault.name, v1.vault.name);
  assert.deepEqual(evidence.runs[1]!.limitations, []);
  assert.throws(
    () => parseEvidence({ ...top, runs: [{ steps: [{}] }] }),
    /runs\[0\].steps\[0\].id: expected a string/,
  );
});

test("steps are grouped by the phase their id names, or the group they name", () => {
  const groups = [
    "deploy-vault",
    "verify-deployment",
    "bootstrap",
    "finalize-activation",
    "configure-scope",
    "allocate-to-core",
    "set-abstraction-pm",
    "observe-pm-rejected",
    "sync-deposit-2",
    "set-api-wallet",
    "sync-agent-5",
    "nav-reconcile-hype",
    "scope-drop-unsellable-hype",
    "request-redeem-owner",
    "sync-revokeagent-6",
    "recall-from-core",
    "claim-owner",
    "something-else",
  ].map((id) => stepGroup({ id }));
  assert.deepEqual(groups, [
    "Deploy & verify",
    "Deploy & verify",
    "Bootstrap & activation",
    "Bootstrap & activation",
    "Bootstrap & activation",
    "Allocation & Core mode",
    "Allocation & Core mode",
    "Allocation & Core mode",
    "Allocation & Core mode",
    "Agent orders & NAV reconciliation",
    "Agent orders & NAV reconciliation",
    "Agent orders & NAV reconciliation",
    "Agent orders & NAV reconciliation",
    "Exit, recall, settle, claim",
    "Exit, recall, settle, claim",
    "Exit, recall, settle, claim",
    "Exit, recall, settle, claim",
    "Other",
  ]);
  assert.equal(
    stepGroup({ id: "claim", group: "Deploy & verify" }),
    "Deploy & verify",
  );
  assert.equal(
    stepGroup({ id: "claim", group: "nope" }),
    "Exit, recall, settle, claim",
  );
});

test("a JSON object or array note is read as data, any other note stays text", () => {
  assert.deepEqual(noteData('{"a": 1}'), { a: 1 });
  assert.equal(noteData("EVM tx submitted"), null);
  assert.equal(noteData("{broken"), null);
  assert.deepEqual(noteData('["0x1", "0x2"]'), ["0x1", "0x2"]);
  assert.equal(noteData("[not json"), null);
});

test("the published evidence file, when present, parses", () => {
  let raw: string;
  try {
    raw = readFileSync(
      new URL("../public/hypervault/evidence.json", import.meta.url),
      "utf8",
    );
  } catch {
    return;
  }
  const evidence = parseEvidence(JSON.parse(raw));
  assert.ok(evidence.runs.length >= 1);
});

test("a vault page shows the latest executed plan, never a hypothetical one over a real one", () => {
  const base = example("strategy").plans[0];
  const ACCOUNT = "0x46c0e94C07111390d7B1F49147AB397B2d991eAe";
  const plan = (mode: string, observedAt: string, extra = {}) => ({
    ...base,
    vault: "USDC",
    account: ACCOUNT,
    mode,
    observedAt,
    ...extra,
  });
  const { plans } = parseStrategy({
    ...example("strategy"),
    plans: [
      plan("executed", "2026-10-11T17:00:00Z"),
      plan("executed", "2026-10-11T18:00:00Z"),
      plan("dry-run", "2026-10-11T19:00:00Z"),
      plan("executed", "2026-10-11T20:00:00Z", {
        hypothetical: true,
        account: null,
      }),
      { ...base, vault: "HYPE", account: null, hypothetical: true },
    ],
  });
  assert.equal(plans[3]!.account, undefined);
  assert.equal(
    planFor(plans, "USDC", ACCOUNT)!.observedAt,
    "2026-10-11T18:00:00Z",
  );
  assert.equal(
    planFor(plans, "USDC", "0x" + "1".repeat(40))!.hypothetical,
    true,
  );
  assert.equal(planFor(plans, "HYPE")!.hypothetical, true);
  assert.equal(planFor(plans, "BTC"), undefined);
});

test("the published strategy and PM comparison files, when present, parse", () => {
  for (const [name, parse] of [
    ["strategy", parseStrategy],
    ["pm-comparison", parsePmComparison],
    ["monitor", parseMonitor],
  ] as const) {
    let raw: string;
    try {
      raw = readFileSync(
        new URL(`../public/hypervault/${name}.json`, import.meta.url),
        "utf8",
      );
    } catch {
      continue;
    }
    parse(JSON.parse(raw));
  }
});
