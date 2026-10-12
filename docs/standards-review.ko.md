# 표준 적합성 검토 기록

최초 검토: 2026-09-21 KST. 최종 갱신: 2026-10-03 KST. 대상은 `AsyncHypeVault` / `EpochRedeem`과 관련 인터페이스다. **표준을 기반으로 구현했지만, 현재 완전 준수라고 판정하지 않는다.** 최초 검토에서 발견한 ERC4626 `maxDeposit` 불일치를 수정했고, Vault가 포함된 0 share 전송도 ERC20 경로로 처리하도록 변경했다. 양수 직접 전송 제한은 유지하므로 제한 없는 share 토큰으로 표시하지 않는다.

## 구현 방식과 판정 범위

설치된 OpenZeppelin Contracts 5.4.0의 ERC20/ERC4626, SafeERC20, ReentrancyGuard, AccessControlDefaultAdminRules를 사용한다. [패키지](../package.json), [Vault](../src/AsyncHypeVault.sol), [EpochRedeem](../src/vault/EpochRedeem.sol)을 대조했다. ERC7540의 요청·operator·epoch·claim은 프로젝트 자체 구현이며 OZ가 제공한 ERC7540 구현체를 그대로 사용하는 구조가 아니다.

검토 방식은 공식 표준 대조, 소스·컴파일된 ABI 검사, 기존 회귀 및 추가 [StandardsReview 테스트](../test/StandardsReview.t.sol)다. 35개 관련 함수의 ABI 존재를 확인했지만, 함수 존재만으로 동작 적합성을 판정하지 않았다. 전체 상태공간의 형식 검증이나 독립 보안 감사는 아니다. 최신 실행 결과는 [STATUS](STATUS.ko.md)에 있다.

판정: `PASS`는 기재한 범위의 코드/시험이 요구와 일치, `FAIL`은 반례 확인, `FIXED`는 확인한 반례 수정·회귀 검증, `COMPAT`은 별도 호환성 정책 검토 필요, `N/A`는 선택하지 않은 표준 기능이다.

## 후속 USDC Vault의 표준 선택

