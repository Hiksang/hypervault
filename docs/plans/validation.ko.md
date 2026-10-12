# 테스트와 통제된 실측 기획

상태: PROPOSED · 2026-09-21. 연결: QA-001, ENV-001 및 전체 REQ. **아래 시험을 이번 문서 작업에서 실행하지 않았다.** 기존 결과는 [STATUS](../STATUS.ko.md)에만 기록한다.

## 검증 단계와 산출물

| 단계 | 확인하는 것 | 확인하지 못하는 것 | 기록 |
| --- | --- | --- | --- |
| 정적/수학 검토 | 권한, 단위, 회계, ABI, 범위 | 실제 Core 실행 | 코드/명세 위치, 반례 |
| 단위/fuzz/invariant | 명시한 모델 안의 보존·경계 | mock 가정의 현실성 | seed·입력·명령·결과 |
| 저장 스냅샷 대조 | 실제 비제로 필드 단위·후보식 | 통제된 인과관계·현재 시점 지원 | 원시 파일/hash·범위·차이 |
| fork | 실제 read/코드와 EVM 상호작용 | Core 비동기 쓰기 처리 전체 | RPC/chain/block/hash·제약 |
| 통제된 testnet | 특정 계정/시점의 의도→실행→잔액 변화 | 다른 네트워크의 동일 조건 | tx/action/전후 원장 |
| 제한된 출시 검증 | 실제 배포 설정과 작은 운영 경로 | 모든 극단 상황·미래 수익 | manifest·승인된 범위·후속 보고 |

## 요구사항별 시험 행렬

| REQ | 필요한 시험 | 기존 자산/새 작업 |
| --- | --- | --- |
| 01 | 같은 quote 가치에서 HYPE 가격 변화, 수익 표시 통화 | PortfolioNav 테스트 + UI 시험 |
| 02 | Core caller=Strategy, onlyVault, immutable 연결 | Strategy/Factory 회귀 |
| 03 | PM 전후 spot/supply 이동·read 부재·다음 cycle | 신규 EX-01~03 |
| 04 | unknown/late/partial/reject/cancel·외부 효과 | Observer 회귀 + EX-04 |
| 05 | gross/net·sender·force-send·중복 수신 | 기존 recall 회귀 + EX-06 |
| 06 | 필드별 비제로·다중 DEX·중복/누락·negative | PortfolioNav/raw reader + EX-05 |
| 07 | price age·block 변경·HTTP 불일치·ABI 실패 | 현재 reader 회귀 + source/입금 신규 |
| 08 | 손익 후 입금·donation·같은 블록 경쟁·zero NAV | Active 입금 신규 |
| 09 | 청구 순서 permutation·자금 부족/초과·공통 환율 | epoch 회귀 + partial exit 신규 |
| 10 | 기존 claim+재투자+recap+수수료 | Vault invariant 확장 |
| 11 | gas 소모/top-up·dust 소유·cycle 이월 | EX-07/08 + 회계 신규 |
| 12 | 가격 gap·cap fallback·liquidation·buffer delta | 스트레스 모델 + 제한된 실측 |
| 13 | keeper 중단·두 caller 경쟁·고정 수령·pause | 기존 adapter + 운영 E2E |
| 14 | indexer 지연·잘못된 controller·평가 불가 화면 | frontend/indexer E2E 신규 |
| 15 | 표준 조문별 동작·인터페이스·오류 | STD-001 검토표 |
| 16 | 잘못된 chain/config·코드 hash·배포 크기 | Factory/script 회귀 + manifest 검증 |
| 17 | 새 배포 자발적 이전·기존 권리 유지 | 확장/이전 신규 |
| 18 | raw/mock/실험 타입, 누락 evidence가 완료를 막음 | 문서·report schema 검증 |

## 실험 공통 절차

대상은 프로젝트가 통제하는 별도 시험 계정이다. 한 실험에는 하나의 경제적 변경만 가하고 동시 주문·외부 자산 이동을 기록한다. action intent·EVM tx·Core 관측을 분리한다. 전후 precompile은 각 관측 시점의 명시 EVM block으로 고정하고 hash를 재확인한다. HTTP는 별도 관측 시각으로 저장한다.

