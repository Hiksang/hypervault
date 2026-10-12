import { useEffect, useRef, useState } from "react";
import { zeroAddress, type Abi } from "viem";
import {
  VaultFault,
  address,
  approve,
  chain,
  connected,
  inspect,
  inspectGuards,
  read,
  send,
  vaultAbi,
  type Address,
  type Guards,
  type Standing,
  type State,
} from "../chain";
import {
  demoClaim,
  demoGuards,
  demoRequest,
  demoState,
  demoViewer,
  patchVault,
  type DemoVault,
} from "../demo";
import {
  depositOpen,
  duration,
  format,
  minShares,
  phases,
  sharePrice,
  units,
} from "../domain";
import { Chat } from "../panels/Chat";
import { Manage } from "../panels/Manage";
import { Records } from "../panels/Records";
import { Scope } from "../panels/Scope";
import { Trade, storedKey } from "../panels/Trade";
import { closedText, vaultFailure } from "../reasons";
import { recentSlot, remember } from "../recent";
import { OPERATOR_TABS, TABS, WIDE_TABS, type Tab } from "../route";
import {
  Banner,
  Metric,
  failureText,
  go,
  poll,
  same,
  shellFor,
  short,
  webStore,
  type Loaded,
  type Shell,
  type VaultView,
} from "../ui";

// An upgraded Vault runs code this page does not know. It is never sent a deposit, and the
// wallet is never asked to approve a token for it.
const CODE_CHANGED = "코드가 바뀐 볼트에는 이 화면에서 입금하지 않습니다.";
// How often the page reads the chain, and how long a read counts as current (ms). The default
// node allows an address 100 requests a minute, which the wallet and every other tab share.
const STATE_EVERY = 15_000,
  SCOPE_EVERY = 20_000,
  RECORDS_EVERY = 60_000,
  FRESH = 30_000;
// An approval this large is no amount: it is what wallets call unlimited.
const UNLIMITED = 2n ** 255n;
const approvalText = (amount: bigint) =>
  amount >= UNLIMITED ? "한도 없음" : `${format(amount)} USDC`;
const LABELS: Record<Tab, string> = {
  deposit: "입금",
  withdraw: "출금",
  chat: "대화",
  manage: "운용",
  trade: "거래",
  scope: "평가 범위",
};

