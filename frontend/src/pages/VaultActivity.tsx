import { CurrentYieldBreakdown, type currentYieldOf } from "./CurrentYield";
import { useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { chain } from "../chain";
import { apiBase } from "../hyperliquid/info";
import { poll, failureText } from "../ui";
import {
  allocation,
  fetchActivity,
  type Activity,
  type Allocation,
} from "../vaultActivity";
import { usePublished, when } from "./hyper";
import {
  currentSegment,
  MIN_ANNUALIZE_DAYS,
  parseNavHistory,
  realizedReturn,
  type NavPoint,
} from "../navHistory";
import { Fig, Freshness, SectionError, Skel, TokenIcon } from "./kit";

const EVERY = 60_000;
/** One 0.01 HYPE order step: below half of it the legs cannot be matched any closer. */
const STEP = 0.01;
const pct = (x: number, digits = 2) =>
  Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—";
const at = (ms: number) => when(new Date(ms).toISOString());

const coreTx = (hash: string) =>
  /^0x0+$/.test(hash) ? (
    "—"
  ) : (
    <a
      className="txlink"
      href={`https://app.hyperliquid.xyz/explorer/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      {hash.slice(0, 8)}…{hash.slice(-4)}
    </a>
  );

export type ActivityState = {
  data: Activity | null;
  failure: string;
  readAt: number | null;
  retry: () => void;
  /** Where the money sits now (display only), with the EVM cash folded in. */
  alloc: Allocation | null;
  available: boolean;
};

/** The vault's HyperCore account from the public Hyperliquid API, polled each minute. */
export function useActivity(
  vault: Address | null,
  evmCash: number | null,
): ActivityState {
  const base = vault ? apiBase(chain.id) : null;
  const [data, setData] = useState<Activity | null>(null),
    [failure, setFailure] = useState(""),
    [readAt, setReadAt] = useState<number | null>(null),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!base) return;
    let alive = true;
    const stop = poll(async () => {
      try {
        const value = await fetchActivity(base, vault!);
        if (alive) {
          setData(value);
          setReadAt(Date.now());
          setFailure("");
        }
      } catch (e) {
        if (alive) setFailure(failureText(e));
      }
    }, EVERY);
    return () => {
      alive = false;
      stop();
    };
  }, [base, vault, tick]);
  return {
    data,
    failure,
    readAt,
    retry: () => setTick((n) => n + 1),
    alloc: data ? allocation(data, evmCash ?? 0) : null,
    available: !!base,
  };
}

/** Right-aligned numeric table with a header; on phones it scrolls sideways inside its frame. */
function Table({
  head,
  rows,
  empty,
  numeric,
}: {
  head: string[];
  rows: ReactNode[][];
  empty: string;
  /** Column indexes holding numbers (right-aligned). */
  numeric: number[];
}) {
  if (rows.length === 0) return <p className="empty-line">{empty}</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
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
                <td key={j} className={numeric.includes(j) ? "r" : undefined}>
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

/** Spot and short first, then the residual delta; full balances behind a disclosure. */
export function PositionsSection({
  a,
  current,
}: {
  a: ActivityState;
  /** Current net yield from the Core precompiles (HyperVault USDC only). */
  current?: ReturnType<typeof currentYieldOf>;
}) {
  const { data, alloc, failure } = a;
  const short = data?.positions.find(
    (p) => p.coin === "HYPE" && Number(p.size) < 0,
  );
  return (
    <section className="sec" aria-labelledby="sec-pos">
      <header className="sec-head">
        <h2 id="sec-pos">Positions</h2>
        <Freshness
          at={a.readAt}
          staleAfter={3 * EVERY}
          source="Hyperliquid"
          failed={!!a.failure}
        />
      </header>
      {!a.available ? (
        <p className="empty-line">
          This network has no HyperCore API to read from.
        </p>
      ) : failure && !data ? (
        <SectionError
          what="Positions could not be read from Hyperliquid."
          detail={failure}
          onRetry={a.retry}
        />
      ) : !alloc || !data ? (
        <div className="legs3">
          {[0, 1, 2].map((i) => (
            <div className="leg-fig" key={i}>
              <Skel w={80} h={12} />
              <Skel w={110} h={26} />
              <Skel w={70} h={12} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {failure && (
            <SectionError
              what="Last refresh failed; showing the previous read."
              detail={failure}
              onRetry={a.retry}
            />
          )}
          <Legs alloc={alloc} />
          {short && (
            <dl className="kv-row">
              <div>
                <dt>Short entry</dt>
                <dd>
                  <Fig v={short.entryPrice} digits={2} unit="USDC" />
                </dd>
              </div>
              <div>
                <dt>Liquidation price</dt>
                <dd>
                  <Fig v={short.liquidationPrice} digits={2} unit="USDC" />
                </dd>
              </div>
              <div>
                <dt>Leverage</dt>
                <dd className="num">{short.leverage}x</dd>
              </div>
              <div>
                <dt>Unrealized PnL</dt>
                <dd>
                  <Fig v={short.pnl} digits={2} unit="USDC" signed />
                </dd>
              </div>
            </dl>
          )}
          {current && (
            <details className="fold">
              <summary>
                Current net yield (annualized):{" "}
                <b className="num">
                  {current.ok
                    ? `${(current.value.value.apr * 100).toFixed(2)}%`
                    : "not available"}
                </b>
              </summary>
              <CurrentYieldBreakdown y={current} />
            </details>
          )}
          <details className="fold">
            <summary>All Core balances</summary>
            <Table
              head={["Spot token", "Total", "On hold"]}
              numeric={[1, 2]}
              rows={data.balances.map((b) => [
                b.coin,
                <Fig v={b.total} digits={4} />,
                <Fig v={b.hold} digits={4} />,
              ])}
              empty="No spot balance."
            />
            <Table
              head={[
                "Perp",
                "Size",
                "Entry",
                "Value (USDC)",
                "PnL (USDC)",
                "Liq. price",
                "Leverage",
              ]}
              numeric={[1, 2, 3, 4, 5, 6]}
              rows={data.positions.map((p) => [
                p.coin,
                <Fig v={p.size} digits={4} />,
                <Fig v={p.entryPrice} digits={2} />,
                <Fig v={p.positionValue} digits={2} />,
                <Fig v={p.pnl} digits={2} signed />,
                <Fig v={p.liquidationPrice} digits={2} />,
                `${p.leverage}x`,
              ])}
              empty="No open perp position."
            />
            <Table
              head={["Lending", "Supplied", "Borrowed", "Oracle (USDC)", "LTV"]}
              numeric={[1, 2, 3, 4]}
              rows={data.lending.map((l) => [
                l.token,
                <Fig v={l.supplied} digits={4} />,
                <Fig v={l.borrowed} digits={4} />,
                <Fig v={l.oraclePrice} digits={2} />,
                l.ltv,
              ])}
              empty="Nothing supplied or borrowed."
            />
            {data.health.borrowedUsd > 0 && (
              <dl className="kv-row">
                <div>
                  <dt>Borrowed</dt>
                  <dd>
                    <Fig v={data.health.borrowedUsd} digits={2} unit="USD" />
                  </dd>
                </div>
                <div>
                  <dt>Health factor</dt>
                  <dd className="num">
                    {pct(data.health.healthFactor ?? NaN, 1)}
                  </dd>
                </div>
                <div>
                  <dt>Liquidation usage</dt>
                  <dd className="num">
                    {pct(data.health.liquidationUsage, 1)}
                  </dd>
                </div>
              </dl>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function Legs({ alloc }: { alloc: Allocation }) {
  if (!alloc.running)
    return (
      <p className="empty-line">
        No position open. The vault holds{" "}
        <Fig v={alloc.evmCash + alloc.coreUsdc} digits={2} unit="USDC" /> in
        cash.
      </p>
    );
  const diff = alloc.spotHype - alloc.shortHype;
  const matched = Math.abs(diff) < STEP / 2;
  return (
    <div className="legs3">
      <div className="leg-fig spot">
        <small>
          <TokenIcon symbol="HYPE" size={16} /> Spot HYPE
        </small>
        <b>
          <Fig v={alloc.spotHype} digits={4} />
        </b>
        <span>
          <Fig v={alloc.spotHypeUsd} digits={2} unit="USD" />
        </span>
      </div>
      <div className="leg-fig short">
        <small>
          <TokenIcon symbol="HYPE" size={16} /> Short HYPE
        </small>
        <b>
          <Fig v={-alloc.shortHype} digits={4} />
        </b>
        <span>
          <Fig v={alloc.shortHypeUsd} digits={2} unit="USD" />
        </span>
      </div>
      <div className="leg-fig">
        <small>Residual delta</small>
        <b>
          <Fig v={diff} digits={4} signed />
        </b>
        <span>
          <span className={`tag ${matched ? "ok" : "warn"}`}>
            {matched ? "Matched" : "Rebalance"}
          </span>{" "}
          <Fig v={Math.abs(alloc.deltaUsd)} digits={2} unit="USD" />
        </span>
      </div>
    </div>
  );
}

/** Return since start from the share price, realized APR only once the history is long enough. */
export function ReturnSection({
  vault,
  sharePrice,
}: {
  vault: Address;
  sharePrice: number | null;
}) {
  const history = usePublished("nav-history", parseNavHistory);
  const sameVault =
    history.kind === "ok" &&
    history.value.vault.toLowerCase() === vault.toLowerCase();
  const seg =
    history.kind === "ok" && sameVault
      ? currentSegment(history.value.points)
      : [];
  const realized = sameVault ? realizedReturn(seg) : null;
  const spanDays =
    seg.length > 1 ? (seg[seg.length - 1]!.t - seg[0]!.t) / 86_400 : 0;
  const chartable = seg.length >= 6 && spanDays >= 2;
  return (
    <section className="sec" aria-labelledby="sec-ret">
      <header className="sec-head">
        <h2 id="sec-ret">Return</h2>
        <span className="fresh">From the share price (after fees)</span>
      </header>
      <dl className="kv-row">
        <div>
          <dt>Since start</dt>
          <dd className="num big">
            {sharePrice === null ? "—" : pct(sharePrice - 1, 2)}
          </dd>
        </div>
        <div>
          <dt>Realized APR</dt>
          <dd className="num big">
            {realized?.annualized != null
              ? pct(realized.annualized)
              : "Not yet"}
          </dd>
          <span className="sub">
            {realized?.annualized != null
              ? `over ${realized.days.toFixed(0)} days`
              : `Shown after ${MIN_ANNUALIZE_DAYS} days of history${realized ? ` (${realized.days.toFixed(1)} so far)` : ""}`}
          </span>
        </div>
      </dl>
      {history.kind === "loading" ? (
        <Skel h={120} />
      ) : chartable ? (
        <PriceChart points={seg} />
      ) : (
        <p className="empty-line">
          {seg.length > 0
            ? `Share-price history starts ${when(new Date(seg[0]!.t * 1000).toISOString())} (${seg.length} snapshot${seg.length === 1 ? "" : "s"}). The chart appears after two days of snapshots.`
            : "No share-price history for this vault yet. The chart appears after two days of snapshots."}
        </p>
      )}
    </section>
  );
}

export function ActivitySection({ a }: { a: ActivityState }) {
  const [tab, setTab] = useState<"trades" | "funding" | "ledger">("trades");
  const { data, failure } = a;
  return (
    <section className="sec" aria-labelledby="sec-act">
      <header className="sec-head">
        <h2 id="sec-act">Activity</h2>
        <div className="seg-tabs" role="tablist" aria-label="Activity">
          {(
            [
              ["trades", "Trades"],
              ["funding", "Funding"],
              ["ledger", "Transfers"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "on" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {!data ? (
        failure ? (
          <SectionError
            what="Activity could not be read from Hyperliquid."
            detail={failure}
            onRetry={a.retry}
          />
        ) : (
          <Skel h={96} />
        )
      ) : tab === "trades" ? (
        <Table
          head={[
            "Time (UTC)",
            "Market",
            "Direction",
            "Price",
            "Size",
            "Fee",
            "Tx",
          ]}
          numeric={[3, 4, 5]}
          rows={data.fills.map((f) => [
            at(f.time).replace(" UTC", ""),
            f.market,
            <span className={`tag ${f.side === "buy" ? "ok" : "bad"}`}>
              {f.dir || f.side}
            </span>,
            <Fig v={f.price} digits={3} />,
            <Fig v={f.size} digits={4} />,
            <>
              <Fig v={f.fee} digits={4} />{" "}
              <span className="unit">{f.feeToken}</span>
            </>,
            coreTx(f.hash),
          ])}
          empty="No trades yet. The latest 50 are shown."
        />
      ) : tab === "funding" ? (
        <Table
          head={["Time (UTC)", "Coin", "Paid to vault (USDC)", "Hourly rate"]}
          numeric={[2, 3]}
          rows={data.funding.map((f) => [
            at(f.time).replace(" UTC", ""),
            f.coin,
            <Fig v={f.usdc} digits={4} signed />,
            <span className="num">{(Number(f.rate) * 100).toFixed(4)}%</span>,
          ])}
          empty="No funding payment in the last 30 days."
        />
      ) : (
        <Table
          head={["Time (UTC)", "Type", "Detail", "Tx"]}
          numeric={[]}
          rows={data.ledger.map((l) => [
            at(l.time).replace(" UTC", ""),
            l.kind,
            l.detail,
            coreTx(l.hash),
          ])}
          empty="No transfer or borrow/lend in the last 30 days."
        />
      )}
    </section>
  );
}

/** Share price over the latest period with shares outstanding (published snapshots). */
function PriceChart({ points }: { points: NavPoint[] }) {
  const W = 640,
    H = 180,
    P = 44;
  const t0 = points[0]!.t,
    t1 = points[points.length - 1]!.t;
  const ys = points.map((p) => p.price!);
  let lo = Math.min(...ys),
    hi = Math.max(...ys);
  if (hi - lo < 1e-6) {
    lo -= 0.001;
    hi += 0.001;
  }
  const x = (t: number) => P + ((t - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P);
  const y = (v: number) => H - P / 2 - ((v - lo) / (hi - lo)) * (H - P);
  const d = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.price!).toFixed(1)}`,
    )
    .join(" ");
  const label = (t: number) =>
    new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ");
  return (
    <figure className="chart">
      <svg
        className="hv-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Share price from ${hi.toFixed(4)} high to ${lo.toFixed(4)} low`}
      >
        <line className="grid" x1={P} x2={W - P} y1={y(hi)} y2={y(hi)} />
        <line className="grid" x1={P} x2={W - P} y1={y(lo)} y2={y(lo)} />
        <text className="axis" x={4} y={y(hi) + 3}>
          {hi.toFixed(4)}
        </text>
        <text className="axis" x={4} y={y(lo) + 3}>
          {lo.toFixed(4)}
        </text>
        <path className="line" d={d} />
        <text className="axis" x={P} y={H - 2}>
          {label(t0)}
        </text>
        <text className="axis" x={W - P} y={H - 2} textAnchor="end">
          {label(t1)} UTC
        </text>
      </svg>
      <figcaption>
        Share price in USDC per hvUSDC, {points.length} snapshots from the
        monitor and operator ledger.
      </figcaption>
    </figure>
  );
}
