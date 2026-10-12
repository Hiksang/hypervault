/**
 * Scroll-entry reveal: elements matching `selector` fade up once as they enter the viewport.
 * IntersectionObserver only (no scroll listeners); does nothing under reduced motion.
 * Elements stay visible unless the observer is running, so content never hides without JS.
 */
export function observeReveals(selector: string): () => void {
  if (
    typeof IntersectionObserver === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return () => {};
  const els = [...document.querySelectorAll<HTMLElement>(selector)];
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
  );
  els.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.setProperty("--i", String(i % 4));
    io.observe(el);
  });
  return () => io.disconnect();
}
