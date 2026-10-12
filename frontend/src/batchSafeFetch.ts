/**
 * A rate-limited HyperEVM node answers a JSON-RPC batch with ONE error object instead of an array;
 * viem's batch transport cannot read that and reports an unknown error. Spread that error over
 * every request id so each read fails with the node's real error (e.g. -32005) and retries.
 */
export async function batchSafeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  let sent: unknown;
  try {
    sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  } catch {
    return res;
  }
  if (!Array.isArray(sent)) return res;
  const text = await res.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return res;
  }
  if (
    Array.isArray(body) ||
    !body ||
    typeof body !== "object" ||
    !("error" in body)
  )
    return res;
  const spread = sent.map((r: { id?: unknown }) => ({
    jsonrpc: "2.0",
    id: r?.id ?? null,
    error: (body as { error: unknown }).error,
  }));
  return new Response(JSON.stringify(spread), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
