import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { USDC, type Dex, type Market, type Scope } from "./hyperliquid/info.ts";

// Limits of HyperCorePrecompileSource.configure: a longer list reverts there.
export const MAX_TOKENS = 6;
export const MAX_DEXES = 8;
export const MAX_CORE_VAULTS = 2;
/** How many share prices the verifier keeps for a Vault. */
export const PRICE_RECORDS = 8;
// Token indexes from here up are HIP-4 outcomes, which the source does not value.
const OUTCOME_BASE = 100_000_000;
const UINT32 = 2 ** 32;

export type ScopeToken = Scope["tokens"][number];
export type Draft = Pick<Scope, "tokens" | "dexes" | "coreVaults">;

const whole = (value: number, below: number) =>
  Number.isInteger(value) && value >= 0 && value < below;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const numeric = (a: Address, b: Address) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

function token(value: ScopeToken): ScopeToken {
  if (!whole(value.index, OUTCOME_BASE))
    throw new Error(
      "토큰 index는 0 이상 1억 미만의 정수여야 합니다. HIP-4 outcome은 등록할 수 없습니다.",
    );
  if (!whole(value.usdcSpot, UINT32))
    throw new Error("USDC pair index는 0 이상의 정수여야 합니다.");
  return {
    index: value.index,
    usdcSpot: value.usdcSpot,
    lending: value.lending,
    reservePrice: value.reservePrice,
  };
}

/** An editable copy. A Vault with nothing registered starts from the mandatory USDC entry. */
export function draftOf(scope: Draft): Draft {
  return {
    tokens: scope.tokens.length
      ? scope.tokens.map(token)
      : [{ index: USDC, usdcSpot: 0, lending: false, reservePrice: false }],
    dexes: [...scope.dexes],
    coreVaults: [...scope.coreVaults],
  };
}

export function sameScope(a: Draft, b: Draft): boolean {
  return (
    a.tokens.length === b.tokens.length &&
    a.dexes.length === b.dexes.length &&
    a.coreVaults.length === b.coreVaults.length &&
    a.tokens.every((row, i) =>
      (["index", "usdcSpot", "lending", "reservePrice"] as const).every(
        (key) => row[key] === b.tokens[i][key],
      ),
    ) &&
    a.dexes.every((dex, i) => dex === b.dexes[i]) &&
    a.coreVaults.every((vault, i) => same(vault, b.coreVaults[i]))
  );
}

/** The venue a report names, and when the report lapses. */
export type Report = {
  kind: "token" | "dex" | "coreVault";
  id: number;
  coreVault: Address;
  expiresAt: bigint;
};

/**
 * Whether `scope` lists the venue a report names. A listed perp DEX or HyperCore vault is counted
 * in full, so no report on it stands. A listed token is counted only for what its registered USDC
 * pair would pay for the holding: while that is nothing, a report on it stands like any other.
 */
export function registered(scope: Draft, report: Report): boolean {
  if (report.kind === "dex") return scope.dexes.includes(report.id);
  if (report.kind === "coreVault")
    return scope.coreVaults.some((row) => same(row, report.coreVault));
  return scope.tokens.some((row) => row.index === report.id);
}

/**
 * What saving `scope` at chain time `now` does to a listed report that has not lapsed.
 * `standing` says that the page saw it stand: the last valuation was refused for it.
 * "answered": its perp DEX or HyperCore vault is registered while the report stands, so the
 * save lifts it: the report leaves the list and the price history restarts (see
 * `priceHistory`). "dropped": the same, but the page did not see the report stand: one that
 * stopped standing by itself only leaves the list, and nothing restarts. "depends": its token
 * is registered, which lifts the report only if the registered pair pays for the holding in the
 * block of the save. This page reads none of that. Empty when the venue is not registered, or
 * the report had lapsed and is only dropped.
 */
export function answer(
  scope: Draft,
  report: Report,
  now: bigint,
  standing: boolean,
): "" | "answered" | "dropped" | "depends" {
  if (now >= report.expiresAt || !registered(scope, report)) return "";
  if (report.kind === "token") return "depends";
  return standing ? "answered" : "dropped";
}

