import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  chain,
  connected,
  switchToChain,
  writesEnabled,
  type Address,
  type EIP1193Provider,
} from "./chain";
import { builtFactory } from "./addresses";
import { saveSession } from "./chatView";
import { demoWorld } from "./demo";
import { foreignFrame } from "./frame";
import { Assets } from "./pages/Assets";
import { Create } from "./pages/Create";
import { DirectVault } from "./pages/DirectVault";
import { Explore } from "./pages/Explore";
import { Home } from "./pages/Home";
import { DemoBanner } from "./pages/hyper";
import { Ops } from "./pages/Ops";
import { Strategy } from "./pages/Strategy";
import { Docs } from "./pages/Docs";
import { VaultPage } from "./pages/VaultPage";
import { Vaults } from "./pages/Vaults";
import { entryFor } from "./pages/ProductCard";
import { externalLink } from "./hypervault";
import { PRODUCTS } from "./products";
import {
  feedbackAfter,
  parseRoute,
  routeHash,
  showsPlace,
  type Feedback,
  type Place,
} from "./route";
import { failureText, short, webStore, type Shell } from "./ui";
import "./style.css";
import "./app.css";
type Provider = EIP1193Provider & {
  on?: (event: string, callback: () => void) => void;
  removeListener?: (event: string, callback: () => void) => void;
};
const built = builtFactory(import.meta.env.VITE_FACTORY_ADDRESS);
// The earlier Factory pages and their simulated demo world are shown only when a build asks.
const legacy = import.meta.env.VITE_LEGACY_FACTORY_UI === "true";
const NAV = [
  ["#/vaults", "Vaults", "vaults"],
  ["#/docs", "Learn", "docs"],
] as const;
const chatLink = externalLink(import.meta.env.VITE_CHAT_URL);
const usdcEntry = entryFor(PRODUCTS[0]!);
const repoLink = externalLink(import.meta.env.VITE_REPO_URL);

