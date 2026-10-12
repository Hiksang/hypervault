import { useEffect, useRef, useState, type ReactNode } from "react";
import { type Abi } from "viem";
import {
  chain,
  read,
  connected,
  switchToChain,
  inspectGuards,
  send,
  type Address,
  type Guards,
  type State,
} from "../chain";
import { inspectDirect, observeDirect, type Observation } from "../directRead";
import { lensAccount, type LensAccount } from "../lensRead";
import type { DirectVault as Entry } from "../directVaultManifest";
import {
  blockedText,
  bridgeKind,
  fields,
  kindOf,
  parseStrategy,
  planFor,
  VAULTS,
} from "../hypervault";
import { Trade } from "../panels/Trade";
import { routeHash } from "../route";
import {
  failureText,
  poll,
  same,
  shellFor,
  short,
  type Loaded,
  type Shell,
  type VaultView,
} from "../ui";
import { Assets } from "./Assets";
import { AccountHistory } from "./AccountHistory";
import { ArrowLeft, Check, Copy } from "@phosphor-icons/react";
import { assetVaultAbi } from "../assetVault";
import { approx, PRODUCTS } from "../products";
import { estAprNow } from "../aprNow";
import {
  amount,
  Fields,
  StatusBadge,
  usePublished,
  Value,
  when,
} from "./hyper";
import { usdc } from "./ProductCard";
import { manifest } from "./Vaults";
import {
  ActivitySection,
  PositionsSection,
  ReturnSection,
  useActivity,
} from "./VaultActivity";
import { StrategyFlow } from "./StrategyFlow";
import { currentYieldOf } from "./CurrentYield";
import { Freshness, SectionError, Skel, TokenIcon } from "./kit";

const OBSERVE_EVERY = 60_000,
  STATE_EVERY = 15_000,
  SCOPE_EVERY = 20_000,
  FRESH = 30_000;
const PHASES = [
  "Not started",
  "Activation pending",
  "Ready",
  "Idle · cash on EVM",
  "Active",
  "Settling withdrawals",
];
// HyperCore spot tokens by index (mainnet): 0 USDC, 150 HYPE, 197 UBTC. Others by number.
const TOKENS: Record<number, string> = { 0: "USDC", 150: "HYPE", 197: "UBTC" };
const tokenLabel = (index: number, base: number | null, symbol: string) =>
  index === base ? symbol : (TOKENS[index] ?? `token #${index}`);

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
const wallet = () =>
  (window as Window & { ethereum?: Provider }).ethereum ?? null;

export function DirectVault({
  app: shell,
  vault,
  trade,
}: {
  app: Shell;
  vault: Address;
  trade: boolean;
}) {
  const app = shellFor(shell, vault);
  const { entries, problem } = manifest();
  const entry = entries.find((e) => same(e.vault, vault));
  if (!entry)
    return (
      <div className="hv">
        <p className="eyebrow">
          <a href="#/vaults">VAULTS</a>
        </p>
        <h1>Not a listed vault</h1>
        <p className="inline-warning" role="alert">
          {problem ||
            `${vault} is not in this build's reviewed deployment manifest. This page reads and offers nothing for it.`}
        </p>
      </div>
    );
  return <Listed app={app} entry={entry} trade={trade} />;
}

