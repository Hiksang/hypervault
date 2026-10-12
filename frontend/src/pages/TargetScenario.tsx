import { SNAPSHOT } from "../marketSnapshot";
import { PM_SOURCE, type Product, scenario } from "../products";
import { breakevenFunding, TARGET } from "../yieldModel";

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

/**
 * The assumptions and LTV table behind a product's "Up to" figure. A calculation scenario at
 * fixed initial prices: never the live vault's return, never an approved operating LTV.
 */
export function TargetScenario({ product }: { product: Product }) {
  const base = product.id === "BTC" ? "BTC" : "HYPE";
  const plus = product.id !== "USDC";
  const top = product.table[product.table.length - 1]!;
  const be = breakevenFunding({
    kind: plus ? "plus" : "usdc",
    ltv: top.ltv,
    shortLeverage: product.shortLeverage,
    fundingApr: 0,
    borrowApr: TARGET.borrowApr,
    roundTripCost: TARGET.roundTripCost,
    roundTripsPerYear: TARGET.roundTripsPerYear,
    performanceFee: TARGET.performanceFee,
    buffer: plus ? 0 : TARGET.buffer,
  });
  const zero = scenario(product.id, 0).netApr;
  const borrow8 = scenario(product.id, undefined, top.ltv, 0.08).netApr;
  return (
    <div className="target-scenario">
      {/* Above the table, not a <caption>: a caption wraps to the table's width. */}
      <p className="table-title">
        {product.name}: target scenarios by actual LTV (USDC debt ÷ spot
        collateral value), per 100% of the initial deposit
      </p>
      <div className="table-scroll">
        <table
          className="data"
          aria-label={`${product.name} target scenarios by actual LTV`}
        >
          <thead>
            <tr>
              <th scope="col">Actual LTV</th>
              <th scope="col">{plus ? "All spot" : "Spot = short"}</th>
              {plus && <th scope="col">Extra spot = short</th>}
              <th scope="col">USDC debt</th>
              <th scope="col">Est. net APR</th>
            </tr>
          </thead>
          <tbody>
            {product.table.map((r) => (
              <tr key={r.ltv}>
                <td className="num">{pct(r.ltv)}</td>
                <td className="num">{pct(r.spot, 2)}</td>
                {plus && <td className="num">{pct(r.hedged, 2)}</td>}
                <td className="num">{pct(r.debt, 2)}</td>
                <td className="num">{pct(r.netApr, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv-list">
        <div>
          <dt>Inputs</dt>
          <dd>
            {base} funding {pct(product.fundingApr, 1)} (90-day average as of{" "}
            {SNAPSHOT.date}, not a live rate) · USDC borrow 5% flat
            (approximation: the official rate moves with utilization and
            compounds) · short {product.shortLeverage}x margin (not the vault's
            leverage) · {pct(TARGET.roundTripCost, 2)} round trip once a year ·
            10% fee on a positive result
            {plus ? "" : " · 10% kept as EVM USDC buffer"}.
          </dd>
        </div>
        <div>
          <dt>Fixed scenario</dt>
          <dd>
            Initial prices, positions and debt held for a year. No basis, hourly
            borrow, rebalancing, slippage, gas or compounding. The short's
            initial margin is assumed borrowed.
          </dd>
        </div>
        <div>
          <dt>Sensitivity at {pct(top.ltv)}</dt>
          <dd>
            Breakeven funding about {pct(be, 2)}. At 0% funding: {pct(zero, 2)}{" "}
            (a loss, no fee). At 8% borrow: {pct(borrow8, 2)}.
          </dd>
        </div>
        <div>
          <dt>LTV limits</dt>
          <dd>
            Official new-borrow LTV factor: HYPE {pct(TARGET.officialLtv.HYPE)},
            BTC {pct(TARGET.officialLtv.BTC)}. {pct(top.ltv)} is a calculation
            scenario, not an approved default. The gap to the factor is not the
            distance to liquidation: that depends on the PM ratio, the oracle,
            maintenance margin, the 20 USDC offset and borrow caps.
          </dd>
        </div>
        <div>
          <dt>Live vault</dt>
          <dd>
            Portfolio Margin needs a Core account above $10k. The live vault is
            below that and is not on PM, so this is not its return.
          </dd>
        </div>
        {plus && (
          <div>
            <dt>Measured against</dt>
            <dd>
              The deposit's initial dollar value. {base} quantity accumulated by
              the strategy is separate from the USD gain or loss of the {base}{" "}
              price, which you keep in full.
            </dd>
          </div>
        )}
        <div>
          <dt>Source</dt>
          <dd>
            <a href={PM_SOURCE} target="_blank" rel="noreferrer">
              Hyperliquid docs: Portfolio Margin
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}
