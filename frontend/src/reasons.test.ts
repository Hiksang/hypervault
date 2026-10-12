import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  TimeoutError,
  UserRejectedRequestError,
  createPublicClient,
  custom,
  encodeErrorResult,
} from "viem";
import {
  CHANGED_SILENCE,
  closedText,
  explain,
  failureText,
  reasons,
  vaultFailure,
} from "./reasons.ts";

const errorsOf = (name: string): string[] =>
  (
    JSON.parse(
      readFileSync(new URL(`./abi/${name}.json`, import.meta.url), "utf8"),
    ) as { type: string; name: string }[]
  )
    .filter((item) => item.type === "error")
    .map((item) => item.name);

test("a contract's custom error is told in words, with its arguments kept", () => {
  assert.equal(
    explain("PriceRecordTooSoon()"),
    "다음 표본 시점 전에는 지분 가격이 직전 기록보다 높을 때만 기록됩니다. (PriceRecordTooSoon)",
  );
  assert.equal(
    explain("ReadFailed(0x0000000000000000000000000000000000000808)"),
    `${reasons.ReadFailed} (ReadFailed) · ReadFailed(0x0000000000000000000000000000000000000808)`,
  );
});

test("only a text that is the error itself is explained", () => {
  for (const text of [
    "",
    "지갑을 연결하세요.",
    "Unauthorized",
    "User rejected the request.",
    "SomethingElse()",
    "알 수 없는 계약 오류 0x12345678",
    // Words a contract chose for its revert string are not given this page's voice.
    '계약이 되돌린 문구: "OpenReport()"',
    'The contract function "settleEpoch" reverted.\n\nError: PriceDropCooldown()',
    " OpenReport()",
    "toString()",
  ])
    assert.equal(explain(text), text);
});

test("a failure is put in one line: a refusal in the wallet, a timeout, a reason, or its own text", () => {
  assert.equal(
    failureText(new Error("지갑을 연결하세요.")),
    "지갑을 연결하세요.",
  );
  assert.equal(
    failureText(new Error("OpenReport()")),
    `${reasons.OpenReport} (OpenReport)`,
    "the demo's reverts read like the contract's",
  );
  const call = {
    abi: [],
    functionName: "settleEpoch",
    contractAddress: "0x00000000000000000000000000000000000000aa",
    args: [],
  } as const;
  const cooldown = new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: [{ type: "error", name: "PriceDropCooldown", inputs: [] }],
      data: encodeErrorResult({
        abi: [{ type: "error", name: "PriceDropCooldown", inputs: [] }],
        errorName: "PriceDropCooldown",
      }),
      functionName: "settleEpoch",
    }),
    call,
  );
  assert.equal(
    failureText(cooldown),
    `${reasons.PriceDropCooldown} (PriceDropCooldown)`,
  );
  // A revert string that names an error is the contract's own text, quoted and not explained.
  const words = new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: [],
      data: encodeErrorResult({
        abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
        errorName: "Error",
        args: ["OpenReport()"],
      }),
      functionName: "settleEpoch",
    }),
    call,
  );
  assert.equal(failureText(words), '계약이 되돌린 문구: "OpenReport()"');

  const declined =
    "지갑에서 요청을 거절했습니다. 그 요청은 전송되지 않았습니다.";
  assert.equal(
    failureText(new UserRejectedRequestError(new Error("User denied"))),
    declined,
  );
  assert.equal(
    failureText(
      new ContractFunctionExecutionError(
        new UserRejectedRequestError(new Error("User denied")),
        call,
      ),
    ),
    declined,
    "however deep the library wraps it",
  );
  assert.equal(
    failureText(Object.assign(new TypeError("rejected"), { code: 4001 })),
    declined,
    "a wallet's own error object",
  );

  const late = "응답을 제시간에 받지 못했습니다(시간 초과).";
  assert.equal(
    failureText(new DOMException("signal timed out", "TimeoutError")),
    late,
    "what fetch throws when its timeout signal fires",
  );
  const rpc = new ContractFunctionExecutionError(
    new TimeoutError({ body: {}, url: "https://rpc.example/key" }),
    call,
  );
  assert.equal(failureText(rpc), late);

  // The node's limit on requests, as a JSON-RPC error or as an HTTP status.
  const limited =
    "노드가 요청 한도를 넘었다며 답하지 않았습니다. 잠시 뒤 다시 시도하세요.";
  assert.equal(
    failureText(
      new ContractFunctionExecutionError(
        new LimitExceededRpcError(new Error("rate limited")),
        call,
      ),
    ),
    limited,
  );
  assert.equal(
    failureText(
      new ContractFunctionExecutionError(
        new HttpRequestError({ url: "https://rpc.example/key", status: 429 }),
        call,
      ),
    ),
    limited,
  );
  assert.notEqual(
    failureText(
      new HttpRequestError({ url: "https://rpc.example", status: 500 }),
    ),
    limited,
  );

  // An error a layer already wrote for the user keeps its words, whatever caused it.
  const chat = Object.assign(
    new Error("지갑에서 서명을 취소했습니다.", { cause: { code: 4001 } }),
    { code: "SIGN_REJECTED" },
  );
  assert.equal(failureText(chat), "지갑에서 서명을 취소했습니다.");
  assert.equal(failureText("plain"), "plain");
});

