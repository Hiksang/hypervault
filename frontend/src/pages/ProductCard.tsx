import { useEffect, useState } from "react";
import { ArrowRight, ClockCountdown } from "@phosphor-icons/react";
import { chain } from "../chain";
import { observeDirect, type Observation } from "../directRead";
import type { DirectVault } from "../directVaultManifest";
import { apiBase, info } from "../hyperliquid/info";
import { kindOf } from "../hypervault";
import { estAprNow } from "../aprNow";
import { approx, type Product } from "../products";
import { routeHash } from "../route";
import { poll } from "../ui";
import { manifest } from "./Vaults";
import { Skel, TokenIcon } from "./kit";
import { useActivity } from "./VaultActivity";

/** The reviewed manifest entry that carries a product, if it is live. */
export function entryFor(product: Product): DirectVault | null {
  if (product.status !== "live") return null;
  return manifest().entries.find((e) => kindOf(e) === product.id) ?? null;
}

export type Live = {
  seen: Observation | null;
  fundingNow: number | null;
  failure: string;
};

/** Onchain observation of a live vault plus the current HYPE funding rate (display only). */
export function useLive(entry: DirectVault | null): Live {
  const [live, setLive] = useState<Live>({
    seen: null,
    fundingNow: null,
    failure: "",
  });
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    const base = apiBase(chain.id);
    const stop = poll(async () => {
      const [seen, funding] = await Promise.allSettled([
        observeDirect(entry),
        base
          ? info<[{ universe: { name: string }[] }, { funding: string }[]]>(
              base,
              { type: "metaAndAssetCtxs" },
            ).then(([meta, ctx]) => {
              const i = meta.universe.findIndex((u) => u.name === "HYPE");
              return i >= 0 ? Number(ctx[i]!.funding) * 24 * 365 : null;
            })
          : Promise.resolve(null),
      ]);
      if (!alive) return;
      setLive({
        seen: seen.status === "fulfilled" ? seen.value : null,
        fundingNow: funding.status === "fulfilled" ? funding.value : null,
        failure: seen.status === "rejected" ? String(seen.reason) : "",
      });
    }, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [entry?.vault]);
  return live;
}

const usdc = (raw: bigint, decimals = 6) =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });

/**
 * A product card: symbol, name, one line of user value, estimated APR and status, nothing about
 * how the strategy is built (that sits in Strategy details). A live vault shows its current
 * estimate (live hedge at 90-day funding); a coming vault its scenario at LAUNCH_LTV.
 */
export function ProductCard({ product }: { product: Product }) {
  const entry = entryFor(product);
  const live = product.status === "live" && entry !== null;
  return (
    <article className={`vcard ${live ? "is-live" : "is-soon"}`}>
      <TokenIcon symbol={product.asset} size={44} />
      <div className="vcard-main">
        <div className="vcard-title">
          <h3>{product.name}</h3>
          {live ? (
            <span className="status ok">
              <span className="live-dot" aria-hidden /> Live
            </span>
          ) : (
            <span className="tag">
              <ClockCountdown weight="bold" /> Coming soon
            </span>
          )}
        </div>
        <p>{product.tagline}</p>
      </div>
      <div className="vcard-apr">
        <small>Est. APR</small>
        <b className="num" title={product.aprBasis}>
          {approx(product.maxApr)}
        </b>
        <small>PM strategy estimate</small>
      </div>
      {live ? (
        <a
          className="btn primary"
          href={routeHash({ page: "direct", vault: entry.vault, trade: false })}
        >
          Open {product.asset} Vault <ArrowRight weight="bold" />
        </a>
      ) : (
        <span className="btn" aria-disabled>
          Not open yet
        </span>
      )}
    </article>
  );
}

/** The live vault's estimate: its hedged share of NAV at 90-day funding, after costs and fee. */
export function LiveApr({ entry }: { entry: DirectVault }) {
  const { seen } = useLive(entry);
  const decimals = seen?.decimals.ok ? seen.decimals.value : 6;
  const navUsd = seen?.nav.ok ? Number(seen.nav.value) / 10 ** decimals : null;
  const cash = seen?.cash.ok ? Number(seen.cash.value) / 10 ** decimals : null;
  const activity = useActivity(entry.vault, cash);
  const now = estAprNow(
    activity.alloc?.shortHypeUsd ?? null,
    navUsd,
    undefined,
    activity.alloc?.borrowedUsd ?? 0,
    activity.data?.rates.usdcBorrowApr ?? 0,
  );
  if (!now)
    return activity.failure ? <b className="num">—</b> : <Skel w={64} h={30} />;
  return (
    <b
      className="num"
      title="The vault as it runs now: hedged share of NAV at the 90-day average HYPE funding, after trading costs and the 10% fee."
    >
      {approx(now.apr)}
    </b>
  );
}

export { usdc };
