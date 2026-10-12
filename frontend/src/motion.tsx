import { useEffect, useRef } from "react";

/** Motion is decoration only: everything renders final values without it. */
const reduced = () =>
  typeof window === "undefined" ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Counts a number up from zero once, writing to the DOM directly (no React state per frame).
 * The final text is rendered first, so readers without motion see the real value.
 */
export function CountUp({
  value,
  format,
  ms = 900,
}: {
  value: number;
  format: (x: number) => string;
  ms?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced()) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(value * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = format(value);
    };
  }, [value]);
  return (
    <span ref={ref} aria-label={format(value)}>
      {format(value)}
    </span>
  );
}

/** A headline whose words rise in sequence (CSS only; static under reduced motion). */
export function Words({ text }: { text: string }) {
  return (
    <span className="words" aria-label={text}>
      {text.split(" ").map((w, i) => (
        <span
          key={i}
          className="word"
          aria-hidden
          style={{ "--w": i } as React.CSSProperties}
        >
          {w}{" "}
        </span>
      ))}
    </span>
  );
}
