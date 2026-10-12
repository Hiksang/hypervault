import { useEffect, useState } from "react";
import { zeroAddress } from "viem";
import { chain } from "../chain";
import { observeDirect, type Observation } from "../directRead";
import type { DirectVault } from "../directVaultManifest";
import {
  bridgeKind,
  parseMonitor,
  staleness,
  type Monitor,
} from "../hypervault";
import { routeHash } from "../route";
import { failureText } from "../ui";
import {
  amount,
  Fields,
  PublishedView,
  StatusBadge,
  Value,
  when,
} from "./hyper";
import { manifest } from "./Vaults";
import { ago, SectionError, Skel, useClock } from "./kit";

const ACTIONS = [
  "None",
  "Deposit",
  "Recall",
  "Agent",
  "Revoke agent",
  "Control",
];

export function Ops({ demo }: { demo: boolean }) {
  const { entries, problem } = manifest();
  return (
    <div className="page">
      <header className="page-top">
        <h1>Operations</h1>
        <p>
          Public, read-only status of the vaults and of the latest monitoring
          run. Owner actions stay in the owner wallet.
        </p>
      </header>
      <PublishedView
        name="monitor"
        parse={parseMonitor}
        missing="No monitoring run published yet"
      >
        {(file) => <MonitorView file={file} />}
      </PublishedView>
      <section className="sec" aria-labelledby="ops-vaults">
        <header className="sec-head">
          <h2 id="ops-vaults">Vault status</h2>
          <span className="fresh">Read from {chain.name} on request</span>
        </header>
        {problem && (
          <p className="inline-warning" role="alert">
            {problem}
          </p>
        )}
        {entries.length === 0 ? (
          <p className="empty-line">
            No vault is in this build's deployment manifest: nothing to read.
          </p>
        ) : demo ? (
          <p className="empty-line">
            Switch to contract mode to read vault status.
          </p>
        ) : (
          <div className="ops-vaults">
            {entries.map((e) => (
              <VaultStatus key={e.vault} entry={e} />
            ))}
          </div>
        )}
      </section>
      <section className="sec" aria-labelledby="ops-roles">
        <header className="sec-head">
          <h2 id="ops-roles">Who can do what</h2>
        </header>
        <dl className="kv-list">
          <div>
            <dt>Owner</dt>
            <dd>
              Registers the valuation scope, allocates to HyperCore through
              CoreWriter, recalls assets, starts and settles withdrawal epochs,
              approves the API wallet.
            </dd>
          </div>
          <div>
            <dt>API wallet (agent)</dt>
            <dd>
              Places and cancels orders for the vault's Core account. Trusted
              with trading authority there. Moving assets back to HyperEVM is an
              owner-only vault function.
            </dd>
          </div>
          <div>
            <dt>Anyone</dt>
            <dd>Records a share price and reads NAV.</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function VaultStatus({ entry }: { entry: DirectVault }) {
  const [seen, setSeen] = useState<Observation | null>(null),
    [failure, setFailure] = useState(""),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    // Read once and on request: a full read is some thirty calls against a shared RPC limit.
    observeDirect(entry).then(
      (value) => {
        if (!alive) return;
        setSeen(value);
        setFailure("");
      },
      (e) => alive && setFailure(failureText(e)),
    );
    return () => {
      alive = false;
    };
  }, [entry.vault, tick]);
  const kind = seen?.kind.ok ? bridgeKind(seen.kind.value) : null;
  const unit = kind === "BTC" ? "UBTC" : (kind ?? "");
  const decimals = seen?.decimals.ok ? seen.decimals.value : 18;
  const fmt = (v: bigint) => `${amount(decimals)(v)} ${unit}`;
  return (
    <div className="ops-vault">
      <div className="ops-vault-head">
        <h3>
          <a
            href={routeHash({
              page: "direct",
              vault: entry.vault,
              trade: false,
            })}
          >
            {entry.name}
          </a>
        </h3>
        <button className="btn-sm" onClick={() => setTick((n) => n + 1)}>
          Read again
        </button>
      </div>
      {failure && (
        <SectionError
          what="This vault could not be read."
          detail={failure}
          onRetry={() => setTick((n) => n + 1)}
        />
      )}
      {!seen ? (
        !failure && <Skel h={120} />
      ) : (
        <>
          <p className="fresh">
            {chain.name} · EVM block {seen.block.toString()} ·{" "}
            {when(new Date(Number(seen.blockTime) * 1000).toISOString())}
          </p>
          <Fields
            rows={[
              ["Owner", <Value seen={seen.owner} show={String} />],
              [
                "API wallet",
                <Value
                  seen={seen.apiWallet}
                  show={(a) => (a === zeroAddress ? "none registered" : a)}
                />,
              ],
              [
                "Core activated",
                <Value
                  seen={seen.coreActivated}
                  show={(b) => (b ? "yes" : "no")}
                />,
              ],
              [
                "Pending Core action",
                <Value
                  seen={seen.pending}
                  show={(p) =>
                    p.id === 0n
                      ? "none"
                      : `#${p.id} ${ACTIONS[p.kind] ?? p.kind} · ${fmt(p.assets)} · submitted at Core block ${p.submittedCoreBlock} · awaiting confirmation`
                  }
                />,
              ],
              ["Allocation queue", <Value seen={seen.queued} show={fmt} />],
              ["EVM cash", <Value seen={seen.cash} show={fmt} />],
              [
                "Reserved for claims",
                <Value seen={seen.reserved} show={fmt} />,
              ],
              [
                "Active withdrawal epoch",
                <Value seen={seen.epoch} show={String} />,
              ],
              [
                "Last confirmed Core block",
                <Value seen={seen.lastCoreBlock} show={String} />,
              ],
            ]}
          />
        </>
      )}
    </div>
  );
}

