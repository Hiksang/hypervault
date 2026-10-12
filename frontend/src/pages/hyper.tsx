import { useEffect, useState, type ReactNode } from "react";
import { assetAmount } from "../assetAmounts";
import type { Seen } from "../directRead";
import { loadPublished, type Published } from "../hypervault";

const base = import.meta.env.BASE_URL;

/** One published file, or its example when the visitor asks for the format. */
export function usePublished<T>(
  name: string,
  parse: (raw: unknown) => T,
  example = false,
): Published<T> {
  const [state, setState] = useState<Published<T>>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void loadPublished(
      `${base}hypervault/${name}${example ? ".example" : ""}.json`,
      parse,
    ).then((value) => alive && setState(value));
    return () => {
      alive = false;
    };
  }, [name, example]);
  return state;
}

/**
 * Draws a published file, or why it cannot be drawn. A missing file says what `missing` says
 * and offers the example file, which then carries the example banner.
 */
export function PublishedView<T extends { example: boolean }>({
  name,
  parse,
  missing,
  children,
}: {
  name: string;
  parse: (raw: unknown) => T;
  missing: string;
  children: (value: T) => ReactNode;
}) {
  const [example, setExample] = useState(false);
  const state = usePublished(name, parse, example);
  if (state.kind === "loading")
    return <p className="empty">Loading {name}.json…</p>;
  if (state.kind === "missing")
    return (
      <div className="note">
        <b>{missing}</b>
        <p>
          <code>public/hypervault/{name}.json</code> is not published in this
          build.
        </p>
        {!example && (
          <button className="link" onClick={() => setExample(true)}>
            Preview the example file format
          </button>
        )}
      </div>
    );
  if (state.kind === "error")
    return (
      <p className="inline-warning" role="alert">
        <b>
          {name}
          {example ? ".example" : ""}.json could not be shown:
        </b>{" "}
        {state.error.replace(/\.$/, "")}. Nothing from it is displayed.
      </p>
    );
  return (
    <>
      {state.value.example && <ExampleBanner />}
      {children(state.value)}
    </>
  );
}

export function ExampleBanner() {
  return (
    <div className="hv-banner example" role="status">
      Example data: format illustration only, not observed from any network
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="hv-banner demo" role="status">
      Demo data: simulated, not a live vault
    </div>
  );
}

const TONES: Record<string, string> = {
  done: "ok",
  ok: "ok",
  executed: "ok",
  pending: "warn",
  warn: "warn",
  "dry-run": "info",
  hypothetical: "warn",
  filled: "ok",
  partial: "warn",
  rejected: "bad",
  failed: "bad",
  alert: "bad",
  "not-run": "muted",
  unobservable: "muted",
  disabled: "muted",
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`hv-badge ${TONES[status] ?? "muted"}`}>{status}</span>
  );
}

/** An ISO time as UTC, to the second. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export const NOT_OBSERVABLE = "not observable";
/** A read value as text, or "not observable" with the reason on hover. */
export function Value<T>({
  seen,
  show,
}: {
  seen: Seen<T> | undefined;
  show: (value: T) => string;
}) {
  if (!seen) return <span className="unseen">{NOT_OBSERVABLE}</span>;
  return seen.ok ? (
    <>{show(seen.value)}</>
  ) : (
    <span className="unseen" title={seen.error}>
      {NOT_OBSERVABLE}
    </span>
  );
}
export const amount = (decimals: number) => (value: bigint) =>
  assetAmount(value, decimals);

export function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="hv-fields">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
