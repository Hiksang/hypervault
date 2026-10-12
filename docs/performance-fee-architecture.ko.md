# USDC Vault의 운용자 성과 수수료 설계

최종 갱신: 2026-10-04 KST. [ADR-016](DECISIONS.ko.md#adr-016)의 목표 설계다. [ADR-026](DECISIONS.ko.md#adr-026)로 성과수수료는 기본 10%인 생성 시 선택값으로 확장했다. [`ManagedRedeem`](../src/managed/ManagedRedeem.sol)에 원가·요청·손실·수수료 회계를 구현했으며 [현행 ABI와 정산 시점](managed-usdc-vault-implementation.ko.md)을 따른다. 이전 [`AsyncUsdcVault`](../src/AsyncUsdcVault.sol)에는 이 수수료가 없다. 구현·검증 완료 조건은 [FEE-001](BACKLOG.ko.md#fee-001), 실제 상태는 [STATUS](STATUS.ko.md)를 따른다.

## 권리와 징수 시점

- 각 공개 Factory Vault의 창설자가 해당 Vault의 운용자다. `performanceFeeBps` 기본값은 1000(이익의 10%)이고 생성자가 0~10000 bps를 선택한다. 이후 요율 변경은 share와 확정 준비금이 모두 0인 Idle에서만 허용한다. [ADR-017](DECISIONS.ko.md#adr-017)에 따라 **이 성과 수수료의 80%는 운용자, 20%는 플랫폼 Treasury**가 받는다. 관리·입금·정액 출금 수수료는 이 결정으로 추가하지 않는다.
- 다른 사용자가 HyperEVM USDC를 `deposit/mint`해 받은 share에만 성과 수수료를 매긴다. [ADR-021](DECISIONS.ko.md#adr-021)의 최초 EVM USDC 100으로 발행한 창설자 share와 그 수익은 과금 대상이 아니다. 1 quote-token 활성화 비용은 송금인 지출이며 Vault 주주 원가·수수료 대상이 아니다. 타인을 위한 `deposit/mint`의 원금은 실제 share 수령자에게 귀속한다.
- 사용자 `requestRedeem` 시 share와 해당 USDC 원가를 함께 고정한다. 출금 epoch의 실제 회수 USDC로 **총 출금 권리**를 정산한 후 수수료와 순수령액을 확정한다. `claim` 시 순수령액은 사용자에게, 수수료의 운용자/플랫폼 몫은 각각의 수령 주소에 **같은 EVM 거래에서** 보낸다. 요청 당시 예상 NAV나 CoreWriter 제출 성공으로 수수료를 선징수하지 않는다.
- `Withdraw`의 `assets`, `redeem` 반환값, `maxWithdraw`는 사용자가 실제 받는 **순 USDC** 기준이어야 한다. 현행 `PerformanceFeePaid` 이벤트에는 요청 ID, 사용자 순수령, 운용자·플랫폼 배분액을 남긴다. 전체 권리·총 fee는 `RequestPriced`, 원가·요율·이월은 공개 요청/사용자 장부, 수령지는 owner/treasury getter로 조회한다. 출금 화면은 Pending 추정과 Claimable 확정치를 구분한다.

## 원가와 손실 이월

모든 값은 HyperEVM USDC의 6자리 정수 단위다. 사용자별 `basisUsdc`는 현재 보유 share의 실제 투입 원가이며, 이익 추정 NAV가 아니다. 입금 시 Vault가 실제 받은 USDC만 원가에 더한다. 사용자가 `q` share를 요청할 때 보유 수량 `s`에 대한 원가 `Breq = floor(basisUsdc × q / s)`를 별도 요청 장부로 옮긴다. `q = s`라면 반올림 잔여 원가도 모두 이동한다. 잔여 share의 원가는 `basisUsdc − Breq`다.

요청의 실제 총 USDC 권리를 `G`, 이전 확정 손실 이월을 `Lprev`라고 할 때:

```text
이번 이익 P       = max(G − Breq, 0)
이번 손실 D       = max(Breq − G, 0)
과금 대상 이익 T  = max(P − Lprev, 0)
새 손실 이월 Lnext = Lprev + D − min(P, Lprev)
수수료 F          = floor((T × 요청 feeBps + 미징수 소수 잔여) / 10000)
사용자 순수령 N   = G − F
```

Claim 시 플랫폼 몫 `Fp = floor((F × 2000 + 플랫폼 소수 잔여) / 10000)`, 운용자 몫 `Fm = F − Fp`다. 플랫폼 소수 잔여는 Vault별로 다음 Claim까지 이어 받아 소액 출금 분할로 플랫폼 몫을 없애지 못하게 한다. `G = N + Fm + Fp`를 매 Claim에서 검증한다. 예시의 총 수수료 2 USDC는 운용자 1.6 USDC, 플랫폼 0.4 USDC이고 사용자 순수령 118 USDC는 그대로다. 운용자 수령 주소와 플랫폼 Treasury 주소는 Factory의 검증된 설정으로 고정하고 사용자 출금 호출자가 바꾸지 못한다.

미징수 소수 잔여는 사용자별로 이어 받아 6자리 USDC 최소 단위의 수수료를 소액 출금 분할로 회피하지 못하게 한다. 손실 이월은 같은 사용자 주소의 후속 출금 이익을 먼저 상쇄하고, 전액 출금 후 재입금해도 유지한다. 다른 사용자·운용자에게 이전할 수 없다. 이미 지급한 수수료의 소급 환급은 이 정책에 포함되지 않는다. 예를 들어 원가 100 USDC를 전액 출금할 때 실제 권리가 120 USDC면 수수료 2 USDC, 사용자 118 USDC다. 권리가 80 USDC면 수수료 0, 손실 이월 20 USDC다. 이후 같은 주소가 다시 투자해 25 USDC의 출금 이익을 얻으면 20 USDC를 먼저 상쇄하고 남은 5 USDC의 10%인 0.5 USDC를 징수한다.

`G`는 주주 소유로 확인된 현금 회수 결과다. Vault/Core의 비요청 입금과 창설자 Core100을 초과한 미확인 잔액, 확정 이전 claim 준비금, 원금 추정 `capitalEstimate`와 불완전한 시장 NAV를 수익으로 넣지 않는다. 확정된 창설자 Core100은 주주 자본이므로 전체 NAV에 한 번 포함하되 다른 예치자의 이익으로 별도 계상하지 않는다. Core 거래·회수·정산 비용이 실제 자산에 반영된 뒤 계산하고 동일 비용을 다시 차감하지 않는다.

## ERC-7540 요청과 지급 준비금

현재 [`EpochRedeem`](../src/vault/EpochRedeem.sol)은 같은 epoch의 여러 controller에 **동일 request ID와 동일 환율**을 준다. 사용자별 원가·손실 이월이 다르면 순환율도 달라지므로 이를 그대로 사용해 성과 수수료를 붙일 수 없다. 목표 구현은 공통 내부 정산 epoch와 외부 ERC-7540 `requestId`를 분리해 **각 사용자 요청에 고유 ID**를 준다. 동일 ID 요청의 동일 환율 요구를 유지하고, 각 요청의 순수령액·수수료는 그 요청의 원가 장부로 계산한다. [ERC-7540 요청 ID 규칙](https://eips.ethereum.org/EIPS/eip-7540#request-ids)

첫 템플릿은 양수 share의 사용자 간 직접 전송을 금지하고 `requestRedeem`의 `controller == owner`를 요구한다. 승인된 operator가 owner/controller를 대신 호출하는 것은 유지한다. 한 주소에는 완전히 Claim하기 전까지 **동시에 하나의 출금 요청만** 허용해 손실 이월 적용 순서를 고정한다. 그래야 다른 사람의 원가·손실 이월을 합쳐 수수료를 줄이거나 share 전송으로 원가를 세탁하지 못하고, 여러 요청의 Claim 순서로 과금 기준을 바꾸지 못한다. 0 share 전송은 ERC-20 경계 검토를 따른다. 양도 가능한 share 또는 별도 controller·동시 요청을 지원하려면 원가 이동·요청별 원가 귀속과 표준 적합성을 새로 검증한다.

각 요청의 총 권리 `G`는 epoch 정산 때 실제 회수액으로 고정하고, `G = N + Fm + Fp` 전체를 출금 지급 준비금으로 잠근다. 운용자와 플랫폼은 Claim 전 수수료분도 투자하거나 인출할 수 없다. Claim 시 `G`를 준비금에서 차감하고 사용자에게 `N`, 고정된 운용자 수령 주소에 `Fm`, 플랫폼 Treasury에 `Fp`를 원자적으로 지급한다. 부분 Claim은 요청 전체의 누적 총 권리·누적 수수료에서 이미 지급한 양을 빼는 방식으로 계산해 Claim 횟수와 순서가 최종 금액을 바꾸지 않게 한다. `maxRedeem/maxWithdraw`, `redeem/withdraw`, `Withdraw` 이벤트와 수수료 이벤트가 이 순수령 의미와 맞아야 한다. `ManagedRedeem`은 정확한 순 USDC withdraw와 누적 redeem을 구현·로컬 회귀했다. sub-share 역산의 작은 잔여 claim 제한과 전체 표준 적합성 미완료는 [현행 명세](managed-usdc-vault-implementation.ko.md)에 기록한다.

사용자가 Claim을 늦춰도 확정 총 권리·수수료는 이후 거래 손익에 따라 바뀌지 않는다. 제3자의 Claim 실행/receiver 선택은 기존 controller/operator 권한을 지키며 고정된 운용자·플랫폼 수령지를 바꾸지 못한다. 두 수수료 전송 중 하나라도 실패하면 Claim 전체를 되돌리고 준비금·손실 이월·지급 장부가 그대로여야 한다.

## 검증해야 할 사례

정상 이익·무이익·손실, 손실 뒤 복구, 재입금, 여러 입금 가격, 부분 출금/부분 Claim, 6자리 반올림과 소액 분할, 플랫폼 20% 배분의 누적 반올림, 동일 epoch 다른 원가의 두 사용자, 요청·정산·Claim 순서 변경, 운용자 자신의 share, operator/receiver, 제3자 송금, 준비금 재투자 차단, 운용자/플랫폼 지급 실패를 검증한다. 요청별 고유 ID가 ERC-7540 동일 ID 환율 규칙을 만족하는지, 순수령 `maxWithdraw`와 `withdraw`가 실제 지급 가능량을 넘지 않는지 공식 조항과 대조한다. 실계정 NAV·Core 회수 증거가 없으면 성과 수수료 금액도 생산용으로 확정할 수 없다.
