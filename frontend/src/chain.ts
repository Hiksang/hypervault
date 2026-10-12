import { batchSafeFetch } from "./batchSafeFetch";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import assetVaultJson from "./abi/ManagedAssetVault.json";
import assetFactoryJson from "./abi/ManagedAssetVaultFactory.json";
import assetBridgeJson from "./abi/ManagedAssetBridge.json";
import assetVerifierJson from "./abi/ManagedAssetNavVerifier.json";
import vaultJson from "./abi/ManagedUsdcVault.json";
import factoryJson from "./abi/ManagedUsdcVaultFactory.json";
import sourceJson from "./abi/HyperCorePrecompileSource.json";
import verifierJson from "./abi/ManagedPortfolioNavVerifier.json";
import type { Scope } from "./hyperliquid/info";
import { boundedName } from "./domain";
import { callAnswered, contractFault, errorText, revertName } from "./errors";
import { chainIdOf, rpcUrl, ensureChain } from "./network";
import { failureText, vaultFailure } from "./reasons";
export { errorText, revertName };
import {
  codeDiffers,
  vaultAddressAt,
  vaultContractsAt,
  vaultIndexOf,
} from "./addresses";
export { vaultAddressAt, vaultContractsAt, vaultIndexOf };
export const vaultAbi = vaultJson as Abi,
  factoryAbi = factoryJson as Abi,
  sourceAbi = sourceJson as Abi,
  verifierAbi = verifierJson as Abi;
export const writesEnabled = import.meta.env.VITE_ENABLE_WRITES === "true";
const chainId = chainIdOf(import.meta.env.VITE_CHAIN_ID);
if (chainId === null) throw new Error("지원하지 않는 chain ID");
// Canonical Multicall3, deployed on HyperEVM mainnet and testnet (checked 2026-10-12); a local
// Anvil node has none, so reads there stay one request each.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const chain = defineChain({
  id: chainId,
  name:
    chainId === 999
      ? "HyperEVM"
      : chainId === 998
        ? "HyperEVM Testnet"
        : "Local Anvil",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl(chainId, import.meta.env.VITE_RPC_URL)] },
  },
  ...(chainId === 31337
    ? {}
    : { contracts: { multicall3: { address: MULTICALL3 } } }),
});
export const client = createPublicClient({
  chain,
  // eth_calls within 50ms go out as Multicall3 aggregate3 calls with allowFailure, so each read
  // still succeeds or reverts on its own; those aggregates and any other request within 50ms then
  // share one HTTP POST (a JSON-RPC batch array, which the HyperEVM nodes accept). An aggregate
  // stays at viem's 1 KB of calldata: the node caps eth_call gas, and the precompile-backed views
  // (NAV, scope observations) cost up to ~250k each, so one aggregate of a whole page reverts.
  transport: http(undefined, {
    timeout: 15000,
    retryCount: 1,
    batch: chainId === 31337 ? false : { wait: 50 },
    fetchFn: batchSafeFetch,
  }),
  batch: {
    multicall: chainId === 31337 ? false : { wait: 50, batchSize: 65_536 },
  },
  // A Vault is an upgradeable proxy anyone can deploy: its reads must not be able to make the
  // browser fetch a URL of the operator's choosing (EIP-3668 offchain lookup).
  ccipRead: false,
});
const multicallAbi = parseAbi([
  "function getBlockNumber() view returns (uint256)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
]);
/**
 * The block an aggregate is read at, asked inside the same Multicall3 batch as the reads it
 * dates (one aggregate3 is one eth_call, so one block), instead of a separate eth_getBlock.
 * A local Anvil node has no Multicall3: there it falls back to the block header.
 */