export function addToken(draft: Draft, value: ScopeToken): Draft {
  const added = token(value);
  if (draft.tokens.some((row) => row.index === added.index))
    throw new Error("이미 등록된 토큰입니다.");
  if (draft.tokens.length >= MAX_TOKENS)
    throw new Error(`토큰은 ${MAX_TOKENS}개까지 등록할 수 있습니다.`);
  return {
    ...draft,
    tokens: [...draft.tokens, added].sort((a, b) => a.index - b.index),
  };
}

export function removeToken(draft: Draft, index: number): Draft {
  if (index === USDC) throw new Error("USDC는 범위에서 뺄 수 없습니다.");
  return {
    ...draft,
    tokens: draft.tokens.filter((row) => row.index !== index),
  };
}

export function flagToken(
  draft: Draft,
  index: number,
  flag: "lending" | "reservePrice",
  on: boolean,
): Draft {
  // USDC is the unit of account: it is always worth 1 and has no price source to choose.
  if (index === USDC && flag === "reservePrice")
    throw new Error("USDC는 항상 1로 평가합니다.");
  return {
    ...draft,
    tokens: draft.tokens.map((row) =>
      row.index === index ? { ...row, [flag]: on } : row,
    ),
  };
}

export function addDex(draft: Draft, dex: number): Draft {
  if (!whole(dex, UINT32))
    throw new Error("DEX index는 0 이상의 정수여야 합니다.");
  if (draft.dexes.includes(dex)) throw new Error("이미 등록된 DEX입니다.");
  if (draft.dexes.length >= MAX_DEXES)
    throw new Error(`perp DEX는 ${MAX_DEXES}개까지 등록할 수 있습니다.`);
  return { ...draft, dexes: [...draft.dexes, dex].sort((a, b) => a - b) };
}

export function removeDex(draft: Draft, dex: number): Draft {
  return { ...draft, dexes: draft.dexes.filter((row) => row !== dex) };
}

export function addCoreVault(draft: Draft, value: string): Draft {
  if (!isAddress(value)) throw new Error("올바른 EVM 주소를 입력하세요.");
  const added = getAddress(value);
  if (added === zeroAddress) throw new Error("0 주소는 등록할 수 없습니다.");
  if (draft.coreVaults.some((row) => same(row, added)))
    throw new Error("이미 등록된 HyperCore vault입니다.");
  if (draft.coreVaults.length >= MAX_CORE_VAULTS)
    throw new Error(
      `HyperCore vault는 ${MAX_CORE_VAULTS}개까지 등록할 수 있습니다.`,
    );
  return { ...draft, coreVaults: [...draft.coreVaults, added].sort(numeric) };
}

export function removeCoreVault(draft: Draft, value: Address): Draft {
  return {
    ...draft,
    coreVaults: draft.coreVaults.filter((row) => !same(row, value)),
  };
}

/**
 * Arguments of `configure`, which replaces the whole scope: every list complete and strictly
 * ascending (tokens by index, DEXes and vault addresses numerically), as the contract requires.
 */
export function configureArgs(vault: Address, draft: Draft, enabled: boolean) {
  const tokens = draft.tokens.map(token).sort((a, b) => a.index - b.index);
  const dexes = [...draft.dexes].sort((a, b) => a - b);
  const coreVaults = draft.coreVaults
    .map((row) => getAddress(row))
    .sort(numeric);
  if (!tokens.some((row) => row.index === USDC))
    throw new Error("USDC(index 0)는 반드시 등록해야 합니다.");
  if (tokens.length > MAX_TOKENS)
    throw new Error(`토큰은 ${MAX_TOKENS}개까지 등록할 수 있습니다.`);
  if (dexes.length > MAX_DEXES)
    throw new Error(`perp DEX는 ${MAX_DEXES}개까지 등록할 수 있습니다.`);
  if (coreVaults.length > MAX_CORE_VAULTS)
    throw new Error(
      `HyperCore vault는 ${MAX_CORE_VAULTS}개까지 등록할 수 있습니다.`,
    );
  if (tokens.some((row, i) => i > 0 && tokens[i - 1].index === row.index))
    throw new Error("같은 토큰이 두 번 들어 있습니다.");
  if (dexes.some((dex) => !whole(dex, UINT32)))
    throw new Error("DEX index는 0 이상의 정수여야 합니다.");
  if (dexes.some((dex, i) => i > 0 && dexes[i - 1] === dex))
    throw new Error("같은 DEX가 두 번 들어 있습니다.");
  if (coreVaults.includes(zeroAddress))
    throw new Error("0 주소는 등록할 수 없습니다.");
  if (coreVaults.some((row, i) => i > 0 && coreVaults[i - 1] === row))
    throw new Error("같은 HyperCore vault가 두 번 들어 있습니다.");
  return [vault, tokens, dexes, coreVaults, enabled] as const;
}

