// What the HyperVault pages show besides the chain: the fixed facts of the three vaults, and
// the JSON files another process publishes under `public/hypervault/`. Every file is checked
// against its schema before anything of it is drawn: a malformed file is an error state on its
// page, never a crash and never a row of zeros.

export type VaultKind = "HYPE" | "BTC" | "USDC";
export const VAULT_KINDS: readonly VaultKind[] = ["HYPE", "BTC", "USDC"];

export type VaultFacts = {
  kind: VaultKind;
  title: string;
  /** The ERC-20 the contract holds and counts shares, NAV and fees in. */
  asset: string;
  decimals: number;
  deposit: string;
  purpose: string;
  steps: string[];
  perp: string;
  status: string;
  note: string;
};

export const VAULTS: Record<VaultKind, VaultFacts> = {
  HYPE: {
    kind: "HYPE",
    title: "HYPE Vault",
    asset: "HYPE (WHYPE on HyperEVM)",
    decimals: 18,
    deposit: "Native HYPE through the HYPE router (WHYPE inside the vault)",
    purpose:
      "Keep the depositor's HYPE exposure and aim to accumulate more HYPE after costs.",
    steps: [
      "Portfolio Margin borrows USDC against the vault's HYPE",
      "Buys extra HYPE spot with the borrowed USDC",
      "Shorts only the extra quantity on the HYPE perp",
    ],
    perp: "HYPE perp short (extra quantity only)",
    status: "Not deployed: local implementation and dry-run plans only",
    note: "The deposited HYPE itself stays unhedged: HYPE price moves are not strategy performance.",
  },
  BTC: {
    kind: "BTC",
    title: "BTC Vault (UBTC)",
    asset: "UBTC",
    decimals: 8,
    deposit: "UBTC (ERC-20)",
    purpose:
      "Keep the depositor's BTC exposure and aim to accumulate more UBTC after costs.",
    steps: [
      "Portfolio Margin borrows USDC against the vault's UBTC",
      "Buys extra UBTC spot with the borrowed USDC",
      "Shorts only the extra quantity on the BTC perp",
    ],
    perp: "BTC perp short (extra quantity only)",
    status: "Not deployed: local implementation and dry-run plans only",
    note: "UBTC is HyperCore spot token 197; its linked ERC-20 on HyperEVM is what the vault holds. The hedge uses the BTC perp, so spot and perp are different instruments on the same underlying.",
  },
  USDC: {
    kind: "USDC",
    title: "USDC Vault",
    asset: "USDC",
    decimals: 6,
    deposit: "USDC (ERC-20)",
    purpose: "Delta-neutral carry: spot buy plus a matching perp short.",
    steps: [
      "Buys spot",
      "Shorts the matching quantity on the perp",
      "Portfolio Margin once eligible (not at the current size: Unified mode)",
    ],
    perp: "Matching perp short",
    status:
      "Prototype on mainnet with the owner's small funds; strategy v0 under validation",
    note: "Strategy v0: HYPE/USDC spot (pair 107) bought with USDC, HYPE perp short sized from the FILLED spot quantity, spot supplied as collateral for USDC borrowing, IOC orders with a 30 bps cap, no new carry when funding < 0, target |spot − short| × mark ≤ 2 USD. Portfolio Margin once eligible (> $10k account value); currently Unified mode without borrowing.",
  },
};

/** Which of the three vaults a manifest entry is, by its explicit `kind` or else its name. */
export function kindOf(entry: {
  name: string;
  kind?: unknown;
}): VaultKind | null {
  if (typeof entry.kind === "string") {
    const k = entry.kind.toUpperCase();
    if (k === "UBTC") return "BTC";
    return (VAULT_KINDS as readonly string[]).includes(k)
      ? (k as VaultKind)
      : null;
  }
  const found = VAULT_KINDS.filter((k) =>
    new RegExp(k === "BTC" ? "U?BTC" : k, "i").test(entry.name),
  );
  return found.length === 1 ? found[0]! : null;
}

