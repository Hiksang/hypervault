import { test } from "node:test";
import assert from "node:assert/strict";

test("a single error answering a batch is spread over every request id", async () => {
  const { batchSafeFetch } = await import("./batchSafeFetch.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32005, message: "rate limited" },
      }),
      {
        status: 200,
      },
    )) as typeof fetch;
  try {
    const res = await batchSafeFetch("https://rpc", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
      ]),
    });
    const body = (await res.json()) as {
      id: number;
      error: { code: number };
    }[];
    assert.deepEqual(
      body.map((b) => [b.id, b.error.code]),
      [
        [1, -32005],
        [2, -32005],
      ],
    );
  } finally {
    globalThis.fetch = real;
  }
});
