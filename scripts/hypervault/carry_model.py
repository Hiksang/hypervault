"""USDC Carry math (pure, no I/O): sizing, carry, breakeven and liquidation distances.

USDC Carry: the vault holds USDC. All spot HYPE is hedged by an equal perp short. The spot is
re-used as collateral and USDC is borrowed against it to grow the hedged notional. With buffer b
kept on EVM, short leverage L and actual LTV q (= total USDC debt / spot HYPE value), per unit of
vault capital V (user's APR/LTV doc, 2026-10-12):

    h    = (1 - b) / (1 + 1/L - q)          spot = short notional / V
    debt = h (1 + 1/L) - (1 - b)            USDC borrowed / V        (debt = q h)

Net APR = [h f - debt r - h c n] x (1 - fee) when positive (no fee on a loss), with funding f,
borrow APR r, round-trip cost c = 0.23% (spot 0.07% + perp 0.045%, in and out) and n round trips.

Liquidation (no rebalancing; the maintenance rate m of the perp is 1 / (2 x maxLeverage)):
  Unified  short leg   is margined by USDC only (spot HYPE is not perp collateral):
                       rally r_up = (margin/notional - m) / (1 + m)
           borrow leg  borrowLend partial liquidation when debt > collateral x (1 + LTV)/2:
                       fall to liquidation = 1 - debt / (collateral x (1 + LTV)/2)
  Portfolio Margin     one ratio (docs): (offset + perp maintenance + net USDC debt)
                       / (HYPE x px x (0.5 + 0.5 LTV)); liquidatable above 0.95. Short losses add
                       to the debt 1:1 while collateral only counts at the threshold, so a rally
                       is the risk; a fall pays the short and lowers the ratio.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal as D

ROUND_TRIP_COST = D("0.0023")  # spot 0.07% + perp 0.045%, entry and exit (taker, base tier)
PERFORMANCE_FEE = D("0.10")
PM_LIQUIDATABLE = D("0.95")
PM_MIN_BORROW_OFFSET = D("20")
PM_MIN_ACCOUNT_USD = D("10000")


@dataclass(frozen=True)
class Shape:
    """Exposures per unit of vault capital V."""

    q: D
    leverage: D
    buffer: D
    spot: D  # h: spot HYPE value = short notional
    debt: D  # USDC borrowed
    margin: D  # USDC left on Core for the short: own Core capital + debt - spot

    @property
    def ltv(self) -> D:
        return self.debt / self.spot if self.spot else D(0)


def usdc_shape(q, leverage, buffer=D("0.1")) -> Shape:
    q, lev, b = D(str(q)), D(str(leverage)), D(str(buffer))
    if q < 0 or q >= 1 + 1 / lev:
        raise ValueError("q out of range")
    h = (1 - b) / (1 + 1 / lev - q)
    debt = h * (1 + 1 / lev) - (1 - b)
    debt = max(debt, D(0))
    return Shape(q=q, leverage=lev, buffer=b, spot=h, debt=debt, margin=(1 - b) + debt - h)


def net_apr(spot, debt, funding, borrow, round_trips=1, fee=PERFORMANCE_FEE) -> D:
    spot, debt, f, r = (D(str(x)) for x in (spot, debt, funding, borrow))
    gross = spot * f - debt * r - spot * ROUND_TRIP_COST * D(str(round_trips))
    return gross * (1 - D(str(fee))) if gross > 0 else gross


def breakeven_funding(spot, debt, borrow, round_trips=1) -> D:
    spot, debt, r = (D(str(x)) for x in (spot, debt, borrow))
    return (debt * r) / spot + ROUND_TRIP_COST * D(str(round_trips)) if spot else D(0)


def stablecoin_borrow_apr(utilization) -> D:
    """Docs: 0.05 + 4.75 x max(0, utilization - 0.8), APY."""
    return D("0.05") + D("4.75") * max(D(0), D(str(utilization)) - D("0.8"))


def maintenance_rate(max_leverage) -> D:
    return D(1) / (2 * D(str(max_leverage)))


def liq_threshold(ltv) -> D:
    return D("0.5") + D("0.5") * D(str(ltv))


def unified_short_rally(margin_usd, notional_usd, mm) -> D | None:
    """HYPE rally that liquidates a USDC-margined short (no other positions). None without a short."""
    margin, ntl, mm = D(str(margin_usd)), D(str(notional_usd)), D(str(mm))
    if ntl <= 0:
        return None
    return max((margin / ntl - mm) / (1 + mm), D(0))


def borrow_fall(debt_usd, collateral_usd, ltv) -> D | None:
    """Uniform collateral price fall that reaches borrowLend partial liquidation. None without debt."""
    debt, coll = D(str(debt_usd)), D(str(collateral_usd))
    if debt <= 0:
        return None
    if coll <= 0:
        return D(0)
    return max(D(1) - debt / (coll * liq_threshold(ltv)), D(0))


def pm_ratio(debt_net_usd, spot_usd, short_usd, mm, ltv, offset=PM_MIN_BORROW_OFFSET) -> D:
    """Portfolio margin ratio for a one-token carry (docs formula, USDC as the borrowed token)."""
    coll = D(str(spot_usd)) * liq_threshold(ltv)
    need = D(str(offset)) + D(str(mm)) * D(str(short_usd)) + max(D(str(debt_net_usd)), D(0))
    return need / coll if coll > 0 else D(99)


def pm_move_to_liquidation(ratio_now, spot_usd, short_usd, mm, ltv) -> D | None:
    """Price move r (signed) at which the PM ratio reaches 0.95, anchored on the observed ratio.

    need(r) = ratio_now x C + (mm + 1) x short x r      (maintenance and short loss grow with r)
    coll(r) = C x (1 + r),   C = spot x (0.5 + 0.5 LTV)
    None when no move in that model reaches it (collateral outruns the requirement)."""
    c = D(str(spot_usd)) * liq_threshold(ltv)
    if c <= 0:
        return None
    need0 = D(str(ratio_now)) * c
    slope = (1 + D(str(mm))) * D(str(short_usd)) - PM_LIQUIDATABLE * c
    if slope == 0:
        return None
    r = (PM_LIQUIDATABLE * c - need0) / slope
    return r if r > -1 else None
