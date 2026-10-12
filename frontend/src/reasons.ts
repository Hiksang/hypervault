import { BaseError } from "viem";
import { callAnswered, errorText } from "./errors.ts";

/**
 * What a contract's custom error means for the person at the screen. The names are those of the
 * Vault, factory, verifier and source ABIs; the wording follows the contracts. One name can be
 * raised in several places, so a reason covers all of them.
 */
export const reasons: Record<string, string> = {
  PriceRecordTooSoon:
    "다음 표본 시점 전에는 지분 가격이 직전 기록보다 높을 때만 기록됩니다.",
  NoShares: "지분이 없는 Vault의 가격은 기록하지 않습니다.",
  PriceHistoryTooShort:
    "가격 창 안에 창의 절반 이상 지난 가격 기록이 있어야 입금 가격을 내고 출금을 정산합니다. 운용자가 신고된 대상을 범위에 등록해 신고에 답했다면 그 뒤의 기록만 셉니다. 가격은 누구나 기록할 수 있습니다.",
  PriceDropCooldown:
    "지분 가격이 창 안의 최고 기록보다 한도 넘게 낮습니다. 그 기록이 창을 벗어날 때까지 입금과 출금 정산이 미뤄집니다.",
  ActionNotFinal:
    "관리 액션이 아직 확정되지 않았습니다. Core 반영 확인은 다음 Core 블록부터(회수는 USDC가 도착한 뒤) 할 수 있습니다.",
  CoreNotFlat:
    "Core에 차입·포지션 또는 가져올 수 있는 가치가 남아 있어 정산할 수 없습니다.",
  NegativeCoreEquity: "Core 순자산이 음수여서 평가를 거부합니다.",
  OpenReport:
    "범위 밖 보유 신고가 지금 성립해 입금과 출금 정산이 닫혀 있습니다. 신고된 것은 등록되지 않은 대상의 보유이거나, 등록된 pair가 사 주지 않는 등록 토큰의 보유입니다. 그 보유를 매도하면 바로 다시 열리고, 범위에 등록해 신고에 답하면 그 뒤의 가격 기록이 창의 절반만큼 지난 다음에 열립니다.",
  ReportStands:
    "신고가 아직 성립해 목록에서 지울 수 없습니다. 신고된 보유가 등록되지 않은 채 남아 있거나, 등록된 pair가 그 보유를 사 주지 않습니다.",
  NotReportable:
    "신고할 수 없는 대상입니다. 범위가 이미 책임지는 대상(USDC, 등록된 DEX와 HyperCore vault, 차입이 있거나 등록된 pair가 그 보유를 10 USDC 이상에 사 주는 등록 토큰)이거나, 지금 보유가 없거나 팔 수 있는 크기(등록되지 않은 대상 10 USDC, 등록된 토큰 20 USDC)에 못 미치거나, token과 pair가 서로 맞지 않습니다. 다른 대상의 신고가 성립해 있는 동안에도 받지 않습니다.",
  ScopeInUse:
    "보유가 남아 있는 항목은 범위에서 뺄 수 없습니다. 토큰은 차입과 팔 수 있는 잔량이 없어야 하고, DEX와 HyperCore vault는 잔액이 0이어야 합니다.",
  ScopeIncomplete:
    "집계하지 않는 lending 장부에 잔액이나 차입이 있습니다. 그 토큰의 lending을 켜세요.",
  ScopeUnavailable:
    "평가 범위가 아직 등록되지 않았거나(가격 기록·출금 정산·신고에 필요), 입금 평가 스위치가 꺼져 있습니다(입금에 필요).",
  PriceGuard:
    "토큰 가격이 가드를 벗어났습니다(호가 없음, spread 과다, oracle과 불일치).",
  NegativeDexEquity:
    "등록 DEX의 계정 가치가 음수여서 입금 평가와 가격 기록을 거부합니다.",
  InvalidObservation:
    "Core 조회 결과가 등록 조건과 맞지 않습니다(pair, decimals, reserve, bridge 주소).",
  InvalidConfiguration:
    "목록의 순서·중복·상한 또는 설정 값이 계약 조건을 벗어났습니다.",
  InvalidContext:
    "검증기가 이 Vault의 설정(asset, 관리 액션 번호, config)과 맞지 않습니다.",
  PendingCoreAction:
    "확인을 기다리는 관리 액션이 있습니다. 먼저 Core 반영을 확인하세요. 출금 정산은 API wallet 등록을 해지한 뒤에만 할 수 있습니다.",
  AgentAlreadyUsed: "한 번 등록에 쓴 agent 주소는 다시 등록할 수 없습니다.",
  CapitalClosed:
    "입금이 닫혀 있거나, 금액이 최소 입금보다 작거나 남은 한도를 넘습니다.",
  NavUnavailable:
    "지금은 Vault가 입금에 쓸 NAV를 내지 않습니다. 관리 액션의 Core 반영 확인을 기다리는 중이거나, 운용 준비·운용 중이 아닌 단계(Core 활성화 확인 중, 출금 정산 중)입니다.",
  CoreNotReady: "Core 활성화가 아직 확인되지 않았습니다.",
  EvidenceRejected:
    "확인할 관리 액션이 없거나 이미 확인되었습니다. 또는 검증 결과가 Vault의 기록과 맞지 않습니다.",
  SlippageOrDeadline:
    "발행될 지분이 허용 범위보다 적거나 유효 시간이 지났습니다.",
  InvalidAmount: "금액 또는 요율이 허용 범위를 벗어났습니다.",
  InvalidReceiver: "등록할 수 없는 주소이거나, 해지할 API wallet이 없습니다.",
  Unauthorized: "이 계정에는 권한이 없습니다.",
  UpgradePending: "업그레이드 제안이 진행 중입니다.",
  WrongPhase: "현재 단계에서는 할 수 없는 동작입니다.",
  OutstandingRequest:
    "이미 진행 중인 출금 요청이 있습니다. 그 요청의 청구를 마친 뒤에 새로 요청할 수 있습니다.",
  EpochClosed:
    "이 출금 epoch는 지금 그 동작을 받지 않습니다. 이미 마감·정산되었거나, 아직 정리를 시작하지 않았습니다.",
  NotClaimable:
    "지금 청구할 수 있는 금액이 없거나, 요청한 양이 청구 가능한 범위를 넘습니다.",
  InvalidVaultName:
    "볼트 이름은 1~96바이트이고 앞뒤 공백과 제어문자를 쓸 수 없습니다.",
  ActivationBudgetExceeded:
    "Core 활성화 비용이 화면에서 확인한 금액보다 커졌습니다. 새로 고친 뒤 다시 시도하세요.",
  SafeERC20FailedOperation:
    "USDC 전송에 실패했습니다. 잔액과 승인 금액을 확인하세요.",
  ReadFailed:
    "HyperCore 조회(precompile)가 실패했습니다. 조회 대상(토큰·pair·DEX index)이 실제로 있는지 확인하세요.",
  InvalidReturnLength:
    "HyperCore 조회(precompile)의 응답 형식이 예상과 다릅니다.",
  ZeroAmount: "금액은 0보다 커야 합니다.",
};

