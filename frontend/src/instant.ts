/**
 * Instant redemption from a running vault's EVM buffer (`HyperVault.redeemNow`). Prices are the
 * accountant's post-fee share price, scaled by 1e30 (the conservative rate the call pays at).
 */
export const PRICE_SCALE = 10n ** 30n;
export const REDEEM_NOW_SIGNATURE =
  "redeemNow(uint256,address,address,uint256,uint256)";
/** keccak256 of the signature, first 4 bytes, without 0x. */
export const REDEEM_NOW_SELECTOR = "782500e1";

/** `HyperVault.INSTANT_EXIT_FEE_BPS`: kept in the vault for the holders who stay. */
export const EXIT_FEE_BPS = 10n;

/** What `redeemNow(shares)` pays at `price`, after the exit fee (rounded down like the contract). */
export function payout(shares: bigint, price: bigint) {
  return (
    (((shares * price) / PRICE_SCALE) * (10_000n - EXIT_FEE_BPS)) / 10_000n
  );
}

/** Shares the buffer can pay now, and their value: the holder's shares capped by free cash. */
export function instantCap(held: bigint, freeCash: bigint, price: bigint) {
  if (price === 0n) return { shares: 0n, assets: 0n };
  const byCash =
    (freeCash * PRICE_SCALE * 10_000n) / (price * (10_000n - EXIT_FEE_BPS));
  const shares = held < byCash ? held : byCash;
  return { shares, assets: payout(shares, price) };
}

/** Shares to redeem to receive `assets` after the fee (rounded down, at most `maxShares`). */
export function sharesFor(assets: bigint, price: bigint, maxShares: bigint) {
  if (price === 0n) return 0n;
  const shares =
    (assets * PRICE_SCALE * 10_000n) / (price * (10_000n - EXIT_FEE_BPS));
  return shares < maxShares ? shares : maxShares;
}

/** Whether deployed runtime code contains a function selector (PUSH4 in the dispatcher). */
export function hasSelector(code: string | undefined, selector: string) {
  return !!code && code.toLowerCase().includes(`63${selector.toLowerCase()}`);
}
