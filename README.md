# HyperVault

HyperVault is a USDC vault on HyperEVM that earns Hyperliquid funding with a hedged position on HyperCore. You deposit USDC and receive transferable vault shares (hvUSDC). The vault buys HYPE spot and opens an equal HYPE perp short, so price moves cancel out and the funding paid to shorts accrues to the share price.

The vault's address on HyperEVM is also its HyperCore account. It values everything it holds onchain, from HyperCore read precompiles, with no offchain price feed or operator-reported numbers.

> Unaudited prototype running with small amounts on mainnet. The operator runs the strategy and is trusted for it (see [Trust model](#trust-model)). Deposit only what you can afford to lose.

## How it works

1. **Deposit.** USDC comes in on HyperEVM and shares are minted at the live, verified NAV.
2. **Strategy runs.** The owner moves USDC to the vault's HyperCore account through CoreWriter. An API wallet approved for that account buys HYPE spot and shorts the same size. The target structure uses Portfolio Margin: spot HYPE is collateral for borrowed USDC that buys more of the same hedged pair.
3. **Track.** NAV is read onchain from precompiles: EVM cash, Core USDC, HYPE spot and lending balances, USDC debt, and perp equity. Hedged spot and the short are both valued at the HYPE perp oracle, so a spot-book or mark spike cannot move NAV.
4. **Withdraw.** Up to the free USDC kept on HyperEVM (the buffer), a withdrawal is paid in the same transaction, less a 0.1% exit fee that stays with the remaining holders. Larger withdrawals are queued and paid when the operator settles the round.

Fees: 10% of gains above the share price's high-water mark. No management or deposit fee.

## Contracts

| Contract | Role |
| --- | --- |
| `HyperVault` | ERC-4626-style deposits and ERC-7540 async redeems, instant redeem from the buffer (`redeemNow`), epochs, HWM fee. Behind a transparent proxy with a 48-hour upgrade delay. |
| `HyperVaultCoreOps` | External library for HyperCore management (allocation, recall, API wallet, lending, account mode, action sync). Runs by delegatecall in the vault. |
| `HyperVaultShare` | Plain transferable ERC-20 share token; only the vault mints, burns and escrows. |
| `HyperVaultAccountant` | Share rate and high-water-mark performance fee. |
| `HyperVaultNavSource` | Values the registered HyperCore scope from read precompiles. |
| `HyperVaultNavVerifier` | NAV for the vault, optional price records, Core action finality, exit flatness. |
| `HyperVaultLens` | Read-only views for wallets and the app (account summary, instant-redeem preview). |

Mainnet deployment (chain 999):

| | Address |
| --- | --- |
| Vault (proxy, = HyperCore account) | `0x6c4556b8068397AD2F3e69205b7C100CAf234883` |
| Implementation | `0x0985B073726B383fbFe0690E2521040511cbf993` |
| HyperVaultCoreOps | `0x5021afee36fd2ec6041a67fd03439d40c0bde1c4` |
| HyperVaultLens | `0x236808860d971da83fea76e1848ded39175f3a60` |
| Share (hvUSDC) | `0xe4479fb2a1cd0d747c3370a1c552f487cfbe2170` |
| Accountant | `0xe99849f55fd601dbc8e13b624a2509f9496b4faa` |
| NAV verifier / source | `0xA9990cB1f9578910D2650782832A7890270D23A8` / `0x1aD812aA6C49fD41908dE649CC9A3Dfff1E6E9e6` |
| Upgrade controller | `0x5dbf9ed6ede0b703c5e3849b02553d44e262e1bb` |
| USDC bridge module | `0x75798f2797e887be93f2d430e8a4a850ffa610b2` |

## Trust model

- **Owner.** Allocates to and recalls from HyperCore, approves the API wallet, registers the valuation scope and can propose upgrades (48-hour delay, executable only while the vault is idle). The owner cannot move vault cash to itself. Holdings the owner leaves outside the registered scope are not counted in NAV.
- **API wallet.** Trades on the vault's HyperCore account. It cannot withdraw funds, but bad trades can lose them.
- **Withdrawals above the buffer** depend on the operator unwinding and settling.
- **Prices.** NAV uses the Hyperliquid perp oracle for hedged HYPE; what an unwind actually realizes can differ slightly.

## Repository layout

```
src/hypervault/     HyperVault contracts
src/managed/        Shared modules (upgrade controller, USDC bridge, Core actions)
test/               Foundry tests (HyperVault*.t.sol for the vault)
script/             Foundry deployment scripts
scripts/hypervault/ Operator tools: deploy, verify, strategy runner, monitor (Python)
frontend/           Web app (Vite + React + viem)
server/             Optional per-vault chat server
docs/               Design records, status and specs (mostly Korean)
```

## Build and test

Requirements: Foundry, Node 22, Python 3.

```sh
npm ci                       # OpenZeppelin contracts
bash scripts/test_managed.sh # forge fmt/build/test, Python tests, storage-layout checks

cd frontend
npm ci
npm test
npm run build
```

The operator tools read keys from `~/.config/hypervault/<name>.key` (mode 600), never from the repository. No `.env` file is published: the app reads its settings from `VITE_*` variables (`VITE_CHAIN_ID`, `VITE_DIRECT_VAULTS` and the others read in `frontend/src`), which you set in your own environment.

## Documentation

- Current state, test counts and contract sizes: [docs/STATUS.ko.md](docs/STATUS.ko.md)
- Design decisions (ADR-036 to ADR-041 cover the current vault): [docs/DECISIONS.ko.md](docs/DECISIONS.ko.md)
- Architecture: [docs/hypervault-architecture.md](docs/hypervault-architecture.md)
- USDC Carry operations runbook: [docs/hypervault-usdc-carry-runbook.md](docs/hypervault-usdc-carry-runbook.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

[Business Source License 1.1](LICENSE). The files under `src/interfaces/` are MIT. On the Change Date (2030-10-13) the licensed work converts to GPL-2.0-or-later.
