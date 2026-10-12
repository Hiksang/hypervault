/** Published share-price series (monitor + ledger snapshots) and the realized return it shows. */

export type NavPoint = {
  t: number;
  nav: number;
  supply: number;
  price: number | null;
};
export type NavHistory = {
  vault: string;
  points: NavPoint[];
  example: boolean;
};

const DAY = 86_400;
/** Below this span a return is shown as cumulative only: annualizing it would mislead. */
export const MIN_ANNUALIZE_DAYS = 30;

export function parseNavHistory(raw: unknown): NavHistory {
  const r = raw as { vault?: unknown; points?: unknown };
  if (typeof r?.vault !== "string" || !Array.isArray(r.points))
    throw new Error("nav-history: bad shape");
  const points = r.points.map((p) => {
    const q = p as Record<string, unknown>;
    if (typeof q.t !== "number" || typeof q.nav !== "number")
      throw new Error("nav-history: bad point");
    return {
      t: q.t,
      nav: q.nav,
      supply: Number(q.supply ?? 0),
      price: typeof q.price === "number" ? q.price : null,
    };
  });
  points.sort((a, b) => a.t - b.t);
  return { vault: r.vault, points, example: false };
}

/** The latest run of points with shares outstanding: a return never spans an empty vault. */
export function currentSegment(points: NavPoint[]): NavPoint[] {
  const out: NavPoint[] = [];
  for (const p of points) {
    if (p.price === null) out.length = 0;
    else out.push(p);
  }
  return out;
}

export type Realized = {
  from: number;
  to: number;
  days: number;
  cumulative: number;
  /** Null until the segment spans MIN_ANNUALIZE_DAYS. */
  annualized: number | null;
};

export function realizedReturn(points: NavPoint[]): Realized | null {
  const seg = currentSegment(points);
  if (seg.length < 2) return null;
  const a = seg[0]!,
    b = seg[seg.length - 1]!;
  const days = (b.t - a.t) / DAY;
  const cumulative = b.price! / a.price! - 1;
  return {
    from: a.t,
    to: b.t,
    days,
    cumulative,
    annualized:
      days >= MIN_ANNUALIZE_DAYS
        ? Math.pow(1 + cumulative, 365 / days) - 1
        : null,
  };
}
