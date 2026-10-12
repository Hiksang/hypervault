import { useEffect, useRef, useState } from "react";
import { zeroAddress, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, read, send, type Address, type Guards } from "../chain";
import {
  demoAgent,
  demoExchange,
  demoMids,
  demoSubmit,
  demoSync,
} from "../demo";
import { duration, uint } from "../domain";
import {
  MIN_PASSPHRASE,
  loadAgent,
  newAgent,
  nextNonce,
  open,
  readAgent,
  removeAgent,
  saveAgent,
  seal,
  type SealedAgent,
} from "../hyperliquid/agentKey";
import { exchange } from "../hyperliquid/exchange";
import {
  agentActive,
  fetchAccount,
  fetchAgents,
  fetchMaxBuilderFee,
  fetchMids,
  type Account,
  type Market,
  type OpenOrder,
} from "../hyperliquid/info";
import type { Builder, OrderResult } from "../hyperliquid/orders";
import { routeHash } from "../route";
import { dexName } from "../scope";
import {
  CONFIRM_TTL_MS,
  KEY_IDLE_MS,
  ORDER_STATE_LABEL,
  ORDER_TYPES,
  accountDexes,
  accountInterval,
  agentStatus,
  buildOrder,
  builderFor,
  cancelFor,
  confirmClick,
  feeText,
  idleLockIn,
  keyActivity,
  offered,
  orderBlock,
  orderState,
  resultText,
  type Action,
  type AgentStatus,
  type Order,
  type OrderType,
  type Ticket,
} from "../trade";
import {
  Detail,
  failureText,
  poll,
  same,
  short,
  type Loaded,
  type Shell,
  type VaultView,
} from "../ui";
import { useMarkets } from "./markets";

const tradingEnabled = import.meta.env.VITE_ENABLE_TRADING === "true";
const feeSetting: string | undefined = import.meta.env
  .VITE_BUILDER_FEE_TENTHS_BPS;
// ManagedUsdcVault.ActionKind.Agent
const KIND_AGENT = 3;
const LISTED = 40;
const NEEDS_VAULT = "Vault를 조회한 뒤에 사용할 수 있습니다.";
const RANK = { any: 0, reduce: 1, none: 2 };
const STATUS: Record<AgentStatus, string> = {
  none: "키 없음",
  unsent: "등록 전",
  pending: "Core 반영 대기",
  retired: "사용할 수 없는 키",
  unconfirmed: "거래소 확인 대기",
  locked: "잠김",
  ready: "사용 가능",
};
type Outcome = {
  title: string;
  results?: OrderResult[];
  /** The size each order asked for, to tell a partial fill from a full one. */
  sizes?: string[];
  preview?: string;
  unknown?: string;
};

/** The key this browser holds for a Vault, sealed. */
export function storedKey(vault: Address): SealedAgent | null {
  try {
    return loadAgent(localStorage, chain.id, vault);
  } catch {
    return null;
  }
}
function damagedKey(vault: Address): boolean {
  try {
    return readAgent(localStorage, chain.id, vault).damaged;
  } catch {
    return false;
  }
}

/**
 * `view` is null while the Vault cannot be read. Orders are signed by the key in this browser
 * and go to the exchange, so the key, the account and its open orders are drawn all the same:
 * what cannot be offered then is whatever needs the Vault or the wallet.
 */
