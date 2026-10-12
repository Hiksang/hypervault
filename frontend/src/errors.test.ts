import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  custom,
  encodeErrorResult,
  type Abi,
} from "viem";
import {
  REASON_LIMIT,
  callAnswered,
  contractFault,
  errorText,
  quotable,
  revertName,
} from "./errors.ts";

const abi = [
  { type: "error", name: "PriceDropCooldown", inputs: [] },
  { type: "error", name: "ReadFailed", inputs: [{ type: "address" }] },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;
const VAULT = "0x00000000000000000000000000000000000000aa";
const PRECOMPILE = "0x0000000000000000000000000000000000000801";

/** What viem throws for a reverted read: the revert, wrapped with the call it belongs to. */
function reverted(data: `0x${string}`) {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi,
      data,
      functionName: "totalAssets",
    }),
    { abi, functionName: "totalAssets", contractAddress: VAULT, args: [] },
  );
}

test("a contract's revert is given by name, with its arguments", () => {
  const cooldown = reverted(
    encodeErrorResult({ abi, errorName: "PriceDropCooldown" }),
  );
  assert.equal(errorText(cooldown), "PriceDropCooldown()");
  assert.equal(revertName(cooldown), "PriceDropCooldown");
  const failed = reverted(
    encodeErrorResult({ abi, errorName: "ReadFailed", args: [PRECOMPILE] }),
  );
  assert.equal(errorText(failed), `ReadFailed(${PRECOMPILE})`);
  assert.equal(revertName(failed), "ReadFailed");
});

test("a revert string is shown as it is, and an unknown error by its selector", () => {
  const text = reverted(
    encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
      errorName: "Error",
      args: ["ERC20: transfer amount exceeds balance"],
    }),
  );
  assert.equal(
    errorText(text),
    '계약이 되돌린 문구: "ERC20: transfer amount exceeds balance"',
    "free text from a contract is marked as the contract's words",
  );
  assert.equal(revertName(text), "Error");
  const unknown = reverted("0xdeadbeef");
  assert.equal(errorText(unknown), "알 수 없는 계약 오류 0xdeadbeef");
  assert.equal(revertName(unknown), "0xdeadbeef");
});

test("a failed request is not a contract's answer, and its text carries no URL", () => {
  const url = "https://rpc.example/v1/secret-project-key";
  const failure = new ContractFunctionExecutionError(
    new HttpRequestError({ url, status: 429, body: { method: "eth_call" } }),
    { abi, functionName: "totalAssets", contractAddress: VAULT, args: [] },
  );
  assert.ok(failure.message.includes(url), "the long form does carry it");
  assert.equal(revertName(failure), null);
  const shown = errorText(failure);
  assert.ok(!shown.includes("rpc.example") && !shown.includes("secret"), shown);
  assert.ok(shown.length > 0 && shown.length <= 300);
  const bare = new HttpRequestError({ url, status: 500 });
  assert.equal(revertName(bare), null);
  assert.ok(!errorText(bare).includes("rpc.example"));
});

test("a call that returns nothing is a contract's answer without a name", () => {
  const empty = new ContractFunctionExecutionError(
    new ContractFunctionZeroDataError({ functionName: "nav" }),
    { abi, functionName: "nav", contractAddress: VAULT, args: [] },
  );
  assert.equal(revertName(empty), "revert");
  assert.ok(errorText(empty).includes("nav"));
});

test("other errors keep their own message, cut to a line", () => {
  assert.equal(
    errorText(new Error("지갑을 연결하세요.")),
    "지갑을 연결하세요.",
  );
  assert.equal(errorText(new Error("x".repeat(1000))).length, 300);
  assert.equal(errorText("plain"), "plain");
  assert.equal(revertName(new Error("PriceDropCooldown()")), null);
  assert.equal(revertName(undefined), null);
});

