import { useState } from "react";
import { ArrowRight, ArrowsLeftRight } from "@phosphor-icons/react";
import { estAprNow, PERFORMANCE_FEE, ROUND_TRIP_COST } from "../aprNow";
import { SNAPSHOT } from "../marketSnapshot";
import { approx, pmEst, PRODUCTS } from "../products";
import { TARGET } from "../yieldModel";
import type { Allocation } from "../vaultActivity";
import type { Rates } from "../vaultActivity";
import { Skel, TokenIcon } from "./kit";
import { TargetScenario } from "./TargetScenario";
import { CurrentYieldBreakdown, type currentYieldOf } from "./CurrentYield";
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

type Shape = {
  spot: number;
  short: number;
  /** Of the spot exposure, the part bought with the vault's own money (share of NAV). */
  own: number;
  borrowed: number;
  buffer: number;
  apr: number | null;
};

/**
 * USDC → HYPE spot ⇄ HYPE short → estimated net APR, drawn either for the position as it
 * stands now (live API read) or for the Portfolio Margin target. The two are never mixed.
 */
export function StrategyFlow({
  live,
  navUsd,
  rates,
  failed,
  initial = "now",
  title = "How it works",
  targetOnly = false,
  current,
}: {
  /** Current net yield from the Core precompiles, shown apart from the 90-day estimate. */
  current?: ReturnType<typeof currentYieldOf>;
  live: Allocation | null;
  navUsd: number | null;
  rates: Rates | null;
  failed: boolean;
  /** Learn opens on the target structure (it reads no live data). */
  initial?: "now" | "target";
  title?: string;
  /** No live data on this page: show only the target structure. */
  targetOnly?: boolean;
}) {
  const [view, setView] = useState<"now" | "target">(initial);
  const product = PRODUCTS[0]!;
  const top = product.table[product.table.length - 1]!;
  const target: Shape = {
    spot: top.spot,
    short: top.spot,
    own: 1 - TARGET.buffer,
    borrowed: top.spot - (1 - TARGET.buffer),
    buffer: TARGET.buffer,
    apr: product.maxApr,
  };
  const now: Shape | null =
    live && navUsd && navUsd > 0
      ? {
          spot: live.spotHypeUsd / navUsd,
          short: live.shortHypeUsd / navUsd,
          own: Math.max(live.spotHypeUsd - live.borrowedUsd, 0) / navUsd,
          borrowed: Math.min(live.borrowedUsd, live.spotHypeUsd) / navUsd,
          buffer: live.evmCash / navUsd,
          apr:
            estAprNow(
              live.shortHypeUsd,
              navUsd,
              undefined,
              live.borrowedUsd,
              rates?.usdcBorrowApr ?? 0,
            )?.apr ?? null,
        }
      : null;
  const shape = view === "now" ? now : target;
  return (
    <section className="sec" aria-labelledby="sec-how">
      <header className="sec-head">
        <h2 id="sec-how">{title}</h2>
        {targetOnly ? (
          <span className="tag">Target scenario</span>
        ) : (
          <div className="seg-tabs" role="tablist" aria-label="Structure shown">
            <button
              role="tab"
              aria-selected={view === "now"}
              className={view === "now" ? "on" : undefined}
              onClick={() => setView("now")}
            >
              Current position
            </button>
            <button
              role="tab"
              aria-selected={view === "target"}
              className={view === "target" ? "on" : undefined}
              onClick={() => setView("target")}
            >
              Target scenario
            </button>
          </div>
        )}
      </header>
      <p className="sec-lead">
        {view === "now"
          ? "The position as it stands, read from Hyperliquid. Without Portfolio Margin the spot HYPE backs USDC borrowing, and the short is margined by USDC alone."
          : `The highest row of the target-scenario table (${Math.round(top.ltv * 100)}% actual LTV, Portfolio Margin, a Core account above $10k). Not the live position: the vault is below that size today.`}
      </p>
      {!shape ? (
        failed ? (
          <p className="empty-line">
            The live position could not be read. Switch to Target scenario to
            see the structure.
          </p>
        ) : (
          <Skel h={132} />
        )
      ) : (
        <>
          <ol className={`flow ${view === "target" ? "is-target" : ""}`}>
            <li className="node">
              <small>Deposit</small>
              <b>
                <TokenIcon symbol="USDC" size={22} /> USDC
              </b>
              <span
                className="chip-sm"
                title="Free USDC on HyperEVM for withdrawals"
              >
                {pct(shape.buffer)} buffer
              </span>
            </li>
            <li className="edge" aria-hidden>
              <ArrowRight weight="bold" />
            </li>
            <li className="pair">
              <div className="node spot">
                <small>Long</small>
                <b>
                  <TokenIcon symbol="HYPE" size={22} /> HYPE Spot
                </b>
                <span className="num">{pct(shape.spot)} of NAV</span>
              </div>
              <span className="pair-eq" aria-label="hedged by">
                <ArrowsLeftRight weight="bold" />
              </span>
              <div className="node short">
                <small>Hedge</small>
                <b>
                  <TokenIcon symbol="HYPE" size={22} /> HYPE Short
                </b>
                <span className="num">{pct(shape.short)} of NAV</span>
              </div>
            </li>
            <li className="edge" aria-hidden>
              <ArrowRight weight="bold" />
            </li>
            <li className="node result">
              <small>
                {view === "now" ? "Est. APR (90d funding)" : "PM est. APR"}
              </small>
              <b className="num">
                {shape.apr === null
                  ? "—"
                  : view === "now"
                    ? approx(shape.apr)
                    : pmEst(shape.apr)}
              </b>
              <span>after costs and the 10% fee</span>
              {view === "now" && current?.ok && (
                <span>
                  Current net yield (annualized){" "}
                  <b className="num">
                    {(current.value.value.apr * 100).toFixed(2)}%
                  </b>
                </span>
              )}
            </li>
          </ol>
          <Exposure shape={shape} />
        </>
      )}
      <details className="fold">
        <summary>Strategy details</summary>
        <Details rates={rates} current={current} />
      </details>
    </section>
  );
}

