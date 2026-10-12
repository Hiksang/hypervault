import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget, createLimiter } from "../src/limits.ts";
test("one post per three seconds, with the remaining wait reported", () => {
  const take = createLimiter();
  assert.equal(take("a", 10_000), 0);
  assert.equal(take("a", 10_001), 2_999);
  assert.equal(take("a", 12_999), 1);
  assert.equal(take("a", 13_000), 0);
});
test("a refused attempt is not counted", () => {
  const take = createLimiter();
  assert.equal(take("a", 0), 0);
  assert.equal(take("a", 2_000), 1_000);
  assert.equal(take("a", 3_000), 0);
});
test("thirty posts per ten minutes", () => {
  const take = createLimiter();
  for (let i = 0; i < 30; i++) assert.equal(take("a", i * 3_000), 0);
  // The window holds posts made from 0 s to 87 s.
  assert.equal(take("a", 90_000), 510_000);
  assert.equal(take("a", 599_999), 1);
  assert.equal(take("a", 600_000), 0);
  assert.equal(take("a", 602_999), 1);
  assert.equal(take("a", 603_000), 0);
  assert.equal(take("a", 606_000), 0);
});
test("each key has its own allowance", () => {
  const take = createLimiter();
  assert.equal(take("vault:alice", 0), 0);
  assert.equal(take("vault:bob", 0), 0);
  assert.equal(take("other:alice", 0), 0);
  assert.equal(take("vault:alice", 0), 3_000);
});
test("idle keys are forgotten without disturbing active ones", () => {
  const take = createLimiter();
  assert.equal(take("idle", 0), 0);
  assert.equal(take("busy", 599_000), 0);
  assert.equal(take("idle", 600_000), 0);
  assert.equal(take("busy", 600_000), 2_000);
});
test("a budget allows a burst, then refills at its rate", () => {
  const spend = createBudget(40, 20);
  for (let i = 0; i < 40; i++) assert.equal(spend(1_000), 0);
  assert.equal(spend(1_000), 50);
  assert.equal(spend(1_049), 1);
  assert.equal(spend(1_050), 0);
  assert.equal(spend(1_050), 50);
  // A second later twenty more are there, and no more than the burst ever.
  for (let i = 0; i < 20; i++) assert.equal(spend(2_050), 0);
  assert.equal(spend(2_050), 50);
  for (let i = 0; i < 40; i++) assert.equal(spend(60_000), 0);
  assert.equal(spend(60_000), 50);
});
test("a refused attempt does not use the budget up", () => {
  const spend = createBudget(2, 10);
  assert.equal(spend(500), 0);
  assert.equal(spend(500), 0);
  for (let i = 0; i < 100; i++) assert.equal(spend(500), 100);
  assert.equal(spend(600), 0);
});
test("a budget earns nothing from a clock that is read as going back", () => {
  const spend = createBudget(2, 10);
  assert.equal(spend(500), 0);
  assert.equal(spend(500), 0);
  // An earlier time, then the same time again: no time has passed.
  assert.equal(spend(400), 100);
  assert.equal(spend(500), 100);
  assert.equal(spend(599), 1);
  assert.equal(spend(600), 0);
  assert.equal(spend(600), 100);
});
