import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Abi, TransactionReceipt } from "viem";
import {
  writesEnabled,
  type Address,
  type EIP1193Provider,
  type State,
} from "./chain";
import type { DemoVault, DemoWorld } from "./demo";
import { routeHash, type Place, type Route } from "./route";

export { failureText } from "./reasons";

/** What the shell shares with every page: the mode, the wallet and the one write lock. */
export type Shell = {
  demo: boolean;
  account: Address | null;
  busy: boolean;
  /** A write may be offered: the demo, or a connected wallet on a build with writes enabled. */
  canWrite: boolean;
  factory: string;
  /**
   * The build names the Factory: it cannot be replaced. Otherwise the visitor types one, and
   * every page says that it runs against a typed Factory.
   */
  factoryFixed: boolean;
  /** Why the build's Factory setting cannot be used, when it cannot. */
  factoryProblem: string;
  setFactory: (value: string) => void;
  /** Bumped when the wallet, the mode or the Factory changes: a read begun before is stale. */
  generation: { current: number };
  /** Runs under the one write lock. A failure is reported like `fail`, for `place`. */
  run: (work: () => Promise<void>, place?: Place) => Promise<void>;
  wallet: () => { p: EIP1193Provider; a: Address };
  /**
   * One line of feedback under the page. Given the page it belongs to, it is shown only there:
   * a confirmation must not sit under another Vault's page.
   */
  say: (text: string, place?: Place) => void;
  /** Asks the browser wallet to connect (and switch to this chain). */
  connect: () => void;
  fail: (e: unknown, place?: Place) => void;
  demoNotice: (text: string, place?: Place) => void;
  /** One line about the page's chain read, shown in the footer. */
  setStatus: (text: string) => void;
  world: DemoWorld;
  setWorld: Dispatch<SetStateAction<DemoWorld>>;
};

/**
 * The shell as one page and its panels use it: whatever they report belongs to `place`. `told`
 * turns a failure into the one that page reports for it.
 */
export function shellFor(
  app: Shell,
  place: Place,
  told: (e: unknown) => unknown = (e) => e,
): Shell {
  return {
    ...app,
    run: (work) =>
      app.run(async () => {
        try {
          await work();
        } catch (e) {
          throw told(e);
        }
      }, place),
    say: (text) => app.say(text, place),
    fail: (e) => app.fail(told(e), place),
    demoNotice: (text) => app.demoNotice(text, place),
  };
}

/** What the vault page shares with its panels. */
export type VaultView = {
  app: Shell;
  vault: Address;
  /** The last good read of the Vault. Only `fresh` says that it is current. */
  state: State;
  /** The account the page is shown for: the connected wallet, or the demo's visitor. */
  viewer: Address | null;
  own: boolean;
  fresh: boolean;
  clock: number;
  /** No write may start: one is running, or this build or wallet cannot write. */
  blockWrite: boolean;
  /** Runs under the write lock, then reads the Vault again. */
  act: (work: () => Promise<void>) => Promise<void>;
  /** The Vault read again for the connected wallet, right before a write. */
  current: () => Promise<State>;
  /** Sends a call only the owner may make, after checking that the wallet is the owner. */
  ownerSend: (
    fn: string,
    args: readonly unknown[],
    at?: Address,
    abi?: Abi,
  ) => Promise<TransactionReceipt>;
  /**
   * Demo only: applies a change to this sample vault. The change may throw, as the contract
   * would revert, and nothing is stored then.
   */
  demoApply: (change: (vault: DemoVault) => DemoVault) => DemoVault;
};

/** A value read from the chain, and whether it is recent enough to act on. */
export type Loaded<T> = { value: T; fresh: boolean };

export const go = (route: Route) => {
  location.hash = routeHash(route);
};
export const short = (v: string) =>
  v ? `${v.slice(0, 6)}…${v.slice(-4)}` : "연결 전";
export const same = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Runs `work` now and every `every` ms while the tab is shown. A hidden tab asks nothing: the
 * node counts every request against one limit per address. Coming back to the tab reads at once
 * if a read is due. A read still running is not started again. Returns the stop function.
 */
export function poll(work: () => Promise<void>, every: number): () => void {
  let last = 0,
    running = false;
  const run = async () => {
    if (running || document.hidden) return;
    running = true;
    last = Date.now();
    try {
      await work();
    } finally {
      running = false;
    }
  };
  const back = () => {
    if (Date.now() - last >= every) void run();
  };
  const timer = setInterval(run, every);
  document.addEventListener("visibilitychange", back);
  void run();
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", back);
  };
}

/** localStorage or sessionStorage, or null where the browser refuses access to it. */
export function webStore(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function Metric({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
}) {
  return (
    <section className="metric">
      <small>{label}</small>
      <div>
        {value} <em>{unit}</em>
      </div>
      <p>{sub}</p>
    </section>
  );
}

export function Detail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="detail">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

/**
 * The mode notice every page shows, and the Factory the contract mode reads. The Factory is the
 * root of what the page trusts: a build that names one shows it and takes no other, and a build
 * that names none marks every page as running against the one the visitor typed.
 */
export function Banner({ app }: { app: Shell }) {
  return (
    <>
      <div className="notice">
        {app.demo
          ? "데모 화면 · 표시된 볼트·NAV·대화·주문은 가상 예시입니다."
          : "계약 연결 · " +
            (writesEnabled
              ? "현재 설정의 계약에 지갑으로 서명합니다."
              : "읽기 전용 — 검토된 배포 설정에서 거래를 활성화하세요.")}
        <span>USDC 입금 · 운용자 거래 · ERC-7540 출금</span>
      </div>
      {!app.demo &&
        (app.factoryFixed ? (
          <section className="connection fixed">
            {app.factoryProblem ? (
              <p className="inline-warning" role="alert">
                {app.factoryProblem}
              </p>
            ) : (
              <p>
                Factory <code className="address">{app.factory}</code>
                <small>이 빌드에 고정된 주소입니다.</small>
              </p>
            )}
          </section>
        ) : (
          <section className="connection">
            <p className="inline-warning typed-factory">
              <b>직접 입력한 Factory로 동작합니다.</b> 이 빌드는 Factory를 정해
              두지 않았습니다. 볼트 목록, 볼트가 등록된 것인지의 확인, 코드 변경
              여부, 지갑이 승인하는 토큰은 모두 아래 주소의 계약이 답한 대로
              표시됩니다. 출처를 확인한 Factory 주소만 입력하세요.
            </p>
            <label>
              Factory 주소
              <input
                value={app.factory}
                disabled={app.busy}
                onChange={(e) => app.setFactory(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </label>
          </section>
        ))}
    </>
  );
}
