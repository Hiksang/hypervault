import { ArrowRight, ArrowUpRight } from "@phosphor-icons/react";
import { estAprNow } from "../aprNow";
import { externalLink, parseMonitor } from "../hypervault";
import { approx, PRODUCTS } from "../products";
import { routeHash } from "../route";
import { usePublished } from "./hyper";
import { ago, Skel, TokenIcon } from "./kit";
import { entryFor, useLive } from "./ProductCard";
import { useActivity } from "./VaultActivity";

const repo = externalLink(import.meta.env.VITE_REPO_URL);

/**
 * Landing, user value first: what you put in and what you can expect. How the strategy is built
 * (LTV, hedge ratio, buffer, CoreWriter) lives on the vault page and in Learn. The only APR here
 * is the live vault's current estimate; the PM scenario never appears on this page.
 */
export function Home() {
  const product = PRODUCTS[0]!;
  const entry = entryFor(product);
  const open = entry
    ? routeHash({ page: "direct", vault: entry.vault, trade: false })
    : "#/vaults";
  const live = useLive(entry);
  const seen = live.seen;
  const decimals = seen?.decimals.ok ? seen.decimals.value : 6;
  const navUsd = seen?.nav.ok ? Number(seen.nav.value) / 10 ** decimals : null;
  const cash = seen?.cash.ok ? Number(seen.cash.value) / 10 ** decimals : null;
  const activity = useActivity(entry?.vault ?? null, cash);
  const now = estAprNow(
    activity.alloc?.shortHypeUsd ?? null,
    navUsd,
    undefined,
    activity.alloc?.borrowedUsd ?? 0,
    activity.data?.rates.usdcBorrowApr ?? 0,
  );
  // Headline: the Portfolio Margin structure the vault is built for (the owner's plan). The live
  // Unified figure sits beside it so the two are never read as one.
  const apr = approx(product.maxApr);
  const nowApr =
    now !== null ? (
      approx(now.apr)
    ) : activity.data || activity.failure || live.failure ? (
      "—"
    ) : (
      <Skel w={48} h={24} />
    );
  const aprTitle = `${product.aprBasis}. An estimate, not a promise.`;
  return (
    <div className="land">
      <section className="land-hero">
        <div className="land-hero-copy">
          <h1>Put your USDC to work.</h1>
          <p className="land-lead">
            Access onchain carry strategies through one simple vault.
          </p>
          <div className="land-cta">
            <a className="btn primary" href={open}>
              Explore USDC Carry <ArrowRight weight="bold" />
            </a>
            <a className="land-link" href="#land-flow">
              How it works
            </a>
          </div>
        </div>
        <aside className="land-preview" aria-label="USDC Carry preview">
          <div className="land-preview-name">
            <TokenIcon symbol="USDC" size={32} />
            <b>{product.name}</b>
          </div>
          <div className="land-preview-apr" title={aprTitle}>
            <span>PM strategy estimate</span>
            <b className="num">{apr}</b>
            {now !== null && <span>Now, live (Unified): {nowApr}</span>}
          </div>
        </aside>
      </section>

      <section className="land-sec" aria-labelledby="land-products">
        <h2 id="land-products">Vaults</h2>
        <a className="land-main-product" href={open}>
          <TokenIcon symbol={product.asset} size={40} />
          <span className="land-product-text">
            <b>{product.name}</b>
            <span>{product.tagline}</span>
          </span>
          <span className="land-product-apr" title={aprTitle}>
            <span>PM strategy estimate</span>
            <b className="num">{apr}</b>
          </span>
          <ArrowRight weight="bold" aria-hidden />
        </a>
        <ul className="land-soon">
          {PRODUCTS.filter((p) => p.status !== "live").map((p) => (
            <li key={p.id}>
              <TokenIcon symbol={p.asset} size={24} />
              <span className="land-product-text">
                <b>{p.name}</b>
                <span>{p.tagline}</span>
              </span>
              <span className="num" title={p.aprBasis}>
                PM strategy est. {approx(p.maxApr)}
              </span>
              <span className="land-soon-tag">Coming soon</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="land-sec" id="land-flow" aria-labelledby="land-how">
        <h2 id="land-how">How it works</h2>
        <ol className="land-flow">
          <li>
            <b>Deposit</b>
            <span>Add USDC and receive hvUSDC vault shares.</span>
          </li>
          <li>
            <b>Strategy runs</b>
            <span>The vault earns funding on Hyperliquid while hedged.</span>
          </li>
          <li>
            <b>Track your balance</b>
            <span>
              Your share value updates onchain. Request a withdrawal any time.
            </span>
          </li>
        </ol>
        <a className="land-link" href="#/docs">
          Read the guide <ArrowRight weight="bold" />
        </a>
      </section>

      <section className="land-sec" aria-labelledby="land-trust">
        <h2 id="land-trust">Built on Hyperliquid</h2>
        <p className="land-trust-line">
          The vault lives on HyperEVM, its positions run on HyperCore, and its
          value is read onchain from HyperCore precompiles.
        </p>
        <Proof vault={entry?.vault ?? null} />
      </section>
    </div>
  );
}

function Proof({ vault }: { vault: string | null }) {
  const monitor = usePublished("monitor", parseMonitor);
  const rules = monitor.kind === "ok" ? monitor.value.rules : [];
  const okRules = rules.filter((r) => r.status === "ok").length;
  // A monitor run older than an hour is history, not the current state.
  const runAt =
    monitor.kind === "ok" ? Date.parse(monitor.value.generatedAt) : NaN;
  const stale = !Number.isFinite(runAt) || Date.now() - runAt > 3_600_000;
  return (
    <ul className="proof-links">
      {vault && (
        <li>
          <a
            href={`https://hyperevmscan.io/address/${vault}`}
            target="_blank"
            rel="noreferrer"
          >
            Contract on HyperEVMScan <ArrowUpRight weight="bold" />
          </a>
        </li>
      )}
      {repo && (
        <li>
          <a href={repo} target="_blank" rel="noreferrer">
            Source code <ArrowUpRight weight="bold" />
          </a>
        </li>
      )}
    </ul>
  );
}
