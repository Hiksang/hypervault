import { useEffect, useRef, useState } from "react";
import { address, chain, listVaults, type VaultSummary } from "../chain";
import { demoSummary, demoViewer } from "../demo";
import { format, phases, sharePrice } from "../domain";
import { closedText } from "../reasons";
import { loadRecent, recentSlot } from "../recent";
import { routeHash } from "../route";
import {
  Banner,
  failureText,
  go,
  same,
  short,
  webStore,
  type Shell,
} from "../ui";

// A row costs about ten requests, and the default node allows an address a hundred a minute:
// ten rows were more than that before the visitor had opened anything. A deployment with its
// own RPC endpoint can show more at a time.
const PAGE = 6;

export function Explore({ app, unknown }: { app: Shell; unknown: boolean }) {
  const { demo, account, factory } = app;
  const [rows, setRows] = useState<VaultSummary[]>([]),
    [total, setTotal] = useState<bigint | null>(null),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState(""),
    [shown, setShown] = useState(PAGE),
    [attempt, setAttempt] = useState(0),
    [asking, setAsking] = useState<string[]>([]);
  const [typed, setTyped] = useState<string>(
    demo ? "" : import.meta.env.VITE_VAULT_ADDRESS || "",
  );
  const [stored] = useState(() => {
    const store = webStore("local");
    return store ? loadRecent(store, recentSlot(demo, chain.id)) : [];
  });
  // Only the latest read of the list may change it: an older one is dropped when it returns.
  const reading = useRef(0);
  // A vault created in an earlier demo is gone after a reload: it is not offered again.
  const recent = stored.filter(
    (row) =>
      !demo ||
      app.world.vaults.some((vault) => same(vault.address, row.address)),
  );
  useEffect(() => {
    if (demo) return;
    setRows([]);
    setTotal(null);
    setFailure("");
    const id = ++reading.current;
    setLoading(!!factory);
    if (!factory) return;
    void (async () => {
      try {
        const page = await listVaults(address(factory), PAGE);
        if (id !== reading.current) return;
        setRows(page.vaults);
        setTotal(page.total);
      } catch (e) {
        if (id === reading.current) setFailure(failureText(e));
      } finally {
        if (id === reading.current) setLoading(false);
      }
    })();
  }, [demo, factory, attempt]);
  async function more() {
    if (demo) {
      setShown(shown + PAGE);
      return;
    }
    const last = rows.at(-1);
    if (!last) return;
    const id = ++reading.current;
    setLoading(true);
    setFailure("");
    try {
      const page = await listVaults(address(factory), PAGE, last.index);
      if (id !== reading.current) return;
      setRows((current) => [
        ...current,
        ...page.vaults.filter(
          (vault) => !current.some((row) => same(row.address, vault.address)),
        ),
      ]);
      setTotal(page.total);
    } catch (e) {
      if (id === reading.current) setFailure(failureText(e));
    } finally {
      if (id === reading.current) setLoading(false);
    }
  }
  /** Reads one row again: the request for it failed, which said nothing about the Vault. */
  async function again(row: VaultSummary) {
    setAsking((list) => [...list, row.address]);
    try {
      const [read] = (await listVaults(address(factory), 1, row.index + 1n))
        .vaults;
      if (read && same(read.address, row.address))
        setRows((current) =>
          current.map((old) => (same(old.address, row.address) ? read : old)),
        );
    } catch (e) {
      app.fail(e, "explore");
    } finally {
      setAsking((list) => list.filter((address) => address !== row.address));
    }
  }
  function open() {
    try {
      const vault = address(typed.trim());
      if (demo && !app.world.vaults.some((row) => same(row.address, vault)))
        throw new Error(
          "데모에 없는 볼트 주소입니다. 아래 예시 볼트를 선택하세요.",
        );
      go({ page: "vault", vault, tab: "deposit" });
    } catch (e) {
      app.fail(e, "explore");
    }
  }
  const samples = demo
    ? [...app.world.vaults].sort((a, b) => Number(b.index - a.index))
    : [];
  const list = demo
    ? samples.slice(0, shown).map((vault) => demoSummary(vault, Date.now()))
    : rows;
  const count = demo ? BigInt(samples.length) : total;
  const viewer = demo ? demoViewer : account;
  const hasMore = demo
    ? shown < samples.length
    : !!rows.length && rows[rows.length - 1].index > 1n;
  // A name is the operator's choice and two vaults can share one: the index and the whole
  // address are what tells them apart.
  const identity = (vault: VaultSummary) => (
    <p className="identity">
      <b>#{vault.index.toString()}</b>
      <code className="address">{vault.address}</code>
    </p>
  );
  // What the controller records stays on a row whatever the vault itself answered.
  const marks = (vault: VaultSummary) =>
    (vault.codeChanged || vault.upgradePending) && (
      <div className="card-owner">
        {vault.codeChanged && <span className="tag changed">코드 변경됨</span>}
        {vault.upgradePending && (
          <span className="tag warn">업그레이드 제안됨</span>
        )}
      </div>
    );
  return (
    <>
      <div className="eyebrow">
        MANAGED USDC VAULTS <span>/</span> EXPLORE
      </div>
      <div className="title-row">
        <div>
          <h1>볼트 탐색</h1>
          <p>
            누구나 만든 볼트를 살펴보고, 운용자와 대화하고, USDC를 예치합니다.
          </p>
        </div>
        <a className="button" href="#/create">
          볼트 만들기 ↗
        </a>
      </div>
      <Banner app={app} />
      {unknown && (
        <p className="inline-warning">
          주소의 페이지를 찾을 수 없어 볼트 탐색을 표시합니다.
        </p>
      )}
      <section className="tools">
        <label>
          주소로 열기
          <div className="inline">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && open()}
              placeholder="Vault 주소 0x…"
              spellCheck={false}
            />
            <button onClick={open}>열기</button>
          </div>
        </label>
        {recent.length > 0 && (
          <div className="recent">
            <small>최근 본 볼트</small>
            <div className="chips">
              {recent.map((row) => (
                <a
                  key={row.address}
                  href={routeHash({
                    page: "vault",
                    vault: row.address,
                    tab: "deposit",
                  })}
                  title={row.address}
                >
                  {row.name || short(row.address)}
                </a>
              ))}
            </div>
          </div>
        )}
      </section>
      <div className="section-head list-head">
        <h2>
          전체 볼트 {count !== null && <em>{`${list.length} / ${count}`}</em>}
        </h2>
        {!demo && !!factory && (
          <button
            className="quiet"
            disabled={loading}
            onClick={() => setAttempt(attempt + 1)}
          >
            새로고침
          </button>
        )}
      </div>
      {failure && (
        <p className="inline-warning" role="alert">
          볼트 목록을 조회하지 못했습니다. {failure}
        </p>
      )}
      {!demo && !factory && !app.factoryFixed && (
        <p className="empty">Factory 주소를 입력하면 볼트 목록을 조회합니다.</p>
      )}
      {!failure && !loading && count === 0n && (
        <p className="empty">
          아직 생성된 볼트가 없습니다. 첫 볼트를 만들어 보세요.
        </p>
      )}
      <div className="cards">
        {list.map((vault) =>
          vault.missed !== null ? (
            // The request failed, not the vault: the row says so and offers to ask again.
            <div key={vault.address} className="card missed">
              <div className="card-head">
                <h3>볼트 #{vault.index.toString()}</h3>
                <span className="badge">조회 전</span>
              </div>
              {identity(vault)}
              {marks(vault)}
              <small>
                이 볼트의 정보를 노드에서 받지 못했습니다. 요청이 실패한 것이며
                볼트의 상태를 뜻하지 않습니다. {vault.missed}
              </small>
              <div className="pair">
                <button
                  disabled={asking.includes(vault.address)}
                  onClick={() => void again(vault)}
                >
                  {asking.includes(vault.address) ? "조회 중…" : "다시 조회"}
                </button>
                <a
                  className="button quiet"
                  href={routeHash({
                    page: "vault",
                    vault: vault.address,
                    tab: "deposit",
                  })}
                >
                  볼트 페이지 열기
                </a>
              </div>
            </div>
          ) : vault.unreadable !== null ? (
            // One vault that answers nothing, or nonsense, is listed as that and no more.
            <a
              key={vault.address}
              className="card"
              href={routeHash({
                page: "vault",
                vault: vault.address,
                tab: "deposit",
              })}
            >
              <div className="card-head">
                <h3>읽을 수 없는 볼트</h3>
                <span className="badge">#{vault.index.toString()}</span>
              </div>
              {identity(vault)}
              {marks(vault)}
              <span className="tag warn">볼트가 답하지 않음</span>
              <small>{vault.unreadable}</small>
              <small>
                이 볼트는 답하지 않거나 이해할 수 없는 값을 답했습니다. 수치는
                표시하지 않습니다.
              </small>
            </a>
          ) : (
            <a
              key={vault.address}
              className="card"
              href={routeHash({
                page: "vault",
                vault: vault.address,
                tab: "deposit",
              })}
            >
              <div className="card-head">
                <h3>{vault.name}</h3>
                <span className="badge">
                  {phases[vault.phase] ?? "알 수 없음"}
                </span>
              </div>
              {identity(vault)}
              <div className="card-owner">
                운용자 <code title={vault.owner}>{short(vault.owner)}</code>
                {!!viewer && same(viewer, vault.owner) && (
                  <span className="tag mine">내 볼트</span>
                )}
                {vault.codeChanged && (
                  <span className="tag changed">코드 변경됨</span>
                )}
                {vault.upgradePending && (
                  <span className="tag warn">업그레이드 제안됨</span>
                )}
              </div>
              <small>주주 순자산 · NAV</small>
              <strong>
                {format(vault.nav)} <em>USDC</em>
              </strong>
              <div className="detail">
                <span>지분 1개당 가치</span>
                <b>{format(sharePrice(vault.nav, vault.supply), 6, 4)} USDC</b>
              </div>
              <div className="detail">
                <span>성과수수료</span>
                <b>{format(vault.fee, 2, 2)}%</b>
              </div>
              <div className="detail">
                <span>최소 입금</span>
                <b>{format(vault.minimum)} USDC</b>
              </div>
              {vault.codeChanged && (
                <small>
                  생성 때와 다른 코드로 동작합니다. 위의 값은 볼트가 스스로 답한
                  것이어서 믿을 수 없고, 이 화면은 입금을 제공하지 않습니다.
                </small>
              )}
              {vault.upgradePending && (
                <small>
                  코드를 바꾸는 업그레이드가 제안되어 있습니다. 제안 중에는
                  입금이 닫힙니다.
                </small>
              )}
              {!vault.depositsPriced && (
                <>
                  <span className="tag warn">
                    현재 입금이 닫혀 있습니다
                    {vault.nav === null ? " · 평가 불가" : ""}
                  </span>
                  {vault.closedBy && (
                    <small>{closedText(vault.closedBy)}</small>
                  )}
                </>
              )}
            </a>
          ),
        )}
      </div>
      {loading && <p className="empty">볼트 목록을 불러오는 중…</p>}
      {hasMore && (
        <button className="more" disabled={loading} onClick={more}>
          더 보기
        </button>
      )}
    </>
  );
}
