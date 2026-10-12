import { useEffect, useState } from "react";
import { zeroAddress } from "viem";
import { observeDirect, type Observation } from "../directRead";
import type { DirectVault } from "../directVaultManifest";
import { failureText } from "../ui";
import { amount } from "./hyper";
import { SectionError, Skel } from "./kit";

const PHASES = [
  "미초기화",
  "활성화 대기",
  "준비",
  "유휴(EVM 현금)",
  "운용 중",
  "출금 정산 중",
];
const KINDS = ["없음", "입금", "회수", "API wallet", "API wallet 해제", "제어"];

type Step = { id: string; label: string; button: string };
const OPEN: Step[] = [
  {
    id: "scope",
    label: "평가 범위 등록 (최초 1회)",
    button: "기본 평가 범위 등록",
  },
  { id: "queue", label: "Core 배정 금액 예약", button: "배정 금액 예약" },
  {
    id: "execute",
    label: "예약 배정 실행 (EVM → Core)",
    button: "예약 배정 실행",
  },
  {
    id: "sync",
    label: "다음 Core 블록에서 Core 작업 확인",
    button: "Core 작업 동기화",
  },
  {
    id: "agent",
    label: "API wallet 등록 후 동기화",
    button: "API wallet 등록",
  },
];
const CLOSE: Step[] = [
  { id: "unwind", label: "API wallet으로 포지션 정리 (페이지 밖)", button: "" },
  {
    id: "revoke",
    label: "API wallet 해제 후 동기화",
    button: "API wallet 해제",
  },
  { id: "exit", label: "출금 정산 시작 (회차 봉인)", button: "출금 정산 시작" },
  {
    id: "recall",
    label: "Core Spot에서 회수 후 동기화",
    button: "Core Spot에서 회수",
  },
  { id: "settle", label: "출금 정산 확정", button: "출금 정산 확정" },
];

/** Which step the vault's current state calls for, from the onchain reads only. */
function nextStep(s: Observation): string | null {
  const pending = s.pending.ok ? s.pending.value.id : 0n;
  if (pending !== 0n) return "sync";
  const phase = s.phase.ok ? s.phase.value : null;
  const agent = s.apiWallet.ok ? s.apiWallet.value : null;
  const queued = s.queued.ok ? s.queued.value : 0n;
  if (phase === 5) return agent && agent !== zeroAddress ? "revoke" : "recall";
  if (queued > 0n) return "execute";
  if ((phase === 3 || phase === 2) && (!agent || agent === zeroAddress))
    return "queue";
  if (phase === 4 && (!agent || agent === zeroAddress)) return "agent";
  return null;
}

/** The owner console's run order, with the step the vault's state points to. */
export function OwnerGuide({ entry }: { entry: DirectVault | null }) {
  const [seen, setSeen] = useState<Observation | null>(null),
    [failure, setFailure] = useState(""),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    setSeen(null);
    observeDirect(entry).then(
      (v) => alive && (setSeen(v), setFailure("")),
      (e) => alive && setFailure(failureText(e)),
    );
    return () => {
      alive = false;
    };
  }, [entry?.vault, tick]);
  if (!entry) return null;
  const decimals = seen?.decimals.ok ? seen.decimals.value : 6;
  const fmt = (v: bigint) => amount(decimals)(v);
  const next = seen ? nextStep(seen) : null;
  const row = (s: Step, i: number) => (
    <li key={s.id} className={next === s.id ? "now" : undefined}>
      <i>{i + 1}</i>
      <span>{s.label}</span>
      {next === s.id && <span className="tag info">다음 단계</span>}
      {s.button && <small>버튼: {s.button}</small>}
    </li>
  );
  return (
    <section className="sec owner-guide" aria-labelledby="og-h">
      <header className="sec-head">
        <h2 id="og-h">실행 순서와 현재 상태</h2>
        <button className="btn-sm" onClick={() => setTick((n) => n + 1)}>
          다시 읽기
        </button>
      </header>
      {failure ? (
        <SectionError
          what="Vault 상태를 읽지 못했습니다."
          detail={failure}
          onRetry={() => setTick((n) => n + 1)}
        />
      ) : !seen ? (
        <Skel h={56} />
      ) : (
        <dl className="kv-row">
          <div>
            <dt>상태</dt>
            <dd>{seen.phase.ok ? PHASES[seen.phase.value] : "조회 불가"}</dd>
          </div>
          <div>
            <dt>대기 중인 Core 작업</dt>
            <dd>
              {seen.pending.ok
                ? seen.pending.value.id === 0n
                  ? "없음"
                  : `#${seen.pending.value.id} ${KINDS[seen.pending.value.kind] ?? ""} (Core 확인 대기)`
                : "조회 불가"}
            </dd>
          </div>
          <div>
            <dt>API wallet</dt>
            <dd className="num">
              {seen.apiWallet.ok
                ? seen.apiWallet.value === zeroAddress
                  ? "없음"
                  : `${seen.apiWallet.value.slice(0, 6)}…${seen.apiWallet.value.slice(-4)}`
                : "조회 불가"}
            </dd>
          </div>
          <div>
            <dt>EVM 현금 / 배정 예약</dt>
            <dd className="num">
              {seen.cash.ok ? fmt(seen.cash.value) : "—"} /{" "}
              {seen.queued.ok ? fmt(seen.queued.value) : "—"}
            </dd>
          </div>
        </dl>
      )}
      <div className="og-cols">
        <div>
          <h3 className="sub-h">운용 시작</h3>
          <ol className="og-steps">{OPEN.map(row)}</ol>
        </div>
        <div>
          <h3 className="sub-h">출금 정산 (전체 청산)</h3>
          <ol className="og-steps">{CLOSE.map(row)}</ol>
        </div>
      </div>
      <p className="fresh">
        Core 작업은 비동기입니다. EVM 트랜잭션 확정 후 다음 Core 블록에서
        반영되며, 그때 "Core 작업 동기화"로 확인합니다.
      </p>
    </section>
  );
}
