import { useState } from "react";
import {
  inspectGuards,
  send,
  sourceAbi,
  type Guards,
  type ScopeReport,
} from "../chain";
import { demoClear, demoConfigure } from "../demo";
import { duration, uint } from "../domain";
import { USDC } from "../hyperliquid/info";
import {
  MAX_CORE_VAULTS,
  MAX_DEXES,
  MAX_TOKENS,
  addCoreVault,
  addDex,
  addToken,
  answer,
  configureArgs,
  dexName,
  draftOf,
  flagToken,
  registered,
  removeCoreVault,
  removeDex,
  removeToken,
  sameScope,
  tokenChoices,
  tokenName,
  type Draft,
} from "../scope";
import { failureText, short, type Loaded, type VaultView } from "../ui";
import { useMarkets } from "./markets";
import { Records } from "./Records";

export function Scope({
  view,
  guards,
  failure,
}: {
  view: VaultView;
  guards: Loaded<Guards | null> | undefined;
  failure: string;
}) {
  const { app, vault, fresh, blockWrite, act } = view;
  const { demo } = app;
  const { base, meta, failure: metaFailure, retry } = useMarkets(demo);
  const [edit, setEdit] = useState<{ version: bigint; draft: Draft } | null>(
    null,
  );
  const [enable, setEnable] = useState(true),
    [problem, setProblem] = useState(""),
    [pick, setPick] = useState(""),
    [index, setIndex] = useState(""),
    [pair, setPair] = useState(""),
    [lending, setLending] = useState(false),
    [reserve, setReserve] = useState(false),
    [dexPick, setDexPick] = useState(""),
    [coreVault, setCoreVault] = useState("");
  if (!guards)
    return (
      <div className="form">
        <h2>평가 범위</h2>
        {failure ? (
          <p className="inline-warning" role="alert">
            등록 범위를 조회하지 못했습니다. {failure}
          </p>
        ) : (
          <p>등록 범위를 조회하는 중…</p>
        )}
      </div>
    );
  if (!guards.value)
    return (
      <div className="form">
        <h2>평가 범위</h2>
        <p className="inline-warning">
          이 Vault의 검증기에는 여기서 관리할 등록 범위가 없습니다. 등록 범위는
          precompile 검증기를 연결한 Vault에만 있습니다.
        </p>
      </div>
    );
  const g = guards.value;
  const { scope } = g;
  // An edit made against an older version is dropped: the scope it started from is gone.
  const editing = !!edit && edit.version === scope.version;
  const draft = editing ? edit.draft : draftOf(scope);
  const changed = !sameScope(draft, scope);
  const enabled = scope.version === 0n ? enable : scope.enabled;
  const markets = meta?.markets ?? [],
    dexes = meta?.dexes ?? [];
  // Without market metadata the indexes are typed in by hand.
  const manual = !meta && (!base || !!metaFailure);
  const locked = blockWrite || !fresh || !guards.fresh;
  // Saving a scope that lists the reported venue can lift the report: it leaves the list, and
  // what was recorded so far stops being price history. That is a fact only for a DEX or
  // HyperCore vault whose report the page saw stand. For the rest the block of the save decides,
  // so the page states the condition and does not predict the outcome.
  const standing = view.state.closedBy === "OpenReport";
  const kept = changed
    ? g.reports.find((report) => answer(draft, report, g.blockTime, standing))
    : undefined;
  const outcome = kept ? answer(draft, kept, g.blockTime, standing) : "";
  /** Whether the edit was accepted; a refused one says why under the editor. */
  function change(next: (current: Draft) => Draft) {
    try {
      setEdit({ version: scope.version, draft: next(draft) });
      setProblem("");
      return true;
    } catch (e) {
      setProblem(failureText(e));
      return false;
    }
  }
  // A report closes the Vault only while its venue holds something the scope does not answer
  // for; the contract reads that again at every valuation. The list alone does not say whether
  // it does: only a valuation that was just refused for it (`OpenReport`) shows that the one
  // report stands. A listed DEX or HyperCore vault is never a registered one. A token can be
  // both: its report stands while the registered pair pays nothing for the holding.
  function reportState(report: ScopeReport) {
    if (report.expiresAt <= g.blockTime) return "소멸 · 아무것도 닫지 않음";
    const lapse = `${duration(report.expiresAt - g.blockTime)} 뒤 소멸`;
    const listed = registered(scope, report);
    if (view.state.closedBy === "OpenReport")
      return `지금 성립 · ${listed ? "등록된 pair가 이 보유를 사 주지 않음 · " : ""}입금과 출금 정산이 닫혀 있음 · ${lapse}`;
    return listed
      ? `등록됨 · 등록된 pair가 보유를 사 주지 않는 동안 닫힘 · ${lapse}`
      : `보유가 남아 있는 동안 닫힘 · ${lapse}`;
  }
  function reportLabel(report: ScopeReport) {
    if (report.kind === "token")
      return `토큰 ${tokenName(markets, report.id)} (index ${report.id})`;
    if (report.kind === "dex")
      return `perp DEX ${dexName(dexes, report.id)} (index ${report.id})`;
    return `HyperCore vault ${short(report.coreVault)}`;
  }
  async function save() {
    await act(async () => {
      if (demo) {
        view.demoApply((row) => demoConfigure(row, draft, enabled, Date.now()));
        app.demoNotice("평가 범위 저장을 모의했습니다.");
        return;
      }
      const args = configureArgs(vault, draft, enabled);
      const latest = await inspectGuards(vault);
      if (!latest || latest.scope.version !== scope.version)
        throw new Error(
          "등록 범위가 그사이 바뀌었습니다. 새로 조회된 범위에서 다시 편집하세요.",
        );
      const receipt = await view.ownerSend(
        "configure",
        args,
        latest.source,
        sourceAbi,
      );
      app.say(`평가 범위 저장 확정 · ${receipt.transactionHash}`);
    });
  }
  async function toggle() {
    if (scope.version === 0n) {
      setEnable(!enable);
      return;
    }
    await act(async () => {
      if (demo) {
        view.demoApply((row) => ({
          ...row,
          guards: {
            ...row.guards,
            scope: { ...row.guards.scope, enabled: !scope.enabled },
          },
        }));
        app.demoNotice(
          `입금 평가 스위치를 ${scope.enabled ? "껐습니다" : "켰습니다"}.`,
        );
        return;
      }
      const receipt = await view.ownerSend(
        "setEnabled",
        [vault, !scope.enabled],
        g.source,
        sourceAbi,
      );
      app.say(`스위치 변경 확정 · ${receipt.transactionHash}`);
    });
  }
  async function clear(report: number) {
    await act(async () => {
      if (demo) {
        view.demoApply((row) => demoClear(row, report, Date.now()));
        app.demoNotice("신고를 목록에서 지우는 것을 모의했습니다.");
        return;
      }
      const { p, a } = app.wallet();
      const receipt = await send(
        p,
        a,
        g.source,
        "clearReport",
        [vault, BigInt(report)],
        sourceAbi,
      );
      app.say(`신고 목록 정리 확정 · ${receipt.transactionHash}`);
    });
  }
  return (
    <div className="form scope">
      <h2>평가 범위</h2>
      <p>
        검증기가 NAV에 집계하는 토큰·perp DEX·HyperCore vault입니다. 이 목록
        밖의 보유는 지분 가격에 반영되지 않습니다.
      </p>
      {!guards.fresh && (
        <p className="inline-warning">
          등록 범위 조회가 만료되었습니다. 다시 조회될 때까지 변경을 보낼 수
          없습니다. {failure}
        </p>
      )}
      <div className="split">
        <div>
          <section className="block">
            <div className="block-head">
              <h3>등록 범위</h3>
              <span className="tag">버전 {scope.version.toString()}</span>
              {changed && <span className="tag warn">저장 전 변경</span>}
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={enabled}
                disabled={locked}
                onChange={toggle}
              />
              <i />
              <span>입금 평가 {enabled ? "켜짐" : "꺼짐"}</span>
            </label>
            <small>
              {scope.version === 0n
                ? "아직 등록된 범위가 없습니다. 스위치는 첫 저장과 함께 적용됩니다."
                : "끄면 운용 준비·운용 중의 입금이 닫힙니다. 가격 기록과 출금 정산 검증은 계속 동작합니다."}
            </small>
            <h4>
              토큰 <em>{`${draft.tokens.length} / ${MAX_TOKENS}`}</em>
            </h4>
            <div className="rows">
              {draft.tokens.map((row) => (
                <div className="row" key={row.index}>
                  <span className="grow">
                    <b>{tokenName(markets, row.index)}</b>
                    <em>
                      index {row.index}
                      {row.index !== USDC && ` · USDC pair ${row.usdcSpot}`}
                    </em>
                  </span>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={row.lending}
                      onChange={(e) =>
                        change((current) =>
                          flagToken(
                            current,
                            row.index,
                            "lending",
                            e.target.checked,
                          ),
                        )
                      }
                    />
                    lending
                  </label>
                  {row.index !== USDC && (
                    <>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={row.reservePrice}
                          onChange={(e) =>
                            change((current) =>
                              flagToken(
                                current,
                                row.index,
                                "reservePrice",
                                e.target.checked,
                              ),
                            )
                          }
                        />
                        reserve 가격
                      </label>
                      <button
                        className="link"
                        onClick={() =>
                          change((current) => removeToken(current, row.index))
                        }
                      >
                        삭제
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="adder">
              {manual ? (
                <div className="two">
                  <input
                    value={index}
                    onChange={(e) => setIndex(e.target.value)}
                    inputMode="numeric"
                    placeholder="token index"
                    aria-label="token index"
                  />
                  <input
                    value={pair}
                    onChange={(e) => setPair(e.target.value)}
                    inputMode="numeric"
                    placeholder="USDC pair index"
                    aria-label="USDC pair index"
                  />
                </div>
              ) : (
                <select
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  disabled={!meta}
                  aria-label="추가할 토큰"
                >
                  <option value="">
                    {meta
                      ? "USDC 호가 spot 시장에서 토큰 선택…"
                      : "시장 정보를 불러오는 중…"}
                  </option>
                  {tokenChoices(markets, draft).map((market) => (
                    <option key={market.key} value={market.key}>
                      {market.label} · token {market.token} · pair {market.pair}
                    </option>
                  ))}
                </select>
              )}
              <div className="adder-flags">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={lending}
                    onChange={(e) => setLending(e.target.checked)}
                  />
                  lending
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={reserve}
                    onChange={(e) => setReserve(e.target.checked)}
                  />
                  reserve 가격
                </label>
                <button
                  onClick={() => {
                    const added = change((current) => {
                      if (manual)
                        return addToken(current, {
                          index: Number(uint(index, 32)),
                          usdcSpot: Number(uint(pair, 32)),
                          lending,
                          reservePrice: reserve,
                        });
                      const market = markets.find((row) => row.key === pick);
                      if (!market)
                        throw new Error("추가할 spot 시장을 선택하세요.");
                      return addToken(current, {
                        index: market.token,
                        usdcSpot: market.pair,
                        lending,
                        reservePrice: reserve,
                      });
                    });
                    if (!added) return;
                    setPick("");
                    setIndex("");
                    setPair("");
                  }}
                >
                  토큰 추가
                </button>
              </div>
            </div>
            <small>
              lending은 그 토큰의 Borrow/Lend 장부를 NAV에 집계합니다(Portfolio
              Margin에서는 담보가 될 수 있는 모든 토큰에 켭니다). reserve 가격은
              호가 대신 프로토콜의 reserve oracle로 평가합니다. 토큰은
              매수호가가 실제로 있는 USDC pair로만 등록하세요. 등록한 pair가 사
              주지 않는 보유는 다른 pair에서 20 USDC 이상에 팔리면 누구나 신고할
              수 있고, 매도할 때까지 입금과 출금 정산을 닫아 둡니다.
            </small>
            <h4>
              perp DEX <em>{`${draft.dexes.length} / ${MAX_DEXES}`}</em>
            </h4>
            <div className="rows">
              {!draft.dexes.length && (
                <p className="empty">등록된 DEX가 없습니다.</p>
              )}
              {draft.dexes.map((dex) => (
                <div className="row" key={dex}>
                  <span className="grow">
                    <b>{dexName(dexes, dex)}</b>
                    <em>index {dex}</em>
                  </span>
                  <button
                    className="link"
                    onClick={() => change((current) => removeDex(current, dex))}
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
            <div className="adder inline">
              {manual ? (
                <input
                  value={dexPick}
                  onChange={(e) => setDexPick(e.target.value)}
                  inputMode="numeric"
                  placeholder="DEX index"
                  aria-label="DEX index"
                />
              ) : (
                <select
                  value={dexPick}
                  onChange={(e) => setDexPick(e.target.value)}
                  disabled={!meta}
                  aria-label="추가할 DEX"
                >
                  <option value="">
                    {meta ? "USDC 담보 DEX 선택…" : "시장 정보를 불러오는 중…"}
                  </option>
                  {dexes
                    .filter((dex) => !draft.dexes.includes(dex.index))
                    .map((dex) => (
                      <option
                        key={dex.index}
                        value={dex.index}
                        disabled={dex.collateralToken !== USDC}
                      >
                        {dexName(dexes, dex.index)} · index {dex.index}
                        {dex.collateralToken !== USDC && " · USDC 담보 아님"}
                      </option>
                    ))}
                </select>
              )}
              <button
                onClick={() => {
                  const added = change((current) => {
                    if (!dexPick) throw new Error("추가할 DEX를 고르세요.");
                    const index = Number(uint(dexPick, 32));
                    const known = dexes.find((dex) => dex.index === index);
                    if (known && known.collateralToken !== USDC)
                      throw new Error(
                        "USDC 담보가 아닌 DEX는 평가할 수 없어 등록하지 않습니다.",
                      );
                    return addDex(current, index);
                  });
                  if (added) setDexPick("");
                }}
              >
                DEX 추가
              </button>
            </div>
            <h4>
              HyperCore vault{" "}
              <em>{`${draft.coreVaults.length} / ${MAX_CORE_VAULTS}`}</em>
            </h4>
            <div className="rows">
              {!draft.coreVaults.length && (
                <p className="empty">등록된 HyperCore vault가 없습니다.</p>
              )}
              {draft.coreVaults.map((row) => (
                <div className="row" key={row}>
                  <span className="grow">
                    <code title={row}>{short(row)}</code>
                  </span>
                  <button
                    className="link"
                    onClick={() =>
                      change((current) => removeCoreVault(current, row))
                    }
                  >
                    삭제
                  </button>
                </div>
              ))}
            </div>
            <div className="adder inline">
              <input
                value={coreVault}
                onChange={(e) => setCoreVault(e.target.value)}
                placeholder="HyperCore vault 주소 0x…"
                aria-label="HyperCore vault 주소"
                spellCheck={false}
              />
              <button
                onClick={() => {
                  if (
                    change((current) => addCoreVault(current, coreVault.trim()))
                  )
                    setCoreVault("");
                }}
              >
                vault 추가
              </button>
            </div>
            {manual && (
              <small>
                시장 정보를 조회할 수 없어 index를 직접 입력합니다
                {metaFailure ? ` (${metaFailure})` : ""}. USDC로 호가되는 pair와
                USDC 담보 DEX만 등록하세요.{" "}
                {base && (
                  <button className="link" onClick={retry}>
                    시장 정보 다시 조회
                  </button>
                )}
              </small>
            )}
            {problem && <p className="inline-warning">{problem}</p>}
            {kept && outcome === "answered" && (
              <p className="inline-warning">
                <b>{reportLabel(kept)}</b> 신고에 답하는 저장입니다. 신고는
                목록에서 빠지고, 지금까지의 가격 기록은 이력으로 세지 않게
                됩니다. 입금과 출금 정산은 저장 뒤에 추가된 기록이 창의 절반(
                {duration(g.priceWindow / 2n)})만큼 지난 다음에 열립니다.
              </p>
            )}
            {kept && outcome === "dropped" && (
              <p className="inline-warning">
                <b>{reportLabel(kept)}</b> 신고의 대상을 등록하는 저장입니다.
                마지막 조회에서는 이 신고 때문에 평가가 거부되지 않았습니다.
                저장되는 블록에서도 신고가 성립하지 않으면 목록에서 빠지기만
                하고 가격 이력은 그대로입니다. 그때 성립하고 있으면 이 저장이
                신고에 답한 것이 되어, 지금까지의 가격 기록은 이력으로 세지 않게
                됩니다.
              </p>
            )}
            {kept && outcome === "depends" && (
              <p className="inline-warning">
                <b>{reportLabel(kept)}</b> 신고의 대상을 등록한 채 저장합니다.
                결과는 저장되는 블록에서 정해지고, 이 화면은 미리 읽지 않습니다.
                신고가 그때까지 성립하다가 이 저장으로 풀리면 신고는 목록에서
                빠지고 지금까지의 가격 기록은 이력으로 세지 않게 되어, 저장 뒤에
                추가된 기록이 창의 절반({duration(g.priceWindow / 2n)})만큼 지난
                다음에 입금과 출금 정산이 열립니다. 풀리는 경우는 셋입니다.
                등록된 USDC pair가 그 보유를 10 USDC 이상에 사 주거나, 그 토큰에
                차입이 있거나, 신고에 지목된 pair에서 그 보유의 가치가 20 USDC에
                못 미치는 경우입니다. 마지막 경우 그 보유는 등록 뒤에 평가에
                잡히지도 않고 신고할 수도 없습니다. 신고가 이미 성립하지 않고
                있었다면 목록에서 빠지기만 합니다. 등록된 pair가 사 주지 않고
                차입이 없으며 그 보유가 신고에 지목된 pair에서 20 USDC 이상에
                팔리는 동안에는 신고가 그대로 남고 Vault도 닫힌 채입니다.
              </p>
            )}
            <div className="two">
              <button
                className="primary"
                disabled={locked || !changed}
                onClick={save}
              >
                저장 <span>↗</span>
              </button>
              <button
                disabled={!editing}
                onClick={() => {
                  setEdit(null);
                  setProblem("");
                }}
              >
                되돌리기
              </button>
            </div>
            <small>
              저장은 범위 전체를 교체합니다. 보유가 남아 있는 항목은 뺄 수 없고,
              DEX의 담보 토큰은 컨트랙트가 확인하지 못하므로 USDC 담보 DEX만
              등록해야 합니다.
            </small>
          </section>
        </div>
        <div>
          <Records view={view} guards={guards} full />
          <section className="block">
            <div className="block-head">
              <h3>범위 밖 보유 신고</h3>
              <span className={"tag " + (g.reports.length ? "warn" : "ok")}>
                {g.reports.length ? `${g.reports.length}건` : "없음"}
              </span>
            </div>
            <div className="rows">
              {!g.reports.length && (
                <p className="empty">범위 밖 보유 신고가 없습니다.</p>
              )}
              {g.reports.map((report) => (
                <div className="row" key={report.index}>
                  <span className="grow">
                    <b>{reportLabel(report)}</b>
                    <em>{reportState(report)}</em>
                  </span>
                  <button disabled={locked} onClick={() => clear(report.index)}>
                    목록에서 지우기
                  </button>
                </div>
              ))}
            </div>
            {!!g.reports.length && (
              <small>
                성립하지 않는 신고는 지우지 않아도 Vault를 닫지 않습니다. 다만
                목록에 남아 있으면 평가할 때마다 다시 읽혀 gas가 듭니다. 신고는
                Vault당 한 건만 보관됩니다. 성립하는 신고는 자리를 지켜 그동안
                다른 대상의 신고를 받지 않고, 소멸했거나 성립하지 않는 신고는
                새로 증명된 신고에 자리를 내줍니다. 등록된 토큰도 등록된 pair가
                그 보유를 사 주지 않는 동안에는, 다른 pair에서 20 USDC 이상에
                팔리는 보유라면 신고됩니다.
              </small>
            )}
          </section>
          <section className="block">
            <h3>알아둘 것</h3>
            <ul className="notes">
              <li>
                새 자산은 <b>거래하기 전에</b> 등록하세요. 등록되지 않은 보유는
                NAV에 보이지 않아, 그 사이의 입금에 지분이 잘못된 가격으로
                발행됩니다.
              </li>
              <li>
                입금과 출금 정산은 창 안의 가장 오래된 가격 기록이 창의 절반(
                {duration(g.priceWindow / 2n)}) 이상 지났을 때만 됩니다. 기록이
                끊기지 않게 그보다 짧은 간격으로 기록하세요. 스위치를 꺼
                두었거나 신고가 성립해 있어도, 관리 액션의 Core 반영 확인을
                기다리는 중에도 가격은 기록됩니다.
              </li>
              <li>
                신고가 성립하는 동안에는 입금과 출금 정산이 모두 닫힙니다. 그
                보유를 매도하면 바로 다시 열립니다. 성립하고 있는 신고의 DEX나
                HyperCore vault를 범위에 등록하면 신고는 목록에서 빠지지만
                그때까지의 가격 기록을 이력으로 세지 않아, 등록 뒤의 기록이 창의
                절반만큼 지난 다음에 열립니다. 신고된 토큰은 세 경우에 그렇게
                됩니다. 등록된 pair가 그 보유를 10 USDC 이상에 사 주거나, 그
                토큰에 차입이 있거나, 신고에 지목된 pair에서 그 보유의 가치가 20
                USDC에 못 미치는 경우입니다. 마지막 경우 그 보유는 등록 뒤에
                평가에 잡히지도 않고 신고할 수도 없습니다. 그 밖에는 등록해도
                신고가 남습니다. 이미 성립하지 않게 된 신고는 등록하면 목록에서
                빠지기만 합니다. 신고는 하루 뒤 소멸합니다.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
