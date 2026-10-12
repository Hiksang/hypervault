// Run after `vite build`, with type stripping: fails unless dist/index.html carries the
// Content-Security-Policy of this build's settings as the first thing in its head.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { contentSecurityPolicy, policyProblem } from "../src/csp.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const expected = contentSecurityPolicy(loadEnv("production", root, "VITE_"));
const problem = policyProblem(
  readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  expected,
);
if (problem) {
  console.error(`dist/index.html: ${problem}`);
  process.exit(1);
}
console.log(
  `dist/index.html carries the policy first in its head.\n  ${expected.split("; ").find((directive) => directive.startsWith("connect-src"))}`,
);
