# HyperCoreVault 구현 및 호출 가이드

이 문서는 legacy `HyperCoreVault`의 당시 동작을 보존하는 이력 자료다. 최신 검증 상태는 [STATUS](STATUS.ko.md), 신규 `AsyncHypeVault` / `HyperCoreStrategyAccount` 호출법은 [분리 구현 명세](split-implementation.ko.md)를 따른다. 이 문서의 당시 차단점을 현재 분리 구조의 진행 상태로 해석하지 않는다.

## 구현 목표

현재 버전은 WHYPE/native HYPE를 받는 custom ERC20 share vault다. 운용 중 HyperCore NAV를 추정해 즉시 상환하지 않고, 출금 epoch가 열리면 전략 전체를 청산·회수한 실제 WHYPE 잔액으로 정산한다. 따라서 ERC-4626이나 ERC-7540 준수를 표방하지 않는다.

전략은 다음 1x carry다.

1. vault의 WHYPE를 unwrap하고 vault 자신의 HyperCore 계정으로 보낸다.
2. action 15로 HYPE를 lending supply에 넣는다.
3. 입금 HYPE와 같은 수량의 HYPE perp short를 IOC로 연다.
4. exit 때 reduce-only IOC로 포지션을 0으로 만든다.
5. PM에 USDC debt가 있으면 필요한 HYPE만 회수·매도해 0 debt를 확인한다.
6. HYPE/quote lending supply를 회수하고 quote profit을 HYPE로 바꾼다.
7. action 13으로 HYPE를 EVM에 recall하고 WHYPE로 감싼 뒤 epoch를 정산한다.

Action 15는 Supply/Withdraw만 제공한다. 이 버전은 spot 매수로 의도적인 USDC auto-borrow를 만들지 않는다. 레버리지 carry는 별도의 debt cap, liquidation 경로, delayed-order 중복 방지가 필요하다.

## 상태 전이

```text
Idle
  -> BridgePending
  -> SupplyingCollateral
  -> OpeningHedge
  -> Active
  -> ClosingHedge
  -> SettlingDebt
  -> WithdrawingCollateral
  -> ConvertingQuote
  -> Recalling
  -> RecallPending
  -> Idle
```

CoreWriter 호출 성공은 Core 실행 성공이 아니다. `PendingAction`은 제출 L1 block과 source-side 상태를 저장하고, 더 새로운 L1 read에서 실제 감소·증가를 확인한 뒤에만 지운다. 동시에 하나의 action만 outstanding일 수 있다.

> **현재 초기화 차단점:** 아래 초기화 순서는 구현된 코드의 동작을 설명하지만 신규 vault에서는 PM 자격과 맞지 않는다. 거래량이 없는 contract master는 PM 전환 전에 Core account value `>$10k`를 충족해야 한다. 현재 코드는 PM 확인 뒤에만 share-backed HYPE를 bridge하므로 그대로 배포할 수 없다. `bootstrap bridge → PM 제출/확인 → supply/short`와 실패 시 recall/환불 상태를 먼저 추가해야 한다.

## 역할별 호출

배포·운영자는 다음 순서로 초기화한다.

1. 외부 Core 계정이 vault 주소에 quote token을 보내 신규 계정의 1 quote-token activation fee를 지불한다. `seedCoreAccount()`의 HYPE 후원만으로 activation이 보장된다고 가정하지 않는다.
2. 한 EVM/Core block 이상 기다린 뒤 `userExists`를 확인한다.
3. 현재 코드를 수정한 뒤, vault가 `Idle`일 때 share-backed HYPE를 먼저 bootstrap bridge해 PM account-value 자격을 충족한다.
4. action 16을 제출하고 공식 API `userAbstraction`으로 실제 PM 활성화를 확인한다.
5. PM 성공 확인 후에만 action 15와 action 1 경로를 연다. PM이 bridge HYPE를 자동 supply했는지는 spot/lending state를 함께 읽어 판단한다.

사용자 함수:

- `deposit(assets, receiver, minShares)`: WHYPE 입금
- `depositHype(receiver, minShares)`: native HYPE 입금
- `redeem(shares, receiver, owner, unwrapNative, minAssets)`: `Idle`일 때 동기 상환
- `requestRedeem(shares, receiver, owner, unwrapNative)`: `Active` epoch에 share 잠금
- `cancelRedeem(requestId)`: exit 시작 전 owner가 취소
- `claimRedeem(requestId)`: 누구나 실행할 수 있지만 저장된 receiver로만 지급

keeper 또는 일반 사용자가 실행할 수 있는 함수:

