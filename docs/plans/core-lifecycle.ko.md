# PM·bridge·운용 생명주기 변경 기획

상태: CONDITIONAL · 2026-09-21. 연결: CORE-001, ENV-001, REQ-02/03. 실제 ABI는 [구현 명세](../split-implementation.ko.md), raw 근거는 [PM 실측](../pm-nav-evidence.ko.md)다.

2026-09-23 로컬 진행: [모형 재현](../pm-lifecycle-model.ko.md)과 [ADR-009](../DECISIONS.ko.md#adr-009)의 초기 lending 검사를 구현했다. 아래 자동 공급 분기·관측 기록은 여전히 조건부 제안이며 현재 코드가 지원하는 경로가 아니다.

## 해결할 문제와 구현 경계

현재 bridge target을 raw spot으로 반복 확인한 뒤 수동 supply한다. PM 적용으로 자금이 다른 잔액 항목으로 이동할 수 있다면 이 조건이 완료를 인식하지 못한다. 반대로 spot+supply 합계만 보고 bridge 성공으로 간주하면 기존 잔액·이자·외부 송금을 새 bridge로 오인할 수 있다.

운용 Phase와 별도로 **bridge 완료, PM 상태, 담보 준비**의 관측 기록을 구분하는 안을 제안한다. 기존 enum 번호를 재배열하지 않는다. 새로운 필드/관측 인터페이스가 필요하면 새 배포 ABI로 명시한다.

## 제안 관측 모델

| 기록 | 필요한 정보 | 금지하는 추론 |
| --- | --- | --- |
| AccountBaseline | chain/account/config/cycle, 자산 범위, Core block, raw 잔액·position·부채, read 상태 | absent/error를 정상 0으로 바꿈 |
| BridgeIntent | 의도 ID, 보낸 EVM 금액, 정확한 Core 단위, 기준 관측, 제출 tx | EVM 송금 성공=Core 도착 |
| BridgeObservation | bridge와 연계된 새 관측, 귀속 가능한 증가량, 검증 방식 | cycle 전체 잔액을 새 입금액으로 인정 |
| PMObservation | 제출 여부, 적용 증거/attestation 종류, 시각·block, 운용 가능 범위 | attestation을 trustless mode read로 표시 |
| CollateralObservation | raw spot·공급·hold·부채·가스 귀속과 미확정 이동 | 공급 잔액이 있다는 이유로 새 supply 성공 판정 |

이 레코드는 설계 데이터다. 현재 Core가 모든 필드를 제공한다는 주장이 아니다. production에서 증명할 수 없는 필드는 명시적으로 Unavailable이며 그에 의존하는 신규 위험을 열지 않는다.

## 상태 전이 조건

| 단계 | 진입/진행 조건 | 수행 | 실패·지연 처리 |
| --- | --- | --- | --- |
| 초기화 | 계정 존재, 시장/단위 일치, 기존 노출 확인 | 초기 gas와 baseline 구분 | read 부재를 원인별 분류, 확인 전 배정 차단 |
| bridge 제출 | Idle, 한도, 미예약 현금, cycle 생성 | unwrap/정확 단위 전송 | 전송 전 실패는 revert; 제출 후에는 관측 대기 |
| bridge 확정 | 새 Core 관측 및 귀속 근거 | bridge 기록 한 번 소비 | 시간 경과로 완료 처리하지 않음 |
| PM 적용 | bridge 확인 또는 이미 검증된 PM baseline | 필요한 경우만 action 제출/확인 | 확인 전 short·추가 supply 금지 |
| 담보 준비 | PM 규칙과 잔액 이동의 증거 확보 | 아래 세 분기 | 불일치면 신규 위험 중단 |
| hedge 개설 | 담보·health·가격·lot·deadline 모두 적합 | 잔량만 IOC short | 부분 효과는 귀속/finality 조건 확인 후 진행 |
| Active | 목표 hedge 범위, pending 없음 | 상태·위험 관측 | 마감/pause/위험 조건이면 회수 |
| 회수 | 기존 pending의 처리 상태 확보 | close→상환→회수→quote 정리→recall | 미확정 실행을 새 회수로 덮어쓰지 않음 |
| 반환 | debt/position/잔여 귀속·inflight 정리 | 실제 WHYPE를 Vault에 전달 | 부채·잔여가 불명확하면 settle 금지 |

PM 완료 전 deadline이 지나도 이미 이동한 자산은 회수 대상이다. 다만 PM 적용 자체가 미확정이면 늦은 적용이 회수에 미치는 효과를 확인해야 하며, 현재 mock의 pre-PM 회수 통과를 이 문제의 해결로 확대하지 않는다.

## 자동 공급 분기

| 실험 결과 | 구현할 경로 | 필요한 증거 |
| --- | --- | --- |
| 전액 자동 공급 | explicit supply 생략, 확인된 경제적 담보만 hedge 기준으로 사용 | 전환 전후 원장과 계정/자산 귀속 |
| 자동 공급 없음 | 가용 raw spot 중 필요한 양만 explicit supply | 제출 전후 paired effect와 실제 기능 지원 |
| 일부 공급/cap fallback | 검증된 부족분만 처리하거나 신규 위험 중단 | cap·hold·가용량과 위험 조건 |
| 읽기 불가/귀속 모호 | 대기·진단, 신규 공급/short 차단 | 실패/부재 의미 및 안전한 복구 근거 |

첫 거래 이후 PM 모드가 계속 유지되는 경우에도 매 cycle baseline과 지원 조건을 확인한다. 모드 유지와 공급 가능성을 동일시하지 않는다. 사용자/제3자의 unsolicited transfer가 계정 청결 검사와 경제적 소유권에 미치는 영향도 정의한다.

## 불변조건과 코드 영향

- 한 cycle의 principal과 recap bridge를 별도 intent로 구분하고 각각 한 번만 인정한다.
- 담보/hedge 수량은 주주 귀속량을 기준으로 한다. 후원 gas를 투자 원금으로 바꾸지 않는다.
- pause/shutdown은 신규 위험을 막고 이미 확정한 지급을 유지한다. 아직 결과를 모르는 쓰기를 삭제하지 않는다.
- raw szi 정규화와 bounded read를 유지한다. float와 임의 공통 decimals를 사용하지 않는다.

주요 변경 대상: [Strategy](../../src/HyperCoreStrategyAccount.sol), [RiskOracle](../../src/HyperCoreRiskOracle.sol), [Observer](../../src/CoreActionObserver.sol), 관련 interfaces와 mock. 공급 전후 자동 이동이 입증되면 observer의 단순 spot debit 조건도 같은 의미로 바꿔야 한다. 전체 자금 소유권/실행 귀속이 없는 부분 수정은 하지 않는다.

완료 증거는 [EX-01~03](validation.ko.md#ex-01)의 raw 자료, 선택한 분기 결정, 정상/지연/pause/다음 cycle의 회귀 및 전량 왕복이다. 이 계획만으로 CORE-001을 완료 처리하지 않는다.
