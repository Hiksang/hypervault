# Core 액션 복구와 recall 변경 기획

상태: CONDITIONAL · 2026-09-21. 연결: CORE-002/003, REQ-04/05. 현재 효과 판정은 [관측 명세](../core-action-recovery.ko.md)가 관리한다.

## 목표와 불가능 경계

실행 의도와 실제 실행 결과를 연결하고 늦은 실행·부분 체결·재호출에서 경제적 효과를 두 번 만들지 않는 것이 목표다. 현재 자료만으로 모든 action의 확정 실패를 온체인 증명할 수 있다고 가정하지 않는다. 외부 신뢰 없이 실패를 확인할 방법이 없다면 **안전한 자동 재시도와 모든 경우의 출금 진행을 동시에 보장할 수 없다.**

## 후보 신뢰 모델

| 모델 | 제공하는 보장 | 제한 | 제안 상태 |
| --- | --- | --- | --- |
| 현행 계정 효과 관측 | 계약이 raw 상태를 읽고 조건 확인 | 특정 action 귀속·무체결 최종성 부족 | 유지 기준선 |
| 프로토콜 검증 가능한 receipt | account/action/결과/종결을 결합 | 제공 여부·authenticity·범위 미확인 | 존재 시 우선 검토 |
| 서명 quorum attestation | 운영 정책에 따라 결과 입력 가능 | 오판·담합·키 분실·검열 신뢰 추가 | OPEN-04 별도 채택 전 미도입 |
| 시간만 지난 자동 초기화 | 구현 쉬움 | 늦은 실행과 중복 위험 | 채택하지 않음 |

quorum을 고르면 단순 HTTP relay로 포장하지 않는다. 서명 도메인에 chainId/Strategy/cycle/action/payload/outcome/잔여 실행 가능성/관측 block/expiry를 묶고 replay 방지·권한 교체·challenge 및 실패 정책을 다시 설계해야 한다. 이 문서는 해당 권한을 승인하거나 구현하지 않는다.

## 제안 실행 기록

기존 pending 필드는 유지하고 필요한 경우 다음 결과 기록을 확장한다: `intentId`, `attemptId`, `actionHash`, `requested`, `observedEffect`, `finalityKind`, `finalizedBlock`, `receiptHash`. 하나의 경제적 의도에 여러 시도가 있더라도 새 시도는 이전 시도의 잔여 실행 가능성을 배제한 뒤만 만든다. actionId는 재사용하지 않는다.

| 결과 분류 | 다음 행동 |
| --- | --- |
| Unknown / read 실패 | pending 유지, 진단·위험 중단; 재제출 금지 |
| 효과 일부, finality 불명 | 관측 보존; 그 효과가 충분한지는 채택한 모델에 따라 판단 |
| 확정 부분 실행 + 잔여 취소 입증 | 실제 잔여 경제 수량을 새 cloid로 실행 |
| 확정 무체결/거절 | 현 상태·가격·health·deadline을 다시 검사하고 새 시도 가능 |
| 확정 성공 | ack 한 번 소비; 다음 실행과 분리하여 commit |
| 상충/예상 초과/청산 의심 | 신규 위험 중단, 전체 계정 대조; 자동 성공/실패로 축약 금지 |

취소 action 자체도 지연되거나 실패할 수 있다. cancel 전송 성공을 원 주문의 잔여 실행 배제 증거로 사용하지 않는다. 액션별 증명 범위가 다르면 lending/recall/PM을 주문 receipt로 처리하지 않는다.

## recall 순수령액 원장

현재 `hypeSystem` 발신자 누적 수신과 gross 전체 금액을 요구한다. [EX-06](validation.ko.md#ex-06)에서 실제 sender·수수료·분할/지연을 확인한 뒤 다음 중 하나를 선택한다.

1. protocol receipt가 amount/fee/net을 인증하면 그 net을 해당 intent에 귀속한다.
2. 공식적이고 검증 가능한 fee 규칙과 고유 수신 귀속이 있으면 예상 net과 실제 수신을 대조한다.
3. sender만 같고 해당 intent 귀속/완료를 증명할 수 없으면 누적액의 임의 허용 오차로 성공 처리하지 않는다.

제안 원장: `grossCoreDebit`, `verifiedFee`, `recognizedNet`, `wrappedNet`, `returnedToVault`, `unattributedReceipt`. 같은 gas 후원·직접 송금·다른 cycle 수신은 recall 결과에 합산하지 않는다. 부분 net이 확인돼도 최종 지급액이 확정되지 않았으면 완료로 만들지 않는다.

wrap과 receipt 소비는 별도 단계를 유지한다. 실제 반환액은 Vault의 WHYPE 증가량과 일치해야 한다. net 차이는 증명된 비용/손실 항목으로 귀속하고 채무나 pending을 숨기는 수치 조정으로 쓰지 않는다.

## 구현·검증 산출물

영향: PendingAction/Observer.Context ABI, receipt ledger, receive/wrap, Strategy terminal 조건, Vault 반환 검증. keeper/indexer는 추가 상태를 지원해야 한다. `syncPendingAction`의 독립 commit과 기존 고정 수령자는 유지한다.

필수 시험: 지연 성공 뒤 재시도, cancel 후 늦은 fill, 부분 fill와 가격 실패, force-send, 동일 sender의 외부 수신, net fee, 부분 수신, duplicate ack, old-cycle receipt, 청산이 close와 같은 방향으로 보이는 경우. 모든 모델에서 Unknown을 0체결로 만들지 않는 회귀를 포함한다.