/**
 * A contract's custom error, as `errorText` writes it (`Name(arguments)`), with its reason put
 * in front. Only a text that begins with a known name is explained: a name inside other text may
 * be words a contract chose for its revert string, and those are never given this page's voice.
 */
export function explain(text: string): string {
  const name = /^([A-Za-z_][A-Za-z0-9_]*)\(/.exec(text)?.[1];
  if (!name || !Object.hasOwn(reasons, name)) return text;
  const reason = `${reasons[name]} (${name})`;
  return text === `${name}()` ? reason : `${reason} · ${text}`;
}

type Link = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
};
function causes(e: unknown): Link[] {
  const chain: Link[] = [];
  for (let error = e; error instanceof Object && chain.length < 10; ) {
    chain.push(error as Link);
    error = (error as Link).cause;
  }
  return chain;
}

/**
 * What went wrong, as a line for the screen. An error some layer already put into words keeps
 * them. Of the rest, three get words here whichever library reports them: a wallet request the
 * user declined, a request that got no answer in time, and one the node refused for coming too
 * often. A contract's custom error comes with its reason, and anything else is the error's own
 * one-line text.
 */
export function failureText(e: unknown): string {
  const worded =
    e instanceof Error && !(e instanceof BaseError) && e.name === "Error";
  if (!worded) {
    const chain = causes(e);
    if (
      chain.some(
        ({ code, name }) =>
          code === 4001 || name === "UserRejectedRequestError",
      )
    )
      return "지갑에서 요청을 거절했습니다. 그 요청은 전송되지 않았습니다.";
    if (chain.some(({ name }) => name === "TimeoutError"))
      return "응답을 제시간에 받지 못했습니다(시간 초과).";
    if (chain.some(({ code, status }) => code === -32005 || status === 429))
      return "노드가 요청 한도를 넘었다며 답하지 않았습니다. 잠시 뒤 다시 시도하세요.";
  }
  return explain(errorText(e));
}

/**
 * Said in place of whatever a Vault whose code changed reverts with or answers. That code picks
 * its errors and its revert strings as it likes: none of them is repeated on this page.
 */
export const CHANGED_SILENCE =
  "코드가 바뀐 볼트가 요청을 되돌렸거나, 실행을 끝내지 못했거나, 해석할 수 없는 값을 답했습니다. 그 코드가 돌려준 오류와 문구는 표시하지 않습니다.";

/**
 * The failure to report for a call to a Vault. For a Vault whose code changed, whatever came
 * back about the call is that code's doing, also a halt that the node reports in words of its
 * own: it is not given this page's wording for a failed request. What got no answer at all (no
 * reply, a time-out, the node's limit) and what is not a call (the wallet) is reported as it is.
 */
export function vaultFailure(e: unknown, codeChanged: boolean): unknown {
  return codeChanged && callAnswered(e) ? new Error(CHANGED_SILENCE) : e;
}

/**
 * Why a Vault takes no deposit, from the error its valuation reverted with (`closedBy`). Empty
 * while it is valued.
 */
export function closedText(name: string | null | undefined): string {
  if (!name) return "";
  return Object.hasOwn(reasons, name)
    ? `${reasons[name]} (${name})`
    : `계약이 평가를 거부했습니다 (${name}).`;
}
