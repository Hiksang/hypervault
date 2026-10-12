import { useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hash } from "viem";
import { chain } from "../chain";
import {
  decodeHistory,
  fetchRange,
  historyEvents,
  sortHistory,
  withBackoff,
  withdrawKind,
  type DecodedLog,
  type HistoryItem,
} from "../history";
import { failureText } from "../ui";
import { isRateLimit } from "../history";
import { SectionError, Skel } from "./kit";

/**
 * The public node accepts 1,000 blocks per eth_getLogs but rate-limits by range: 100–200-block
 * windows pass most of the time, 500+ mostly do not (measured 2026-10-13). So: 200-block windows,
 * one at a time with a short pause, backoff on -32005, and 8,000 blocks (about 2 hours of
 * HyperEVM) per pass; older history loads on request. A full history needs an indexer.
 */
const LOG_NODE = !!import.meta.env.VITE_LOGS_RPC_URL;
const WINDOW = LOG_NODE ? 1000n : 200n;
const PASS_BLOCKS = LOG_NODE ? 50_000n : 8_000n;
const PAUSE_MS = LOG_NODE ? 50 : 250;

type Scan = {
  items: HistoryItem[];
  /** A pass stopped midway (rate limit): the next scan resumes it. */
  partial: boolean;
  /** Highest and lowest block already scanned; history below `oldest` is not read yet. */
  newest: bigint;
  oldest: bigint;
};

// Its own client, without JSON-RPC batching: under load the public node answers a batch with
// one bare `-32005` object, which a batching transport cannot match to its requests (it fails
// with "reading 'error'"); unbatched, a rate limit surfaces as -32005 and is retried.
// VITE_LOGS_RPC_URL may name a node with roomier log limits (it is added to the CSP).
const client = createPublicClient({
  chain,
  transport: http(import.meta.env.VITE_LOGS_RPC_URL || undefined, {
    timeout: 15000,
    retryCount: 0,
    batch: false,
  }),
  ccipRead: false,
});

// Per page session: a revisit only scans the blocks since the last scan.
const cache = new Map<string, Scan>();

async function logsOf(vault: Address, from: bigint, to: bigint) {
  return fetchRange(
    async (lo, hi) => {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
      return client.getLogs({
        address: vault,
        events: historyEvents,
        fromBlock: lo,
        toBlock: hi,
      }) as unknown as Promise<DecodedLog[]>;
    },
    from,
    to,
    WINDOW,
  );
}

/** Instant vs claim (by the calling function) and block times, for rows that lack them. */
async function complete(items: HistoryItem[]): Promise<HistoryItem[]> {
  const blocks = new Map<bigint, number>();
  const kinds = new Map<Hash, HistoryItem["kind"]>();
  // One at a time: a handful of rows, and the public node rate-limits bursts.
  for (const b of new Set(
    items.filter((i) => i.time === undefined).map((i) => i.block),
  )) {
    const x = await withBackoff(() => client.getBlock({ blockNumber: b }));
    blocks.set(b, Number(x.timestamp));
  }
  for (const h of new Set(
    items.filter((i) => i.kind === "Claim").map((i) => i.tx),
  )) {
    const t = await withBackoff(() => client.getTransaction({ hash: h }));
    kinds.set(h, withdrawKind(t.input));
  }
  return items.map((i) => ({
    ...i,
    time: i.time ?? blocks.get(i.block),
    kind: i.kind === "Claim" ? (kinds.get(i.tx) ?? i.kind) : i.kind,
  }));
}

/**
 * New blocks since the last scan, then (first time, or on "Load older") up to PASS_BLOCKS further
 * back, one window at a time. Progress is kept after every window, so a rate limit midway keeps
 * the rows found and Retry continues from where it stopped (`partial` marks that case).
 */