/** USDC-quoted spot markets whose base token is not in the draft: what can be added. */
export function tokenChoices(
  markets: readonly Market[],
  draft: Draft,
): Market[] {
  return markets.filter(
    (market) =>
      market.kind === "spot" &&
      market.quote === USDC &&
      market.token !== USDC &&
      !draft.tokens.some((row) => row.index === market.token),
  );
}

export function tokenName(markets: readonly Market[], index: number): string {
  if (index === USDC) return "USDC";
  const market = markets.find(
    (row) => row.kind === "spot" && row.token === index,
  );
  return market ? market.label.split("/")[0] : `토큰 #${index}`;
}

export function dexName(dexes: readonly Dex[], index: number): string {
  const dex = dexes.find((row) => row.index === index);
  if (!dex) return `DEX #${index}`;
  return dex.name || "기본 perp DEX";
}

export type PriceRecord = { price: bigint; time: bigint };

/** The share price the verifier records and compares: the Vault's own ratio, at 1e30. */
export function recordedPrice(assets: bigint, supply: bigint): bigint {
  return ((assets + 1n) * 10n ** 30n) / (supply + 1000n);
}

/**
 * Where a Vault stands against the verifier's price history rules at chain time `now`. A deposit
 * is priced, and an exit settles, only when the oldest record that counts is at least half a
 * window old. A record counts while it is inside the window and was made after `since`, the time
 * the owner last answered a report by registering its venue. A new sample is added only more
 * than an eighth of the window after the last one.
 */
export function priceHistory(
  records: readonly PriceRecord[],
  window: bigint,
  now: bigint,
  since = 0n,
) {
  const written = records.filter((record) => record.time);
  const inside = written.filter((record) => now - record.time <= window);
  const counted = inside.filter((record) => record.time > since);
  const newest = written.reduce<bigint | null>(
    (best, { time }) => (best === null || time > best ? time : best),
    null,
  );
  const oldest = counted.reduce<bigint | null>(
    (best, { time }) => (best === null || time < best ? time : best),
    null,
  );
  const half = window / 2n;
  const gap = window / BigInt(PRICE_RECORDS);
  const age = (time: bigint | null) => (time === null ? null : now - time);
  const oldestAge = age(oldest);
  const newestAge = age(newest);
  return {
    count: written.length,
    /** Records inside the window that are no history: made up to the answer to a report. */
    uncounted: inside.length - counted.length,
    newestAge,
    oldestAge,
    aged: oldestAge !== null && oldestAge >= half,
    /** Seconds until the history is old enough; null when no record counts. */
    agedIn:
      oldestAge === null ? null : oldestAge >= half ? 0n : half - oldestAge,
    /** Seconds until a new sample is due. Before that a call only raises the newest record. */
    recordIn: newestAge === null || newestAge > gap ? 0n : gap - newestAge + 1n,
    /** The highest price inside the window, counted or not: what a price is measured against. */
    highest: inside.reduce((top, { price }) => (price > top ? price : top), 0n),
  };
}

/**
 * The error the verifier answers when `price` is to be used at chain time `now`, for a deposit
 * and for an exit settlement alike: too little history, or a price more than `maxDrawdownBps`
 * below the highest record of the window. Empty when the price passes.
 */
export function priceRefusal(
  records: readonly PriceRecord[],
  window: bigint,
  maxDrawdownBps: bigint,
  price: bigint,
  now: bigint,
  since = 0n,
): "" | "PriceHistoryTooShort" | "PriceDropCooldown" {
  const { aged, highest } = priceHistory(records, window, now, since);
  if (!aged) return "PriceHistoryTooShort";
  return price * 10_000n < highest * (10_000n - maxDrawdownBps)
    ? "PriceDropCooldown"
    : "";
}
