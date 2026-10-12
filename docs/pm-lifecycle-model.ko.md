# PM 생명주기 로컬 가설 재현과 공급 진입 방어

작성일: 2026-09-23 KST. 연결: [CORE-001](BACKLOG.ko.md#core-001), [ENV-001](BACKLOG.ko.md#env-001), [AS-01/02](plans/sources.ko.md). 이 문서는 PM·bridge·공급 가설을 로컬 모델로 재현한 근거와 변경 범위의 관리 원본이다. 실행 수치·통과 여부·빌드 크기는 [STATUS](STATUS.ko.md), 작업 완료 여부는 BACKLOG, 설계 채택은 [DECISIONS](DECISIONS.ko.md)에서 관리한다.

**자동 공급을 지원하거나 실제 출금 정체를 해결한 결과가 아니다.** 테스트는 Core read 응답을 직접 바꾸며 실제 CoreWriter 처리를 실행하지 않는다. 현재 통제 가능한 프로젝트 테스트넷 환경은 확보되지 않았고, 이번 작업에서 배포·서명·주문·자금 이동·새 RPC 전후 실험은 수행하지 않았다.

## 근거의 종류

| 종류 | 확인한 내용 | 입증하지 않는 내용 |
| --- | --- | --- |
| 공식 문서 재확인 | PM의 미사용 borrowable 자산 자동 수익, cap fallback, action 인코딩, EVM/Core 처리 순서 | 해당 Strategy 계정에서 자동 공급되는 시점·양·가스 귀속·쓰기 성공 |
| 공개 계정의 정적 관측 | [기존 PM 실측](pm-nav-evidence.ko.md)에서 raw spot=0/supply>0 및 일부 lending read 실패 | PM 전환이 그 이동의 원인인지, 첫 입금·다음 cycle 전후 상태, 오류의 정확한 의미 |
| 직접 주입한 로컬 가정 | raw spot을 줄이고 lending supply를 늘리거나 read 오류를 넣었을 때 현재 코드의 분기·revert·자금 보존 | HyperCore가 실제로 그 상태를 만들거나 같은 순서로 처리한다는 사실 |

공개 원시 자료는 [reference/README](reference/README.md)에 출처가 있고 기존 JSON을 덮어쓰지 않았다. 아래 보존식은 fixture의 명시적 가정이며 생산용 NAV나 bridge receipt 검증식이 아니다.

## 공식 설명과 미확정 경계

- [PM 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin)는 미사용 borrowable 자산의 자동 수익과 cap 도달 시 non-PM 동작으로의 fallback을 설명한다. raw spot이 lending으로 이동하는 정확한 시점·금액, 후원 가스가 별도로 남는다는 보장은 설명하지 않는다. 모드가 PM이라는 사실만으로 다음 cycle의 공급·차입 가능성이 보장되지 않는다.
- [Core 연동 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)는 action 15의 Supply/Withdraw와 amount=0의 최대 적용 의미, action 16의 PM 설정 인코딩을 제공한다. PM 본문은 CoreWriter supply를 향후 기능으로 서술하는 문장을 유지한다. ABI 존재를 모든 network/account에서의 실행 성공으로 확대하지 않는다.
- [처리 순서 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings)에 따르면 EVM block 이후 EVM→Core transfer, CoreWriter 순으로 처리한다. CoreWriter caller는 그 EVM block 이전에 Core에 존재해야 하며 같은 block의 계정 초기화로 이 조건을 충족할 수 없다. EVM 전송 성공만으로 Core 도착을 확정하지 않는다.
- [Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-abstraction-state)는 `userAbstraction`을 제공한다. 현재 저장된 [L1Read ABI](reference/L1Read.sol)와 [CoreRead](../src/CoreRead.sol)에는 PM mode read 함수가 없다. HTTP 관측을 온체인 mode 증명으로 바꾸지 않으며 `confirmPortfolioMargin`의 운영자 attestation 경계를 유지한다.
- [전송 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers)는 HYPE의 native/system-address 경로와 Core→EVM의 비용을 명시한다. [계정 활성화 비용](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee.md)도 별도 존재한다. 공급 잔액과 가스 사용 가능량의 관계, 실제 callback sender·gross/net·분할 수신은 이 설명만으로 확정하지 않는다.

공식 read 설명의 invalid-input error와 공개 계정의 lending 오류를 연결해 “미초기화이면 항상 정상 0”이라고 추론하지 않는다. [기존 실측의 실패 처리](pm-nav-evidence.ko.md#실측-단위와-실패-처리)를 유지한다.

## 로컬 모델 입력과 현재 결과

구현: [PmLifecycleModel.t.sol](../test/PmLifecycleModel.t.sol). 공통 fixture는 주주 원금 100 HYPE, 후원 reserve 1 HYPE를 사용한다. Core 수량은 1e8, EVM WHYPE는 1e18 단위다. 값은 시험 입력이며 운영 기본값이 아니다.

기본 모델은 PM 요청과 attestation 후 raw spot/supply 응답을 직접 교체한다. 별도 명시가 없으면 이자·비용·hold·부채를 0으로 가정한다. 이는 다음 식을 강제로 만족시키는 입력이다.

```text
raw spot HYPE + lending supply HYPE = 101 HYPE
```

`_bridgeTarget`은 101 HYPE의 raw spot 도착을 요구한다. 아래 표는 테스트가 검사하는 코드 결과를 설명한다. 테스트 성공은 그 결과가 재현됐다는 뜻이며, 막히는 시나리오를 성공적인 PM 통합으로 바꾸지 않는다. 최종 실행 결과는 [STATUS](STATUS.ko.md)를 확인한다.

| 테스트 시나리오 | 직접 주입하는 입력 | 현재 결과와 검증 범위 |
| --- | --- | --- |
| 원금 전액 자동 공급 | spot 1 / supply 100 | `advance`가 `CoreObservationPending`으로 거부된다. bridge pending·attestation·원금 기록이 유지되고 추가 supply/short를 제출하지 않는다. |
| 원금 일부 자동 공급 | spot 76 / supply 25 | 합계가 같아도 raw spot target에 못 미쳐 진행하지 못한다. 부분 자동 공급 지원이 없음을 재현한다. |
| reserve까지 자동 공급 | spot 0 / supply 101 | gas reserve까지 raw spot에서 사라진 가정을 재현한다. 단순 spot+supply 합산으로 통과시켜도 가스 소유권·가용성은 해결되지 않는다. |
| opening deadline 이후 exit | 전액 자동 공급 모델에서 마감 도달 | 공개 caller의 `beginExit`는 수락되지만 후속 `advance`는 옛 raw target에서 막히고 `settleEpoch`는 ReturnReady가 아니어서 거부된다. |
| pause 이후 exit | 전액 자동 공급 모델에서 guardian pause | 신규 위험은 멈추고 exit 요청은 기록되지만 같은 bridge 조건 때문에 진행·정산할 수 없다. pause가 회수 성공을 보장하지 않는다. |
| 다음 cycle의 PM 재요청 전 자동 공급 | 첫 mock cycle을 반환한 뒤 두 번째 bridge 금액이 바로 supply로 이동한다고 가정 | cycle별 PM 플래그는 초기화되고, raw target 검사 때문에 PM 제출 및 `advance`가 막힌다. Core의 PM 유지 자체는 fixture에서 조회하지 않는다. |
| 초기 HYPE lending read 실패 | 기존 Core 계정에서 HYPE lending read만 revert | `startCycle` 전체가 revert한다. WHYPE·shares·cycle/epoch·allowance·bridge·writer 상태가 변경되지 않는다. 정상 zero 응답과 실패를 구별한다. |
| 초기 quote lending read 실패 | 같은 조건에서 quote lending read만 revert | 위와 같이 자금 이동 전 원자적으로 거부한다. 오류를 0 부채로 취급하지 않는다. |
| 자동 공급 후 외부 raw spot 보충 | supply 100을 유지한 채 unrelated spot 100이 추가돼 raw target 101을 다시 충족한다고 가정 | 수정 전에는 원금 전액의 explicit supply를 다시 제출할 수 있었다. 수정 후에는 아래 공급 진입 방어가 `ResidualExposure`로 차단하며 bridge pending과 action 식별자를 유지한다. Core의 추가 공급 실행 성공을 재현한 것은 아니다. |

외부 raw spot 보충 시나리오는 PM 상태에서 그 보충분이 raw spot으로 관측될 수 있는 타이밍을 추가로 가정한다. 이 입력이 실네트워크에서 가능한지 확인하지 않았다. 자동 공급 외에도 초기 clean 검사 이후 나타난 비제로 lending을 새 수동 공급의 정상 baseline으로 삼는 코드 경로를 검사하는 반례다.

다음 cycle을 준비하는 첫 왕복도 fixture가 주입한 잔액과 native 수신으로 구성한다. 이를 실제 PM 유지·Core 실행·recall 성공 원장으로 사용하지 않는다.

## 수동 공급 직전의 추가 방어

초기 `startCycle`은 clean account를 요구한다. 그러나 bridge와 PM 처리는 여러 관측 시점에 걸치므로, 최초 검사 뒤 나타난 lending 잔액을 `_supplyBefore`로 받아 원금 전액을 추가 공급하는 것은 현재 수동 공급 모델의 전제와 맞지 않는다.

이번 [Strategy 변경](../src/HyperCoreStrategyAccount.sol)은 `_observeBridgeAndSupply`에서 다음 순서를 따른다.

1. 기존 raw spot bridge target을 확인한다.
2. HYPE lending을 성공적으로 읽는다. 오류는 그대로 전파한다.
3. `supply.value != 0 || borrow.value != 0`이면 `ResidualExposure`로 거부한다.
4. 위 조건을 통과한 경우에만 bridge target을 지우고 기존 explicit supply를 제출한다.

즉, 이미 보이는 공급·차입을 자동으로 주주 담보로 인정하지 않는다. 비제로 상태의 원인이 자동 공급인지 외부 자금인지 이 가드가 판단하는 것도 아니다. 성공한 zero read를 요구함으로써 현재 수동 공급 경로가 감당하지 못하는 상태에서 추가 금융 action을 만들지 않는다.

[CollateralAdmission.t.sol](../test/CollateralAdmission.t.sol)은 다음을 검사한다.

| 회귀 | 입력과 기대값 |
| --- | --- |
| 공급만/차입만 존재 | supply-only와 borrow-only 각각에서 추가 공급을 거부하고, 정상 zero read로 교체했을 때 기존 경로가 유지되는지 검사한다. |
| 변경된 lending의 공급 차단 fuzz | HYPE supply/borrow 중 하나 이상이 비제로이면 `ResidualExposure`. phase·bridge pending·writer action 수·다음 action 식별자에 부수효과가 없어야 한다. |
| zero read 경로 유지 | 위 모델 상태를 새 Core block의 정상 zero 응답으로 명시적으로 교체하면 기존 정확 수량의 explicit supply 제출 경로가 열린다. 이 교체는 테스트 입력이며 실제 원장을 초기화하는 운영 복구 절차가 아니다. |
| 공급 직전 lending read 실패 | raw target과 PM attestation이 있어도 read가 실패하면 `CoreRead.ReadFailed`. zero fallback이나 supply 제출이 없어야 한다. |

수정 전 반례와 수정 후 회귀의 실행 기록은 [STATUS](STATUS.ko.md)에 둔다. ABI·storage 변경 여부와 배포 영향은 [현행 구현 명세](split-implementation.ko.md) 및 [CHANGELOG](../CHANGELOG.md)가 관리한다.

## 이 변경으로 해결하지 않은 것

- raw spot target을 충족하지 못하는 전액/부분 자동 공급·reserve 자동 공급 및 다음 cycle의 정체는 그대로다. 자동 공급을 지원하는 분기나 부족분 공급 로직을 추가하지 않았다.
- PM 성공 readback, action receipt/finality, reject/zero-fill 복구를 만들지 않았다. attestation 및 계정 효과의 신뢰 경계가 유지된다.
- 이 가드는 **제출 전 상태를 제한하는 검사**다. 제출 후 `CoreActionObserver`의 supply 증가·spot 감소 paired effect를 보강하거나 외부 변화와 action 효과를 구별하는 보편적 해결책이 아니다.
- `spot+supply` 합계만으로 bridge 귀속을 증명하지 않고, 이자·외부 송금·기존 잔액을 새 원금으로 인정하지 않는다. 가스 몫을 공급 원금으로 재분류하지 않는다.
- pause/마감 후 PM이 늦게 적용되는 경우, 실제 가스 소모와 top-up, recall 비용·순수령액·잔여 dust, 최종 claim 가능성을 해결하지 않았다.
- lending 조회 실패를 0으로 바꾸지 않는다. 신규 계정의 정상 초기화 절차와 unknown/error 구별은 실제 환경에서 추가 확인해야 한다.

따라서 [CORE-001](BACKLOG.ko.md#core-001)의 로컬 근거가 늘고 한 제출 경계가 보수적으로 제한됐다는 범위로 판단한다. 전체 통합 완료나 운용 준비 완료로 표시하지 않는다.

## 다음 통제 실험의 순서와 완료 증거

실행 전 [ENV-001](BACKLOG.ko.md#env-001)의 프로젝트 소유 시험 계정·chainId/RPC·실제 배포 주소·역할·시장 metadata·자금/가스·실행 방식을 확보해야 한다. 공개 관측 주소는 프로젝트 소유 계정이 아니다. 현재 배포 스크립트의 로컬 제한을 제거하는 것만으로 환경 검증을 대신하지 않는다.

기록 형식은 실제 존재하는 [실험 기록 템플릿](plans/templates/experiment-record.example.json)을 사용한다. 비밀키·서명 비밀은 넣지 않는다. 원시 read는 각 시점의 명시 EVM block에 고정하고 hash를 재확인하며 HTTP는 별도 observedAt과 `blockPinned=false`로 보관한다. 실패와 모르는 결과도 새 기록으로 남긴다.

| 순서 | 연결 실험 | 관측할 것과 다음 단계의 조건 |
| --- | --- | --- |
| 1 | [EX-01 초기 계정](plans/validation.ko.md#ex-01) | 신규→activation→후원 단계의 userExists·spot·lending·read 오류·실제 비용을 각각 기록한다. 계정 존재와 정상 zero ABI/absent/error의 구분 없이 `startCycle` 검사를 완화하지 않는다. |
| 2 | [EX-02 첫 bridge/PM](plans/validation.ko.md#ex-02) | 후원금 baseline과 주주 원금을 분리하고 bridge→PM intent→후속 block별 spot/supply/hold/debt/mode를 관측한다. 자동/부분/미공급, reserve 이동, cap fallback, 마감·pause 중 늦은 적용을 구별한다. |
| 3 | [EX-02 다음 cycle](plans/validation.ko.md#ex-02) | 기존 PM 계정의 새 principal bridge를 별도로 관측한다. 첫 cycle 전이를 반복한다고 가정하지 않고 모드 유지·입금 귀속·가스 잔액을 다시 대조한다. |
| 4 | [EX-03 explicit supply/withdraw](plans/validation.ko.md#ex-03) | 지원을 확인한 환경에서 작은 정확 단위로 action 15의 실제 처리와 source/destination 변화, cap·hold·가용 유동성을 확인한다. 이미 공급된 금액을 다시 제출하지 않는다. |
| 5 | [EX-07 가스 원장](plans/validation.ko.md#ex-07) | 초기 후원·실제 소모·보충·종료 잔여를 자산/소유자별로 분리한다. 공급 계정 잔액과 transfer 비용의 관계를 확인하며 첫 단계부터 비용 관측을 함께 수집한다. |
| 6 | [EX-06 recall/지급](plans/validation.ko.md#ex-06) | Core 차감→sender/gross/net/native 수신→wrap→Vault 반환→최종 사용자 claim을 대조한다. ReturnReady나 EVM receipt만으로 성공을 판정하지 않는다. |

각 결과의 `PASS_IN_MODEL`과 `PASS_OBSERVED`를 구분한다. 실제 전환 원장·지원 조건·자금 귀속이 확보된 뒤 [생명주기 기획](plans/core-lifecycle.ko.md)의 자동/수동/부분 공급 분기를 선택하고, Observer·NAV·가스·회수 모델을 함께 맞춘다.
