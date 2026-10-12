import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentSegment,
  parseNavHistory,
  realizedReturn,
} from "./navHistory.ts";

const DAY = 86_400;
const p = (t: number, price: number | null) => ({
  t,
  nav: 1,
  supply: price === null ? 0 : 1,
  price,
});

test("a return never spans an empty vault", () => {
  const pts = [
    p(0, 1),
    p(DAY, 1.2),
    p(2 * DAY, null),
    p(3 * DAY, 1),
    p(4 * DAY, 1.01),
  ];
  assert.deepEqual(
    currentSegment(pts).map((x) => x.t),
    [3 * DAY, 4 * DAY],
  );
  const r = realizedReturn(pts)!;
  assert.ok(Math.abs(r.cumulative - 0.01) < 1e-12);
  assert.equal(r.annualized, null, "one day is not annualized");
});

test("annualized only after 30 days", () => {
  const r = realizedReturn([p(0, 1), p(60 * DAY, 1.01)])!;
  assert.ok(Math.abs(r.annualized! - (Math.pow(1.01, 365 / 60) - 1)) < 1e-12);
  assert.equal(realizedReturn([p(0, 1)]), null);
});

test("parser rejects a malformed file and sorts points", () => {
  assert.throws(() => parseNavHistory({ points: [] }));
  const h = parseNavHistory({ vault: "0x1", points: [p(5, 1), p(1, null)] });
  assert.deepEqual(
    h.points.map((x) => x.t),
    [1, 5],
  );
});
