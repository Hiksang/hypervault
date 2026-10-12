# 상품 요구사항 기획

상태: PROPOSED · 2026-10-03 갱신. 대상: PROD-001, REQ-01/13/14/17. 현재 구현은 [STATUS](../STATUS.ko.md); 아래 후기 단계는 출시 약속이 아니다. 새 제품의 자산·시장·표준/유동성 방향은 [ADR-010](../DECISIONS.ko.md#adr-010)·[ADR-011](../DECISIONS.ko.md#adr-011)·[ADR-012](../DECISIONS.ko.md#adr-012)을 따른다.

## 상품 정의

현행 프로토타입은 WHYPE 지분과 HYPE 담보·HYPE perp short의 carry다. 새 제품 목표는 **HyperEVM USDC 입출금·USDC 기준 지분과 HyperCore spot·HIP-3·HIP-4 거래**다. validator 운영 perp도 포함한다. HYPE 현물·perp carry는 가능한 전략 예시일 뿐 고정 상품 정의가 아니다. 기존 HyperCore Vault와 다른 거래 범위가 핵심이다. 사용자는 관리형 개별 포지션 대신 ERC20 지분과 비동기 출금 권리를 가진다. keeper는 정해진 실행만 촉진한다. 현행 WHYPE 코드가 USDC를 받는다는 뜻은 아니다.

주주는 spot·perp·HIP-3·HIP-4의 평가/정산 손익과 funding·이자·거래 비용·운용 손실을 함께 부담한다. HIP-4의 미결제 outcome은 확정 USDC가 아니며, 모든 시장의 손익을 같은 시점의 USDC 가치로 대조한다. 초기 상품명이나 화면에 원금 보장·고정 APY·즉시 출금 표현을 사용하지 않는다.

## 단계별 제품 범위

| 단계 | 제공 기능 | 넘어갈 조건 |
| --- | --- | --- |
| A: 현행 프로토타입 검증 | WHYPE Idle 예치, 단일 carry, 전량 회수와 epoch claim | 통제된 정상/실패 왕복, 최종 지급과 비용 원장 확인 |
| B: USDC·시장 경로 검증 | 별도 USDC 쌍의 HyperEVM↔Core 왕복과 spot·HIP-3·HIP-4 주문/정산/회수 | [USDC-001](../BACKLOG.ko.md#usdc-001)·[MARKET-001](../BACKLOG.ko.md#market-001)의 시장별 통제 시험 |
| C: 다중 시장 배포 후보 | spot·HIP-3·HIP-4 중 전량 회수 가능한 허용 시장의 USDC NAV·exit와 성과·위험 표시; 목표 운용 buffer 0 가능, 확정 claim 준비금 별도 | DEX·token·outcome 전체 source 완전성, 만기/중단·회수·비용 검증 |
| D: 운용 중 입금 | Active 동기 입금, 제한된 현금 대기·추가 배정 | 희석·가격 조작·미헤지 노출 제한 검증 |
| E: 지속 운용 출금 | 부분 회수와 필요시 buffer, 동일 epoch 전체 처리 | 잔존 포지션 위험·가격·손실 공정성 검증 |
| F: 외부 프로토콜 확장 | lending/LP 등 별도 custody adapter와 배분·회수 정책 | 첫 제품의 Core 시장 지원과 구분해 독립 검증 |

각 단계는 외부 배포 버전 번호가 아니다. 현행 immutable 계약에 후기 기능을 setter로 추가하는 모델도 아니다.

## 사용자의 핵심 작업

| 사용자 | 원하는 결과 | 사용 흐름 | 성공 확인 |
| --- | --- | --- | --- |
| 예치자 | 자산과 가격 조건을 알고 지분 취득 | 자산 선택→허용 상태/최소 수령 확인→승인→입금 | 실제 수령 지분·기준 블록·거래 |
| 출금자 | 대기와 손실 가능성을 알고 출금 신청 | 지분 수량→controller/receiver 방식 선택→request | requestId, pending 지분, 현재 제약 |
| 청구자 | 확정 자산 수령 | Claimable 확인→기초자산 수령; 현행 WHYPE, 후속 USDC | entitlement 감소와 실제 이체 |
| 제3자 실행자 | 사용자의 목적지를 바꾸지 않고 지급 | 고정 수령 adapter의 claim 호출 | 원 beneficiary 수령, caller 보상과 분리 |
| 운영자 | 상태를 파악하고 필요한 동작 실행 | 관측→권한/위험 조건 확인→단계 실행 | Core 결과와 EVM tx 결과를 별도 기록 |
| 통합 서비스 | 지분·권리를 정확히 표시 | 계약 조회+indexer provenance | 캐시만으로 출금액/거래 가능성 확정하지 않음 |

## 상품 정책

- 현행 WHYPE 지분과 후속 USDC 지분은 별도 주소·별도 권리다. share를 송금해도 이미 request에 escrow된 지분과 controller 권리는 같이 이전되지 않는다는 점을 안내한다.
- 최초 요청 취소 기능과 양도 가능한 출금 NFT는 추가하지 않는다. 사용자에게 요청 전 이 제약을 보여 준다.
- 출금 시간은 보장하지 않는다. 관측된 처리 분포를 표시할 수 있으나 unknown pending에서는 ETA 대신 지연 원인을 표시한다.
- 새 공개 USDC 운용자 Vault의 성과 수수료는 [ADR-016](../DECISIONS.ko.md#adr-016)의 **다른 사용자 출금 이익 10%**다. [ADR-017](../DECISIONS.ko.md#adr-017)은 그 수수료를 운용자 80%·플랫폼 20%로 배분한다. 구체적인 원가·손실 이월·순수령 계산은 [수수료 명세](../performance-fee-architecture.ko.md)를 따른다. 기존 WHYPE 수수료 기획과 실제 거래·차입·회수 비용은 별개다.
- 새 공개 USDC Vault의 첫 경로는 [ADR-021](../DECISIONS.ko.md#adr-021)의 생성 거래 내 HyperEVM USDC 100 수령·창설자 지분 발행과 Vault 자신의 Core 배정이다. 후속 Core 확인은 거래·공개 입금의 개방 조건이며 share를 재발행하지 않는다. 101 gross/100 net은 실측 전 확정 표시하지 않는다. 플랫폼 생성 수수료는 없고 활성화 비용은 창설자 지분 원가에 포함하지 않는다. Core에만 자금이 있는 창설자·일반 사용자는 자기 동일 주소 EVM으로 출금한 뒤 Vault 함수로 입금한다. Vault Core 직접 송금은 지분을 만들지 않는다.
- 운용 중 창설자 지분 출금 제한은 [OPEN-09](README.md#정책-결정-등록부)의 제안이다. 초기 창설자 share 유지, 추가 share의 조건부 출금, 종료 후 전액 출금 가능 여부를 배포 전에 확정하고 UI·계약이 같은 규칙을 써야 한다.
- 통제된 시험 단계의 TVL·최소 입금·cycle 기한은 배포 manifest의 값으로 표시한다. README 예시를 운영값으로 쓰지 않는다.

## 성과와 지표의 정의

| 지표 | 정의와 표시 조건 |
| --- | --- |
| 지분당 기초자산 가치 | 검증된 주주 NAV / 유통+미정산 escrow 지분; 확정 claim 지분은 소각 후 제외. 현행 WHYPE와 후속 USDC를 혼용하지 않음 |
| quote 환산 가치 | 같은 시점·quote의 검증된 가격으로 환산; USDC와 USD를 혼용하지 않음 |
| 사용자 순수익 | 입출금 현금흐름을 분리한 지분 가치 변화; 예치 증가는 수익 아님 |
| 기간 전략 수익 | spot·perp·HIP-3·HIP-4의 실현/평가손익+funding/이자−거래/회수 비용; 만기 payout·미결제 가치 중복 계상 금지 |
| 연환산 표시 | 관측 기간·평가 통화·수수료 포함 여부와 계산 방법을 함께 표시; 기간 부족 시 생략 |
| 회수 시간 | request→Claimable, Claimable→Claimed를 별도 집계; 미완료 건을 제외해 성능을 과장하지 않음 |
| 운용 신뢰성 | 시장별 미확정 action·read 실패·reconciliation 차이, HIP-3 health, HIP-4 만기 지연, 집중 노출 |

## 현행 HYPE carry의 경제성 모형 (새 상품 전체에 일반화 금지)

이하 수식은 기존 WHYPE carry 아이디어의 단순 모형이다. 새 USDC 다중 시장 상품의 spot·HIP-3·HIP-4 손익이나 만기 정산 공식을 대신하지 않는다. 각 시장의 경제성은 MARKET-001에서 별도로 모델링한다.

시뮬레이션은 같은 quote 통화와 같은 기간 h를 사용한다. short 명목금액 N, 공급자산 가치 V, 실제 quote 부채 D, 각 기간의 funding/공급/차입 수익률을 rf/rs/rb, 왕복 비용을 C라고 하면 단순 상수 잔액 모델은 다음과 같다.

```text
기간 기대손익 ≈ N × rf + V × rs - D × rb + basis 변화 손익 - C
손익분기 funding ≈ (D × rb - V × rs + C) / N   [basis 변화=0, N>0]
```

이는 미래 의사결정용 모형이며 NAV에 더하는 새 수익 항목이 아니다. 실제 ledger에서 이미 반영한 funding/이자를 다시 더하지 않는다. rb/rs를 연율로 입력하고 rf만 시간당 값으로 입력하는 식의 혼용을 막는다. 실제 운영에서는 N/V/D/가격이 변하므로 시간 구간별 적분과 체결·비용 원장을 사용한다.

| 시나리오 | 확인할 결과 |
| --- | --- |
| funding 양수이나 차입 금리가 높음 | funding만으로 진입하면 순손실이 될 수 있음 |
| funding 음전환·예상보다 긴 회수 | 기다리는 비용과 즉시 축소 비용을 비교 |
| 입금/출금이 잦고 금액이 작음 | 고정 왕복비·lot/dust가 수익을 넘는 구간 |
| HYPE 급등/급락·basis 확대 | quote delta hedge와 차입 증가/health/HYPE 환산 손익 분리 |
| buffer 증가 | 운용 명목금액·funding 수익 감소와 미헤지 가격 노출 |

매출·APY·TVL 목표는 아직 정하지 않는다. funding의 과거 관측을 보장 수익으로 사용하지 않고, 실행비·금리·가격 스트레스에서 순가치와 회수 가능성을 함께 보고 진입/중단 정책을 보정한다. 첫 버전에 funding 예측 oracle나 자동 수익률 최적화가 이미 있는 것으로 표시하지 않는다.

## 제외 범위와 완료 조건

원금 보증, 정해진 APY, 신규 토큰 발행 인센티브, 허가 없는 임의 레버리지, 사용자별 커스텀 전략은 첫 상품 범위가 아니다. 지갑별 손익 세무 처리나 법적 상품 분류를 이 기술 기획에서 확정하지 않는다.

완료 조건은 세 단계다. 제품 용어·권리·수수료 표시가 실제 계약과 맞고, 대표 사용자 흐름을 [화면 기획](frontend.ko.md)으로 실행할 수 있으며, 제한 상황을 [검증 계획](validation.ko.md)으로 재현한다. 처리 속도·APY 목표값은 데이터가 생긴 뒤 설정한다.
