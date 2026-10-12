# Vault / StrategyAccount 구현 명세

최초 작성: 2026-09-20 KST. 최종 갱신: 2026-09-23 KST. 이 문서는 현행 계약의 ABI·회계·권한·호출 절차를 관리한다. 구현/검증 현황은 [STATUS](STATUS.ko.md), 미완료 작업은 [BACKLOG](BACKLOG.ko.md), 설계 결정은 [DECISIONS](DECISIONS.ko.md)를 따른다. [변경 기획서](contract-change-spec.ko.md)는 구현 전 이력 자료다.

프로젝트 전체의 구성·신뢰 경계·배포 단계는 [Vault 아키텍처 기준선](vault-architecture.ko.md)에 정리했다. 이 문서의 현행 ABI를 후속 제안으로 바꾸지는 않는다.

2026-10-02 [ADR-010](DECISIONS.ko.md#adr-010)의 후속 목표는 HyperEVM USDC 기반 새 배포 쌍이다. **아래 ABI·WHYPE 18자리·hcHYPE 21자리·HypeRouter·Strategy bridge 경로는 WHYPE 코드 설명**이며 USDC 계약에 그대로 적용되지 않는다. 새 [USDC ERC7540 Vault의 구현 범위](usdc-vault-implementation.ko.md)는 별도 명세에 있다. [USDC-001/002](BACKLOG.ko.md#usdc-001)의 Strategy·실측 조건은 미완료다.

[표준 검토](standards-review.ko.md)에서 주요 ERC7540 흐름을 확인했지만 완전 준수 판정은 아니다. 발견한 `maxDeposit`의 zero-share 한도 불일치와 Vault가 포함된 0 share 전송 거부는 수정했다. 양수 직접 share 전송 제한은 유지한다. OZ 기반과 자체 구현 부분, 반례·수정·검토 범위는 해당 보고서가 관리한다.

후속으로 [Core 액션 관측·복구 기준](core-action-recovery.ko.md)을 구현했다. 새로운 `CoreActionObserver`, 액션 식별 정보, 독립적인 `syncPendingAction()`과 읽기 전용 API 진단을 포함한다. 거절/zero-fill의 신뢰 없는 자동 재시도는 아직 지원하지 않는다.

## 구현된 계약

2026-09-21 [공개 PM 실측](pm-nav-evidence.ko.md)으로 확인한 수량 단위 오류를 수정했다. Strategy와 액션 observer는 RiskOracle.positionSize를 통해 raw size lots를 CoreWriter 1e8 단위로 변환한다. RiskOracle 인터페이스 및 ActionObserver.Context ABI가 변경됐다. PM 전환 후 자동 공급 / raw spot 변화와 lending 상태 부재 시 precompile 실패는 추가 통합 검증 조건이다.

[NAV·유동성 확장 구조](nav-liquidity-architecture.ko.md)를 채택했다. 이번에는 선택 가능한 정규화 NAV reader와 계산 모듈, cycle/freshness 검증을 구현했다. 기본 배포는 원금 추정 reader를 유지한다. 생산용 PM 대차대조표 source, 운용 중 입금, 출금 buffer·부분 회수는 후속 단계다. Observation ABI 끝에 cycleId가 추가됐으므로 Vault와 reader를 함께 재빌드해야 한다.

| 계약 | 역할 |
|---|---|
| `AsyncHypeVault` | OpenZeppelin 5.4.0 ERC4626/ERC20, 역할, 배정, epoch 정산 |
| `EpochRedeem` | ERC7540 operator·request·claim, 지분 escrow, 부분 수령·반올림 |
| `HyperCoreStrategyAccount` | 자신의 Core 계정에서 bridge·PM 제출·supply·short·unwind·recall |
| `CoreActionObserver` | 계정 효과를 양방향·수량·방향 조건으로 분류; 액션별 receipt 증명은 아님 |
| `HyperCoreNavReader` | 실현 잔액 또는 명시적으로 구분한 투입 원금 추정값 |
| `HypeRouter` | native HYPE 입금/수령, 최소 수령량·기한 검사 |
| `FixedReceiverController` | 누구나 실행할 수 있는 고정 beneficiary WHYPE 지급 |
| `VaultFactory` | Vault 배포 → Strategy 배포 → 일회성 연결을 한 트랜잭션으로 수행 |
| `VaultDeployer`, `StrategyDeployer` | 생성 코드를 분리하여 Factory 크기 제한을 충족 |
| `CreationCodeChunk` 2개 | Strategy 생성 코드를 나누어 보관하는 STOP-prefixed 불변 계약; 경제적 권한 없음 |

기존 `HyperCoreVault`와 테스트는 legacy 회귀 비교용으로 남겨 두었다. 새 배포 스크립트는 그 계약을 사용하지 않는다. 새 구조는 proxy가 아니며 Vault/Strategy 교체 함수가 없다. Factory에도 자금 운용 역할은 없다.

## 계정과 권한

Core 계정 주소는 **StrategyAccount의 EVM 주소**다. CoreWriter의 caller와 모든 계정 read가 이 주소를 사용한다. Vault는 CoreWriter를 호출하지 않는다. API wallet은 발급·등록하지 않는다.

- `MANAGER_ROLE`: Idle에서 `startCycle(assets)`만 실행한다. 자산·시장·수령자·주문 가격을 변경하지 못한다.
- `BOOTSTRAP_ROLE`: 해당 cycle에서 제출한 PM 요청을 외부 확인한 뒤 `confirmPortfolioMargin(cycleId)`로 확인한다. 이 함수는 운영자 확인 기록이며 온체인 PM 성공 증명은 아니다.
- `GUARDIAN_ROLE`: 신규 위험 pause, 영구 shutdown, 조기 exit 권한이 있다. 이미 확정된 claim을 막는 기능은 없다.
- 누구나: 관측된 bridge 뒤 PM 제출, `Strategy.advance()`, 마감 뒤 `Vault.beginExit(id)`, 필요한 금액의 `recapitalize(id)`, `settleEpoch(id)`, NAV checkpoint를 호출한다.
- controller/operator: 표준 `redeem/withdraw`로 수령자를 지정해 claim한다. share allowance만 가진 사람에게 claim 권한을 주지 않는다.

기존 관리자 지갑이 Core 주문을 서명하는 구조와 다르다. keeper는 정해진 상태 전이를 실행할 뿐이다. 권한 이전에는 OZ `AccessControlDefaultAdminRules`를 사용한다. 일반 role grant/revoke까지 모두 timelock되는 것은 아니다.

## 사용자 ABI

```solidity
deposit(uint256 assets, address receiver) returns (uint256 shares)
mint(uint256 shares, address receiver) returns (uint256 assets)
deposit(uint256 assets, address receiver, address controller) returns (uint256 shares)
mint(uint256 shares, address receiver, address controller) returns (uint256 assets)
requestRedeem(uint256 shares, address controller, address owner) returns (uint256 requestId)
pendingRedeemRequest(uint256 requestId, address controller) returns (uint256 shares)
claimableRedeemRequest(uint256 requestId, address controller) returns (uint256 shares)
redeem(uint256 shares, address receiver, address controller) returns (uint256 assets)
withdraw(uint256 assets, address receiver, address controller) returns (uint256 shares)
setOperator(address operator, bool approved) returns (bool)
```

입금은 완전히 Idle인 경우에만 열리며 `maxDeposit/maxMint`는 나머지 상태에서 0이다. controller overload의 자금 출처는 caller이고 `Deposit` 이벤트의 첫 인자는 controller다. native 입금은 router의 `depositHype(receiver,minShares,deadline)`을 사용한다.

`maxDeposit`은 미예약 현금을 뺀 남은 cap을 구한 뒤, 그 전액을 넣어도 `previewDeposit`이 0 shares이면 0을 반환한다. 그렇지 않으면 남은 cap을 반환한다. `maxMint`는 그 한도를 shares로 내림 환산한다. caller의 잔액/allowance는 한도 계산에 사용하지 않는다. 입금 preview는 한도와 독립적으로 환산하며 0 shares 발행은 실행 시 거부한다. 한도가 0인 경계는 `CapitalClosed`, 한도 안이지만 너무 작은 zero-share 입금은 `InvalidAmount`로 거부된다.

출금은 Idle에서도 request → claim이다. Idle 요청은 즉시 Claimable이 되지만 요청 함수가 자금을 밀어 주지는 않는다. 운용 중 요청은 동일 epoch에 합산한다. controller당 미완료 epoch는 하나이며 이전 claim을 마쳐야 다음 epoch를 요청할 수 있다. exit가 시작되면 그 epoch는 닫힌다. v1 요청 취소는 없다.

`share()`는 Vault 자신이다. ERC165, ERC7540 operator/redeem, ERC7575의 규정 ID를 지원한다. share lookup `vault(asset)`도 제공한다. `previewRedeem/previewWithdraw`는 항상 revert하고, `maxRedeem/maxWithdraw`는 확정 entitlement를 반환한다. `convertTo*` 및 입금 preview는 Active라는 이유로 revert하지 않는다.

유효한 비제로 주소 사이의 0 share `transfer/transferFrom`은 Vault가 from/to여도 true를 반환하고 `Transfer` 이벤트를 발생시킨다. 잔액·총 공급·allowance·epoch·준비금은 바뀌지 않는다. 양수 직접 전송은 Vault로/부터 모두 차단하며 내부 request escrow와 정산 burn만 허용한다. 0 전송은 출금 요청이나 claim 권한을 만들지 않으며 `requestRedeem(0,...)`은 계속 거부한다. 주소 0에 대한 OZ 검증도 유지한다. [ADR-008](DECISIONS.ko.md#adr-008)

OZ ERC4626의 동기 `_withdraw`를 호출하지 않는다. 요청 지분은 Vault에 escrow하고 정산에서 소각하며 claim에서 다시 소각하지 않는다. 같은 controller의 부분 redeem/withdraw를 혼합해도 전체 지급은 원래 entitlement를 넘지 않는다. 마지막 redeem/withdraw는 자신의 잔여 entitlement를 정리한다. 환율 0인 전손도 redeem으로 요청을 완료한다.

완료된 epoch의 개인별 floor 반올림 잔액은 `roundingReserve`로 남기고 `releaseRoundingDust()`가 고정 `dustRecipient`에게만 지급한다. 그 전까지 `reservedClaimAssets` 안에 포함되어 다음 투자와 주주 NAV에서 제외된다.

### 정산 환율과 반올림

현재 WHYPE는 18 decimals, `hcHYPE` 지분은 21 decimals이며 virtual share offset은 3이다. 정산 직전 미예약 주주 현금을 A, 소각 전 총 지분을 S, 요청 지분을 Q라고 하면 `EpochRedeem._settleRedeemEpoch()`의 환율은 다음과 같다. A에는 실제 회수액과 Vault의 미배정 주주 현금이 포함되며 Active 평가 추정치를 넣지 않는다.

| 조건 | rateNumerator / rateDenominator |
| --- | --- |
| A=0 | 분자 0; 분모는 아래 S/Q 규칙을 유지 |
| Q=S, S>0 | A / S |
| 그 외 | (A+1) / (S+1000), 단 A=0이면 분자 0 |

epoch 준비금은 `floor(Q × numerator / denominator)`다. 부분 redeem 지급액은 floor, 부분 withdraw의 필요 지분은 ceil이다. 마지막 claim은 해당 controller 자신의 남은 entitlement만 소비한다. 다른 controller 몫이나 완료 epoch의 dust를 마지막 청구자에게 몰아주지 않는다.

## Permissionless 수령

표준 Vault claim은 controller/operator의 권한이 필요하다. 제3자가 지급까지 실행하게 하려면 beneficiary별 `FixedReceiverController`를 배포하고, 그 adapter 주소를 요청의 controller로 지정한다. 누구나 adapter의 `claim()`을 호출할 수 있고 WHYPE는 항상 고정 beneficiary로 전송된다. adapter에 operator 등록이나 임의 call 경로는 없다.

native HYPE 수령은 사용자가 router를 operator로 승인한 뒤 `redeemHype(shares,receiver,minAssets,deadline)`를 호출한다. router가 사용하는 controller는 항상 `msg.sender`다. 다른 사용자가 router를 승인해 두었어도 그 사용자의 요청을 탈취할 수 없다. unwrap이나 native 수신이 실패하면 claim 전체가 revert되어 권리가 보존된다.

## 운용과 회수

1. 외부에서 **Strategy 주소의** Core 계정을 활성화하고 가스 예비금을 준비한다. 현재 `sponsorGas()`는 Idle에서 누적 상한까지 초기 후원만 받으며 share를 발행하지 않는다.
2. Vault에 사용자 자금이 예치되면 manager가 `startCycle(assets)`를 실행한다. cycle/epoch/기한을 기록하고 정확한 allowance로 Strategy에 WHYPE를 배정한다.
3. Strategy가 unwrap/bridge한다. raw spot target 관측 후 누구나 PM 전환을 제출한다. bootstrap 역할의 확인이 있어야 supply와 short를 실행한다. 첫 explicit supply 직전 HYPE lending의 supply/borrow가 모두 0인지 다시 확인하며, 비제로는 `ResidualExposure`, 읽기 실패는 revert한다. 검사 통과 후에만 bridge target을 지우고 기존 원금 수량을 제출한다.
4. 누구나 `advance()`로 한 단계씩 진행한다. 가격/수량/cloid는 계약이 결정하며 한 번에 하나의 금융 action만 미확정으로 남는다.
5. opening deadline까지 활성화되지 않거나 cycle deadline이 지나면 누구나 `beginExit`를 호출한다. guardian은 더 일찍 요청할 수 있다. pause/shutdown 상태도 exit를 허용한다. 출금 요청이 없어도 cycle 전체를 닫을 수 있다.
6. bridge 관측 → pending 금융 action 관측 → reduce-only close → 부채 상환 → lending 회수 → quote 변환 → HYPE recall 순으로 회수한다. PM 확인 전에도 금융 action이 없고 raw spot bridge target을 충족하면 초기 회수 경로에 진입할 수 있다. 자동 공급 등으로 raw spot이 target 아래라면 deadline/pause 뒤에도 이 조건에서 멈춘다.
7. debt recapitalization은 실제 필요량, cycle 누적 cap, Vault의 미예약 WHYPE를 모두 검사한다. 확정 claim 준비금은 사용할 수 없다.
8. Strategy가 ReturnReady가 되면 누구나 Vault의 `settleEpoch`를 실행한다. 실제 WHYPE 잔액 증가를 반환값과 비교한다. 정산에는 회수액뿐 아니라 Vault에 남아 있던 미배정 주주 자금도 포함한다.

core pending에는 cycle ID, action ID, 실제 cloid/payload hash와 제출 시각이 포함된다. ID는 cycle을 넘어 증가한다. 과거 cycle의 반환·정산을 재사용할 수 없다. 지연이나 zero-fill만으로 action을 삭제하지 않는다. `pendingActionObservation()`으로 효과/읽기 실패를 구분하고 `syncPendingAction()`으로 인정된 효과만 별도로 기록한다.

Recall 수신이 관측되면 요청 금액을 wrap하고 pending을 소비한 뒤 Recalling으로 돌아온다. 다음 `advance()`에서 terminal 조건을 검사하여 ReturnReady가 된다. 잔여 quote 때문에 마지막 검사가 실패해도 이미 수신한 WHYPE와 소비 기록은 유지된다. 이는 dust 처분 경로를 구현했다는 뜻은 아니다.

Strategy phase의 ABI 숫자는 다음과 같다. Vault phase와 별개이며 enum 재배열 시 숫자를 비교하는 reader·Vault·테스트도 함께 검토한다.

```text
0 Idle                 1 BridgePending          2 SupplyingCollateral
3 OpeningHedge         4 Active                 5 ClosingHedge
6 SettlingDebt         7 WithdrawingCollateral  8 ConvertingQuote
9 Recalling           10 RecallPending         11 ReturnReady
```

초기 lending 검사는 기존 공급/차입을 보고 전액 공급을 추가 제출하지 않도록 하는 방어다. 자동 공급을 이번 bridge의 원금으로 인정하거나 hedge를 진행시키지 않는다. [모형 재현](pm-lifecycle-model.ko.md)과 [ADR-009](DECISIONS.ko.md#adr-009)를 참고한다.

## 평가와 종료 조건의 한계

`totalAssets()`는 미예약 EVM 현금과 마지막 Strategy 관측/추정값을 합산하고 결과를 0 아래로 내리지 않는다. 기본 reader의 Active 값은 원금 추정치다. 현재 공정 NAV나 외부 담보 가격으로 간주하지 않는다.

Core read 실패가 기존 Claimable 자산의 지급을 막지는 않는다. NAV reader가 실패하거나 cycle·시점·상태 검증을 통과하지 못하면 Unavailable로 표시하고 마지막 정상 값과 시각을 유지한다. `effectiveNavQuality()`는 캐시의 나이와 현재 Strategy 상태를 재검사하며 평가 NAV는 현재 Core block도 일치해야 한다. 실제 입금과 epoch 정산은 Active NAV/cache에 의존하지 않는다.

quote dust를 기존 프로토타입처럼 무조건 다음 cycle로 넘기는 동작은 제거했다. 따라서 일부 실제 exit는 residual 상태에서 멈출 수 있다. 이는 해결 완료로 숨기지 않고 배포 차단 조건으로 남긴다. 가스 예비금과 주주 담보는 같은 Core 계정에 있으므로 청산으로부터 물리적으로 분리되지 않는다.

PM 전환·액션 최종성·recall·dust·가스·청산의 남은 작업과 완료 조건은 [BACKLOG의 CORE 항목](BACKLOG.ko.md), 생산용 source는 [NAV-001](BACKLOG.ko.md#nav-001)에서 관리한다. mock 통과를 실자금 운용이나 전체 표준 적합성 검증으로 해석하지 않는다.

## 배포와 검증

`script/DeployPair.s.sol`은 chain 31337의 로컬/fork 리허설용이다. 실행 시 RiskOracle, NavReader, CoreActionObserver, 두 deployer와 Factory, 새 Vault/Strategy 쌍을 배포한다. 라이브 네트워크 실행은 거부한다. 역할·자산·cap은 환경변수에서 명시적으로 입력한다. HYPE lot/가격 설정과 1시간 opening timeout, 1일 cycle은 리허설 설정이다. `Strategy.Config.actionObserver`는 새 필수 필드이며 configHash에 포함된다.

필요 변수: `VAULT_ADMIN`, `VAULT_MANAGER`, `VAULT_GUARDIAN`, `VAULT_BOOTSTRAP`, `DUST_RECIPIENT`, `WHYPE`, `CORE_WRITER`, `HYPE_SYSTEM`, `HYPE_TOKEN`, `QUOTE_TOKEN`, `HYPE_PERP_ASSET`, `HYPE_SPOT_ASSET`, `HYPE_SPOT_INDEX`, `CORE_GAS_RESERVE`, `MAX_ASSETS`, `RECAP_CAP`. 토큰량은 각각 EVM wei 또는 Config에 명시된 Core 단위다. 로컬의 protocol mock이나 fork 주소를 먼저 준비한다.

```sh
forge script script/DeployPair.s.sol:DeployPair --rpc-url http://127.0.0.1:8545
forge fmt --check
forge test --offline
forge build --offline --sizes
```

첫 명령은 broadcast 없는 배포 시뮬레이션이다. 이번 작업에서 온체인 배포나 서명은 수행하지 않았다. 기존에 자금이 들어간 legacy 배포가 있다면 임의 업그레이드/지분 전환을 하지 않고 기존 출금 후 사용자가 새 주소에 다시 예치해야 한다.

테스트는 표준 ABI와 이벤트, operator/allowance 구분, 부분 claim fuzz, 전손, 여러 cycle의 reserve/escrow 보존 invariant, native router 오용/실패 복구, 실제 분리 계약의 mock Core 왕복, PM 전 실패 회수, pending 미확정, 부분 체결 후 축소, 부채 상환, 고정 수령자, Factory 연결을 포함한다. mock Core 테스트는 네트워크 write 지원의 증거가 아니다.
