import { directVaults } from "../assetVault";
import type { DirectVault } from "../directVaultManifest";
import { kindOf } from "../hypervault";
import { approx, PRODUCTS } from "../products";
import { TargetScenario } from "./TargetScenario";
import { TokenIcon } from "./kit";
import { ProductCard } from "./ProductCard";
import { routeHash } from "../route";

/** The reviewed manifest, or why it cannot be used: a broken one lists no vault at all. */
export function manifest(): { entries: DirectVault[]; problem: string } {
  try {
    return { entries: directVaults(), problem: "" };
  } catch (e) {
    return {
      entries: [],
      problem: `The deployment manifest (VITE_DIRECT_VAULTS) is invalid: ${e instanceof Error ? e.message : String(e)}. No vault is offered.`,
    };
  }
}

export function Vaults() {
  const { entries, problem } = manifest();
  const unmatched = entries.filter((e) => kindOf(e) === null);
  const live = PRODUCTS.filter((p) => p.status === "live");
  const soon = PRODUCTS.filter((p) => p.status !== "live");
  return (
    <div className="page">
      <header className="page-top">
        <h1>Vaults</h1>
        <p>
          One strategy engine, accounted in each vault's own asset. The USDC
          vault is live; HYPE and BTC follow.
        </p>
      </header>
      {problem && (
        <p className="inline-warning" role="alert">
          {problem}
        </p>
      )}
      <div className="vault-list">
        {live.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
      <section className="home-sec" aria-labelledby="v-soon">
        <header>
          <h2 id="v-soon">Coming soon</h2>
        </header>
        <div className="soon-row">
          {soon.map((p) => (
            <div className="soon" key={p.id}>
              <TokenIcon symbol={p.asset} size={28} />
              <div>
                <b>{p.name}</b>
                <small>{p.tagline}</small>
              </div>
              <span className="num" title={p.aprBasis}>
                PM strategy est. {approx(p.maxApr)}
              </span>
              <span className="tag">Coming soon</span>
            </div>
          ))}
        </div>
      </section>
      <details className="fold">
        <summary>Strategy details</summary>
        {PRODUCTS.map((p) => (
          <section key={p.id} aria-label={p.name}>
            <h3 className="sub-h">{p.name}</h3>
            <TargetScenario product={p} />
          </section>
        ))}
      </details>
      {unmatched.length > 0 && (
        <section className="home-sec" aria-labelledby="v-retired">
          <header>
            <h2 id="v-retired">
              {unmatched.every((e) => e.retired)
                ? "Retired vaults (withdraw only)"
                : "Other manifest entries"}
            </h2>
          </header>
          <ul className="retired-list">
            {unmatched.map((e) => (
              <li key={e.vault}>
                <a
                  href={routeHash({
                    page: "direct",
                    vault: e.vault,
                    trade: false,
                  })}
                >
                  <b>{e.name}</b>
                  <code className="addr">{e.vault}</code>
                  <span>Open to withdraw</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