- `observeBridgeAndSupply()`
- `processOpeningHedge()` / `activateStrategy()`
- cycle 종료 후 `beginExit()`
- `processHedgeClose()`
- `processDebtSettlement()`
- `recapitalizeDebt()`: Core collateral만으로 debt를 갚을 수 없을 때 unreserved EVM WHYPE 중 계산된 부족분만 Core로 보충. 목표 Core spot 잔액이 관측되기 전에는 재호출과 debt 매도를 거부한다.
- `processCollateralWithdrawal()`
- `processQuoteConversion()`
- `submitRecall()` / `syncCoreState()`

호출자는 가격, 수량, raw action, 지급 receiver를 제공하지 않는다. 모든 payload는 현재 read와 immutable config에서 생성한다. pause는 신규 입금과 새 cycle만 막고 이미 시작된 exit, settlement, claim은 막지 않는다.

## 회계

- 입금과 동기 상환은 `Idle`에서만 가능하다.
- `freeAssets = WHYPE balance - reservedClaimAssets`다.
- 요청 share는 vault 주소에 잠기지만 settlement 전까지 total supply에 남아 손익을 부담한다.
- 회수 완료 시 같은 epoch의 요청 share를 한 번에 소각하고 해당 WHYPE를 `reservedClaimAssets`로 격리한다.
- 각 request는 같은 epoch 환율을 쓰며 마지막 claimant가 정수 나눗셈 잔여분만 받는다.
- 이전 epoch의 claim reserve는 `startStrategy` 한도에서 제외된다.
- 전략 전손으로 recall할 HYPE가 없어도 포지션·debt·lending이 정리되고 gas reserve 이하만 남으면 epoch를 0자산으로 정산할 수 있다.
- 1 lot 미만 quote는 `QuoteResidualCarried`로 기록하고 Core에 이월한다. 모든 share가 동시에 나가는 경우 그 미세 잔액의 최종 소유권 정책은 아직 production 차단 조건이다.

## 가격과 수량

`HyperCoreRiskOracle`은 지원하는 perp 하나와 spot 하나를 immutable하게 저장한다.

- HYPE perp read 값은 mainnet/testnet 모두 `×10_000`하여 order 1e8 가격으로 바꾼다.
- HYPE spot read 값은 `×100`한다.
- bid와 ask 양쪽을 oracle/spot reference와 비교한다.
- slippage 적용 후 5자리 유효숫자와 시장별 decimal cap으로 방향에 맞춰 반올림한다.
- HYPE order size는 0.01 HYPE, 즉 order 단위 `1_000_000` lot에 맞춘다.

## 남은 production 차단 조건

- 신규 contract master의 PM 자격을 위한 share-backed bootstrap bridge와 action 16 실패 시 permissionless recall/환불 경로가 없다. 현재 `seed → PM → strategy bridge` 순서는 account value `>$10k` 조건을 충족하지 못한다.
- 신규 Core 계정의 1 quote-token activation transaction을 현재 vault 함수가 처리하지 않는다. 배포 단계의 외부 Core 전송과 `userExists` 확인이 필요하다.
- rejected 또는 zero-fill된 CoreWriter action은 공식 onchain status가 없어 안전하게 만료·재시도할 수 없다. 특히 open/spot conversion/recall은 중복 실행이 위험하다.
- action 16 성공을 확인하는 공식 read가 없어 `enableLiveStrategy()` 전에 외부 검증이 필요하다.
- action 15/16은 최신 공식 표에 있지만 mainnet end-to-end 실행을 아직 관측하지 못했다. 반면 action 1은 mainnet contract 주문과 fill이 일치하는 실동작을 확인했다.
- CoreWriter 표에는 leverage 변경 action이 없다. 현재 미사용 주소의 HYPE 설정은 mainnet에서 cross 10x로 관측됐지만 프로토콜 불변값이 아니며, 주문 전에 `isIsolated`와 leverage를 확인하고 예상과 다르면 차단해야 한다.
- lending `BasisAndValue.value`가 token wei라는 해석과 PM auto-repay를 소액 live delta로 확인해야 한다.
- Core→EVM 수신의 `msg.sender`가 실제로 `0x2222...2222`인지, 요청액 전부가 도착하는지 확인해야 한다.
- 테스트넷 HYPE perp는 strict isolated이므로 mainnet PM carry의 완전한 대체 시험이 아니다.
- vault runtime이 EIP-170 한도에 가깝다. 새 전략·레버리지 기능은 share vault와 immutable Core custody account를 분리한 뒤 추가한다.

이 항목이 해결되기 전에는 mainnet 사용자 입금을 열지 않는다.
