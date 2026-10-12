import { useEffect, useState } from "react";
import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import {
  address,
  approve,
  client,
  onTxStage,
  type TxStage,
  read,
  send,
  sourceAbi,
  verifierAbi,
} from "../chain";
import { instantCap, payout, sharesFor } from "../instant";
import {
  BLOCK_TEXT,
  instantFromLens,
  lensAccount,
  type LensAccount,
  type LensBlock,
} from "../lensRead";
import { minShares } from "../slippage";
import { OwnerGuide } from "./OwnerGuide";
import { type Shell } from "../ui";
import {
  assetAmount,
  assetBridgeAbi,
  directVaultOption,
  directVaults,
  assetUnits,
  assetVaultAbi,
  assetVaultIdentity,
  nativeRouterAbi,
} from "../assetVault";

// What the instant path reads and calls; the vault's own ABI file may predate `redeemNow`.
const instantAbi = parseAbi([
  "function phase() view returns (uint8)",
  "function liveNav() view returns (uint256, bool)",
  "function accountant() view returns (address)",
  "function availableCash() view returns (uint256)",
  "function share() view returns (address)",
  "function quote(address, uint256, bool) view returns (uint256, uint256, uint256)",
  "function windowLow(address) view returns (uint256)",
  "function verifier() view returns (address)",
  "function recordPrice(address) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function redeemNow(uint256, address, address, uint256, uint256) returns (uint256)",
  "function INSTANT_EXIT_FEE_BPS() view returns (uint256)",
]);
type Instant = {
  price: bigint;
  shares: bigint;
  assets: bigint;
  /** No share-price record in the window: the vault refuses until one is recorded. */
  needsRecord: boolean;
  /** From the Lens: why nothing can be paid now, when `assets` is zero. */
  reason?: LensBlock;
};

/**
 * The buffer's instant offer to `account`, or null when the vault cannot pay at once now.
 * Two waves of batched reads (one Multicall3 aggregate each): the probe, phase, live NAV, cash,
 * holding and window low, then the accountant's quote at that NAV. Share and accountant come
 * from the reviewed manifest; `INSTANT_EXIT_FEE_BPS` answers only on an implementation with
 * `redeemNow`, so its revert means "no instant path" (no storage or code reads needed).
 */
async function loadInstant(
  e: { vault: Address; share?: Address; accountant?: Address; lens?: Address },
  account: Address,
): Promise<Instant | null> {
  // v6: the Lens answers with redeemNow's own arithmetic in one view call (ADR-041).
  if (e.lens)
    return instantFromLens(await lensAccount(read, e.lens, e.vault, account));
  if (!e.share || !e.accountant) return null;
  const vault = e.vault;
  const [probe, phase, live, cash, held, low] = await Promise.all([
    read<bigint>(vault, "INSTANT_EXIT_FEE_BPS", [], instantAbi).then(
      () => true,
      () => false,
    ),
    read<number>(vault, "phase", [], instantAbi),
    read<readonly [bigint, boolean]>(vault, "liveNav", [], instantAbi),
    read<bigint>(vault, "availableCash", [], instantAbi),
    read<bigint>(e.share, "balanceOf", [account], instantAbi),
    read<bigint>(e.accountant, "windowLow", [vault], instantAbi),
  ]);
  if (!probe || (phase !== 2 && phase !== 4)) return null; // Ready or Active; Idle pays through the request
  const [nav, realized] = live;
  const quote = await read<readonly [bigint, bigint, bigint]>(
    e.accountant,
    "quote",
    [vault, nav, realized],
    instantAbi,
  );
  const needsRecord = !realized && low === 2n ** 256n - 1n;
  return { price: quote[2], needsRecord, ...instantCap(held, cash, quote[2]) };
}

export type Terms = {
  minimum: string | null;
  minimumRaw?: bigint | null;
  fee: string | null;
  capLeft: bigint | null;
};
type Stage = TxStage | null;

/** A typed amount in base units, null when it is not a plain decimal with at most `decimals`. */
function parseAmount(text: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > decimals) return null;
  return BigInt((whole || "0") + frac.padEnd(decimals, "0"));
}

/** Rounded down to 2 decimals for display (the exact amount goes into the field). */
const fixed2 = (raw: bigint, decimals: number) => {
  const cents = decimals >= 2 ? raw / 10n ** BigInt(decimals - 2) : raw * 100n;
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
};

