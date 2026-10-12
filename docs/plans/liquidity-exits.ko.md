# 출금 buffer와 부분 회수 기획

2026-10-02 범위 주의: 아래 WHYPE buffer·환율·HYPE 수치 예시는 현행 프로토타입 기준의 제안이다. 후속 [USDC 쌍](../DECISIONS.ko.md#adr-010)의 buffer는 미예약 USDC로 정의하고, spot token·기본/HIP-3 perp·HIP-4 outcome·USDC 부채·실제 반환액에 대한 가격·위험 수식을 새로 검증한다. 예시의 WHYPE를 글자만 USDC로 바꿔 적용하지 않는다.

2026-10-03 USDC 초기 설계 결정: [ADR-012](../DECISIONS.ko.md#adr-012)에 따라 첫 배포 후보는 목표 운용 buffer 0과 **전량 회수 후 epoch claim**으로 시작할 수 있다. 이 문서의 부분 회수·buffer 수식은 더 빠른 출금/지속 운용을 위한 후속안이다. `reservedClaimAssets`는 이미 확정된 청구의 지급 준비금이므로 목표 운용 buffer가 0이어도 잠그며, 신규 배정·recap에 쓰지 않는다. EVM 가스용 HYPE는 별도 운영 자금이다. 모든 허용 시장이 실제 USDC로 회수될 때까지 출금은 지연될 수 있고, 환금 경로 없는 HIP-4 outcome은 배포 후보에서 제외한다.

상태: PROPOSED / 평가·회수는 CONDITIONAL · 2026-09-21. 연결: LIQ-001, REQ-09/10/12/13. 현행 전량 cycle 종료와 구분되는 **새 배포의 확장안**이다.

## 첫 구현안

하나의 sealed epoch 전체를 한 번에 Claimable로 만든다. **전략 일부 회수**와 **요청 일부 fulfillment**는 다르다. 첫 버전은 필요한 포지션만 줄이되 sealed 요청 전체의 준비금이 확보될 때 함께 정산한다. 여러 tranche의 부분 fulfillment는 후기 기능으로 미룬다.

한 번에 open epoch 하나와 정산 중 epoch 하나만 허용하는 복잡도도 검토할 수 있으나, 첫 구현은 정산 중 새 요청과 입금을 닫아 controller별 한 미완료 epoch 제약을 유지하는 안이다. 출금 가능 횟수/접근성 영향은 화면에 표시한다.

## buffer 원장과 가격 노출

`freeCash = Vault WHYPE - reservedClaimAssets`이며 buffer는 이 freeCash 중 정책상 남기는 주주 자산이다. buffer를 새 채무처럼 totalAssets에서 다시 빼지 않는다. targetBuffer는 검증된 주주 NAV와 정해진 비율/상한으로 계산한다. reserve·recap·재배정 가능 현금은 중복 배정하지 않는다.

WHYPE buffer는 미헤지일 수 있다. 전체 HYPE delta와 Core 담보만으로 안전하게 유지 가능한 hedge를 함께 검사한다. Vault 밖의 현금까지 short로 맞추면 Core PM 담보가 부족해질 수 있으므로 full hedge를 자동 요구하지 않는다. 초기 bounded-unhedged 제안은 OPEN-03이다.

## 제안 정산 전이

| 상태 | 동작 | 금지 동작 |
| --- | --- | --- |
| Collecting | 같은 epoch의 request 집계 | 고정 지급액 약속 |
| Sealed | Q 고정, 입금/추가 배정 잠금 | 일부 사용자만 선착순 buffer 지급 |
| PreparingLiquidity | 필요 자금 추정, partial close/상환/담보 회수 | 추정 회수액으로 준비금 확정 |
| LiquidityStable | pending/inflight 없음, 잔존 전략 위험 확인, fresh 평가 | CapitalEstimate로 대체 |
| Fulfilled | 같은 스냅샷으로 환율·준비금 설정, Q 소각 | 이후 손실을 확정 claim에 전가 |
| Claiming | 기존 controller별 부분 claim | 다른 controller 잔액 지급 |
| Completed | rounding dust 처리, 다음 epoch | 과거 잔여 소유권 삭제 |

이는 제안하는 논리 상태이며 현행 enum 숫자로 추가 구현된 것이 아니다. 전량 청산·shutdown은 기존 full-exit 경로를 유지한다.

## 정산 수식과 반복 회수

Q<S일 때 LiquidityStable의 검증된 주주 NAV N으로 현행 virtual policy를 확장해 `rate=(N+1)/(S+1000)`, `R=floor(Q×rate)`를 제안한다. R 이상인 실제 미예약 WHYPE가 있을 때만 epoch를 Fulfilled로 만든다. 확정 준비금 R을 제외하고 Q를 소각하면 잔존 주주는 나머지 자산을 보유한다.

초기 회수 목표는 추정치다. 회수 중 가격·비용·N이 변해 현금이 R보다 작으면 전원 Pending을 유지하고 추가 회수한다. 무한 반복을 숨기지 않도록 bounded round 수와 full-exit 전환 정책을 파라미터로 둔다. 라운드 상한은 pending action을 무시하는 timeout이 아니다.

Q=S인 전량 출금은 잔존 전략을 평가로 남기지 않고 실제 전량 회수/채무·잔여 정리를 완료한 뒤 A/S로 정산한다. partial-exit에서도 N≤0을 단순 0 claim으로 처리하려면 남아 있는 채무·자산 소유권 종료가 먼저 증명돼야 한다.

## 비용과 희석

첫 안은 회수 실행 중 발생한 실제 비용을 정산 전 공용 주주 NAV에 반영하고 pending 지분도 같은 비율로 부담한다. 잦은 소액 출금이 잔존 주주에게 비용을 전가할 수 있으므로 최소 요청·epoch batching·실행 비용 cap을 검토한다. 출금자에게만 비용을 부과하려면 별도 fee 명세와 동일 requestId 환율이 필요하다.

잠금 동안의 시장 손익은 아직 정산되지 않은 모든 지분에 귀속한다. buffer 도착 시점에 먼저 클릭한 유저만 이전 NAV 가격으로 빠져나갈 수 없게 한다. full cash 초과 회수는 잔존 주주 현금이며 마지막 출금자의 보너스가 아니다.

## Strategy 인터페이스와 reader 변경

제안 내부 인터페이스는 `requestLiquidity(epochId, targetAssets, constraintsHash)`, `liquidityStatus(epochId)`, `returnLiquidity(epochId)` 같은 별도 경로다. 실제 selector는 구현 전 정한다. cycleId·epochId·withdrawal intent를 함께 검증하고, 반환 자금은 Vault만 받을 수 있다.

partial close 이후 필요한 margin과 부채를 재검사하고 담보를 먼저 과도하게 빼지 않는다. 잔존 포지션으로 Active를 이어갈 수 있어야 한다. 현재 `returnToVault`가 cycle을 끝내는 동작과 혼합하지 않는다. reader는 LiquidityStable에서도 검증된 잔존 NAV를 읽도록 scope/state 정책 확장이 필요하다.

## 수치 예시와 완료 조건

offset·비용을 생략한 예시에서 N=1,000 HYPE, S=1,000 shares, Q=200이면 R=200이다. freeCash=50이면 150 이상 실제 회수가 필요하다. 회수 비용 반영 후 N=990이면 동일 epoch 전원에게 같은 최종 rate 0.99를 적용한다. 특정 사용자를 먼저 1.00에 지급하지 않는다.

동일 epoch 순서 변경, 다중 사용자, 가격 급변, 회수 부족/초과, 부분 close 후 pause, 잔존 부채, stale NAV, 전체 출금, 기존 claim 지급을 시험한다. 새 권한·준비금·표준 적합성 검토 없이 현행 settleEpoch에 이 수식만 삽입하지 않는다.
