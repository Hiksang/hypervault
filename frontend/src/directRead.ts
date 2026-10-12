import { erc20Abi, zeroAddress, type Abi, type Address } from "viem";
import assetVerifierJson from "./abi/ManagedAssetNavVerifier.json";
import accountantJson from "./abi/HyperVaultAccountant.json";
import hyperVaultJson from "./abi/HyperVault.json";
import {
  assetBridgeAbi,
  assetVaultAbi,
  assetVaultIdentity,
  controllerAbi,
} from "./assetVault";
import { blockAndTime, read, revertName, sourceAbi, type State } from "./chain";
import { readCore, type CoreState } from "./coreRead";
import { boundedName } from "./domain";
import type { DirectVault } from "./directVaultManifest";
import { failureText } from "./reasons";

const assetVerifierAbi = assetVerifierJson as Abi;
const accountantAbi = accountantJson as Abi;
const hyperVaultAbi = hyperVaultJson as Abi;
/**
 * The NAV deposits are priced at, reverting when it cannot be verified. v1's `totalAssets` does
 * that itself; v2's `totalAssets` returns the last verified rate instead, so v2 asks `liveNav`.
 */
const liveNav = (e: DirectVault, block?: bigint) =>
  e.share
    ? read<readonly [bigint, boolean]>(
        e.vault,
        "liveNav",
        [],
        hyperVaultAbi,
        block,
      ).then(([assets]) => assets)
    : read<bigint>(e.vault, "totalAssets", [], assetVaultAbi, block);
/** Accountant prices: assets per raw share at 1e30. */
const PRICE_SCALE = 10n ** 30n;

/** A value read, or why it could not be: never a zero standing in for a failed read. */
export type Seen<T> = { ok: true; value: T } | { ok: false; error: string };
const seen = <T>(work: Promise<T>): Promise<Seen<T>> =>
  work.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, error: revertName(e) ?? failureText(e) }),
  );

/**
 * A manifest Vault read as the Factory pages read theirs (`State`), so the trade panel can work
 * on it. Its identity is the manifest's: the controller's record decides `codeChanged`.
 */
export async function inspectDirect(
  e: DirectVault,
  account: Address | null,
): Promise<State> {
  // Unpinned: every read below leaves in one Multicall3 aggregate (one eth_call, one block), and
  // the block number and time come from that same aggregate.
  const block = undefined;
  const head = blockAndTime().then((h) => {
    if (BigInt(Math.floor(Date.now() / 1000)) - h.timestamp > 60n)
      throw new Error("RPC 블록이 오래되었습니다.");
    return h;
  });
  const r = <T>(fn: string, args: readonly unknown[] = []) =>
    read<T>(e.vault, fn, args, assetVaultAbi, block);
  const identityWork = Promise.all([
    assetVaultIdentity(e),
    read<Address>(e.controller, "implementation", [], controllerAbi, block),
    head,
  ]);
  identityWork.catch(() => {}); // awaited below; a failure there is the one reported
  const valuation = liveNav(e, block).then(
    (nav) => ({ nav, closedBy: null as string | null }),
    (err) => {
      const closedBy = revertName(err);
      if (closedBy === null) throw err;
      return { nav: null, closedBy };
    },
  );
  const mine = account
    ? [
        r<bigint>("balanceOf", [account]),
        // v2 has no per-holder cost basis: every share of an epoch is paid the same price.
        e.share ? 0n : r<bigint>("basisUsdc", [account]),
        r<bigint>("controllerRequest", [account]),
        r<bigint>("maxRedeem", [account]),
        r<bigint>("maxWithdraw", [account]),
      ]
    : [0n, 0n, 0n, 0n, 0n];
  const [
    name,
    owner,
    phase,
    pending,
    supply,
    value,
    capacity,
    cash,
    reserved,
    fee,
    minimum,
    epoch,
    agent,
    activation,
    allowance,
    shares,
    basis,
    request,
    claimShares,
    claimNet,
  ] = await Promise.all([
    r<string>("name"),
    r<Address>("owner"),
    r<number>("phase"),
    r<readonly unknown[]>("pendingAction"),
    r<bigint>("totalSupply"),
    valuation,
    r<bigint>("maxDeposit", [account ?? zeroAddress]),
    r<bigint>("availableCash"),
    r<bigint>("reservedClaimAssets"),
    r<bigint>("performanceFeeBps"),
    r<bigint>("minimumDeposit"),
    r<bigint>("activeEpochId"),
    r<Address>("apiWallet"),
    r<bigint>("activationCost"),
    account
      ? read<bigint>(e.asset, "allowance", [account, e.vault], erc20Abi, block)
      : null,
    ...mine,
  ]);
  const [identity, implementation, { number: blockNumber }] =
    await identityWork;
  const now = Date.now();
  return {
    index: 0n,
    name: boundedName(name),
    owner,
    asset: e.asset,
    phase: Number(phase),
    cash,
    reserved,
    supply,
    fee,
    minimum,
    pending: pending[0] as bigint,
    epoch,
    agent,
    account,
    shares: shares as bigint,
    basis: basis as bigint,
    request: request as bigint,
    claimShares: claimShares as bigint,
    claimNet: claimNet as bigint,
    allowance,
    capacity,
    ...value,
    block: blockNumber,
    readAt: now,
    wholeAt: now,
    upgrade: e.controller,
    implementation,
    upgradePending: identity.pending,
    upgradeAt: 0n,
    upgradeTo: zeroAddress,
    codeChanged: identity.changed,
    activation,
  };
}

