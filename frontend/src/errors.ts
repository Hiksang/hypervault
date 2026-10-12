import {
  BaseError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  HttpRequestError,
  RpcError,
  RpcRequestError,
  TimeoutError,
} from "viem";

type Kind = abstract new (...args: never[]) => unknown;
const within = (e: unknown, ...kinds: Kind[]) =>
  e instanceof BaseError
    ? e.walk((cause) => kinds.some((kind) => cause instanceof kind))
    : null;

/**
 * The contract error a call reverted with: its name, or its selector when no ABI here knows it.
 * Null when the call failed for another reason, such as the RPC: that is never a contract's answer.
 * viem also files a node's internal error as a revert. Only what carries revert data, or what the
 * node itself called a revert, is taken as one.
 */
export function revertName(e: unknown): string | null {
  if (within(e, ContractFunctionZeroDataError)) return "revert";
  const revert = within(e, ContractFunctionRevertedError);
  if (
    revert instanceof ContractFunctionRevertedError &&
    revert.raw &&
    revert.raw !== "0x"
  )
    return revert.data?.errorName ?? revert.signature ?? "revert";
  return within(e, ExecutionRevertedError) ? "revert" : null;
}

/**
 * Whether a failed read is the contract's doing: it reverted, or it answered what its ABI cannot
 * decode. False when the request itself failed (the node, the network, a time-out): that says
 * nothing about the contract.
 */
export function contractFault(e: unknown): boolean {
  if (revertName(e) !== null) return true;
  return (
    !!within(e, ContractFunctionExecutionError) &&
    !within(
      e,
      CallExecutionError,
      HttpRequestError,
      RpcRequestError,
      RpcError,
      TimeoutError,
    )
  );
}

/** The JSON-RPC code of a request a node refuses for coming too often. */
const LIMIT = -32005;

/**
 * Whether a failed read or simulation was answered about the call at all: by the contract (see
 * `contractFault`), or by the node, which refuses a call that halts (an invalid opcode, all gas
 * used) with an error of its own that is no revert. False when nothing came back about the call:
 * no reply over HTTP, a time-out, the node's limit on requests. False too for what is no call
 * to the node, such as a transaction the wallet refused.
 */
export function callAnswered(e: unknown): boolean {
  if (contractFault(e)) return true;
  if (
    !(e instanceof BaseError) ||
    !within(e, CallExecutionError) ||
    within(e, HttpRequestError, TimeoutError)
  )
    return false;
  return !!e.walk((cause) => {
    const code = (cause as { code?: unknown } | null)?.code;
    // viem gives -1 to what a transport threw that is no reply of the node.
    return typeof code === "number" && code !== -1 && code !== LIMIT;
  });
}

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const QUOTES = /[\p{Quotation_Mark}`´]/gu;

/** One line of text: no line break, no character that hides or reorders what follows, cut to `limit`. */
function line(text: string, limit: number): string {
  const flat = [
    ...text
      .replace(INVISIBLE, "")
      .replace(BREAKS, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  return flat.length > limit
    ? flat.slice(0, limit).join("") + "…"
    : flat.join("");
}

/** The longest revert string put on screen. */
export const REASON_LIMIT = 120;

/**
 * A contract's free text as it may stand between this page's quotation marks: on one line, cut
 * short, and with no quotation mark of its own, so that it can neither close the quote nor go on
 * in what looks like the page's voice.
 */
export function quotable(text: string): string {
  return line(text.replace(QUOTES, ""), REASON_LIMIT);
}

/**
 * A line for the screen. A contract's revert is given as its error, `Name(arguments)`. A revert
 * string is free text chosen by the contract, so it is quoted as the contract's words and never
 * shown as this page's own. Anything else is viem's one-line summary: its long form carries the
 * RPC URL and the whole request.
 */
export function errorText(e: unknown) {
  if (e instanceof BaseError) {
    if (revertName(e) !== null) {
      const revert = within(e, ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const { data, reason, signature } = revert;
        if (data && data.errorName !== "Error" && data.errorName !== "Panic")
          return line(
            `${data.errorName}(${(data.args ?? []).map(String).join(", ")})`,
            300,
          );
        // Without data the reason is the node's own message, which says no more than "reverted".
        const said = (reason ?? "").replace(/^execution reverted:?\s*/i, "");
        if (said) return `계약이 되돌린 문구: "${quotable(said)}"`;
        if (signature) return `알 수 없는 계약 오류 ${signature}`;
      }
      const bare = within(e, ExecutionRevertedError);
      if (bare instanceof ExecutionRevertedError) {
        // A node that sends the reason only in its message: the same words of the contract.
        const said = /^Execution reverted with reason: (.*)\.$/s.exec(
          bare.shortMessage,
        )?.[1];
        return said
          ? `계약이 되돌린 문구: "${quotable(said)}"`
          : "계약이 이유를 밝히지 않고 요청을 되돌렸습니다.";
      }
    }
    // What viem files as a revert without being one is the node's own failure: it is not
    // worded as the contract's.
    const filed = within(e, ContractFunctionRevertedError);
    if (filed instanceof ContractFunctionRevertedError)
      return `노드가 요청을 처리하지 못했습니다: ${line(filed.reason ?? "", 200)}`;
    return line(e.shortMessage, 300);
  }
  return e instanceof Error ? e.message.slice(0, 300) : String(e);
}
