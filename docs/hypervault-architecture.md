# HyperVault — Architecture

2026-10-12. Current architecture of the deployed HyperVault prototype. The current deployment is **v3**: the v2 contracts, which are laid out like kHYPE (share token, manager, accountant; [ADR-037](DECISIONS.ko.md#adr-037)), paired with owner-trusted NAV modules that have no third-party reports and no drawdown wait ([ADR-038](DECISIONS.ko.md#adr-038)). The v1 (`ManagedAssetVault`, runs 1–3) and v2 vaults stay deployed as evidence and are retired from the deposit UI. Section 11 lists the differences.

Korean specs: [per-asset vault](managed-asset-vault.ko.md), [direct deployment](direct-vaults.ko.md), [precompile NAV](managed-precompile-nav.ko.md), [HyperVault scope](hypervault.ko.md). Status and evidence: [STATUS](STATUS.ko.md#hypervault). Standards check: [ERC-7540 review](standards-review.ko.md#hypervault-v2). It covers the v2 contracts, which v3 uses unchanged. The older [vault-architecture.ko.md](vault-architecture.ko.md) describes earlier designs and is not current.

## 1. One idea

The vault manager contract **is** its own HyperCore account. A HyperEVM proxy holds custody and the withdrawal queue, and the same address on HyperCore holds the spot, perp, lending and margin positions. The EVM side reads the Core side through **read precompiles** and acts on it through **CoreWriter**. Trading is done by an API wallet (agent) that the vault approves for its own Core account.

Like kHYPE next to its StakingManager, the **share is a separate ERC-20** that anyone can transfer or use in other protocols. The **exchange rate and the performance fee live in an accountant**.

```text
                 HyperEVM (chain 999)                                        HyperCore
┌────────────────────────────────────────────────────────┐          ┌────────────────────────────┐
│ HyperVaultShare (hvUSDC, ERC-20) ◄─ mint/burn/escrow ─┐ │          │                            │
│                                                       │ │          │                            │
│ TransparentUpgradeableProxy ◄── manager address ──────┼─┼─────────►│ same address = Core account│
│   └─ HyperVault (impl): ERC-7575 vault, ERC-7540 redeem │          │ spot, perps, lending, mode │
│        allocation queue, epochs, Core management      │ │          └──────────────▲─────────────┘
│        ├─ HyperVaultAccountant: rate, high-water mark, fee                         │ orders by the
│        ├─ delegatecall ─► ManagedAssetBridge ─ Circle / system transfers ───────────┤ vault's agent
│        ├─ CoreWriter 0x3333… ─ sendAsset / actions ────────────────────────────────┘
│        └─ HyperVaultNavVerifier ─► HyperVaultNavSource ─ read precompiles 0x08xx
│ ManagedUpgradeController (48h delay, Idle only)                                     │
└────────────────────────────────────────────────────────┘
```

## 2. Contracts and mainnet addresses (v3, current)

| Contract | Role | Address (HyperEVM 999) |
| --- | --- | --- |
| `HyperVault` proxy | Manager. Holds deposits, cash, the redeem queue and epochs, and manages Core. Its address is the Core account. | v4 `0xf9c05bf416F6E45bf3658A92C94fE4f8f03a6b4F` (v3 `0x2affc225…0516` retired) |
| `HyperVault` implementation | Logic. Config (asset, share, accountant, bridge, verifier, owner, fees, caps) is immutable and hashed into `configHash`. | `0x63688DDBb939aA5690F096529CF1b6f6aa91DDFa` |
| `HyperVaultShare` (hvUSDC, 9 decimals) | Plain transferable ERC-20. Only the manager can mint, burn, or escrow redeem requests. Not upgradeable. | `0x6960fd2d19167ba2d6175e16a5f27342b6e0d29d` (v4) |
| `HyperVaultAccountant` | Per-vault high-water mark and last verified rate; computes fee shares. | `0x9a5c6a1bd9acdcc08803dd502379bc2f9d328459` (v4) |
| `HyperVaultNavVerifier` | NAV in base-asset units, optional price records, action finality, exit flatness. No drawdown wait. | `0x96A41336fa0a271c7956d4d1b9e31272F10226bd` (v4) |
| `HyperVaultNavSource` | Holds each vault's registered scope and values it from read precompiles. No reports. | `0x94Ea87A22044AF089D98ACd59E983aEC04DB0290` (v4) |
| `ManagedUpgradeController` | The owner proposes an upgrade, waits 48 h, and can execute it only while the vault is Idle with no pending action and no agent. The `configHash` must stay the same. | `0xd286784ce886eff134672d9f67242f140a0f060e` |
| `ManagedAssetBridge` (USDC) | Reused from v1. Stateless and called by delegatecall: EVM↔Core transfer per asset. | `0x75798f2797e887be93f2d430e8a4a850ffa610b2` |

`configHash` is `0xd4f74aaf1789994dc28d888035da567e14848d67f3fe0d211911d0c0a4141e4b`. The deployed runtime bytecode of all five new contracts matches a local `forge build` exactly once immutables are masked.

Each vault has one base asset, and its shares, NAV and fee are counted in that asset. Only the USDC vault is deployed.

v2 deployment (retired): vault `0x4Dd7a7ECB3Bc91792b83e0Ee5fFb5b0E7fF9C58B`, share `0xfe226ffa…c065`, accountant `0x92221dde…2a1b`. It reused v1's report-capable source and drawdown-guarded verifier.

## 3. Vault states

```text
Uninitialized ──bootstrap──► AwaitingActivation ──finalizeActivation──► Idle
                                                                         │  ▲
                              executeCoreAllocation / setApiWallet / …   │  │ settleEpoch (Core flat)
                                                                         ▼  │
                                                                       Active ──beginExit──► Exiting
```

| State | Assets | Deposits | Redeem request |
| --- | --- | --- | --- |
| AwaitingActivation, Idle | all EVM cash | at cash price | **settled in the same tx** |
| Active | EVM cash + Core positions | at verified NAV. Needs: no pending Core action, and live price within 20 bps of the lowest price record in the window, if there are records | queued in the open epoch |
| Exiting | being unwound | closed | closed (epoch sealed) |

## 4. Money flow

1. **Deposit** (anyone).
   - The fee due is charged first.
   - The deposit is priced at the post-fee price: `assets × (supply + 1000) / (NAV + 1)`.
   - The share token mints to the receiver.
   - All of the deposit stays as EVM cash.
2. **Allocate** (owner). `queueCoreAllocation` and then `executeCoreAllocation` send free cash to the vault's own Core account. A later Core block confirms it through `syncCoreAction`.
3. **Trade** (agent). The vault's API wallet signs orders on the vault's Core account. The contract does not check them.
   - The same API wallet can use manual borrow/lend (BLP) through the L1 action `{type: "borrowLend", operation: supply|borrow|repay|withdraw, token, amount}`.
   - This was verified on mainnet in a `default`-mode account (v3 run 2): 0.13 HYPE was supplied as collateral and 5 USDC was borrowed, then the borrow was repaid and the collateral withdrawn.
   - The action is not in the public API docs or SDK; its format was taken from the official web app.
   - To value it, the scope must count the lending ledgers (USDC and HYPE with `lending = true`). Otherwise the NAV refuses to value the account (`ScopeIncomplete`).
4. **Recall** (owner). `recallFromCore` brings the asset back. Core charges transfer gas in HYPE from the vault's Core account (0.000037 HYPE observed in v2). It is booked only when the asset has arrived.
5. **Settle** (anyone, after the owner's `beginExit`).
   - The Core account must be flat: no debt, no position, at most 2 USDC of dust. There is no drawdown wait.
   - The fee is charged at realized EVM cash.
   - The epoch is priced at that cash, and the escrowed shares are burned.
6. **Claim** (controller or operator). `redeem` / `withdraw` pay the epoch price. There is no per-holder fee at claim.

## 5. NAV, rate and fee

```text
shareholderAssets = availableCash + floor(CoreValue_USDC18 × 10^decimals / basePrice_USDC18)
CoreValue         = Σ registered tokens (spot + lending supply − borrow) × price
                  + Σ registered perp DEX account value (incl. uPnL) + Σ registered Core-vault equity
price             = (assets + 1) × 1e30 / (supply + 1000)               // per raw share, virtual offset
conservative      = Core valuation: min(live price, lowest verifier record in the window)
                    no records in the window: the live price
                    EVM cash (Idle, exit): the live price
fee (assets)      = (conservative − highWaterMark) × (supply + 1000) × feeBps / 1e34   if above the mark
fee shares        = fee × (supply + 1000) / (assets + 1 − fee)    → 80% owner, 20% treasury
highWaterMark     = rate = post-fee conservative price
```

- **Inputs.** All NAV inputs come from HyperCore read precompiles at the current Core block. Prices are Hyperliquid's own reserve or spot prices. There is no external price feed and no operator-reported number. A failed read never becomes zero; it closes issuance.
- **When the fee is charged.** The fee is crystallized before every deposit or mint, before every settlement, and in `checkpoint()`, which anyone may call.
- **Losses.** Losses are recovered fee-free, because the mark only moves up after a fee. The owner's shares are diluted like everyone else's.
- **Empty vault.** An empty vault restarts its mark at the price new holders enter at. The fee rate is capped at 50%.
- **Price spikes.** A spike shorter than the verifier's window (600 s here) is neither charged nor published. While the live price runs more than 20 bps above the window low, Active deposits close. Otherwise a depositor would be priced at the live NAV and then pay the lagging fee.
- **`totalAssets` / `convertToAssets` / `convertToShares`** answer from the last verified rate in Active and never revert. Integrators check `accountant.marks(vault).updatedAt`. `liveNav()` reverts when the NAV cannot be verified, and issuance uses it.
- **Out-of-scope holdings.** Holdings outside the registered scope are invisible to the NAV, and the owner is trusted to keep the scope complete. Nobody can report out-of-scope holdings, so a stranger's transfer can never close the vault ([ADR-038](DECISIONS.ko.md#adr-038)).

## 6. Roles

| Who | Can |
| --- | --- |
| Owner (immutable) | bootstrap; queue/execute allocation; recall; move between Core DEXes; lending; abstraction mode; approve/revoke the API wallet; builder fee up to the cap; begin exit; register the valuation scope; propose upgrades (48 h) |
| API wallet (agent) | place and cancel orders on the vault's Core account; a revoked agent cannot be reused |
| Anyone | deposit; transfer shares; `checkpoint`; settle a sealed epoch; record a share price |
| Controller / its operator | open or join its own redeem request (with the share owner's shares by allowance or operator approval); claim |

## 7. Withdrawals (ERC-7540)

Redeeming is asynchronous: **request → (owner work) → settle → claim**.

- A request can be made at any time except while an epoch is being exited. The caller must be the controller or an operator of the controller.
- A controller has one request at a time. More shares requested in the same open epoch join that request.
- **Idle:** the request settles in the same transaction and can be claimed at once (mainnet v2 run 1, owner).
- **Active:** the request waits in the open epoch. It becomes claimable only after the owner seals the epoch, unwinds **all** Core positions, revokes the agent and recalls the assets, and the epoch is settled.
  - The user cannot force this. There is no deadline and no permissionless exit.
  - Every exit unwinds the whole strategy.
- Every share in an epoch is paid the same price, so shares received by transfer redeem like any other (mainnet v2 run 1: demo-user redeemed 3e9 transferred shares plus 9.64e9 deposited shares).

## 8. Liquidity buffer

The buffer is free EVM cash that the owner does not allocate. The operator tool keeps `max(1 USDC, 10% of NAV, value of shares requested in the open epoch)` and allocates the rest (`roundtrip.py buffer` / `allocate auto`). The vault does not enforce this.

A buffer-backed instant partial redeem is designed but not implemented ([ADR-036](DECISIONS.ko.md#adr-036)). With transferable shares, a DEX pool could also serve as the instant exit, as it does for LSTs.

## 9. Trust boundaries

- **Scope completeness (owner-trusted):** the owner chooses what is valued. If the owner or agent moves value outside the scope, the NAV looks lower. Issuance and settlement still proceed at that NAV, so redeemers can be paid less and the remaining holders, usually the owner, gain. v1 and v2 guarded against this with third-party reports and a drawdown wait. v3 removes both by decision ([ADR-038](DECISIONS.ko.md#adr-038)).
- **Trading authority:** the owner and the agent can trade the vault's Core account freely.
- **Withdrawal cooperation:** Active redemptions need the owner (section 7).
- **Asynchronous Core:** an EVM transaction calling CoreWriter can succeed while Core rejects the action. The verifier infers non-recall actions from a later Core block.
- **Fee timing:** a price held above its level for longer than the window can be crystallized as fee and is not refunded if the price falls back. The owner controls trading, so this is owner-trusted. Without price records, the fee is measured at the live NAV.
- **Upgrades:** the owner can change the implementation after 48 h while the vault is Idle. The config hash cannot change. The share token and accountant are not upgradeable.
- **Audit:** none of this is audited.

## 10. What ran on mainnet and what did not

Ran (owner's small funds; [v3 evidence](reference/hypervault-v3-mainnet-2026-10-12/), [v2 evidence](reference/hypervault-v2-mainnet-2026-10-12/), [v1 evidence](reference/hypervault-mainnet-2026-10-12/)):

**v3 run 1 (current deployment):**
1. Deployed and verified all five contracts, with exact bytecode matches.
2. Bootstrapped with an 11 USDC seed.
3. Allocated 9.9 USDC.
4. An Active deposit of 10 USDC minted 10e9 shares **with zero price records**.
5. Requested a redeem while Active, then exit, recall of 9.9 and **immediate settlement with no drawdown wait**.
6. Claimed 21.0, so in and out both totalled 21.0.


**v3 run 2 (manual borrow):**
1. Owner deposit of 15.
2. The API wallet bought 0.13 HYPE, supplied it as collateral and borrowed 5 USDC (health 1.46).
3. The NAV refused to value the account until the lending ledgers were registered. After that, verifier NAV 15.158817 vs API 15.158818.
4. The borrow was repaid including interest, the collateral withdrawn and the HYPE sold.
5. Recall, settlement and claims returned 15.008495 to the owner.
6. The 0.0085 gain from the HYPE price was **real trading profit**. Settlement charged a 10% fee on it (0.00085), the first fee on non-synthetic profit.

**v2 run 1, step by step (the v2 deployment's modules still had reports and the drawdown wait):**
1. **Deploy and bootstrap.** Deployed and verified (all checks, bytecode match). Bootstrapped with a 12 USDC seed and Core activation from the EVM.
2. **Transfer.** 3e9 shares moved to a second wallet by an ERC-20 transfer.
3. **Allocate.** 10.8 USDC allocated by the buffer policy.
4. **Synthetic gain.** The owner sent 0.5 USDC on Core to the vault's Core account. This is a labeled stand-in for profit, not trading.
5. **Spike guard.**
   - Right after the rise, the NAV was 12.5, but the fee was 0, the rate stayed at 1.000 and deposits were closed.
   - Ten minutes later the window low reached 1.0417.
   - `checkpoint` then minted 48,191,803 fee shares, worth 0.05 USDC (10% of 0.5). The mark and rate moved to 1.0375.
6. **Active deposit.** 10 USDC minted exactly the preview, 9,638,553,471 shares, at 1.0375. Gas was 274,531.
7. **Active request.** The second wallet requested a redeem of all its shares while Active: pending 12.64e9, claimable 0.
8. **Exit and claims.**
   - Exit, recall of 11.3 USDC, and settlement at 13.1125.
   - The second wallet claimed 13.1125, which is 3 × 1.0375 + 10.
   - The owner's Idle request settled in the same transaction, and the owner claimed 9.3875.
   - In and out both totalled 22.5.

**v1 runs 1–3:** HYPE spot, a spot + perp-short hedge with funding, NAV reconciliation against the HyperCore ledger, and an Active deposit with async and instant redeem.

Not run:
- HYPE and UBTC vaults, and a native HYPE router for v2
- Portfolio Margin borrowing (account too small)
- trading on the v2 vault (v1 covered it)
- a fee crystallized from real trading profit
- buffer-backed instant redeem
- continuous operation
- an audit

## 11. v1 → v2

| | v1 `ManagedAssetVault` | v2 HyperVault |
| --- | --- | --- |
| Share | the vault itself, non-transferable | separate ERC-20, transferable |
| Fee | per holder: realized profit over cost basis and loss carry, paid at claim | vault-level high-water mark, minted as shares; conservative price |
| Redeem controller | must equal the share owner | controller or its operator; owner's shares by allowance or operator approval |
| Requests | one per controller | one per controller, and same-epoch requests join it |
| `totalAssets` / `convertTo*` | revert when the NAV cannot be verified | last verified rate; `liveNav()` reverts instead |
| Core management, bridge | — | unchanged |
| NAV modules | report-capable source, drawdown + history verifier | v2: same as v1. v3: owner-trusted source and verifier without reports or drawdown wait |
