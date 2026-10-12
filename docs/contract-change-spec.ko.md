# 컨트랙트 구현 변경 기획서

작성일: 2026-09-20 KST · 상태: 구현 전 명세 · 대상: 현재 `HyperCoreVault` 프로토타입

후속 구현이 추가되었다. 실제 동작은 [분리 구현 명세](split-implementation.ko.md), 최신 상태는 [STATUS](STATUS.ko.md), 남은 작업은 [BACKLOG](BACKLOG.ko.md)를 따른다. 아래는 작성 당시의 변경 명세를 보존한 이력 자료다.

상위 제품/운용 설계는 [Vault / StrategyAccount 분리 기획](vault-strategy-plan.ko.md)이다. 이 문서는 그 설계를 파일, 상속, ABI, 저장소, 호출 경계와 검증 작업으로 구체화한다. 컨트랙트가 PM을 사용할 수 있다는 전제를 유지한다. 이 문서를 작성한 시점에는 Solidity 구현을 변경하지 않았다.

## 1. 표준과 OpenZeppelin 사용 범위

**ERC-7540은 Ethereum 표준이며 OpenZeppelin의 독자 표준이 아니다.** 구현 방향은 “OpenZeppelin Contracts 기반 + ERC-7540 규격 준수 + 자체 HyperCore 연동”이다. OpenZeppelin 상속만으로 자체 코드까지 감사되거나 표준 준수가 보장되지는 않는다.

| 구분 | 현재 | 변경 목표 |
|---|---|---|
| 라이브러리 | `@openzeppelin/contracts` 5.4.0 | 구현 착수 기준으로 동일 버전 고정; 버전 변경은 별도 호환성 검증 |
| 지분 | OZ ERC20 기반 custom share | OZ ERC4626이 포함하는 ERC20 사용 |
| 입금/변환 | 직접 작성한 함수 | ERC4626의 인터페이스·변환 기반 사용, 자산평가/한도 override |
| 비동기 출금 | custom request/claim | Final ERC-7540에 맞춘 자체 epoch 정산 모듈 |
| 공통 기능 | SafeERC20, Math, SafeCast, ReentrancyGuard 등 | 안정판 OZ 모듈 재사용 |
| ERC-7540 라이브러리 | 설치되지 않음 | 설치된 5.4.0에 완성 구현이 있다고 가정하지 않음 |
| OZ Community Contracts | 사용하지 않음 | 참고 자료; 이 변경의 기본 의존성으로 자동 추가하지 않음 |

