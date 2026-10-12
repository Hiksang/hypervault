# 다중 전략·외부 대출·USDC 확장 기획

상태: PROPOSED · 2026-10-03 갱신. 연결: STRAT-001, REQ-06/10/17. 외부 custody/lending/LP 확장은 첫 USDC 상품의 Core spot·HIP-3·HIP-4 시장 지원과 별개이며, 검증된 NAV와 부분 회수 이후 단계다. 특정 외부 프로토콜을 선택하거나 투자 비중을 확정하지 않았다.

## 분리할 상품 경계

현행 WHYPE 상품의 전략을 늘리는 것과 [ADR-010](../DECISIONS.ko.md#adr-010)의 새 USDC underlying 상품을 만드는 것은 별개다. 후속 USDC 상품은 HyperEVM 입금→`CoreDepositWallet.depositFor`→Strategy Core credit→spot·HIP-3·HIP-4 거래/정산→USDC 회수의 비용·단위·슬리피지·대기 원장을 새로 정의한다. HYPE 매수/hedge는 그중 한 거래 조합이다. 이 필수 시장 범위는 [ADR-011](../DECISIONS.ko.md#adr-011)·[MARKET-001](../BACKLOG.ko.md#market-001)에서 추적하며 STRAT-001로 미루지 않는다. 기존 hcHYPE underlying을 제자리에서 바꾸지 않는다. 이 경로는 [USDC-001/002](../BACKLOG.ko.md#usdc-001)의 미완료 작업이다.

외부 lending이나 LP가 새로운 수익원을 제공하더라도 출금 지연·부채·평가·custody 신뢰가 함께 추가된다. 서로 다른 상품을 동일 가격으로 합산하기 전에 source와 회수 계약을 정의한다.

## 제안 adapter 계약

| 기능 | 입력/출력의 의미 | 제약 |
| --- | --- | --- |
| config identity | asset, custody account, markets, code/config hash | 생성 시 고정, arbitrary-call 없음 |
| allocate | allocation ID, 허용 자산량 | Vault/정해진 allocator만, 실제 수신 대조 |
| observe | NAV·품질·시점·범위·pending | estimate와 executable liquidity 구분 |
| requestLiquidity | withdrawal intent, 목표량, 제한 | 수령자는 회계 Vault로 고정 |
| advance/return | 허용된 공개 진행과 실제 반환 | request/action replay 방지 |
| emergency exit | 신규 위험 정지와 안전한 축소 | 확정 claim 자산 접근 금지 |

이는 현재 IHyperCoreStrategyAccount를 이미 교체한 ABI가 아니다. 별도 버전에서 adapter registry와 자금 원장을 설계해야 한다. proxy/실시간 strategy 교체를 묵시적으로 추가하지 않는다.

## 배분과 회수

배분 비중은 strategy별 max exposure, 검증된 health, liquidity horizon, 미확정 자금, 공통 담보/프로토콜 상관관계로 제한한다. 각 adapter의 예치 한도와 전체 cap이 모두 적용된다. 수익률 순 정렬만으로 자금을 보내지 않는다.

요청한 회수량과 실제 회수액을 별도 기록한다. 한 전략이 멈추면 다른 전략의 현금만으로 일부 주주에게 손실 전의 가격을 먼저 지급하지 않는다. NAV를 확정할 수 없는 전략이 있으면 새 가격 거래/epoch 정산을 그 정책에 맞게 제한한다.

Strategy A의 자산을 B의 부채 담보로 사용할 때는 별도 연결 관계를 원장에 넣어 중복 자산과 숨겨진 cross-risk를 방지한다. 회수 우선순위는 실제 비용·유동성·위험 조건을 반영하며 임의 beneficiary 지급은 허용하지 않는다.

## 후보 전략 검토표

각 후보는 자산·프로토콜·custody·원금/부채·수익 원천·price source·출금 제한·운영 키·upgrade 신뢰·read/write 증거·비용·실패 복구를 채워야 한다. API 또는 UI의 예치 APY만으로 adapter를 선택하지 않는다. 실제 프로토콜을 정하면 공식 문서와 현재 deployment를 새로 조사한다.

## 새 시험과 출시 조건

동일 현금 이중 배정, 한 adapter 실패/음수 NAV, 동시 exit, share 가격의 오래된 전략 혼합, strategy 사이 회수 순서, migration, 임의 token donation을 시험한다. adapter 하나의 손실이 전체 NAV와 pending 요청에 공정하게 반영되고 과거 확정 claim에 전가되지 않아야 한다.

완료 범위는 제품 목표 선정→후보 검토→독립 adapter→source/회수 실험→전체 원장 회귀→새 배포다. 이 문서만으로 STRAT-001이나 별도 USDC 상품을 완료 처리하지 않는다.
