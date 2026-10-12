type Frame = { parent: Frame; location: { origin: string } };

/**
 * Whether this window is shown inside a page of another origin. Such a page can cover this one
 * and steer a visitor's clicks onto its buttons, and this page holds a trading key. Forbidding
 * that is the host's part (`frame-ancestors`, which a policy in a meta tag cannot carry), so the
 * page also refuses by itself. Reading the origin of a window of another origin throws: that is
 * the answer too.
 */
export function foreignFrame(win: Frame): boolean {
  const own = win.location.origin;
  for (let at = win; at.parent !== at; at = at.parent) {
    try {
      if (at.parent.location.origin !== own) return true;
    } catch {
      return true;
    }
  }
  return false;
}
