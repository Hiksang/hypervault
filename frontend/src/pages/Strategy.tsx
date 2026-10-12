import {
  fields,
  parsePmComparison,
  parseStrategy,
  type PmComparison,
  type Strategy as File,
} from "../hypervault";
import { Fields, PublishedView, StatusBadge, when } from "./hyper";

const cell = (value: number | null) =>
  value === null ? <span className="unseen">not computed</span> : String(value);

export function Strategy() {
  return (
    <div className="hv">
      <p className="eyebrow">
        <a href="#/">HYPERVAULT</a> <span>/</span> STRATEGY
      </p>
      <h1>Strategy &amp; Portfolio Margin</h1>
      <section>
        <h2>Separate margin vs HyperVault PM</h2>
        <PublishedView
          name="pm-comparison"
          parse={parsePmComparison}
          missing="No PM comparison published yet"
        >
          {(file) => <Comparison file={file} />}
        </PublishedView>
      </section>
      <section>
        <h2>Runner plans</h2>
        <PublishedView
          name="strategy"
          parse={parseStrategy}
          missing="No strategy snapshot published yet"
        >
          {(file) => <Plans file={file} />}
        </PublishedView>
      </section>
    </div>
  );
}

function Comparison({ file }: { file: PmComparison }) {
  return (
    <>
      <p className="hv-small">
        Asset {file.asset} · generated {when(file.generatedAt)}
      </p>
      <h3 className="hv-sub">Assumptions</h3>
      <div className="hv-table-wrap">
        <table className="hv-table">
          <thead>
            <tr>
              <th>Assumption</th>
              <th>Value</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {file.assumptions.map((a) => (
              <tr key={a.name}>
                <th scope="row">{a.name}</th>
                <td>
                  {a.value} {a.unit}
                </td>
                <td>{a.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="hv-sub">Comparison</h3>
      <div className="hv-table-wrap">
        <table className="hv-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Unit</th>
              <th>Isolated / separate margin</th>
              <th>HyperVault PM</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {file.rows.map((row) => (
              <tr key={row.metric}>
                <th scope="row">{row.metric}</th>
                <td>{row.unit}</td>
                <td>{cell(row["separate-margin"])}</td>
                <td>{cell(row["hypervault-pm"])}</td>
                <td>{row.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {file.caveats.length > 0 && (
        <ul className="hv-list">
          {file.caveats.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Plans({ file }: { file: File }) {
  if (file.plans.length === 0)
    return <p className="note">The snapshot holds no plans.</p>;
  return (
    <>
      <p className="hv-small">Generated {when(file.generatedAt)}</p>
      {file.plans.map((plan, i) => (
        <article className="hv-card" key={`${plan.vault}-${i}`}>
          <div className="hv-card-head">
            <h3>{plan.vault} vault</h3>
            <span>
              {plan.hypothetical && <StatusBadge status="hypothetical" />}{" "}
              <StatusBadge status={plan.mode} />
            </span>
          </div>
          {plan.hypothetical && (
            <p className="inline-warning">
              Hypothetical input. No vault deployed. Figures come from live
              market data applied to an assumed position; nothing was traded.
            </p>
          )}
          <p className="hv-small">
            {plan.mode === "dry-run"
              ? "Dry run: planned only, nothing was sent."
              : "Executed: the runner reports these actions as sent."}{" "}
            Observed {when(plan.observedAt)}
            {plan.account && (
              <>
                {" "}
                · account <code className="address">{plan.account}</code>
              </>
            )}
          </p>
          <div className="hv-cards two">
            <div>
              <small>Original exposure (kept)</small>
              <Fields rows={fields(plan.baseExposure)} />
            </div>
            <div>
              <small>Extra spot and its hedge</small>
              <Fields rows={fields(plan.extraHedge)} />
            </div>
          </div>
          {plan.actions.length > 0 && (
            <div className="hv-table-wrap">
              <table className="hv-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Market</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.actions.map((a, j) => (
                    <tr key={j}>
                      <td>{a.kind}</td>
                      <td>{a.market}</td>
                      <td>{a.side}</td>
                      <td>
                        {a.size} {a.unit}
                      </td>
                      <td>{a.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan.blocked.length > 0 && (
            <div className="inline-warning">
              <b>Blocked</b>
              <ul>
                {plan.blocked.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.results.length > 0 && (
            <>
              <small>Exchange results</small>
              <div className="hv-table-wrap">
                <table className="hv-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>State</th>
                      <th>Filled / requested</th>
                      <th>Avg price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.results.map((r, j) => {
                      const a = (r.action ?? {}) as Record<string, unknown>;
                      return (
                        <tr key={j}>
                          <td>
                            {a.market
                              ? `${String(a.market)} ${String(a.side ?? "")}`
                              : String(r.kind ?? "—")}
                          </td>
                          <td>
                            {r.state !== undefined ? (
                              <StatusBadge status={String(r.state)} />
                            ) : r.response !== undefined ? (
                              "answered"
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            {r.totalSz !== undefined
                              ? `${String(r.totalSz)} / ${String(r.requested ?? "?")}`
                              : "—"}
                          </td>
                          <td>
                            {r.avgPx !== undefined ? String(r.avgPx) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <small>Risk</small>
          <Fields rows={fields(plan.risk)} />
        </article>
      ))}
    </>
  );
}
