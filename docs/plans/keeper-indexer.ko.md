# Keeper·indexer·관측 서비스 기획

상태: PROPOSED · 2026-09-21. 연결: OPS-001, REQ-04/13/14/18. keeper는 실행 촉진자이며 NAV·권한의 원천이 아니다.

## 서비스 구성

| 모듈 | 책임 | 권한 |
| --- | --- | --- |
| EVM/Core collector | 특정 블록 read, tx/log, HTTP 진단, 오류 보존 | 읽기 전용 |
| reconciler | cycle/action/receipt/잔액의 대조 | 읽기 전용; 성공 판정을 계약에 주입하지 않음 |
| scheduler | 허용된 다음 함수 선택과 실행 비용 관리 | permissionless 함수만 호출하는 EVM 지갑 |
| role executor | manager/bootstrap/guardian 동작 | 별도 역할 지갑과 운영 절차 |
| indexer/API | 사용자 요청·claim·단계·근거 제공 | 서명/자금 접근 없음 |
| alerting | 지연·불일치·가스/health 경보 | 알림만, 자동 권한 확장 없음 |

API wallet을 발급하는 모듈은 없다. 관리자 서명과 keeper nonce를 공유하지 않는다. 서비스가 꺼져도 다른 caller가 같은 공개 함수를 실행할 수 있어야 한다.

## 실행 루프

1. manifest의 chain/address/ABI/configHash를 확인한다.
2. EVM block과 상태를 읽고 reorg 여부를 확인한다. Core snapshot과 HTTP 진단의 provenance를 별도 저장한다.
3. 이미 처리한 상태인지 `chainId/strategy/cycleId/actionId/phase`로 판별한다. local lease는 중복 비용 방지용이며 온체인 권한이 아니다.
4. pending 효과가 있으면 `syncPendingAction`을 우선 검토한다. 새 거래를 먼저 보내지 않는다.
5. 현재 공개 predicate에 맞는 advance/beginExit/recap/settle을 시뮬레이션하고 보낸다. 실패하면 최신 상태를 다시 읽는다.
6. EVM tx receipt와 Core 후속 효과를 각각 확인한다. EVM mined를 Core filled로 표시하지 않는다.

같은 EVM tx의 fee replacement는 같은 경제 호출/nonce를 유지한다. 새 nonce로 action을 다시 만드는 복구는 별도 finality 조건이 필요하다. 여러 keeper의 경쟁은 계약의 상태 재검사로 한 호출만 유효해야 한다.

## 데이터 모델 제안

| 엔터티 | 키·필드 |
| --- | --- |
| Deployment | chainId, addresses, ABI version/hash, config hash, code hashes, manifest version |
| EvmBlock | number/hash/parentHash/time, confirmations, canonical 여부 |
| Cycle | Vault/Strategy cycleId, phase, deadlines, allocated/recap/returned |
| Action | chain/Strategy/cycle/actionId, cloid/hash/kind, submitted block/tx, status provenance |
| Observation | EVM/Core block, read set, raw/error hash, HTTP observedAt, evidence kind |
| RedeemRequest | Vault/requestId/controller, requested/consumed shares, paid assets, settled rate |
| Transaction | sender/nonce/calldata hash/tx hash, replacedBy, EVM receipt |
| Alert | stable reason code, first/last seen, affected cycle, changed evidence, acknowledged |

uint/int 금액은 decimal string으로 보관한다. JS Number/float를 원장 계산에 사용하지 않는다. 화면용 소수와 원장 정수를 분리한다. 재색인 시 이벤트와 현재 storage를 대조한다.

## reorg와 장애

EVM block hash가 바뀌면 해당 log 기반 materialized view를 rollback하고 canonical chain에서 replay한다. Core를 EVM처럼 직접 rollback한다고 가정하지 않고 새 관측으로 대조한다. 이미 전송한 action intent는 local row 삭제만으로 재전송하지 않는다.

RPC timeout·429·ABI 실패·잔액 불일치·unknown order를 구별한다. bounded backoff와 circuit breaker를 적용하고 endpoint 교체 시 chainId/block hash를 다시 검증한다. source 오류가 계속돼도 확정 claim용 EVM 읽기/사용자 호출 경로는 독립적으로 제공한다.

## 관측과 경보

측정: oldest pending age, 마지막 성공 read의 Core/EVM block, 원장 차이, gas 잔고, 확정 준비금/현금, epoch 처리 단계, API/indexer lag, nonce queue, revert reason. threshold는 [파라미터 기획](risk-parameters.ko.md)에서 정한다.

동일 원인 반복은 묶고 상태 변화·복구·새 위험에 알린다. 경보가 human action을 요구하면 필요한 역할과 안전하게 가능한 함수를 표시한다. “pending 삭제” 같은 존재하지 않는 해결 버튼을 만들지 않는다.

## 구현 순서와 수용 기준

먼저 read-only indexer·replay, 다음 dry-run planner, 마지막 testnet scheduler를 구현한다. 재시작, duplicate delivery, 두 keeper 경쟁, RPC disagreement, reorg, tx replacement, core delay를 시험한다. keeper DB를 잃어도 온체인 상태에서 재구성 가능해야 한다. 보상 토큰·유저 잔액에서의 자동 gas 차감은 이번 범위에 없다.
