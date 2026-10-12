# HyperVault — What Real Operation Needs (gap analysis)

2026-10-12. This document compares the current v3 vault ([architecture](hypervault-architecture.md)) with established vault platforms. It lists what was added for operation and what still needs a contract change. The user-facing explanation is the FE page `#/docs` ("Learn").

## 1. What other platforms ship

| Platform | Relevant features |
| --- | --- |
| Veda BoringVault ([docs](https://docs.veda.tech/architecture-and-flow-of-funds/core-components)) | Vault, Teller, Accountant and Manager are separate modules. Share lock period after deposit (anti-arbitrage). Offchain rate pushed with rate limits and deviation bounds, with a pause on out-of-bound updates. Merkle-whitelisted strategy calls. |
| Lagoon ([overview](https://octav.fi/octav-blog-posts/build-the-perfect-vault-with-lagoon-finance), [API](https://web3-ethereum-defi.readthedocs.io/vaults/lagoon/index.html)) | ERC-7540 async deposit and redeem with periodic settlement. Safe custody plus role modules. Protocol and token whitelists. Optional KYC. Performance, management and entry/exit fees. NAV from an oracle or the curator, with committee review. |
| Morpho vaults ([roles](https://docs.morpho.org/curate/concepts/roles/)) | Owner, curator, allocator and guardian/sentinel roles, held by separate multisigs. Timelocked risk increases, immediate risk decreases, and a guardian veto. |
| Yearn v3 ([VaultV3](https://docs.yearn.fi/developers/smart-contracts/V3/VaultV3)) | Role manager. Deposit-limit modules. Profit unlocking over time. Emergency shutdown. |
| Hyperliquid user vaults / HLP ([depositor docs](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-depositors)) | Leader keeps at least 5% of the vault. 10% profit share above the depositor's high-water mark. Deposit lockup: 1 day for user vaults, 4 days for HLP. |
| kHYPE (Kinetiq) ([our review](khype-deposit-buffer.ko.md)) | Separate token, manager and accountant. Instant-unstake pool and buffer targets. Pauser registry. |
| Ethena ([funding risk](https://docs.ethena.fi/protocol-overview/risks/funding-risk.md)) | Reserve fund for negative funding. Shifts to stable assets when funding is low. Published custody and exchange risks. |

## 2. Gap table

| Capability | Others | HyperVault v3 | Status |
| --- | --- | --- | --- |
| Async redeem, transferable share, HWM fee, onchain NAV | yes | yes | done (ADR-037/038) |
| Deposit cap, minimum deposit | yes | yes (1,000 / 10 USDC) | done |
| Upgrade delay | timelocks | 48 h, Idle only | done |
| **Share-price history and realized return** | dashboards | monitor publishes `nav-history.json`; FE chart; realized APR shown only after 30 days | **added** |
| **Redemption SLA** | settlement windows | 72 h commitment; monitor rule `redeem-sla` (warn 24 h, alert 72 h) | **added** (operator commitment, not enforced) |
| **Alert delivery** | ops standard | `HV_ALERT_WEBHOOK` (Slack and Discord compatible), deduplicated | **added** |
| **Negative-funding regime response** | Ethena reserve and rotation | funding rule on 24 h and 7 d averages; unwind runbook | **added** (no reserve fund) |
| **Borrow health monitoring** | lending UIs | `blp-health` rule (70% / 85% of liquidation) | added earlier |
| **User docs and risk disclosure** | all | FE `#/docs`: how it works, yield sources with a worked example, fees, withdrawals, risk table, roles, glossary, FAQ | **added** |
| Live positions, trades, funding, loans | dashboards | FE vault page from the Hyperliquid API | added earlier |
| Guardian / emergency pause | kHYPE, Veda, Yearn, Morpho | none. The owner can only disable the scope (closes Active deposits); Idle deposits cannot be paused | **contract change (v4)** |
| Separate roles, multisig owner | Morpho, Lagoon | one EOA owner | **contract change and ops**: owner is immutable in the config, so a new vault is needed |
| Strategy whitelist | Veda Merkle, Lagoon | owner-trusted (ADR-038) | contract or design change |
| Share lock after deposit | Veda, HL vaults | none (Active redeem already waits for an exit) | low priority |
| Instant partial redeem / buffer pool | kHYPE | operator buffer policy only (ADR-036) | contract change |
| Lending ledgers of a fresh account | — | registering lending before first use closes NAV | source change (v4) |
| Continuous operation | always-on keepers | monitor and runner are CLI loops on one machine | **ops: host monitor and keeper** (server or cron) |
| Audit | standard | none | required before outside capital |

## 3. Yield, from data (snapshot 2026-10-12)

HYPE perp funding, from the Hyperliquid `fundingHistory`:

| Window | Average APR | Share of hours negative |
| --- | --- | --- |
| 90 days | 10.05% | 8.9% |
| 30 days | 9.55% | 9.3% |
| 7 days | 8.55% | 8.9% |

- The worst 7-day rolling average in 90 days was 4.33% and the best was 24.28%.
- The lowest single hour was −39.8% APR.
- USDC lending was at 5.00% borrow APR, 3.47% supply APR and 77% utilization.
- A second read the same day, used by the FE (`frontend/src/marketSnapshot.ts`), gave a 30-day HYPE average of 9.61%, 3.49% supply APR and 77.5% utilization. The product pages and the user guide quote that read.
- HYPE LTV was 65%.

Fees are base tier: taker 0.045% on perps and 0.070% on spot ([fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)).

**USDC vault, 1,000 USDC.** The split is 600 spot HYPE plus a 600 short at 2x (300 margin), with 100 left as a buffer. With one round trip a year and a 10% performance fee, the net APR is:
- 5.30% at the 90-day average
- 2.21% in the worst 7-day window
- −0.14% at zero funding
- −6.14% at −10% funding

Code: `frontend/src/yieldModel.ts`, with tests.

**HYPE/BTC vault extra leg.** The extra leg earns `borrowed share × (funding − borrow APR)`. At 30% borrowed that is 30% × (10.05% − 5.00%) ≈ 1.5% per year in the base asset, before costs. It is thin and turns negative when funding falls below the borrow rate.

Levers that raise yield:
- **Portfolio Margin** (account value above $10k): spot HYPE backs the short, so more of NAV is hedged.
- **Maker orders**: −0.015% instead of the taker fee.
- **Lending idle USDC**: 3.47% supply APR. Its interaction with margin in Unified mode has not been measured.
- **Fewer rebalances.**

## 4. Risks and controls

| Risk | Control in place | Residual |
| --- | --- | --- |
| Negative funding | `funding` rule (24 h / 7 d average), unwind runbook | losses during negative regimes; no reserve fund |
| Short liquidation | 2x leverage, `margin` rule | price gaps |
| Borrow liquidation | `blp-health` rule | sharp crashes |
| Borrow-rate spikes | `borrow` rule (APR > 12%) | spread inversion |
| Execution and leg risk | short sized to the filled spot; $10 minimum check | slippage, dust |
| Operator trust (scope, trading) | `unregistered` rule, public data | no third-party checks (ADR-038) |
| Withdrawal delay | 72 h SLA, `redeem-sla` rule, buffer | no forced exit |
| Contracts | tests, review, 48 h upgrade delay | not audited |
| Platform (validators, oracle incidents, USDC bridge) | only HYPE and USDC markets | outside vault control |

## 5. Next contract version (v4) candidates

1. A guardian role that can pause deposits (Idle and Active) and new allocations, separate from the owner.
2. The owner as a multisig, with role separation (owner / allocator / guardian).
3. The source reads lending ledgers through the existing probe, so a fresh account can register lending from the start.
4. Optional: a strategy whitelist for the API wallet (market allowlist enforced by the operator tooling at minimum), and a share lock period.

All of these need a new deployment and should come with an audit.