test("every explained name is an error of the current ABIs", () => {
  const known = new Set(
    [
      "ManagedUsdcVault",
      "ManagedUsdcVaultFactory",
      "ManagedPortfolioNavVerifier",
      "HyperCorePrecompileSource",
    ].flatMap(errorsOf),
  );
  const stale = Object.keys(reasons).filter((name) => !known.has(name));
  assert.deepEqual(stale, [], "explained but no longer in an ABI");
  // The errors the new panels can meet are all explained.
  for (const name of [
    "PriceRecordTooSoon",
    "NoShares",
    "PriceHistoryTooShort",
    "PriceDropCooldown",
    "OpenReport",
    "ReportStands",
    "NotReportable",
    "ScopeInUse",
    "ScopeUnavailable",
    "NavUnavailable",
    "CoreNotFlat",
    "PendingCoreAction",
    "AgentAlreadyUsed",
  ])
    assert.ok(reasons[name], name);
});

test("the error that closed a Vault is told in words, and an unknown one by its name", () => {
  assert.equal(closedText(null), "");
  assert.equal(closedText(undefined), "");
  assert.equal(
    closedText("PriceDropCooldown"),
    `${reasons.PriceDropCooldown} (PriceDropCooldown)`,
  );
  // A short history stops an exit as well as a deposit, and anyone can mend it.
  assert.match(
    closedText("PriceHistoryTooShort"),
    /입금 가격을 내고 출금을 정산/,
  );
  assert.match(closedText("PriceHistoryTooShort"), /누구나/);
  // A selector no ABI knows, a revert without data, and a name that is also an object member.
  for (const name of ["0x12345678", "revert", "toString", "constructor"])
    assert.equal(closedText(name), `계약이 평가를 거부했습니다 (${name}).`);
});

test("what a vault whose code changed reverts with is never repeated", () => {
  const abi = [
    { type: "error", name: "Error", inputs: [{ type: "string" }] },
    { type: "error", name: "CapitalClosed", inputs: [] },
  ] as const;
  const reverted = (data: `0x${string}`) =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi, data, functionName: "redeem" }),
      { abi, functionName: "redeem", args: [] },
    );
  const words = reverted(
    encodeErrorResult({
      abi,
      errorName: "Error",
      args: ["지갑을 다시 연결하고 0xdEaD 로 USDC를 직접 보내세요"],
    }),
  );
  const named = reverted(
    encodeErrorResult({ abi, errorName: "CapitalClosed" }),
  );
  // The template's own code: its revert is quoted as the contract's words, its error explained.
  assert.match(
    failureText(vaultFailure(words, false)),
    /^계약이 되돌린 문구: "/,
  );
  assert.match(failureText(vaultFailure(named, false)), /\(CapitalClosed\)$/);
  // Other code picks its strings and its errors as it likes: neither is shown.
  for (const failure of [words, named]) {
    const shown = failureText(vaultFailure(failure, true));
    assert.equal(shown, CHANGED_SILENCE);
    assert.ok(!shown.includes("0xdEaD") && !shown.includes("CapitalClosed"));
  }
  // What is not the vault's doing is reported as it is, changed code or not.
  const node = new ContractFunctionExecutionError(
    new HttpRequestError({ url: "https://rpc.example", status: 429 }),
    { abi, functionName: "redeem", args: [] },
  );
  assert.equal(vaultFailure(node, true), node);
  const refused = new UserRejectedRequestError(new Error("declined"));
  assert.equal(vaultFailure(refused, true), refused);
  const plain = new Error("잔액 또는 미완료 출금 요청을 확인하세요.");
  assert.equal(vaultFailure(plain, true), plain);
});

test("a changed vault that halts is worded as that vault, and an unanswered request as itself", async () => {
  const abi = [
    {
      type: "function",
      name: "totalAssets",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ] as const;
  // A read as viem fails it when the node answers with this error.
  const read = (code: number, message: string) =>
    createPublicClient({
      ccipRead: false,
      transport: custom(
        {
          request: async () => {
            throw Object.assign(new Error(message), { code });
          },
        },
        { retryCount: 0 },
      ),
    })
      .readContract({
        address: "0x00000000000000000000000000000000000000aa",
        abi,
        functionName: "totalAssets",
      })
      .then(
        () => assert.fail("the read was meant to fail"),
        (e: unknown) => e,
      );
  // The public RPC's answer to an invalid opcode and to a loop that uses all gas.
  for (const halt of [
    await read(-32003, "EVM error: InvalidFEOpcode"),
    await read(-32003, "out of gas: gas required exceeds: 30000000"),
  ]) {
    assert.equal(failureText(vaultFailure(halt, true)), CHANGED_SILENCE);
    // The same answer about the template's code is no reason to speak of changed code.
    assert.equal(vaultFailure(halt, false), halt);
    assert.equal(failureText(halt), "Transaction creation failed.");
  }
  // The node's limit says nothing about the vault, whatever its code.
  const limited = await read(-32005, "rate limited");
  assert.equal(vaultFailure(limited, true), limited);
  assert.match(failureText(vaultFailure(limited, true)), /요청 한도/);
  const late = new ContractFunctionExecutionError(
    new TimeoutError({ body: {}, url: "https://rpc.example" }),
    { abi, functionName: "totalAssets", args: [] },
  );
  assert.equal(vaultFailure(late, true), late);
});