OZ의 ERC-7540 구현은 별도 Community Contracts에서 제공되며 이 라이브러리는 감사·호환성 보장이 안정판과 다르다. 이번 구현은 안정판 ERC4626 기반 위에 필요한 비동기 로직을 분리 작성하는 방향으로 고정한다. [ERC-7540 표준](https://eips.ethereum.org/EIPS/eip-7540), [OZ ERC-4626](https://docs.openzeppelin.com/contracts/5.x/erc4626), [OZ ERC-7540 구현 안내](https://docs.openzeppelin.com/community-contracts/erc7540), [OZ Community Contracts 보안 정책](https://docs.openzeppelin.com/community-contracts#security)

## 2. 파일 변경 목록

아래 이름은 앞으로 만들 파일이다. 표준화 완료 전까지 기존 `src/HyperCoreVault.sol`을 비교 기준으로 남겨 두며, 기존 파일 이름으로 새 ABI를 조용히 덮어쓰지 않는다.

| 파일 | 작업 | 책임 |
|---|---|---|
| `src/AsyncHypeVault.sol` | 신규 | 표준 입출금, 자금 배정, cycle, 실제 회수 확인 |
| `src/vault/EpochRedeem.sol` | 신규 abstract | ERC-7540 operator, 요청/정산/claim 회계; Vault와 같은 주소/저장소 사용 |
| `src/HyperCoreStrategyAccount.sol` | 신규 | 기존 Core 실행 상태 머신 이동·수정 |
| `src/HyperCoreNavReader.sol` | 신규 | Strategy 순자산 관측, signed deficit, 단위·중복 제거 |
| `src/HypeRouter.sol` | 신규 | native 입금·claim 및 최소 수령량 검사 |
| `src/FixedReceiverController.sol` | 신규 | 누구나 claim을 실행하되 사용자 지정 beneficiary에만 지급 |
| `src/VaultFactory.sol` | 신규 | 쌍의 원자적 배포·일회성 연결 |
| `src/interfaces/IHyperCoreStrategyAccount.sol` | 신규 | Vault가 신뢰하는 Strategy 호출 및 상태 형식 |
| `src/interfaces/IHyperCoreNavReader.sol` | 신규 | 평가 관측/상태 형식 |
| `src/interfaces/IERC7540.sol`, `IERC7575.sol` | 신규 또는 정확한 기존 interface 재사용 | Final 명세의 ABI 고정; 구현과 분리 |
| `src/CoreActions.sol`, `src/CoreRead.sol` | 재사용·필요 부분 수정 | typed action/read, 모든 account 인자 검증 |
| `src/HyperCoreRiskOracle.sol` 및 interface | 확장 | 가격/lot 외 필요한 건전성 관측과 축소 조건 |
| `src/HyperCoreVault.sol` | 단계 종료 후 legacy 표시 | 이전 회계·테스트 비교용; 새 배포 entry point에서 제외 |

`EpochRedeem`은 개발상 분리이며 상속된 코드는 Vault runtime에 포함된다. EIP-170 크기를 줄이는 실제 분리는 별도 배포되는 StrategyAccount/NavReader/Router에서 얻는다.

## 3. 상속과 override

Vault는 `EpochRedeem`을 통해 OZ `ERC4626`을 상속하고 `ERC165`, `ReentrancyGuard`, 역할 관리용 `AccessControlDefaultAdminRules`를 조합한다. ERC20을 다시 중복 상속하거나 share token을 별도로 발행하지 않는다. `ERC20Permit`은 v1 필수가 아니며 별도 UX 확장으로 남긴다.

역할은 `MANAGER_ROLE`, `GUARDIAN_ROLE`, `BOOTSTRAP_ROLE`로 나눈다. admin transfer delay는 배포 파라미터다. `AccessControlDefaultAdminRules`가 일반 role 변경까지 모두 timelock한다는 가정은 하지 않는다. 시장, Strategy 연결, 수령자 및 hard risk cap은 배포 이후 변경 함수가 없다.

| 항목 | 구현 방향 |
|---|---|
| `asset`, name/symbol/ERC20 | OZ 기본 기능 재사용 |
| `_decimalsOffset()` | 기존과 동일하게 3; WHYPE 18 → share 21 decimals |
| `totalAssets()` | 현금 + 검증된 Strategy 순자산; claim reserve 제외 |
| `convertToAssets/convertToShares` | OZ 평균 변환 의미 유지; Active라고 revert하지 않음 |
| `_deposit` / 공개 deposit·mint | bound/Idle/pause/cap 검사와 reentrancy 방어; ERC20 이동·mint는 OZ 경로 활용 |
| `maxDeposit/maxMint` | 입금 불가 상태 0; 가능한 상태의 정확한 cap |
| `previewDeposit/previewMint` | phase/입금 한도 때문에 revert하지 않음 |
| `redeem/withdraw` | ERC-7540 claim 전용으로 직접 override; 기본 `_withdraw` 경로와 분리 |
| `maxRedeem/maxWithdraw` | wallet balance 대신 controller의 확정 entitlement |
| `previewRedeem/previewWithdraw` | 항상 비동기 preview 오류로 revert |
| `supportsInterface/share` | ERC-165/7540 redeem/operator/7575; share는 Vault 자신 |

`super.redeem()`은 preview, allowance, share 소각을 동기 출금 규칙대로 수행하므로 async claim에서 호출하지 않는다. 공개 overload끼리 `nonReentrant` 함수를 중첩 호출하지 않고 동일 internal helper로 모은다. 조합 상속의 ERC165 override는 AccessControl의 interface ID도 보존한다.

필수 interface ID는 operator `0xe3bc4e65`, async redeem `0x620ee8e4`, ERC-7575 `0x2f0a18c5`다. v1은 async deposit `0xce3bbe50`을 지원한다고 표시하지 않는다. 여러 interface를 한 파일에 선언하더라도 각 규격의 ID를 별도로 검증한다.

## 4. 기존 함수 → 새 함수 대응

| 기존 HyperCoreVault 함수 | 새 위치/ABI | 변경 내용 |
|---|---|---|
| `deposit(assets, receiver, minShares)` | Vault `deposit(uint256,address)` | 표준 ABI 복구; minShares는 router의 별도 wrapper |
| `depositHype(receiver, minShares)` | Router `depositHype(receiver,minShares,deadline)` | wrap 후 Vault 입금; user receiver에 shares 발행 |
| `redeem(shares,receiver,owner,unwrap,minAssets)` | Vault `redeem(uint256,address,address)` | 즉시 소각 출금에서 확정 요청 claim으로 변경 |
| `requestRedeem(shares,receiver,owner,unwrap)` | Vault `requestRedeem(uint256,address,address)` | 두 번째 인자는 receiver가 아닌 controller |
| `cancelRedeem(requestId)` | v1 신규 ABI에서 제외 | 기존 버전의 취소 기능과 호환되지 않음을 명시 |
| `claimRedeem(requestId)` | 표준 redeem/withdraw; 선택적 controller adapter | 표준은 controller/operator만, adapter는 fixed receiver로 누구나 실행 |
| `freeAssets()` | Vault `availableCash()` | 유동 현금 전용 이름; NAV인 totalAssets와 구분 |
| `seedCoreAccount()` | Strategy `sponsorGas()` | Strategy 주소로 후원; activation 성공은 별도 관측 |
| `submitPortfolioMarginActivation()` | Strategy `submitPortfolioMarginActivation()` | 현재 cycle/입금 관측 후 지정된 자기 주소 PM만 제출 |
| `enableLiveStrategy()` | Vault `confirmPortfolioMargin(cycleId)` → Strategy 확인 기록 | 제출 사실과 실제 활성화 확인을 구분 |
| `startStrategy(assets)` | Vault `startCycle(assets)` → Strategy `startCycle(...)` | 배정·기한·epoch 생성은 Vault, bridge 실행은 Strategy |
| `observeBridgeAndSupply`, `processOpeningHedge`, `activateStrategy` | Strategy `advance()` 내부 단계 | 현재 phase를 보고 한 번에 bounded 작업만 실행 |
| `beginExit()` | Vault `beginExit(cycleId)` → Strategy `requestExit(cycleId)` | 누구나 마감 조건 충족 시 호출 |
| `processHedgeClose/processDebtSettlement/processCollateralWithdrawal/processQuoteConversion` | Strategy `advance()` 내부 단계 | 가격/수량은 실행자가 정하지 않음 |
| `recapitalizeDebt()` | Vault `recapitalize(cycleId)` → Strategy | 부족분·누적 cap·claim reserve 제외 확인 |
| `submitRecall/syncCoreState` | Strategy `advance()` 내부 단계 | 수신 인증/미확정 action 관측 유지 |
| `_settleEpoch()` | Vault `settleEpoch(cycleId)` | Strategy 종료와 실제 Vault 잔액 증가 대조 후 정산 |
| `pauseNewCapital/unpauseNewCapital/permanentlyShutdown` | Vault 역할별 함수 | 출금 권리를 유지하고 Strategy의 신규 위험도 함께 차단 |
| `receive()` | Strategy와 Router | Vault 사용자 회계는 ERC20 중심; native Core 수신은 Strategy에서 처리 |

추가하는 표준 함수는 `mint`, `withdraw`, `max*`, `preview*`, `asset`, `totalAssets`, `share`, `setOperator/isOperator`, `pendingRedeemRequest/claimableRedeemRequest`, controller를 받는 deposit/mint overload다. sync deposit의 controller overload는 caller 권한을 확인하고 caller의 WHYPE에서 자금을 받는다. controller의 allowance를 자동으로 사용하지 않는다.

controller overload의 `Deposit` 이벤트 첫 인자는 표준에 따라 controller다. OZ `_deposit(caller, ...)`는 자금 출처와 이벤트 첫 인자를 같은 값으로 사용하므로, 이 overload에서는 funder와 controller를 구분하는 internal helper가 필요하다. 토큰 이동과 mint 순서는 OZ 구현을 따라 유지하고 이벤트를 중복 emit하지 않는다.

## 5. 저장소 변경

### Vault

```solidity
// 설계용 필드 목록; 컴파일되는 구현 코드가 아님
strategy; deploymentFactory; navReader;
vaultPhase; shutdown; riskPaused;
nextCycleId; nextEpochId; currentCycleId;
mapping(uint256 cycleId => Cycle) cycles;
mapping(uint256 epochId => RedeemEpoch) epochs;
mapping(uint256 epochId => mapping(address controller => Request)) requests;
mapping(address controller => uint256 epochId) controllerEpoch;
mapping(address controller => mapping(address operator => bool)) operators;
reservedClaimAssets; roundingReserve;
lastValidNav; navAsOfCoreBlock; navStatus;
```

| struct | 필요한 필드와 의미 |
|---|---|
| `Cycle` | epochId, allocatedAssets, recapitalizedAssets, recapCap, openDeadline, cycleEnd, exitRequested, settled |
| `RedeemEpoch` | requestedShares, remainingClaimShares, rateNumerator, rateDenominator, reservedAssetsRemaining, sealed, settled |
| `Request` | requestedShares, consumedShares, paidAssets; epoch 환율로 계산한 최대 entitlement와 대조 |

`controllerEpoch`는 0을 미완료 요청 없음으로 사용하고 epoch ID는 1부터 증가한다. controller당 미완료 epoch 하나, 같은 epoch의 요청은 합산한다. 정산 전 request shares는 Vault의 ERC20 balance에 escrow하며 totalSupply에 포함된다. epoch 정산에서 합계만 소각하므로 무제한 controller 순회가 없다. 표준 pending/claimable view는 epoch.settled와 소비량으로 계산하고 stale한 status 필드를 따로 유지하지 않는다.

`roundingReserve`는 `reservedClaimAssets` 안에 포함된 아직 귀속이 확정되지 않은 반올림 잔액이다. 별도로 두 번 차감하지 않는다. 모든 요청 소비 후에만 dust 처리 대상으로 분류한다.

### StrategyAccount

기존 `Phase`, `ActionKind`, `PendingAction`, `_strategyHype`, `_bridgeTarget`, `_supplyBefore`, `_nextCloid`, `totalCoreHypeReceived`를 이동한다. 여기에 `vault immutable`, `cycleId`, 고정 투자 계획, returnConsumed, exitRequested, riskPaused, gasBucket, inFlight 기록을 추가한다.

`PendingAction`에는 cycleId, cloid, 제출 block, source 관측치, receipt 기준값을 포함한다. 개별 cycle마다 cloid를 1로 초기화하지 않는다. 종료된 cycle action과 새로운 cycle 관측이 섞이지 않아야 한다.

Vault가 관리하는 사용자 share/claim 데이터는 Strategy에 존재하지 않는다. Strategy의 `address(this)`는 모든 Core precompile과 CoreWriter의 계정 기준이다.

## 6. 계약 간 인터페이스 초안

다음은 신규 내부 프로토콜의 설계 ABI다. ERC 표준 ABI와 달리 구현 검토에서 변경할 수 있다. struct 정의와 exact uint 폭은 코딩 단계에서 확정한다.

```solidity
interface IHyperCoreStrategyAccount {
    function vault() external view returns (address);
    function asset() external view returns (address);
    function configHash() external view returns (bytes32);

    // onlyVault; exact allowance만 소모한다.
    function startCycle(
        uint256 cycleId, uint256 assets, uint64 openDeadline, uint64 cycleEnd
    ) external;
    function confirmPortfolioMargin(uint256 cycleId) external;
    function requestExit(uint256 cycleId) external;
    function setRiskPaused(bool paused) external;
    function recapitalize(uint256 cycleId, uint256 assets) external;
    function returnToVault(uint256 cycleId) external returns (uint256 assets);

    // 누구나 호출; raw action이나 경제적 실행 파라미터를 받지 않는다.
    function submitPortfolioMarginActivation() external;
    function advance() external;

    function cycleStatus(uint256 cycleId) external view returns (CycleStatus memory);
    function requiredRecapitalization(uint256 cycleId) external view returns (uint256);
}
```

`CycleStatus`는 현재 cycle, phase, pending 종류/제출 block, exit flag, return-ready 상태를 포함한다. 상태값만 거짓으로 설정할 수 있는 setter는 없다. PM 확인은 별도 financial action 재시도 권한을 주지 않는다.

`NavObservation`은 signed Strategy netAssets(WHYPE wei), asOfCoreBlock, observedAt, valid/quality, inFlight 판정을 포함한다. 사용자가 observation 숫자를 입력하는 public setter는 만들지 않는다. 정확한 Core 손익/부채 단위는 검증된 decoder에서만 변환한다.

## 7. 원자적 자금 이동 절차

### startCycle

1. Vault가 bound/Idle, 청산할 미확정 위험 없음, 자금 cap 및 riskPaused를 확인한다.
2. 새 cycle/epoch/기한을 먼저 기록한다. 이 시점부터 신규 입금은 닫힌다.
3. `availableCash = Vault.WHYPE - reservedClaimAssets` 안에서 Strategy allowance를 정확한 배정액으로 설정한다.
4. Strategy가 onlyVault startCycle에서 배정액을 pull하고 unwrap/bridge한다. 반환 시 allowance가 소진됐는지 확인한다.
5. Strategy의 Core 입금 관측 → 필요한 PM 확인 → 공급/hedge 단계로 진행한다.

시작 중 external call 실패 시 전체 EVM 트랜잭션을 revert한다. 최초 bridge가 제출된 뒤에는 async Core 실패를 EVM revert로 되돌릴 수 없으므로 회수 상태 머신으로 처리한다.

### settleEpoch

1. Vault가 cycle 미정산, epoch sealed, Strategy의 동일 cycle ReturnReady를 확인한다.
2. 회수 가능 판정에는 debt/position/금융 pending/in-flight 해소와 protocol gas·quote dust 처리가 필요하다.
3. Vault 잔액을 저장하고 onlyVault `returnToVault`를 호출한다. Strategy는 수령자를 인자로 받지 않고 Vault로만 WHYPE를 전송한다.
4. 반환된 숫자와 실제 잔액 증가를 대조한다. 자산 0 반환도 검증된 전손 종료라면 허용한다.
5. 기존 claim 채무를 제외한 전체 shareholder cash로 epoch 환율을 고정한다. 이 cash에는 cycle에 배정하지 않은 주주 자금도 포함된다.
6. 요청 share 합계를 burn하고 그 지급액을 reserve로 격리한다. epoch/cycle 소비 표시까지 같은 트랜잭션에서 처리한다.

Vault에는 Strategy가 임의 환율이나 성공 상태를 밀어 넣는 무권한 callback을 만들지 않는다. 이미 반환된 cycle 재사용은 불가하며, 전략 회수액만으로 전체 Vault NAV를 대체하지 않는다.

## 8. 정산 수학과 claim

상위 기획의 virtual-offset 환율을 기본 후보로 유지한다. 저장하는 환율은 분자/분모이며 고정 소수점 환율의 반복 반올림을 피한다. 실제 회수된 자산 A, 정산 전 공급 S, 요청 합 Q를 사용한다. Q=0이면 burn/reserve 없이 cycle만 종료한다. A=0은 전손 분기로 처리하며 부채가 남아 있으면 진입하지 않는다.

controller의 전체 지급 한도는 `floor(requestedShares * N / D)`다. `redeem`은 share 수량 기준으로, `withdraw`는 asset 수량 기준으로 한도를 소비한다. 일반 부분 redeem은 floor, 부분 withdraw는 ceil 방향으로 계산하되 각각 남은 share/asset 한도를 검사한다. 자신의 마지막 claim에서만 자신의 반올림 잔여를 정리한다. 다른 controller가 남긴 dust를 가져오지 못한다.

표준 `maxRedeem/maxWithdraw`는 같은 계산을 사용하고 반환된 최대값을 실제로 수령할 수 있어야 한다. paidAssets와 consumedShares 모두 감소할 수 없는 누적값으로 기록한다. 전손 때는 양의 remaining shares를 redeem하여 0 asset으로 요청을 완료할 수 있다.

정산에서 shares를 이미 burn했으므로 claim에서 `_burn` 또는 `transferFrom`을 다시 호출하지 않는다. 지급량, claim 소비량, reserve 감소를 먼저 갱신하고 WHYPE를 전송한다. 마지막 개인 요청을 완료하면 controllerEpoch를 해제한다.

## 9. 권한과 native router 변경

`requestRedeem`은 owner 자신, owner의 operator, 또는 충분한 share allowance를 가진 caller가 실행할 수 있다. operator에는 allowance 차감을 요구하지 않는다. claim은 controller 또는 그 operator만 실행하며 share allowance만으로 claim할 수 없다. receiver는 표준 claim 시 권한자가 지정한다.

manager가 사라져도 누구나 cycle 마감 뒤 Vault.beginExit와 Strategy.advance, Vault.settleEpoch를 실행할 수 있다. guardian의 riskPaused는 다음 신규 supply/open 전에 Strategy도 확인한다. manager가 기존 pause를 우회하여 직접 Strategy를 시작할 수 없다. 이미 확정된 claim은 Core read·NAV·운영자 상태와 독립적으로 실행한다.

Router의 native 출금은 특히 caller 검사가 필요하다. router가 사용자에게 operator로 승인되어 있다고 해서 누구나 router에 임의 controller/receiver를 넣어 claim할 수 있으면 안 된다. v1 `redeemHype`는 `controller == msg.sender`를 강제하고, 사용자가 승인한 router가 Vault에서 자기 주소로 WHYPE를 수령한 뒤 같은 호출에서 unwrap/지정 receiver로 지급한다. 위임 실행은 별도 서명/nonce 설계 없이 열지 않는다.

무권한 누구나 실행하는 지급은 `FixedReceiverController`로 분리한다. 사용자가 요청 당시 이 adapter를 controller로 선택한다. adapter의 Vault/beneficiary는 불변이고 모든 수령은 그 beneficiary로만 가능하다. operator 임의 등록, arbitrary external call, receiver 변경 함수는 없다.

Strategy의 native 수신은 canonical WHYPE unwrap과 Core recall 발신자를 구분한다. WHYPE의 2,300 gas unwrap 경로에는 storage 기록을 하지 않는다. 실제 Core callback 형식·발신자·순수령액은 integration 검증 후 구현한다. 강제 native 전송이나 donation을 recall 영수증으로 인정하지 않는다.

## 10. 상태·오류·이벤트

Vault 상태는 Unbound/Idle/Deploying/Active/Exiting/Settling/Closed, Strategy 상태는 Core 단계별 상태다. Funding은 startCycle 트랜잭션 내 임시 상태로 둘 수 있다. 두 상태는 cycleId로 연결하며 keeper가 동기화 상태를 임의 지정할 수 없다.

신규 오류 후보: `NotBound`, `AlreadyBound`, `WrongVault`, `WrongCycle`, `ControllerEpochOutstanding`, `UnauthorizedController`, `NotClaimable`, `AsyncPreviewUnsupported`, `StrategyNotReturnReady`, `ReturnAmountMismatch`, `ClaimReserveViolation`, `RecapitalizationCapExceeded`, `NavUnavailable`, `ActionOutcomeUnknown`.

표준 Deposit/Withdraw/RedeemRequest/OperatorSet 이벤트를 제공하고 자체 이벤트는 CycleAllocated, ExitRequested, CoreActionSubmitted/Observed, StrategyReturned, EpochSettled, NavCheckpointed, RecoveryRequired로 구분한다. 표준 Withdraw는 실제 claim 지급 시 emit한다. 정산에서 share가 소각되는 ERC20 Transfer와 실제 asset 지급 이벤트는 서로 다른 단계다.

pause/shutdown은 요청을 지우지 않는다. PM-only 미확인은 신규 위험을 닫고 회수로 전환할 수 있지만, 이미 제출된 금융 action은 시간 경과만으로 취소됐다고 판단하지 않는다. 지연 주문이 나중에 실행될 수 있는 상태에서 terminal 완료나 신규 cycle을 허용하지 않는다.

## 11. NAV와 아직 확정하지 않을 구현

`totalAssets()`를 단순 Vault.balance로 작성하면 Core에 운용 중인 자산이 빠진다. 반대로 spot+lending+perpPnL-debt를 검증 없이 더하면 PM 중복 계상이 생길 수 있다. NavReader는 signed net value와 quality를 반환하고 Vault는 마지막 유효 관측과 이후 현금 이동을 조정한다.

실제 입금은 fully Idle의 확정 회계를, 출금 정산은 실제 회수금을 사용한다. Active view에서 Core read 실패가 발생해도 already-claimable 지급은 영향을 받지 않는다. 캐시의 합리성·freshness·in-flight ledger가 검증되기 전에는 표준 준수 완료라고 표시하지 않는다.

다음은 단순 refactor로 해결되지 않는 항목이다. mock 테스트를 실제 지원 증거로 대체하지 않는다.

- 실패한 Core action을 안전하게 확정·재시도하는 근거
- PM spot/lending/PnL/debt의 단위와 중복 제거
- Core recall callback의 인증과 gas 차감 정산
- PM 건전성을 유지하는 단계별 unwind와 자동 위험 축소
- quote sub-lot 잔액, protocol gas 감소, 전원 exit 이후 소유권 처리

## 12. 테스트 변경과 완료 기준

| 테스트 파일(신규 예정) | 주요 검증 |
|---|---|
| `AsyncHypeVault.t.sol` | 표준 입금·mint, Idle 제한, max/preview/convert 의미 |
| `ERC7540Conformance.t.sol` | ABI, interface IDs, operator/allowance 구분, request/claim 이벤트, 별도 claim 호출 |
| `EpochAccounting.t.sol` | 부분 redeem/withdraw 혼합, 같은 epoch 환율, 전손·전원 상환·dust, controller 제한 |
| `HyperCoreStrategyAccount.t.sol` | 실제 caller/read 주소, PM bootstrap, partial fill, timeout/unknown 결과, recall |
| `VaultStrategyIntegration.t.sol` | 실제 토큰 배정·반환, wrong cycle, 가짜 완료, 0 반환, 재자본화 cap |
| `VaultInvariants.t.sol` | claim reserve 보존, 이중 claim/return 불가, 회계 보존, pause 후 exit |
| `HypeRouter.t.sol`, `FixedReceiverController.t.sol` | operator 승인된 router 악용 방지, unwrap 실패, 고정 수령자, 최소 수령량 |
| `VaultFactory.t.sol` | atomic bind, 재연결 불가, unbound 입금 차단, 구성 불일치 |
| `HyperCoreNavReader.t.sol` | signed loss, unit mismatch, 중복/in-flight, stale/failed read |

현재 CorePrimitives/RiskOracle 테스트는 유지한다. 기존 HyperCoreVault 테스트 중 donation, reserve, full loss, partial fill, fixed receiver 사례는 목적에 맞게 분리 이전한다. 기존 테스트 개수보다 상태 조합과 자산 보존을 통과 기준으로 삼는다.

각 단계에서 `forge fmt --check`, `forge test --offline`, `forge build --offline --sizes`를 실행한다. runtime은 개별 계약 EIP-170 이하, 내부 목표 22 KiB 이하이며 Factory initcode도 검증한다. fuzz는 분할 claim·자금 흐름을, stateful invariant는 여러 cycle과 여러 사용자를 대상으로 한다.

## 13. 구현 순서와 ABI 전환

1. **인터페이스/MockStrategy:** ABI와 immutable 연결을 먼저 확정한다. 새 Vault 테스트는 실제 Core 없이 시작한다.
2. **Strategy 분리:** 기존 Core 상태를 이동하고 user address를 Strategy로 바꾼다. Factory와 실제 WHYPE 왕복을 검증한다.
3. **표준 회계:** EpochRedeem/Vault를 구현하고 기존 custom claim을 표준 claim으로 바꾼다. 공개 ABI·이벤트 스냅샷을 남긴다.
4. **NAV/복구:** read 단위와 Core 비동기 관측을 붙인다. 미해결 결과는 실패 원인으로 보존한다.
5. **Router/운영:** native UX와 permissionless crank 상태조회, 배포 스크립트·runbook을 작성한다.
6. **통합:** 제한된 실자금 canary와 별도 검토를 통과한 후 배포 대상으로 지정한다.

이번 변경은 기존 ABI와 저장소에 호환되지 않는다. proxy 업그레이드로 취급하지 않고 새 Vault/Strategy 쌍을 배포하는 것을 기본으로 한다. 기존 주소가 실제 배포됐는지는 구현 시작 시 확인한다. 자금이 있는 기존 배포가 있다면 먼저 기존 계약의 회수·사용자 claim을 완료하고, 사용자가 새 Vault에 명시적으로 예치한다. 이전 share를 임의 비율로 강제 변환하거나 새 Strategy가 옛 Core 계정에 접근할 수 있다고 가정하지 않는다.

표준 준수의 완료 기준은 단순히 ERC4626을 상속하는 것이 아니라 **정확한 ABI/권한/뷰 동작, 일관된 자산평가, 실제 비동기 정산, claim 자금 보존**을 모두 검증하는 것이다. 최종 대외 표현은 “OpenZeppelin Contracts 기반의 ERC-7540 호환 HyperCore vault”이며 구현·검증 완료 전에는 “호환을 목표로 개발 중”으로 표시한다.
