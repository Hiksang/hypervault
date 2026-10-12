import { test } from "node:test";
import assert from "node:assert/strict";
import { foreignFrame } from "./frame.ts";

type Win = { parent: Win; location: { origin: string } };
/** A window of `origin`, on top or inside `parent`. Reading another origin's location throws. */
function win(origin: string, parent?: Win, viewer = origin): Win {
  const self = {
    get location() {
      if (viewer !== origin) throw new Error("SecurityError");
      return { origin };
    },
  } as Win;
  self.parent = parent ?? self;
  return self;
}
const SITE = "https://vault.example";

test("the page runs on top, or inside a page of its own origin, and nowhere else", () => {
  assert.equal(foreignFrame(win(SITE)), false);
  assert.equal(foreignFrame(win(SITE, win(SITE))), false);
  assert.equal(foreignFrame(win(SITE, win(SITE, win(SITE)))), false);
  // Another site's page around it: reading that window's origin throws.
  const other = win("https://evil.example", undefined, SITE);
  assert.equal(foreignFrame(win(SITE, other)), true);
  // The same, where the browser lets the origin be read.
  assert.equal(foreignFrame(win(SITE, win("https://evil.example"))), true);
  assert.equal(foreignFrame(win(SITE, win("http://vault.example"))), true);
  assert.equal(
    foreignFrame(win(SITE, win("https://vault.example:8443"))),
    true,
  );
  // Its own origin right around it, and another site's around that.
  assert.equal(foreignFrame(win(SITE, win(SITE, other))), true);
  // A sandboxed frame has no origin of its own to compare.
  assert.equal(foreignFrame(win("null", other)), true);
});
