import { defineConfig, type Plugin } from "vite";
import { contentSecurityPolicy, policyTag } from "./src/csp.ts";

/**
 * Puts the Content-Security-Policy into the built page, first in its head so that it governs
 * everything after it. Only a build gets it: the dev server serves inline scripts of its own.
 * The settings are the ones the build itself resolved, read from its own env directory, and so
 * the very values the page is compiled with: not whatever directory the command was run from.
 */
export function csp(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: "content-security-policy",
    apply: "build",
    configResolved(config) {
      env = config.env;
    },
    transformIndexHtml: () => [policyTag(contentSecurityPolicy(env))],
  };
}

export default defineConfig({ plugins: [csp()] });
