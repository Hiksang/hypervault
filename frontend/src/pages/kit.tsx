import { useEffect, useState, type ReactNode } from "react";
import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";

/** Official token marks, shipped as local files (public/tokens). */
const TOKEN_FILES: Record<string, string> = {
  USDC: "/tokens/USDC.svg",
  HYPE: "/tokens/HYPE.svg",
  BTC: "/tokens/BTC.svg",
  UBTC: "/tokens/BTC.svg",
};

export function TokenIcon({
  symbol,
  size = 20,
}: {
  symbol: string;
  size?: number;
}) {
  const src = TOKEN_FILES[symbol.toUpperCase()];
  if (!src)
    return (
      <span
        className="tk tk-text"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {symbol.slice(0, 1)}
      </span>
    );
  return (
    <span
      className={`tk tk-${symbol.toLowerCase()}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img src={src} alt="" width={size} height={size} />
    </span>
  );
}

/** A grey block with the final element's shape, so the layout does not move when data lands. */
export function Skel({
  w = "100%",
  h = 16,
  className = "",
}: {
  w?: number | string;
  h?: number;
  className?: string;
}) {
  return (
    <span
      className={`skel ${className}`}
      style={{ width: w, height: h }}
      aria-hidden
    />
  );
}

/** A section-local failure: what failed, and a retry that re-reads only this section. */
export function SectionError({
  what,
  detail,
  onRetry,
}: {
  what: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="sec-error" role="alert">
      <WarningCircle weight="bold" aria-hidden />
      <span>
        <b>{what}</b>
        {detail && <small title={detail}>{shorten(detail)}</small>}
      </span>
      {onRetry && (
        <button className="btn-sm" onClick={onRetry}>
          <ArrowClockwise weight="bold" aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}

const shorten = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

/** Re-renders every `ms`, for "updated 40s ago" lines. */
export function useClock(ms = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "Updated 30s ago" with a stale label once the data is older than `staleAfter` ms. */
export function Freshness({
  at,
  staleAfter,
  source,
  failed = false,
}: {
  at: number | null;
  staleAfter: number;
  source?: string;
  /** The read failed: say so instead of "Reading…". */
  failed?: boolean;
}) {
  const now = useClock();
  if (at === null)
    return (
      <span className="fresh">
        {failed ? `${source ? `${source} · ` : ""}not read` : "Reading…"}
      </span>
    );
  const stale = now - at > staleAfter;
  return (
    <span className={`fresh ${stale ? "is-stale" : ""}`}>
      {stale && <b className="tag warn">Stale</b>}
      {source ? `${source} · ` : ""}updated {ago(at, now)}
    </span>
  );
}

/** A decimal rounded for reading (tabular), the exact value on hover. */
export function Fig({
  v,
  digits,
  unit,
  signed = false,
}: {
  v: number | string | null | undefined;
  digits: number;
  unit?: string;
  signed?: boolean;
}) {
  if (v === null || v === undefined || v === "") return <>—</>;
  const x = Number(v);
  if (!Number.isFinite(x)) return <>{String(v)}</>;
  const s = Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = x < 0 ? "−" : signed && x > 0 ? "+" : "";
  return (
    <span className="num" title={String(v)}>
      {sign}
      {s}
      {unit && <span className="unit"> {unit}</span>}
    </span>
  );
}

export function Tip({ children }: { children: ReactNode }) {
  return <span className="tip">{children}</span>;
}
