import type { IncomingMessage, RequestListener } from "node:http";
import type { Address } from "viem";
import {
  fresh,
  issueToken,
  readToken,
  sessionSeconds,
  signedBy,
} from "./auth.ts";
import type { Chain } from "./chain.ts";
import type { Config } from "./config.ts";
import { HttpError, statuses, type ErrorCode } from "./errors.ts";
import { corsHeaders, readJson, send, type Reply } from "./http.ts";
import { createBudget, createLimiter } from "./limits.ts";
import { createLog, describe } from "./log.ts";
import { Busy, canPost, createRoles } from "./roles.ts";
import {
  parseAddress,
  parseId,
  parsePage,
  parseSignature,
  parseText,
} from "./rules.ts";
import type { Store } from "./store.ts";
export type AppOptions = {
  db: Store;
  chain: Chain;
  config: Config;
  // Milliseconds since the epoch, like Date.now: for tokens and createdAt.
  now: () => number;
  // Milliseconds on a clock that never goes back: for caches and limits,
  // which a corrected wall clock must not stretch or reset.
  monotonic?: () => number;
  log?: (line: string) => void;
};
type Request = {
  req: IncomingMessage;
  params: string[];
  query: URLSearchParams;
};
type Route = {
  method: "GET" | "POST";
  path: RegExp;
  run: (request: Request) => Reply | Promise<Reply>;
};
export function createApp({
  db,
  chain,
  config,
  now,
  monotonic = () => performance.now(),
  log = console.error,
}: AppOptions): RequestListener {
  // Failed chain reads and internal errors are limited apart, so that an
  // RPC outage cannot crowd the service's own faults out of the log.
  const chainLog = createLog(log, monotonic, "chain read failures");
  const faultLog = createLog(log, monotonic, "internal errors");
  const roles = createRoles(chain, monotonic, chainLog);
  const take = createLimiter();
  // Checking a signature costs about 1.5 ms of CPU and anyone may ask for
  // it. Sign-ins share an allowance of 200 a second, which caps that work at
  // under a third of one core and leaves the rest of the service responsive.
  const verify = createBudget(200, 200);
  const key = {
    secret: config.sessionSecret,
    chainId: config.chainId,
    audience: config.audience,
  };
  const seconds = () => Math.floor(now() / 1000);
  const retryAfter = (wait: number) => ({
    "Retry-After": String(Math.ceil(wait / 1000)),
  });
  // A chain that cannot be read is a 503, never a guessed answer. roles.ts
  // has logged the reason, unless it is only that enough reads are out
  // already: then the caller is told to come back shortly.
  async function onChain<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw error instanceof Busy
        ? new HttpError("CHAIN_BUSY", retryAfter(1_000))
        : new HttpError("CHAIN_UNAVAILABLE");
    }
  }
  function address(value: unknown): Address {
    const parsed = parseAddress(value);
    if (!parsed) throw new HttpError("INVALID_ADDRESS");
    return parsed;
  }
  // `signed` says the request carries a token: it may then use the reads
  // kept back from requests that anyone can send.
  async function room(vault: Address, signed = false): Promise<void> {
    if (!(await onChain(() => roles.isVault(vault, signed))))
      throw new HttpError("NOT_A_VAULT");
  }
  function signer(req: IncomingMessage): Address {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "");
    const wallet = match && readToken(key, match[1] ?? "", seconds());
    if (!wallet) throw new HttpError("UNAUTHORIZED");
    return wallet;
  }
  async function session({ req }: Request): Promise<Reply> {
    const body = await readJson(req);
    const wallet = address(body.address);
    const signature = parseSignature(body.signature);
    const { issuedAt } = body;
    if (
      !signature ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0
    )
      throw new HttpError("INVALID_REQUEST");
    if (!fresh(issuedAt, seconds())) throw new HttpError("SIGNATURE_EXPIRED");
    const wait = verify(monotonic());
    if (wait > 0) throw new HttpError("BUSY", retryAfter(wait));
    // The audience is this server's own, never one named by the request.
    if (!(await signedBy(config, wallet, issuedAt, signature)))
      throw new HttpError("BAD_SIGNATURE");
    // Counted from signing, so exchanging the same signature again later
    // cannot stretch the session.
    const expiresAt = issuedAt + sessionSeconds;
    return {
      status: 200,
      body: {
        token: issueToken(key, wallet, expiresAt),
        address: wallet,
        expiresAt,
      },
    };
  }
  async function role({ params, query }: Request): Promise<Reply> {
    const vault = address(params[0]);
    const account = address(query.get("address"));
    await room(vault);
    const found = await onChain(() => roles.roleOf(vault, account));
    return {
      status: 200,
      body: { role: found, canPost: canPost(found, config.posting) },
    };
  }
  async function list({ params, query }: Request): Promise<Reply> {
    const vault = address(params[0]);
    const page = parsePage(query);
    if (!page) throw new HttpError("INVALID_REQUEST");
    await room(vault);
    return { status: 200, body: { messages: db.list(vault, page) } };
  }
  async function post({ req, params }: Request): Promise<Reply> {
    const vault = address(params[0]);
    const author = signer(req);
    const text = parseText((await readJson(req)).text);
    if (text === null) throw new HttpError("INVALID_TEXT");
    await room(vault, true);
    const found = await onChain(() => roles.roleOf(vault, author, true));
    if (!canPost(found, config.posting))
      throw new HttpError("POSTING_NOT_ALLOWED");
    const wait = take(`${vault}:${author}`, monotonic());
    if (wait > 0) throw new HttpError("RATE_LIMITED", retryAfter(wait));
    const message = db.add({
      vault,
      author,
      role: found,
      text,
      createdAt: seconds(),
    });
    return { status: 201, body: { message } };
  }
  async function hide({ req, params }: Request): Promise<Reply> {
    const vault = address(params[0]);
    const id = parseId(params[1]);
    const caller = signer(req);
    const { hidden } = await readJson(req);
    if (id === null || typeof hidden !== "boolean")
      throw new HttpError("INVALID_REQUEST");
    await room(vault, true);
    const by =
      caller === config.admin
        ? "admin"
        : caller === (await onChain(() => roles.ownerOf(vault, true)))
          ? "owner"
          : null;
    if (!by) throw new HttpError("NOT_MODERATOR");
    const current = db.hiddenBy(vault, id);
    if (current === undefined) throw new HttpError("MESSAGE_NOT_FOUND");
    // The owner may be the one being moderated, so what the admin hid stays
    // hidden until the admin says otherwise.
    if (current === "admin" && by !== "admin")
      throw new HttpError("HIDDEN_BY_ADMIN");
    const message = db.setHiddenBy(vault, id, hidden ? by : null);
    return { status: 200, body: { message } };
  }
  const routes: Route[] = [
    {
      method: "GET",
      path: /^\/health$/,
      run: () => ({ status: 200, body: { ok: true, chainId: config.chainId } }),
    },
    { method: "POST", path: /^\/session$/, run: session },
    { method: "GET", path: /^\/vaults\/([^/]+)\/role$/, run: role },
    { method: "GET", path: /^\/vaults\/([^/]+)\/messages$/, run: list },
    { method: "POST", path: /^\/vaults\/([^/]+)\/messages$/, run: post },
    {
      method: "POST",
      path: /^\/vaults\/([^/]+)\/messages\/([^/]+)\/hide$/,
      run: hide,
    },
  ];
  async function handle(req: IncomingMessage): Promise<Reply> {
    if (req.method === "OPTIONS") return { status: 204 };
    const url = req.url ?? "";
    const cut = url.indexOf("?");
    const path = cut < 0 ? url : url.slice(0, cut);
    const matched = routes.flatMap((route) => {
      const match = route.path.exec(path);
      return match ? [{ route, params: match.slice(1) }] : [];
    });
    if (!matched.length) throw new HttpError("NOT_FOUND");
    const found = matched.find(({ route }) => route.method === req.method);
    if (!found)
      throw new HttpError("METHOD_NOT_ALLOWED", {
        Allow: matched.map(({ route }) => route.method).join(", "),
      });
    return found.route.run({
      req,
      params: found.params,
      query: new URLSearchParams(cut < 0 ? "" : url.slice(cut + 1)),
    });
  }
  function failure(error: unknown): Reply {
    const known = error instanceof HttpError;
    if (!known) faultLog(`request failed: ${describe(error, 400)}`);
    const code: ErrorCode = known ? error.code : "INTERNAL";
    return {
      status: statuses[code],
      body: { error: code },
      headers: {
        ...(known && error.headers),
        ...(statuses[code] === 401 && { "WWW-Authenticate": "Bearer" }),
      },
    };
  }
  return (req, res) => {
    handle(req)
      .catch(failure)
      .then((reply) => send(res, reply, corsHeaders(req, config.corsOrigins)))
      .catch(() => res.destroy());
  };
}