export async function blockAndTime(): Promise<{
  number: bigint;
  timestamp: bigint;
}> {
  if (chain.id === 31337) {
    const head = await client.getBlock({ blockTag: "latest" });
    return { number: head.number, timestamp: head.timestamp };
  }
  const [number, timestamp] = await Promise.all([
    client.readContract({
      address: MULTICALL3,
      abi: multicallAbi,
      functionName: "getBlockNumber",
    }),
    client.readContract({
      address: MULTICALL3,
      abi: multicallAbi,
      functionName: "getCurrentBlockTimestamp",
    }),
  ]);
  return { number, timestamp };
}
export function address(value: string): Address {
  if (!isAddress(value)) throw new Error("Enter a valid EVM address.");
  return getAddress(value);
}
// A revert raised inside another contract keeps that contract's error: a Vault call can fail with
// the verifier's `PriceDropCooldown` or the source's `OpenReport`. Every call is therefore decoded
// with the errors of all four ABIs, so the reason is named instead of shown as a selector.
const errors = [
  ...new Map(
    [
      ...vaultAbi,
      ...factoryAbi,
      ...verifierAbi,
      ...sourceAbi,
      ...(assetVaultJson as Abi),
      ...(assetFactoryJson as Abi),
      ...(assetBridgeJson as Abi),
      ...(assetVerifierJson as Abi),
    ]
      .filter((item) => item.type === "error")
      .map((item) => [JSON.stringify([item.name, item.inputs]), item]),
  ).values(),
];
const withErrors = (abi: Abi): Abi => [
  ...abi.filter((item) => item.type !== "error"),
  ...errors,
];
export async function read<T>(
  at: Address,
  fn: string,
  args: readonly unknown[] = [],
  abi: Abi = vaultAbi,
  blockNumber?: bigint,
): Promise<T> {
  return (await client.readContract({
    address: at,
    abi: withErrors(abi),
    functionName: fn,
    args,
    blockNumber,
  })) as T;
}
// The default node allows an address 100 requests a minute, which the wallet and every other tab
// share. What cannot change is therefore asked once a session, and what a page shows is read in
// two parts (see `inspect`).
const answers = new Map<string, Promise<unknown>>();
/**
 * A read whose answer cannot change, because it is an immutable of a contract that cannot be
 * upgraded (the Factory, the verifier). Asked once, and again only if the request failed.
 */
function fixed<T>(at: Address, fn: string, abi: Abi): Promise<T> {
  const key = `${at.toLowerCase()}:${fn}`;
  let answer = answers.get(key) as Promise<T> | undefined;
  if (!answer) {
    answer = read<T>(at, fn, [], abi).catch((e) => {
      answers.delete(key);
      throw e;
    });
    answers.set(key, answer);
  }
  return answer;
}
let chainAsked: Promise<void> | undefined;
/** The node's chain is asked once: the build fixes the RPC. A wrong or failed answer is asked again. */
function rightChain(): Promise<void> {
  return (chainAsked ??= client
    .getChainId()
    .then((id) => {
      if (id !== chain.id)
        throw new Error("RPC chain does not match the configured chain.");
    })
    .catch((e) => {
      chainAsked = undefined;
      throw e;
    }));
}
// The Factory registers a Vault once and for good, at an index that never changes.
const places = new Map<string, bigint>();
const placeKey = (factory: Address, vault: Address) =>
  `${factory}:${vault}`.toLowerCase();