이 절은 [ADR-012](DECISIONS.ko.md#adr-012)의 새 상품 선택 근거다. [USDC Vault](usdc-vault-implementation.ko.md)의 로컬 ERC7540 흐름은 별도 mock 시험을 통과했지만 아래 WHYPE 코드의 적합성 판정이나 전체 ERC7540 인증은 아니다. ERC는 인터페이스 표준이고 OpenZeppelin은 구현 라이브러리다.

| 후보 | 사용 여부와 이유 |
| --- | --- |
| [ERC4626](https://eips.ethereum.org/EIPS/eip-4626) + stable [OpenZeppelin ERC4626](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC4626) | 채택. USDC 하나의 입출금 자산과 ERC20 지분·동기 Idle 입금에 맞는다. ERC4626만으로 비동기 Core 회수·epoch claim은 구현되지 않는다. |
| [ERC7540](https://eips.ethereum.org/EIPS/eip-7540) | 채택. 동기 입금 + 비동기 redeem이 허용되며 요청·Pending/Claimable/Claimed·동일 requestId의 동일 환율과 부분 이행 비례율을 적용한다. ERC165와 ERC7575 `share()`도 요구한다. 운용 USDC buffer는 표준 요건이 아니다. |
| [ERC7575](https://eips.ethereum.org/EIPS/eip-7575) | ERC7540에 필요한 `share()`/ERC165 호환성만 유지. 다중 입금 자산/진입점은 만들지 않는다. Core 내부 spot·HIP-3·HIP-4 노출이 사용자 입금 자산을 여러 개로 바꾸지는 않는다. |
| [ERC5143](https://eips.ethereum.org/EIPS/eip-5143) | 선택하지 않음. slippage 보호 overload를 제안하지만 현재 표준 상태는 Stagnant. 새 USDC Vault는 별도 `depositWithLimit`/`mintWithLimit`으로 한도·기한을 검사한다. ERC5143 준수 주장은 하지 않는다. |

OpenZeppelin [Community Contracts ERC7540](https://docs.openzeppelin.com/community-contracts/erc7540)은 `ERC7540SyncDeposit` + `ERC7540AdminRedeem` 같은 조합을 제공한다. 하지만 이 프로젝트에 설치된 stable `@openzeppelin/contracts` 5.4.0에는 ERC7540 구현이 없고 Community 패키지는 설치되어 있지 않다. [저장소 보안 고지](https://github.com/OpenZeppelin/openzeppelin-community-contracts#security)는 미감사·호환성 보장 부재를 명시한다. 첫 USDC 구현은 stable OZ 기반 + 프로젝트의 ERC7540 epoch 회계를 사용한다. Community 모듈은 별도 ABI/권한/epoch·가스·크기 비교와 감사가 충족될 때만 재평가한다. 기존 WHYPE 테스트 통과만으로 새 USDC 적합성이 입증된 것은 아니다.

[OpenZeppelin의 ERC4626 가이드](https://docs.openzeppelin.com/contracts/5.x/erc4626)는 직접 송금으로 환율을 움직이는 공격과 virtual offset 완화책을 설명한다. 새 USDC Vault의 3자리 offset은 기존 ERC4626 수식의 반올림 경계를 완화하지만, 비요청 USDC를 잔액 기반 `totalAssets`에 포함할 경우 cap·epoch 정산·다음 배정까지 영향을 주는 문제를 없애지는 않는다. [ADR-013](DECISIONS.ko.md#adr-013)의 별도 `accountedCash` 장부는 Vault 주소로 직접 들어온 USDC를 이 경로에서 격리한다. 이는 Core/Strategy로 전송된 자산의 출처 증명이 아니다.

## STD-F01 — maxDeposit이 실행 불가능한 입금 한도를 광고함

**판정: FIXED · 최초 심각도 P2.** [ERC4626 maxDeposit](https://eips.ethereum.org/EIPS/eip-4626#maxdeposit)은 실제 수용 가능한 최대량을 초과해서 반환하지 않도록 요구한다. 이는 선택 사항이 아닌 MUST 요구사항이다. 수정 전 [AsyncHypeVault](../src/AsyncHypeVault.sol)의 `maxDeposit`은 자산 cap의 남은 공간만 반환했고, `_depositAssets`는 발행 지분이 0이면 입금을 거부했다.

수정 전 재현 조건과 결과:

```text
phase = Idle, pause/shutdown 없음, totalSupply = 0
maximumTotalAssets = 1000 × 10^18
Vault에 직접 기부한 WHYPE = maximumTotalAssets - 1

maxDeposit(ALICE)       = 1 wei
previewDeposit(1 wei)   = 0 shares
maxMint(ALICE)          = 0
deposit(1 wei, ALICE)   = InvalidAmount revert
```

caller는 충분한 WHYPE와 allowance를 가지고 있고 receiver도 정상이었다. 지갑 잔액·승인·네트워크 지연 때문이 아니라 limit 함수와 입금 조건의 불일치였다. donation 방어는 0 shares 발행을 막고 있었으므로 이 반례 자체를 자금 탈취로 분류하지 않는다. integrator가 입금 가능하다고 판단해 실패하는 문제였다.

수정: 남은 capacity에 대해 `previewDeposit(capacity)`가 0이면 `maxDeposit`도 0을 반환한다. 환산은 입금량에 대해 단조 증가하므로 capacity 전체로도 shares가 생기지 않으면 그 이하의 어떤 양으로도 유효한 입금을 할 수 없다. 양의 shares가 생기면 기존 capacity를 반환한다. 지갑 잔액에 의존하지 않으며 기존 cap·pause·receiver 제한과 zero-share 입금 거부를 유지한다. `previewDeposit` 자체에 limit을 섞지 않는다.

같은 반례의 수정 후 결과는 `maxDeposit=0`, `maxMint=0`이고 `deposit(1)`은 `CapitalClosed`로 거부된다. ABI·storage layout 변경은 없으며 이 경계의 오류 selector는 기존 `InvalidAmount`에서 바뀐다. capacity가 충분할 때의 소액 zero-share 입금은 여전히 `InvalidAmount`다.

기존 반례 테스트를 `testMaxDepositIsZeroWhenRemainingCapacityMintsNoShares`로 전환했다. 새 기대값이 수정 전 코드에서 실패하고 수정 후 통과하는 것을 확인했다. 한 share 발행 경계의 deposit/mint, cap 초과 거부, 기존 claim 준비금 제외, cap·초기 입금·기부금 조합에서 광고한 최대량의 실제 실행을 검증한다. fuzz는 지원 cap 범위에서 빈 Vault·기존 shares·cap 이상 기부를 포함한다. 작업 기록은 [STD-002](BACKLOG.ko.md#std-002), 실행 결과·크기는 [STATUS](STATUS.ko.md)에서 관리한다.

## STD-C01 — Vault 주소로의 0 share 전송도 제한됨

**판정: FIXED · 0 수량 전송 제한 해소.** 수정 전 [EpochRedeem](../src/vault/EpochRedeem.sol)의 `_update`는 request escrow 외 Vault가 포함된 직접 share 전송을 수량과 무관하게 막았다. 일반 사용자 간 0 전송은 성공했지만 `transfer(vault,0)`과 `transferFrom(owner,vault,0)`은 `DirectShareTransferForbidden`으로 revert했다.

[ERC20 transfer](https://eips.ethereum.org/EIPS/eip-20#transfer)와 [transferFrom](https://eips.ethereum.org/EIPS/eip-20#transferfrom)은 0 수량도 정상 전송으로 처리하고 `Transfer` 이벤트를 발생시키도록 요구한다. [ERC4626](https://eips.ethereum.org/EIPS/eip-4626#specification)은 비양도 Vault의 전송 거부를 허용한다. **해석과 결정:** 현재 지분은 사용자 간 양도 가능하고 0 전송은 custody를 바꾸지 않으므로, 비양도 예외를 이 거부의 근거로 삼지 않고 0 전송을 허용한다. 비양도 예외가 모든 선택적 제한을 포괄한다는 판정은 아니다. [ADR-008](DECISIONS.ko.md#adr-008)

수정은 custody guard에 `value != 0` 조건을 추가한 것이다. 0 전송도 `super._update`를 거쳐 OZ의 정상 이벤트 경로를 사용한다. early return이나 수동 이벤트 우회는 없다. ABI·storage layout 변경 없이 아래 동작을 유지한다.

| 호출/조건 | 수정 후 동작 |
| --- | --- |
| 유효한 비제로 주소 간 0 transfer/transferFrom | true와 `Transfer(from,to,0)`; Vault가 from/to인 경우 포함 |
| 0 transferFrom의 allowance | 0/유한/무한 allowance에서 차감 없음. 잔액·총 공급·요청·준비금도 그대로 |
| Vault로/부터의 양수 직접 share 전송 | 기존 차단 유지; request escrow와 정산 burn은 내부 허용 경로 |
| `requestRedeem(0,...)` | `InvalidAmount`; 0 transfer로 요청이나 claim 권한을 만들지 않음 |
| zero address sender/receiver | OZ 주소 검증 유지; 0 수량이라고 허용하지 않음 |
| risk pause/shutdown | 0 전송은 계속 가능; 신규 입금 등 별도 제한은 유지 |

새 회귀 `testZeroShareTransfersEmitEventsWithoutChangingAccounting`은 기존 코드에서 실패하는 것을 확인했다. 추가 검증은 이벤트 발행 주소·from/to/value, allowance fuzz, 보관 중인 지분과 정산 burn·최종 claim, 양수 우회 차단 및 실패 시 allowance 보존, pause/shutdown, zero-address 거부를 포함한다. 실행 결과는 [STATUS](STATUS.ko.md), 완료 조건은 [STD-003](BACKLOG.ko.md#std-003)에서 관리한다.

양수 직접 전송 제한은 목적지/출처에 따른 의도적 제약으로 남아 있다. 따라서 이번 수정만으로 무제한 ERC20 전송이나 전체 ERC4626 적합성을 인증하지 않는다. 통합 코드는 출금 요청을 `RedeemRequest`와 요청 조회에서 확인하며, 0 `Transfer` 이벤트를 입금·출금 요청·custody 증가로 취급하지 않는다.

## ERC7540 대조

기준: [공식 ERC7540](https://eips.ethereum.org/EIPS/eip-7540#specification). 이 표는 이 프로젝트가 선택한 **동기 입금 + 비동기 출금** 범위다.

| 검토 영역 | 판정 | 코드/검증 근거 |
| --- | --- | --- |
| 흐름 선택 | PASS | deposit/mint 즉시 발행, requestRedeem 후 별도 claim |
| 요청 지분 custody | PASS | request escrow, fulfillment burn, claim에서 재소각 없음 |
| 요청 권한 | PASS | owner·operator 또는 share allowance, 무한 allowance 보존 |
| claim 권한 | PASS | controller/operator만 receiver 지정; allowance만으로 지급 불가 |
| requestId | PASS | 1부터 증가, controller+id로 추적; 0은 사용하지 않음 |
| Pending/Claimable 조회 | PASS | 분리·caller 독립, 미존재 ID는 0; 추가 fuzz |
| 같은 epoch 환율/시점 | PASS | 전체 epoch가 한 번에 settled, 공유 rate로 각 entitlement 계산 |
| 부분 claim | PASS | 기존 혼합 redeem/withdraw fuzz, 개인 entitlement·dust 보존 |
| 비동기 preview | PASS | previewRedeem/Withdraw의 항상 revert; 0·큰 입력·정산 후 검사 |
| controller 입금 overload | PASS | 권한·caller 자금·controller Deposit 이벤트 확인 |
| 이벤트 | PASS | RedeemRequest/OperatorSet/Withdraw topic·data 대조 |
| async deposit | N/A | 미구현, 해당 interface ID false; 결함으로 분류하지 않음 |
| 요청 취소 | N/A | 현재 미지원; 이 표준의 필수 기능으로 취급하지 않음 |

controller당 한 미완료 epoch, Idle 즉시 Claimable 후 별도 claim, 고정 수령 adapter는 프로젝트 정책/확장이다. request를 호출하자마자 자산을 사용자에게 밀어 보내는 경로는 없다.

## ERC4626 상속 범위와 예외

기준: [공식 ERC4626](https://eips.ethereum.org/EIPS/eip-4626#specification). 출금 부분은 ERC7540이 명시적으로 바꾼 의미로 검토한다.

| 검토 영역 | 판정 | 근거/제한 |
| --- | --- | --- |
| asset·metadata·share ABI | PASS | 고정 WHYPE, self-share, OZ ERC20/metadata; shares 21 decimals |
| 0 share 전송 | PASS 범위 내 | STD-C01 수정, OZ 이벤트·allowance·주소 검증 유지 |
| 양수 share 전송 | 제한 명시 | 사용자 간 가능, Vault 직접 전송은 요청 escrow 외 차단 |
| sync deposit/mint | PASS | 정확한 전송/발행, 유효 상태에서 preview와 실행량 대조 |
| deposit/mint 한도 | PASS 범위 내 | STD-F01 수정, 최소 share·cap·준비금 경계와 최대 입금/mint 실행 회귀 |
| convert·입금 preview | PASS 범위 내 | OZ floor/ceil, Active라는 이유만으로 revert하지 않음 |
| maxWithdraw/maxRedeem | PASS 범위 내 | 확정 entitlement 및 남은 claim shares, pause에도 기존 claim 가능 |
| Withdraw 이벤트·burn | PASS | ERC7540의 정산 소각/claim 지급, 동일 shares 두 번 소각하지 않음 |
| totalAssets | 제한 명시 | 기본 Active 값은 원금 추정; 실제 NAV/가격 검증과 별개 |
| permit | N/A | 선택 기능, 현재 구현하지 않음 |

ERC4626는 `totalAssets/convert*`를 추정으로 사용할 수 있다고 설명한다. 따라서 Active 원금 추정치라는 사실만으로 별도의 확정 MUST 위반을 추가하지 않았다. 다만 수익·손실을 반영한 생산용 NAV가 완성됐다는 뜻도 아니다. [해당 설명](https://eips.ethereum.org/EIPS/eip-4626#security-considerations)

non-revert view의 확인은 정상 WHYPE와 원장 불변조건이 유지되는 상태를 대상으로 했다. `availableCash`의 reserve violation 오류나 비정상 underlying 동작까지 포함한 모든 상태에서 non-revert임을 형식적으로 증명한 것은 아니다. Active 가격 개방과 source 완전성은 [NAV-001](BACKLOG.ko.md#nav-001), [VAULT-001](BACKLOG.ko.md#vault-001)에 남긴다.

## ERC7575·ERC165

[ERC7575](https://eips.ethereum.org/EIPS/eip-7575#specification)의 `share`, `vault(asset)`, `VaultUpdate`, self-share 모델을 대조했다. 정해진 asset은 해당 Vault, 다른 asset은 0을 반환한다. 다중 자산 상품을 구현했다는 의미는 아니다.

[ERC165](https://eips.ethereum.org/EIPS/eip-165#how-a-contract-will-publish-the-interfaces-it-implements)의 30,000 gas staticcall로 아래 ID를 검사했다.

| ID | 의미 | 결과 |
| --- | --- | --- |
| 0x01ffc9a7 | ERC165 | true |
| 0xe3bc4e65 | ERC7540 operator | true |
| 0x620ee8e4 | ERC7540 async redeem | true |
| 0x2f0a18c5 | ERC7575 Vault | true |
| 0xf815c03d | share→Vault lookup | true |
| 0x7965db0b | AccessControl | true |
| 0xce3bbe50 | async deposit | false |
| 0xffffffff / 0x12345678 | invalid / unknown | false |

## 표준 외의 범위

StrategyAccount, CoreWriter payload, PM attestation, keeper 진행, NAV source, 고정 beneficiary adapter, router의 native 변환은 프로젝트/프로토콜 통합 로직이다. 표준 interface 검사로 실제 Core write·실패 복구·withdrawal liveness를 검증할 수 없다. legacy `HyperCoreVault`도 새 ERC7540 Vault와 같은 적합성 대상으로 취급하지 않는다.

이 검토의 올바른 표현은 **“OpenZeppelin 기반의 ERC7540 비동기 출금 구현이며, 확인한 입금 한도 불일치와 0 share 전송 제약을 수정했다. 양수 직접 전송 제한은 명시적으로 남아 있다”**다. 테스트 실행 수·명령·크기는 [STATUS](STATUS.ko.md), 후속 작업은 [BACKLOG](BACKLOG.ko.md)가 관리한다.

<a id="managed-asset-vault"></a>
## ManagedAssetVault / ManagedRedeem (HyperVault 배포 계약) 대조 — 2026-10-12

위 판정은 `AsyncHypeVault`/`EpochRedeem` 대상이다. 이 절은 메인넷에 배포한 [ManagedAssetVault](../src/ManagedAssetVault.sol)·[ManagedRedeem](../src/managed/ManagedRedeem.sol)을 [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540)·ERC-4626·ERC-7575와 대조한 기록이다. 코드 대조와 메인넷 Vault `0x46c0e94C07111390d7B1F49147AB397B2d991eAe`의 실제 호출(run 1~3)을 근거로 한다. 독립 감사나 형식 검증은 아니다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 비동기 출금 요청 `requestRedeem(shares, controller, owner)` → 고유 requestId, 지분 escrow, `RedeemRequest` 이벤트 | PASS | run 2·3 요청 거래, 요청 직후 지갑 지분 0 |
| owner ≠ msg.sender일 때 operator 승인 또는 ERC-20 allowance 요구 | PASS | `isOperator` 확인 후 `_spendAllowance` |
| Pending → Claimable 단방향 전이, `pendingRedeemRequest`/`claimableRedeemRequest` 상호 배타 | PASS | run 3: 요청 직후 pending 10e9·claimable 0, 정산 후 pending 0·claimable 10e9 |
| `maxRedeem`/`maxWithdraw` = 청구 가능량, `redeem`/`withdraw`로 claim(controller 또는 operator), 부분 claim | PASS | run 3 `maxWithdraw` 10.000000 → claim 10 USDC |
| `previewRedeem`/`previewWithdraw`는 비동기라 revert | PASS | 메인넷 호출 `AsyncPreviewUnsupported` |
| `setOperator`/`isOperator`, `OperatorSet` 이벤트 | PASS | 코드 |
| ERC-165: 7540 redeem `0x620ee8e4`, operator `0xe3bc4e65`, ERC-7575 `0x2f0a18c5`, ERC-165 true; async deposit `0xce3bbe50` false | PASS | 메인넷 `supportsInterface` 호출 |
| ERC-7575 `share()` = Vault, `vault(asset)` = Vault | PASS | 메인넷 호출 |
| 입금은 동기 ERC-4626(`deposit`/`mint`), `maxDeposit`은 실제 가능 한도(닫힘이면 0) | PASS | run 3 Idle·Active 입금, NAV 차단 중 `maxDeposit` 0 |
| controller ≠ owner 요청 | 제한 | `InvalidReceiver`로 거부. 표준 흐름의 일부를 지원하지 않는다 |
| controller당 미결 요청 1건 | 제한 | `OutstandingRequest`. 같은 controller의 추가 요청은 앞 요청 claim 뒤 |
| 지분 양도 | 제한(COMPAT) | 0이 아닌 사용자 간 전송은 `NonTransferableShares`. 지분 토큰을 DeFi에 조합할 수 없다 |
| `totalAssets`/`convertTo*` 무revert | **불일치** | ERC-4626은 overflow 외 revert하지 않을 것을 요구한다. 이 Vault는 NAV를 검증할 수 없을 때(가격 이력 부족, 하락 대기, 대기 중 Core 액션, Exiting) 의도적으로 revert해 발행을 닫는다. 통합자는 `maxDeposit`으로 개폐를 확인해야 한다 |
| Active 중 즉시 지급 | 표준 밖 | 7540은 요청과 claim 사이 시간을 정하지 않는다. 이 Vault의 Claimable 전환은 owner의 exit·전체 청산·회수·정산에 달려 있고 사용자가 강제할 수 없다(신뢰 경계) |

정리: 출금은 **ERC-7540 비동기 요청 → 정산 → claim** 흐름을 따르고 메인넷에서 세 번 확인했다. 표준 위반으로 볼 수 있는 것은 `totalAssets`/`convertTo*`가 NAV 검증 불가 시 revert하는 점이며 의도한 설계다. 그 밖의 제한(controller=owner, 요청 1건, 양도 불가)은 표준이 허용하는 범위의 축소로 기록한다.

<a id="hypervault-v2"></a>
## HyperVault v2 (매니저 + 지분 토큰 + 어카운턴트) 대조 — 2026-10-12

[HyperVault](../src/hypervault/HyperVault.sol)·[HyperVaultShare](../src/hypervault/HyperVaultShare.sol)·[HyperVaultAccountant](../src/hypervault/HyperVaultAccountant.sol)를 같은 기준으로 대조했다([ADR-037](DECISIONS.ko.md#adr-037)). 근거는 코드, `test/HyperVault.t.sol` 20개, 메인넷 v2 run 1(Vault `0x4Dd7a7ECB3Bc91792b83e0Ee5fFb5b0E7fF9C58B`)이다. 독립 감사가 아니다. 별도 리뷰 에이전트가 두 번 검토했고 지적 F1(타인 controller에 dust 요청으로 출금 차단)·F2(지연된 수수료를 입금자가 부담)를 수정한 뒤 승인했다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| ERC-7575 분리 share: `share()` = 별도 ERC-20, Vault는 `asset()`·`totalAssets`·`convertTo*`·입출금 담당 | PASS | 메인넷 `share()` = `0xfe226f…c065`, `share.vault()` = Vault |
| 지분 양도 | PASS(해소) | 일반 ERC-20 전송. 메인넷에서 3e9 전송 뒤 수령자가 그 지분으로 출금 요청·claim |
| `totalAssets`/`convertTo*` 무revert | PASS(해소) | Active는 어카운턴트의 마지막 검증 환율(`marks.updatedAt`으로 신선도 확인), Idle은 현금. 발행 판단은 revert하는 `liveNav()`가 맡는다. 시험: Core 액션 대기 중에도 응답 |
| `previewDeposit`/`previewMint` = 실제 결과 | PASS | 수수료 선정산 포함. 메인넷 Active 입금 preview 9,638,553,471 = 발행량 |
| controller ≠ share owner 요청 | PASS | allowance 또는 operator로 owner 지분 escrow. 단 호출자는 controller 또는 그 operator여야 한다(F1 수정) |
| controller당 미결 요청 | 제한(완화) | 1건. 같은 열린 epoch의 추가 요청은 합쳐진다. 정산 후 미청구 요청이 있으면 `OutstandingRequest` |
| Pending → Claimable, preview 출금 revert, operator, ERC-165 | PASS | v1과 같은 구조. 메인넷: 요청 직후 pending 12.64e9·claimable 0, 정산 후 claimable |
| 공유 지분 가격 | 설계 | epoch의 모든 지분이 같은 가격을 받는다. 사용자별 원가·손실 이월은 없다 |
| 지분 토큰의 `vault(asset)` 조회·`VaultUpdate` 이벤트(7575 SHOULD) | 미구현 | 토큰은 `vault()`만 제공 |
| Active 중 즉시 지급 | 표준 밖 | v1과 같다. owner의 exit·청산·회수·정산 필요(신뢰 경계) |

v3 배포는 같은 HyperVault·Share·Accountant 계약에 owner 신뢰 NAV 모듈([ADR-038](DECISIONS.ko.md#adr-038))을 붙인 것이라 위 판정이 그대로 적용된다. 차이는 발행·정산이 급락 대기·가격 이력·신고에 막히지 않는다는 점이며 표준 항목에는 영향이 없다.

정리: v1의 불일치(`totalAssets`/`convertTo*` revert)와 제한(양도 불가, controller=owner)은 해소했다. 남은 것은 7575 share 쪽 SHOULD 항목과 owner 협조형 Active 출금이다.