원장은 `before + 외부유입 - 외부유출 + 검증된손익 - 비용 = after`를 자산/부채/소유자별로 대조한다. snapshot 숫자 변화만으로 손익이나 action 귀속을 발명하지 않는다. fail/read 오류/불명 결과도 저장하며 재시도 실험으로 덮어쓰지 않는다. [실험 템플릿](templates/experiment-record.example.json)을 사용한다.

<a id="ex-01"></a>
## EX-01 — 초기 계정과 lending 상태

userExists, raw spot, lending, position, margin, abstraction 관측 가능성을 신규/활성화/초기 후원 단계에서 비교한다. API 누락과 PrecompileError를 보존한다. 정상 zero의 ABI와 absent/error를 구별할 근거가 생겨야 초기 clean 검사를 설계할 수 있다.

<a id="ex-02"></a>
## EX-02 — bridge와 PM 전환

동일 계정의 초기 후원/주주 자금 분리→bridge 관측→PM 요청→각 후속 block의 spot/supply/hold/debt/mode를 기록한다. PM 이미 활성화된 다음 cycle도 별도로 관측한다. 자동 공급 여부·시점·cap fallback·지연 중 회수 결과를 비교한다. PM 성공이라고 알려진 HTTP 값과 온체인 확인 가능한 상태를 구분한다.

<a id="ex-03"></a>
## EX-03 — explicit supply/withdraw 지원과 효과

기능을 지원하는 통제된 환경에서 작은 정확 단위로 공급/회수를 수행한다. action 15 인코딩, 0의 max 의미, user/global cap, 가용 유동성, source/destination 잔액 변화를 확인한다. 이미 자동 공급된 금액에 재공급하지 않는다. 지원 불명/실패 결과도 명시한다.

<a id="ex-04"></a>
## EX-04 — 주문 실행과 실패 finality

정상 IOC, 부분 실행, 무체결, 늦은 실행, 취소 경쟁을 분리한다. cloid/oid·EVM/HTTP/raw position을 대조한다. protocol이 특정 실패 상황을 시험용으로 만들 수 없으면 mock으로만 다루고 실제 실험이라고 쓰지 않는다. 청산/외부 효과와 주문 효과 구별 근거를 수집한다.

<a id="ex-05"></a>
## EX-05 — 평가 원장

공급 이자, short, funding 경계, quote debt와 상환, 다중 DEX 또는 범위 밖 자산을 갖는 허용 시험에서 raw→정규화→NAV→API 대조를 기록한다. precompile 일관성과 가격 최신성을 따로 평가한다. 잘못된 금액을 0·임의 부호 변경으로 API에 맞추지 않는다.

<a id="ex-06"></a>
## EX-06 — recall과 실제 지급

Core 차감·비용·sender·native 수신·wrap·Vault 반환·epoch claim을 시간 순으로 대조한다. fee 유무·부분 수신·강제 송금 모델은 구분한다. 마지막 사용자의 실제 자산 증가까지 확인하며 ReturnReady 이벤트만으로 완료하지 않는다.

<a id="ex-07"></a>
## EX-07 — 가스 후원·소모

초기 후원, 운용 중 부족, 추가 후원, 종료 후 잔여를 원장에 분리한다. 실제 gas 소모를 다른 자산 감소와 구별할 수 있는지 확인한다. 공개 타인 계정을 gas 실험 대상이나 후원 대상으로 사용하지 않는다.

<a id="ex-08"></a>
## EX-08 — dust·전손·위험 회수

sub-lot quote, 최소 회수 금액, 부채 잔여, 읽기 장애, 제한된 recap을 시험한다. 청산/극단 손실은 우선 로컬 모델로 실행하고 실네트워크에서 고의 위험을 확대하는 실험으로 자동 전환하지 않는다. 권리 보존과 종료 불가능 조건까지 기록한다.

## 완료 판정

각 시험은 `NOT_RUN`, `PASS_IN_MODEL`, `PASS_OBSERVED`, `FAIL`, `INCONCLUSIVE` 중 하나와 evidence URI/hash를 가진다. PASS_OBSERVED는 network/account/시점 범위 안의 관측이며 전체 production 인증이 아니다. 버그 발견 시 반례와 raw를 먼저 보존하고 수정 후 의미 있는 회귀를 추가한다.

전체 코드 변경의 검증 명령은 [HANDOVER](../../HANDOVER.ko.md)를 따른다. 본 계획 작성에서는 새 계약 테스트를 실행하지 않는다. BACKLOG 완료는 해당 항목의 실측 조건까지 충족했을 때만 기록한다.
