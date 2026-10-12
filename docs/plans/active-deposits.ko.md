# 운용 중 동기 입금 기획

2026-10-04 Managed USDC의 gate/소비자 구현과 precompile source 미완료 경계는 [현행 NAV 명세](../managed-precompile-nav.ko.md)를 따른다. 아래 WHYPE 초안은 해당 구현의 SSOT가 아니다.

2026-10-02 범위 주의: 아래 WHYPE·native Router·21자리 share 예시는 현행 프로토타입 기준의 제안이다. 후속 [USDC 쌍](../DECISIONS.ko.md#adr-010)의 Active 입금은 USDC 6자리·새 share offset·Core credit 원장을 기준으로 수식과 미헤지 노출 검사를 다시 작성해야 한다. 현재 코드나 이 초안이 USDC Active 입금을 지원한다는 뜻은 아니다.

상태: PROPOSED · 2026-09-21. 연결: VAULT-001, REQ-07/08/12. NAV-001 이후 구현한다. 현재 Idle-only 입금을 이 문서 작성으로 개방하지 않는다.

## 목표와 가격 기준

입금 직전의 검증된 주주 NAV로 지분을 발행한다. 기존 지분과 escrow pending shares는 공급에 포함하고 확정 claim 채무는 자산에서 제외한다. 입금액이 NAV에 들어간 뒤 가격을 계산하는 실수를 막는다. 원금 추정값·오래된 캐시로 대체하지 않는다.

수수료 0 제안과 기존 OZ offset을 유지할 때, A를 입금 직전 주주 순자산(WHYPE wei), S를 입금 직전 share base units라고 정의한다.

```text
deposit(x): shares = floor(x × (S + 1000) / (A + 1))
mint(y):    assets = ceil(y × (A + 1) / (S + 1000))
```

S>0이고 A≤0이면 새로운 유저 자금을 기존 손실에 넣지 않도록 입금을 닫는다. 초기 빈 Vault의 donation/offset 처리와 최소 shares>0 조건은 별도 테스트한다. 경제적 예시에서 100 shares가 NAV 120을 갖고 12를 입금하면 약 10 shares를 발행한다. 기존 원금 NAV 100을 쓰면 약 12 shares가 발행돼 과거 수익이 이전된다. 예시는 실제 decimals/offset 반올림을 생략했다.

## 실행 순서

1. reentrancy·pause/shutdown·receiver/controller 권한 검사.
2. Active 안정 상태인지 확인: 신규/기존 pending, bridge/recall, exit/정산 잠금 없음.
3. 현재 source 관측과 가격 정책으로 **새 평가**를 받고 scope/cycle/block/완전성/가격 freshness 검사.
4. 필요한 기존 주주 비용을 먼저 반영하고 A/S 및 미헤지 잔고·TVL cap 검사.
5. preview와 같은 수식으로 assets/shares 계산, 호출자의 minShares/maxAssets/deadline 검사.
6. 정확한 WHYPE 수신 확인 후 mint. 허용 토큰은 고정 WHYPE이며 fee-on-transfer를 지원하는 것으로 확대하지 않음.
7. 새 관측/잔액 상태를 일관되게 기록. 입금 자체로 Core 주문을 바로 생성하지 않고 현금 정책에 따라 후속 배정.

native Router에서는 Vault 입금 전 WHYPE로 wrap하지만 Vault 자신의 입금 전 A에는 아직 포함되면 안 된다. 관측 실패 후 이미 보낸 native가 중간 계약에 남지 않도록 전체 입금 원자성을 유지한다.

## view 함수와 캐시

현재 `totalAssets`는 상태별 추정 캐시이므로 상위 ERC4626의 `_convertToShares`를 그대로 믿고 guard만 열지 않는다. Active `previewDeposit/previewMint`와 실행 함수가 공통 fresh quote 계산을 사용하도록 분리하는 안을 제안한다. `maxDeposit/maxMint`는 신뢰할 수 있는 가격·유동성/노출 여유가 없으면 0이다.

비동기 `previewWithdraw/previewRedeem`의 항상 revert 규칙은 유지한다. convert 계열은 참고 환산이며 사용자에게 실행 가능한 금액으로 표시하지 않는다. preview 이후 상태가 바뀔 수 있으므로 slippage 보호는 실행 시 다시 검사한다. 신뢰할 수 있는 preview가 없을 때는 명시적 오류이며 조용히 CapitalEstimate로 반환하지 않는다.

## buffer와 공정성 제약

새 WHYPE 현금이 쌓이면 기존 Core hedge와 별개로 전체 Vault에 HYPE long 노출이 생긴다. `unhedgedAssets` 한도를 전체 NAV와 함께 검사하고 초과분의 입금은 닫는다. 소액 반복 입금으로 한도·정산 잠금·최소 수량을 우회하지 못해야 한다.

seal된 출금 epoch 처리 중에는 초기 안에서 입금·추가 배정을 잠근다. [부분 출금 기획](liquidity-exits.ko.md)이 epoch 비용과 가격을 확정하기 전 신규 주주가 들어오지 않도록 하기 위함이다. 기존 claim 지급에는 이 잠금을 적용하지 않는다.

## ABI·코드 영향과 시험

변경 대상: AsyncHypeVault의 입금 내부 경로, max/preview/가격 helper, NavReader/Source 연동, HypeRouter 보호 입력, cap 정책. 기존 함수 selector를 보존하더라도 Active 동작 변화는 ABI 동작 변경으로 기록한다. 새로운 quote helper 이름은 구현 시 결정한다.

필수 시험: 이익/손실 후 입금, 동일 tx 관측 실패, block 변경, 같은 block 대량 입금, donation, first deposit, negative NAV, 미예약 현금 cap, gas reserve 제외, 기존 claim, pending/exit 차단, front-run 가격 변화, native rollback. 새 규칙으로 VaultDeployer runtime 여유도 확인한다.
