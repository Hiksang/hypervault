import { useEffect, useState } from "react";
import { chain } from "../chain";
import { demoDexes, demoMarkets } from "../demo";
import {
  apiBase,
  fetchMarkets,
  type Dex,
  type Market,
} from "../hyperliquid/info";
import { failureText } from "../ui";

export type Meta = { dexes: Dex[]; markets: Market[] };

/**
 * Market metadata of the HyperCore behind this chain: the demo's samples, or one read of the
 * public API. `base` is null on a chain without HyperCore, and `meta` stays null there.
 */
export function useMarkets(demo: boolean) {
  const base = demo ? null : apiBase(chain.id);
  const [meta, setMeta] = useState<Meta | null>(
    demo ? { dexes: demoDexes, markets: demoMarkets } : null,
  );
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!base) return;
    let active = true;
    fetchMarkets(base).then(
      (value) => {
        if (!active) return;
        setMeta(value);
        setFailure("");
      },
      (e) => active && setFailure(failureText(e)),
    );
    return () => {
      active = false;
    };
  }, [base, attempt]);
  return { base, meta, failure, retry: () => setAttempt(attempt + 1) };
}