export type TokenSeen = {
  index: number;
  weiDecimals: number;
  spot: bigint;
  hold: bigint;
  /** Null when the scope does not ask the lending ledger of this token. */
  supply: bigint | null;
  borrow: bigint | null;
  usdcPrice18: bigint;
};
/** What the page can see of a manifest Vault, each part on its own. */
export type Observation = {
  block: bigint;
  blockTime: bigint;
  kind: Seen<number>;
  decimals: Seen<number>;
  coreToken: Seen<number>;
  name: Seen<string>;
  owner: Seen<Address>;
  apiWallet: Seen<Address>;
  phase: Seen<number>;
  nav: Seen<bigint>;
  supply: Seen<bigint>;
  /** Assets per one whole share, in base-asset units. */
  sharePrice: Seen<bigint>;
  shareDecimals: Seen<number>;
  cash: Seen<bigint>;
  queued: Seen<bigint>;
  reserved: Seen<bigint>;
  principal: Seen<bigint>;
  fee: Seen<bigint>;
  /** The platform's part of the performance fee, in basis points of the fee. */
  platformShare: Seen<bigint>;
  minimum: Seen<bigint>;
  maximum: Seen<bigint>;
  coreActivated: Seen<boolean>;
  lastCoreBlock: Seen<bigint>;
  epoch: Seen<bigint>;
  pending: Seen<{
    id: bigint;
    kind: number;
    assets: bigint;
    submittedCoreBlock: bigint;
    agent: Address;
  }>;
  /** The verifier's display value of the whole Vault, in base-asset units, and its Core block. */
  verifierNav: Seen<{ nav: bigint; coreBlock: bigint }>;
  tokens: Seen<{ coreBlock: bigint; values: TokenSeen[] }>;
  dexes: Seen<{
    coreBlock: bigint;
    values: { dex: number; accountValue: bigint }[];
  }>;
  /** The vault's own Core account through the read precompiles (HyperVault USDC only). */
  core: CoreState | null;
  /** v2 only: high-water mark and last published rate, per whole share in base-asset units. */
  marks: Seen<{
    highWaterMark: bigint;
    rate: bigint;
    updatedAt: bigint;
  }> | null;
};

/**
 * A page read sends some thirty requests at once, and the public node answers a burst over its
 * limit with an error, not a revert: such a request is asked once more after a pause.
 */
function ask<T>(...args: Parameters<typeof read>): Promise<T> {
  return read<T>(...args).catch(async (e) => {
    if (revertName(e) !== null) throw e;
    await new Promise((resume) => setTimeout(resume, 1500));
    return read<T>(...args);
  });
}

/** Immutables of a manifest Vault (verifier source, share decimals), asked once a session. */
const once = new Map<string, Promise<unknown>>();
function immutable<T>(key: string, work: () => Promise<T>): Promise<T> {
  let p = once.get(key) as Promise<T> | undefined;
  if (!p) {
    p = work();
    once.set(key, p);
    p.catch(() => once.delete(key));
  }
  return p;
}

