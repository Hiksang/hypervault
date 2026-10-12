import type { CoreState } from "../coreRead";
import { CORE } from "../coreRead";
import {
  currentYield,
  perpPx,
  spotPx,
  units,
  type LendingLeg,
  type YieldBreakdown,
} from "../coreYield";
import type { TokenSeen } from "../directRead";
import type { Activity } from "../vaultActivity";

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
const usd = (x: number) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)} USD`;

export type CurrentYield = {
  value: YieldBreakdown;
  fundingHourly: number;
  oraclePx: number;
  /** Where the lending legs came from: the NAV source's precompile reads, or the API. */
  lendingSource: "precompile" | "api";
  rates: {
    usdcSupply: number;
    usdcBorrow: number;
    hypeSupply: number;
    hypeBorrow: number;
  };
};

/**
 * Current net yield from the Core precompiles, with the funding rate from the API (no precompile
 * exposes it). Null with a reason when a needed read failed; a failed read is never a zero.
 */
export function currentYieldOf(
  core: CoreState | null | undefined,
  activity: Activity | null,
  navUsd: number | null,
  /** The NAV source's token observations (lending is null where the scope does not ask it). */
  tokens?: TokenSeen[] | null,
): { ok: true; value: CurrentYield } | { ok: false; why: string } {
  if (!core) return { ok: false, why: "Core account not read yet." };
  if (navUsd === null || !(navUsd > 0))
    return { ok: false, why: "NAV not read." };
  if (!core.position.ok)
    return { ok: false, why: `Position precompile: ${core.position.error}` };
  if (!core.oraclePx.ok)
    return { ok: false, why: `Oracle precompile: ${core.oraclePx.error}` };
  if (!core.reserveUsdc.ok || !core.reserveHype.ok)
    return { ok: false, why: "Reserve-rate precompile could not be read." };
  const fundingHourly = activity?.rates.hypeFundingHourly ?? NaN;
  if (!Number.isFinite(fundingHourly))
    return { ok: false, why: "Current funding rate not read from the API." };
  const rU = core.reserveUsdc.value,
    rH = core.reserveHype.value;
  const hypePx = spotPx(rH.oraclePx, CORE.hypeSzDecimals);
  const rates = {
    usdcSupply: Number(rU.supplyBps) / 10_000,
    usdcBorrow: Number(rU.borrowBps) / 10_000,
    hypeSupply: Number(rH.supplyBps) / 10_000,
    hypeBorrow: Number(rH.borrowBps) / 10_000,
  };
  let lending: LendingLeg[];
  let lendingSource: "precompile" | "api";
  const tok = (index: number) => tokens?.find((x) => x.index === index);
  const tU = tok(CORE.usdcToken),
    tH = tok(CORE.hypeToken);
  if (
    tU &&
    tH &&
    tU.supply !== null &&
    tU.borrow !== null &&
    tH.supply !== null &&
    tH.borrow !== null
  ) {
    lendingSource = "precompile";
    lending = [
      {
        supplied: units(tU.supply, tU.weiDecimals),
        borrowed: units(tU.borrow, tU.weiDecimals),
        px: 1,
        supplyRate: rates.usdcSupply,
        borrowRate: rates.usdcBorrow,
      },
      {
        supplied: units(tH.supply, tH.weiDecimals),
        borrowed: units(tH.borrow, tH.weiDecimals),
        px: hypePx,
        supplyRate: rates.hypeSupply,
        borrowRate: rates.hypeBorrow,
      },
    ];
  } else if (activity) {
    // The vault's scope does not ask the lending ledger (no lending in use): the API's user
    // state, read on the same page, answers it instead, and the page says so.
    lendingSource = "api";
    const row = (name: string) =>
      activity.lending.find((l) => l.token === name);
    const u = row("USDC"),
      h = row("HYPE");
    lending = [
      {
        supplied: Number(u?.supplied ?? 0),
        borrowed: Number(u?.borrowed ?? 0),
        px: 1,
        supplyRate: rates.usdcSupply,
        borrowRate: rates.usdcBorrow,
      },
      {
        supplied: Number(h?.supplied ?? 0),
        borrowed: Number(h?.borrowed ?? 0),
        px: hypePx,
        supplyRate: rates.hypeSupply,
        borrowRate: rates.hypeBorrow,
      },
    ];
  } else {
    return { ok: false, why: "Lending state not readable yet." };
  }
  const oraclePx = perpPx(core.oraclePx.value, CORE.hypeSzDecimals);
  const value = currentYield({
    perpSize: units(core.position.value.szi, CORE.hypeSzDecimals),
    oraclePx,
    fundingHourly,
    lending,
    navUsd,
    performanceFee: 0.1,
  });
  if (!value) return { ok: false, why: "NAV not read." };
  return {
    ok: true,
    value: { value, fundingHourly, oraclePx, lendingSource, rates },
  };
}

/** The legs behind "Current net yield (annualized)", each annualized, with the rates used. */
export function CurrentYieldBreakdown({
  y,
}: {
  y: ReturnType<typeof currentYieldOf>;
}) {
  if (!y.ok) return <p className="empty-line">{y.why}</p>;
  const { value: v, fundingHourly, oraclePx, lendingSource, rates } = y.value;
  const rows: [string, string, string, string][] = [
    [
      "Funding (HYPE short)",
      `${v.shortNotionalUsd.toFixed(2)} USD short × ${pct(fundingHourly * 8760)} (hourly ${(fundingHourly * 100).toFixed(5)}% × 8,760) at oracle ${oraclePx.toFixed(2)}`,
      usd(v.fundingUsd),
      pct(v.fundingApr),
    ],
    [
      "Lending supply",
      `USDC ${pct(rates.usdcSupply)}, HYPE ${pct(rates.hypeSupply)} on supplied value`,
      usd(v.supplyUsd),
      pct(v.supplyApr),
    ],
    [
      "Borrow cost",
      `USDC ${pct(rates.usdcBorrow)}, HYPE ${pct(rates.hypeBorrow)} on borrowed value`,
      usd(-v.borrowUsd),
      pct(-v.borrowApr),
    ],
  ];
  return (
    <>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Leg</th>
              <th scope="col">Rate used</th>
              <th scope="col" className="r">
                Per year
              </th>
              <th scope="col" className="r">
                Of NAV
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, rate, usdv, p]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{rate}</td>
                <td className="r num">{usdv}</td>
                <td className="r num">{p}</td>
              </tr>
            ))}
            <tr>
              <td>Performance fee</td>
              <td>10% of a positive total</td>
              <td className="r num">{usd(-v.feeUsd)}</td>
              <td className="r num">—</td>
            </tr>
            <tr>
              <th scope="row">Current net yield</th>
              <td>after the fee</td>
              <td className="r num">{usd(v.netUsd)}</td>
              <td className="r num">{pct(v.apr)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="fine-line">
        Sources: position, oracle price, balances and reserve rates from
        HyperCore read precompiles; lending balances from{" "}
        {lendingSource === "precompile"
          ? "the NAV source's precompile reads"
          : "the Hyperliquid API (the vault's valuation scope does not query lending)"}
        ; the funding rate from the Hyperliquid API (no precompile exposes it).
        This hour's rates annualized: not a forecast.
      </p>
    </>
  );
}