/** The kind the bridge reports (`ManagedAssetBridge.kind`: 0 USDC, 1 HYPE, 2 UBTC). */
export const bridgeKind = (kind: number): VaultKind | null =>
  (["USDC", "HYPE", "BTC"] as const)[kind] ?? null;

// ---------------------------------------------------------------- links

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** HyperEVM explorer link for a transaction, only on mainnet and only for a real hash. */
export function evmTxUrl(chainId: number, hash: string | undefined) {
  return chainId === 999 && hash && HASH.test(hash)
    ? `https://hyperevmscan.io/tx/${hash}`
    : null;
}

/** HyperCore explorer link for an account, on the network the file names. */
export function coreAddressUrl(network: string, address: string | undefined) {
  if (!address || !ADDRESS.test(address)) return null;
  if (network === "hyperliquid-mainnet")
    return `https://app.hyperliquid.xyz/explorer/address/${address}`;
  if (network === "hyperliquid-testnet")
    return `https://app.hyperliquid-testnet.xyz/explorer/address/${address}`;
  return null;
}

/** A build setting's link, or null: only an absolute https URL, never a placeholder. */
export function externalLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- validation

type Obj = Record<string, unknown>;

function object(value: unknown, at: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${at}: expected an object`);
  return value as Obj;
}
function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected an array`);
  return value;
}
function text(o: Obj, key: string, at: string): string {
  if (typeof o[key] !== "string")
    throw new Error(`${at}.${key}: expected a string`);
  return o[key] as string;
}
function maybeText(o: Obj, key: string, at: string): string | undefined {
  return o[key] === undefined ? undefined : text(o, key, at);
}
function number(o: Obj, key: string, at: string): number {
  if (typeof o[key] !== "number" || !Number.isFinite(o[key]))
    throw new Error(`${at}.${key}: expected a number`);
  return o[key] as number;
}
function maybeNumber(o: Obj, key: string, at: string): number | undefined {
  return o[key] === undefined ? undefined : number(o, key, at);
}
function nullableNumber(o: Obj, key: string, at: string): number | null {
  return o[key] === null ? null : number(o, key, at);
}
function oneOf<T extends string>(
  o: Obj,
  key: string,
  values: readonly T[],
  at: string,
): T {
  const value = o[key];
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`${at}.${key}: expected one of ${values.join(", ")}`);
  return value as T;
}
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
function time(o: Obj, key: string, at: string): string {
  const value = text(o, key, at);
  if (!ISO.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error(`${at}.${key}: expected an ISO 8601 time`);
  return value;
}
function maybeTime(o: Obj, key: string, at: string): string | undefined {
  return o[key] === undefined ? undefined : time(o, key, at);
}
function texts(o: Obj, key: string, at: string): string[] {
  return list(o[key], `${at}.${key}`).map((item, i) => {
    if (typeof item !== "string")
      throw new Error(`${at}.${key}[${i}]: expected a string`);
    return item;
  });
}
function maybeTexts(o: Obj, key: string, at: string): string[] | undefined {
  return o[key] === undefined ? undefined : texts(o, key, at);
}
function maybeObject(o: Obj, key: string, at: string): Obj | undefined {
  return o[key] === undefined ? undefined : object(o[key], `${at}.${key}`);
}
function schema(o: Obj, name: string) {
  if (o.schema !== name) throw new Error(`schema: expected "${name}"`);
  if (o.example !== undefined && typeof o.example !== "boolean")
    throw new Error("example: expected a boolean");
}

// ---------------------------------------------------------------- evidence.json

export const STEP_STATUSES = ["done", "pending", "failed", "not-run"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export type EvidenceStep = {
  id: string;
  title: string;
  status: StepStatus;
  layer: "evm" | "core" | "both";
  group?: string;
  txHash?: string;
  evmBlock?: number;
  coreBlock?: number;
  observedAt?: string;
  unit?: string;
  before?: Obj;
  after?: Obj;
  note?: string;
};
export type EvidenceVault = {
  name: string;
  asset: "USDC" | "HYPE" | "UBTC";
  address: string;
  controller: string;
  implementation: string;
  implementationCodehash: string;
  configHash: string;
};
export type EvidenceRun = {
  id: string;
  title?: string;
  network: "hyperliquid-mainnet" | "hyperliquid-testnet" | "local";
  chainId: number;
  generatedAt: string;
  vault: EvidenceVault;
  steps: EvidenceStep[];
  limitations: string[];
};
/** One run (v1: the file itself) or several (`runs`, each taking the file's fields as defaults). */
export type Evidence = {
  example: boolean;
  generatedAt: string;
  runs: EvidenceRun[];
};

const NETWORKS = [
  "hyperliquid-mainnet",
  "hyperliquid-testnet",
  "local",
] as const;

function parseRun(r: Obj, top: Obj, at: string, index: number): EvidenceRun {
  const pick = (key: string) => (r[key] !== undefined ? r : top);
  const v = object(pick("vault").vault, `${at}.vault`);
  const where = `${at}.vault`;
  return {
    id: r.id === undefined ? `run-${index + 1}` : text(r, "id", at),
    title: maybeText(r, "title", at),
    network: oneOf(pick("network"), "network", NETWORKS, at),
    chainId: number(pick("chainId"), "chainId", at),
    generatedAt: time(pick("generatedAt"), "generatedAt", at),
    vault: {
      name: text(v, "name", where),
      asset: oneOf(v, "asset", ["USDC", "HYPE", "UBTC"] as const, where),
      address: text(v, "address", where),
      controller: text(v, "controller", where),
      implementation: text(v, "implementation", where),
      implementationCodehash: text(v, "implementationCodehash", where),
      configHash: text(v, "configHash", where),
    },
    steps: list(r.steps, `${at}.steps`).map((item, i) => {
      const where = `${at}.steps[${i}]`;
      const s = object(item, where);
      return {
        id: text(s, "id", where),
        title: text(s, "title", where),
        status: oneOf(s, "status", STEP_STATUSES, where),
        layer: oneOf(s, "layer", ["evm", "core", "both"] as const, where),
        group: maybeText(s, "group", where),
        txHash: maybeText(s, "txHash", where),
        evmBlock: maybeNumber(s, "evmBlock", where),
        coreBlock: maybeNumber(s, "coreBlock", where),
        observedAt: maybeTime(s, "observedAt", where),
        unit: maybeText(s, "unit", where),
        before: maybeObject(s, "before", where),
        after: maybeObject(s, "after", where),
        note: maybeText(s, "note", where),
      };
    }),
    limitations:
      pick("limitations").limitations === undefined
        ? []
        : texts(pick("limitations"), "limitations", at),
  };
}

export function parseEvidence(raw: unknown): Evidence {
  const o = object(raw, "evidence");
  schema(o, "hypervault.evidence.v1");
  const runs =
    o.runs === undefined
      ? [parseRun(o, o, "evidence", 0)]
      : list(o.runs, "runs").map((item, i) =>
          parseRun(object(item, `runs[${i}]`), o, `runs[${i}]`, i),
        );
  return {
    example: o.example === true,
    generatedAt: time(o, "generatedAt", "evidence"),
    runs,
  };
}

/** The phases of a round trip, in order, that the evidence page groups steps under. */
export const STEP_GROUPS = [
  "Deploy & verify",
  "Bootstrap & activation",
  "Allocation & Core mode",
  "Agent orders & NAV reconciliation",
  "Exit, recall, settle, claim",
  "Other",
] as const;
export type StepGroup = (typeof STEP_GROUPS)[number];
// Tried in this order: the first pattern that matches a step's id decides its group.
const GROUP_RULES: [RegExp, StepGroup][] = [
  [
    /redeem|revoke|exit|recall|settle|claim|withdraw/,
    "Exit, recall, settle, claim",
  ],
  [
    /agent|api-wallet|order|nav|perp|spot|hedge|scope-drop|reconcil/,
    "Agent orders & NAV reconciliation",
  ],
  [
    /allocat|abstraction|sync-control|sync-deposit|pm|deposit|transfer/,
    "Allocation & Core mode",
  ],
  [/bootstrap|activation|scope/, "Bootstrap & activation"],
  [/deploy|verify/, "Deploy & verify"],
];
/** A step's group: the one it names, else the one its id suggests. */
export function stepGroup(step: { id: string; group?: string }): StepGroup {
  if (step.group && (STEP_GROUPS as readonly string[]).includes(step.group))
    return step.group as StepGroup;
  return GROUP_RULES.find(([rule]) => rule.test(step.id))?.[1] ?? "Other";
}

/** A note that is a JSON object or array is shown as data; anything else as the text it is. */
export function noteData(note: string): Obj | unknown[] | null {
  const trimmed = note.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object"
      ? (value as Obj | unknown[])
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- monitor.json

export const RULE_STATUSES = ["ok", "warn", "alert", "unobservable"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export type MonitorRule = {
  id: string;
  title: string;
  unit: string;
  threshold: string;
  observed: string | null;
  status: RuleStatus;
  rationale: string;
  action: string;
};
export type Monitor = {
  example: boolean;
  generatedAt: string;
  lastSuccessAt: string | null;
  runId: string;
  network: string;
  vault: string;
  rules: MonitorRule[];
  errors: string[];
  ai: {
    status: "ok" | "failed" | "disabled";
    model?: string;
    generatedAt?: string;
    inputDigest?: string;
    summary?: string;
    causes?: string[];
    impact?: string;
    responseCandidates?: string[];
    error?: string;
  };
};

/** A threshold is shown as written: a number in the file is kept as its digits. */
function shown(o: Obj, key: string, at: string): string {
  if (typeof o[key] === "number" && Number.isFinite(o[key]))
    return String(o[key]);
  return text(o, key, at);
}

export function parseMonitor(raw: unknown): Monitor {
  const o = object(raw, "monitor");
  schema(o, "hypervault.monitor.v1");
  const ai = object(o.ai, "ai");
  return {
    example: o.example === true,
    generatedAt: time(o, "generatedAt", "monitor"),
    lastSuccessAt:
      o.lastSuccessAt === null ? null : time(o, "lastSuccessAt", "monitor"),
    runId: text(o, "runId", "monitor"),
    network: text(o, "network", "monitor"),
    vault: text(o, "vault", "monitor"),
    rules: list(o.rules, "rules").map((item, i) => {
      const at = `rules[${i}]`;
      const r = object(item, at);
      return {
        id: text(r, "id", at),
        title: text(r, "title", at),
        unit: text(r, "unit", at),
        threshold: shown(r, "threshold", at),
        observed: r.observed === null ? null : shown(r, "observed", at),
        status: oneOf(r, "status", RULE_STATUSES, at),
        rationale: text(r, "rationale", at),
        action: text(r, "action", at),
      };
    }),
    errors: texts(o, "errors", "monitor"),
    ai: {
      status: oneOf(ai, "status", ["ok", "failed", "disabled"] as const, "ai"),
      model: maybeText(ai, "model", "ai"),
      generatedAt: maybeTime(ai, "generatedAt", "ai"),
      inputDigest: maybeText(ai, "inputDigest", "ai"),
      summary: maybeText(ai, "summary", "ai"),
      causes: maybeTexts(ai, "causes", "ai"),
      impact: maybeText(ai, "impact", "ai"),
      responseCandidates:
        ai.responseCandidates === undefined
          ? undefined
          : list(ai.responseCandidates, "ai.responseCandidates").map(
              (item, i) => {
                // A plain line, or `{ ruleId?, action }` naming the rule it answers.
                if (typeof item === "string") return item;
                const at = `ai.responseCandidates[${i}]`;
                const c = object(item, at);
                const rule = maybeText(c, "ruleId", at);
                const action = text(c, "action", at);
                return rule ? `${rule}: ${action}` : action;
              },
            ),
      error: maybeText(ai, "error", "ai"),
    },
  };
}

/** A monitor file older than this is flagged as stale. */
export const STALE_AFTER_MS = 30 * 60_000;
export function staleness(generatedAt: string, now: number) {
  const age = now - Date.parse(generatedAt);
  return { minutes: Math.floor(age / 60_000), stale: age > STALE_AFTER_MS };
}

// ---------------------------------------------------------------- pm-comparison.json

export const PM_COLUMNS = ["separate-margin", "hypervault-pm"] as const;
export type PmComparison = {
  example: boolean;
  generatedAt: string;
  asset: string;
  assumptions: { name: string; value: string; unit: string; source: string }[];
  rows: {
    metric: string;
    unit: string;
    "separate-margin": number | null;
    "hypervault-pm": number | null;
    note?: string;
  }[];
  caveats: string[];
};

export function parsePmComparison(raw: unknown): PmComparison {
  const o = object(raw, "pm-comparison");
  schema(o, "hypervault.pm-comparison.v1");
  const columns = list(o.columns, "columns");
  if (
    columns.length !== PM_COLUMNS.length ||
    columns.some((c, i) => c !== PM_COLUMNS[i])
  )
    throw new Error(`columns: expected ${JSON.stringify(PM_COLUMNS)}`);
  return {
    example: o.example === true,
    generatedAt: time(o, "generatedAt", "pm-comparison"),
    asset: text(o, "asset", "pm-comparison"),
    assumptions: list(o.assumptions, "assumptions").map((item, i) => {
      const at = `assumptions[${i}]`;
      const a = object(item, at);
      return {
        name: text(a, "name", at),
        value: shown(a, "value", at),
        unit: text(a, "unit", at),
        source: text(a, "source", at),
      };
    }),
    rows: list(o.rows, "rows").map((item, i) => {
      const at = `rows[${i}]`;
      const r = object(item, at);
      return {
        metric: text(r, "metric", at),
        unit: text(r, "unit", at),
        "separate-margin": nullableNumber(r, "separate-margin", at),
        "hypervault-pm": nullableNumber(r, "hypervault-pm", at),
        note: maybeText(r, "note", at),
      };
    }),
    caveats: texts(o, "caveats", "pm-comparison"),
  };
}

// ---------------------------------------------------------------- strategy.json

export type StrategyAction = {
  kind: string;
  market: string;
  side: string;
  size: string;
  unit: string;
  reason: string;
};
export type StrategyPlan = {
  vault: VaultKind;
  mode: "dry-run" | "executed";
  account?: string;
  /** An input for a vault that is not deployed: no account, nothing traded. */
  hypothetical: boolean;
  observedAt: string;
  baseExposure: Obj;
  extraHedge: Obj;
  actions: StrategyAction[];
  blocked: string[];
  risk: Obj;
  /** What the exchange answered, for an executed plan. Free-form per entry. */
  results: Obj[];
};
export type Strategy = {
  example: boolean;
  generatedAt: string;
  plans: StrategyPlan[];
};

export function parseStrategy(raw: unknown): Strategy {
  const o = object(raw, "strategy");
  schema(o, "hypervault.strategy.v1");
  return {
    example: o.example === true,
    generatedAt: time(o, "generatedAt", "strategy"),
    plans: list(o.plans, "plans").map((item, i) => {
      const at = `plans[${i}]`;
      const p = object(item, at);
      return {
        vault: oneOf(p, "vault", VAULT_KINDS, at),
        mode: oneOf(p, "mode", ["dry-run", "executed"] as const, at),
        account: p.account === null ? undefined : maybeText(p, "account", at),
        hypothetical: p.hypothetical === true,
        observedAt: time(p, "observedAt", at),
        baseExposure: object(p.baseExposure, `${at}.baseExposure`),
        extraHedge: object(p.extraHedge, `${at}.extraHedge`),
        actions: list(p.actions, `${at}.actions`).map((entry, j) => {
          const where = `${at}.actions[${j}]`;
          const a = object(entry, where);
          return {
            kind: text(a, "kind", where),
            market: text(a, "market", where),
            side: text(a, "side", where),
            size: shown(a, "size", where),
            unit: text(a, "unit", where),
            reason: text(a, "reason", where),
          };
        }),
        blocked: texts(p, "blocked", at),
        risk: object(p.risk, `${at}.risk`),
        results:
          p.results === undefined
            ? []
            : list(p.results, `${at}.results`).map((entry, j) =>
                object(entry, `${at}.results[${j}]`),
              ),
      };
    }),
  };
}

/**
 * The plan a vault page shows for `kind` (and `account`, when the plan names one): the latest
 * executed plan of a real account, else its latest dry run, else the latest hypothetical input.
 */
export function planFor(
  plans: readonly StrategyPlan[],
  kind: VaultKind,
  account?: string,
): StrategyPlan | undefined {
  const mine = plans.filter(
    (p) =>
      p.vault === kind &&
      (!account ||
        !p.account ||
        p.account.toLowerCase() === account.toLowerCase()),
  );
  const latest = (rows: StrategyPlan[]) =>
    rows.reduce<StrategyPlan | undefined>(
      (best, p) =>
        !best || Date.parse(p.observedAt) > Date.parse(best.observedAt)
          ? p
          : best,
      undefined,
    );
  const real = mine.filter((p) => !p.hypothetical);
  return (
    latest(real.filter((p) => p.mode === "executed")) ??
    latest(real) ??
    latest(mine)
  );
}

/** A free-form object of a snapshot as label/value rows; nested objects flatten to `a.b`. */
export function fields(value: Obj, prefix = ""): [string, string][] {
  return Object.entries(value).flatMap(([key, v]): [string, string][] =>
    v && typeof v === "object" && !Array.isArray(v)
      ? fields(v as Obj, `${prefix}${key}.`)
      : [
          [
            prefix + key,
            v === null
              ? "not observable"
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v),
          ],
        ],
  );
}

// ---------------------------------------------------------------- loading

export type Published<T> =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; error: string }
  | { kind: "ok"; value: T };

/**
 * Fetches one published file. Missing (404, empty, or the dev server's HTML fallback) and
 * malformed are different states: a malformed file names what is wrong with it.
 */
export async function loadPublished<T>(
  url: string,
  parse: (raw: unknown) => T,
  fetcher: typeof fetch = fetch,
): Promise<Published<T>> {
  let body: string;
  try {
    const response = await fetcher(url, { cache: "no-store" });
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok)
      return { kind: "error", error: `HTTP ${response.status}` };
    body = await response.text();
  } catch (e) {
    return {
      kind: "error",
      error: `request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith("<")) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { kind: "error", error: "malformed JSON" };
  }
  try {
    return { kind: "ok", value: parse(raw) };
  } catch (e) {
    return { kind: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- NAV blockers

const BLOCKERS: Record<string, string> = {
  NavUnavailable:
    "The vault does not price deposits now: a Core action awaits confirmation, or the vault is not in the ready/active phase.",
  PendingCoreAction:
    "A Core action submitted from the EVM awaits confirmation on HyperCore.",
  ActionNotFinal: "The pending Core action is not final yet.",
  CoreNotReady: "Core activation is not confirmed yet.",
  PriceHistoryTooShort:
    "Not enough share-price history in the price window yet (anyone can record a price).",
  PriceDropCooldown:
    "The share price is below the window's high by more than the limit: deposits and settlement wait.",
  NegativeCoreEquity: "Core net equity is negative.",
  NegativeDexEquity: "A registered perp DEX account value is negative.",
  OpenReport:
    "A holding outside the registered valuation scope has been reported.",
  ScopeIncomplete:
    "A lending ledger outside the registered scope holds a balance or debt.",
  ScopeUnavailable:
    "The valuation scope is not registered, or deposit valuation is switched off.",
  PriceGuard:
    "A token price failed the guard (no quote, wide spread, or off the oracle).",
  ReadFailed: "A HyperCore read precompile call failed.",
  InvalidObservation:
    "A HyperCore read did not match the registered scope settings.",
  WrongPhase: "The vault's phase does not allow this.",
  CapitalClosed: "Deposits are closed.",
};

/** Why the contract refused to value the vault, from its revert name. */
export function blockedText(name: string): string {
  return Object.hasOwn(BLOCKERS, name)
    ? `${BLOCKERS[name]} (${name})`
    : `The contract refused to value the vault (${name}).`;
}