// The same failures as viem builds them from what a node answers.
const text = [
  { type: "error", name: "Error", inputs: [{ type: "string" }] },
] as const satisfies Abi;
const reads = [
  ...abi,
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const satisfies Abi;
async function asked(
  answer: () => unknown,
  functionName: "name" | "totalAssets" = "totalAssets",
) {
  const client = createPublicClient({
    ccipRead: false,
    transport: custom({ request: async () => answer() }, { retryCount: 0 }),
  });
  return client.readContract({ address: VAULT, abi: reads, functionName }).then(
    () => assert.fail("the read was meant to fail"),
    (e: unknown) => e,
  );
}
const refuse =
  (fields: object, message = "execution reverted") =>
  () => {
    throw Object.assign(new Error(message), fields);
  };

test("a revert string cannot close its quote, start a line or run on", async () => {
  const said = async (reason: string) =>
    errorText(
      await asked(
        refuse({
          code: 3,
          data: encodeErrorResult({ abi: text, args: [reason] }),
        }),
      ),
    );
  assert.equal(
    await said('끝"\n지갑 연결 완료 · 이 볼트는 검증되었습니다'),
    '계약이 되돌린 문구: "끝 지갑 연결 완료 · 이 볼트는 검증되었습니다"',
  );
  // Every kind of quotation mark, a line or paragraph separator, a direction override and a
  // character that is not drawn at all.
  const shown = await said("a”b’c«d»e「f」g`h i j‮k​lㅤm\tn\r\no");
  assert.equal(shown, '계약이 되돌린 문구: "abcdefgh i jklm n o"');
  const long = await said("가".repeat(5000));
  assert.equal(
    long,
    `계약이 되돌린 문구: "${"가".repeat(REASON_LIMIT)}…"`,
    "cut by characters",
  );
  assert.equal(quotable("  plain   words  "), "plain words");
  assert.equal(quotable("😀".repeat(200)), "😀".repeat(REASON_LIMIT) + "…");
});

test("only what the node calls a revert is a contract's answer", async () => {
  // A revert without data, as one node sends it and as another does.
  const bare = await asked(refuse({ code: 3, data: "0x" }));
  assert.equal(revertName(bare), "revert");
  assert.equal(
    errorText(bare),
    "계약이 이유를 밝히지 않고 요청을 되돌렸습니다.",
  );
  const worded = await asked(
    refuse({ code: -32000 }, 'execution reverted: 여기 "보내세요"'),
  );
  assert.equal(revertName(worded), "revert");
  assert.equal(errorText(worded), '계약이 되돌린 문구: "여기 보내세요"');
  // The node's own failure, which viem files under the same error class: not a revert.
  const internal = await asked(refuse({ code: -32603 }, "Internal error"));
  assert.equal(revertName(internal), null);
  assert.equal(
    errorText(internal),
    "노드가 요청을 처리하지 못했습니다: Internal error",
  );
  const limited = await asked(refuse({ code: -32005 }, "rate limited"));
  assert.equal(revertName(limited), null);
  assert.ok(!errorText(limited).includes("계약"), errorText(limited));
});

test("a failed read is the contract's fault only when the contract answered", async () => {
  const reverted = await asked(
    refuse({
      code: 3,
      data: encodeErrorResult({ abi, errorName: "PriceDropCooldown" }),
    }),
  );
  assert.equal(contractFault(reverted), true);
  assert.equal(
    contractFault(await asked(refuse({ code: 3, data: "0x" }))),
    true,
  );
  // An address without code answers nothing; a contract of another kind answers nonsense.
  assert.equal(contractFault(await asked(() => "0x")), true);
  const nonsense = await asked(() => "0x1234", "name");
  assert.equal(revertName(nonsense), null, "not a revert either");
  assert.equal(contractFault(nonsense), true);
  // The node or the network: nothing is known about the contract.
  for (const failure of [
    await asked(refuse({ code: -32005 }, "rate limited")),
    await asked(refuse({ code: -32603 }, "Internal error")),
    await asked(refuse({}, "fetch failed")),
    new HttpRequestError({ url: "https://rpc.example", status: 429 }),
    new Error("RPC 블록이 오래되었습니다."),
    undefined,
  ])
    assert.equal(contractFault(failure), false, String(failure));
});

test("a call the node would not run is an answer about it; a request without a reply is not", async () => {
  // A halt as the public HyperEVM RPC answers it (2026-10-05): its own code, and no revert.
  const halted = await asked(
    refuse({ code: -32003 }, "EVM error: InvalidFEOpcode"),
  );
  assert.equal(revertName(halted), null);
  assert.equal(contractFault(halted), false, "nothing the contract returned");
  assert.equal(callAnswered(halted), true);
  assert.equal(
    callAnswered(
      await asked(
        refuse({ code: -32003 }, "out of gas: gas required exceeds: 30000000"),
      ),
    ),
    true,
  );
  assert.equal(
    callAnswered(await asked(refuse({ code: -32603 }, "Internal error"))),
    true,
    "the node said so of this call",
  );
  // Whatever is the contract's doing is an answer.
  assert.equal(
    callAnswered(await asked(refuse({ code: 3, data: "0x" }))),
    true,
  );
  assert.equal(callAnswered(await asked(() => "0x")), true);
  assert.equal(callAnswered(await asked(() => "0x1234", "name")), true);
  // Nothing came back about the call: the node's limit, no reply over HTTP, a time-out.
  const url = "https://rpc.example";
  const thrown = (error: Error) => () => {
    throw error;
  };
  for (const failure of [
    await asked(refuse({ code: -32005 }, "rate limited")),
    await asked(refuse({}, "fetch failed")),
    await asked(thrown(new HttpRequestError({ url, status: 429 }))),
    await asked(thrown(new HttpRequestError({ url, status: 502 }))),
    await asked(thrown(new HttpRequestError({ url }))),
    await asked(thrown(new TimeoutError({ body: {}, url }))),
    new HttpRequestError({ url, status: 429 }),
    // No call to the node at all.
    Object.assign(new Error("refused"), { code: -32003 }),
    new Error("RPC 블록이 오래되었습니다."),
    undefined,
  ])
    assert.equal(callAnswered(failure), false, String(failure));
});
