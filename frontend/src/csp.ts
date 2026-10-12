import { apiBase } from "./hyperliquid/info.ts";
import { chainIdOf, rpcUrl } from "./network.ts";

function origin(name: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} must be an absolute URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error(`${name} must be an http(s) URL: ${url}`);
  if (parsed.username || parsed.password)
    throw new Error(`${name} must not carry credentials`);
  // A source in a policy is not a URL. `*` in a host is a wildcard there and `;` ends the
  // directive, and a URL may hold both: only a plain host name or address is named.
  if (!HOST_NAME.test(parsed.hostname) && !HOST_IPV6.test(parsed.hostname))
    throw new Error(`${name} must name one plain host: ${url}`);
  return parsed.origin;
}
const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const HOST_NAME = new RegExp(`^(${LABEL}\\.)*${LABEL}$`);
const HOST_IPV6 = /^\[[0-9a-f:.]+\]$/;

/**
 * The Content-Security-Policy of the built page, from the settings it is built with. The page
 * holds a trading key, so it loads nothing from a third party: scripts, styles and fonts are its
 * own. It may talk only to the three services it is configured for: the EVM RPC, the Hyperliquid
 * API of its chain, and the chat server; and to its own site, for the files published beside it
 * (`hypervault/*.json`).
 * `frame-ancestors` is not here: a policy in a meta tag cannot carry it, the host must send it.
 */
export function contentSecurityPolicy(env: {
  VITE_CHAIN_ID?: string;
  VITE_RPC_URL?: string;
  VITE_CHAT_URL?: string;
  VITE_LOGS_RPC_URL?: string;
}): string {
  const chainId = chainIdOf(env.VITE_CHAIN_ID);
  if (chainId === null)
    throw new Error(
      `VITE_CHAIN_ID is not a supported chain: ${env.VITE_CHAIN_ID}`,
    );
  const api = apiBase(chainId);
  const connect = new Set([
    "'self'",
    origin("VITE_RPC_URL", rpcUrl(chainId, env.VITE_RPC_URL)),
    ...(api ? [origin("the Hyperliquid API", api)] : []),
    ...(env.VITE_CHAT_URL ? [origin("VITE_CHAT_URL", env.VITE_CHAT_URL)] : []),
    // Optional node for eth_getLogs (account history); the main RPC rate-limits log ranges.
    ...(env.VITE_LOGS_RPC_URL
      ? [origin("VITE_LOGS_RPC_URL", env.VITE_LOGS_RPC_URL)]
      : []),
  ]);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The policy as a Vite plugin puts it into the page: first in the head. */
export function policyTag(policy: string) {
  return {
    tag: "meta",
    attrs: { "http-equiv": "Content-Security-Policy", content: policy },
    injectTo: "head-prepend" as const,
  };
}

const unescaped = (text: string) =>
  text
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/**
 * What is wrong with the policy a built page carries, or "". The page must carry exactly
 * `expected`, in a meta tag that is the first thing in its head: whatever stands before that tag
 * is not governed by it, and a build that lost the tag would ship with no policy at all.
 */
export function policyProblem(html: string, expected: string): string {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1];
  if (head === undefined) return "the page has no head";
  const first =
    /^\s*<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i.exec(
      head,
    );
  if (!first)
    return "the head does not begin with the Content-Security-Policy meta tag";
  const found = unescaped(first[1]);
  if (found !== expected)
    return `the policy is not the one of these build settings\n  found:    ${found}\n  expected: ${expected}`;
  if (/Content-Security-Policy/i.test(head.slice(first[0].length)))
    return "the head carries a second policy";
  return "";
}