function MonitorView({ file }: { file: Monitor }) {
  const now = useClock(30_000);
  const age = staleness(file.generatedAt, now);
  const counts = { ok: 0, warn: 0, alert: 0, other: 0 };
  for (const r of file.rules)
    if (r.status === "ok") counts.ok++;
    else if (r.status === "warn") counts.warn++;
    else if (r.status === "alert") counts.alert++;
    else counts.other++;
  const attention = file.rules.filter((r) => r.status !== "ok");
  const runAt = Date.parse(file.generatedAt);
  return (
    <>
      <section className="ops-summary-card" aria-label="Monitoring summary">
        <div className="ops-sum-main">
          <small>Rule engine · latest run</small>
          {age.stale ? (
            <b className="big">
              <span className="tag warn">Stale</span> Last run {ago(runAt, now)}
            </b>
          ) : (
            <b className="big num">
              {counts.ok} of {file.rules.length} checks ok
            </b>
          )}
          <span className="fresh">
            {when(file.generatedAt)} · run {file.runId}
            {age.stale &&
              " · more than 30 minutes old: these results are history, not the current state"}
          </span>
        </div>
        <ul className="ops-counts">
          <li>
            <span className="tag ok">ok</span> {counts.ok}
          </li>
          <li>
            <span className="tag warn">warn</span> {counts.warn}
          </li>
          <li>
            <span className="tag bad">alert</span> {counts.alert}
          </li>
          {counts.other > 0 && (
            <li>
              <span className="tag">not observable</span> {counts.other}
            </li>
          )}
        </ul>
        <div className="ops-sum-ai">
          <small>AI summary (advisory)</small>
          <span className={`tag ${file.ai.status === "ok" ? "info" : ""}`}>
            {file.ai.status === "ok"
              ? "Active"
              : file.ai.status === "disabled"
                ? "Off"
                : "Failed"}
          </span>
          <span className="fresh">Separate from the rule engine</span>
        </div>
        {attention.length > 0 && (
          <ul className="ops-attn">
            {attention.map((r) => (
              <li key={r.id}>
                <StatusBadge status={r.status} /> <b>{r.title}</b>
                {r.observed !== null && (
                  <span className="num">
                    {" "}
                    · {r.observed} {r.unit}
                  </span>
                )}
                <span className="muted-line"> {r.action}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sec" aria-labelledby="ops-rules">
        <header className="sec-head">
          <h2 id="ops-rules">Rules</h2>
          <span className="fresh">
            Vault <code className="addr">{file.vault.slice(0, 10)}…</code> ·{" "}
            {file.network}
          </span>
        </header>
        <div className="tbl-wrap">
          <table className="tbl ops-tbl">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Status</th>
                <th className="r">Observed</th>
                <th className="r">Threshold</th>
              </tr>
            </thead>
            <tbody>
              {file.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <b>{rule.title}</b>
                    <small className="rule-why">{rule.rationale}</small>
                  </td>
                  <td>
                    <StatusBadge status={rule.status} />
                  </td>
                  <td className="r">
                    {rule.observed === null ? (
                      <span className="unseen">not observable</span>
                    ) : (
                      `${rule.observed} ${rule.unit}`
                    )}
                  </td>
                  <td className="r">
                    {rule.threshold} {rule.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {file.errors.length > 0 && (
          <SectionError
            what={`${file.errors.length} error(s) in this run`}
            detail={file.errors.join(" · ")}
          />
        )}
        <details className="fold">
          <summary>Run details</summary>
          <Fields
            rows={[
              ["Run", file.runId],
              ["Network", file.network],
              ["Vault", <code className="address">{file.vault}</code>],
              ["Generated", when(file.generatedAt)],
              ["Last successful run", when(file.lastSuccessAt)],
            ]}
          />
          <Fields
            rows={file.rules.map((r) => [r.title, `Action: ${r.action}`])}
          />
        </details>
      </section>

      <section className="sec" aria-labelledby="ops-ai">
        <header className="sec-head">
          <h2 id="ops-ai">AI summary</h2>
          <span className="fresh">
            Advisory only: no trading, risk-limit or fund-moving authority
          </span>
        </header>
        {file.ai.status !== "ok" ? (
          <p className="empty-line">
            {file.ai.status === "disabled"
              ? "The AI summary is off for this run."
              : `The AI summary failed${file.ai.error ? `: ${file.ai.error}` : ""}.`}{" "}
            The rule table above is complete without it.
          </p>
        ) : (
          <>
            <p className="fresh">
              Model {file.ai.model ?? "unknown"} · generated{" "}
              {when(file.ai.generatedAt)} · input digest{" "}
              <code>{file.ai.inputDigest ?? "unknown"}</code>
            </p>
            {file.ai.summary && <p>{file.ai.summary}</p>}
            {file.ai.causes && file.ai.causes.length > 0 && (
              <>
                <h3 className="sub-h">Possible causes</h3>
                <ul className="hv-list">
                  {file.ai.causes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            {file.ai.impact && (
              <>
                <h3 className="sub-h">Impact</h3>
                <p>{file.ai.impact}</p>
              </>
            )}
            {file.ai.responseCandidates &&
              file.ai.responseCandidates.length > 0 && (
                <>
                  <h3 className="sub-h">
                    Response candidates (for the owner to decide)
                  </h3>
                  <ul className="hv-list">
                    {file.ai.responseCandidates.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
          </>
        )}
      </section>
    </>
  );
}
