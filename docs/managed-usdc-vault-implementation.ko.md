# Managed USDC Vault 현행 구현

2026-10-04. 코드·ABI·회계의 관리 원본. [설계](managed-usdc-vault-architecture.ko.md), [결정](DECISIONS.ko.md#adr-025), [실행 결과](STATUS.ko.md), [메인넷 시나리오](managed-mainnet-scenarios.ko.md)를 함께 본다. NAV·액션·종료 검증은 [precompile 검증기](managed-precompile-nav.ko.md)가 맡으며 **통제 왕복으로 검증되지 않았고** 메인넷 배포 완료 상태가 아니다. 이전 `AsyncUsdcVault`는 별도 Strategy형 비교 구현으로 유지한다.

## 계약과 권한

| 파일 | 책임 |
| --- | --- |
| [ManagedUsdcVaultFactory](../src/ManagedUsdcVaultFactory.sol) | 공개 생성, 창설자 자금 수령, 고정 owner, 등록부. 생성 코드 조각으로 배포 크기 제한 대응 |
| [ManagedUsdcVault](../src/ManagedUsdcVault.sol) | Vault 자신의 Core 관리, 활성화, 동기 지분, Idle 및 검증된 Ready/Active 입금 경로, 회수·정산 |
| [ManagedRedeem](../src/managed/ManagedRedeem.sol) | ERC4626 기반 지분, ERC7540 요청, 원가·수수료·준비금 |
| [ManagedCoreActions](../src/managed/ManagedCoreActions.sol) | action 9/12/13 인코딩; action 15/16은 기존 CoreActions 사용 |
| [ManagedUpgradeController](../src/managed/ManagedUpgradeController.sol) | Vault별 owner의 업그레이드 제안·취소·48시간 지연 실행 |
| [IManagedVaultVerifier](../src/interfaces/IManagedVaultVerifier.sol), [IManagedNavVerifier](../src/interfaces/IManagedNavVerifier.sol) | Vault가 immutable `verifier`에 요구하는 액션·종료·NAV 인터페이스 |
| [ManagedPortfolioNavVerifier](../src/managed/ManagedPortfolioNavVerifier.sol), [HyperCorePrecompileSource](../src/nav/HyperCorePrecompileSource.sol) | 그 인터페이스의 온체인 관측 구현과 Vault별 등록 범위. [명세](managed-precompile-nav.ko.md). test mock은 Vault 회계 시험 전용 |

`Vault proxy 주소 == Core 계정 == CoreWriter caller`다. 일반 CALL로 다른 모듈에 CoreWriter 실행을 맡기지 않는다. Solidity 라이브러리·상속·proxy delegatecall은 proxy 주소를 유지한다. Factory·운용 implementation·upgrade controller 주소에 예치하지 않는다.

Factory 호출자가 owner다. owner는 API wallet을 발급받는 별도 체인 절차 없이 **오프체인에서 Vault 전용 키를 생성하고 주소만 등록**한다. 키·개인키는 컨트랙트에 저장하지 않는다. API 정보 조회 대상은 Vault proxy다. 해당 agent는 일반 Core master 계정을 대신 서명하므로 native Hyperliquid Vault용 `vaultAddress` 라우팅을 설정하지 않는다.

## 생성과 초기화

```solidity
createVaultAndFund(uint256 maxActivationCost)
createVaultAndFund(uint256 maxActivationCost, uint16 feeBps, uint256 minimumDeposit)
createVaultAndFund(string vaultName, uint256 maxActivationCost, uint16 feeBps, uint256 minimumDeposit)
```

기존 두 overload는 기본 이름을 유지한다. 세 번째는 생성 시 이름까지 지정한다. `setVaultName(string)`은 owner 전용이며 운용 중에도 변경할 수 있다. 이름은 proxy storage의 마지막에 추가했고 UTF-8 문자열의 bytes 길이 1~96, 앞뒤 ASCII 공백·ASCII 제어문자 금지다. configHash·금융 권리는 바꾸지 않는다. 이전 storage가 비어 있으면 기본 이름을 반환한다. `bootstrap()` 호환 selector도 유지한다.

첫 overload는 Factory 기본 설정을 사용한다. 배포 스크립트 기본값은 성과수수료 1,000 bps, 최소 입금 10e6 USDC다. 두 번째는 생성자가 조건을 고른다. 성과수수료는 0~10,000 bps, 최소 입금은 1 USDC 최소 단위 이상이고 Vault cap 이하다. 10,000 bps는 **원금이 아니라 과금 대상 수익 전부**를 뜻한다. 플랫폼은 성과수수료의 2,000 bps를 받는다.

생성 거래에서 controller·implementation·OZ TransparentUpgradeableProxy/ProxyAdmin을 만들고 Factory가 `bootstrap(vaultName)`한다. 초기화는 Factory만 1회 가능하며 implementation 자체의 bootstrap은 거부한다. proxy 생성과 자금 납입이 하나의 거래이므로 외부 초기화 선점 구간이 없다.

실제 EVM 수령액 `100e6 + activationCost`를 확인하고 창설자에게 `100e9` share와 `100e6` 원가를 기록한다. Vault의 Circle `deposit(gross, uint32.max)`가 실제 전액을 차감해야 전체 거래가 성공한다. 정확한 allowance만 설정한 뒤 0으로 지운다. 1 USDC 활성화 예산이면 gross 101이며 **실제 spot 순수령이 100인지는 실측 대상**이다. 비용은 share 원가에 더하지 않는다.

`AwaitingActivation → finalizeActivation(proof) → Ready`에서 Core 준비 상태만 확인하고 share를 다시 발행하지 않는다. 후속 Core 실패는 이미 성공한 EVM 생성 거래의 소급 revert가 아니다.

## 상태와 가격

```text
Uninitialized → AwaitingActivation → Ready → Active → Exiting → Idle
                                                        ↑        │
                                                        └ Active ←┘
```

Ready는 초기 자금이 Core에 있는 상태다. Ready/Active에서는 `verifier.verifyNav`가 값을 반환할 때만 `totalAssets()`와 입금이 동작한다. precompile 검증기를 연결한 Vault는 owner가 평가 범위를 등록하고 켠 뒤부터 가격이 나온다. 평가 구조·식·한계는 [precompile NAV 명세](managed-precompile-nav.ko.md)가 관리한다.

**현재 확정 가치:** Idle에서 `totalAssets() = accountedCash − reservedClaimAssets`. 직접 USDC 송금은 `unaccountedUsdc()`에만 표시하며 가격·cap·운용 자금에서 제외한다. 실제 잔액이 장부보다 작으면 중단한다. 기존 claim 준비금에는 아직 지급하지 않은 사용자 순수령·운용자 및 플랫폼 fee·반올림 dust가 포함된다.

일반적인 설명상의 1 share 가격은 `주주 순자산 / 유통 share`다. 실제 입금은 OZ의 virtual asset/share를 포함해 `floor(입금 USDC × (shareSupply + 1000) / (totalAssets + 1))`로 계산한다. USDC는 6자리, share는 9자리다. 예를 들어 주주 순자산 120 USDC, share 100개면 경제적 가격은 약 1.2 USDC/share다. 개인별 성과수수료 차이는 공통 NAV에서 일괄 차감하지 않고 각 출금 요청의 원가·손실 이월로 계산한다.

**Active 가치평가:** `주주 NAV = Vault.availableCash() + 등록 범위의 Core 순자산`이다. Core 순자산은 spot·lending·DEX별 equity·HyperCore vault equity를 한 번씩 더한 값이며 계정 equity에 이미 들어 있는 담보·PnL·funding을 다시 더하지 않는다([평가식](managed-precompile-nav.ko.md#평가식)). `managedPrincipal`은 배정 원금 메모이며 NAV가 아니다. 검증기의 실패는 그대로 revert한다. Exiting/비활성 및 Core pending은 `NavUnavailable`이다. `maxDeposit`은 NAV 실패에서 용량 0을 반환한다. [NAV-001](BACKLOG.ko.md#nav-001)

## 입금과 커스텀 조건

Idle 또는 검증기가 NAV를 반환하는 Ready/Active에서 `deposit`, `mint`, controller overload, `depositWithLimit(assets, receiver, minShares, deadline)`를 제공한다. 최소 금액은 **매 입금의 실제 USDC**에 적용하고 창설자 100 USDC bootstrap에는 적용하지 않는다. cap 잔여가 최소 입금보다 작으면 `maxDeposit/maxMint=0`이다. NAV를 얻을 수 없는 운용 중(범위 미등록·비활성·조회 실패), Exiting, 업그레이드 제안 중 또는 Core 관리 액션 pending 중에는 신규 입금을 닫는다. 실제 USDC 수령 전에 가격을 계산하고 즉시 share를 발행한다. 새 현금은 EVM에 남아 후속 owner 배정에 사용한다. [구현·시험 경계](managed-precompile-nav.ko.md)

`setDepositTerms(uint16 feeBps, uint256 minimum)`은 Idle의 owner 전용이다. 최소 입금은 변경할 수 있다. 성과수수료율은 **남은 share와 확정 준비금이 모두 0인 경우만** 변경할 수 있다. 기존 투자자의 누적 수익에 인상된 요율을 소급 적용하지 않는다. 이미 만들어진 요청에는 `feeBps`를 별도 고정한다. 사용자 손실 이월·수수료 소수 잔여는 전액 출금 뒤에도 유지한다.

## 관리 함수

| owner 전용 함수 | 동작 |
| --- | --- |
| `setApiWallet(agent)` | 단일 unnamed 슬롯 action 9. owner 개인 계정이 아닌 Vault agent 등록/교체 |
| `revokeApiWallet()` | 같은 슬롯을 Vault별 hash-derived 비서명 주소로 교체. Core 적용을 확인해야 해지 완료 |
| `depositToCore(evmAmount)` | 준비금 제외 주주 현금만 Circle로 배정 |
| `recallUsdcFromCore(sourceDex, evmAmount)` | action 13, USDC system 목적지와 동일 Vault EVM 귀속 고정 |
| `transferWithinCore(token, sourceDex, destinationDex, coreAmount)` | 같은 Vault 계정 내 이동 |
| `supplyToLending`, `withdrawFromLending`, `withdrawAllFromLending` | action 15. 일반 amount=0 거부; 전액 회수는 별도 명시 함수 |
| `setAbstraction(mode)` | action 16, 대상 user=Vault |
| `approveBuilderFee(maxFeeRate)` | action 12, 생성 시 builder와 상한 안에서만 승인 |
| `beginExit(epoch)` | 요청 epoch를 봉인하고 운용 정리 단계로 이동 |

USDC 왕복은 EVM6→Core8로 내부 변환한다. 일반 token/lending 입력은 해당 token의 Core 단위다. builder fee는 성과수수료와 별개이며 승인만으로 모든 주문에 부과되지 않는다. `apiWallet` 저장값은 **검증된 등록 상태**다. 제출 직후에는 바꾸지 않는다. 폐기 키 재사용을 거부하고, 키 교체만으로 열린 주문이 취소됐다고 가정하지 않는다.

## 증거와 정산

관리 액션은 1개 pending으로 직렬 처리한다. digest에 chain/vault/nonce/kind/amount/agent/Core 제출 블록/payload hash를 넣고 `syncCoreAction(id, proof)`에서 검증한다. 성공·최종 실패와 unknown/pending을 구분한다. Core 블록은 제출보다 나중이며 현재 read를 초과할 수 없다. recall의 귀속 금액만 장부 현금으로 편입하고 실제 ERC20 잔액도 대조한다.

`settleEpoch(epoch, proof)`는 누구나 호출할 수 있지만 Exiting, pending 없음, 등록 agent 없음과 `verifier.verifyIdle`의 통과가 필요하다. **HTTP 잔액 조회나 owner가 입력한 성공 bool은 쓰지 않는다.** precompile 검증기의 판정 규칙(뒤의 Core 블록, 실제 도착한 장부 밖 USDC만 편입, 등록 범위 flat·dust 상한)과 관측할 수 없는 범위(Core 쪽 거절, 미등록 노출, 열린 주문)는 [명세](managed-precompile-nav.ko.md#액션-최종성)에 있다. `MockManagedVerifier`는 Vault 회계 시험에서만 결과를 주입한다. 메인넷 Core 액션 통제 실험은 남아 있다.

사용자별 `requestRedeem(shares, controller, shareOwner)`는 고유 ID를 만들고 내부 epoch에 합산한다. controller=shareOwner, 주소당 미완료 요청 1개, 양수 share 직접 전송 금지다. Idle 요청은 즉시 claimable, 운용 중 요청은 owner의 정리·회수 뒤 claimable이 된다. owner 협조 없는 모든 시장 강제 종료는 제공하지 않는다.

epoch는 실현 현금으로 gross 준비금을 잠그고 escrow share를 burn한다. 전체 share 출금 시 모든 주주 현금을 비례 정산하고 부분 출금은 OZ virtual 비율을 쓴다. 요청의 gross·요율·원가는 고정되며 첫 claim 시 수수료·손실 이월을 저장한다. 주소당 요청 1개라 적용 순서가 바뀌지 않는다. 사용자별 원가·손실 이월·수수료 소수 carry와 **Vault 전체 플랫폼 소수 carry**를 유지한다.

부분 claim은 누적 순수령·누적 수수료에서 기지급액을 빼 최종 지급액을 보존한다. `withdraw(assets)`의 assets는 정확한 순수령이다. sub-share 반올림으로 요청한 assets에 대응하는 새 share가 없거나 마지막 share를 너무 일찍 소비하는 경우 거부하므로 작은 잔여분은 `redeem(remainingShares)`로 청구한다. 전손도 0 USDC redeem으로 요청을 닫을 수 있다. 모든 사용자·manager·treasury 지급은 한 거래이고 어느 전송이 실패해도 전부 되돌린다. 마지막 claim 후 정수 dust는 계속 격리하며 `releaseRoundingDust()`로 고정 treasury에 보낸다.

## 업그레이드

OZ 5.4.0 `TransparentUpgradeableProxy + ProxyAdmin`과 Vault별 controller를 사용한다. controller owner 기본안은 해당 Vault owner이며 Factory는 기존 Vault 업그레이드 권한을 갖지 않는다. controller는 `propose(newImplementation, migrationData)`로 codehash와 calldata hash를 고정하고 **48시간 이후·검증된 Idle**에서 `execute(migrationData)`한다. 미정산 Core 액션·등록 agent가 있으면 거부한다. 대기 중 신규 입금·새 운용을 닫지만 요청/확정 claim과 Exiting의 회수는 유지한다. owner는 제안을 취소할 수 있다.

**implementation은 Vault마다 별도 배포한다.** 이 버전은 OZ ERC4626의 immutable asset과 owner/config를 사용하므로 공유 implementation을 복제하는 템플릿이 아니다. proxy의 ERC20 잔고·원가·요청·준비금은 storage에 있고, 이름/심볼은 명시 override한다. bootstrap에서 proxy의 request/epoch 시작값과 입금 조건을 초기화한다. ReentrancyGuard의 proxy 초기 0 값은 NOT_ENTERED와 마찬가지로 첫 진입을 허용한 뒤 표준 상태로 바뀌며 초기화/재진입 경로를 유지해야 한다.

새 implementation은 **원래 생성 Config 전체**를 그대로 받아 동일 configHash를 반환해야 한다. 바뀐 `setDepositTerms` 값은 proxy storage로 보존하며 새 constructor 값으로 덮지 않는다. `disabledAgent()`는 실행 중인 proxy 주소에서 유도하므로 구현 교체로 바뀌지 않는다. 마이그레이션은 ProxyAdmin 문맥으로 실행되므로 별도 접근 제어와 재초기화 방지가 필요하다.

기계적 layout 검사와 V2 회귀는 [검증 스크립트](../scripts/test_managed.sh)에 있다. baseline은 [storage fixture](../test/fixtures/managed-storage-v1.json)다. 기존 변수 순서·타입·mapping struct를 바꾸거나 부모 storage를 끼워 넣으면 안 된다. `configHash`를 반환하는 악성 코드까지 자동 검증할 수는 없으므로 **업그레이드 권한에 대한 owner 신뢰**도 상품에 포함된다. 기존 claim을 임의 코드 변경으로부터 절대적으로 보호하는 구조라고 표시하지 않는다. 실제 새 버전마다 독립 검토·layout·회귀·회수 시나리오를 다시 수행한다.

## 기본 FE

[frontend](../frontend/README.ko.md)는 데모와 실제 계약 연결을 구분하며 생성/입금/request/claim/owner 관리를 제공한다. 실제 모드는 배포 설정과 지갑을 사용하고, 평가 불가를 NAV 0으로 표시하지 않는다. 평가 범위 등록 화면은 아직 없다. 검증기가 통제 왕복으로 검증되기 전에는 UI만으로 실자금 기능이 개방되지 않는다.
