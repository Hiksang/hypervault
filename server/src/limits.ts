// spend(now) takes one from an allowance of `burst` that refills at
// `perSecond`, and returns 0, or the milliseconds until one is there to take.
// The allowance is counted in milliseconds of refill, which keeps it exact.
export function createBudget(burst: number, perSecond: number) {
  const cost = 1000 / perSecond;
  const full = burst * cost;
  let credit = full;
  let at = -Infinity;
  return function spend(now: number): number {
    // A time earlier than one already seen earns nothing, then or later.
    if (now > at) {
      credit = Math.min(full, credit + (now - at));
      at = now;
    }
    if (credit < cost) return Math.ceil(cost - credit);
    credit -= cost;
    return 0;
  };
}
const minGap = 3_000;
const windowSpan = 10 * 60_000;
const windowMax = 30;
// take(key, now) returns 0 and counts the post when it is allowed, otherwise
// the milliseconds to wait. Only allowed posts are counted. `now` must come
// from a clock that never goes back, or a corrected wall clock locks authors
// out until it catches up.
export function createLimiter() {
  const posts = new Map<string, number[]>();
  let swept = 0;
  return function take(key: string, now: number): number {
    if (now - swept >= windowSpan) {
      for (const [other, times] of posts)
        if (now - (times.at(-1) ?? 0) >= windowSpan) posts.delete(other);
      swept = now;
    }
    const times = (posts.get(key) ?? []).filter((at) => now - at < windowSpan);
    const oldest = times[0];
    const last = times.at(-1);
    const wait = Math.max(
      last === undefined ? 0 : last + minGap - now,
      oldest === undefined || times.length < windowMax
        ? 0
        : oldest + windowSpan - now,
      0,
    );
    if (wait === 0) times.push(now);
    posts.set(key, times);
    return wait;
  };
}
