import { decodeAbiParameters, encodeAbiParameters, type Address } from "viem";
import { client } from "./chain";

/**
 * HyperCore read precompiles (docs/reference/L1Read.sol): raw ABI arguments, no selector.
 * Issued with `client.call`, so they join the page's Multicall3 aggregate3; each read still
 * fails on its own. A failed read is an error, never a zero.
 *
 * Not called here: the lending user state (0x0811). It errors for an account with no lending
 * entry, and a precompile error inside aggregate3 burns all the gas it was forwarded, which
 * starves every later call of the aggregate. Lending balances come from the NAV source's
 * bounded-gas `observeTokens` (itself precompile-backed) when the scope asks the lending ledger,
 * or else from the Hyperliquid API, and the page says which.
 */
const P = {
  spotBalance: "0x0000000000000000000000000000000000000801",
  markPx: "0x0000000000000000000000000000000000000806",
  oraclePx: "0x0000000000000000000000000000000000000807",
  marginSummary: "0x000000000000000000000000000000000000080f",
  reserve: "0x0000000000000000000000000000000000000812",
  position: "0x0000000000000000000000000000000000000813",
} as const satisfies Record<string, Address>;

/** HYPE on Core: spot token 150, perp 159 (szDecimals 2); USDC spot token 0. */
export const CORE = {
  usdcToken: 0,
  hypeToken: 150,
  hypePerp: 159,
  hypeSzDecimals: 2,
  /** Spot wei decimals of USDC and HYPE on Core. */
  weiDecimals: 8,
} as const;

async function raw(to: Address, data: `0x${string}`) {
  const { data: out } = await client.call({ to, data });
  if (!out || out === "0x")
    throw new Error(`precompile ${to} returned nothing`);
  return out;
}
const u64 = { type: "uint64" } as const;
const i64 = { type: "int64" } as const;

export type CoreRead<T> = { ok: true; value: T } | { ok: false; error: string };
const seen = <T>(work: Promise<T>): Promise<CoreRead<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message.split("\n")[0]! : String(e),
    }),
  );

export type Reserve = {
  borrowBps: bigint;
  supplyBps: bigint;
  utilizationBps: bigint;
  oraclePx: bigint;
  ltvBps: bigint;
};
export type CoreState = {
  spotUsdc: CoreRead<bigint>;
  spotHype: CoreRead<bigint>;
  position: CoreRead<{ szi: bigint; entryNtl: bigint; leverage: number }>;
  markPx: CoreRead<bigint>;
  oraclePx: CoreRead<bigint>;
  margin: CoreRead<{
    accountValue: bigint;
    marginUsed: bigint;
    ntlPos: bigint;
  }>;
  reserveUsdc: CoreRead<Reserve>;
  reserveHype: CoreRead<Reserve>;
};

const spot = (user: Address, token: number) =>
  raw(
    P.spotBalance,
    encodeAbiParameters([{ type: "address" }, u64], [user, BigInt(token)]),
  ).then((d) => decodeAbiParameters([u64, u64, u64], d)[0]);
const reserve = (token: number) =>
  raw(P.reserve, encodeAbiParameters([u64], [BigInt(token)])).then((d) => {
    const [borrowBps, supplyBps, , utilizationBps, oraclePx, ltvBps] =
      decodeAbiParameters([u64, u64, u64, u64, u64, u64, u64, u64], d);
    return { borrowBps, supplyBps, utilizationBps, oraclePx, ltvBps };
  });
const px = (to: Address, perp: number) =>
  raw(to, encodeAbiParameters([{ type: "uint32" }], [perp])).then(
    (d) => decodeAbiParameters([u64], d)[0],
  );

/** One Core account's balances, HYPE short, margin, lending and reserve rates, all at once. */
export function readCore(user: Address): Promise<CoreState> {
  return Promise.all([
    seen(spot(user, CORE.usdcToken)),
    seen(spot(user, CORE.hypeToken)),
    seen(
      raw(
        P.position,
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint32" }],
          [user, CORE.hypePerp],
        ),
      ).then((d) => {
        const [szi, entryNtl, , leverage] = decodeAbiParameters(
          [i64, u64, i64, { type: "uint32" }, { type: "bool" }],
          d,
        );
        return { szi, entryNtl, leverage: Number(leverage) };
      }),
    ),
    seen(px(P.markPx, CORE.hypePerp)),
    seen(px(P.oraclePx, CORE.hypePerp)),
    seen(
      raw(
        P.marginSummary,
        encodeAbiParameters(
          [{ type: "uint32" }, { type: "address" }],
          [0, user],
        ),
      ).then((d) => {
        const [accountValue, marginUsed, ntlPos] = decodeAbiParameters(
          [i64, u64, u64, i64],
          d,
        );
        return { accountValue, marginUsed, ntlPos };
      }),
    ),
    seen(reserve(CORE.usdcToken)),
    seen(reserve(CORE.hypeToken)),
  ]).then(
    ([
      spotUsdc,
      spotHype,
      position,
      markPx,
      oraclePx,
      margin,
      reserveUsdc,
      reserveHype,
    ]) => ({
      spotUsdc,
      spotHype,
      position,
      markPx,
      oraclePx,
      margin,
      reserveUsdc,
      reserveHype,
    }),
  );
}