/** Spot exposure split into own equity and borrowed, against a 100%-of-NAV line. */
function Exposure({ shape }: { shape: Shape }) {
  const scale = Math.max(1.5, shape.spot + 0.05);
  const w = (x: number) => `${(Math.max(x, 0) / scale) * 100}%`;
  return (
    <div className="expo">
      <div className="expo-head">
        <small>Spot exposure as share of NAV</small>
        <span className="num">{pct(shape.spot)}</span>
      </div>
      <div
        className="expo-bar"
        role="img"
        aria-label={`Own equity ${pct(shape.own)} of NAV, borrowed ${pct(shape.borrowed)} of NAV`}
      >
        <span className="own" style={{ width: w(shape.own) }} />
        <span className="borrowed" style={{ width: w(shape.borrowed) }} />
        <span className="nav-line" style={{ left: w(1) }}>
          <em>NAV</em>
        </span>
      </div>
      <ul className="legend">
        <li>
          <i className="own" /> Own equity {pct(shape.own)}
        </li>
        <li>
          <i className="borrowed" /> Borrowed USDC {pct(shape.borrowed)}
        </li>
        <li className="muted">
          {shape.borrowed > 0.005
            ? "Exposure above 100% is bought with borrowed USDC; the short hedges all of it."
            : "Nothing borrowed: exposure stays below NAV."}
        </li>
      </ul>
    </div>
  );
}

function Details({
  rates,
  current,
}: {
  rates: Rates | null;
  current?: ReturnType<typeof currentYieldOf>;
}) {
  const rows: [string, string][] = [
    [
      "Estimated net APR (90d funding)",
      `Short notional ÷ NAV × HYPE funding ${pct(SNAPSHOT.hype.funding90d, 2)} (90-day average as of ${SNAPSHOT.date}), less ${pct(ROUND_TRIP_COST, 2)} round-trip trading, after the ${pct(PERFORMANCE_FEE)} fee. A 90-day average, not today's rate; it changes as the position changes.`,
    ],
    [
      "Current funding (annualized)",
      "The hourly rate now × 24 × 365, shown under Market now. A market rate, not a vault return.",
    ],
    [
      "Realized return",
      "From the published share-price history only. Annualized after 30 days.",
    ],
  ];
  return (
    <>
      <dl className="kv-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {current && (
        <>
          <h3 className="sub-h">Current net yield (annualized)</h3>
          <CurrentYieldBreakdown y={current} />
        </>
      )}
      <h3 className="sub-h">
        PM scenario: Est. APR {pmEst(PRODUCTS[0]!.maxApr)} at{" "}
        {Math.round(PRODUCTS[0]!.maxLtv * 100)}% LTV (not live)
      </h3>
      <TargetScenario product={PRODUCTS[0]!} />
      <h3 className="sub-h">Market now (not vault returns)</h3>
      {rates ? (
        <dl className="kv-row">
          <div>
            <dt>Current funding (annualized)</dt>
            <dd className="num">{pct(rates.hypeFundingApr, 2)}</dd>
          </div>
          <div>
            <dt>USDC borrow</dt>
            <dd className="num">{pct(rates.usdcBorrowApr, 2)}</dd>
          </div>
          <div>
            <dt>USDC supply</dt>
            <dd className="num">{pct(rates.usdcSupplyApr, 2)}</dd>
          </div>
          <div>
            <dt>HYPE LTV</dt>
            <dd className="num">{pct(rates.hypeLtv)}</dd>
          </div>
        </dl>
      ) : (
        <p className="empty-line">Market rates not read yet.</p>
      )}
    </>
  );
}
