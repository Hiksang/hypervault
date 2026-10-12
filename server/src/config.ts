import type { Address } from "viem";
import { parseAddress } from "./rules.ts";
export type Posting = "members" | "open";
export type Config = {
  port: number;
  host: string;
  chainId: number;
  rpcUrl: string;
  factory: Address;
  audience: string;
  databasePath: string;
  sessionSecret: string;
  corsOrigins: readonly string[];
  posting: Posting;
  admin: Address | null;
};
const chainIds = [999, 998, 31337];
function origin(value: string): string {
  if (!URL.canParse(value) || new URL(value).origin !== value)
    throw new Error(
      "CORS_ORIGIN entries must be exact origins such as http://127.0.0.1:5173",
    );
  return value;
}
// Sign-in signatures name this URL, and clients name the URL they were given,
// so it has to be written the one way a URL normalises to: no trailing slash,
// no default port, lowercase host.
function audience(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    !/^https?:$/.test(url.protocol) ||
    value !== url.origin + url.pathname.replace(/\/+$/, "")
  )
    throw new Error(
      "CHAT_AUDIENCE must be the public URL of this server as clients configure it, such as https://chat.example.com, without a trailing slash",
    );
  return value;
}
// Messages name the variable and never echo a value: one of them is a secret.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const text = (name: string, fallback = "") => env[name]?.trim() || fallback;
  const integer = (name: string, fallback = "") =>
    /^[0-9]{1,5}$/.test(text(name, fallback))
      ? Number(text(name, fallback))
      : -1;
  const port = integer("PORT", "8787");
  if (port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535");
  const chainId = integer("CHAIN_ID");
  if (!chainIds.includes(chainId))
    throw new Error("CHAIN_ID must be 999, 998 or 31337");
  const rpcUrl = text("RPC_URL");
  if (!URL.canParse(rpcUrl) || !/^https?:$/.test(new URL(rpcUrl).protocol))
    throw new Error("RPC_URL must be an http(s) URL");
  const factory = parseAddress(text("FACTORY_ADDRESS"));
  if (!factory)
    throw new Error("FACTORY_ADDRESS must be a 20-byte hex address");
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must be at least 32 characters");
  const posting = text("CHAT_POSTING", "members");
  if (posting !== "members" && posting !== "open")
    throw new Error("CHAT_POSTING must be members or open");
  const admin = parseAddress(text("CHAT_ADMIN"));
  if (text("CHAT_ADMIN") && !admin)
    throw new Error("CHAT_ADMIN must be a 20-byte hex address");
  return {
    port,
    host: text("HOST", "127.0.0.1"),
    chainId,
    rpcUrl,
    factory,
    audience: audience(text("CHAT_AUDIENCE")),
    databasePath: text("DATABASE_PATH", "./chat.sqlite"),
    sessionSecret,
    corsOrigins: text("CORS_ORIGIN", "http://127.0.0.1:5173")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(origin),
    posting,
    admin,
  };
}
