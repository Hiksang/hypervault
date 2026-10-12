# 사용자 화면과 통합 API 기획

2026-10-04 Managed 기본 FE의 현행 실행·설정·범위는 [frontend 안내](../../frontend/README.ko.md)를 따른다. 아래는 후속 전체 화면 기획이다.

2026-10-02 범위 주의: 아래 WHYPE/native Router 화면은 현행 프로토타입용 초안이다. 후속 [USDC 쌍](../DECISIONS.ko.md#adr-010)은 HyperEVM USDC 입금·USDC claim과 Core 이동/정산 대기를 별도 흐름으로 표시한다. WHYPE 입금과 USDC 입금을 동일 Vault의 토큰 선택 메뉴처럼 보여주지 않는다. 새 공개 USDC Vault는 [성과 수수료 명세](../performance-fee-architecture.ko.md)에 따라 Pending 단계의 예상 총액·예상 수수료·예상 순수령과 Claimable 단계의 확정 값을 각각 표시한다.

새 USDC Vault 생성 화면의 첫 경로는 [ADR-021](../DECISIONS.ko.md#adr-021)의 HyperEVM 승인과 `createVaultAndFund` 한 번의 생성·창설자 지분 발행·첫 Core 배정 거래다. EVM 성공 즉시 창설자 share와 `AwaitingActivation`을 표시하고, Core 순수령이 검증되면 Ready·운용 가능으로 바꾼다. 예상 gross 차감과 예상 활성화 비용을 분리하며 101→100은 실측 전 보장 수치로 쓰지 않는다. 플랫폼 생성 수수료는 없다. Core에만 USDC가 있는 창설자·예치자는 자기 동일 주소 EVM으로 먼저 출금하고 도착 확인 후 Vault 함수로 입금하도록 안내한다. Vault Core 주소로의 직접 송금은 share를 발행하지 않는다고 명시한다.

상태: PROPOSED · 2026-09-21. 연결: UX-001, REQ-01/13/14. 화면/서버 구현은 아직 없으며 아래 route와 API는 제안이다.

## 화면 구성

| 화면 | 필수 정보 | 주요 행동 |
| --- | --- | --- |
| 상품 개요 | 기준 자산, 전략 단계, 수수료, 출금 방식, 평가 품질 | 지갑 연결·예치 이동 |
| 내 자산 | 보유 지분, pending 지분, claimable entitlement를 분리 | 입금·요청·청구 |
| 입금 | WHYPE/native, 허용 상태, 최소 수령, gas, deadline | approval 및 deposit |
| 출금 신청 | 지분, controller, 취소 제약, 변동 가능한 수령액 | requestRedeem |
| 요청 상세 | requestId, controller, Pending/Claimable/Claimed, block 근거 | 허용된 claim 또는 고정 수령 adapter 실행 |
| 전략 상태 | cycle, 자금 위치, Core pending, 정상/지연/위험 상태 | 일반 사용자는 조회, 실행자는 공개 진행 함수 |
| 운영 화면 | 역할별 가능한 동작, raw/evidence, 불일치·경보 | 권한에 맞는 실행과 결과 확인 |

## 표시 규칙

NAV 품질을 `확정 회수액`, `검증된 평가액`, `투입 원금 추정`, `평가 불가`로 구분한다. 마지막 값은 시점과 함께 회색 참고값으로 표시하고 “현재 출금 가능”으로 보여주지 않는다. HYPE 수익률과 quote 수익률은 통화·기간을 붙인다. funding rate 하나를 상품 APY로 표시하지 않는다.

내 자산에서 wallet shares와 escrow 요청 지분을 더해 경제적 노출을 설명할 수 있지만 이미 소각한 claim 지분을 현재 supply에 다시 합산하지 않는다. exact payout은 `maxWithdraw(controller)` 등 확정 권리로 읽고, pending은 예시 환산액일 뿐 최종 금액이 아님을 표시한다.

## 상태별 행동

| 계약/요청 상태 | 입금 | 새 요청 | 확정 claim |
| --- | --- | --- | --- |
| Idle, 정상 | 현행 지원 | 가능, 별도 claim 필요 | 가능 |
| Active | 현재 닫힘; 후기 VAULT-001 이후 조건부 | 현행 epoch 범위에서 가능 | 기존 claim 가능 |
| Exiting/정산 잠금 | 닫힘 | 현행/제안 정책상 닫힘 | 기존 claim 가능 |
| pause/shutdown | 닫힘 | 계약의 허용 상태를 조회 | 차단하지 않음 |
| NAV/Core read 실패 | 새 가격 거래 닫힘 | 요청 ABI의 실제 허용 결과 표시 | EVM 준비금·권리로 실행 가능 |

UI는 이름만 보고 허용 여부를 추정하지 않고 최신 view와 call simulation을 사용한다. 버튼을 잠글 때 이유와 재확인 방법을 표시한다.

## 권한과 사용자 확인

입금 자금 제공자, share receiver, request owner, controller, claim receiver의 차이를 거래 전 요약한다. controller를 잃으면 share allowance만으로 claim할 수 없으므로 임의 주소 자동 채우기를 하지 않는다. 제3자 지급을 원하면 고정 beneficiary adapter 주소와 beneficiary를 검증해 보여 준다.

native claim은 사용자가 router를 operator로 승인해야 한다. 승인 범위와 취소 방법을 표시한다. 현재 router에 다른 사용자의 controller를 넣는 입력은 만들지 않는다. permit·가스 대납·일괄 서명은 현재 지원한다고 표시하지 않는다. native 수신 실패 시 WHYPE claim 대안을 제시한다.

## 제안 read API

```text
GET /v1/vaults/{chainId}/{vault}
GET /v1/vaults/{chainId}/{vault}/controllers/{controller}/requests
GET /v1/strategies/{chainId}/{strategy}/cycles/{cycleId}
GET /v1/strategies/{chainId}/{strategy}/actions/{actionId}
```

응답에는 schemaVersion, contract ABI version, chainId, block number/hash, Core block, observedAt, freshness/evidence, nullable error를 포함한다. 금액은 base-unit string과 decimals다. missing을 `"0"`으로 채우지 않는다. HTTP API는 추적과 표시용이며 mint/재시도 권한은 없다. 주소와 chain은 URL·manifest·지갑 간 대조한다.

견적은 온체인 fresh read/simulation을 사용하며 quote block, 만료, minShares/maxAssets를 사용자가 확인한다. 서버가 반환한 예상량을 계약 보호 조건 없이 서명하게 하지 않는다.

## 오류와 접근성

네트워크 불일치, 입금 닫힘, 부족 allowance, 기존 controller epoch, 가격/유동성 실패, read unavailable, native 수신 거절, transaction replacement를 구분한다. 사용자에게는 필요한 다음 행동을, 운영 상세에는 selector/revert/evidence를 제공한다. 불명확한 오류를 모두 “잔액 부족”으로 바꾸지 않는다.

상태를 색만으로 구분하지 않고 텍스트·키보드 접근·소수점 복사·주소 확인을 지원한다. 수용 시험은 잘못된 chain/controller, 두 번 클릭, stale quote, 지갑 거절, 이미 claim된 요청, indexer lag/reorg, 모바일 claim 흐름을 포함한다.
