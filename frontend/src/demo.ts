import { getAddress, zeroAddress, type Address } from "viem";
import type { Guards, ScopeReport, State, VaultSummary } from "./chain.ts";
import type { ChatMessage, ChatRole } from "./chat.ts";
import { duration } from "./domain.ts";
import {
  USDC,
  type Account,
  type Dex,
  type Market,
  type OpenOrder,
} from "./hyperliquid/info.ts";
import {
  meetsMinimum,
  perpAsset,
  spotAsset,
  type OrderResult,
  type OrderWire,
} from "./hyperliquid/orders.ts";
import {
  PRICE_RECORDS,
  configureArgs,
  priceHistory,
  priceRefusal,
  recordedPrice,
  registered,
  type Draft,
} from "./scope.ts";
import type { Action } from "./trade.ts";

// Everything here is invented sample data and local bookkeeping for the demo mode. Nothing in
// this file reads a chain, an exchange or a chat server.

const at = (prefix: string, n: number | bigint) =>
  getAddress(`0x${prefix}${n.toString(16).padStart(40 - prefix.length, "0")}`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Who looks at the demo: operator of two sample vaults and a depositor in others. */
export const demoViewer = getAddress(
  "0x1111111111111111111111111111111111111111",
);
const builder = at("b0b0", 1);
const verifier = at("c0de", 1);
const source = at("c0de", 2);

export type DemoPending =
  | { kind: "activation" }
  | { kind: "agent"; agent: Address }
  | { kind: "revoke" }
  | { kind: "builderFee"; rate: number };
export type DemoVault = {
  address: Address;
  index: bigint;
  /** The Vault's own figures. Whether a deposit is priced at `nav` is decided by `demoState`. */
  state: State;
  guards: Guards;
  messages: ChatMessage[];
  account: Account;
  pending: DemoPending | null;
  /** The viewer's simulated agent key: its address while "stored", and whether it is "open". */
  key: Address | null;
  unlocked: boolean;
  usedAgents: Address[];
  /** Builder fee approved on Core, in tenths of a basis point. */
  approvedFee: number;
  /**
   * The viewer's redeem request: the shares waiting in it and their basis, and once its epoch is
   * settled what was reserved for it, fee included.
   */
  redeeming: { shares: bigint; basis: bigint; gross: bigint } | null;
  /** The Vault's action nonce: the id of its latest Core action. */
  actions: number;
  /** Last simulated order id. */
  oid: number;
};
export type DemoWorld = { vaults: DemoVault[] };

export const demoDexes: Dex[] = [
  { index: 0, name: "", collateralToken: USDC },
  { index: 1, name: "xyz", collateralToken: USDC },
  { index: 2, name: "flx", collateralToken: 360 },
];
const perp = (
  dex: Dex,
  index: number,
  name: string,
  szDecimals: number,
  maxLeverage: number,
): Market => ({
  key: `perp:${dex.index}:${name}`,
  kind: "perp",
  label: `${name}-PERP`,
  coin: name,
  asset: perpAsset(dex.index, index),
  szDecimals,
  maxLeverage,
  dex: dex.index,
  token: -1,
  pair: -1,
  quote: dex.collateralToken,
});
const spot = (
  pair: number,
  coin: string,
  base: string,
  token: number,
  szDecimals: number,
): Market => ({
  key: `spot:${pair}`,
  kind: "spot",
  label: `${base}/USDC`,
  coin,
  asset: spotAsset(pair),
  szDecimals,
  maxLeverage: 1,
  dex: -1,
  token,
  pair,
  quote: USDC,
});
export const demoMarkets: Market[] = [
  perp(demoDexes[0], 0, "BTC", 5, 40),
  perp(demoDexes[0], 1, "ETH", 4, 25),
  spot(107, "@107", "HYPE", 150, 2),
  spot(0, "PURR/USDC", "PURR", 1, 0),
  perp(demoDexes[1], 0, "xyz:XYZ100", 3, 20),
  perp(demoDexes[2], 0, "flx:OIL", 2, 10),
];
/** Fixed prices: a demo order fills at the mid or rests, and nothing moves afterwards. */
export const demoMids: Record<string, string> = {
  BTC: "60000",
  ETH: "2500",
  "@107": "30",
  "PURR/USDC": "0.2",
  "xyz:XYZ100": "24850",
  "flx:OIL": "71.5",
};

const HOUR = 3600;
const seconds = (now: number) => BigInt(Math.floor(now / 1000));

function sample(
  now: number,
  index: number,
  state: Partial<State> & Pick<State, "name" | "owner" | "phase">,
  scope: Pick<Guards["scope"], "version" | "enabled"> & Partial<Draft>,
  recordHours: number[],
  rest: Partial<DemoVault> & { reports?: ScopeReport[] } = {},
): DemoVault {
  const { reports = [], ...more } = rest;
  const full: State = {
    index: BigInt(index),
    asset: zeroAddress,
    account: demoViewer,
    allowance: 0n,
    wholeAt: now,
    implementation: zeroAddress,
    cash: 0n,
    reserved: 0n,
    supply: 0n,
    fee: 1000n,
    minimum: 10_000000n,
    pending: 0n,
    epoch: 1n,
    agent: zeroAddress,
    shares: 0n,
    basis: 0n,
    request: 0n,
    claimShares: 0n,
    claimNet: 0n,
    capacity: 0n,
    nav: null,
    closedBy: null,
    block: 0n,
    readAt: now,
    upgrade: zeroAddress,
    upgradePending: false,
    upgradeAt: 0n,
    upgradeTo: zeroAddress,
    codeChanged: false,
    activation: 1_000000n,
    ...state,
  };
  const price = recordedPrice(full.nav ?? 0n, full.supply);
  return {
    address: at("de", index),
    index: BigInt(index),
    state: full,
    guards: {
      verifier,
      source,
      scope: { tokens: [], dexes: [], coreVaults: [], ...scope },
      reports,
      records: recordHours.map((hours) => ({
        price,
        time: seconds(now) - BigInt(hours * HOUR),
      })),
      answeredAt: 0n,
      priceWindow: 86400n,
      maxDrawdownBps: 500n,
      builder,
      builderFeeCap: 100n,
      block: 0n,
      blockTime: seconds(now),
    },
    messages: [],
    account: { positions: [], margins: [], balances: [], orders: [] },
    pending: null,
    key: null,
    unlocked: false,
    usedAgents: [],
    approvedFee: 0,
    redeeming: null,
    actions: Number(full.pending) || 12,
    oid: 77_000_000,
    ...more,
  };
}

const usdc = { index: USDC, usdcSpot: 0, lending: true, reservePrice: false };
const hype = { index: 150, usdcSpot: 107, lending: false, reservePrice: true };

export function demoWorld(now = Date.now()): DemoWorld {
  let id = 0;
  const said = (
    vault: number,
    author: Address,
    role: ChatRole,
    hoursAgo: number,
    text: string,
    hidden = false,
  ): ChatMessage => ({
    id: ++id,
    vault: at("de", vault),
    author,
    role,
    // The demo keeps the text of a hidden message so that it can be shown again; the chat
    // server never sends it.
    text,
    createdAt: Math.floor(now / 1000 - hoursAgo * HOUR),
    hidden,
  });
  const [alice, bob, carol] = [1, 2, 3].map((n) => at("aa", n));
  const operators = [2, 3, 4, 5].map((n) => at("0b", n));
  return {
    vaults: [
      sample(
        now,
        7,
        {
          name: "Core Multi-Market",
          owner: demoViewer,
          phase: 4,
          cash: 10000_000000n,
          supply: 100000_000000000n,
          nav: 110000_000000n,
          agent: at("a6", 0x61),
          shares: 1000_000000000n,
          basis: 1000_000000n,
          capacity: 890000_000000n,
        },
        { version: 3n, enabled: true, tokens: [usdc, hype], dexes: [0] },
        [14, 10, 6, 2],
        {
          messages: [
            said(
              7,
              demoViewer,
              "owner",
              50,
              "이번 주는 BTC·ETH perp 비중을 줄이고 HYPE 현물을 일부 편입했습니다. 평가 범위는 USDC·HYPE·기본 perp DEX입니다.",
            ),
            said(
              7,
              alice,
              "depositor",
              26,
              "출금을 요청하면 정산까지 보통 얼마나 걸리나요?",
            ),
            said(
              7,
              demoViewer,
              "owner",
              25,
              "포지션 정리와 Core 회수가 끝나야 정산됩니다. 지난번에는 하루 안에 끝났습니다.",
            ),
            said(
              7,
              bob,
              "depositor",
              5,
              "수익 보장 리딩방 초대합니다. 지갑 시드 문구를 보내 주시면 대신 운용해 드립니다.",
              true,
            ),
            said(7, alice, "depositor", 1, "확인했습니다. 감사합니다."),
          ],
          account: {
            margins: [
              { dex: 0, accountValue: "65210.5", withdrawable: "51020.25" },
            ],
            positions: [
              {
                dex: 0,
                coin: "BTC",
                size: "0.25",
                entryPrice: "58000",
                value: "15000",
                pnl: "500",
                liquidationPrice: "41250",
              },
            ],
            balances: [
              { token: USDC, coin: "USDC", total: "19789.5", hold: "0.0" },
              { token: 150, coin: "HYPE", total: "500", hold: "0.0" },
            ],
            orders: [
              {
                dex: 0,
                coin: "ETH",
                isBuy: true,
                price: "2400",
                size: "2",
                oid: 76_999_114,
                time: now - 3 * HOUR * 1000,
                reduceOnly: false,
              },
              // A stop on the whole position: the exchange lists such an order with size zero.
              {
                dex: 0,
                coin: "BTC",
                isBuy: false,
                price: "48600",
                size: "0.0",
                oid: 76_999_120,
                time: now - 2 * HOUR * 1000,
                reduceOnly: true,
                type: "Stop Market",
                triggerPrice: "54000",
              },
            ],
          },
          key: at("a6", 0x61),
          unlocked: true,
          usedAgents: [at("a6", 0x61)],
          approvedFee: 10,
        },
      ),
      sample(
        now,
        6,
        {
          name: "HYPE Basis Carry",
          owner: operators[0],
          phase: 4,
          cash: 4300_120000n,
          supply: 240000_000000000n,
          nav: 254300_120000n,
          fee: 1500n,
          minimum: 50_000000n,
          agent: at("a6", 0x51),
          shares: 500_000000000n,
          basis: 512_300000n,
          capacity: 745000_000000n,
        },
        { version: 2n, enabled: true, tokens: [usdc, hype], dexes: [0] },
        [13, 9, 5, 1],
        {
          messages: [
            said(
              6,
              operators[0],
              "owner",
              30,
              "HYPE 현물 매수와 perp 매도로 funding을 받는 전략입니다. funding이 음수로 돌면 비중을 줄입니다.",
            ),
            said(
              6,
              carol,
              "depositor",
              8,
              "성과수수료 15%는 출금할 때 생긴 이익에만 붙는 게 맞나요?",
            ),
            said(
              6,
              operators[0],
              "owner",
              7,
              "네, 출금으로 실현된 이익에만 적용됩니다.",
            ),
          ],
        },
      ),
      sample(
        now,
        5,
        {
          name: "BTC 추세 추종",
          owner: operators[1],
          phase: 4,
          cash: 1120_500000n,
          supply: 50000_000000000n,
          nav: 48120_500000n,
          fee: 2000n,
          minimum: 100_000000n,
          agent: at("a6", 0x41),
          capacity: 900000_000000n,
        },
        { version: 1n, enabled: true, tokens: [usdc], dexes: [0] },
        // One record three hours old: the history is not yet half a window long.
        [3],
        {
          messages: [
            said(
              5,
              operators[1],
              "owner",
              2,
              "가격 기록을 다시 쌓는 중이라 입금은 잠시 닫혀 있습니다. 출금 요청은 평소대로 가능합니다.",
            ),
          ],
        },
      ),
      sample(
        now,
        4,
        {
          name: "Stable Lending Ladder",
          owner: operators[2],
          phase: 3,
          cash: 75000_000000n,
          supply: 75000_000000000n,
          nav: 75000_000000n,
          fee: 500n,
          capacity: 925000_000000n,
          // Its operator proposed an upgrade: executable in thirty hours, and no deposit until then.
          upgradePending: true,
          upgradeAt: seconds(now) + BigInt(30 * HOUR),
          upgradeTo: at("c0de", 0x42),
          // The viewer once approved a deposit that never confirmed: the approval still stands.
          allowance: 250_000000n,
        },
        { version: 0n, enabled: false },
        [],
      ),
      sample(
        now,
        3,
        {
          name: "Delta Neutral 실험",
          owner: demoViewer,
          phase: 4,
          cash: 400_000000n,
          supply: 20000_000000000n,
          nav: 20400_000000n,
          agent: at("a6", 0x21),
          shares: 5000_000000000n,
          basis: 5000_000000n,
          capacity: 979600_000000n,
        },
        { version: 1n, enabled: true, tokens: [usdc], dexes: [0] },
        [15, 11, 7, 3],
        {
          reports: [
            {
              index: 0,
              kind: "dex",
              id: 1,
              coreVault: zeroAddress,
              expiresAt: seconds(now) + BigInt(20 * HOUR),
            },
          ],
          messages: [
            said(
              3,
              demoViewer,
              "owner",
              4,
              "xyz DEX 포지션이 평가 범위 밖이라는 신고가 들어왔습니다. 범위에 등록하면 입금과 출금 정산이 바로 다시 열립니다. 곧 등록하겠습니다.",
            ),
          ],
          account: {
            margins: [
              { dex: 0, accountValue: "12400", withdrawable: "12400" },
              { dex: 1, accountValue: "7600", withdrawable: "5115" },
            ],
            positions: [
              {
                dex: 1,
                coin: "xyz:XYZ100",
                size: "-0.2",
                entryPrice: "25000",
                value: "4970",
                pnl: "30",
                liquidationPrice: "36400",
              },
            ],
            balances: [
              { token: USDC, coin: "USDC", total: "400", hold: "0.0" },
            ],
            orders: [],
          },
          key: at("a6", 0x21),
          usedAgents: [at("a6", 0x21)],
        },
      ),
      sample(
        now,
        2,
        {
          name: "Genesis Exit",
          owner: demoViewer,
          phase: 5,
          cash: 12000_000000n,
          supply: 12000_000000000n,
          nav: 12000_000000n,
          shares: 750_000000000n,
          basis: 750_000000n,
          request: 2n,
        },
        { version: 4n, enabled: true, tokens: [usdc], dexes: [0] },
        [16, 12, 8, 4],
        {
          // Everything is back from Core and the agent is revoked: the exit can be settled.
          redeeming: { shares: 250_000000000n, basis: 250_000000n, gross: 0n },
          messages: [
            said(
              2,
              demoViewer,
              "owner",
              1,
              "포지션을 모두 정리하고 Core의 USDC를 회수했습니다. 가격 기록이 이어져 있어 곧 출금을 정산합니다.",
            ),
          ],
          usedAgents: [at("a6", 0x11)],
        },
      ),
      sample(
        now,
        1,
        {
          name: "Momentum One",
          owner: operators[3],
          phase: 4,
          cash: 2100_000000n,
          supply: 30000_000000000n,
          nav: 33600_000000n,
          fee: 2500n,
          shares: 300_000000000n,
          basis: 300_000000n,
          capacity: 966400_000000n,
          // Upgraded since it was created: nothing it reports about itself is relied on.
          codeChanged: true,
        },
        { version: 5n, enabled: true, tokens: [usdc], dexes: [0] },
        [17, 13, 9, 5],
        {
          messages: [
            said(
              1,
              operators[3],
              "owner",
              40,
              "새 전략에 맞춰 볼트 코드를 업그레이드했습니다.",
            ),
            said(
              1,
              carol,
              "depositor",
              36,
              "코드가 바뀐 뒤로는 화면의 수치를 확인할 방법이 없네요. 출금을 요청했습니다.",
            ),
          ],
        },
      ),
    ],
  };
}

export function patchVault(
  world: DemoWorld,
  address: Address,
  change: (vault: DemoVault) => DemoVault,
): DemoWorld {
  return {
    vaults: world.vaults.map((vault) =>
      same(vault.address, address) ? change(vault) : vault,
    ),
  };
}

// A contract would revert with this custom error; the shell explains the name in words.
const revert = (name: string) => new Error(`${name}()`);

const holdsDex = (account: Account, dex: number) =>
  account.positions.some((position) => position.dex === dex) ||
  account.margins.some(
    (margin) => margin.dex === dex && Number(margin.accountValue) !== 0,
  );
const holdsToken = (account: Account, token: number) =>
  account.balances.some((balance) => balance.token === token);

/**
 * What a spot market of the demo would pay for the account's holding of a token, at the
 * exchange's 8 decimals; `pair` asks one pair only. The demo has no order book: a market pays
 * its fixed price, and a pair that is no market here pays nothing.
 */
function sale(account: Account, token: number, pair?: number): bigint {
  const market = demoMarkets.find(
    (row) =>
      row.kind === "spot" &&
      row.token === token &&
      (pair === undefined || row.pair === pair),
  );
  const held = account.balances.find((row) => row.token === token);
  return market && held
    ? times(fixed(held.total), fixed(demoMids[market.coin]))
    : 0n;
}

/**
 * Whether a report closes the Vault now: every valuation reads its venue again, and it counts
 * only until it lapses and only while that venue holds something the scope does not answer
 * for. A registered DEX or HyperCore vault is counted in full. A registered token is counted
 * for what its own pair would pay: while that is under the minimum order (10 USDC), a report
 * on it stands if the holding sells for twice that elsewhere. An unregistered token needs the
 * minimum order. The demo does not keep the pair a report was proven on: "elsewhere" is the
 * token's one market here.
 */
function stands(vault: DemoVault, report: ScopeReport, now: bigint): boolean {
  const { scope } = vault.guards;
  if (report.expiresAt <= now) return false;
  if (report.kind !== "token") {
    if (registered(scope, report)) return false;
    // The demo keeps no HyperCore vault equity: such a report stands until it lapses.
    return report.kind === "coreVault" || holdsDex(vault.account, report.id);
  }
  if (report.id === USDC) return false;
  const minimum = 10n * UNIT;
  const listed = scope.tokens.find((token) => token.index === report.id);
  if (listed && sale(vault.account, listed.index, listed.usdcSpot) >= minimum)
    return false;
  return sale(vault.account, report.id) >= (listed ? 2n * minimum : minimum);
}

/**
 * Why the source refuses to value the Core account, as the error it reverts with. Issuance needs
 * the owner's switch on, an exit only a registered scope, and neither goes on while a report
 * stands. A price record asks for neither: see `demoRecord`.
 */
function refusal(vault: DemoVault, now: bigint, issuing: boolean): string {
  const { scope, reports } = vault.guards;
  if (issuing ? !scope.enabled : scope.version === 0n)
    return "ScopeUnavailable";
  return reports.some((report) => stands(vault, report, now))
    ? "OpenReport"
    : "";
}

/** The error `totalAssets` would revert with, or null while a deposit is priced. */
function closedBy(vault: DemoVault, now: bigint): string | null {
  const { state, guards } = vault;
  if (state.phase === 3) return null; // idle: priced at realized cash, no verifier
  if (
    (state.phase !== 2 && state.phase !== 4) ||
    state.pending !== 0n ||
    state.nav === null
  )
    return "NavUnavailable";
  return (
    refusal(vault, now, true) ||
    priceRefusal(
      guards.records,
      guards.priceWindow,
      guards.maxDrawdownBps,
      recordedPrice(state.nav, state.supply),
      now,
      guards.answeredAt,
    ) ||
    null
  );
}

/** Whether a deposit would be priced now, by the rules of the Vault and its verifier. */
export function demoPriced(vault: DemoVault, now: bigint): boolean {
  // An Idle vault is valued at its cash, but takes no deposit while an action is pending.
  return vault.state.pending === 0n && closedBy(vault, now) === null;
}

/** `maxDeposit`: nothing while a deposit is not priced or an upgrade is proposed. */
function capacity(vault: DemoVault, now: bigint): bigint {
  return demoPriced(vault, now) && !vault.state.upgradePending
    ? vault.state.capacity
    : 0n;
}

/** What `inspect` would return: no NAV where `totalAssets` reverts, no capacity while closed. */
export function demoState(vault: DemoVault, now: number): State {
  const closed = closedBy(vault, seconds(now));
  return {
    ...vault.state,
    nav: closed ? null : vault.state.nav,
    closedBy: closed,
    capacity: capacity(vault, seconds(now)),
    readAt: now,
  };
}

/** What `inspectGuards` would return, read at `now`. */
export function demoGuards(vault: DemoVault, now: number): Guards {
  return { ...vault.guards, blockTime: seconds(now) };
}

/** What `listVaults` would return: the verifier's display value survives a closed deposit. */
export function demoSummary(vault: DemoVault, now: number): VaultSummary {
  const { state } = vault;
  const closed = closedBy(vault, seconds(now));
  // The verifier's display read answers wherever the valuation itself does, history or not.
  const shown = closed === null || !refusal(vault, seconds(now), true);
  return {
    address: vault.address,
    index: vault.index,
    name: state.name,
    owner: state.owner,
    phase: state.phase,
    supply: state.supply,
    fee: state.fee,
    minimum: state.minimum,
    nav: shown ? state.nav : null,
    depositsPriced: closed === null,
    closedBy: closed,
    codeChanged: state.codeChanged,
    upgradePending: state.upgradePending,
    unreadable: null,
    missed: null,
  };
}

export function demoCreate(
  world: DemoWorld,
  terms: { name: string; fee: bigint; minimum: bigint },
  now: number,
): { world: DemoWorld; vault: Address } {
  const index =
    world.vaults.reduce((top, vault) => Math.max(top, Number(vault.index)), 0) +
    1;
  const created = sample(
    now,
    index,
    {
      ...terms,
      owner: demoViewer,
      phase: 1,
      pending: 1n,
      supply: 100_000000000n,
      shares: 100_000000000n,
      basis: 100_000000n,
    },
    { version: 0n, enabled: false },
    [],
    { pending: { kind: "activation" } },
  );
  return {
    world: { vaults: [created, ...world.vaults] },
    vault: created.address,
  };
}

/** An address for a simulated agent key. No key is generated: the demo signs nothing. */
export function demoAgent(vault: DemoVault): Address {
  return at("a6", Number(vault.index) * 16 + vault.usedAgents.length + 1);
}

/** The owner submits a Core action: it waits, and deposits stay closed, until it is confirmed. */
export function demoSubmit(vault: DemoVault, pending: DemoPending): DemoVault {
  if (vault.state.phase < 2) throw revert("CoreNotReady");
  if (vault.pending) throw revert("PendingCoreAction");
  if (
    pending.kind === "agent" &&
    vault.usedAgents.some((used) => same(used, pending.agent))
  )
    throw revert("AgentAlreadyUsed");
  if (pending.kind === "revoke" && vault.state.agent === zeroAddress)
    throw revert("InvalidReceiver");
  if (
    pending.kind === "builderFee" &&
    BigInt(pending.rate) > vault.guards.builderFeeCap
  )
    throw revert("InvalidAmount");
  return {
    ...vault,
    pending,
    actions: vault.actions + 1,
    usedAgents:
      pending.kind === "agent"
        ? [...vault.usedAgents, pending.agent]
        : vault.usedAgents,
    state: {
      ...vault.state,
      pending: BigInt(vault.actions + 1),
      // A registration is a Core action: a Ready or an Idle vault becomes Active with it.
      phase:
        pending.kind === "agent" &&
        (vault.state.phase === 2 || vault.state.phase === 3)
          ? 4
          : vault.state.phase,
    },
  };
}

/** `syncCoreAction` / `finalizeActivation`: the pending action takes effect. */
export function demoSync(vault: DemoVault): DemoVault {
  const { pending } = vault;
  if (!pending) throw revert("EvidenceRejected");
  const state = { ...vault.state, pending: 0n };
  if (pending.kind === "activation")
    return {
      ...vault,
      pending: null,
      state: {
        ...state,
        phase: 2,
        nav: 100_000000n,
        capacity: 999900_000000n,
      },
      account: {
        ...vault.account,
        margins: [{ dex: 0, accountValue: "0.0", withdrawable: "0.0" }],
        balances: [{ token: USDC, coin: "USDC", total: "100", hold: "0.0" }],
      },
    };
  if (pending.kind === "agent")
    return {
      ...vault,
      pending: null,
      state: { ...state, agent: pending.agent },
    };
  if (pending.kind === "revoke")
    return { ...vault, pending: null, state: { ...state, agent: zeroAddress } };
  return { ...vault, pending: null, state, approvedFee: pending.rate };
}

/**
 * `configure`: the whole scope is replaced. An entry that still holds something cannot leave.
 * The kept report is dropped when the new scope lists its venue and it no longer stands: always
 * for a DEX or HyperCore vault, for a token only if its registered pair pays for the holding.
 * If the report stood until this call, the call is what lifted it, and the records made so far
 * stop being price history. One that had stopped standing by itself, or lapsed, is only dropped.
 */
export function demoConfigure(
  vault: DemoVault,
  draft: Draft,
  enabled: boolean,
  now: number,
): DemoVault {
  const [, tokens, dexes, coreVaults] = configureArgs(
    vault.address,
    draft,
    enabled,
  );
  const { scope, reports, answeredAt } = vault.guards;
  if (
    scope.dexes.some(
      (dex) => !dexes.includes(dex) && holdsDex(vault.account, dex),
    ) ||
    scope.tokens.some(
      (token) =>
        !tokens.some((row) => row.index === token.index) &&
        holdsToken(vault.account, token.index),
    )
  )
    throw revert("ScopeInUse");
  const next = {
    version: scope.version + 1n,
    enabled,
    tokens,
    dexes,
    coreVaults,
  };
  const [kept] = reports;
  const time = seconds(now);
  const guards = { ...vault.guards, scope: next };
  const stood = !!kept && stands(vault, kept, time);
  const dropped =
    !!kept &&
    registered(next, kept) &&
    !stands({ ...vault, guards }, kept, time);
  return {
    ...vault,
    guards: {
      ...guards,
      reports: dropped ? [] : reports,
      answeredAt: dropped && stood ? time : answeredAt,
    },
  };
}

/**
 * `recordPrice`: anyone may record the share price. A new sample is added once the last one is
 * more than an eighth of the window old; before that only a higher price replaces its price.
 * Neither the owner's switch, a report nor a pending action stops it, because issuance and exits
 * need the history.
 */
export function demoRecord(vault: DemoVault, now: number): DemoVault {
  const { state, guards } = vault;
  const time = seconds(now);
  if (state.supply === 0n) throw revert("NoShares");
  // An Idle vault issues at its cash alone: that price is recorded, without reading Core.
  const idle = state.phase === 3;
  if (!idle && guards.scope.version === 0n) throw revert("ScopeUnavailable");
  const record = {
    price: recordedPrice(
      idle ? state.cash : (state.nav ?? state.cash),
      state.supply,
    ),
    time,
  };
  const last = guards.records.at(-1);
  if (priceHistory(guards.records, guards.priceWindow, time).recordIn === 0n)
    return {
      ...vault,
      guards: {
        ...guards,
        records: [...guards.records, record].slice(-PRICE_RECORDS),
      },
    };
  if (!last || record.price <= last.price) throw revert("PriceRecordTooSoon");
  return {
    ...vault,
    guards: {
      ...guards,
      records: [
        ...guards.records.slice(0, -1),
        { ...last, price: record.price },
      ],
    },
  };
}

/** `clearReport`: list housekeeping. Only a report that no longer stands can be dropped. */
export function demoClear(
  vault: DemoVault,
  index: number,
  now: number,
): DemoVault {
  const { reports } = vault.guards;
  const report = reports[index];
  if (!report) throw new Error("해당 신고가 없습니다.");
  if (stands(vault, report, seconds(now))) throw revert("ReportStands");
  return {
    ...vault,
    guards: {
      ...vault.guards,
      reports: reports
        .filter((_, i) => i !== index)
        .map((row, i) => ({ ...row, index: i })),
    },
  };
}

/**
 * The epoch of the viewer's request is settled: its shares are burned and paid at the cash price,
 * with the Vault's virtual offset unless they are the whole supply. The demo follows the viewer's
 * request only.
 */
function settled(vault: DemoVault): DemoVault {
  const { state, redeeming } = vault;
  if (!redeeming) return vault;
  const { cash, supply } = state;
  const gross =
    cash === 0n
      ? 0n
      : redeeming.shares === supply
        ? cash
        : (redeeming.shares * (cash + 1n)) / (supply + 1000n);
  const profit = gross > redeeming.basis ? gross - redeeming.basis : 0n;
  // The owner pays no performance fee on their own shares.
  const fee = same(demoViewer, state.owner)
    ? 0n
    : (profit * state.fee) / 10_000n;
  return {
    ...vault,
    redeeming: { ...redeeming, gross },
    state: {
      ...state,
      cash: cash - gross,
      nav: state.nav === null ? null : state.nav - gross,
      reserved: state.reserved + gross,
      supply: supply - redeeming.shares,
      claimShares: redeeming.shares,
      claimNet: gross - fee,
    },
  };
}

/**
 * `requestRedeem`: the viewer's shares, with their part of the basis, wait in a request. An Idle
 * vault holds only cash and settles it at once.
 */
export function demoRequest(vault: DemoVault, shares: bigint): DemoVault {
  const { state } = vault;
  if (shares <= 0n || shares > state.shares) throw revert("InvalidAmount");
  if (state.request !== 0n) throw revert("OutstandingRequest");
  if (state.phase < 2 || state.phase === 5) throw revert("WrongPhase");
  const basis = (state.basis * shares) / state.shares;
  const requested: DemoVault = {
    ...vault,
    redeeming: { shares, basis, gross: 0n },
    state: {
      ...state,
      shares: state.shares - shares,
      basis: state.basis - basis,
      request: 1n,
    },
  };
  return state.phase === 3 ? settled(requested) : requested;
}

/** `redeem`: the viewer claims the whole of a settled request, which closes it. */
export function demoClaim(vault: DemoVault): DemoVault {
  const { state, redeeming } = vault;
  if (!redeeming || state.claimShares === 0n) throw revert("NotClaimable");
  return {
    ...vault,
    redeeming: null,
    state: {
      ...state,
      reserved: state.reserved - redeeming.gross,
      request: 0n,
      claimShares: 0n,
      claimNet: 0n,
    },
  };
}

/** `beginExit`: the owner closes the epoch. From here the Vault only winds down. */
export function demoBeginExit(vault: DemoVault): DemoVault {
  const { state } = vault;
  if (state.phase === 0 || state.phase === 3 || state.phase === 5)
    throw revert("WrongPhase");
  if (state.phase === 1 && state.pending !== 0n)
    throw revert("PendingCoreAction");
  return { ...vault, state: { ...state, phase: 5 } };
}

/**
 * `settleEpoch`: an exit pays out the cash it brought home. Nothing may be pending, no agent may
 * still trade, no report may stand, Core must be empty, and the cash price needs the same
 * recorded history as issuance and must not be far below its highest record. An exit of a Vault
 * without shares pays nobody and needs no price. The demo counts anything left on Core as not
 * flat; the contract allows a little dust.
 */
export function demoSettle(vault: DemoVault, now: number): DemoVault {
  const { state, guards, account } = vault;
  const time = seconds(now);
  if (state.phase !== 5) throw revert("WrongPhase");
  if (state.pending !== 0n || state.agent !== zeroAddress)
    throw revert("PendingCoreAction");
  const flat =
    !account.positions.length &&
    account.margins.every((margin) => Number(margin.accountValue) === 0) &&
    account.balances.every((balance) => Number(balance.total) === 0);
  const refused =
    refusal(vault, time, false) ||
    (flat ? "" : "CoreNotFlat") ||
    (state.supply === 0n
      ? ""
      : priceRefusal(
          guards.records,
          guards.priceWindow,
          guards.maxDrawdownBps,
          recordedPrice(state.cash, state.supply),
          time,
          guards.answeredAt,
        ));
  if (refused) throw revert(refused);
  return settled({ ...vault, state: { ...state, phase: 3, nav: state.cash } });
}

// Exact decimal arithmetic for the simulated fills, at the exchange's 8 decimals.
const UNIT = 10n ** 8n;
function fixed(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const value =
    BigInt(whole || "0") * UNIT + BigInt(fraction.padEnd(8, "0").slice(0, 8));
  return negative ? -value : value;
}
function decimal(value: bigint): string {
  const n = value < 0n ? -value : value;
  const fraction = (n % UNIT).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${n / UNIT}${fraction ? "." + fraction : ""}`;
}
const times = (a: bigint, b: bigint) => (a * b) / UNIT;
const abs = (n: bigint) => (n < 0n ? -n : n);

type Step = { account: Account; result: OrderResult };

function fillPerp(
  account: Account,
  market: Market,
  wire: OrderWire,
  oid: number,
): Step {
  const mid = fixed(demoMids[market.coin]);
  const held = account.positions.find(
    (row) => row.dex === market.dex && row.coin === market.coin,
  );
  const old = held ? fixed(held.size) : 0n;
  let delta = wire.b ? fixed(wire.s) : -fixed(wire.s);
  const adds = old === 0n || old > 0n === delta > 0n;
  if (wire.r) {
    if (adds)
      return {
        account,
        result: {
          kind: "error",
          message: "Reduce only order would increase position.",
        },
      };
    if (abs(delta) > abs(old)) delta = -old;
  }
  const size = old + delta;
  const before = held?.entryPrice ? fixed(held.entryPrice) : mid;
  const entry = adds
    ? (abs(old) * before + abs(delta) * mid) / (abs(old) + abs(delta))
    : abs(delta) > abs(old)
      ? mid
      : before;
  const next = {
    dex: market.dex,
    coin: market.coin,
    size: decimal(size),
    entryPrice: decimal(entry),
    value: decimal(times(abs(size), mid)),
    pnl: decimal(times(size, mid - entry)),
    liquidationPrice: null,
  };
  // A stop or take-profit on the whole position is cancelled with the position.
  const wholePosition = (order: OpenOrder) =>
    order.dex === market.dex &&
    order.coin === market.coin &&
    !!order.triggerPrice &&
    !Number(order.size);
  return {
    account: {
      ...account,
      positions:
        size === 0n
          ? account.positions.filter((row) => row !== held)
          : held
            ? account.positions.map((row) => (row === held ? next : row))
            : [...account.positions, next],
      orders:
        size === 0n
          ? account.orders.filter((order) => !wholePosition(order))
          : account.orders,
    },
    result: {
      kind: "filled",
      oid,
      size: decimal(abs(delta)),
      price: demoMids[market.coin],
    },
  };
}

function fillSpot(
  account: Account,
  market: Market,
  wire: OrderWire,
  oid: number,
): Step {
  const size = fixed(wire.s);
  const cost = times(size, fixed(demoMids[market.coin]));
  const base = market.label.split("/")[0];
  const total = (token: number) =>
    fixed(account.balances.find((row) => row.token === token)?.total ?? "0");
  const [paid, pays, got, gets] = wire.b
    ? [cost, USDC, size, market.token]
    : [size, market.token, cost, USDC];
  if (total(pays) < paid)
    return {
      account,
      result: {
        kind: "error",
        message: `Insufficient spot balance asset=${wire.b ? "USDC" : base}`,
      },
    };
  const next = new Map([
    [pays, total(pays) - paid],
    [gets, total(gets) + got],
  ]);
  const coin = (token: number) => (token === USDC ? "USDC" : base);
  const balances = [
    ...account.balances.filter((row) => !next.has(row.token)),
    ...[...next].map(([token, value]) => ({
      token,
      coin: coin(token),
      total: decimal(value),
      hold: account.balances.find((row) => row.token === token)?.hold ?? "0.0",
    })),
  ]
    .filter((row) => fixed(row.total) !== 0n)
    .sort((a, b) => a.token - b.token);
  return {
    account: { ...account, balances },
    result: {
      kind: "filled",
      oid,
      size: decimal(size),
      price: demoMids[market.coin],
    },
  };
}

function place(
  account: Account,
  wire: OrderWire,
  oid: number,
  now: number,
): Step {
  const reject = (message: string): Step => ({
    account,
    result: { kind: "error", message },
  });
  const market = demoMarkets.find((row) => row.asset === wire.a);
  if (!market) return reject("Invalid asset.");
  if (!wire.r && !meetsMinimum(wire.p, wire.s))
    return reject("Order must have minimum value of $10.");
  const mid = fixed(demoMids[market.coin]);
  const { tif } = wire.t.limit;
  if (wire.b ? fixed(wire.p) < mid : fixed(wire.p) > mid) {
    if (tif === "Ioc")
      return reject(
        "Order could not immediately match against any resting orders.",
      );
    return {
      account: {
        ...account,
        orders: [
          ...account.orders,
          {
            dex: Math.max(market.dex, 0),
            coin: market.coin,
            isBuy: wire.b,
            price: wire.p,
            size: wire.s,
            oid,
            time: now,
            reduceOnly: wire.r,
          },
        ],
      },
      result: { kind: "resting", oid },
    };
  }
  if (tif === "Alo")
    return reject("Post only order would have immediately matched.");
  return market.kind === "perp"
    ? fillPerp(account, market, wire, oid)
    : fillSpot(account, market, wire, oid);
}

/**
 * The demo's stand-in for the exchange: the very action the agent would sign is applied to the
 * sample account. An order that crosses the fixed mid fills at it, any other rests; a cancel
 * removes a resting order.
 */
export function demoExchange(
  vault: DemoVault,
  action: Action,
  now: number,
): { vault: DemoVault; results: OrderResult[] } {
  let { account, oid } = vault;
  const results: OrderResult[] = [];
  if ("cancels" in action)
    for (const { o } of action.cancels) {
      const found = account.orders.some((order) => order.oid === o);
      if (found)
        account = {
          ...account,
          orders: account.orders.filter((order) => order.oid !== o),
        };
      results.push(
        found
          ? { kind: "ok" }
          : {
              kind: "error",
              message: "Order was never placed, already canceled, or filled.",
            },
      );
    }
  else
    for (const wire of action.orders) {
      const step = place(account, wire, ++oid, now);
      account = step.account;
      results.push(step.result);
    }
  return { vault: { ...vault, account, oid }, results };
}