export function VaultPage({
  app: shell,
  vault,
  tab,
}: {
  app: Shell;
  vault: Address;
  tab: Tab;
}) {
  // What this page and its panels report belongs to this Vault, wherever the visitor is by then.
  // A Vault whose code changed chooses its own errors: they are not repeated (see `silent`).
  const silent = useRef(false);
  const app = shellFor(shell, vault, (e) => vaultFailure(e, silent.current));
  const { demo, account, busy, factory } = app;
  const [loaded, setLoaded] = useState<State | null>(null),
    [fault, setFault] = useState<Standing | null>(null),
    [failure, setFailure] = useState(""),
    [guardFailure, setGuardFailure] = useState(""),
    [clock, setClock] = useState(Date.now()),
    [amount, setAmount] = useState("100");
  const [guarded, setGuarded] = useState<{
    value: Guards | null;
    readAt: number;
  } | null>(null);
  const sample = demo
    ? app.world.vaults.find((row) => same(row.address, vault))
    : undefined;
  const latest = useRef(sample),
    kept = useRef<State | null>(null),
    // The read now on screen, which the next one builds on, and the last scope read.
    shown = useRef<State | null>(null),
    steady = useRef<Guards | null>(null);
  latest.current = sample;
  const state = demo ? (sample ? demoState(sample, clock) : null) : loaded;
  // A failed read clears what the page shows, but the panels stay mounted on the last good read
  // of this vault for this account, so an opened key, a draft or a half-typed message survives
  // it. `fresh` is false then, and the owner of a Vault never changes.
  const held = state ?? kept.current;
  const viewer = demo ? demoViewer : account;
  const fresh = !!state && (demo || clock - state.readAt < FRESH),
    own = !!held && !!viewer && same(viewer, held.owner);
  // What is known of the Vault without its word, also while its own reads fail.
  const standing: Standing | null = state ?? (demo ? null : fault);
  const changed = !!standing?.codeChanged;
  silent.current = changed;
  // Kept through failed requests, that record is an old one: the page says when it was read.
  const lastRead =
    !state && standing && clock - standing.readAt >= FRESH
      ? standing.readAt
      : null;
  const open =
    !!state &&
    depositOpen(
      state.phase,
      state.capacity,
      state.pending,
      fresh,
      state.codeChanged,
    ) &&
    !state.upgradePending;
  const blockWrite = busy || !app.canWrite;
  const now = BigInt(Math.floor(clock / 1000));
  // The operator panels act on the registered scope and read it often. Every visitor is shown
  // the price records beside a deposit or a withdrawal: a slower read does.
  const working =
    own && (tab === "manage" || tab === "trade" || tab === "scope");
  const guarding = working || tab === "deposit" || tab === "withdraw";
  const guards: Loaded<Guards | null> | undefined = demo
    ? sample && { value: demoGuards(sample, clock), fresh: true }
    : guarded
      ? { value: guarded.value, fresh: clock - guarded.readAt < FRESH }
      : undefined;
  const name = state?.name;
  const status = demo
    ? ""
    : loaded
      ? `EVM BLOCK ${loaded.block} · ${fresh ? "조회 정상" : "조회 만료"}`
      : "CONTRACT NOT CONNECTED";
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  function accept(s: State) {
    // What the Vault's code fixes for the scope read is asked again once that code changes.
    if (kept.current && kept.current.implementation !== s.implementation)
      steady.current = null;
    kept.current = s;
    shown.current = s;
    setLoaded(s);
    setFault(null);
    setFailure("");
  }
  function reject(e: unknown) {
    shown.current = null;
    setLoaded(null);
    // A Vault that does not answer keeps what its controller records, and a request that got
    // no answer takes back nothing of what was last known: the alarm, the notices and the way
    // to cancel an approval stay through an outage.
    setFault((last) =>
      e instanceof VaultFault ? e.standing : (last ?? kept.current),
    );
    setFailure(failureText(e));
  }
  function guard(value: Guards | null) {
    steady.current = value;
    setGuarded({ value, readAt: Date.now() });
    setGuardFailure("");
  }
  useEffect(() => {
    if (demo) return;
    // What was read for another account or Factory is never shown for this one.
    kept.current = null;
    shown.current = null;
    steady.current = null;
    setLoaded(null);
    setFault(null);
    setFailure("");
    if (!factory) return;
    let active = true;
    const stop = poll(async () => {
      const id = app.generation.current;
      const current = () => active && id === app.generation.current;
      try {
        const s = await inspect(
          address(factory),
          vault,
          account,
          shown.current,
        );
        if (current()) accept(s);
      } catch (e) {
        if (current()) reject(e);
      }
    }, STATE_EVERY);
    return () => {
      active = false;
      stop();
    };
  }, [demo, vault, factory, account]);
  useEffect(() => {
    if (demo || !guarding) return;
    let active = true;
    const stop = poll(
      async () => {
        try {
          const value = await inspectGuards(vault, steady.current);
          if (active) guard(value);
        } catch (e) {
          // The last good read stays for the panels to show; it stops being fresh on its own.
          if (active) setGuardFailure(failureText(e));
        }
      },
      working ? SCOPE_EVERY : RECORDS_EVERY,
    );
    return () => {
      active = false;
      stop();
    };
  }, [demo, vault, guarding, working]);
  useEffect(() => {
    const store = webStore("local");
    if (store && name !== undefined)
      remember(store, recentSlot(demo, chain.id), { address: vault, name });
  }, [demo, vault, name]);
  useEffect(() => {
    app.setStatus(status);
    return () => app.setStatus("");
  }, [status]);
  /**
   * Reads the whole Vault and its scope again. It does not throw: a failed re-read is shown as
   * one, and must not hide the confirmation of what was just sent. Returns the Vault if read.
   */
  async function reload(): Promise<State | null> {
    if (demo || !factory) return null;
    const id = app.generation.current;
    const [s, g] = await Promise.allSettled([
      (async () => inspect(address(factory), vault, account))(),
      guarding ? inspectGuards(vault, steady.current) : null,
    ]);
    if (id !== app.generation.current) return null;
    if (s.status === "fulfilled") accept(s.value);
    else reject(s.reason);
    if (guarding)
      if (g.status === "fulfilled") guard(g.value);
      else setGuardFailure(failureText(g.reason));
    return s.status === "fulfilled" ? s.value : null;
  }
  function act(work: () => Promise<void>) {
    return app.run(async () => {
      const id = app.generation.current;
      await work();
      if (id === app.generation.current) await reload();
    });
  }
  async function current() {
    const { p, a } = app.wallet();
    await connected(p, a);
    return await inspect(address(factory), vault, a);
  }
  async function ownerSend(
    fn: string,
    args: readonly unknown[],
    at: Address = vault,
    abi: Abi = vaultAbi,
  ) {
    const { p, a } = app.wallet();
    const s = await current();
    if (!same(s.owner, a)) throw new Error("owner 권한 필요");
    return await send(p, a, at, fn, args, abi);
  }
  function demoApply(change: (row: DemoVault) => DemoVault) {
    if (!latest.current) throw new Error("데모에 없는 볼트입니다.");
    const next = change(latest.current);
    latest.current = next;
    app.setWorld((world) => patchVault(world, vault, () => next));
    return next;
  }
  async function deposit() {
    await act(async () => {
      const n = units(amount);
      if (state?.codeChanged) throw new Error(CODE_CHANGED);
      if (!state || !open || n < state.minimum || n > state.capacity)
        throw new Error("검증된 NAV·최소 입금·한도를 확인하세요.");
      if (demo) {
        const shares = (n * (state.supply + 1000n)) / (state.nav! + 1n);
        demoApply((row) => ({
          ...row,
          state: {
            ...row.state,
            cash: row.state.cash + n,
            nav: row.state.nav! + n,
            shares: row.state.shares + shares,
            supply: row.state.supply + shares,
            basis: row.state.basis + n,
            capacity: row.state.capacity - n,
          },
        }));
        app.demoNotice(`${format(n)} USDC 입금과 지분 발행을 모의했습니다.`);
        return;
      }
      const { p, a } = app.wallet();
      const s = await current();
      // Read again just now: the code may have changed since the page last looked.
      if (s.codeChanged) throw new Error(CODE_CHANGED);
      if (
        !depositOpen(s.phase, s.capacity, s.pending, true, s.codeChanged) ||
        s.upgradePending ||
        n < s.minimum ||
        n > s.capacity
      )
        throw new Error("입금 조건이 변경되었습니다.");
      const quote = await read<bigint>(vault, "previewDeposit", [n]);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const limit = minShares(quote);
      app.say("입금액만큼 USDC 승인 후 입금 서명을 요청합니다.");
      try {
        await approve(p, a, s.asset, vault, n);
        const receipt = await send(p, a, vault, "depositWithLimit", [
          n,
          a,
          limit,
          deadline,
        ]);
        app.say(`입금 확정 · ${receipt.transactionHash}`);
      } catch (e) {
        // The approval can be confirmed while the deposit is not, and it then stays with the
        // Vault. What stands now is read, not assumed.
        const after = await reload();
        const left = after ? after.allowance : null;
        const why = failureText(
          vaultFailure(e, after?.codeChanged ?? silent.current),
        );
        throw new Error(
          left === null
            ? `${why} 입금은 확정되지 않았습니다. 이 볼트에 준 USDC 승인이 남아 있는지는 확인하지 못했습니다. 조회가 돌아오면 이 화면 위쪽에 표시됩니다.`
            : left > 0n
              ? `${why} 입금은 확정되지 않았고, 이 볼트에 준 USDC 승인(${approvalText(left)})은 남아 있습니다. 화면 위쪽의 ‘승인 취소’로 거둘 수 있습니다.`
              : `${why} 입금은 확정되지 않았습니다. 이 볼트에 남은 USDC 승인은 없습니다.`,
        );
      }
    });
  }
  async function cancelApproval() {
    await act(async () => {
      if (demo) {
        demoApply((row) => ({
          ...row,
          state: { ...row.state, allowance: 0n },
        }));
        app.demoNotice("USDC 승인 취소를 모의했습니다.");
        return;
      }
      if (!standing) throw new Error("Vault 조회가 필요합니다.");
      const { p, a } = app.wallet();
      // The Factory's asset, never a token the Vault names: asked of the token, so it works
      // for a Vault that no longer answers.
      const sent = await approve(p, a, standing.asset, vault, 0n);
      app.say(
        sent
          ? "USDC 승인 취소 확정 · 이 볼트는 이 지갑의 USDC를 더 가져갈 수 없습니다."
          : "이 볼트에 남아 있는 USDC 승인이 없습니다.",
      );
    });
  }
  async function redeem(request: boolean) {
    await act(async () => {
      if (!state) throw new Error("Vault 조회가 필요합니다.");
      if (demo) {
        if (request) {
          const n = units(amount, 9);
          if (n > state.shares || state.request !== 0n)
            throw new Error("잔액 또는 미완료 출금 요청을 확인하세요.");
          const next = demoApply((row) => demoRequest(row, n));
          app.demoNotice(
            next.state.claimShares
              ? "출금을 요청했습니다. 현금만 보유한 볼트여서 바로 정산되었고, 아래에서 청구할 수 있습니다."
              : "출금을 요청했습니다. 운용자의 정리·회수와 정산 뒤 청구할 수 있습니다.",
          );
        } else {
          demoApply(demoClaim);
          app.demoNotice("확정 출금액을 청구했습니다.");
        }
        return;
      }
      const { p, a } = app.wallet();
      const s = await current();
      const n = request ? units(amount, 9) : s.claimShares;
      if (request && (n > s.shares || s.request !== 0n))
        throw new Error("잔액 또는 미완료 출금 요청을 확인하세요.");
      if (!request && n === 0n)
        throw new Error("아직 청구 가능한 지분이 없습니다.");
      const receipt = await send(
        p,
        a,
        vault,
        request ? "requestRedeem" : "redeem",
        [n, a, a],
      );
      app.say(
        `${request ? "출금 요청" : "출금 청구"} 확정 · ${receipt.transactionHash}`,
      );
    });
  }
  // Without a wallet nothing was asked for an account: its figures are not shown as zeros.
  const mine = !!account || demo;
  // What the connected wallet left approved for this Vault, as the notices name it.
  const approved = standing?.allowance ?? null;
  const wallet = demo ? "예시 지갑" : "연결한 지갑";
  const view: VaultView | null = held && {
    app,
    vault,
    state: held,
    viewer,
    own,
    fresh,
    clock,
    blockWrite,
    act,
    current,
    ownerSend,
    demoApply,
  };
  // Who the owner is is unknown while the Vault cannot be read. The orders placed with the key
  // in this browser stay within reach then: the trade tab is listed wherever that key is.
  const keyHere = !demo && !!storedKey(vault);
  const tabs = TABS.filter(
    (key) =>
      !OPERATOR_TABS.includes(key) ||
      own ||
      OPERATOR_TABS.includes(tab) ||
      (key === "trade" && keyHere),
  );
  const notice = demo
    ? sample
      ? ""
      : "데모에 없는 볼트입니다. 볼트 탐색에서 예시 볼트를 선택하세요."
    : !factory
      ? // A build that fixed the Factory offers no field: the banner says what is wrong with it.
        app.factoryFixed
        ? ""
        : "Factory 주소를 입력하면 이 Vault를 조회합니다."
      : failure;
  return (
    <>
      <div className="eyebrow">
        MANAGED USDC VAULTS <span>/</span> <a href="#/explore">EXPLORE</a>{" "}
        <span>/</span> VAULT
      </div>
      <div className="title-row">
        <div>
          <h1>{state?.name || "USDC Vault"}</h1>
          <p>한 개의 볼트에서 관리하는 HyperCore 포트폴리오</p>
          {/* A name is the operator's choice and can repeat: the index and the address cannot. */}
          <p className="identity">
            {standing && <b>#{standing.index.toString()}</b>}
            <code className="address">{vault}</code>
          </p>
        </div>
        <div className="badges">
          {own && <span className="tag mine">내 볼트</span>}
          <span className="badge">
            {state ? (phases[state.phase] ?? "알 수 없음") : "연결 대기"}
          </span>
        </div>
      </div>
      <Banner app={app} />
      {notice && (
        <p className="inline-warning" role="alert">
          {notice}
          {lastRead !== null &&
            ` 아래의 볼트 번호와 경고, 승인 기록은 ${new Date(lastRead).toLocaleTimeString("ko-KR")}에 마지막으로 읽은 것입니다.`}
        </p>
      )}
      {changed && (
        <div className="alarm" role="alert">
          <b>이 볼트의 코드가 생성 때와 다릅니다.</b>
          <p>
            Vault는 운용자가 코드를 바꿀 수 있는 프록시입니다. 이 볼트는 처음
            설치된 코드가 아닌 다른 코드로 동작하거나, 그 코드처럼 답하지
            않습니다. 아래의 이름·운용자·NAV·잔액은 모두 볼트가 스스로 답한
            값이어서 믿을 수 없습니다.
          </p>
          <p>
            이 화면은 이 볼트에 입금과 새 USDC 승인을 제공하지 않습니다. 지분을
            가진 사람은 출금 탭에서 출금 요청과 청구를 계속 보낼 수 있지만, 그
            요청을 처리하는 것도 볼트의 현재 코드입니다.
          </p>
          <p>
            {!account && !demo
              ? "전에 이 볼트에 입금을 시도한 지갑에는 USDC 승인이 남아 있을 수 있고, 볼트의 현재 코드는 그 승인으로 서명 없이 USDC를 가져갈 수 있습니다. 지갑을 연결하면 남은 승인을 확인하고 취소할 수 있습니다."
              : approved === null
                ? `${wallet}이 이 볼트에 준 USDC 승인이 남아 있는지 확인하지 못했습니다. 남아 있다면 볼트의 현재 코드가 서명 없이 그만큼 가져갈 수 있습니다.`
                : approved > 0n
                  ? `${wallet}이 전에 준 USDC 승인(${approvalText(approved)})이 이 볼트에 남아 있습니다. 볼트의 현재 코드는 서명을 더 받지 않고 그만큼 가져갈 수 있습니다. 아래에서 바로 취소하세요.`
                  : `${wallet}이 이 볼트에 준 USDC 승인은 남아 있지 않습니다.`}
          </p>
        </div>
      )}
      {standing?.upgradePending && (
        <p className="inline-warning">
          <b>업그레이드가 제안되어 있습니다.</b>{" "}
          {standing.upgradeAt === 0n
            ? "실행할 수 있는 시각은 확인하지 못했습니다."
            : standing.upgradeAt > now
              ? `${new Date(Number(standing.upgradeAt) * 1000).toLocaleString("ko-KR")}부터(${duration(standing.upgradeAt - now)} 뒤) 실행할 수 있습니다.`
              : "지금 실행할 수 있습니다."}{" "}
          {standing.upgradeTo !== zeroAddress && (
            <>
              controller에 기록된 설치될 구현 주소는{" "}
              <code>{standing.upgradeTo}</code>입니다. 이 화면은 그 코드가
              무엇을 하는지 확인하지 않습니다.{" "}
            </>
          )}
          실행되면 이 볼트의 코드가 바뀌고, 그 뒤에는 볼트가 답하는 값을 믿을 수
          없게 됩니다. 제안 중에는 입금이 닫히며, 지분을 가진 사람은 그 전에
          출금을 요청할 수 있습니다.{" "}
          {!account && !demo
            ? "이 볼트에 준 USDC 승인이 남아 있다면 새 코드가 그 승인을 쓸 수 있습니다. 지갑을 연결하면 확인할 수 있습니다."
            : !!approved &&
              `${wallet}의 USDC 승인(${approvalText(approved)})이 이 볼트에 남아 있습니다. 업그레이드가 실행되면 새 코드가 그 승인을 쓸 수 있으므로, 아래에서 먼저 취소하세요.`}
        </p>
      )}
      {!!approved && (
        <div className="inline-warning action approval">
          <span>
            <b>이 볼트에 USDC 승인이 남아 있습니다.</b> {wallet}은 이 볼트가{" "}
            {approved >= UNLIMITED
              ? "한도 없이"
              : `${format(approved)} USDC까지`}{" "}
            가져갈 수 있게 승인해 두었습니다. 이 화면은 입금액만큼만 승인하고
            입금이 그 승인을 다 쓰므로, 남아 있는 승인은 확정되지 않은 입금이
            남긴 것이거나 다른 곳에서 준 것입니다. 승인은 볼트의 코드가 바뀌어도
            그대로 남습니다. 쓰지 않을 승인은 취소하세요.
          </span>
          <button disabled={blockWrite} onClick={cancelApproval}>
            승인 취소
          </button>
        </div>
      )}
      <div className="stats">
        <Metric
          label="주주 순자산 · NAV"
          value={format(state?.nav)}
          unit="USDC"
          sub={
            state?.nav === null
              ? "평가 불가 · 입금 닫힘"
              : demo
                ? "가상 평가 예시"
                : fresh
                  ? "계약의 현재 평가"
                  : "조회 필요"
          }
        />
        <Metric
          label="EVM 운용 가능 현금"
          value={format(state?.cash)}
          unit="USDC"
          sub="확정 출금 준비금 제외"
        />
        <Metric
          label="성과수수료"
          value={state ? format(state.fee, 2, 2) : "—"}
          unit="%"
          sub="수수료의 20%는 플랫폼 몫"
        />
        <Metric
          label="최소 입금"
          value={format(state?.minimum)}
          unit="USDC"
          sub="입금마다 적용"
        />
      </div>
      {state?.nav === null && state.closedBy && (
        <p className="note closed">
          <b>입금이 닫힌 이유</b> {closedText(state.closedBy)}
        </p>
      )}
      <div
        className={"workspace vault" + (WIDE_TABS.includes(tab) ? " wide" : "")}
      >
        {/* The panel a visitor acts in comes first in the document, as it does on screen for a
            wide tab. A browser that keeps the view steady while the page changes anchors on what
            comes first: an anchor below the trade form would move its buttons under the pointer. */}
        <section className="transaction">
          <nav>
            {tabs.map((key) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => go({ page: "vault", vault, tab: key })}
                disabled={busy}
              >
                {LABELS[key]}
              </button>
            ))}
          </nav>
          {tab === "deposit" && (
            <div className="form">
              <h2>USDC 예치</h2>
              <p>HyperEVM의 USDC로 입금합니다.</p>
              <label>
                입금 금액
                <div className="amount-input">
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <b>USDC</b>
                </div>
              </label>
              <div className="detail">
                <span>최소 입금</span>
                <b>{format(state?.minimum)} USDC</b>
              </div>
              <div className="detail">
                <span>발행 시점</span>
                <b>입금 거래 내 즉시</b>
              </div>
              <div className="detail">
                <span>허용 가격 변동</span>
                <b>0.5% · 5분 유효</b>
              </div>
              {!open && (
                <p className="inline-warning">
                  {!state
                    ? "Vault를 조회한 뒤에 입금할 수 있습니다."
                    : changed
                      ? CODE_CHANGED
                      : state.pending
                        ? "Core 관리 액션 확인을 기다리는 중입니다."
                        : state.upgradePending
                          ? "업그레이드 제안 중입니다."
                          : state.closedBy
                            ? "현재 검증된 입금 가격이 없습니다."
                            : !fresh
                              ? "조회가 만료되었습니다. 다시 조회되면 입금할 수 있습니다."
                              : "지금은 받을 수 있는 입금 한도가 없습니다."}
                </p>
              )}
              <button
                className="primary"
                disabled={blockWrite || !open}
                onClick={deposit}
              >
                {busy ? "처리 중…" : "USDC 승인 후 입금"} <span>↗</span>
              </button>
              <small>
                지분은 양도할 수 없습니다. 출금은 요청 후 운용자의 자금
                회수·정산을 거칩니다.
              </small>
              {view && <Records view={view} guards={guards} />}
            </div>
          )}
          {tab === "withdraw" && (
            <div className="form">
              <h2>출금 요청과 청구</h2>
              <p>
                운용 중에는 지분을 요청에 잠그고 정산을 기다립니다. 정산은
                운용자가 포지션을 정리하고 Core의 자금을 회수한 뒤, 가격 기록
                조건이 맞을 때 확정됩니다.
              </p>
              {changed && (
                <p className="inline-warning">
                  코드가 바뀐 볼트입니다. 출금 요청과 청구는 보낼 수 있지만
                  볼트의 현재 코드가 처리하므로, 결과가 이 화면의 표시와 다를 수
                  있습니다.
                </p>
              )}
              <label>
                출금할 지분
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <button
                className="primary"
                disabled={
                  blockWrite ||
                  !fresh ||
                  !state ||
                  state.request !== 0n ||
                  ![2, 3, 4].includes(state.phase)
                }
                onClick={() => redeem(true)}
              >
                출금 요청
              </button>
              <div className="divider" />
              <div className="detail">
                <span>요청 ID</span>
                <b>
                  {!mine || !state
                    ? "—"
                    : state.request
                      ? state.request.toString()
                      : "없음"}
                </b>
              </div>
              <div className="detail">
                <span>청구 가능한 지분</span>
                <b>{mine ? format(state?.claimShares, 9, 4) : "—"}</b>
              </div>
              <div className="detail">
                <span>수수료 차감 후 수령액</span>
                <b>{mine ? format(state?.claimNet) : "—"} USDC</b>
              </div>
              <button
                disabled={blockWrite || !fresh || !state?.claimShares}
                onClick={() => redeem(false)}
              >
                확정된 출금 전액 청구
              </button>
              <small>
                전손의 경우 수령액이 0이어도 확정된 지분을 청구하여 요청을 닫을
                수 있습니다.
              </small>
              {view && <Records view={view} guards={guards} />}
            </div>
          )}
          {tab !== "deposit" &&
            tab !== "withdraw" &&
            (!view ? (
              // Orders are signed by the key in this browser and go to the exchange: with that
              // key here, open orders stay cancellable once a read of the Vault has failed.
              tab === "trade" && !!failure && keyHere ? (
                <Trade
                  app={app}
                  vault={vault}
                  clock={clock}
                  view={null}
                  guards={guards}
                  failure={guardFailure}
                />
              ) : (
                <div className="form">
                  <h2>{LABELS[tab]}</h2>
                  <p>Vault를 조회한 뒤에 사용할 수 있습니다.</p>
                </div>
              )
            ) : tab === "chat" ? (
              <Chat view={view} />
            ) : tab === "manage" ? (
              <Manage view={view} guards={guards} />
            ) : !own ? (
              <div className="form">
                <h2>{LABELS[tab]}</h2>
                <p className="inline-warning">
                  이 Vault의 운용자만 사용할 수 있습니다.
                  {!demo && !account && " 운용자 지갑을 연결하세요."}
                </p>
              </div>
            ) : tab === "trade" ? (
              <Trade
                app={app}
                vault={vault}
                clock={clock}
                view={view}
                guards={guards}
                failure={guardFailure}
              />
            ) : (
              <Scope view={view} guards={guards} failure={guardFailure} />
            ))}
        </section>
        <section className="portfolio">
          <div className="section-head">
            <h2>내 포지션</h2>
            <span>
              {demo
                ? "EXAMPLE"
                : account
                  ? short(account)
                  : "WALLET NOT CONNECTED"}
            </span>
          </div>
          <div className="position">
            <div>
              <small>보유 지분</small>
              <strong>
                {mine ? format(state?.shares, 9, 4) : "—"} <em>mvUSDC</em>
              </strong>
            </div>
            <div>
              <small>잔여 취득 원가</small>
              <strong>
                {mine ? format(state?.basis) : "—"} <em>USDC</em>
              </strong>
            </div>
          </div>
          <div className="detail">
            <span>주주 현금</span>
            <b>{format(state?.cash)} USDC</b>
          </div>
          <div className="detail">
            <span>확정 출금 준비금</span>
            <b>{format(state?.reserved)} USDC</b>
          </div>
          <div className="detail">
            <span>총 지분</span>
            <b>{format(state?.supply, 9, 4)}</b>
          </div>
          <div className="detail">
            <span>지분 1개당 가치</span>
            <b>{format(sharePrice(state?.nav, state?.supply), 6, 4)} USDC</b>
          </div>
          <div className="detail">
            <span>운용자</span>
            <code title={state?.owner}>{short(state?.owner || "")}</code>
          </div>
          <div className="detail">
            <span>Vault API wallet</span>
            <code>
              {state?.agent === zeroAddress
                ? "미등록"
                : short(state?.agent || "")}
            </code>
          </div>
          <div className="valuation">
            <span className="mini-label">VALUATION POLICY</span>
            <h3>입금 직전 NAV로 즉시 발행</h3>
            <p>
              기존 포트폴리오의 순자산으로 지분 가격을 계산합니다. 평가
              불가·관리 액션 처리 중·출금 정산 중에는 입금할 수 없습니다.
            </p>
            <div className="tags">
              <span>Spot</span>
              <span>Perps · HIP-3</span>
              <span>HIP-4</span>
              <span>Borrow / Lend</span>
            </div>
            <small>
              거래 대상 범위입니다. 모든 시장의 생산용 NAV 검증이 완료됐다는
              뜻은 아닙니다.
            </small>
          </div>
        </section>
      </div>
    </>
  );
}