export async function observeDirect(e: DirectVault): Promise<Observation> {
  // Unpinned reads issued together: one Multicall3 aggregate3 per wave, read at one block, with
  // that block's number and time inside the same aggregate. After the first poll the
  // immutables are cached and the whole observation is a single eth_call.
  const block = undefined;
  const head = blockAndTime();
  head.catch(() => {}); // awaited below
  const r = <T>(fn: string, args: readonly unknown[] = []) =>
    ask<T>(e.vault, fn, args, assetVaultAbi, block);
  const shareDecimals = immutable(`${e.vault}:decimals`, () =>
    r<number>("decimals").then(Number),
  );
  const source = immutable(`${e.verifier}:source`, () =>
    ask<Address>(e.verifier, "source", [], assetVerifierAbi, block),
  );
  const core = e.share ? readCore(e.vault) : Promise.resolve(null);
  const scope = source.then((at) =>
    ask<readonly [bigint, boolean, readonly unknown[], readonly number[]]>(
      at,
      "scope",
      [e.vault],
      sourceAbi,
      block,
    ),
  );
  const marks = e.accountant
    ? seen(
        Promise.all([
          shareDecimals,
          ask<readonly [bigint, bigint, bigint]>(
            e.accountant,
            "marks",
            [e.vault],
            accountantAbi,
            block,
          ),
        ]).then(([d, [highWaterMark, rate, updatedAt]]) => ({
          highWaterMark: (highWaterMark * 10n ** BigInt(d)) / PRICE_SCALE,
          rate: (rate * 10n ** BigInt(d)) / PRICE_SCALE,
          updatedAt,
        })),
      )
    : Promise.resolve(null);
  const [
    kind,
    decimals,
    coreToken,
    name,
    owner,
    apiWallet,
    phase,
    nav,
    supply,
    sharePrice,
    shareDecimalsSeen,
    cash,
    queued,
    reserved,
    principal,
    fee,
    platformShare,
    minimum,
    maximum,
    coreActivated,
    lastCoreBlock,
    epoch,
    pending,
    verifierNav,
    tokens,
    dexes,
    marksSeen,
  ] = await Promise.all([
    seen(ask<number>(e.bridge, "kind", [], assetBridgeAbi, block).then(Number)),
    seen(
      ask<number>(e.bridge, "assetDecimals", [], assetBridgeAbi, block).then(
        Number,
      ),
    ),
    seen(
      ask<number>(e.bridge, "coreToken", [], assetBridgeAbi, block).then(
        Number,
      ),
    ),
    seen(r<string>("name").then(boundedName)),
    seen(r<Address>("owner")),
    seen(r<Address>("apiWallet")),
    seen(r<number>("phase").then(Number)),
    seen(liveNav(e, block)),
    seen(r<bigint>("totalSupply")),
    seen(
      shareDecimals.then((d) =>
        r<bigint>("convertToAssets", [10n ** BigInt(d)]),
      ),
    ),
    seen(shareDecimals),
    seen(r<bigint>("availableCash")),
    seen(r<bigint>("queuedAllocation")),
    seen(r<bigint>("reservedClaimAssets")),
    seen(r<bigint>("managedPrincipal")),
    seen(r<bigint>("performanceFeeBps")),
    seen(r<bigint>("PLATFORM_SHARE_BPS")),
    seen(r<bigint>("minimumDeposit")),
    seen(r<bigint>("maximumAssets")),
    seen(r<boolean>("coreActivated")),
    seen(r<bigint>("lastConfirmedCoreBlock")),
    seen(r<bigint>("activeEpochId")),
    seen(
      r<readonly [bigint, string, bigint, number, bigint, Address]>(
        "pendingAction",
      ).then(([id, , submittedCoreBlock, kind, assets, agent]) => ({
        id,
        kind: Number(kind),
        assets,
        submittedCoreBlock,
        agent,
      })),
    ),
    seen(
      ask<readonly [bigint, bigint]>(
        e.verifier,
        "nav",
        [e.vault],
        assetVerifierAbi,
        block,
      ).then(([value, coreBlock]) => ({ nav: value, coreBlock })),
    ),
    seen(
      source
        .then((at) =>
          ask<
            readonly [
              bigint,
              readonly {
                index: number;
                weiDecimals: number;
                spot: { total: bigint; hold: bigint };
                lending: {
                  borrow: { value: bigint };
                  supply: { value: bigint };
                };
                lendingQueried: boolean;
                usdcPrice18: bigint;
              }[],
            ]
          >(at, "observeTokens", [e.vault], sourceAbi, block),
        )
        .then(([coreBlock, values]) => ({
          coreBlock,
          values: values.map((t) => ({
            index: Number(t.index),
            weiDecimals: Number(t.weiDecimals),
            spot: t.spot.total,
            hold: t.spot.hold,
            supply: t.lendingQueried ? t.lending.supply.value : null,
            borrow: t.lendingQueried ? t.lending.borrow.value : null,
            usdcPrice18: t.usdcPrice18,
          })),
        })),
    ),
    seen(
      Promise.all([
        scope,
        source.then((at) =>
          ask<readonly [bigint, readonly { accountValue: bigint }[]]>(
            at,
            "observeDexes",
            [e.vault],
            sourceAbi,
            block,
          ),
        ),
      ]).then(([s, [coreBlock, values]]) => ({
        coreBlock,
        values: values.map((v, i) => ({
          dex: Number(s[3][i] ?? i),
          accountValue: v.accountValue,
        })),
      })),
    ),
    marks,
  ]);
  const [{ number, timestamp }, coreSeen] = await Promise.all([head, core]);
  return {
    block: number,
    blockTime: timestamp,
    core: coreSeen,
    kind,
    decimals,
    coreToken,
    name,
    owner,
    apiWallet,
    phase,
    nav,
    supply,
    sharePrice,
    shareDecimals: shareDecimalsSeen,
    cash,
    queued,
    reserved,
    principal,
    fee,
    platformShare,
    minimum,
    maximum,
    coreActivated,
    lastCoreBlock,
    epoch,
    pending,
    verifierNav,
    tokens,
    dexes,
    marks: marksSeen,
  };
}