function Listed({
  app,
  entry,
  trade,
}: {
  app: Shell;
  entry: Entry;
  trade: boolean;
}) {
  const [seen, setSeen] = useState<Observation | null>(null),
    [seenAt, setSeenAt] = useState<number | null>(null),
    [failure, setFailure] = useState(""),
    [tick, setTick] = useState(0),
    [walletChain, setWalletChain] = useState<number | null>(null),
    [position, setPosition] = useState<State | null>(null),
    [positionAt, setPositionAt] = useState(0),
    [positionFailure, setPositionFailure] = useState(""),
    [positionTick, setPositionTick] = useState(0),
    [pending, setPending] = useState(0n),
    [lensAcct, setLensAcct] = useState<LensAccount | null>(null);
  const named = kindOf(entry);
  const reported = seen?.kind.ok ? bridgeKind(seen.kind.value) : null;
  const kind = reported ?? named;
  const facts = kind ? VAULTS[kind] : null;
  const decimals = seen?.decimals.ok
    ? seen.decimals.value
    : (facts?.decimals ?? 18);
  const symbol = kind === "BTC" ? "UBTC" : (kind ?? "units");
  const shareDecimals = seen?.shareDecimals.ok
    ? seen.shareDecimals.value
    : decimals;
  const strategy = usePublished("strategy", parseStrategy);
  const plan =
    strategy.kind === "ok" && kind
      ? planFor(strategy.value.plans, kind, entry.vault)
      : undefined;

  useEffect(() => {
    if (app.demo) return;
    let alive = true;
    const stop = poll(async () => {
      try {
        const value = await observeDirect(entry);
        if (alive) {
          setSeen(value);
          setSeenAt(Date.now());
          setFailure("");
        }
      } catch (e) {
        if (alive) setFailure(failureText(e));
      }
    }, OBSERVE_EVERY);
    return () => {
      alive = false;
      stop();
    };
  }, [app.demo, entry.vault, tick]);
  useEffect(() => {
    const p = wallet();
    if (!p || !app.account) return setWalletChain(null);
    p.request({ method: "eth_chainId" }).then(
      (id) => setWalletChain(Number(id)),
      () => setWalletChain(null),
    );
  }, [app.account, tick]);
  useEffect(() => {
    setPosition(null);
    setPositionFailure("");
    setPending(0n);
    setLensAcct(null);
    if (app.demo || !app.account) return;
    const account = app.account;
    let alive = true;
    // Refreshed on a timer too, so a deposit or claim made in the panel shows up.
    const stop = poll(async () => {
      try {
        // v6: the Lens rides in the same Multicall3 aggregate as the vault reads and already
        // answers the pending request, so no second wave (ADR-041).
        const [s, acct] = await Promise.all([
          inspectDirect(entry, account),
          entry.lens
            ? lensAccount(read, entry.lens, entry.vault, account)
            : Promise.resolve(null),
        ]);
        const waiting = acct
          ? acct.pendingShares
          : s.request > 0n
            ? await read<bigint>(
                entry.vault,
                "pendingRedeemRequest",
                [s.request, account],
                assetVaultAbi,
              )
            : 0n;
        if (alive) {
          setPosition(s);
          setLensAcct(acct);
          setPending(waiting);
          setPositionAt(Date.now());
          setPositionFailure("");
        }
      } catch (e) {
        if (alive) setPositionFailure(failureText(e));
      }
    }, STATE_EVERY);
    return () => {
      alive = false;
      stop();
    };
  }, [app.demo, app.account, entry.vault, positionTick]);

  async function switchNetwork() {
    const p = wallet();
    if (!p) return app.fail(new Error("No browser wallet found."));
    try {
      await switchToChain(p);
      setTick((n) => n + 1);
    } catch (e) {
      app.fail(e);
    }
  }

  const fmt = amount(decimals);
  const navBlocked = seen && !seen.nav.ok ? seen.nav.error : null;
  const product = PRODUCTS.find((p) => p.id === kind) ?? null;
  const navUsd = seen?.nav.ok ? Number(seen.nav.value) / 10 ** decimals : null;
  const evmCash = seen?.cash.ok
    ? Number(seen.cash.value) / 10 ** decimals
    : null;
  const activity = useActivity(entry.vault, evmCash);
  const now = estAprNow(
    activity.alloc?.shortHypeUsd ?? null,
    navUsd,
    undefined,
    activity.alloc?.borrowedUsd ?? 0,
    activity.data?.rates.usdcBorrowApr ?? 0,
  );
  const current =
    entry.share && kind === "USDC"
      ? currentYieldOf(
          seen?.core,
          activity.data,
          navUsd,
          seen?.tokens.ok ? seen.tokens.value.values : null,
        )
      : undefined;
  const empty = !!seen?.supply.ok && seen.supply.value === 0n;
  const price =
    seen && !empty && seen.sharePrice.ok ? seen.sharePrice.value : null;
  const supply = seen?.supply.ok ? seen.supply.value : null;
  const owner = seen?.owner.ok ? seen.owner.value : null;
  const isOwner = !!owner && !!app.account && same(owner, app.account);
  const retired = entry.retired === true;
  const phase = seen?.phase.ok ? seen.phase.value : null;
  const sharePriceNum =
    empty || !seen
      ? null
      : seen.marks?.ok
        ? Number(seen.marks.value.rate) / 10 ** decimals
        : seen.sharePrice.ok
          ? Number(seen.sharePrice.value) / 10 ** decimals
          : null;
  const terms = {
    minimum: seen?.minimum.ok
      ? `${fixed(seen.minimum.value, decimals, 2)} ${symbol}`
      : null,
    minimumRaw: seen?.minimum.ok ? seen.minimum.value : null,
    fee: seen?.fee.ok ? `${Number(seen.fee.value) / 100}%` : null,
    capLeft:
      seen?.maximum.ok && seen.nav.ok
        ? seen.maximum.value > seen.nav.value
          ? seen.maximum.value - seen.nav.value
          : 0n
        : null,
  };
  return (
    <div className="vp">
      <a className="crumb" href="#/vaults">
        <ArrowLeft weight="bold" /> All vaults
      </a>
      <header className="vp-head">
        <TokenIcon symbol={symbol} size={40} />
        <div className="vp-title">
          <h1>{retired ? entry.name : (product?.name ?? entry.name)}</h1>
          <p>
            {retired
              ? "Strategy closed and settled. Withdraw only."
              : (product?.tagline ?? facts?.purpose)}{" "}
            <a
              href={`https://hyperevmscan.io/address/${entry.vault}`}
              target="_blank"
              rel="noreferrer"
              className="addr"
              title={entry.vault}
            >
              {short(entry.vault)}
            </a>
          </p>
        </div>
        <span
          className={`status ${phase === 4 ? "ok" : phase === 5 ? "warn" : ""}`}
        >
          {phase === 4 && <span className="live-dot" aria-hidden />}
          {phase !== null
            ? (PHASES[phase] ?? "Unknown")
            : failure
              ? "Unavailable"
              : "Reading…"}
        </span>
        {isOwner && (
          <nav className="seg-tabs vp-owner" aria-label="Vault view">
            <a
              href={routeHash({
                page: "direct",
                vault: entry.vault,
                trade: false,
              })}
              aria-current={!trade ? "page" : undefined}
            >
              Overview
            </a>
            <a
              href={routeHash({
                page: "direct",
                vault: entry.vault,
                trade: true,
              })}
              aria-current={trade ? "page" : undefined}
            >
              Owner trading
            </a>
          </nav>
        )}
      </header>
      {named && reported && named !== reported && (
        <p className="inline-warning" role="alert">
          The manifest name suggests {named}, but the bridge reports {reported}.
          The bridge's answer is used.
        </p>
      )}
      {app.demo ? (
        <p className="note">
          This page reads the live vault. Switch to contract mode in the header
          to read it.
        </p>
      ) : trade ? (
        <DirectTrade app={app} entry={entry} />
      ) : (
        <div className="vp-grid">
          <section className="vp-metrics" aria-label="Key figures">
            {failure && !seen ? (
              <SectionError
                what="The vault could not be read from HyperEVM."
                detail={failure}
                onRetry={() => setTick((n) => n + 1)}
              />
            ) : (
              <div className="metrics">
                {product && !retired && (
                  <div className="metric">
                    <small>Est. APR (Portfolio Margin)</small>
                    <b className="num" title={product.aprBasis}>
                      {approx(product.maxApr)}
                    </b>
                    <span>
                      Target structure at {Math.round(product.maxLtv * 100)}%
                      LTV · not live yet
                    </span>
                  </div>
                )}
                <div className="metric">
                  <small>Now (Unified, live)</small>
                  <b className="num">
                    {retired ? (
                      "Closed"
                    ) : now ? (
                      approx(now.apr)
                    ) : activity.failure ? (
                      "—"
                    ) : (
                      <Skel w={90} h={30} />
                    )}
                  </b>
                  <span>
                    {retired
                      ? "Strategy closed, no position"
                      : now
                        ? `${Math.round(now.hedgedShare * 100)}% of NAV hedged · 90-day funding`
                        : "Live hedge × 90-day funding"}
                  </span>
                </div>
                <div className="metric">
                  <small>Vault value (NAV)</small>
                  <b className="num">
                    {seen?.nav.ok ? (
                      <>
                        {usdc(seen.nav.value, decimals)}
                        <em>{symbol}</em>
                      </>
                    ) : navBlocked ? (
                      "Not valued"
                    ) : (
                      <Skel w={110} h={30} />
                    )}
                  </b>
                  <span>Onchain, verifier-priced</span>
                </div>
                <div className="metric">
                  <small>Share price</small>
                  <b className="num">
                    {empty ? (
                      "—"
                    ) : price !== null ? (
                      <span title={fmt(price)}>
                        {fixed(price, decimals, 4)}
                      </span>
                    ) : (
                      <Skel w={100} h={30} />
                    )}
                  </b>
                  <span>
                    {empty ? "No shares yet" : `${symbol} per hvUSDC`}
                  </span>
                </div>
              </div>
            )}
            <div className="metrics-foot">
              <Freshness
                at={seenAt}
                staleAfter={3 * OBSERVE_EVERY}
                source="HyperEVM"
                failed={!!failure}
              />
              {failure && seen && (
                <button
                  className="btn-sm"
                  onClick={() => setTick((n) => n + 1)}
                >
                  Read again
                </button>
              )}
            </div>
            {navBlocked && (
              <p className="inline-warning" role="alert">
                <b>Deposits are closed for now.</b> {blockedText(navBlocked)}
              </p>
            )}
          </section>

          <aside className="vp-side">
            <section className="acct" aria-labelledby="acct-h">
              <header className="acct-head">
                <h2 id="acct-h">Your position</h2>
                {app.account && (
                  <span className="addr">{short(app.account)}</span>
                )}
              </header>
              {!app.account ? (
                <div className="acct-empty">
                  <p>Connect a wallet to see your balance and deposit.</p>
                  <button
                    className="btn primary block"
                    onClick={app.connect}
                    disabled={app.busy}
                  >
                    Connect wallet
                  </button>
                </div>
              ) : walletChain !== null && walletChain !== chain.id ? (
                <div className="acct-empty">
                  <p>
                    Your wallet is on chain {walletChain}. This vault is on{" "}
                    {chain.name}.
                  </p>
                  <button className="btn primary block" onClick={switchNetwork}>
                    Switch to {chain.name}
                  </button>
                </div>
              ) : positionFailure && !position ? (
                <SectionError
                  what="Your balance could not be read."
                  detail={positionFailure}
                  onRetry={() => setPositionTick((n) => n + 1)}
                />
              ) : !position ? (
                <div className="pos">
                  <Skel w={70} h={12} />
                  <Skel w={150} h={34} />
                  <Skel h={14} />
                  <Skel h={14} />
                </div>
              ) : (
                <YourPosition
                  shares={position.shares}
                  price={price}
                  supply={supply}
                  pending={pending}
                  claimNet={position.claimNet}
                  claimShares={position.claimShares}
                  shareDecimals={shareDecimals}
                  decimals={decimals}
                  fmt={fmt}
                  symbol={symbol}
                />
              )}
              <Assets
                app={app}
                only={entry.vault}
                locale="en"
                compact
                operator={isOwner}
                unit={symbol}
                unitDecimals={decimals}
                sharePrice={price}
                shareDecimals={shareDecimals}
                heldShares={position?.shares ?? null}
                claimable={position ? position.claimShares > 0n : false}
                waiting={pending > 0n}
                terms={terms}
                phase={phase}
                note="Unaudited prototype. Deposit only what you can afford to lose."
                positionAt={positionAt}
                lens={entry.lens ? lensAcct : undefined}
                onConfirmed={() => setPositionTick((n) => n + 1)}
              />
              {app.account && entry.fromBlock !== undefined && (
                <AccountHistory
                  vault={entry.vault}
                  user={app.account}
                  fromBlock={entry.fromBlock}
                  decimals={decimals}
                  shareDecimals={shareDecimals}
                  unit={symbol}
                  refresh={positionTick}
                />
              )}
            </section>
          </aside>

          <div className="vp-main">
            {!retired && kind === "USDC" && (
              <StrategyFlow
                live={activity.alloc}
                navUsd={navUsd}
                rates={activity.data?.rates ?? null}
                failed={!!activity.failure && !activity.data}
                current={current}
              />
            )}
            <PositionsSection a={activity} current={current} />
            <ReturnSection vault={entry.vault} sharePrice={sharePriceNum} />
            <ActivitySection a={activity} />
            <details className="fold sec">
              <summary>Contract and onchain details</summary>
              <p className="fresh">
                <a href="#/ops">Operations status</a> ·{" "}
                <a href="#/assets">Owner console</a>
              </p>
              {seen ? (
                <>
                  <p className="fresh">
                    EVM block {seen.block.toString()},{" "}
                    {when(
                      new Date(Number(seen.blockTime) * 1000).toISOString(),
                    )}
                    .
                  </p>
                  <Fields
                    rows={[
                      [
                        "Vault (its HyperCore account)",
                        <code className="address">{entry.vault}</code>,
                      ],
                      [
                        "Owner",
                        owner ? <code className="address">{owner}</code> : "—",
                      ],
                      [
                        `Verifier value (${symbol})`,
                        <Value
                          seen={seen.verifierNav}
                          show={(v) =>
                            `${fmt(v.nav)} at Core block ${v.coreBlock}`
                          }
                        />,
                      ],
                      [
                        `Cash on HyperEVM (${symbol})`,
                        <Value seen={seen.cash} show={fmt} />,
                      ],
                      [
                        `Allocation queue (${symbol})`,
                        <Value seen={seen.queued} show={fmt} />,
                      ],
                      [
                        `Reserved for claims (${symbol})`,
                        <Value seen={seen.reserved} show={fmt} />,
                      ],
                      [
                        "Total shares",
                        <Value
                          seen={seen.supply}
                          show={amount(shareDecimals)}
                        />,
                      ],
                      ...(entry.share
                        ? ([
                            [
                              "Share token (ERC-20)",
                              <code className="address">{entry.share}</code>,
                            ],
                            [
                              `High-water mark (${symbol} per share)`,
                              seen.marks ? (
                                <Value
                                  seen={seen.marks}
                                  show={(m) => fmt(m.highWaterMark)}
                                />
                              ) : (
                                "n/a"
                              ),
                            ],
                          ] as [string, ReactNode][])
                        : []),
                      [
                        "Performance fee",
                        <Value
                          seen={seen.fee}
                          show={(v) =>
                            `${Number(v) / 100}% of share-price gains above the high-water mark, as new shares`
                          }
                        />,
                      ],
                      [
                        `Minimum deposit (${symbol})`,
                        <Value seen={seen.minimum} show={fmt} />,
                      ],
                      [
                        "Last confirmed Core block",
                        <Value seen={seen.lastCoreBlock} show={String} />,
                      ],
                    ]}
                  />
                  <h3 className="sub-h">
                    HyperCore account (read precompiles)
                  </h3>
                  <CoreTable seen={seen} symbol={symbol} />
                  {plan && (
                    <>
                      <h3 className="sub-h">Latest strategy plan</h3>
                      <p className="fresh">
                        {plan.hypothetical
                          ? "Hypothetical input."
                          : plan.mode === "executed"
                            ? "Latest executed plan."
                            : "Latest dry-run plan, nothing sent."}{" "}
                        Observed {when(plan.observedAt)}.
                      </p>
                      <Fields
                        rows={[
                          ...fields(plan.baseExposure),
                          ...fields(plan.extraHedge),
                        ]}
                      />
                    </>
                  )}
                </>
              ) : (
                <Skel h={60} />
              )}
            </details>
          </div>
        </div>
      )}
    </div>
  );
}