const STEP_LABELS: [string, string][] = [
  ["signing", "Awaiting signature"],
  ["sent", "Sent"],
  ["confirmed", "Confirmed on HyperEVM"],
  ["reflected", "Position updated"],
];

/** Where the visitor's latest transaction stands, from wallet signature to the re-read position. */
function TxProgress({
  stage,
  positionAt,
}: {
  stage: Stage;
  positionAt: number;
}) {
  if (!stage) return null;
  const reflected = stage.stage === "confirmed" && positionAt > stage.at;
  const reached = reflected
    ? 3
    : stage.stage === "confirmed"
      ? 2
      : stage.stage === "sent"
        ? 1
        : 0;
  const hash = stage.stage === "signing" ? null : stage.hash;
  return (
    <div className="txp" role="status" aria-live="polite">
      <ol>
        {STEP_LABELS.map(([id, label], i) => (
          <li
            key={id}
            className={
              i < reached || reflected ? "done" : i === reached ? "now" : ""
            }
          >
            <i aria-hidden />
            {label}
          </li>
        ))}
      </ol>
      <p className="fine">
        {stage.fn}
        {hash && (
          <>
            {" · "}
            <a
              href={`https://hyperevmscan.io/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              {hash.slice(0, 10)}…
            </a>
          </>
        )}
        {stage.stage === "confirmed" &&
          !reflected &&
          " · reading your position again"}
      </p>
    </div>
  );
}

const TEXT = {
  ko: {
    scopeNote:
      "기본 평가 범위는 USDC·기준 자산과 기본 perp 시장입니다. 다른 자산·HIP-3 시장을 거래하려면 평가 범위를 확장해야 합니다.",
    usdcLending: "USDC 대출·공급 장부 포함",
    baseLending: "HYPE·UBTC 대출·공급 장부 포함",
    scope: "기본 평가 범위 등록",
    ownerNote:
      "대기 자금 배정과 Core 회수는 운용자만 실행할 수 있습니다. 회수 전 필요한 포지션 정리·기준 자산 확보를 완료하세요.",
    agentAddress: "Vault 전용 API wallet 주소",
    agent: "API wallet 등록",
    historyNote:
      "운용 중 입금에는 평가 범위 등록과 가격 이력이 필요합니다. 기존 precompile source의 configure·verifier의 recordPrice를 사용합니다.",
    queueAction: "배정 금액 예약",
    cancelAction: "예약 취소",
    executeAction: "예약 배정 실행",
    recallAction: "Core Spot에서 회수",
    exitAction: "출금 정산 시작",
    settleAction: "출금 정산 확정",
    revokeAction: "API wallet 해제",
    manifest:
      "Vault 배포 설정이 올바르지 않습니다. 운영자의 설정 확인이 필요합니다.",
    unlisted: "검토된 Vault 배포 목록에 없는 주소입니다.",
    noNav: "평가 불가 / 입금 제한",
    changedBlock: "구현이 변경된 Vault의 신규 작업은 제한됩니다.",
    upgradeBlock: "업그레이드 대기 중에는 입금할 수 없습니다.",
    zeroShares: "발행될 지분이 0입니다.",
    noShares: "출금 요청할 지분이 없습니다.",
    notClaimable: "정산 후 청구할 수 있습니다.",
    noAction: "진행 중인 Core 작업이 없습니다.",
    sent: "트랜잭션이 완료됐습니다. 상태 조회로 반영 결과를 확인하세요.",
    panel: "입출금·운용",
    inspect: "상태 조회",
    amount: "금액 (이 Vault의 기준 자산 단위)",
    deposit: "입금",
    request: "내 지분 전액 출금 요청",
    claim: "정산된 금액 청구",
    sync: "Core 작업 동기화",
    record: "가격 기록",
    approval: "Vault 입금·출금 위임 승인 취소",
    owner: "운용자 관리",
    summary: (
      symbol: string,
      phase: number,
      nav: string,
      cash: string,
      queued: string,
      owner: string,
      changed: boolean,
      pending: boolean,
    ) =>
      `${symbol} · 상태 ${["미초기화", "활성화 대기", "준비", "현금 보유", "운용 중", "출금 정산 중"][phase]}\nNAV ${nav}\n사용 가능 ${cash} · 배정 큐 ${queued} ${symbol}\n운용자 ${owner}${changed ? "\n구현 변경됨: 신규 입금 제한" : ""}${pending ? "\n업그레이드 대기 중" : ""}`,
  },
  en: {
    scopeNote:
      "The default valuation scope is USDC, the base asset and the main perp DEX. Trading other assets or HIP-3 markets needs a wider scope.",
    usdcLending: "Include the USDC lending ledger",
    baseLending: "Include the HYPE/UBTC lending ledger",
    scope: "Register default valuation scope",
    ownerNote:
      "Only the owner can allocate queued cash and recall from Core. Unwind positions and hold the base asset before a recall.",
    agentAddress: "Vault API wallet address",
    agent: "Register API wallet",
    historyNote:
      "Deposits while active need a registered scope and price history (precompile source configure, verifier recordPrice).",
    queueAction: "Queue allocation",
    cancelAction: "Cancel queued allocation",
    executeAction: "Execute queued allocation",
    recallAction: "Recall from Core spot",
    exitAction: "Begin exit",
    settleAction: "Settle epoch",
    revokeAction: "Revoke API wallet",
    manifest:
      "The vault deployment manifest is invalid. The operator must fix the build settings.",
    unlisted: "This address is not in the reviewed deployment manifest.",
    noNav: "not valued / deposits closed",
    changedBlock:
      "New actions are blocked: the vault's implementation differs from the manifest.",
    upgradeBlock: "Deposits are closed while an upgrade is pending.",
    zeroShares: "This deposit would mint zero shares.",
    noShares: "You hold no shares to redeem.",
    notClaimable:
      "Nothing to claim yet: the request is claimable after settlement.",
    noAction: "No Core action is pending.",
    sent: "Transaction confirmed on HyperEVM. Read the status to see its effect (Core effects arrive in a later Core block).",
    panel: "Deposit · withdraw",
    inspect: "Read status",
    amount: "Amount (in this vault's base asset)",
    deposit: "Deposit",
    request: "Request redeem of all my shares",
    claim: "Claim settled redeem",
    sync: "Confirm pending Core action",
    record: "Record share price",
    approval: "Revoke token approval / router operator",
    owner: "Owner actions",
    summary: (
      symbol: string,
      phase: number,
      nav: string,
      cash: string,
      queued: string,
      owner: string,
      changed: boolean,
      pending: boolean,
    ) =>
      `${symbol} · phase ${["Uninitialized", "Activation pending", "Ready", "Idle (cash on EVM)", "Active", "Settling withdrawals"][phase]}\nNAV ${nav}\nAvailable ${cash} · allocation queue ${queued} ${symbol}\nOwner ${owner}${changed ? "\nImplementation changed: new deposits blocked" : ""}${pending ? "\nUpgrade pending" : ""}`,
  },
};

/**
 * Given `only`, the panel of that one manifest Vault, as the HyperVault vault page shows it, in
 * `locale` (Korean on the owner console, English on the HyperVault pages).
 */
export function Assets({
  app,
  only,
  locale = "ko",
  compact = false,
  unit = "",
  unitDecimals = 6,
  note = "",
  operator = false,
  sharePrice = null,
  shareDecimals = 9,
  heldShares = null,
  claimable = false,
  waiting = false,
  phase = null,
  terms,
  positionAt,
  lens,
  onConfirmed,
}: {
  app: Shell;
  only?: Address;
  locale?: keyof typeof TEXT;
  /** Inside a vault page's account card: Deposit / Withdraw tabs, operator tools folded away. */
  compact?: boolean;
  /** The base asset's symbol, shown in the amount field (compact only). */
  unit?: string;
  unitDecimals?: number;
  /** One line of terms under the deposit button (compact only). */
  note?: string;
  /** Compact only: the connected wallet owns the vault, so operator tools are shown. */
  operator?: boolean;
  /** Compact only: base-asset units per whole share (null for an empty vault). */
  sharePrice?: bigint | null;
  shareDecimals?: number;
  heldShares?: bigint | null;
  claimable?: boolean;
  waiting?: boolean;
  phase?: number | null;
  terms?: Terms;
  /** When the page last read the visitor's position, to mark a confirmed transaction reflected. */
  positionAt?: number;
  /** v6: the account card's Lens read; when given, the withdraw tab reads nothing itself. */
  lens?: LensAccount | null;
  onConfirmed?: () => void;
}) {
  const t = TEXT[locale];
  let entries: ReturnType<typeof directVaults> = [];
  let manifestError = "";
  try {
    entries = directVaults();
  } catch {
    manifestError = t.manifest;
  }
  const [vault, setVault] = useState(only ?? entries[0]?.vault ?? "");
  const [amount, setAmount] = useState("");
  const retired =
    entries.find((e) => e.vault.toLowerCase() === vault.toLowerCase())
      ?.retired === true;
  const [side, setSide] = useState<"deposit" | "withdraw">(
    retired ? "withdraw" : "deposit",
  );
  const [instant, setInstant] = useState<Instant | null>(null);
  const [nowAmount, setNowAmount] = useState("");
  const [instantTick, setInstantTick] = useState(0);
  useEffect(() => {
    if (lens === undefined) return;
    setInstant(
      compact && side === "withdraw" && lens ? instantFromLens(lens) : null,
    );
  }, [lens, compact, side]);
  useEffect(() => {
    if (lens !== undefined) return; // the card's Lens read above answers
    if (!compact || side !== "withdraw" || !app.account || !vault) {
      setInstant(null);
      return;
    }
    let alive = true;
    const listed = entries.find(
      (x) => x.vault.toLowerCase() === vault.toLowerCase(),
    );
    if (!listed) return setInstant(null);
    loadInstant(listed, app.account).then(
      (v) => alive && setInstant(v),
      () => alive && setInstant(null),
    );
    return () => {
      alive = false;
    };
  }, [compact, side, app.account, vault, instantTick, positionAt]);
  // The connected wallet's balance of the vault asset, for the deposit tab (and its Max).
  const [walletBal, setWalletBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!compact || side !== "deposit" || !app.account || !vault) {
      setWalletBal(null);
      return;
    }
    const listed = entries.find(
      (x) => x.vault.toLowerCase() === vault.toLowerCase(),
    );
    if (!listed) return;
    let alive = true;
    const load = () =>
      read<bigint>(listed.asset, "balanceOf", [app.account!], instantAbi).then(
        (b) => alive && setWalletBal(b),
        () => alive && setWalletBal(null),
      );
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [compact, side, app.account, vault, positionAt]);
  const [stage, setStage] = useState<Stage>(null);
  useEffect(() => {
    if (!compact) return;
    return onTxStage((s) => setStage(s));
  }, [compact]);
  const [usdcLending, setUsdcLending] = useState(false);
  const [baseLending, setBaseLending] = useState(false);
  const [agent, setAgent] = useState("");
  const [summary, setSummary] = useState("");
  const disabled = app.demo || app.busy;
  const canWrite = !app.demo && app.canWrite && !app.busy;
  function entry() {
    const found = entries.find(
      (e) => e.vault.toLowerCase() === vault.toLowerCase(),
    );
    if (!found) throw new Error(t.unlisted);
    return found;
  }
  async function inspect() {
    await app.run(async () => {
      const e = entry(),
        v = address(vault);
      const identity = await assetVaultIdentity(e);
      const o = await directVaultOption(e);
      const [phase, cash, queued, owner] = await Promise.all([
        read<number>(v, "phase", [], assetVaultAbi),
        read<bigint>(v, "availableCash", [], assetVaultAbi),
        read<bigint>(v, "queuedAllocation", [], assetVaultAbi),
        read<Address>(v, "owner", [], assetVaultAbi),
      ]);
      let nav = t.noNav;
      try {
        nav =
          assetAmount(
            await read<bigint>(v, "totalAssets", [], assetVaultAbi),
            o.decimals,
          ) +
          " " +
          o.symbol;
      } catch {
        /* a failed NAV is never zero */
      }
      setSummary(
        t.summary(
          o.symbol,
          Number(phase),
          nav,
          assetAmount(cash, o.decimals),
          assetAmount(queued, o.decimals),
          owner,
          identity.changed,
          identity.pending,
        ),
      );
    });
  }
  async function act(kind: string) {
    await app.run(async () => {
      const { p, a } = app.wallet(),
        v = address(vault);
      const e = entry();
      const identity = await assetVaultIdentity(e);
      const o = await directVaultOption(e);
      if (
        identity.changed &&
        kind !== "request" &&
        kind !== "now" &&
        kind !== "record-now" &&
        kind !== "claim" &&
        kind !== "approval"
      )
        throw new Error(t.changedBlock);
      const native = o.kind === 1 && identity.router !== zeroAddress;
      const call = (fn: string, args: readonly unknown[] = []) =>
        send(p, a, v, fn, args, assetVaultAbi);
      if (kind === "record-now") {
        await send(p, a, e.verifier, "recordPrice", [v], instantAbi);
        setInstantTick((n) => n + 1);
      } else if (kind === "now") {
        const offer = await loadInstant(e, a);
        if (offer?.needsRecord)
          throw new Error(
            "Record a share price first (anyone can), then withdraw now.",
          );
        if (!offer || offer.shares === 0n)
          throw new Error(
            (offer?.reason && BLOCK_TEXT[offer.reason]) ||
              "The buffer cannot pay right now: request a withdrawal instead.",
          );
        const shares = sharesFor(
          assetUnits(nowAmount, o.decimals),
          offer.price,
          offer.shares,
        );
        if (shares === 0n) throw new Error("Enter an amount to withdraw now.");
        // The call prices at its own block: 1% below this quote, as for deposits.
        const quoted = payout(shares, offer.price);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
        await send(
          p,
          a,
          v,
          "redeemNow",
          [shares, a, a, (quoted * 99n) / 100n, deadline],
          instantAbi,
        );
        setNowAmount("");
        setInstantTick((n) => n + 1);
      } else if (kind === "deposit") {
        if (identity.pending) throw new Error(t.upgradeBlock);
        const value = assetUnits(amount, o.decimals);
        const quoted = await read<bigint>(
          v,
          "previewDeposit",
          [value],
          assetVaultAbi,
        );
        if (quoted === 0n) throw new Error(t.zeroShares);
        // 1% below the quote: normal NAV drift passes, an abnormal move reverts (see slippage.ts).
        const least = minShares(quoted);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
        if (native)
          await send(
            p,
            a,
            identity.router,
            "depositHype",
            [a, least, deadline],
            nativeRouterAbi,
            value,
          );
        else {
          await approve(p, a, o.asset, v, value);
          await call("depositWithLimit", [value, a, least, deadline]);
        }
      } else if (kind === "request") {
        const shares = await read<bigint>(v, "balanceOf", [a], assetVaultAbi);
        if (shares === 0n) throw new Error(t.noShares);
        await call("requestRedeem", [shares, a, a]);
      } else if (kind === "claim") {
        const shares = await read<bigint>(v, "maxRedeem", [a], assetVaultAbi);
        if (shares === 0n) throw new Error(t.notClaimable);
        if (native && !identity.changed) {
          await call("setOperator", [identity.router, true]);
          const minimum = await read<bigint>(
            v,
            "maxWithdraw",
            [a],
            assetVaultAbi,
          );
          await send(
            p,
            a,
            identity.router,
            "redeemHype",
            [shares, a, minimum, BigInt(Math.floor(Date.now() / 1000) + 300)],
            nativeRouterAbi,
          );
          await call("setOperator", [identity.router, false]);
        } else await call("redeem", [shares, a, a]);
      } else if (kind === "record") {
        await send(p, a, o.template.verifier, "recordPrice", [v], verifierAbi);
      } else if (kind === "scope") {
        const source = await read<Address>(
          o.template.verifier,
          "source",
          [],
          verifierAbi,
        );
        const tokens = [
          { index: 0, usdcSpot: 0, lending: usdcLending, reservePrice: false },
        ];
        if (o.kind !== 0) {
          const index = await read<number>(
            o.bridge,
            "coreToken",
            [],
            assetBridgeAbi,
          );
          const pair = await read<number>(
            o.bridge,
            "spotPair",
            [],
            assetBridgeAbi,
          );
          tokens.push({
            index,
            usdcSpot: pair,
            lending: baseLending,
            reservePrice: true,
          });
        }
        await send(
          p,
          a,
          source,
          "configure",
          [v, tokens, [0], [], true],
          sourceAbi,
        );
      } else if (kind === "approval") {
        await approve(p, a, o.asset, v, 0n);
        if (native) await call("setOperator", [identity.router, false]);
      } else if (kind === "sync") {
        const pending = await read<
          readonly [bigint, string, bigint, number, bigint, Address]
        >(v, "pendingAction", [], assetVaultAbi);
        if (pending[0] === 0n) throw new Error(t.noAction);
        await call("syncCoreAction", [pending[0], "0x"]);
      } else if (kind === "queue")
        await call("queueCoreAllocation", [assetUnits(amount, o.decimals)]);
      else if (kind === "cancel") await call("queueCoreAllocation", [0n]);
      else if (kind === "execute") await call("executeCoreAllocation");
      else if (kind === "recall")
        await call("recallFromCore", [
          4294967295,
          assetUnits(amount, o.decimals),
        ]);
      else if (kind === "agent") await call("setApiWallet", [address(agent)]);
      else if (kind === "revoke") await call("revokeApiWallet");
      else if (kind === "exit" || kind === "settle") {
        const epoch = await read<bigint>(v, "activeEpochId", [], assetVaultAbi);
        await call(
          kind === "exit" ? "beginExit" : "settleEpoch",
          kind === "exit" ? [epoch] : [epoch, "0x"],
        );
      }
      if (compact) onConfirmed?.();
      else app.say(t.sent);
    });
  }
  const ownerDetails = (
    <details>
      <summary>{t.owner}</summary>
      <p>{t.scopeNote}</p>
      <label>
        <input
          type="checkbox"
          checked={usdcLending}
          onChange={(e) => setUsdcLending(e.target.checked)}
        />{" "}
        {t.usdcLending}
      </label>
      <label>
        <input
          type="checkbox"
          checked={baseLending}
          onChange={(e) => setBaseLending(e.target.checked)}
        />{" "}
        {t.baseLending}
      </label>
      <button disabled={!canWrite || !vault} onClick={() => act("scope")}>
        {t.scope}
      </button>
      <p>{t.ownerNote}</p>
      <div className="actions">
        {[
          ["queue", t.queueAction],
          ["cancel", t.cancelAction],
          ["execute", t.executeAction],
          ["recall", t.recallAction],
          ["exit", t.exitAction],
          ["settle", t.settleAction],
          ["revoke", t.revokeAction],
        ].map(([k, label]) => (
          <button
            key={k}
            disabled={!canWrite || !vault}
            onClick={() => act(k!)}
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        {t.agentAddress}
        <input value={agent} onChange={(e) => setAgent(e.target.value)} />
      </label>
      <button disabled={!canWrite || !vault} onClick={() => act("agent")}>
        {t.agent}
      </button>
      <p>{t.historyNote}</p>
    </details>
  );
  if (compact) {
    const parsed = parseAmount(amount, unitDecimals);
    const minimumRaw = terms?.minimumRaw ?? null;
    const depositProblem = !app.account
      ? "Connect a wallet to deposit."
      : !app.canWrite
        ? "Wallet writes are off in this build."
        : app.busy
          ? "A transaction is in progress."
          : !amount
            ? "Enter an amount."
            : parsed === null
              ? `Enter a number with at most ${unitDecimals} decimals.`
              : parsed === 0n
                ? "Enter an amount above zero."
                : walletBal !== null && parsed > walletBal
                  ? `Your wallet holds ${assetAmount(walletBal, unitDecimals)} ${unit}.`
                  : minimumRaw !== null && parsed < minimumRaw
                    ? `The minimum deposit is ${terms?.minimum}.`
                    : terms?.capLeft !== undefined &&
                        terms.capLeft !== null &&
                        parsed > terms.capLeft
                      ? `The vault has room for ${assetAmount(terms.capLeft, unitDecimals)} ${unit} more.`
                      : "";
    // Max: the whole wallet balance, within the vault's remaining room.
    const depositMax =
      walletBal === null
        ? null
        : terms?.capLeft !== undefined &&
            terms.capLeft !== null &&
            terms.capLeft < walletBal
          ? terms.capLeft
          : walletBal;
    const estShares =
      parsed && sharePrice && sharePrice > 0n
        ? (parsed * 10n ** BigInt(shareDecimals)) / sharePrice
        : null;
    const nowParsed = parseAmount(nowAmount, unitDecimals);
    const nowProblem = !nowAmount
      ? "Enter an amount."
      : nowParsed === null
        ? `Enter a number with at most ${unitDecimals} decimals.`
        : instant && nowParsed > instant.assets
          ? `The buffer pays up to ${assetAmount(instant.assets, unitDecimals)} ${unit} now.`
          : !canWrite
            ? app.account
              ? "A transaction is in progress."
              : "Connect a wallet."
            : "";
    const noShares = heldShares !== null && heldShares === 0n;
    const requestProblem = !app.account
      ? "Connect a wallet."
      : noShares
        ? "You hold no shares to withdraw."
        : !canWrite
          ? "A transaction is in progress."
          : "";
    const claimProblem = !app.account
      ? "Connect a wallet."
      : !claimable
        ? waiting
          ? "Your request is waiting for settlement."
          : "Nothing to claim."
        : !canWrite
          ? "A transaction is in progress."
          : "";
    return (
      <div className="acct-actions">
        {manifestError && <p role="alert">{manifestError}</p>}
        <div
          className="seg-tabs full"
          role="tablist"
          aria-label="Deposit or withdraw"
        >
          {(["deposit", "withdraw"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={side === k}
              className={side === k ? "on" : undefined}
              onClick={() => setSide(k)}
            >
              {k === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
        {/* Right under the tabs: visible next to the button that started it, in either tab. */}
        <TxProgress stage={stage} positionAt={positionAt ?? 0} />
        {side === "deposit" && retired ? (
          <p className="muted-line">
            This vault is retired: its strategy is closed and settled. It takes
            no new deposits. Withdraw your shares at any time.
          </p>
        ) : side === "deposit" ? (
          <div className="tab-body">
            <label className="field">
              <span>
                Amount
                {app.account && (
                  <span className="wallet-bal">
                    Wallet{" "}
                    {walletBal === null
                      ? "—"
                      : `${fixed2(walletBal, unitDecimals)} ${unit}`}
                    {depositMax !== null && depositMax > 0n && (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          setAmount(assetAmount(depositMax, unitDecimals))
                        }
                      >
                        Max
                      </button>
                    )}
                  </span>
                )}
              </span>
              <span
                className={`field-row ${amount && parsed === null ? "bad" : ""}`}
              >
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  aria-invalid={!!amount && parsed === null}
                  onChange={(e) => setAmount(e.target.value.trim())}
                />
                <em>{unit}</em>
              </span>
            </label>
            <dl className="terms">
              <div>
                <dt>You receive (est.)</dt>
                <dd className="num">
                  {estShares !== null
                    ? `${assetAmount(estShares, shareDecimals).replace(/(\.\d{4})\d+/, "$1")} hvUSDC`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Minimum deposit</dt>
                <dd className="num">{terms?.minimum ?? "—"}</dd>
              </div>
              <div>
                <dt>Performance fee</dt>
                <dd>
                  {terms?.fee ? `${terms.fee} of gains, high-water mark` : "—"}
                </dd>
              </div>
              <div>
                <dt>Price protection</dt>
                <dd title="The deposit reverts if it would mint more than 1% fewer shares than quoted">
                  1% max slippage
                </dd>
              </div>
            </dl>
            <button
              className="btn primary block"
              disabled={!!depositProblem}
              onClick={() => act("deposit")}
            >
              Deposit
            </button>
            {depositProblem && amount && (
              <p className="reason" role="status">
                {depositProblem}
              </p>
            )}
            {note && <p className="fine">{note}</p>}
          </div>
        ) : (
          <div className="tab-body">
            {instant?.needsRecord && (
              <div className="callout">
                <p>
                  Instant withdrawal needs a share-price record from the last 10
                  minutes. Anyone can record one.
                </p>
                <button
                  className="btn block"
                  disabled={!canWrite}
                  onClick={() => act("record-now")}
                >
                  Record share price
                </button>
              </div>
            )}
            {instant &&
              !instant.needsRecord &&
              instant.assets === 0n &&
              instant.reason &&
              instant.reason !== "None" && (
                <p className="fine">{BLOCK_TEXT[instant.reason]}</p>
              )}
            {instant && !instant.needsRecord && instant.assets > 0n && (
              <>
                <label className="field">
                  <span>
                    Withdraw now
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        setNowAmount(assetAmount(instant.assets, unitDecimals))
                      }
                    >
                      Max {fixed2(instant.assets, unitDecimals)} {unit}
                    </button>
                  </span>
                  <span
                    className={`field-row ${nowAmount && nowParsed === null ? "bad" : ""}`}
                  >
                    <input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={nowAmount}
                      aria-invalid={!!nowAmount && nowParsed === null}
                      onChange={(e) => setNowAmount(e.target.value.trim())}
                    />
                    <em>{unit}</em>
                  </span>
                </label>
                <dl className="terms">
                  <div>
                    <dt>Paid now, from the buffer</dt>
                    <dd className="num">
                      up to {fixed2(instant.assets, unitDecimals)} {unit}
                    </dd>
                  </div>
                  <div>
                    <dt>Exit fee</dt>
                    <dd>0.1%, kept for holders who stay</dd>
                  </div>
                </dl>
                <button
                  className="btn primary block"
                  disabled={!!nowProblem}
                  onClick={() => act("now")}
                >
                  Withdraw now
                </button>
                {nowProblem && nowAmount && (
                  <p className="reason" role="status">
                    {nowProblem}
                  </p>
                )}
                <hr className="rule" />
              </>
            )}
            <div className="queue">
              <b>{instant ? "Withdraw everything" : "Withdraw"}</b>
              <p className="muted-line">
                {instant
                  ? "Requests all your shares. Paid after the operator unwinds and settles, within 72 hours; then claim."
                  : phase === 3
                    ? "The vault is idle: a request redeems all your shares and pays at once."
                    : "Requests all your shares. While the strategy runs it is paid after settlement, within 72 hours; then claim."}
              </p>
              {waiting && (
                <p className="state-line warn" role="status">
                  Your request is waiting for settlement.
                </p>
              )}
              <div className="btn-pair">
                <button
                  className={`btn ${instant && instant.assets > 0n ? "" : "primary"}`}
                  disabled={!!requestProblem}
                  title={requestProblem || undefined}
                  onClick={() => act("request")}
                >
                  Request withdrawal
                </button>
                <button
                  className={`btn ${claimable ? "primary" : ""}`}
                  disabled={!!claimProblem}
                  title={claimProblem || undefined}
                  onClick={() => act("claim")}
                >
                  Claim
                </button>
              </div>
              {app.account && (requestProblem || claimProblem) && (
                <p className="reason">
                  {requestProblem && `Request: ${requestProblem} `}
                  {claimProblem && `Claim: ${claimProblem}`}
                </p>
              )}
            </div>
          </div>
        )}
        {operator && (
          <details className="fold ops-tools">
            <summary>Operator tools (owner only)</summary>
            <div className="actions">
              <button disabled={disabled || !vault} onClick={inspect}>
                {t.inspect}
              </button>
              {[
                ["sync", t.sync],
                ["record", t.record],
                ["approval", t.approval],
              ].map(([k, label]) => (
                <button
                  key={k}
                  disabled={!canWrite || !vault}
                  onClick={() => act(k!)}
                >
                  {label}
                </button>
              ))}
            </div>
            {summary && (
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {summary}
              </pre>
            )}
            {ownerDetails}
          </details>
        )}
      </div>
    );
  }
  return (
    <>
      {!only && <h1>Owner console</h1>}
      {!only && (
        <OwnerGuide
          entry={
            entries.find(
              (e) => e.vault.toLowerCase() === vault.toLowerCase(),
            ) ?? null
          }
        />
      )}
      {manifestError && <p role="alert">{manifestError}</p>}
      {!only && (
        <>
          <p>
            선택한 자산으로 입금·출금하며, 수익과 성과 수수료도 같은 자산
            단위입니다. HYPE는 native로 입출금합니다.
          </p>
          <p>
            플랫폼이 직접 배포한 자산별 Vault입니다. 수익률은 보장되지 않으며
            HYPE·UBTC 수량 기준으로 성과를 평가합니다.
          </p>
        </>
      )}
      {app.demo && (
        <p role="status">
          실제 Vault 조회는 상단에서 읽기 전용 모드로 전환하세요.
        </p>
      )}
      {entries.length === 0 && (
        <p role="status">
          아직 검토된 Vault 배포 주소가 등록되지 않았습니다. 입출금은 배포 목록
          등록 후 사용할 수 있습니다.
        </p>
      )}
      <section className="transaction">
        <div className="form">
          <h2>{t.panel}</h2>
          {!only && (
            <label>
              Vault 선택
              <select
                value={vault}
                disabled={app.busy}
                onChange={(e) => {
                  setVault(e.target.value as Address);
                  setSummary("");
                }}
              >
                {entries.map((e) => (
                  <option value={e.vault} key={e.vault}>
                    {e.name} · {e.vault}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button disabled={disabled || !vault} onClick={inspect}>
            {t.inspect}
          </button>
          {summary && (
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {summary}
            </pre>
          )}
          <label>
            {t.amount}
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <div className="actions">
            {[
              ["deposit", t.deposit],
              ["request", t.request],
              ["claim", t.claim],
              ["sync", t.sync],
              ["record", t.record],
              ["approval", t.approval],
            ].map(([k, label]) => (
              <button
                key={k}
                disabled={!canWrite || !vault}
                onClick={() => act(k!)}
              >
                {label}
              </button>
            ))}
          </div>
          {ownerDetails}
        </div>
      </section>
    </>
  );
}