/** Where a Vault stands in its Factory. Throws when the Factory does not know it. */
async function placeOf(factory: Address, vault: Address, blockNumber: bigint) {
  const deployer = await fixed<Address>(factory, "deployer", factoryAbi);
  const key = placeKey(factory, vault);
  let index = places.get(key);
  if (index === undefined) {
    if (
      !(await read<boolean>(
        factory,
        "isVault",
        [vault],
        factoryAbi,
        blockNumber,
      ))
    )
      throw new Error("이 Factory에 등록된 Vault가 아닙니다.");
    const found = vaultIndexOf(
      deployer,
      vault,
      await read<bigint>(factory, "vaultCount", [], factoryAbi, blockNumber),
    );
    if (found === null)
      throw new Error(
        "Factory의 Vault 주소 규칙으로 이 Vault를 찾지 못했습니다.",
      );
    places.set(key, (index = found));
  }
  const template = await fixed<{ asset: Address }>(
    factory,
    "templateConfig",
    factoryAbi,
  );
  return { deployer, index, asset: template.asset };
}
// Read from the controller the deployer created for the Vault, never from an address the Vault
// itself names.
const controllerAbi = [
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "pending",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "executeAfter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "proposedImplementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;
/**
 * Whether the Vault still runs the code it was created with, and whether an upgrade is proposed.
 * A Vault is an upgradeable proxy: after an upgrade nothing it says about itself (its asset, its
 * owner, its NAV, even its controller) can be taken at its word, and `isVault` stays true. The
 * controller is not upgradeable and records the implementation, so the question is put to it.
 * It does not record how often the code changed: a Vault upgraded and later set back to its
 * first implementation reads as unchanged.
 */
async function codeState(
  deployer: Address,
  index: bigint,
  blockNumber: bigint,
) {
  const made = vaultContractsAt(deployer, index);
  const ask = <T>(fn: string) =>
    read<T>(made.controller, fn, [], controllerAbi, blockNumber);
  const [implementation, upgradePending] = await Promise.all([
    ask<Address>("implementation"),
    ask<boolean>("pending"),
  ]);
  return {
    upgrade: made.controller,
    implementation,
    first: made.implementation,
    upgradePending,
  };
}
/** What a proposed upgrade would install and when. Asked only while one is proposed. */
async function proposal(controller: Address, blockNumber: bigint) {
  const ask = <T>(fn: string) =>
    read<T>(controller, fn, [], controllerAbi, blockNumber);
  const [upgradeAt, upgradeTo] = await Promise.all([
    ask<bigint>("executeAfter"),
    ask<Address>("proposedImplementation"),
  ]);
  return { upgradeAt, upgradeTo };
}
export type State = {
  /** The Vault's place in its Factory, from 1. */
  index: bigint;
  name: string;
  owner: Address;
  /** The Factory's asset: the only token this page ever asks a wallet to approve. */
  asset: Address;
  phase: number;
  cash: bigint;
  reserved: bigint;
  supply: bigint;
  fee: bigint;
  minimum: bigint;
  pending: bigint;
  epoch: bigint;
  agent: Address;
  /**
   * The account the next five values and `allowance` were read for. Null when no wallet is
   * connected: nothing was asked then, and the five are zero.
   */
  account: Address | null;
  shares: bigint;
  basis: bigint;
  request: bigint;
  claimShares: bigint;
  claimNet: bigint;
  /**
   * What `account` has approved this Vault to take of the Factory's asset. An approval outlives
   * the deposit it was given for when that deposit does not confirm, and an upgrade hands it to
   * the new code.
   */
  allowance: bigint | null;
  capacity: bigint;
  nav: bigint | null;
  /** The contract error `totalAssets` reverted with when there is no NAV. */
  closedBy: string | null;
  block: bigint;
  /** When the part that decides a deposit was last read, and when the whole Vault was (ms). */
  readAt: number;
  wholeAt: number;
  /** The controller the deployer created for this Vault. */
  upgrade: Address;
  /** The implementation that controller records. */
  implementation: Address;
  upgradePending: boolean;
  /** When a proposed upgrade can be executed (unix seconds), or zero. */
  upgradeAt: bigint;
  /** The implementation a proposed upgrade would install, or the zero address. */
  upgradeTo: Address;
  /**
   * The Vault no longer runs the code it was created with, or does not answer like it. Nothing
   * else in this state can then be relied on, and the page offers no deposit.
   */
  codeChanged: boolean;
  activation: bigint;
};
/**
 * What is known about a Vault without taking its word: its place in the Factory, what its
 * controller records, and what the account approved for it. `codeChanged` is here the
 * controller's record alone.
 */
export type Standing = Pick<
  State,
  | "index"
  | "asset"
  | "upgrade"
  | "implementation"
  | "upgradePending"
  | "upgradeAt"
  | "upgradeTo"
  | "codeChanged"
  | "account"
  | "allowance"
  | "block"
  | "readAt"
>;
/**
 * A Vault whose own reads failed. What its controller records is known all the same: a Vault
 * that stops answering after an upgrade must not lose the mark of it. The message is a line for
 * the screen, and never the words of a Vault whose code changed.
 */
export class VaultFault extends Error {
  readonly standing: Standing;
  constructor(standing: Standing, reason: unknown) {
    super(failureText(vaultFailure(reason, standing.codeChanged)), {
      cause: reason,
    });
    this.standing = standing;
  }
}
/**
 * A whole read of a Vault is good for this long (ms): a little under a minute, so that of reads
 * made every fifteen seconds each fourth is a whole one, whichever way the timer drifts.
 */
export const WHOLE_EVERY = 55_000;
/**
 * Reads a Vault for an account. Given `previous`, the last read for the same account, only what
 * decides a deposit is asked again (the code the controller records, phase, pending action,
 * supply, valuation and capacity) until a whole read is `WHOLE_EVERY` old or one of those moved.
 * Everything in one read is of one block.
 */
export async function inspect(
  factory: Address,
  vault: Address,
  account: Address | null,
  previous?: State | null,
): Promise<State> {
  await rightChain();
  const head = await client.getBlock({ blockTag: "latest" });
  if (BigInt(Math.floor(Date.now() / 1000)) - head.timestamp > 60n)
    throw new Error("RPC block is stale.");
  const block = head.number;
  const { deployer, index, asset } = await placeOf(factory, vault, block);
  const code = await codeState(deployer, index, block);
  const proposed = code.upgradePending
    ? await proposal(code.upgrade, block)
    : { upgradeAt: 0n, upgradeTo: zeroAddress };
  const r = <T>(fn: string, args: readonly unknown[] = []) =>
    read<T>(vault, fn, args, vaultAbi, block);
  const approved = () =>
    account
      ? read<bigint>(asset, "allowance", [account, vault], erc20Abi, block)
      : null;
  const standing = {
    index,
    asset,
    upgrade: code.upgrade,
    implementation: code.implementation,
    upgradePending: code.upgradePending,
    ...proposed,
    account,
    block,
  };
  try {
    const [phase, pending, supply, valuation, capacity] = await Promise.all([
      r<number>("phase"),
      r<readonly unknown[]>("pendingAction"),
      r<bigint>("totalSupply"),
      // Only a revert means "not valued". A failed request fails the whole read instead.
      r<bigint>("totalAssets").then(
        (nav) => ({ nav, closedBy: null }),
        (e) => {
          const closedBy = revertName(e);
          if (closedBy === null) throw e;
          return { nav: null, closedBy };
        },
      ),
      r<bigint>("maxDeposit", [account ?? zeroAddress]),
    ]);
    const moving = {
      phase,
      pending: pending[0] as bigint,
      supply,
      ...valuation,
      capacity,
    };
    if (
      previous &&
      previous.account === account &&
      previous.implementation === code.implementation &&
      previous.phase === moving.phase &&
      previous.pending === moving.pending &&
      previous.supply === moving.supply &&
      previous.upgradePending === code.upgradePending &&
      Date.now() - previous.wholeAt < WHOLE_EVERY
    )
      return { ...previous, ...standing, ...moving, readAt: Date.now() };
    const [
      name,
      owner,
      answeredAsset,
      cash,
      reserved,
      fee,
      minimum,
      epoch,
      agent,
      upgrade,
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
      r<Address>("asset"),
      r<bigint>("availableCash"),
      r<bigint>("reservedClaimAssets"),
      r<bigint>("performanceFeeBps"),
      r<bigint>("minimumDeposit"),
      r<bigint>("activeEpochId"),
      r<Address>("apiWallet"),
      r<Address>("upgradeController"),
      r<bigint>("activationCost"),
      approved(),
      ...(account
        ? [
            r<bigint>("balanceOf", [account]),
            r<bigint>("basisUsdc", [account]),
            r<bigint>("controllerRequest", [account]),
            r<bigint>("maxRedeem", [account]),
            r<bigint>("maxWithdraw", [account]),
          ]
        : [0n, 0n, 0n, 0n, 0n]),
    ]);
    const now = Date.now();
    return {
      ...standing,
      ...moving,
      // A name is whatever the Vault answers: it is shown and stored only as long as one may be.
      name: boundedName(name),
      owner,
      cash,
      reserved,
      fee,
      minimum,
      epoch,
      agent,
      shares,
      basis,
      request,
      claimShares,
      claimNet,
      allowance,
      readAt: now,
      wholeAt: now,
      codeChanged: codeDiffers({
        implementation: code.implementation,
        first: code.first,
        asset: answeredAsset,
        templateAsset: asset,
        controller: upgrade,
        madeController: code.upgrade,
        name,
      }),
      activation,
    };
  } catch (e) {
    throw new VaultFault(
      {
        ...standing,
        codeChanged: codeDiffers({
          implementation: code.implementation,
          first: code.first,
        }),
        // What stays approved matters most for a Vault that no longer answers: it is asked of
        // the asset, not of the Vault. Null says it could not be read.
        allowance: await Promise.resolve(approved()).catch(() => null),
        readAt: Date.now(),
      },
      e,
    );
  }
}
/** Put the wallet on this build's chain, adding the chain to the wallet first if needed. */
/** The one call `ensureChain` needs from any EIP-1193 provider (viem's or the page's own type). */
type Requester = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
export function switchToChain(provider: object): Promise<boolean> {
  const p = provider as Requester;
  return ensureChain(
    (args) => p.request(args),
    chain.id,
    import.meta.env.VITE_RPC_URL,
  );
}
export async function connected(provider: EIP1193Provider, expected?: Address) {
  const id = await provider.request({ method: "eth_chainId" });
  const accounts = await provider.request({ method: "eth_accounts" });
  if (Number(id) !== chain.id)
    throw new Error(`Switch your wallet to ${chain.name} (${chain.id}).`);
  if (
    !accounts[0] ||
    (expected && accounts[0].toLowerCase() !== expected.toLowerCase())
  )
    throw new Error("Wallet account changed. Connect again.");
  return getAddress(accounts[0]);
}
/**
 * Where the latest wallet transaction stands, for the page to show: the wallet is asked to
 * sign, the transaction is sent (hash known), then confirmed on HyperEVM. Display only.
 */
