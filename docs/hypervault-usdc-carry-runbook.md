# USDC Carry operations runbook (dry-run tooling)

Status 2026-10-12: planning and monitoring only. Nothing here signs or moves funds. Formulas follow
the user's APR/LTV document (USDC section); code in `scripts/hypervault/carry_model.py`.

## Shape

The vault holds USDC. All spot HYPE is hedged by an equal perp short. The spot is used as
collateral, and USDC is borrowed against it to grow the hedged notional. The buffer b stays on EVM.
L is the short leverage and q is the actual LTV (USDC debt / spot HYPE value).

    spot = (1 - b) / (1 + 1/L - q)        debt = spot (1 + 1/L) - (1 - b) = q x spot
    breakeven funding = q x borrow APR + 0.23%      highest carrying q = (funding - 0.23%) / borrow

## Modes

| | Unified | Portfolio Margin |
|---|---|---|
| Borrowing | Explicit `borrowLend`, signed by the API wallet: supply HYPE, then borrow USDC | Automatic against collateral when an order needs it |
| Short margin | USDC only. Spot HYPE is not perp margin. At L = 10 the short liquidates on about a +4.8% rally, so the default is L = 2 (about +43%) | Spot and short are netted in one ratio. Liquidatable when the ratio is above 0.95. Default L = 10 |
| Main risks | Short on a rally; borrow on a fall (usage = debt / (collateral x 0.825)) | Rally (a short loss adds 1:1 to the debt) |
| Requirement | None | Account value above $10k. A 10,000 USDC vault with a 10% EVM buffer has only 9,000 on Core and does not qualify |

## Commands

    # plan for the live v4 vault (its abstraction decides the mode)
    python3 scripts/hypervault/usdc_carry.py --target-q 0.30
    python3 scripts/hypervault/usdc_carry.py --unwind
    # hypothetical capital
    python3 scripts/hypervault/usdc_carry.py --hypo-capital 10000 --mode portfolioMargin --target-q 0.40 --max-notional 1000000
    # monitors (read-only, own output .omc/hypervault/monitor-<name>.json, never the FE file)
    python3 scripts/hypervault/mode_monitor.py --account <vault> --label "v4 vault" --name unified-v4 --target-q 0 --loop --interval 180
    python3 scripts/hypervault/mode_monitor.py --account <pm account> --label "third-party PM" --name pm-observed --observe --loop --interval 240
    # fold the same rules into the vault monitor (ids prefixed carry-)
    HV_VERSION=v4 python3 scripts/hypervault/monitor.py --carry-rules 0 ...

## Order of operations (as `usdc_carry.py` emits them)

- **Expand, Unified:**
  - Before anything else, on a vault: the owner runs `roundtrip.py scope --blp`. A supplied HYPE balance under `lending=false` makes the NAV source revert.
  - Then: supply the unsupplied HYPE → borrow USDC → buy spot → short the filled size. Repeat per round within 95% of the remaining capacity.
  - Supply the last spot bought.
- **Expand, PM:** buy spot (auto-borrow) → short the filled size, round by round.
- **Reduce, Unified:**
  - Close the short x → repay with the freed margin → withdraw HYPE (only as much as keeps usage ≤ 0.70) → sell → repay the proceeds.
  - Unwind: reduce, repay all (null), withdraw all (null), close the remaining short, sell the remaining lot if the rounded lot is at least 10 USDC.
- **Reduce, PM:** close the short → sell (the balance repays).

## Guards

The planner blocks a plan, or lowers its target, when:
- 24h or 7d funding is below breakeven, or is not positive;
- q is above min(0.60, reserve LTV − 0.05);
- Unified: the short has less than a 25% rally to liquidation, the borrow has less than a 25% fall to liquidation, or borrow usage is above 0.70;
- PM: the ratio estimate × 1.15 is above 0.50, there is less than a 25% move to liquidation, or the account is under $10k;
- the abstraction differs from the plan;
- an order is below the $11 minimum;
- the book touch is less than 5× the order size (split into IOC chunks);
- the plan exceeds the max notional cap;
- residual delta is above $2.

The PM ratio uses the docs formula. On a live PM account it read 0.374 against the API's 0.410, about 9% low, hence the 1.15 safety factor in planning. Monitoring uses the API ratio itself.
