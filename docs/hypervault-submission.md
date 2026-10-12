# HyperVault — Submission Package (Colosseum, Hyperliquid)

Prepared 2026-10-12 KST. This file is the source for the project description, the pitch and demo scripts, and the list of items only the team can supply. Korean product spec: [hypervault.ko.md](hypervault.ko.md). Live status: [STATUS](STATUS.ko.md#hypervault).

Architecture (English): [hypervault-architecture.md](hypervault-architecture.md).

Official requirements (deadline, video lengths, fields) could not be re-confirmed from the public project page on 2026-10-12; the team must check the Colosseum dashboard before submitting. Working deadline: **2026-10-13 15:59 KST** (Oct 12, 11:59 PM PDT).

## 1. Project description (paste-ready)

> **HyperVault** — Hyperliquid-native vaults that keep custody and shares on HyperEVM while the strategy runs in a real HyperCore account.
>
> Each vault is denominated in its own base asset. The **HYPE** and **BTC (UBTC)** vaults keep the depositor's asset exposure and aim to add hedged carry on top: under Portfolio Margin, borrow USDC, buy extra spot, and short only that extra amount. The **USDC** vault runs a delta-neutral carry: spot buy plus a matching perp short.
>
> Laid out like kHYPE: the share (hvUSDC) is a separate, freely transferable ERC-20 that can be used across DeFi; the vault manager contract *is* its HyperCore account; an accountant publishes the last verified exchange rate (never reverts) and charges a vault-level **high-water-mark** performance fee as new shares, measured at the lower of live NAV and recent recorded prices so short spikes are never charged.
>
> The vault manager *is* its HyperCore account. NAV is computed onchain from HyperCore **read precompiles** (spot, perp account value, lending) over an owner-registered scope, using Hyperliquid's own reserve/oracle prices; there is no external price feed and no operator-reported NAV number. The owner manages Core from the EVM through **CoreWriter**; orders are placed by an approved vault API wallet.
>
> **What actually ran on mainnet (owner's small funds):** the current v2 USDC vault: deploy → Core activation → share transfer to a second wallet → allocation → a labelled synthetic gain (an owner transfer on Core, not trading profit) → fee withheld while the price ran ahead of its records, then charged at 10% of the gain once they caught up → NAV-priced deposit → async redeem of transferred + deposited shares → recall → settle → claim (in = out = 22.5 USDC). Before that, the v1 vault ran three full round trips: deploy → bootstrap → Core activation from the EVM → deposit → Core allocation → API-wallet orders (HYPE spot, then spot + perp short hedge) → NAV reconciled against the HyperCore ledger → withdrawal request → unwind → recall to EVM → settlement → claim. A NAV-priced deposit while Active and both redeem paths (instant when Idle, asynchronous ERC-7540 request → settle → claim when Active) were exercised. Rule-based monitoring with an advisory AI summary ran alongside.
>
> **Withdrawals:** while the strategy runs, a withdrawal up to the free EVM cash (the buffer) is paid in the same transaction (`redeemNow`, v4) at the conservative price (lower of live NAV and the 10-minute record low) minus a 0.1% exit fee kept for remaining holders; it needs a recent price record. Anything above the buffer is a queued request paid after the owner unwinds and recalls (the user cannot force it). In Idle every redeem is instant.
>
> **Not yet:** HYPE and UBTC vaults are implemented and tested locally (strategy in dry-run only); Portfolio Margin was attempted but is not available at this account size (>$10k account value required), so the live hedge ran in Unified mode without borrowing (on v1). The v2 fee has not yet been charged on real trading profit. Not audited; not a production launch.

Correction to the current Colosseum text: it says "All three use native portfolio margin" and implies all three vaults run. Replace with the paragraph above.

## 2. Evidence links

- **v6 vault (current)** (proxy = HyperCore account): `0x6c4556b8068397AD2F3e69205b7C100CAf234883`; share `0xe4479fb2a1cd0d747c3370a1c552f487cfbe2170`; accountant `0xe99849f55fd601dbc8e13b624a2509f9496b4faa`; verifier `0xA9990cB1f9578910D2650782832A7890270D23A8`; source `0x1aD812aA6C49fD41908dE649CC9A3Dfff1E6E9e6`; CoreOps `0x5021afee36fd2ec6041a67fd03439d40c0bde1c4`; Lens `0x236808860d971da83fea76e1848ded39175f3a60`
  - Explorer: https://hyperevmscan.io/address/0x6c4556b8068397AD2F3e69205b7C100CAf234883
  - Instant withdrawal with no price record (oracle-only scope): tx `0x03c59bb38d14a00313800ce35b623ef9bea0d27ed0c0a30d9e9e6b2fc704f78d`
- v4 vault (retired 2026-10-13): `0xf9c05bf416F6E45bf3658A92C94fE4f8f03a6b4F`; share token hvUSDC `0x6960fd2d19167ba2d6175e16a5f27342b6e0d29d`; accountant `0x9a5c6a1bd9acdcc08803dd502379bc2f9d328459`; NAV verifier `0x96A41336fa0a271c7956d4d1b9e31272F10226bd`; source `0x94Ea87A22044AF089D98ACd59E983aEC04DB0290`
  - Explorer: https://hyperevmscan.io/address/0xf9c05bf416F6E45bf3658A92C94fE4f8f03a6b4F
  - Instant withdrawal while Active (1 USDC of shares → 0.998270 USDC): tx `0x33184f87e132c1638160005df7dc04dc2462d5607401abe796e99220d21e748f`
- v3 vault (retired 2026-10-12, withdraw-only for its one remaining holder): `0x2affc225fa3566ea48Bc48e61b50e7Bbcf770516`; share token `0x351d11605ec33916a42f7fbd1245a498bdb9c7a6`
  - Explorer: https://hyperevmscan.io/address/0x2affc225fa3566ea48Bc48e61b50e7Bbcf770516
  - Evidence: `frontend/public/hypervault/evidence-v3.json` (raw JSON; the FE page was removed 2026-10-12)
- v2 vault (retired; HWM fee and transfer demo ran here): `0x4Dd7a7ECB3Bc91792b83e0Ee5fFb5b0E7fF9C58B`, evidence `evidence-v2.json`
- v1 vault (runs 1–3, retired from deposits): `0x46c0e94C07111390d7B1F49147AB397B2d991eAe` on HyperEVM (chain 999)
  - Explorer: https://hyperevmscan.io/address/0x46c0e94C07111390d7B1F49147AB397B2d991eAe
  - Core account: https://app.hyperliquid.xyz/explorer/address/0x46c0e94C07111390d7B1F49147AB397B2d991eAe
- Modules: source `0xf4094199a3a9556c0719e5ab75fdc6fa4f590dc1`, bridge `0x75798f2797e887be93f2d430e8a4a850ffa610b2`, verifier `0x72abc2bc36231e413974be2ee65bcd59afed5b5c`, controller `0xf8f90463Eaf559B4da2f873b481A929363c34fCc`, implementation `0xB2d69CFb6DF1735a2b450293Df334e257c7Bfb88`
- Step-by-step ledger with tx hashes: `frontend/public/hypervault/evidence.json` (raw JSON)
- Monitor output: `frontend/public/hypervault/monitor.json` (`#/ops`)

### Mainnet findings worth showing

| Finding | Evidence |
| --- | --- |
| v2: shares are a plain ERC-20; 3e9 shares transferred to a second wallet were redeemed like any other share | v2 run 1 `share-transfer`, `claim-demo-user` |
| v2: right after a +4.2% NAV rise the fee was 0, the published rate stayed at 1.000 and deposits closed; ~10 min later the window caught up and `checkpoint` minted 0.05 USDC of fee shares (10% of the gain) | v2 run 1 `spike-guard-observed`, `checkpoint-fee-crystallized` (gain is synthetic, labelled) |
| v2: NAV-priced deposit after the fee: preview = minted 9,638,553,471 shares at 1.0375, 274,531 gas | v2 run 1 `deposit-demo-user-active` |
| EVM→Core activation works: 1 USDC via Circle CoreDepositWallet created the vault's Core account; the whole 1 USDC went to the new-account fee | bootstrap tx `0x7269eea0…`, Core USDC 0.0 afterwards |
| Read-precompile NAV matches the HyperCore ledger exactly with a HYPE spot position (diff 0) | run 1 `nav-reconcile-hype` |
| With an open perp short in Unified mode, precompile ledgers are disjoint (spot USDC excludes margin, perp account value includes uPnL): no double count | run 2 `nav-reconcile-hedged` |
| EVM success ≠ Core success: `setAbstraction(PortfolioMargin)` succeeded on the EVM but Core kept `default` | run 1 `observe-pm-rejected` |
| Core→EVM recall pays transfer gas in HYPE on Core (0.000176 / 0.000212 HYPE observed) | `sync-recall-7`, `sync-recall-11` |
| Live hedge from the strategy runner: spot 0.16 HYPE bought at 86.343, perp short of the FILLED 0.16 at 86.307 (2x), funding +0.000173 USDC received at 18:00 UTC, then closed (short first) | run 2 `strategy-open-hedge`, `funding-received`, `strategy-unwind` |
| Active deposit priced by the onchain NAV: 10 USDC minted exactly `10e6 × (supply+1000)/(assets+1)` shares; the existing holder kept 15.0 USDC of value. Idle redeem settled in the same transaction | run 3 `nav-priced-issuance`, `request-redeem-owner` |
| A separate depositor's full cycle: 25 USDC in → 24.981177 out; loss, so performance fee 0 and loss carried forward (0.018823) | run 2 `user-deposit` … `claim-demo-user` |
| Small-vault edge case: unsellable gas-reserve dust (<$10 minimum order) blocks exit settlement under a 3% drawdown guard unless removed from scope | run 1 `scope-drop-unsellable-hype` |

## 3. Trust boundaries (say these out loud)

- The owner registers the valuation scope; holdings outside it are invisible to NAV (owner-trusted completeness). The current v3 deployment deliberately has no third-party reports and no drawdown wait: if the owner moved value outside the scope, issuance and settlement would still proceed at the lower NAV.
- The owner and the API wallet have trading authority over the vault's Core account.
- Withdrawals need owner cooperation: unwind, recall to EVM, revoke the agent, then settle. There is no deadline or permissionless exit, and every Active exit unwinds the whole strategy, including holders who did not request. A buffer-backed instant partial redeem is designed but not implemented (ADR-036).
- Core actions are asynchronous and Core never returns a receipt to the EVM; the verifier infers non-recall success from a later Core block.

## 4. Pitch script (≈2.5 min)

1. *Problem (20s).* Carry on Hyperliquid needs a HyperCore account; vault tokens need an EVM contract. Bridging the two usually means trusting someone to report what the Core account is worth.
2. *Idea (30s).* HyperVault makes the vault contract its own HyperCore account. Custody, shares and the withdrawal queue live on HyperEVM; spot, perps and Portfolio Margin live on HyperCore. NAV is read onchain from HyperCore precompiles.
3. *Three products (30s).* HYPE and BTC vaults keep your asset exposure and add hedged carry on top — denominated in HYPE or BTC, so a price rally is not counted as manager performance. A USDC vault runs delta-neutral carry.
4. *Why PM (30s).* For the same $10k spot and short, Portfolio Margin needs about $10.5k of own capital instead of about $15.75k with separate stablecoin margin; the funding earned is identical, the capital tied up is not. (Table at `#/strategy`.)
5. *Proof (30s).* We ran it on mainnet with our own small funds: three complete round trips on a USDC vault, NAV reconciled to the HyperCore ledger with a live hedge, and every EVM step's tx hash and every Core order id are public.
6. *Honesty + next (10s).* PM needs >$10k account value, so the live hedge used Unified mode. Next: HYPE/BTC vaults on mainnet, PM-sized test, audit.

## 5. Demo script (≤3 min)

1. `#/` (15s) — three vaults, architecture, trust boundaries.
2. `#/vaults/<vault>` (40s) — live NAV from precompiles, EVM cash, Core balances, phase; why deposits close (price-history / pending action).
3. Vault page Activity (60s): trades, funding and transfers with explorer links. Open one tx on the explorer and the Core account page. The full step ledger is the raw `evidence*.json` in the repo.
4. `#/ops` (30s) — 14 rules (incl. borrow health) with units/thresholds, last success time, AI summary labelled advisory-only.
5. `#/strategy` (25s) — PM vs separate-margin table with assumptions; HYPE/BTC dry-run plans marked dry-run.
6. Close (10s) — what is not done yet.

## 6. Code and change scope

- Repository: provide the link (team). Exclude `.env`, `cache/`, `broadcast/*/dry-run`, `~/.config/hypervault`. Operator keys live outside the repo in `~/.config/hypervault`; the root `.env` holds the owner key and must never be published.
- Before the hackathon (pre-existing in this repo, per CHANGELOG up to 2026-10-11): Managed vault contracts, precompile NAV source/verifier, per-asset vault + bridge, direct-deploy scripts, the original FE and chat server.
- During the hackathon (2026-10-12), v2: `src/hypervault/` (HyperVault manager, HyperVaultShare, HyperVaultAccountant), `script/DeployHyperVault.s.sol`, `test/HyperVault.t.sol`; mainnet v2 deployment and run. These are new contracts; v1 contracts are unchanged.
- During the hackathon (2026-10-12), v1 phase: `scripts/hypervault/` (round-trip runner, strategy runner, monitor + AI summary, PM comparison), HyperVault FE pages (`#/`, `#/vaults`, `#/evidence`, `#/ops`, `#/strategy`, direct-vault trade wiring), mainnet deployment and the three round trips, tests `test/python/test_hypervault_strategy.py` and FE `src/hypervault.test.ts`, docs `docs/hypervault.ko.md`, this file. No Solidity contract changes.

## 7. Items only the team can provide

- [ ] Confirm the deadline and required fields on the Colosseum dashboard; accept terms.
- [ ] Public repository URL (and whether to include pre-hackathon history).
- [ ] Pitch video URL and demo video URL (record from the scripts above).
- [ ] Founder profiles, team contacts.
- [ ] Logo final approval. App URL: https://vault.hypurrquant.com (live, 2026-10-12).
- [ ] Final submission click on Colosseum — development completion is not submission.