function CoreTable({ seen, symbol }: { seen: Observation; symbol: string }) {
  const base = seen.coreToken.ok ? seen.coreToken.value : null;
  const unit = (v: bigint, d: number) => amount(d)(v);
  return (
    <>
      {seen.tokens.ok ? (
        <div className="hv-table-wrap">
          <table className="hv-table">
            <thead>
              <tr>
                <th>Core token</th>
                <th>Spot</th>
                <th>Lending supply</th>
                <th>Lending borrow</th>
                <th>Price (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {seen.tokens.value.values.map((t) => (
                <tr key={t.index}>
                  <th scope="row">{tokenLabel(t.index, base, symbol)}</th>
                  <td>{unit(t.spot, t.weiDecimals)}</td>
                  <td>
                    {t.supply === null ? (
                      <span className="unseen">not in scope</span>
                    ) : (
                      unit(t.supply, t.weiDecimals)
                    )}
                  </td>
                  <td>
                    {t.borrow === null ? (
                      <span className="unseen">not in scope</span>
                    ) : (
                      unit(t.borrow, t.weiDecimals)
                    )}
                  </td>
                  <td>{unit(t.usdcPrice18, 18)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hv-small">
            Core block {seen.tokens.value.coreBlock.toString()}. Only tokens in
            the owner-registered valuation scope are read.
          </p>
        </div>
      ) : (
        <p className="note">
          Core token balances: <Value seen={seen.tokens} show={() => ""} />
        </p>
      )}
      {seen.dexes.ok ? (
        <Fields
          rows={seen.dexes.value.values.map((d) => [
            `Perp account value, DEX ${d.dex === 0 ? "main" : `#${d.dex}`} (USDC)`,
            amount(6)(d.accountValue),
          ])}
        />
      ) : (
        <p className="note">
          Perp account value: <Value seen={seen.dexes} show={() => ""} />
        </p>
      )}
    </>
  );
}

/**
 * The trade panel on a manifest Vault: the Vault is read as `inspectDirect` reads it, and
 * orders still go only through the browser's agent key (`VITE_ENABLE_TRADING`).
 */
function DirectTrade({ app, entry }: { app: Shell; entry: Entry }) {
  const vault = entry.vault;
  const [state, setState] = useState<State | null>(null),
    [failure, setFailure] = useState(""),
    [guarded, setGuarded] = useState<{
      value: Guards | null;
      readAt: number;
    } | null>(null),
    [guardFailure, setGuardFailure] = useState(""),
    [clock, setClock] = useState(Date.now());
  const steady = useRef<Guards | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let alive = true;
    const stop = poll(async () => {
      try {
        const s = await inspectDirect(entry, app.account);
        if (alive) {
          setState(s);
          setFailure("");
        }
      } catch (e) {
        if (alive) setFailure(failureText(e));
      }
    }, STATE_EVERY);
    return () => {
      alive = false;
      stop();
    };
  }, [vault, app.account]);
  useEffect(() => {
    let alive = true;
    const stop = poll(async () => {
      try {
        const value = await inspectGuards(vault, steady.current);
        steady.current = value;
        if (alive) {
          setGuarded({ value, readAt: Date.now() });
          setGuardFailure("");
        }
      } catch (e) {
        if (alive) setGuardFailure(failureText(e));
      }
    }, SCOPE_EVERY);
    return () => {
      alive = false;
      stop();
    };
  }, [vault]);
  const guards: Loaded<Guards | null> | undefined = guarded
    ? { value: guarded.value, fresh: clock - guarded.readAt < FRESH }
    : undefined;
  const fresh = !!state && clock - state.readAt < FRESH;
  const own = !!state && !!app.account && same(app.account, state.owner);
  async function current() {
    const { p, a } = app.wallet();
    await connected(p, a);
    return await inspectDirect(entry, a);
  }
  const view: VaultView | null = state && {
    app,
    vault,
    state,
    viewer: app.account,
    own,
    fresh,
    clock,
    blockWrite: app.busy || !app.canWrite,
    act: (work) =>
      app.run(async () => {
        await work();
        setState(await inspectDirect(entry, app.account));
      }),
    current,
    ownerSend: async (
      fn: string,
      args: readonly unknown[],
      at?: Address,
      abi?: Abi,
    ) => {
      const { p, a } = app.wallet();
      const s = await current();
      if (!same(s.owner, a)) throw new Error("owner 권한 필요");
      return await send(p, a, at ?? vault, fn, args, abi);
    },
    demoApply: () => {
      throw new Error("데모에 없는 볼트입니다.");
    },
  };
  return (
    <section>
      <h2>Owner trading</h2>
      <p className="hv-small">
        Orders are signed by an API wallet key kept encrypted in this browser
        and sent to the Hyperliquid exchange for the vault's Core account. This
        build{" "}
        {import.meta.env.VITE_ENABLE_TRADING === "true"
          ? "sends signed orders"
          : "only shows unsigned previews (VITE_ENABLE_TRADING is off)"}
        . Order results are shown as pending, filled, partially filled, unfilled
        or rejected.
      </p>
      {failure && (
        <p className="inline-warning" role="alert">
          {failure}
        </p>
      )}
      {!state ? (
        !failure && <p className="empty">Reading the vault…</p>
      ) : !own ? (
        <p className="inline-warning">
          Only the vault owner ({short(state.owner)}) can trade.{" "}
          {!app.account && "Connect the owner wallet."}
        </p>
      ) : (
        <div className="workspace vault wide">
          <section className="transaction">
            <Trade
              app={app}
              vault={vault}
              clock={clock}
              view={view}
              guards={guards}
              failure={guardFailure}
            />
          </section>
        </div>
      )}
      <p className="hv-small">
        Status:{" "}
        <StatusBadge status={state ? (fresh ? "ok" : "pending") : "not-run"} />{" "}
        {state &&
          `EVM block ${state.block} · ${state.pending === 0n ? "no Core action pending" : `Core action #${state.pending} awaiting confirmation`}`}
      </p>
    </section>
  );
}

/** A raw amount as a grouped decimal with `digits` places (rounded half up, display only). */
function fixed(raw: bigint, decimals: number, digits: number): string {
  const scale = 10n ** BigInt(Math.max(decimals - digits, 0));
  const v =
    decimals > digits
      ? (raw + scale / 2n) / scale
      : raw * 10n ** BigInt(digits - decimals);
  const s = v.toString().padStart(digits + 1, "0");
  const whole = BigInt(s.slice(0, s.length - digits)).toLocaleString("en-US");
  return digits ? `${whole}.${s.slice(-digits)}` : whole;
}

function YourPosition({
  shares,
  price,
  supply,
  pending,
  claimNet,
  claimShares,
  shareDecimals,
  decimals,
  symbol,
}: {
  shares: bigint;
  /** Base-asset units per whole share, null for an empty vault. */
  price: bigint | null;
  supply: bigint | null;
  pending: bigint;
  claimNet: bigint;
  claimShares: bigint;
  shareDecimals: number;
  decimals: number;
  fmt: (v: bigint) => string;
  symbol: string;
}) {
  // Rounded for reading; the exact amount is the tooltip and the copy button.
  const money = (v: bigint) => fixed(v, decimals, 2);
  const units = (v: bigint) => fixed(v, shareDecimals, 4);
  const exact = (v: bigint, d: number) => amount(d)(v);
  const one = 10n ** BigInt(shareDecimals);
  const value = price !== null ? (shares * price) / one : null;
  const pendingValue = price !== null ? (pending * price) / one : null;
  const ownership =
    supply && supply > 0n ? Number((shares * 1_000_000n) / supply) / 10_000 : 0;
  const [copied, setCopied] = useState(false);
  if (shares === 0n && pending === 0n && claimShares === 0n)
    return (
      <div className="pos">
        <small>Balance</small>
        <b className="pos-value num">
          0.00 <em>{symbol}</em>
        </b>
        <p className="muted-line">You hold no shares in this vault yet.</p>
      </div>
    );
  const copy = () => {
    const text = `${exact(shares, shareDecimals)}`;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="pos">
      <small>Balance</small>
      <b
        className="pos-value num"
        title={
          value !== null ? `${exact(value, decimals)} ${symbol}` : undefined
        }
      >
        {value !== null ? money(value) : "—"} <em>{symbol}</em>
      </b>
      <dl className="pos-rows">
        <div>
          <dt>Shares</dt>
          <dd>
            <span
              className="num"
              title={`${exact(shares, shareDecimals)} hvUSDC`}
            >
              {units(shares)} hvUSDC
            </span>{" "}
            <button
              className="copy"
              onClick={copy}
              aria-label="Copy exact share amount"
              title="Copy exact amount"
            >
              {copied ? <Check weight="bold" /> : <Copy weight="bold" />}
            </button>
          </dd>
        </div>
        <div>
          <dt>Share of vault</dt>
          <dd className="num">{ownership.toFixed(2)}%</dd>
        </div>
        {pending > 0n && (
          <div>
            <dt>Waiting to settle</dt>
            <dd className="num">
              {units(pending)} hvUSDC
              {pendingValue !== null && ` ≈ ${money(pendingValue)} ${symbol}`}
            </dd>
          </div>
        )}
        {claimShares > 0n && (
          <div className="claim">
            <dt>Ready to claim</dt>
            <dd className="num">
              {money(claimNet)} {symbol}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