/** Symbol image plus the name set in the heading face: one logo, no third font. */
function Wordmark() {
  return (
    <span className="wordmark">
      <img
        className="wordmark-mark"
        src="/brand/logo-mark.png"
        alt=""
        width={24}
        height={24}
      />
      <span className="wordmark-word">HyperVault</span>
    </span>
  );
}
function App() {
  const [demo, setDemo] = useState(legacy),
    [account, setAccount] = useState<Address | null>(null),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<Feedback | null>(null),
    [status, setStatus] = useState(""),
    [route, setRoute] = useState(() => parseRoute(location.hash)),
    [world, setWorld] = useState(() => demoWorld());
  const [factory, setFactory] = useState(built.address);
  const provider = useRef<Provider | null>(null),
    lock = useRef(false),
    generation = useRef(0),
    page = useRef(route),
    accountRef = useRef<Address | null>(null);
  accountRef.current = account;
  const shown = route.page === "vault" ? route.vault : route.page;
  const say = (text: string, place: Place = null) =>
    setFeedback({ text, error: false, place });
  const fail = (e: unknown, place: Place = null) =>
    setFeedback({ text: failureText(e), error: true, place });
  // Success notes clear themselves; errors stay until the next action or page change.
  useEffect(() => {
    if (!feedback || feedback.error) return;
    const t = setTimeout(
      () => setFeedback((now) => (now === feedback ? null : now)),
      4000,
    );
    return () => clearTimeout(t);
  }, [feedback]);
  useEffect(() => {
    const change = () => {
      const from = page.current;
      const to = parseRoute(location.hash);
      page.current = to;
      setRoute(to);
      setFeedback((line) => feedbackAfter(line, from, to));
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    // Not returned: newer browsers answer a scroll with a promise, which is not a cleanup.
    window.scrollTo(0, 0);
  }, [shown]);
  useEffect(() => {
    const p = (window as Window & { ethereum?: Provider }).ethereum;
    if (!p) return;
    provider.current = p;
    const invalidate = (text: string) => {
      generation.current++;
      setAccount(null);
      // A chat session belongs to the account that signed it.
      const store = webStore("session");
      if (store) saveSession(store, null);
      say(text);
    };
    const onAccounts = () => {
      if (accountRef.current)
        invalidate("Wallet account changed. Connect again.");
    };
    // A switch to this chain (ours or the visitor's) keeps the same account connected; leaving it
    // disconnects, and Connect switches back.
    const onChain = () => {
      const was = accountRef.current;
      if (!was) return;
      generation.current++;
      connected(p, was).then(
        (a) => setAccount(a),
        () =>
          invalidate(
            `Your wallet left ${chain.name}. Connect again to switch back.`,
          ),
      );
    };
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, []);
  function switchMode() {
    generation.current++;
    setDemo(!demo);
    if (!demo) setWorld(demoWorld());
    setFeedback(null);
    setAccount(null);
    // A vault of one mode does not exist in the other.
    if (route.page === "vault") location.hash = "#/explore";
  }
  async function run(work: () => Promise<void>, place: Place = null) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await work();
    } catch (e) {
      fail(e, place);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function connect() {
    await run(async () => {
      if (demo) {
        say("데모에서는 지갑이나 실제 자금을 사용하지 않습니다.");
        return;
      }
      if (!provider.current)
        throw new Error(
          "No browser EVM wallet found. Install one or open this page in a wallet browser.",
        );
      await provider.current.request({ method: "eth_requestAccounts" });
      await switchToChain(provider.current);
      setAccount(await connected(provider.current));
      say("Wallet connected");
    });
  }
  const app: Shell = {
    demo,
    account,
    busy,
    canWrite: demo || (!!account && writesEnabled),
    factory,
    factoryFixed: built.fixed,
    factoryProblem: built.problem,
    setFactory: (value) => {
      // The Factory a build names is not the visitor's to replace.
      if (built.fixed) return;
      generation.current++;
      setFactory(value);
    },
    generation,
    run,
    wallet: () => {
      if (!provider.current || !account) throw new Error("지갑을 연결하세요.");
      return { p: provider.current, a: account };
    },
    say,
    connect: () => void connect(),
    fail,
    demoNotice: (text, place) =>
      say(`데모 · ${text} 실제 거래는 전송하지 않았습니다.`, place),
    setStatus,
    world,
    setWorld,
  };
  // A line made for another page than the one shown waits there, unseen.
  const line = feedback && showsPlace(route, feedback.place) ? feedback : null;
  const legacyPage =
    legacy &&
    (route.page === "explore" ||
      route.page === "create" ||
      route.page === "vault");
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="HyperVault home">
          <Wordmark />
        </a>
        <nav className="pages" aria-label="Main">
          {NAV.map(([href, label, page]) => (
            <a
              key={href}
              href={href}
              aria-current={
                route.page === page ||
                (page === "vaults" && route.page === "direct")
                  ? "page"
                  : undefined
              }
            >
              {label}
            </a>
          ))}
          {legacy && (
            <>
              <a href="#/explore">이전 Factory 탐색</a>
              <a href="#/create">이전 Factory 생성</a>
            </>
          )}
        </nav>
        <div className="header-right">
          {route.page === "home" && !legacy ? (
            <a
              className="btn primary"
              href={
                usdcEntry
                  ? routeHash({
                      page: "direct",
                      vault: usdcEntry.vault,
                      trade: false,
                    })
                  : "#/vaults"
              }
            >
              Launch app
            </a>
          ) : (
            <>
              <span className="network">
                {demo ? "Local demo" : chain.name}
              </span>
              {legacy && (
                <button className="quiet" disabled={busy} onClick={switchMode}>
                  {demo ? "실제 계약 연결" : "데모로 보기"}
                </button>
              )}
              <button className="primary" onClick={connect} disabled={busy}>
                {account ? short(account) : "Connect wallet"}
              </button>
            </>
          )}
        </div>
      </header>
      {demo && legacyPage && <DemoBanner />}
      <main>
        {route.page === "vaults" ? (
          <Vaults />
        ) : route.page === "direct" ? (
          <DirectVault
            key={`${demo}:${route.vault}`}
            app={app}
            vault={route.vault}
            trade={route.trade}
          />
        ) : route.page === "ops" ? (
          <Ops demo={demo} />
        ) : route.page === "strategy" ? (
          <Strategy />
        ) : route.page === "docs" ? (
          <Docs />
        ) : route.page === "assets" ? (
          <Assets app={app} />
        ) : !legacyPage ? (
          <Home />
        ) : route.page === "create" ? (
          <Create app={app} />
        ) : route.page === "vault" ? (
          <VaultPage
            key={`${demo}:${route.vault}`}
            app={app}
            vault={route.vault}
            tab={route.tab}
          />
        ) : (
          <Explore key={String(demo)} app={app} unknown={false} />
        )}
        {line && (
          <div
            role={line.error ? "alert" : "status"}
            className={"feedback " + (line.error ? "error" : "")}
          >
            {line.text}
          </div>
        )}
        <footer className="site-footer">
          <div className="footer-brand">
            <Wordmark />
          </div>
          <nav className="footer-links" aria-label="Footer">
            <a href="#/docs">Docs</a>
            <a href="#/vaults">Vaults</a>
            {usdcEntry && (
              <a
                href={`https://hyperevmscan.io/address/${usdcEntry.vault}`}
                target="_blank"
                rel="noreferrer"
              >
                Contract
              </a>
            )}
            {chatLink && (
              <a href={chatLink} target="_blank" rel="noreferrer">
                Community
              </a>
            )}
            {repoLink && (
              <a href={repoLink} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
          </nav>
          {(demo || status) && (
            <span className="footer-status">
              {demo ? "Demo, no transactions" : status}
            </span>
          )}
        </footer>
      </main>
    </div>
  );
}
// Inside another site's page nothing is started: no wallet is asked and no stored key is read.
createRoot(document.getElementById("root")!).render(
  foreignFrame(window) ? (
    <p className="framed" role="alert">
      이 화면은 다른 사이트의 페이지 안(프레임)에서는 열리지 않습니다. 브라우저
      주소창에 이 화면의 주소를 직접 입력해 여세요.
    </p>
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
