import type { ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { StrategyFlow } from "./StrategyFlow";
import { TAKER, TARGET } from "../yieldModel";
import { planAt, pmEst, PRODUCTS } from "../products";
import { TargetScenario } from "./TargetScenario";
import { SNAPSHOT as MARKET } from "../marketSnapshot";
import { EXIT_FEE_BPS } from "../instant";

/**
 * User guide. The default view answers what a depositor needs: how to use the vault, how it
 * earns, what it costs, how to withdraw and what can go wrong. Every number about the strategy
 * (LTV, hedge size, borrow, market snapshot) lives once, in Advanced details, computed from
 * products/yieldModel; nothing here is a promise of return.
 */

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const usd = (x: number) =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const EXIT_FEE = `${Number(EXIT_FEE_BPS) / 100}%`;
const PERF_FEE = pct(TARGET.performanceFee, 0);

const TOC = [
  ["use", "How to use"],
  ["earn", "How it earns"],
  ["fees", "Fees"],
  ["withdraw", "Withdrawals"],
  ["risks", "Main risks"],
  ["faq", "FAQ"],
  ["advanced", "Advanced details"],
] as const;

/** Scroll a section so its heading sits just below the sticky header, whatever its height. */
function jump(id: string) {
  const el = document.getElementById(`docs-${id}`);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  // Align the heading, not the section box: its padding would push the title down.
  const target = el.querySelector("h2, summary") ?? el;
  const header = document.querySelector("header.topbar");
  const offset =
    (header instanceof HTMLElement ? header.offsetHeight : 60) + 16;
  window.scrollTo({
    top: target.getBoundingClientRect().top + window.scrollY - offset,
    behavior: "smooth",
  });
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={`docs-${id}`} className="sec doc-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Table({
  head,
  rows,
  numeric = [],
}: {
  head: string[];
  rows: ReactNode[][];
  numeric?: number[];
}) {
  return (
    <div className="tbl-wrap">
      <table className="tbl doc-tbl">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={numeric.includes(i) ? "r" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className={numeric.includes(j) ? "r num" : undefined}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Folded list: the title and one-line summary stay visible, the detail opens on demand. */
function FoldList({ items }: { items: [string, string, ReactNode][] }) {
  return (
    <ul className="doc-folds">
      {items.map(([title, summary, detail]) => (
        <li key={title}>
          <details className="fold">
            <summary>
              <span>
                <b>{title}</b>
                <span>{summary}</span>
              </span>
            </summary>
            <div className="doc-fold-body">{detail}</div>
          </details>
        </li>
      ))}
    </ul>
  );
}

const NAV = 1000;
/** USDC Carry at the top target-scenario row, with its parts per unit of deposit. */
const carry = (fundingApr: number) => {
  const r = planAt("USDC", fundingApr);
  const funding = r.hedged * fundingApr;
  const costs =
    r.debt * TARGET.borrowApr +
    r.hedged * TARGET.roundTripCost * TARGET.roundTripsPerYear +
    (r.gross > 0 ? r.gross * TARGET.performanceFee : 0);
  return { ...r, funding, costs };
};

export function Docs() {
  const scenarios: [string, number][] = [
    ["90-day average", TARGET.funding.HYPE],
    ["30-day average", MARKET.hype.funding30d],
    ["Worst 7 days (90 days)", MARKET.hype.worst7d],
    ["Zero funding", 0],
    ["Negative funding", -0.1],
  ];
  const plan = carry(TARGET.funding.HYPE);
  return (
    <div className="page doc">
      <header className="page-top">
        <h1>How HyperVault works</h1>
        <p>
          Deposit USDC, receive vault shares, and let a hedged strategy on
          Hyperliquid earn for you. Withdraw by redeeming your shares.
        </p>
      </header>
      <div className="doc-grid">
        <nav className="doc-toc" aria-label="On this page">
          {TOC.map(([id, label]) => (
            <a
              key={id}
              href={`#/docs`}
              onClick={(e) => {
                e.preventDefault();
                jump(id);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="doc-body">
          <Section id="use" title="How to use">
            <ol className="doc-steps">
              {[
                [
                  "Deposit",
                  "Add USDC and receive hvUSDC shares at the current share price.",
                ],
                [
                  "Strategy runs",
                  "The vault earns funding on Hyperliquid with a hedged position.",
                ],
                [
                  "Track",
                  "Your share value updates onchain. Check it on the vault page.",
                ],
                [
                  "Withdraw",
                  "Take USDC from the buffer at once, or request the rest.",
                ],
              ].map(([title, body], i) => (
                <li key={title}>
                  <span className="doc-step-n">{i + 1}</span>
                  <b>{title}</b>
                  <p>{body}</p>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="earn" title="How it earns">
            <div className="doc-flow" aria-label="Money flow">
              <div>
                <b>USDC</b>
                <span>You deposit</span>
              </div>
              <ArrowRight weight="bold" aria-hidden />
              <div>
                <b>Strategy runs</b>
                <span>HYPE spot + equal short, earning funding</span>
              </div>
              <ArrowRight weight="bold" aria-hidden />
              <div>
                <b>Share value</b>
                <span>Gains and losses show in the share price</span>
              </div>
            </div>
            <p>
              Spot and short cancel each other's price moves, so the vault keeps
              the funding that perp longs pay shorts. Funding changes every hour
              and can turn negative. The target structure uses Portfolio Margin
              to hedge more of the deposit; how, and the numbers, are in
              Advanced details.
            </p>
          </Section>

          <Section id="fees" title="Fees">
            <dl className="doc-kv">
              <div>
                <dt>Performance fee</dt>
                <dd>
                  {PERF_FEE} of the gain above the share price's previous high
                  (high-water mark). Nothing while a loss is being recovered.
                </dd>
              </div>
              <div>
                <dt>Instant exit fee</dt>
                <dd>
                  {EXIT_FEE} of a withdrawal paid at once from the buffer. It
                  stays in the vault for the holders who remain.
                </dd>
              </div>
              <div>
                <dt>Minimum deposit</dt>
                <dd>
                  10 USDC. The vault's total size is capped in the contract.
                </dd>
              </div>
              <div>
                <dt>No other fees</dt>
                <dd>
                  No management or deposit fee. Trading fees and interest are
                  paid by the strategy and already in the share price.
                </dd>
              </div>
            </dl>
          </Section>

          <Section id="withdraw" title="Withdrawals">
            <div className="doc-cards">
              <article>
                <h3>Instant from the buffer</h3>
                <p>
                  Paid in the same transaction from the free USDC on HyperEVM,
                  up to what the buffer holds.
                </p>
                <p>
                  Priced conservatively (the lower of the live and recently
                  recorded share price), less the {EXIT_FEE} exit fee.
                </p>
              </article>
              <article>
                <h3>Request</h3>
                <p>
                  For more than the buffer. Paid after the operator closes the
                  positions and settles the round, at one price for everyone in
                  it.
                </p>
                <p>Operator commitment: within 72 hours of the request.</p>
              </article>
            </div>
            <p>
              When no strategy is running, a request is paid in the same
              transaction. Shares are transferable, so you can also sell them to
              another holder.
            </p>
          </Section>

          <Section id="risks" title="Main risks">
            <FoldList
              items={[
                [
                  "Funding turns negative",
                  "Shorts then pay longs and the carry loses money.",
                  <p>
                    The monitor alerts when the 24-hour or 7-day average turns
                    negative, and the operator stops adding or closes the hedge.
                    Losses during negative periods remain, and closing and
                    reopening costs fees.
                  </p>,
                ],
                [
                  "Short liquidation in a sharp rally",
                  "A fast HYPE rally can use up the short's margin.",
                  <p>
                    Margin usage is monitored and the position is sized with
                    room to spare, but a move faster than the operator can react
                    can still liquidate the short.
                  </p>,
                ],
                [
                  "Borrow cost above funding",
                  "When the vault borrows, interest can exceed funding.",
                  <p>
                    Hyperliquid's borrow rate climbs steeply at high
                    utilization. The monitor compares the borrow rate with
                    funding and the borrowed leg is reduced when the spread
                    turns negative.
                  </p>,
                ],
                [
                  "Operator and trading-wallet trust",
                  "The operator runs the strategy and settles larger withdrawals.",
                  <p>
                    The operator chooses what NAV counts and trades through an
                    API wallet. The wallet can place orders and borrow, but
                    cannot send funds to another address; it can still lose
                    value through bad trades. Beyond the buffer, a withdrawal
                    waits for the operator to settle.
                  </p>,
                ],
                [
                  "Smart contracts",
                  "The contracts are not audited.",
                  <p>
                    A bug could lose or lock funds. The code is tested and
                    published, and upgrades wait 48 hours before they can run.
                  </p>,
                ],
                [
                  "Oracle vs sale price",
                  "NAV uses Hyperliquid's oracle; a sale can get a little less.",
                  <p>
                    The hedged spot and the short are valued at the same HYPE
                    perp oracle price, so book spikes do not move NAV. Selling
                    in an exit gets the market price, which can differ slightly;
                    the instant exit fee covers the usual gap. Settlement always
                    pays the cash actually brought home.
                  </p>,
                ],
                [
                  "Hyperliquid platform",
                  "Validator, oracle or bridge incidents are outside the vault.",
                  <p>
                    Only HYPE and USDC markets are used, but platform-level
                    events can still affect the vault.
                  </p>,
                ],
              ]}
            />
          </Section>

          <Section id="faq" title="FAQ">
            <FoldList
              items={[
                [
                  "Is the yield guaranteed?",
                  "No.",
                  <p>
                    It depends on funding, which changes every hour and is
                    sometimes negative.
                  </p>,
                ],
                [
                  "Can I lose money?",
                  "Yes.",
                  <p>
                    Negative funding, liquidations, operator error, contract
                    bugs or platform incidents can all cause losses.
                  </p>,
                ],
                [
                  'Why does realized return say "Not yet"?',
                  "It needs 30 days of share-price history.",
                  <p>
                    Annualizing a few days would mislead. Until then the vault
                    page shows estimates, labeled as estimates.
                  </p>,
                ],
                [
                  "Where can I check the vault?",
                  "On the vault page.",
                  <p>
                    It shows the onchain NAV, live positions, trades, funding
                    and loans, with explorer links.
                  </p>,
                ],
              ]}
            />
          </Section>

          <details className="fold sec doc-sec doc-advanced" id="docs-advanced">
            <summary>Advanced details</summary>

            <h3 className="sub-h">Technical structure</h3>
            <ul className="doc-list">
              <li>
                The vault contract lives on HyperEVM; shares (hvUSDC) are a
                plain ERC-20 token.
              </li>
              <li>
                The vault's address is also its HyperCore account. It moves cash
                there through CoreWriter, and an approved API wallet trades
                spot, perps and lending on that account.
              </li>
              <li>
                NAV is read onchain from HyperCore read precompiles. Hedged spot
                and the short are valued at one HYPE perp oracle price, so the
                pair nets to zero. A read that fails stops deposits instead of
                using a guess.
              </li>
              <li>
                Modules: share token, fee accountant (high-water mark), NAV
                source and verifier, a Core-management library and a read-only
                lens. Upgrades wait 48 hours.
              </li>
            </ul>

            <StrategyFlow
              live={null}
              navUsd={null}
              rates={null}
              failed={false}
              initial="target"
              targetOnly
              title="Target structure (Portfolio Margin)"
            />
            <p>
              Worked example: {usd(NAV)} at {pct(plan.ltv, 0)} actual LTV. Spot
              HYPE = short {usd(plan.hedged * NAV)}, USDC debt{" "}
              {usd(plan.debt * NAV)}, cash buffer {usd(TARGET.buffer * NAV)}.
              Not the live vault: Portfolio Margin needs a HyperCore account
              above $10k.
            </p>
            <Table
              head={["Funding scenario", "Funding", "Costs and fee", "Net APR"]}
              numeric={[1, 2, 3]}
              rows={scenarios.map(([label, f]) => {
                const r = carry(f);
                return [
                  `${label} (${pct(f)})`,
                  usd(r.funding * NAV),
                  usd(-r.costs * NAV),
                  <b className={r.netApr < 0 ? "neg" : undefined}>
                    {pct(r.netApr, 2)}
                  </b>,
                ];
              })}
            />
            <p className="hv-small">
              Costs are borrow interest at a flat {pct(TARGET.borrowApr, 0)}{" "}
              (the real rate moves with utilization), one open and close a year
              at base taker fees (spot {pct(TAKER.spot, 3)}, perps{" "}
              {pct(TAKER.perp, 3)}) and the {PERF_FEE} fee on gains. Prices,
              positions and debt are held for a year; a HYPE rally adds short
              losses to the debt.
            </p>

            <h3 className="sub-h">Scenarios by LTV</h3>
            {PRODUCTS.map((p) => (
              <details className="fold" key={p.id}>
                <summary>
                  {p.name}: Est. APR {pmEst(p.maxApr)} at{" "}
                  {Math.round(p.maxLtv * 100)}% LTV
                </summary>
                <TargetScenario product={p} />
              </details>
            ))}

            <h3 className="sub-h">Market snapshot ({MARKET.date})</h3>
            <dl className="doc-kv">
              <div>
                <dt>HYPE funding</dt>
                <dd>
                  {pct(MARKET.hype.funding90d)} APR (90 days),{" "}
                  {pct(MARKET.hype.funding30d)} (30 days);{" "}
                  {pct(MARKET.hype.negativeHours, 0)} of hours negative
                </dd>
              </div>
              <div>
                <dt>USDC lending</dt>
                <dd>
                  Supply {pct(MARKET.usdc.supplyApr)} APR, borrow{" "}
                  {pct(MARKET.usdc.borrowApr)}, utilization{" "}
                  {pct(MARKET.usdc.utilization, 0)}
                </dd>
              </div>
            </dl>

            <h3 className="sub-h">Who controls what</h3>
            <Table
              head={["Role", "Can", "Cannot"]}
              rows={[
                [
                  "You (shareholder)",
                  "Deposit, transfer shares, withdraw from the buffer, request and claim redemptions",
                  "Force a settlement beyond the buffer while the strategy runs",
                ],
                [
                  "Operator (vault owner)",
                  "Move cash to and from HyperCore, choose the valued scope, approve the trading wallet, settle rounds, propose upgrades (48 h delay)",
                  "Take shares or claims, change the fee for existing holders, upgrade without the delay",
                ],
                [
                  "Trading wallet (API wallet)",
                  "Place orders and borrow or lend on the vault's HyperCore account",
                  "Send funds to another address",
                ],
              ]}
            />

            <h3 className="sub-h">Glossary</h3>
            <dl className="doc-kv">
              {[
                [
                  "NAV",
                  "Cash on HyperEVM plus what the HyperCore account is worth, minus what it owes.",
                ],
                ["Share price", "NAV ÷ shares, in USDC per share."],
                [
                  "High-water mark",
                  "The highest share price a fee was charged at; fees apply only above it.",
                ],
                [
                  "Funding",
                  "Hourly payment between perp longs and shorts that keeps perps near spot.",
                ],
                [
                  "Delta-neutral",
                  "Spot long and perp short of the same size, so price moves cancel.",
                ],
                [
                  "LTV",
                  "Debt as a share of collateral value; Hyperliquid caps new borrowing per asset.",
                ],
                [
                  "Round (epoch)",
                  "Redemption requests settled together at one price.",
                ],
              ].map(([term, def]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{def}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </div>
    </div>
  );
}