export type TxStage =
  | { stage: "signing"; fn: string }
  | { stage: "sent"; fn: string; hash: `0x${string}` }
  | { stage: "confirmed"; fn: string; hash: `0x${string}`; at: number };
const stageListeners = new Set<(s: TxStage) => void>();
export function onTxStage(listener: (s: TxStage) => void): () => void {
  stageListeners.add(listener);
  return () => void stageListeners.delete(listener);
}
const emitStage = (s: TxStage) => stageListeners.forEach((l) => l(s));

export async function send(
  provider: EIP1193Provider,
  account: Address,
  at: Address,
  fn: string,
  args: readonly unknown[] = [],
  abi: Abi = vaultAbi,
  value = 0n,
) {
  if (!writesEnabled)
    throw new Error(
      "현재 읽기 전용 설정입니다. 검토한 배포에 VITE_ENABLE_WRITES=true를 설정하세요.",
    );
  await connected(provider, account);
  if ((await client.getChainId()) !== chain.id)
    throw new Error("RPC chain mismatch");
  const simulation = await client.simulateContract({
    account,
    address: at,
    abi: withErrors(abi),
    functionName: fn,
    args,
    value,
  });
  await connected(provider, account);
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  emitStage({ stage: "signing", fn });
  const hash = await wallet.writeContract(simulation.request);
  emitStage({ stage: "sent", fn, hash });
  // A wallet can cancel a pending transaction or swap it for another: the receipt that comes
  // back is then not this call's, whatever its status says.
  let swapped = false;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => {
      swapped = replacement.reason !== "repriced";
    },
  });
  if (swapped)
    throw new Error(
      "지갑에서 이 거래가 취소되었거나 다른 거래로 바뀌었습니다. 상태를 확인한 뒤 다시 시도하세요.",
    );
  if (receipt.status !== "success") throw new Error("Transaction reverted.");
  emitStage({ stage: "confirmed", fn, hash, at: Date.now() });
  return receipt;
}
/** Sets what `spender` may take of `token` to `amount`; zero takes an approval back. */
export async function approve(
  provider: EIP1193Provider,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<boolean> {
  const allowance = await read<bigint>(
    token,
    "allowance",
    [account, spender],
    erc20Abi,
  );
  // Exactly the amount, never more: what is left of a larger approval stays with the spender,
  // whatever code it runs later. False when nothing had to be sent.
  if (allowance === amount) return false;
  // Some tokens refuse to change one approval into another: it is taken back first.
  if (allowance > 0n && amount > 0n)
    await send(provider, account, token, "approve", [spender, 0n], erc20Abi);
  await send(provider, account, token, "approve", [spender, amount], erc20Abi);
  return true;
}
export function createdVault(
  logs: Parameters<typeof parseEventLogs>[0]["logs"],
): Address {
  const parsed = parseEventLogs({
    abi: factoryAbi,
    eventName: "VaultCreated",
    logs,
  });
  const args = parsed[0]?.args as { vault?: Address } | undefined;
  if (!args?.vault)
    throw new Error(
      "생성 이벤트를 확인하지 못했습니다. 거래 내역을 확인하세요.",
    );
  return args.vault;
}
// The Factory keeps a count but no list. Its deployer creates every Vault with CREATE, so the
// addresses follow from the deployer's nonces (`vaultContractsAt`).
export type VaultSummary = {
  address: Address;
  index: bigint;
  name: string;
  owner: Address;
  phase: number;
  supply: bigint;
  fee: bigint;
  minimum: bigint;
  /** Shareholder assets, or null when no valuation is available. */
  nav: bigint | null;
  /** False when the value comes from the verifier's display read while deposits are closed. */
  depositsPriced: boolean;
  /** The contract error that closes deposits, when they are not priced. */
  closedBy: string | null;
  /**
   * The Vault no longer runs the code it was created with: what it says is not relied on. Null
   * when its controller could not be asked.
   */
  codeChanged: boolean | null;
  /** An upgrade is proposed: the code changes when its owner executes it. Null as above. */
  upgradePending: boolean | null;
  /**
   * Why this Vault could not be read, when it reverted or answered nonsense: one such Vault
   * must not take the list down with it. The fields it would have answered are then empty, and
   * the words of a Vault whose code changed are never among the reasons.
   */
  unreadable: string | null;
  /**
   * Why the request for this Vault failed, when it was the request (the node, the network).
   * That says nothing about the Vault: the row is to be read again.
   */
  missed: string | null;
};
/**
 * NAV for display: the Vault's own value when it prices deposits, else the verifier's read. Only
 * a contract's revert counts as "closed" or "not valued": a request that failed is thrown.
 */
async function displayNav(vault: Address, blockNumber: bigint) {
  try {
    return {
      nav: await read<bigint>(vault, "totalAssets", [], vaultAbi, blockNumber),
      depositsPriced: true,
      closedBy: null,
    };
  } catch (e) {
    const closedBy = revertName(e);
    if (closedBy === null) throw e;
    try {
      const verifier = await read<Address>(
        vault,
        "verifier",
        [],
        vaultAbi,
        blockNumber,
      );
      const [nav] = await read<readonly [bigint, bigint]>(
        verifier,
        "nav",
        [vault],
        verifierAbi,
        blockNumber,
      );
      return { nav, depositsPriced: false, closedBy };
    } catch (inner) {
      if (revertName(inner) === null) throw inner;
      return { nav: null, depositsPriced: false, closedBy };
    }
  }
}
/** Newest first. `before` is the index to continue below (exclusive); omit it for the first page. */
export async function listVaults(
  factory: Address,
  count = 10,
  before?: bigint,
): Promise<{ total: bigint; vaults: VaultSummary[] }> {
  await rightChain();
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [total, deployer] = await Promise.all([
    read<bigint>(factory, "vaultCount", [], factoryAbi, blockNumber),
    fixed<Address>(factory, "deployer", factoryAbi),
  ]);
  const vaults: VaultSummary[] = [];
  const start =
    before === undefined || before > total + 1n ? total : before - 1n;
  for (let index = start; index >= 1n && vaults.length < count; index--) {
    const vault = vaultAddressAt(deployer, index);
    const key = placeKey(factory, vault);
    if (!places.has(key)) {
      if (
        !(await read<boolean>(
          factory,
          "isVault",
          [vault],
          factoryAbi,
          blockNumber,
        ))
      )
        throw new Error("Factory의 Vault 주소 규칙이 예상과 다릅니다.");
      places.set(key, index);
    }
    const empty = {
      address: vault,
      index,
      name: "",
      owner: zeroAddress,
      phase: 0,
      supply: 0n,
      fee: 0n,
      minimum: 0n,
      nav: null,
      depositsPriced: false,
      closedBy: null,
      unreadable: null,
      missed: null,
    };
    // The controller is asked first and apart: whatever the Vault then does, the row keeps what
    // the controller records of its code.
    let code: Awaited<ReturnType<typeof codeState>>;
    try {
      code = await codeState(deployer, index, blockNumber);
    } catch (e) {
      vaults.push(
        contractFault(e)
          ? {
              ...empty,
              codeChanged: true,
              upgradePending: null,
              unreadable:
                "이 볼트의 upgrade controller가 답하지 않아 코드를 확인할 수 없습니다.",
            }
          : {
              ...empty,
              codeChanged: null,
              upgradePending: null,
              missed: failureText(e),
            },
      );
      continue;
    }
    const marks = {
      codeChanged: codeDiffers({
        implementation: code.implementation,
        first: code.first,
      }),
      upgradePending: code.upgradePending,
    };
    const r = <T>(fn: string) => read<T>(vault, fn, [], vaultAbi, blockNumber);
    try {
      const [name, owner, phase, supply, fee, minimum, value] =
        await Promise.all([
          r<string>("name"),
          r<Address>("owner"),
          r<number>("phase"),
          r<bigint>("totalSupply"),
          r<bigint>("performanceFeeBps"),
          r<bigint>("minimumDeposit"),
          displayNav(vault, blockNumber),
        ]);
      vaults.push({
        ...empty,
        name: boundedName(name),
        owner,
        phase,
        supply,
        fee,
        minimum,
        ...value,
        ...marks,
        codeChanged: codeDiffers({
          implementation: code.implementation,
          first: code.first,
          name,
        }),
      });
    } catch (e) {
      // A Vault whose code changed halts as easily as it reverts, and a node words a halt as a
      // refusal of its own: only a request that got no answer is kept apart from that Vault.
      const itsDoing = marks.codeChanged ? callAnswered(e) : contractFault(e);
      vaults.push({
        ...empty,
        ...marks,
        ...(itsDoing
          ? { unreadable: failureText(vaultFailure(e, marks.codeChanged)) }
          : { missed: failureText(e) }),
      });
    }
  }
  return { total, vaults };
}
export type ScopeReport = {
  index: number;
  kind: "token" | "dex" | "coreVault";
  id: number;
  coreVault: Address;
  expiresAt: bigint;
};
export type PriceRecord = { price: bigint; time: bigint };
/** What the precompile verifier holds for a Vault: its registered scope and issuance guards. */
export type Guards = {
  verifier: Address;
  source: Address;
  scope: Scope;
  reports: ScopeReport[];
  records: PriceRecord[];
  /** When the owner last answered a report by registering its venue (0: never). */
  answeredAt: bigint;
  priceWindow: bigint;
  maxDrawdownBps: bigint;
  builder: Address;
  builderFeeCap: bigint;
  block: bigint;
  blockTime: bigint;
};
const REPORT_KINDS = ["token", "dex", "coreVault"] as const;
/**
 * Null when the Vault's verifier is not the precompile verifier (its reads do not answer). What
 * the Vault's code fixes (its verifier and builder) is taken from `previous`, the last read,
 * when one is given: the caller gives none once the Vault's code has changed.
 */
export async function inspectGuards(
  vault: Address,
  previous?: Guards | null,
): Promise<Guards | null> {
  const block = await client.getBlock({ blockTag: "latest" });
  const at = block.number;
  const [verifier, builder, builderFeeCap] = previous
    ? [previous.verifier, previous.builder, previous.builderFeeCap]
    : await Promise.all([
        read<Address>(vault, "verifier", [], vaultAbi, at),
        read<Address>(vault, "builder", [], vaultAbi, at),
        read<bigint>(vault, "builderFeeCap", [], vaultAbi, at),
      ]);
  let source: Address;
  try {
    source = await fixed<Address>(verifier, "source", verifierAbi);
  } catch (e) {
    // Only a contract that does not answer is "another verifier". A request that failed says
    // nothing about the scope, and no scope would let the trade screen offer every market.
    if (revertName(e) === null) throw e;
    return null;
  }
  const [scope, reports, records, answeredAt, priceWindow, maxDrawdownBps] =
    await Promise.all([
      read<
        readonly [
          bigint,
          boolean,
          readonly {
            index: number;
            usdcSpot: number;
            lending: boolean;
            reservePrice: boolean;
          }[],
          readonly number[],
          readonly Address[],
        ]
      >(source, "scope", [vault], sourceAbi, at),
      read<
        readonly {
          coreVault: Address;
          id: number;
          expiresAt: bigint;
          kind: number;
        }[]
      >(source, "reports", [vault], sourceAbi, at),
      read<readonly PriceRecord[]>(
        verifier,
        "priceRecords",
        [vault],
        verifierAbi,
        at,
      ),
      read<bigint>(source, "reportAnsweredAt", [vault], sourceAbi, at),
      fixed<bigint>(verifier, "priceWindow", verifierAbi),
      fixed<bigint>(verifier, "maxDrawdownBps", verifierAbi),
    ]);
  return {
    verifier,
    source,
    scope: {
      version: scope[0],
      enabled: scope[1],
      tokens: scope[2].map(({ index, usdcSpot, lending, reservePrice }) => ({
        index,
        usdcSpot,
        lending,
        reservePrice,
      })),
      dexes: [...scope[3]],
      coreVaults: [...scope[4]],
    },
    reports: reports.map((report, index) => ({
      index,
      kind: REPORT_KINDS[report.kind],
      id: report.id,
      coreVault: report.coreVault,
      expiresAt: report.expiresAt,
    })),
    records: records.filter((record) => record.time !== 0n),
    answeredAt,
    priceWindow,
    maxDrawdownBps,
    builder,
    builderFeeCap,
    block: at,
    blockTime: block.timestamp,
  };
}
export type FactoryConfig = {
  asset: Address;
  activationCost: bigint;
  maximumAssets: bigint;
};
export type { Address, EIP1193Provider, Hex };