export function Trade({
  app,
  vault,
  clock,
  view,
  guards,
  failure,
}: {
  app: Shell;
  vault: Address;
  clock: number;
  view: VaultView | null;
  guards: Loaded<Guards | null> | undefined;
  failure: string;
}) {
  const state = view?.state ?? null,
    fresh = !!view?.fresh,
    blockWrite = view?.blockWrite ?? true;
  const { demo, account, busy } = app;
  const act = (work: () => Promise<void>) =>
    view
      ? view.act(work)
      : app.run(async () => {
          throw new Error(NEEDS_VAULT);
        });
  /** The Vault's side of the panel, for what cannot be done without it. */
  const onChain = () => {
    if (!view) throw new Error(NEEDS_VAULT);
    return view;
  };
  const { base, meta, failure: metaFailure, retry } = useMarkets(demo);
  const sample = demo
    ? app.world.vaults.find((row) => same(row.address, vault))
    : undefined;
  // Undefined while the scope is not known: only a verifier that really keeps none gives null.
  const scope = guards ? (guards.value?.scope ?? null) : undefined;
  const markets = meta?.markets ?? [],
    dexes = meta?.dexes ?? [];

  const [sealed, setSealed] = useState(() => (demo ? null : storedKey(vault))),
    [damaged, setDamaged] = useState(() => !demo && damagedKey(vault)),
    [listed, setListed] = useState<boolean | null>(null),
    [unlocked, setUnlocked] = useState(false),
    [discarding, setDiscarding] = useState(false),
    [keyFailure, setKeyFailure] = useState("");
  const [recorded, setRecorded] = useState<{
    pendingAgent: Address | null;
    used: boolean;
  } | null>(null);
  const signer = useRef<LocalAccount | null>(null),
    first = useRef<HTMLInputElement>(null),
    second = useRef<HTMLInputElement>(null),
    pass = useRef<HTMLInputElement>(null);
  const key = demo ? (sample?.key ?? null) : (sealed?.address ?? null);
  const matched = !!key && !!state && same(key, state.agent);
  // Until the Vault has been asked about a key it does not name, nothing is offered for it.
  const checking = !demo && !!key && !!state && !matched && !recorded;
  const status = agentStatus({
    stored: key,
    apiWallet: state ? state.agent : null,
    pendingAgent: demo
      ? sample?.pending?.kind === "agent"
        ? sample.pending.agent
        : null
      : (recorded?.pendingAgent ?? null),
    used: demo
      ? !!key && !!sample?.usedAgents.some((row) => same(row, key))
      : !!recorded?.used,
    active: demo ? true : listed,
    unlocked: demo ? !!sample?.unlocked : unlocked,
  });

  const [query, setQuery] = useState(""),
    [picked, setPicked] = useState(""),
    [mids, setMids] = useState<Record<string, string>>(demo ? demoMids : {}),
    [problem, setProblem] = useState(""),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [rate, setRate] = useState(""),
    [approvedFee, setApprovedFee] = useState<number | null>(null),
    [loadedAccount, setLoadedAccount] = useState<Account | null>(null),
    [accountFailure, setAccountFailure] = useState(""),
    [accountAt, setAccountAt] = useState(0),
    [tick, setTick] = useState(0);
  const [ticket, setTicket] = useState<Ticket>({
    isBuy: true,
    type: "limit",
    price: "",
    size: "",
    slippage: "1",
    reduceOnly: false,
  });
  const [confirm, setConfirm] = useState<{
    order: Order;
    market: Market;
    reduceOnly: boolean;
    at: number;
    agreed: boolean;
  } | null>(null);
  // Each edit and each review makes every earlier review stale: one that returns late is dropped.
  const reviews = useRef(0);
  const [reviewing, setReviewing] = useState(false);
  // When the operator last did something with the key or the ticket: an opened key that sees
  // no such activity for KEY_IDLE_MS is locked again.
  const [active, setActive] = useState(() => Date.now());
  const [fallback, setFallback] = useState<{
    builder: Address;
    cap: bigint;
  } | null>(null);
  const market = markets.find((row) => row.key === picked);
  const dexOf = (row: Market) =>
    row.kind === "perp"
      ? (dexes.find((dex) => dex.index === row.dex)?.name ?? "")
      : "";
  const builder = guards?.value?.builder ?? fallback?.builder ?? null;
  const cap = guards?.value?.builderFeeCap ?? fallback?.cap ?? null;
  const hasBuilder = !!builder && !same(builder, zeroAddress);
  const approved = demo ? (sample?.approvedFee ?? 0) : approvedFee;
  let attach: Builder | undefined,
    feeProblem = "";
  try {
    attach = builderFor(builder, feeSetting, approved ?? 0);
  } catch (e) {
    feeProblem = failureText(e);
  }
  // The account is shown whatever is known of the scope: every DEX while it is not.
  const watched = accountDexes(dexes, scope);
  const watching = watched.map((dex) => dex.index).join(",");
  const every = accountInterval(watched.length);
  const shownAccount = demo ? (sample?.account ?? null) : loadedAccount;
  // A demo order or a real one needs the key open; a preview signs nothing.
  const keyNeeded = demo || tradingEnabled;
  // Enough for a cancel and for an order that only reduces. Only an order that can open or add
  // exposure also waits for a recent read of the scope (`orderBlock`).
  const keyOpen = !busy && (!keyNeeded || status === "ready");
  const scopeFresh = demo || !!guards?.fresh;
  const opened = demo ? !!sample?.unlocked : unlocked;
  const idle = `${KEY_IDLE_MS / 60_000}분`;
  // The page clock ticks once a second and can be behind the last activity: for the countdown
  // shown, that is no time passed. The lock itself goes by the real clock.
  const lockIn = idleLockIn(active, Math.max(active, clock));
  function expire() {
    lock();
    app.say(`${idle} 동안 거래가 없어 서명 키를 다시 잠갔습니다.`);
  }
  // Counts as activity, unless the key's time has already run out: the timer that locks it
  // can be held up, and what the operator does next is then not what keeps the key open.
  // False when it locked the key instead.
  function touch(): boolean {
    const now = Date.now();
    if (keyActivity(opened, active, now) === "lock") {
      expire();
      return false;
    }
    setActive(now);
    return true;
  }

  useEffect(
    () => () => {
      signer.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!opened) return;
    // A background tab runs this late, and a sleeping machine stops its count. The key is not
    // used late: the page's clock, every activity and sending each check the time themselves.
    const timer = setTimeout(expire, idleLockIn(active, Date.now()));
    return () => clearTimeout(timer);
  }, [opened, active]);
  // The page's clock is read from the wall clock every second, unlike that timer's count.
  const ranOut = opened && lockIn === 0;
  useEffect(() => {
    if (ranOut) expire();
  }, [ranOut]);
  useEffect(() => {
    signer.current = null;
    setUnlocked(false);
  }, [account]);
  useEffect(() => {
    setRecorded(null);
    setKeyFailure("");
    if (demo || !sealed || matched || !state) return;
    let alive = true;
    Promise.all([
      read<readonly [bigint, Hex, bigint, number, bigint, Address]>(
        vault,
        "pendingAction",
      ),
      read<boolean>(vault, "usedAgents", [sealed.address]),
    ]).then(
      ([pending, used]) =>
        alive &&
        setRecorded({
          pendingAgent:
            pending[0] !== 0n && pending[3] === KIND_AGENT ? pending[5] : null,
          used,
        }),
      (e) => alive && setKeyFailure(failureText(e)),
    );
    return () => {
      alive = false;
    };
  }, [demo, vault, sealed, matched, !state, state?.pending]);
  useEffect(() => setListed(null), [base, vault, sealed]);
  useEffect(() => {
    // Without the Vault's word, the exchange's list is all that says whether the key can sign.
    // What it said of this key stays while the Vault's read comes and goes.
    if (!base || !sealed || (state && !matched)) return;
    let alive = true,
      done = false;
    const check = async () => {
      try {
        const agents = await fetchAgents(base, vault);
        if (!alive) return;
        done = agentActive(agents, sealed.address, Date.now());
        setListed(done);
      } catch {
        if (alive) setListed(null);
      }
    };
    void check();
    // Core applies a registration a moment after the Vault confirms it: look again until listed.
    const timer = setInterval(
      () => !done && !document.hidden && void check(),
      10000,
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, vault, sealed, matched, !state]);
  useEffect(() => {
    if (demo || !guards || guards.value) return;
    let alive = true;
    Promise.all([
      read<Address>(vault, "builder"),
      read<bigint>(vault, "builderFeeCap"),
    ]).then(
      ([address, limit]) =>
        alive && setFallback({ builder: address, cap: limit }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [demo, vault, !guards, !guards?.value]);
  useEffect(() => {
    if (!base || !builder || !hasBuilder) return;
    let alive = true;
    fetchMaxBuilderFee(base, vault, builder).then(
      (value) => alive && setApprovedFee(value),
      () => alive && setApprovedFee(null),
    );
    return () => {
      alive = false;
    };
    // Read again once a pending action is confirmed: it may have been the approval.
  }, [base, vault, builder, hasBuilder, state?.pending]);
  useEffect(() => {
    if (!base || !market) return;
    let alive = true;
    const stop = poll(
      () =>
        fetchMids(base, dexOf(market)).then(
          (value) => void (alive && setMids(value)),
          () => undefined,
        ),
      10000,
    );
    return () => {
      alive = false;
      stop();
    };
  }, [base, market?.key]);
  useEffect(() => {
    if (!base || !meta) return;
    let alive = true;
    const stop = poll(async () => {
      try {
        const value = await fetchAccount(base, vault, watched);
        if (!alive) return;
        setLoadedAccount(value);
        setAccountAt(Date.now());
        setAccountFailure("");
      } catch (e) {
        if (alive) setAccountFailure(failureText(e));
      }
    }, every);
    return () => {
      alive = false;
      stop();
    };
  }, [base, vault, meta, watching, tick]);

  function clearInputs() {
    for (const input of [first, second, pass])
      if (input.current) input.current.value = "";
  }
  async function createKey() {
    // Read from the fields and never kept in state: the passphrase lives for this call only.
    const passphrase = first.current?.value ?? "";
    const again = second.current?.value ?? "";
    await act(async () => {
      if (passphrase.length < MIN_PASSPHRASE)
        throw new Error(`암호는 ${MIN_PASSPHRASE}자 이상이어야 합니다.`);
      if (passphrase !== again) throw new Error("두 암호가 서로 다릅니다.");
      if (demo) {
        onChain().demoApply((row) => {
          const agent = demoAgent(row);
          return {
            ...demoSubmit(row, { kind: "agent", agent }),
            key: agent,
            unlocked: false,
          };
        });
        app.demoNotice(
          "서명 키 생성과 등록 요청을 모의했습니다. 키는 만들지도 저장하지도 않았습니다.",
        );
        return;
      }
      // Everything that could refuse the registration is checked before a key exists.
      if (!app.canWrite) throw new Error("현재 읽기 전용 설정입니다.");
      const { p, a } = app.wallet();
      const s = await onChain().current();
      if (!same(s.owner, a)) throw new Error("owner 권한 필요");
      if (s.pending !== 0n)
        throw new Error(
          "확인을 기다리는 관리 액션이 있습니다. 먼저 Core 반영을 확인하세요.",
        );
      // Another tab may have stored a key since this one looked: it is never overwritten, and
      // neither is a record that cannot be read as one.
      const there = readAgent(localStorage, chain.id, vault);
      if (there.sealed || there.damaged)
        throw new Error(
          "이 브라우저에 이미 이 Vault의 서명 키 기록이 있습니다. 페이지를 새로 고치세요.",
        );
      const agent = newAgent();
      const record = await seal(agent.privateKey, passphrase);
      saveAgent(localStorage, chain.id, vault, record);
      setSealed(record);
      app.say(
        "서명 키를 암호화해 이 브라우저에 저장했습니다. Vault에 등록하는 거래에 서명하세요.",
      );
      const receipt = await send(p, a, vault, "setApiWallet", [agent.address]);
      app.say(
        `등록 요청 확정 · ${receipt.transactionHash} · 다음 블록부터 Core 반영을 확인할 수 있습니다.`,
      );
    });
    clearInputs();
  }
  async function register() {
    await act(async () => {
      if (!sealed) throw new Error("이 브라우저에 서명 키가 없습니다.");
      const receipt = await onChain().ownerSend("setApiWallet", [
        sealed.address,
      ]);
      app.say(
        `등록 요청 확정 · ${receipt.transactionHash} · 다음 블록부터 Core 반영을 확인할 수 있습니다.`,
      );
    });
  }
  async function sync() {
    await act(async () => {
      if (demo) {
        onChain().demoApply(demoSync);
        app.demoNotice("Core 반영 확인을 모의했습니다.");
        return;
      }
      const { p, a } = app.wallet();
      const s = await onChain().current();
      if (s.pending === 0n) throw new Error("확인할 관리 액션이 없습니다.");
      const receipt = await send(
        p,
        a,
        vault,
        s.phase === 1 ? "finalizeActivation" : "syncCoreAction",
        s.phase === 1 ? ["0x"] : [s.pending, "0x"],
      );
      app.say(`Core 반영 확인 확정 · ${receipt.transactionHash}`);
    });
  }
  async function unlock() {
    const passphrase = pass.current?.value ?? "";
    await app.run(async () => {
      if (!passphrase) throw new Error("암호를 입력하세요.");
      touch();
      if (demo) {
        onChain().demoApply((row) => ({ ...row, unlocked: true }));
        app.demoNotice(
          "서명 키 잠금 해제를 모의했습니다. 암호는 확인하지 않습니다.",
        );
        return;
      }
      if (!sealed) throw new Error("이 브라우저에 서명 키가 없습니다.");
      signer.current = privateKeyToAccount(await open(sealed, passphrase));
      setUnlocked(true);
      app.say(
        `서명 키를 열었습니다. 이 화면을 벗어나거나 ${idle} 동안 거래가 없으면 다시 잠깁니다.`,
      );
    });
    clearInputs();
  }
  function lock() {
    signer.current = null;
    setUnlocked(false);
    if (demo) view?.demoApply((row) => ({ ...row, unlocked: false }));
  }
  function discard() {
    setDiscarding(false);
    try {
      if (demo) {
        onChain().demoApply((row) => ({ ...row, key: null, unlocked: false }));
        app.demoNotice("예시 서명 키를 지웠습니다.");
        return;
      }
      removeAgent(localStorage, chain.id, vault);
      lock();
      setSealed(null);
      setDamaged(false);
      app.say(
        "이 브라우저에서 서명 키를 지웠습니다. Vault에 등록이 남아 있으면 해지하세요.",
      );
    } catch (e) {
      app.fail(e);
    }
  }
  async function revoke() {
    await act(async () => {
      if (demo) {
        onChain().demoApply((row) => demoSubmit(row, { kind: "revoke" }));
        app.demoNotice("API wallet 등록 해지 요청을 모의했습니다.");
        return;
      }
      const receipt = await onChain().ownerSend("revokeApiWallet", []);
      app.say(
        `등록 해지 요청 확정 · ${receipt.transactionHash} · Core 반영 확인이 필요합니다.`,
      );
    });
  }
  async function approveFee() {
    await act(async () => {
      const value = BigInt(uint(rate, 64));
      if (cap === null || value > cap)
        throw new Error(
          `승인 요율은 이 Vault의 상한 ${cap ?? "—"}(0.1bp 단위) 이하여야 합니다.`,
        );
      if (demo) {
        onChain().demoApply((row) =>
          demoSubmit(row, { kind: "builderFee", rate: Number(value) }),
        );
        app.demoNotice(
          "builder fee 승인 요청을 모의했습니다. Core 반영 확인 뒤에 적용됩니다.",
        );
        return;
      }
      const receipt = await onChain().ownerSend("approveBuilderFee", [value]);
      app.say(
        `builder fee 승인 요청 확정 · ${receipt.transactionHash} · Core 반영 확인이 필요합니다.`,
      );
    });
  }
  function edit(change: Partial<Ticket>) {
    reviews.current++;
    touch();
    setTicket({ ...ticket, ...change });
    setConfirm(null);
    setReviewing(false);
    setProblem("");
  }
  async function review() {
    const id = ++reviews.current;
    setOutcome(null);
    setConfirm(null);
    if (!touch()) return;
    setReviewing(true);
    try {
      if (!market) throw new Error("시장을 고르세요.");
      // The scope may have changed since the market was picked.
      const block = orderBlock(market, ticket.reduceOnly, scope, scopeFresh);
      if (block) throw new Error(block);
      if (feeProblem) throw new Error(feeProblem);
      let mid: string | undefined = mids[market.coin];
      if (ticket.type !== "post" && base) {
        // An immediate order is bounded from the price now, and a limit is measured against
        // it: not from the last refresh.
        try {
          const now = await fetchMids(base, dexOf(market));
          if (id === reviews.current) setMids(now);
          mid = now[market.coin];
        } catch (e) {
          // Without a price an immediate order has no bound. A limit can still be sent, but
          // how far it lies from the market is then unknown, and the operator is told so.
          if (ticket.type === "market") throw e;
          mid = undefined;
        }
      }
      // The form was edited, or reviewed again, while this review waited: its answer is for a
      // ticket the form no longer shows.
      if (id !== reviews.current) return;
      setConfirm({
        order: buildOrder(market, ticket, mid, attach),
        market,
        reduceOnly: market.kind === "perp" && ticket.reduceOnly,
        at: Date.now(),
        agreed: false,
      });
      setProblem("");
    } catch (e) {
      if (id !== reviews.current) return;
      setConfirm(null);
      setProblem(failureText(e));
    } finally {
      if (id === reviews.current) setReviewing(false);
    }
  }
  async function submit(action: Action, title: string) {
    const sizes =
      "orders" in action ? action.orders.map((order) => order.s) : [];
    await app.run(async () => {
      setConfirm(null);
      // The timer that locks an idle key can run late in a background tab: the key is not used
      // past its time whether or not it has run.
      if (keyNeeded && keyActivity(opened, active, Date.now()) === "lock") {
        lock();
        throw new Error(
          `${idle} 동안 거래가 없어 서명 키를 잠갔습니다. 다시 연 뒤에 전송하세요.`,
        );
      }
      touch();
      if (demo) {
        let results: OrderResult[] = [];
        onChain().demoApply((row) => {
          const done = demoExchange(row, action, Date.now());
          results = done.results;
          return done.vault;
        });
        setOutcome({ title, results, sizes });
        app.demoNotice("요청을 예시 계정에만 반영했습니다.");
        return;
      }
      if (!tradingEnabled) {
        setOutcome({ title, preview: JSON.stringify(action, null, 2) });
        app.say(
          "이 빌드는 주문을 전송하지 않습니다. 서명도 전송도 하지 않은 미리보기를 표시합니다.",
        );
        return;
      }
      const agent = signer.current;
      if (!base || !agent || status !== "ready")
        throw new Error("서명 키를 연 뒤에 전송할 수 있습니다.");
      const nonce = nextNonce(localStorage, agent.address);
      let left = false;
      const fetcher: typeof fetch = (...args) => {
        left = true;
        return fetch(...args);
      };
      try {
        setOutcome({
          title,
          sizes,
          results: await exchange(
            base,
            agent,
            action,
            nonce,
            chain.id === 999,
            fetcher,
          ),
        });
      } catch (e) {
        // An error before the request left is an ordinary one. After that the exchange may
        // have acted on it: the outcome is unknown and nothing is sent again.
        if (!left) throw e;
        setOutcome({ title, unknown: failureText(e) });
      }
      setTick((n) => n + 1);
    });
  }
  function cancel(order: OpenOrder) {
    try {
      void submit(cancelFor(markets, order), `주문 #${order.oid} 취소`);
    } catch (e) {
      app.fail(e);
    }
  }
  function sendConfirmed() {
    if (!confirm) return;
    // The button is disabled where it can be; these are the rules themselves. A click that
    // comes right after the confirmation appeared was not aimed at it.
    const click = confirmClick(confirm.at, Date.now());
    if (click === "early") return;
    if (click === "expired") {
      setConfirm(null);
      setProblem(
        `확인한 지 ${CONFIRM_TTL_MS / 1000}초가 지났습니다. 다시 확인하세요.`,
      );
      return;
    }
    if (confirm.order.consent && !confirm.agreed) {
      setProblem(
        "지정가와 현재가의 차이를 확인하고 동의한 뒤에 전송할 수 있습니다.",
      );
      return;
    }
    const block = orderBlock(
      confirm.market,
      confirm.reduceOnly,
      scope,
      scopeFresh,
    );
    if (block) {
      setProblem(block);
      return;
    }
    void submit(confirm.order.action, confirm.order.summary);
  }

  if (!demo && !base)
    return (
      <div className="form">
        <h2>거래</h2>
        <p className="inline-warning">
          이 체인에서는 HyperCore 거래를 사용할 수 없습니다. {chain.name}에는
          Hyperliquid API가 없습니다.
        </p>
      </div>
    );
  const term = query.trim().toLowerCase();
  const offer = (row: Market) => offered(row, scope, scopeFresh);
  const found = markets
    .filter((row) => !term || row.label.toLowerCase().includes(term))
    .sort((a, b) => RANK[offer(a).orders] - RANK[offer(b).orders]);
  const coinLabel = (coin: string) =>
    markets.find((row) => row.coin === coin)?.label ?? coin;
  const outside = (inside: boolean) =>
    scope && !inside ? <span className="tag warn">범위 밖</span> : null;
  const tone = (value: string) =>
    value.startsWith("-") ? "bad" : Number(value) ? "good" : "";
  const live = !!confirm && confirmClick(confirm.at, clock) !== "expired";
  // Why the confirmed order cannot be sent right now, if it cannot.
  const held =
    confirm && live
      ? orderBlock(confirm.market, confirm.reduceOnly, scope, scopeFresh)
      : "";
  // Two missed refreshes: what is listed may no longer be what the account holds.
  const outdated = !demo && !!loadedAccount && clock - accountAt > 2 * every;
  return (
    <div className="form trade">
      <h2>거래</h2>
      <p>
        Vault의 HyperCore 계정으로 주문합니다. 주문에는 이 브라우저의 서명 키가
        서명하고, 지갑은 키 등록과 승인에만 씁니다.
      </p>
      {!demo && !tradingEnabled && (
        <p className="note">
          이 빌드는 주문을 전송하지 않습니다(VITE_ENABLE_TRADING). 주문과 취소는
          서명하지 않은 미리보기로만 표시됩니다.
        </p>
      )}
      {!state && (
        <p className="inline-warning">
          Vault를 조회하지 못한 상태입니다. 이 브라우저의 서명 키로 미체결
          주문을 취소하고 포지션을 줄이는 reduce-only 주문을 보낼 수 있습니다.
          키 등록·해지와 Core 반영 확인처럼 Vault와 지갑이 필요한 기능은 조회가
          돌아온 뒤에 쓸 수 있습니다.
        </p>
      )}
      {!!state && state.pending !== 0n && (
        <div className="inline-warning action">
          <span>
            Core 관리 액션 #{state.pending.toString()}의 확인을 기다립니다. 확인
            전에는 입금이 닫히고 다른 관리 액션을 보낼 수 없습니다.
          </span>
          <button disabled={blockWrite || !fresh} onClick={sync}>
            Core 반영 확인
          </button>
        </div>
      )}
      <section className="block">
        <div className="block-head">
          <h3>주문 서명 키</h3>
          <span
            className={
              "tag " +
              (status === "ready" ? "ok" : status === "none" ? "" : "warn")
            }
          >
            {checking ? "확인 중" : STATUS[status]}
          </span>
        </div>
        <div className="key">
          <ul className="notes">
            <li>
              이 키는 Vault의 자금으로 거래할 수 있지만 출금할 수는 없습니다.
            </li>
            <li>
              이 브라우저에만, 암호로 암호화해 저장합니다. 서버나 다른 기기로
              보내지 않습니다.
            </li>
            <li>
              키나 암호를 잃으면 되찾을 수 없습니다. 새 키를 만들어 다시
              등록하세요.
            </li>
            <li>
              한 번 등록에 쓴 agent 주소는 같은 Vault에 다시 등록할 수 없습니다.
            </li>
          </ul>
          <div>
            {key && (
              <>
                <Detail label="이 브라우저의 키">
                  <code title={key}>{short(key)}</code>
                </Detail>
                <Detail label="Vault의 API wallet">
                  <code title={state?.agent}>
                    {!state
                      ? "조회 안 됨"
                      : state.agent === zeroAddress
                        ? "미등록"
                        : short(state.agent)}
                  </code>
                </Detail>
              </>
            )}
            {damaged ? (
              <div className="inline-warning action">
                <span>
                  이 브라우저에 저장된 이 Vault의 서명 키 기록이 손상되었습니다.
                  길이나 형식이 맞지 않아, 암호가 맞아도 열 수 없습니다. 기록을
                  지운 뒤 새 키를 만들어 등록하세요.
                </span>
                <button onClick={discard}>손상된 기록 지우기</button>
              </div>
            ) : checking ? (
              <p className={keyFailure ? "inline-warning" : "note"}>
                {keyFailure
                  ? `Vault에서 이 키의 등록 상태를 확인하지 못했습니다. ${keyFailure}`
                  : "Vault에서 이 키의 등록 상태를 확인하는 중…"}
              </p>
            ) : status === "none" ? (
              !state ? (
                <p className="note">{NEEDS_VAULT}</p>
              ) : (
                <>
                  {state.agent !== zeroAddress && (
                    <div className="inline-warning action">
                      <span>
                        Vault에는 API wallet {short(state.agent)}가 등록되어
                        있지만 그 키는 이 브라우저에 없습니다. 새 키를 등록하면
                        교체됩니다. 더 쓰지 않는 키라면 등록을 해지하세요.
                      </span>
                      <button
                        disabled={blockWrite || !fresh || state.pending !== 0n}
                        onClick={revoke}
                      >
                        등록 해지
                      </button>
                    </div>
                  )}
                  <div className="two">
                    <label>
                      새 암호 ({MIN_PASSPHRASE}자 이상)
                      <input
                        type="password"
                        ref={first}
                        autoComplete="new-password"
                      />
                    </label>
                    <label>
                      암호 확인
                      <input
                        type="password"
                        ref={second}
                        autoComplete="new-password"
                      />
                    </label>
                  </div>
                  <small>
                    암호화된 키는 이 브라우저에서 복사해 가져가 계속 추측해 볼
                    수 있으므로, 이 암호가 키의 유일한 보호입니다. 다른 곳에
                    쓰지 않은 긴 문구를 쓰세요.
                  </small>
                  <button
                    disabled={blockWrite || !fresh || state.pending !== 0n}
                    onClick={createKey}
                  >
                    서명 키 만들고 Vault에 등록
                  </button>
                </>
              )
            ) : status === "unsent" ? (
              <>
                <p className="inline-warning">
                  이 키의 등록이 Vault에 전달되지 않았습니다. 등록 거래를 보내
                  마무리하거나, 폐기하고 새 키를 만드세요.
                </p>
                <button
                  disabled={blockWrite || !fresh || state?.pending !== 0n}
                  onClick={register}
                >
                  등록 거래 보내기
                </button>
              </>
            ) : status === "pending" ? (
              <p className="inline-warning">
                등록 요청이 Vault에 제출되었습니다. 다음 블록부터 위의 “Core
                반영 확인”으로 마무리할 수 있습니다.
              </p>
            ) : status === "retired" ? (
              <p className="inline-warning">
                이 주소는 이미 등록에 쓰였고 지금은 Vault의 agent가 아닙니다.
                다시 등록할 수 없으므로 폐기하고 새 키를 만드세요.
              </p>
            ) : status === "unconfirmed" ? (
              <p className="inline-warning">
                {!state
                  ? listed === null
                    ? "Vault를 조회하지 못했고, 거래소 API에서 이 키가 활성 agent인지도 아직 확인하지 못했습니다. "
                    : "Vault를 조회하지 못했고, 거래소 API는 이 키를 활성 agent로 표시하지 않습니다. "
                  : listed === null
                    ? "Vault는 이 키를 agent로 기록했습니다. 거래소 API에서 활성 agent인지 아직 확인하지 못했습니다. "
                    : "Vault는 이 키를 agent로 기록했지만 거래소 API가 활성 agent로 표시하지 않습니다(반영 지연, 만료 또는 Core의 거절). "}
                10초마다 다시 확인합니다.
                {state && " 계속 확인되지 않으면 폐기하고 새 키를 등록하세요."}
              </p>
            ) : status === "locked" ? (
              <div className="adder inline">
                <input
                  type="password"
                  ref={pass}
                  autoComplete="off"
                  placeholder="서명 키 암호"
                  aria-label="서명 키 암호"
                  onKeyDown={(e) => e.key === "Enter" && void unlock()}
                />
                <button disabled={busy} onClick={unlock}>
                  잠금 해제
                </button>
              </div>
            ) : (
              <>
                <button onClick={lock}>잠금</button>
                <small>
                  거래가 없으면 {duration(Math.ceil(lockIn / 1000))} 뒤 자동으로
                  잠깁니다. 기준은 마지막 거래 동작에서 {idle}입니다.
                </small>
              </>
            )}
            {key &&
              !checking &&
              !damaged &&
              (discarding ? (
                <div className="inline-warning action">
                  <span>
                    이 브라우저의 서명 키를 지웁니다. 되돌릴 수 없으며, 다시
                    거래하려면 새 키를 등록해야 합니다.
                  </span>
                  <span className="pair">
                    <button onClick={discard}>폐기 확정</button>
                    <button
                      className="quiet"
                      onClick={() => setDiscarding(false)}
                    >
                      취소
                    </button>
                  </span>
                </div>
              ) : (
                <button className="link" onClick={() => setDiscarding(true)}>
                  키 폐기
                </button>
              ))}
          </div>
        </div>
      </section>
      <div className="split">
        <div>
          <section className="block">
            <div className="block-head">
              <h3>시장</h3>
              {market && <span className="tag ok">{market.label}</span>}
            </div>
            {!guards ? (
              <p className={failure || !state ? "inline-warning" : "note"}>
                {failure
                  ? `평가 범위를 조회하지 못했습니다. ${failure} `
                  : state
                    ? "평가 범위를 확인하는 중… "
                    : "평가 범위를 조회하지 못한 상태입니다. "}
                범위를 확인하기 전에는 포지션을 여는 주문을 보낼 수 없고, 취소와
                reduce-only 주문만 보낼 수 있습니다.
              </p>
            ) : (
              !guards.fresh && (
                <p className="inline-warning">
                  평가 범위 조회가 만료되었습니다. 다시 조회될 때까지 포지션을
                  여는 주문은 보낼 수 없습니다. 취소와 reduce-only 주문은 보낼
                  수 있습니다. {failure}
                </p>
              )
            )}
            {guards && !guards.value && (
              <p className="inline-warning">
                이 Vault의 검증기에서는 등록 범위를 읽을 수 없습니다. USDC
                시장만 표시하지만, 거래한 자산이 NAV에 집계되는지는 이 화면에서
                확인할 수 없습니다.
              </p>
            )}
            {metaFailure && (
              <div className="inline-warning action">
                <span>시장 정보를 조회하지 못했습니다. {metaFailure}</span>
                <button onClick={retry}>다시 시도</button>
              </div>
            )}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="시장 검색 (예: BTC, HYPE)"
              aria-label="시장 검색"
            />
            <div className="markets">
              {found.slice(0, LISTED).map((row) => {
                const { orders, note } = offer(row);
                return (
                  <button
                    key={row.key}
                    className={row.key === picked ? "active" : ""}
                    disabled={orders === "none"}
                    onClick={() => {
                      setPicked(row.key);
                      setOutcome(null);
                      // Where only a reducing order may be sent, the ticket starts as one.
                      edit({ price: "", reduceOnly: orders === "reduce" });
                    }}
                  >
                    <b>{row.label}</b>
                    <span>
                      {row.kind === "perp"
                        ? `perp · ${dexName(dexes, row.dex)}`
                        : "spot"}
                    </span>
                    {note && <em>{note}</em>}
                  </button>
                );
              })}
              {!found.length && (
                <p className="empty">
                  {meta ? "맞는 시장이 없습니다." : "시장을 불러오는 중…"}
                </p>
              )}
            </div>
            <small>
              {found.length > LISTED &&
                `${found.length}개 중 ${LISTED}개를 표시합니다. 검색으로 좁히세요. `}
              범위 밖 시장은{" "}
              <a href={routeHash({ page: "vault", vault, tab: "scope" })}>
                평가 범위
              </a>
              에 먼저 등록해야 포지션을 열 수 있습니다. 등록 전에 거래한 보유는
              NAV에 보이지 않습니다. 범위 밖이거나 범위를 확인하지 못한 perp
              시장에서는 포지션을 줄이는 reduce-only 주문만 보낼 수 있습니다.
            </small>
          </section>
          <section className="block">
            <div className="block-head">
              <h3>주문</h3>
              {market && (
                <span className="tag">mid {mids[market.coin] ?? "—"}</span>
              )}
            </div>
            {!market ? (
              <p className="empty">시장을 고르면 주문을 입력할 수 있습니다.</p>
            ) : (
              <>
                <div className="segment">
                  <button
                    className={ticket.isBuy ? "active buy" : ""}
                    onClick={() => edit({ isBuy: true })}
                  >
                    매수
                  </button>
                  <button
                    className={ticket.isBuy ? "" : "active sell"}
                    onClick={() => edit({ isBuy: false })}
                  >
                    매도
                  </button>
                </div>
                <label>
                  주문 유형
                  <select
                    value={ticket.type}
                    onChange={(e) =>
                      edit({ type: e.target.value as OrderType })
                    }
                  >
                    {(Object.keys(ORDER_TYPES) as OrderType[]).map((type) => (
                      <option key={type} value={type}>
                        {ORDER_TYPES[type].label} ({ORDER_TYPES[type].tif})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="two">
                  {ticket.type === "market" ? (
                    <label>
                      허용 슬리피지 (%)
                      <input
                        value={ticket.slippage}
                        onChange={(e) => edit({ slippage: e.target.value })}
                        inputMode="decimal"
                      />
                    </label>
                  ) : (
                    <label>
                      가격 (USDC)
                      <input
                        value={ticket.price}
                        onChange={(e) => edit({ price: e.target.value })}
                        inputMode="decimal"
                      />
                    </label>
                  )}
                  <label>
                    수량 ({market.label.split(/[/-]/)[0]})
                    <input
                      value={ticket.size}
                      onChange={(e) => edit({ size: e.target.value })}
                      inputMode="decimal"
                    />
                  </label>
                </div>
                <small>
                  수량은 소수 {market.szDecimals}자리, 가격은 소수{" "}
                  {(market.kind === "perp" ? 6 : 8) - market.szDecimals}
                  자리·유효숫자 5자리까지입니다. 입력한 값은 반올림하지
                  않습니다.
                </small>
                {market.kind === "perp" && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ticket.reduceOnly}
                      onChange={(e) => edit({ reduceOnly: e.target.checked })}
                    />
                    reduce-only — 포지션을 줄이는 주문만
                  </label>
                )}
                {market.kind === "perp" &&
                  offer(market).orders === "reduce" && (
                    <small>
                      {offer(market).note}. 이 시장에는 지금 포지션을 줄이는
                      주문만 보낼 수 있습니다.
                    </small>
                  )}
                {/* The review button keeps its place and nothing above it changes but the
                    confirmation, whose buttons come after its text: the second click of a double
                    click on the review button finds that text or the review button, never the
                    send button. `confirmClick` is the rule; this is the layout that goes with it. */}
                {confirm && live && (
                  <div className="confirm">
                    <div className="confirm-text">
                      <small>이 주문을 전송합니다</small>
                      <b>{confirm.order.summary}</b>
                      {confirm.order.warning && (
                        <p className="inline-warning">
                          {confirm.order.warning}
                        </p>
                      )}
                    </div>
                    {confirm.order.consent && (
                      <label className="check consent">
                        <input
                          type="checkbox"
                          checked={confirm.agreed}
                          onChange={(e) =>
                            confirmClick(confirm.at, Date.now()) !== "early" &&
                            setConfirm({ ...confirm, agreed: e.target.checked })
                          }
                        />
                        <span>
                          {confirm.order.consent} 그래도 이 가격으로 전송합니다.
                        </span>
                      </label>
                    )}
                    {held && <p className="inline-warning">{held}</p>}
                    <div className="two">
                      <button
                        className="primary"
                        disabled={
                          !keyOpen ||
                          !!held ||
                          (!!confirm.order.consent && !confirm.agreed)
                        }
                        onClick={sendConfirmed}
                      >
                        주문 전송 <span>↗</span>
                      </button>
                      <button onClick={() => setConfirm(null)}>수정</button>
                    </div>
                  </div>
                )}
                <button
                  className="primary"
                  disabled={busy || reviewing || live}
                  onClick={review}
                >
                  주문 확인 <span>→</span>
                </button>
                {problem && <p className="inline-warning">{problem}</p>}
                {confirm && !live && (
                  <small>
                    확인한 지 {CONFIRM_TTL_MS / 1000}초가 지났습니다. 다시
                    확인하세요.
                  </small>
                )}
                {keyNeeded && status !== "ready" && (
                  <small>주문을 전송하려면 서명 키를 여세요.</small>
                )}
              </>
            )}
            {outcome && (
              <div className="outcome" role="status">
                <small>{outcome.title}</small>
                {outcome.results?.map((result, i) => {
                  const { ok, text } = resultText(result);
                  const state = orderState(result, outcome.sizes?.[i]);
                  return (
                    <b key={i} className={ok ? "good" : "bad"}>
                      <span className={`tag order-${state}`}>
                        {ORDER_STATE_LABEL[state]}
                      </span>{" "}
                      {text}
                    </b>
                  );
                })}
                {outcome.unknown !== undefined && (
                  <b className="bad">
                    결과를 알 수 없습니다. 요청이 거래소에 도달했을 수 있습니다.
                    미체결 주문과 포지션을 확인한 뒤에만 다시 시도하세요. 자동
                    재시도는 하지 않습니다. ({outcome.unknown})
                  </b>
                )}
                {outcome.preview !== undefined && (
                  <>
                    <b>전송하지 않은 미리보기</b>
                    <pre>{outcome.preview}</pre>
                  </>
                )}
                {demo && (
                  <small>
                    데모의 가상 처리입니다. 실제로 전송하지 않았습니다.
                  </small>
                )}
              </div>
            )}
          </section>
          <section className="block">
            <div className="block-head">
              <h3>builder fee</h3>
              <span className={"tag " + (attach ? "ok" : "")}>
                {attach ? `주문마다 ${feeText(attach.f)}` : "붙이지 않음"}
              </span>
            </div>
            {!hasBuilder ? (
              <p className="note">
                {builder
                  ? "이 Vault에는 builder가 설정되어 있지 않습니다."
                  : "builder 설정을 확인하는 중…"}
              </p>
            ) : (
              <>
                <Detail label="builder">
                  <code title={builder ?? ""}>{short(builder ?? "")}</code>
                </Detail>
                <Detail label="Core에 승인된 상한">
                  {approved === null ? "조회 불가" : feeText(approved)}
                </Detail>
                <Detail label="Vault의 승인 한도">
                  {cap === null ? "—" : feeText(Number(cap))}
                </Detail>
                <Detail label="이 빌드의 설정 요율">
                  {feeProblem ? "설정 오류" : feeText(Number(feeSetting || 0))}
                </Detail>
                {feeProblem && <p className="inline-warning">{feeProblem}</p>}
                {approved === null && (
                  <p className="note">
                    승인값을 확인하지 못해 주문에 fee를 붙이지 않습니다.
                  </p>
                )}
                <div className="adder inline">
                  <input
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    inputMode="numeric"
                    placeholder="승인 요율 (0.1bp 단위 정수)"
                    aria-label="승인 요율 (0.1bp 단위 정수)"
                  />
                  <button
                    disabled={blockWrite || !fresh || state?.pending !== 0n}
                    onClick={approveFee}
                  >
                    builder fee 승인
                  </button>
                </div>
                <small>
                  승인은 상한일 뿐이며, 주문에는 설정 요율과 승인 상한 중 작은
                  값이 붙습니다. 승인은 Core 반영 확인 뒤에 적용됩니다.
                </small>
              </>
            )}
          </section>
        </div>
        <div>
          <section className="block">
            <div className="block-head">
              <h3>계정</h3>
              {!demo && (
                <button className="link" onClick={() => setTick(tick + 1)}>
                  새로고침
                </button>
              )}
            </div>
            <small>
              거래소 HTTP API가 보여 주는 값입니다. 온체인 NAV가 아니며 지분
              가격에 쓰이지 않습니다.{" "}
              {demo
                ? "데모의 가상 계정입니다."
                : `${every / 1000}초마다 갱신합니다.`}
            </small>
            {accountFailure && (
              <p className="inline-warning">
                계정을 조회하지 못했습니다. {accountFailure}
              </p>
            )}
            {outdated && (
              <p className="inline-warning">
                아래 값은 {Math.floor((clock - accountAt) / 1000)}초 전에 조회한
                것입니다. 주문과 취소 전에 다시 조회하세요.
              </p>
            )}
            {!shownAccount ? (
              !accountFailure && <p className="empty">계정을 불러오는 중…</p>
            ) : (
              <>
                <h4>DEX별 계정 가치</h4>
                <div className="rows table three">
                  <div className="row head">
                    <span>DEX</span>
                    <span>계정 가치</span>
                    <span>출금 가능</span>
                  </div>
                  {shownAccount.margins.map((margin) => (
                    <div className="row" key={margin.dex}>
                      <span data-label="DEX">
                        {dexName(dexes, margin.dex)}
                        {outside(
                          !!scope?.dexes.includes(margin.dex) ||
                            Number(margin.accountValue) === 0,
                        )}
                      </span>
                      <span data-label="계정 가치">{margin.accountValue}</span>
                      <span data-label="출금 가능">{margin.withdrawable}</span>
                    </div>
                  ))}
                  {!shownAccount.margins.length && (
                    <p className="empty">조회한 DEX가 없습니다.</p>
                  )}
                </div>
                <h4>포지션</h4>
                <div className="rows table six">
                  <div className="row head">
                    <span>시장</span>
                    <span>수량</span>
                    <span>진입가</span>
                    <span>가치</span>
                    <span>미실현 손익</span>
                    <span>청산가</span>
                  </div>
                  {shownAccount.positions.map((position) => (
                    <div
                      className="row"
                      key={`${position.dex}:${position.coin}`}
                    >
                      <span data-label="시장">
                        {coinLabel(position.coin)}
                        {outside(!!scope?.dexes.includes(position.dex))}
                      </span>
                      <span data-label="수량" className={tone(position.size)}>
                        {position.size}
                      </span>
                      <span data-label="진입가">
                        {position.entryPrice ?? "—"}
                      </span>
                      <span data-label="가치">{position.value}</span>
                      <span
                        data-label="미실현 손익"
                        className={tone(position.pnl)}
                      >
                        {position.pnl}
                      </span>
                      <span data-label="청산가">
                        {position.liquidationPrice ?? "—"}
                      </span>
                    </div>
                  ))}
                  {!shownAccount.positions.length && (
                    <p className="empty">열린 포지션이 없습니다.</p>
                  )}
                </div>
                <h4>Spot 잔액</h4>
                <div className="rows table three">
                  <div className="row head">
                    <span>토큰</span>
                    <span>잔액</span>
                    <span>주문에 묶임</span>
                  </div>
                  {shownAccount.balances.map((balance) => (
                    <div className="row" key={balance.token}>
                      <span data-label="토큰">
                        {balance.coin}
                        {outside(
                          !!scope?.tokens.some(
                            (token) => token.index === balance.token,
                          ),
                        )}
                      </span>
                      <span data-label="잔액">{balance.total}</span>
                      <span data-label="주문에 묶임">{balance.hold}</span>
                    </div>
                  ))}
                  {!shownAccount.balances.length && (
                    <p className="empty">spot 잔액이 없습니다.</p>
                  )}
                </div>
                <h4>미체결 주문</h4>
                <div className="rows table orders">
                  <div className="row head">
                    <span>시장</span>
                    <span>방향</span>
                    <span>유형</span>
                    <span>가격</span>
                    <span>수량</span>
                    <span />
                  </div>
                  {shownAccount.orders.map((order) => (
                    <div className="row" key={order.oid}>
                      <span data-label="시장">{coinLabel(order.coin)}</span>
                      <span
                        data-label="방향"
                        className={order.isBuy ? "good" : "bad"}
                      >
                        {order.isBuy ? "매수" : "매도"}
                        {order.reduceOnly && <em>reduce-only</em>}
                      </span>
                      <span data-label="유형">
                        {order.type ?? "Limit"}
                        {order.triggerPrice && (
                          <em>조건가 {order.triggerPrice}</em>
                        )}
                      </span>
                      <span data-label="가격">{order.price}</span>
                      <span data-label="수량">
                        {order.triggerPrice && !Number(order.size)
                          ? "포지션 전체"
                          : order.size}
                      </span>
                      <span>
                        <button
                          disabled={!keyOpen}
                          onClick={() => cancel(order)}
                        >
                          취소
                        </button>
                      </span>
                    </div>
                  ))}
                  {!shownAccount.orders.length && (
                    <p className="empty">미체결 주문이 없습니다.</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
