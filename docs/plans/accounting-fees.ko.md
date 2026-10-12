# 회계·수수료·gas·dust 기획

2026-10-02 범위 주의: 아래 WHYPE 소유권·매입 대가 예시는 현행 프로토타입 기준이다. 후속 [USDC 다중 시장 쌍](../DECISIONS.ko.md#adr-011)은 Vault USDC, Core USDC·spot token·HIP-3 담보·HIP-4 outcome, EVM/Core 이동, 1회성 활성화 비용과 6↔8자리 환산을 별도 원장으로 재정의해야 한다. 현행 표의 수치를 그대로 복사하지 않는다.

상태: PROPOSED / 일부 CONDITIONAL · 2026-09-21. 연결: CORE-004/005, REQ-10/11. 현행 epoch 수식은 [구현 명세](../split-implementation.ko.md), 제품 정책 선택은 [OPEN-02/05/08](README.md)이 관리한다.

## 소유권 원장

| 구분 | 경제적 소유자 | NAV/운용 처리 | 감소 조건 |
| --- | --- | --- | --- |
| Vault 미예약 WHYPE | 현재 주주 | NAV에 포함, 정책 범위에서 운용·recap | 배정·정산·정당한 비용 |
| Core 주주 자산/부채 | 현재 주주, pending request 포함 | 검증 source에서 순가치 반영 | 거래·상환·회수·손실 |
| 요청 escrow shares | 해당 controller의 출금 권리 | 정산 전 supply에 포함, 정산에서 소각 | epoch fulfillment |
| 확정 claim 준비금 | 정산된 controller 집합 | 주주 NAV와 투자에서 제외 | claim 또는 명시된 rounding dust 처리 |
| 완료 epoch rounding dust | 고정 dustRecipient | 지급 전까지 reservedClaimAssets 내부 | releaseRoundingDust |
| 주주 소유 buffer | 현재 주주 | NAV에 포함, 목표 유동성으로 운용 제한 | epoch 예약 또는 정책상 재배정 |
| Core gas 후원 | 정책상 비주주 예산 | share 미발행, 귀속 명시 후 NAV 제외 | 인증된 gas 소모/허용된 잔액 처리 |
| 귀속 불명 receipt/외부 송금 | 아직 미확정 | 자동 수익·claim 인정 금지 | 출처/소유권 대조 |

공유 Core 계정은 법적/경제적 장부 구분과 별개로 프로토콜 청산에서 같이 손실을 볼 수 있다. 계약이 계산상 예비금을 제외한다고 물리적으로 격리되는 것은 아니다.

## 사건별 회계 규칙

입금·배정·회수는 수익이 아니다. bridge를 Core와 EVM에 동시에 자산으로 잡지 않는다. recap은 이미 존재하는 주주 현금의 이동이며 신규 수익이나 새로운 지분 발행 근거가 아니다. funding/이자는 현재 잔액에 포함됐는지 확인한 뒤 한 번만 수익/비용에 반영한다.

epoch 정산은 기존 준비금을 제외한 순자산으로 새 entitlement를 만들고 지분을 소각한다. 확정 후 시장 손익을 그 entitlement에 다시 배분하지 않는다. 공용 담보를 먼저 빼 주는 담보 인출과 실제 Vault claim 준비금 적립은 다른 사건이다.

## 수수료 제안

이 절의 0 fee 권장안은 기존 WHYPE 기획의 이력이다. 새 공개 **USDC 운용자 Vault**는 [ADR-016](../DECISIONS.ko.md#adr-016)으로 다른 사용자의 실제 출금 이익에 10% 총 성과 수수료를 채택했고 [ADR-017](../DECISIONS.ko.md#adr-017)로 이를 운용자 80%·플랫폼 20%로 배분한다. 사용자별 USDC 원가·손실 이월·Claim 시 현금 분할은 [현행 목표 명세](../performance-fee-architecture.ko.md)가 관리한다. 현행 계약에는 아직 별도 성과 수수료 모듈이 없다. 거래 수수료·차입 이자·회수 비용은 실제 자산 변화로 반영한다.

아래 표는 WHYPE 또는 향후 다른 수수료 방식의 미결 기획이며, 새 USDC 상품에서 확정된 값은 ADR-016과 상세 명세가 우선한다.

| 항목 | 필수 결정 |
| --- | --- |
| 성과 측정 통화 | HYPE HWM인지 quote HWM인지; 환율 변동을 성과로 보는 방식 |
| 성과 수수료 | 순비용 차감 후 초과 성과, 손실 회복, 신규 입금/출금의 HWM 조정 |
| 관리 수수료 | 시간 기준, 부채/claim 제외 자산 기준, max 경과 시간과 징수 빈도 |
| 지급 방식 | 자산 인출 또는 지분 희석 중 하나; 준비금 사용 금지 |
| 결정 시점 | 입금/정산 전 기존 주주에게 귀속되는 비용을 먼저 확정 |
| 변경 가능성 | 현재 immutable 계약에 setter를 가정하지 않고 새 배포/별도 결정 |

참고 계산: virtual offsets와 반올림을 생략한 경제 모델에서, NAV A·supply S에 대해 F의 수수료를 새 지분으로 지급하려면 feeShares = F×S/(A−F)다. A≤F에서는 이 모델이 성립하지 않는다. 이 식은 구현 코드가 아니며 실제 OZ offset·ceil/floor·HWM 검증 없이는 적용하지 않는다. 비용을 NAV에서 이미 차감했다면 fee shares로 다시 같은 비용을 징수하지 않는다.

## gas 후원 원장 제안

초기 안은 비상환 후원으로 시작하고 shares를 발행하지 않는다. 누적 후원액, 인증된 소모, 주주 비용 부담분, 남은 비주주 예산을 별도로 추적한다. Core 잔액이 줄었다는 이유만으로 전액 gas 소모라 분류하지 않는다. 불명확한 손실은 gas/주주 자산 중 어디에 배분되는지 정책이 필요하다.

운용 중 top-up은 공개 호출 가능하되 정책 cap, 정확한 단위, 관측 intent를 적용한다. 기존 financial pending과 충돌하지 않는 별도 인입 원장이 필요하다. 후원이 자동 supply되거나 PM 담보로 사용되는 경우까지 [EX-02/07](validation.ko.md#ex-02)에서 검증한다. 불확실한 고정 gas floor를 매 cycle 새 자산처럼 복원하지 않는다.

## quote sub-lot dust 제안

| 방식 | 허용 조건 | 남는 제약 |
| --- | --- | --- |
| 실제 protocol 환전/상환 | 최소 단위·수수료·부채 해소가 실제 지원됨 | 가장 직접적이나 지원 미확인 |
| 후원자가 잔여 자산을 공정 가격으로 매입 | 최신 가격, 한도, 자산 소유권 이전과 WHYPE 입금이 대조됨 | arbitrary sweep 금지; adapter/원장 추가 필요 |
| 과거 epoch의 잔여 청구권 유지 | 기존 주주 소유권과 별도 recovery ledger, source의 한 번만 제외 | ERC7540 claim 및 NAV 모델을 확장해야 함 |
| 무조건 다음 cycle 이월/0 처리 | 해당 없음 | 채택하지 않음 |

첫 구현 제안은 실제 환전 가능성을 먼저 확인하고, 불가능하면 cap을 둔 후원 매입을 검토한다. 미확정 debt에는 asset dust 면제를 적용하지 않는다. 현행 terminal 차단을 단순 tolerance로 제거하지 않는다. 과거 epoch recovery ledger는 후순위 대안이며 현재 준비금 권리를 임의 변경하지 않는다.

## 예시와 완료 조건

Vault 현금이 20이고 기존 claim 준비금이 7이면 주주 현금은 13이다. Strategy에서 실제 40을 반환하면 새 정산에 쓰는 주주 현금은 53이며 60이 아니다. 나중에 이전 claim 7이 지급돼도 현 주주 NAV는 바뀌지 않는다.

필수 회계 시험: 여러 cycle의 기존 claim, donation, supply 이자, debt, recap, gas 손실/후원, 0자산 정산, 혼합 부분 claim, dust 매입 실패. 부채와 소유권 불명 금액을 ledger에서 지워 보존식을 맞추지 않는다.
