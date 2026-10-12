import { createBudget } from "./limits.ts";
// What an error may put in the log: printable ASCII on one line, cut short
// and quoted. The text can come from a contract (a revert reason of any
// length, with line breaks or terminal escapes in it) and must not be able to
// pass for a line of the log itself, or to fill the log. Of a viem error the
// short message is used: the long one adds lines about the library and the
// request, among them the URL of an RPC request, which may hold an API key.
export function describe(error: unknown, limit: number): string {
  let text = "an error that cannot be printed";
  try {
    if (!(error instanceof Error)) text = String(error);
    else if ("shortMessage" in error && typeof error.shortMessage === "string")
      text = error.shortMessage;
    else {
      const said = String(error.stack ?? `${error.name}: ${error.message}`);
      // After the first line, where the cut does not take it.
      const end = said.indexOf("\n");
      text =
        end < 0
          ? said + reason(error)
          : said.slice(0, end) + reason(error) + said.slice(end);
    }
  } catch {
    // Keeps the text above.
  }
  return JSON.stringify(
    text
      .slice(0, 4 * limit)
      .replace(/\s+/g, " ")
      .slice(0, limit)
      .replace(/[^\x20-\x7e]/g, "?"),
  );
}
// Why a connection failed is on the error's cause: refused, not found, a TLS
// fault. Its code is given, or else its name, and only when that is a plain
// word: the cause's message can name the host the request went to.
function reason(error: Error): string {
  const { cause } = error;
  if (typeof cause !== "object" || cause === null) return "";
  const { code, name } = cause as { code?: unknown; name?: unknown };
  const word = [code, name].find(
    (value) =>
      typeof value === "string" &&
      value !== "Error" &&
      /^\w{1,40}$/.test(value),
  );
  return word === undefined ? "" : ` [${String(word)}]`;
}
// A log that requests cannot fill: twenty lines at once, then one a second.
// When lines start being left out it says so once, and the next line written
// says how many were. `now` must be a clock that never goes back.
export function createLog(
  write: (line: string) => void,
  now: () => number,
  subject: string,
) {
  const spend = createBudget(20, 1);
  let dropped = 0;
  return function note(line: string): void {
    if (spend(now()) > 0) {
      if (dropped === 0)
        write(
          `more ${subject} are not being logged: one line a second at most`,
        );
      dropped += 1;
      return;
    }
    write(dropped ? `(${dropped} left out) ${line}` : line);
    dropped = 0;
  };
}
