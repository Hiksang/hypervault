# USDC ERC-7540 Vault 구현 명세

최종 갱신: 2026-10-04 KST. [AsyncUsdcVault](../src/AsyncUsdcVault.sol)와 [Strategy 경계](../src/interfaces/IUsdcCycleStrategy.sol)의 **현재 로컬 구현**을 설명한다. 제품 목표는 [설계 결정](DECISIONS.ko.md)과 [ADR-023의 관리 함수 아키텍처](managed-usdc-vault-architecture.ko.md), 진행 상태는 [STATUS](STATUS.ko.md), 미완료 조건은 [USDC-001/002](BACKLOG.ko.md#usdc-001), [FACTORY-001](BACKLOG.ko.md#factory-001), [FEE-001](BACKLOG.ko.md#fee-001), [MARKET-001/002](BACKLOG.ko.md#market-001)이 관리한다. 이 계약은 통제된 mock 검증 단계이며 실자금 배포 후보가 아니다.

**목표와 현재 코드의 차이:** [ADR-014](DECISIONS.ko.md#adr-014)·[ADR-021](DECISIONS.ko.md#adr-021)·[ADR-023](DECISIONS.ko.md#adr-023)은 누구나 자신이 owner인 Vault를 생성하고 **Vault 주소 자체를 Core 계정**으로 쓰며 창설자 EVM USDC로 초기 자본·활성화를 조달하도록 정했다. owner는 typed 관리 함수를 호출하고 agent는 API 주문을 보낸다. 아래 함수 설명은 아직 별도 Strategy 주소를 쓰는 기존 `AsyncUsdcVault`의 실제 동작이다. 이 코드를 같은 주소 배포 또는 공개 생성이 가능한 것으로 해석하지 않는다. 단일 주소로 이전할 때 `startCycle`의 수신자, CoreWriter caller, owner 권한, 역방향 회수·정산, factory binding·activation gate와 비요청 자산 장부를 다시 구현하고 검증해야 한다.

**성과 수수료 미구현:** [ADR-016](DECISIONS.ko.md#adr-016)의 다른 사용자 출금 이익 10%와 [ADR-017](DECISIONS.ko.md#adr-017)의 운용자 80%·플랫폼 20% 배분은 이 계약에 없다. 현재 `EpochRedeem`은 같은 epoch의 모든 controller에 동일 외부 요청 ID와 환율을 쓰고, share 양도도 허용한다. 사용자별 원가·손실 이월·고유 요청 ID·Claim 시 사용자/운용자/플랫폼 분할이 필요하다. [목표 수수료 명세](performance-fee-architecture.ko.md)를 현재 ABI로 해석하지 않는다.

**생성자 자기자본 미구현:** [ADR-021](DECISIONS.ko.md#adr-021)의 생성 거래 내 Vault 배포·창설자 EVM USDC 100 수령·즉시 share 발행·Vault 자신의 Core 입금 호출과 후속 Core activation gate·비동기 실패 복구는 이 계약에 없다. 현재 별도 Strategy `bindStrategyOnce`로 `Idle`이 되면 일반 입금이 가능하고, Core 창설자 bootstrap 경로는 없다.

**후속 구현:** 단일 주소 공개 Factory·owner/API 관리·수수료·업그레이드는 별도 [Managed USDC 명세](managed-usdc-vault-implementation.ko.md)에 구현했다. 아래의 미구현 표현은 이전 `AsyncUsdcVault` 계약에 대한 설명이다.

## 구현된 흐름

- ERC20/4626 지분은 `hcUSDC`, 입출금 기초자산은 6자리 ERC20 USDC, share는 9자리다. 기존 `hcHYPE`와 별도 계약·지분이다. 공통 [EpochRedeem](../src/vault/EpochRedeem.sol)의 이름/심볼 생성자만 일반화했고 기존 WHYPE 배포 ABI·이름은 유지했다.
- Strategy는 지정한 factory만 `bindStrategyOnce`로 연결할 수 있다. `vault()`·`asset()`·`configHash()`를 대조한다. 실제 배포용 새 Factory와 시장별 Strategy 구현은 아직 없다.
- `Idle`에서 `deposit/mint`는 사용자가 승인한 USDC를 Vault가 실제로 전액 받았을 때 지분을 발행한다. `depositWithLimit`/`mintWithLimit`은 최소 지분 또는 최대 USDC와 기한을 검사하며 실패 시 입금 전체를 되돌린다. cap, 0 share 발행, 위험 일시정지, 전손 후 잔존 지분에 신규 자금을 얹는 입금을 거부한다. Active/Exiting 입금은 허용하지 않는다.
- manager의 `startCycle(assets)`는 미예약 USDC만 사용한다. 정확한 allowance를 `CoreDepositWallet`에 주고 `depositFor(strategy, assets, destinationDex)`를 호출하며 실제 EVM 차감액을 대조하고 allowance를 0으로 되돌린다. `destinationDex`는 생성 시 spot 또는 기본 perp 중 하나로 고정한다. 이 호출의 성공은 Core credit·시장 주문 가능 상태의 증명이 아니다.
- `requestRedeem`은 지분을 escrow하고 ERC7540 Pending으로 기록한다. cycle 종료 후 누구나 `beginExit`을 호출해 epoch를 봉인한다. 지정 guardian은 조기 종료할 수 있고 pause 상태는 Strategy에도 전달한다. `strategy.returnReady(cycleId)`가 true일 때만 `settleEpoch`가 Strategy의 `returnToVault`를 호출하고 **실제 Vault USDC 증가량**과 반환값을 대조한다. 그 뒤 동일 epoch 가격으로 준비금을 확정한다. 사용자는 별도 `redeem/withdraw`로 USDC를 청구한다. Idle/Closed 요청은 즉시 Claimable이 되지만 청구 호출은 여전히 별도다.
- `accountedCash`는 `deposit/mint`의 정확한 USDC 수신과 Strategy 반환의 정확한 USDC 수신으로 증가하며 Core 배정·claim·rounding dust 지급으로 감소한다. `availableCash = accountedCash - reservedClaimAssets`다. 실제 잔액이 장부 미만이면 `AccountedCashDeficit`로 중단한다. 누구나 ERC20 `transfer`로 Vault에 직접 보낸 USDC는 `unaccountedUsdc = balanceOf(Vault) - accountedCash`로 관측되며 지분 가격·입금 한도·epoch 지급액·다음 cycle 배정에 포함되지 않는다. 다른 ERC20 송금도 USDC 자산이 아니다. 직접 송금분의 회수/귀속 함수는 아직 없으므로 Vault에 남는다.
- `reservedClaimAssets`는 `availableCash`, 다음 cycle 배정, 주주 `totalAssets`에서 제외한다. `totalAssets`의 Active/Exiting `capitalEstimate`는 **원금 추정치**이며 시장 NAV·활성 입금 가격이 아니다. 목표 운용 buffer 0과 확정 claim 준비금은 다른 항목이다.

## 정산 신뢰 경계와 미구현

`IUsdcCycleStrategy.returnReady`는 실제 Core spot·기본/HIP-3 perp·HIP-4 outcome의 주문/포지션/부채/담보/만기·정산, 인플라이트, 반환 가능 USDC와 pending 액션을 모두 검증해야 한다. 현재는 **인터페이스와 test mock만** 있으며 그 증명·시장별 거래·CoreWriter USDC 회수·Core credit 자동 관측·생산용 NAV source는 구현되지 않았다. 악의적이거나 불완전한 Strategy를 연결하면 Vault의 반환 조건은 안전하지 않다. `bindStrategyOnce`의 주소 검사는 경제적 안전성 검증이 아니다. 새 Factory, 통제 네트워크 왕복, 시장별 terminal/회수 관측, 독립 검토가 완료되기 전 실자금 입금을 열지 않는다.

**Core/Strategy 수신 경계:** 제3자가 `depositFor`로 Strategy의 Core USDC를 늘리거나 Core 자산을 직접 보낼 수 있다. Vault의 `accountedCash`는 이를 검증하지 못한다. Core 잔액 단독 증가는 이번 cycle 원금의 도착 또는 운용 수익이라는 증거가 아니다. 생산용 Strategy는 예상 credit과 외부 증가를 분리하고, cycle/action 및 전후 상태에 더해 출처를 연결하는 증거를 확인해야 한다. 동액 외부 입금이 끼어들면 전후 잔액 차이만으로 귀속을 알 수 없다. 미확인 Core 토큰은 주문·NAV·출금 정산에서 제외하거나 안전하게 중단해야 한다. Strategy EVM 주소로 직접 보낸 USDC가 `returnToVault`에 섞이지 않도록 회수 수령분도 구분해야 한다. 현 test mock은 자신의 EVM 잔액 전체를 반환하므로 이 공격을 방어하는 구현으로 해석하면 안 된다.

로컬 [USDC 테스트](../test/AsyncUsdcVault.t.sol)는 6자리 입금과 9자리 지분, Circle 인터페이스를 흉내 낸 `depositFor`의 정확한 차감, Pending→Claimable→claim, 두 사용자 동일 epoch 손실 배분, 준비금 재투자 차단, 미인출/잘못된 반환값 차단, 전손 뒤 재입금 차단, 가격/기한 보호, guardian pause/exit, Vault 직접 USDC 송금의 가격·cap·배정·정산 격리와 장부 결손 시 중단을 재현한다. mock의 `complete()`는 Core의 실제 체결·반환 증거가 아니다. 실행 결과와 빌드 크기는 [STATUS](STATUS.ko.md)에서 관리한다.
