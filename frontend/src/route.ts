import { getAddress, isAddress, type Address } from "viem";

export const TABS = [
  "deposit",
  "withdraw",
  "chat",
  "manage",
  "trade",
  "scope",
] as const;
export type Tab = (typeof TABS)[number];
/** Tabs only the Vault's operator can use. */
export const OPERATOR_TABS: readonly Tab[] = ["manage", "trade", "scope"];
/** Tabs whose panel takes the full width of the page. */
export const WIDE_TABS: readonly Tab[] = ["trade", "scope"];
/** Pages of HyperVault that take no address. */
export const HYPER_PAGES = ["vaults", "ops", "strategy", "docs"] as const;
export type Route =
  | { page: "home" }
  | { page: (typeof HYPER_PAGES)[number] }
  | { page: "direct"; vault: Address; trade: boolean }
  | { page: "explore" }
  | { page: "create" }
  | { page: "assets" }
  | { page: "vault"; vault: Address; tab: Tab }
  | { page: "unknown" };

/**
 * `#/` home, `#/vaults`, `#/vaults/<address>[/trade]`, `#/ops`, `#/strategy`;
 * the earlier Factory pages: `#/explore`, `#/create`, `#/vault/<address>[/<tab>]`.
 */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
  const [page, vault, tab = "deposit", ...rest] = parts;
  const direct = parts[2];
  if (!page) return { page: "home" };
  if ((HYPER_PAGES as readonly string[]).includes(page) && vault === undefined)
    return { page: page as (typeof HYPER_PAGES)[number] };
  if (
    page === "vaults" &&
    vault &&
    isAddress(vault, { strict: false }) &&
    (direct === undefined || direct === "trade") &&
    !rest.length
  )
    return { page: "direct", vault: getAddress(vault), trade: !!direct };
  if (page === "explore" && vault === undefined) return { page: "explore" };
  if (page === "assets" && vault === undefined) return { page: "assets" };
  if (page === "create" && vault === undefined) return { page: "create" };
  if (
    page === "vault" &&
    vault &&
    isAddress(vault, { strict: false }) &&
    (TABS as readonly string[]).includes(tab) &&
    !rest.length
  )
    return { page: "vault", vault: getAddress(vault), tab: tab as Tab };
  return { page: "unknown" };
}

/**
 * The page a line of feedback belongs to: a Vault's page by its address, the create page, the
 * list, or null for what is about no page in particular (the wallet).
 */
export type Place = Address | "create" | "explore" | null;
export type Feedback = { text: string; error: boolean; place: Place };

/** Whether `route` shows the page `place` names. An unknown hash shows the list. */
export function showsPlace(route: Route, place: Place): boolean {
  if (place === null) return true;
  if (route.page === "vault" || route.page === "direct")
    return place.toLowerCase() === route.vault.toLowerCase();
  return place === (route.page === "create" ? "create" : "explore");
}

/**
 * What is left of the feedback line when the page changes from `from` to `to`. A line is shown
 * only on the page it belongs to: an action that ends after the visitor moved on must not
 * confirm itself under another Vault's page. So it is dropped unless the new page is its own,
 * and an error that was on screen goes with any move: what it was about lies behind.
 */
export function feedbackAfter(
  feedback: Feedback | null,
  from: Route,
  to: Route,
): Feedback | null {
  if (!feedback || !showsPlace(to, feedback.place)) return null;
  return feedback.error && showsPlace(from, feedback.place) ? null : feedback;
}

export function routeHash(route: Route): string {
  if (route.page === "direct")
    return `#/vaults/${route.vault}${route.trade ? "/trade" : ""}`;
  if ((HYPER_PAGES as readonly string[]).includes(route.page))
    return `#/${route.page}`;
  if (route.page === "explore") return "#/explore";
  if (route.page === "vault")
    return `#/vault/${route.vault}${route.tab === "deposit" ? "" : "/" + route.tab}`;
  if (route.page === "assets") return "#/assets";
  return route.page === "create" ? "#/create" : "#/";
}
