# 생산용 HyperCore NAV source 기획

상태: CONDITIONAL · 2026-09-21. 연결: NAV-001, REQ-06/07. 계산 수식과 기존 Snapshot ABI는 [NAV 설계](../nav-liquidity-architecture.ko.md), [IStrategyBalanceSheet](../../src/interfaces/IStrategyBalanceSheet.sol)를 따른다.

## 책임과 범위

제안 `HyperCoreBalanceSheetSource`는 raw 계정 관측을 **중복 없는 quote 1e18 대차대조표**로 변환한다. raw reader를 그대로 연결하지 않는다. 이 문서의 2026-09-21 초안 첫 범위는 지정 Strategy·HYPE/quote·한 perp·명시한 DEX 집합이다. [ADR-011](../DECISIONS.ko.md#adr-011)의 새 USDC 상품에는 이 범위가 부족하며, spot·HIP-3 DEX·HIP-4 outcome을 포함한 source와 시장별 가격/정산 품질을 다시 설계해야 한다. 범위 밖 자산이 없다는 확인 방식이 없으면 `complete=true`를 반환할 수 없다.

source는 계정·기초 자산·configHash·cycleId·Core block을 검증하고 모든 구성요소와 가격의 provenance를 관리한다. keeper 제출 숫자를 신뢰하는 입력은 없다. 별도 source 교체 setter 없이 새 배포 구성에 고정한다.

## 필드 매핑 명세

| 목적 필드 | 후보 원천 | 정규화와 중복 방지 조건 |
| --- | --- | --- |
| spotValue | raw spot free/held를 포함한 경제적 소유 잔액 | 사용 가능 금액과 자산 가치를 구분; 공급·bridge와 중복 제외 |
| suppliedValue | lending supply.value | basis 대신 이자 포함 value; 통합 API 잔액과 동시 합산 금지 |
| debtValue | lending borrow.value + 미포함 부채 | 양수 채무로 정규화; 음수 margin을 또 debt로 이중 반영 금지 |
| perpCollateralValue, unrealizedPnl | margin/position의 검증된 분해 | accountValue를 그대로 쓸지 분해할지 하나 선택; 포함 PnL 재가산 금지 |
| unsettledFunding | 아직 어느 잔액에도 반영되지 않은 금액 | 누적 funding 통계를 사용하지 않음; 검증 불가하면 source 미완성 |
| accruedFees | 아직 자산 차감에 반영되지 않은 비용 | 거래 잔액에 이미 반영된 fee를 다시 차감하지 않음 |
| excludedValue | 총자산에 포함된 비주주 gas/잔여 수탁 자금 | 실제 포함된 항목만 한 번 차감; 별도 현금과 혼동 금지 |
| assetPrice | 같은 quote 기준 HYPE 가격 | 관측 시각과 업데이트 시각 구분; USDC/USD 환율 가정 금지 |

margin summary가 signed net 값이고 기존 unsigned collateral 필드로 안전하게 분해할 수 없다면 임의 0 clamp를 하지 않는다. 별도 signed net 항목을 가진 ABI 변경안을 먼저 제시하거나 source를 불완전으로 둔다. raw helper의 관측시각은 가격의 freshness 증명이 아니다.

## 단위·시점 계약

- 각 필드는 별도 단위 descriptor와 metadata 근거를 가진다. raw spot/lending, margin, szi, mark/oracle를 한 decimals로 나누지 않는다.
- 정규화는 정수 mulDiv와 checked cast를 사용한다. signed NAV는 음수를 보존하며 기초 자산 환산의 음수 나눗셈도 floor다.
- `observedAt`은 모든 입력 중 가장 오래된 실제 관측 기준이다. 마지막 가격 갱신 시각을 제공받지 못하면 block.timestamp를 대신 넣어 freshness를 만들지 않는다. 가격 유효성을 증명하는 별도 설계가 필요하다.
- 한 EVM 호출의 Core snapshot 일관성과 HTTP 시점 비교는 별개다. 동일 block read만으로 가격의 경제적 최신성을 보장하지 않는다.

## 평가 상태

| 상태 | source/reader 결과 | 허용하는 사용 |
| --- | --- | --- |
| 모든 범위·단위·가격·부채 확인 | 검증된 Snapshot, reader MarkToMarket | 추가 가격 정책을 통과한 경우에만 신규 입금 |
| 자산/DEX 범위 불명 | complete=false 또는 명시적 오류 | 진단; mint 금지 |
| read 실패/ABI 오류 | revert/Unavailable | 기존 claim은 계속, 새 가격 사용 금지 |
| bridge/recall/pending 있음 | inFlight=true | 전이 진단, Active 가격 사용 금지 |
| 회수 완료 후 현금만 있음 | 기존 Realized 경로 | 실제 현금 기반 정산 |

현재 `PortfolioNavReader`는 Active·pending 없음에서만 MTM을 읽는다. [부분 출금](liquidity-exits.ko.md)의 정산 구간 평가를 지원하려면 별도 안정 상태와 reader 검사 변경이 필요하다. fallback CapitalEstimate를 정산 가격으로 승격하지 않는다.

## 완전성 증명 방식

허용 action만 내보내는 코드 검토만으로 외부에서 들어온 자산이나 다른 DEX 잔액 부재를 증명할 수 없다. 지원 자산 열거 가능성, account abstraction, isolated/cross 포지션, collateral 통화, 미체결/hold를 조사한다. 알 수 없는 dust의 존재가 영구 DoS를 만들지 않도록 격리·경제적 제외 정책을 설계하되 알려지지 않은 부채는 제외하지 않는다.

관측 원장은 raw→단위→소유권→항목→합계 순으로 각 금액을 추적한다. 같은 원천 잔액 ID가 두 자산 항목에 들어가면 검증 실패다. `supply + margin accountValue` 같은 표본 후보식은 일반 공식으로 복사하지 않는다.

## 구현과 완료 조건

source의 설정 hash에는 quote 식별자, 허용 토큰/시장/DEX, 단위 descriptor, 가격 정책, 가스/잔여 소유권 정책 버전을 묶는 안을 제안한다. 현재 Snapshot에 quote 식별자가 없으므로 source configHash와 배포 manifest에서 검증하거나 ABI 확장이 필요하다.

완료 산출물은 필드 매핑표, 정상/부채/펀딩/부분체결/청산/회수 전후 원장, 비제로 단위 시험, 누락·중복·negative equity property test다. 지분 발행 검증은 별도 VAULT-001이며 source 완성만으로 자동으로 열리지 않는다.