async function scan(
  vault: Address,
  user: Address,
  floor: bigint,
  older: boolean,
): Promise<Scan> {
  const key = `${vault}:${user}`.toLowerCase();
  const head = await withBackoff(() => client.getBlockNumber());
  const prev = cache.get(key);
  const s: Scan = prev
    ? { ...prev }
    : { items: [], newest: head, oldest: head + 1n, partial: false };
  const add = async (from: bigint, to: bigint) => {
    const fresh = await complete(
      decodeHistory(await logsOf(vault, from, to), user),
    );
    const seen = new Set(s.items.map((i) => `${i.tx}:${i.logIndex}`));
    s.items = sortHistory([
      ...s.items,
      ...fresh.filter((i) => !seen.has(`${i.tx}:${i.logIndex}`)),
    ]);
  };
  try {
    if (prev && head > prev.newest) await add(prev.newest + 1n, head);
    s.newest = head;
    if (!prev || older || prev.partial) {
      const stop =
        s.oldest - PASS_BLOCKS > floor ? s.oldest - PASS_BLOCKS : floor;
      s.partial = true;
      while (s.oldest > stop) {
        const lo = s.oldest - WINDOW > stop ? s.oldest - WINDOW : stop;
        await add(lo, s.oldest - 1n);
        s.oldest = lo;
        cache.set(key, { ...s });
      }
      s.partial = false;
    }
  } finally {
    cache.set(key, { ...s });
  }
  return s;
}

const fmtUnits = (raw: bigint, decimals: number, places: number) => {
  // Half-up, like the rest of the app: 0.0999 USDC reads 0.10, not 0.09.
  const scale = 10n ** BigInt(Math.max(decimals - places, 0));
  const v = scale > 1n ? (raw + scale / 2n) / scale : raw;
  const whole = v / 10n ** BigInt(places);
  const frac = (v % 10n ** BigInt(places)).toString().padStart(places, "0");
  return `${whole.toLocaleString("en-US")}.${frac}`;
};

/** The connected holder's deposits, requests, instant withdrawals and claims on this vault. */
export function AccountHistory({
  vault,
  user,
  fromBlock,
  decimals,
  shareDecimals,
  unit,
  refresh,
}: {
  vault: Address;
  user: Address;
  fromBlock: number;
  decimals: number;
  shareDecimals: number;
  unit: string;
  /** Changes when the position is re-read (after a transaction), to pick up new rows. */
  refresh: number;
}) {
  const [data, setData] = useState<Scan | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [older, setOlder] = useState(0);
  const floor = BigInt(fromBlock);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    scan(vault, user, floor, older > 0).then(
      (s) => {
        if (!alive) return;
        setData({ ...s });
        setFailure("");
        setBusy(false);
      },
      (e) => {
        if (!alive) return;
        const kept = cache.get(`${vault}:${user}`.toLowerCase());
        if (kept) setData({ ...kept });
        setFailure(
          isRateLimit(e)
            ? "The network node is busy (rate limited). Try again in a minute."
            : failureText(e),
        );
        setBusy(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [vault, user, floor, tick, older, refresh]);

  return (
    <section className="history" aria-labelledby="hist-h">
      <h3 id="hist-h">Your activity</h3>
      {failure && !data ? (
        <SectionError
          what="Your activity could not be read."
          detail={failure}
          onRetry={() => setTick((n) => n + 1)}
        />
      ) : !data ? (
        <div className="history-skel" aria-busy="true">
          <Skel h={24} />
          <Skel h={24} />
          <Skel h={24} />
        </div>
      ) : (
        <>
          {data.items.length === 0 ? (
            <p className="fine">
              {data.oldest > floor
                ? "No activity in the blocks read so far."
                : "No activity yet."}
            </p>
          ) : (
            <ul className="history-list">
              {data.items.map((i) => (
                <li key={`${i.tx}:${i.logIndex}`}>
                  <span className="history-kind">{i.kind}</span>
                  <span className="num history-amt">
                    {i.assets !== null
                      ? `${fmtUnits(i.assets, decimals, 2)} ${unit}`
                      : "Paid at settlement"}
                    <small>{fmtUnits(i.shares, shareDecimals, 4)} shares</small>
                  </span>
                  <a
                    className="history-time"
                    href={`https://hyperevmscan.io/tx/${i.tx}`}
                    target="_blank"
                    rel="noreferrer"
                    title={i.tx}
                  >
                    {i.time
                      ? new Date(i.time * 1000).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : `Block ${i.block}`}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {failure && (
            <SectionError
              what="The latest activity could not be read."
              detail={failure}
              onRetry={() => setTick((n) => n + 1)}
            />
          )}
          {data.oldest > floor && (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => setOlder((n) => n + 1)}
            >
              {busy ? "Reading…" : "Load older activity"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
