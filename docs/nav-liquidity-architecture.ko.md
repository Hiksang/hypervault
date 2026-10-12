# NAV·입금 가격·출금 유동성 확장 구조

최초 작성: 2026-09-20 KST. 최종 갱신: 2026-10-02 KST. NAV 수식·source 계약·입금 가격·유동성 설계의 관리 원본이다. 확장 순서는 [ADR-006](DECISIONS.ko.md#adr-006), 후속 USDC 상품 목표는 [ADR-010](DECISIONS.ko.md#adr-010), 최신 구현 상태는 [STATUS](STATUS.ko.md), 작업 순서·완료 상태는 [BACKLOG](BACKLOG.ko.md)에서 관리한다. 아래 후속 단계의 요구사항은 구현 완료를 뜻하지 않는다.

## 기준 자산과 상품 성격

후속 [PM 실측·회계 대조](pm-nav-evidence.ko.md)에서 raw position 수량 변환 오류를 수정하고 PM 계정의 raw spot / API 통합 잔액 차이를 확인했다. 단일 HYPE carry 표본에서 기본 DEX accountValue와 lending net을 조합한 quote 잔액이 API와 맞았지만, 생산용 source의 완전성과 전환 동작을 검증한 것은 아니다.

**현행 코드**의 입출금·지분 회계 자산은 WHYPE이고 native HYPE는 Router에서 변환한다. HYPE 현물 + 같은 수량의 perpetual short는 대략 quote 통화 기준 델타 중립이며 HYPE 수량 보존 상품이 아니다. 순가치가 5,000 USDC로 유지되더라도 HYPE 가격이 50에서 100 USDC로 오르면 현행 WHYPE 환산 순자산은 100에서 50 HYPE로 줄어든다.

**후속 상품 목표**는 HyperEVM Circle native USDC를 기초자산으로 하는 새 Vault / Strategy 쌍이다. Vault의 `CoreDepositWallet.depositFor` → Strategy Core credit → spot·HIP-3·HIP-4 시장별 거래/정산 → USDC 회수 → 실제 USDC 정산 경로를 별도로 구현·실측한다. HYPE 현물 매수/short는 가능한 예시이며 새 상품의 고정 전략은 아니다. [시장 범위](DECISIONS.ko.md#adr-011). 기존 지분의 underlying을 변경하지 않는다. 현재 NAV 계산부는 0~18자리 asset decimals를 지원하지만 AsyncHypeVault / HypeRouter / HyperCoreStrategyAccount는 WHYPE 전용이다. 계산부의 USDC 환산 테스트는 USDC Vault 전체 지원의 증거가 아니다. [경로와 증거 조건](vault-architecture.ko.md#7-usdc-목표-경로와-검증-조건)

## 책임 분리

| 구성 요소 | 책임 | 구현 상태 |
| --- | --- | --- |
| AsyncHypeVault / EpochRedeem | ERC20 지분, ERC7540 요청·claim, 준비금, 자금 배정 | 기존 유지, NAV 캐시 검증 추가 |
| HyperCoreStrategyAccount | Core 자산 보관, 허용된 주문·공급·회수, 액션 관측 | 기존 단일 전략 유지 |
| IStrategyBalanceSheet 구현체 | 원시 상태를 중복 없는 동일 통화 대차대조표로 정규화 | 인터페이스 추가; 생산용 Core adapter 미구현 |
| PortfolioNavReader / PortfolioNavMath | 순가치 계산, asset 단위 환산, 관측 범위 검증 | 이번 구현, mock source로 검증 |
| 유동성 배분 정책 | 미투자 buffer, 부분 회수, 지속 운용 epoch | 후속 단계 |

지분 발행이나 출금 권한을 Strategy에 옮기지 않는다. keeper가 평가값을 제출하는 함수는 추가하지 않는다. reader와 source는 생성 시 고정되며 변경 setter가 없다. source의 정확성은 배포 시 선택하는 코드의 신뢰 경계다. `complete=true` 또는 `MarkToMarket`이라는 값 자체는 정확성의 암호학적 증명이 아니다.

## 회계 수식과 source 계약

source 금액은 **하나의 명시된 quote 통화** 기준 1e18 정밀도다. USDC 표시 금액을 별도 환율 없이 USD라고 취급하지 않는다. `assetPrice`는 같은 quote 통화로 표시한 기초 자산 1개 가격이며 1e18 정밀도다.

```text
strategyQuoteEquity = spotValue + suppliedValue + perpCollateralValue
                    + unrealizedPnl + unsettledFunding
                    - debtValue - accruedFees - excludedValue

strategyAssetNAV = floor(strategyQuoteEquity × 10^assetDecimals / assetPrice)
                 + Strategy의 EVM ERC20 잔액

shareholderNAV = Vault의 ERC20 잔액 - 확정 claim 준비금 + strategyAssetNAV
```

Strategy NAV는 음수를 유지한다. 음수 환산도 음의 무한대 방향 반올림이다. Vault의 ERC4626 `totalAssets()`만 최종 결과를 0에서 제한한다. 0 가격, 정수 범위 초과, 누락된 관측값은 revert하며 0 NAV로 바꾸지 않는다.

생산용 source는 다음을 입증해야 한다.

1. spot / supplied / perp collateral은 서로 겹치지 않는다. PM의 spot·lending·margin summary를 그대로 합산하지 않는다. 담보 haircut을 적용한 차입 가능 금액과 경제적 순자산도 구분한다.
2. suppliedValue는 공급 이자를 포함한 현재 가치, debtValue는 차입 원금과 누적 이자를 포함한 현재 부채다. basis를 현재 가치로 오인하지 않는다.
3. 잔액에 이미 반영된 PnL·펀딩·수수료를 중복 반영하지 않는다. unsettledFunding은 아직 미반영된 금액만 담고 비용은 음수다.
4. Core 가스 후원금 등 주주에게 귀속되지 않는 자금은 위 자산 항목에 포함됐을 때만 excludedValue로 차감한다. 같은 예비금을 두 번 빼지 않는다.
5. Strategy EVM ERC20 잔액과 Vault 현금은 source에 넣지 않는다. reader / Vault가 각각 한 번 반영한다. 외부 프로토콜 자산·추가 시장도 빠짐없이 추적하거나 complete=false로 거부한다.
6. account, asset, Strategy config hash, cycleId가 일치해야 한다. Core 구성 항목은 동일 Core block 관측이며 가격을 포함한 모든 입력의 가장 오래된 시각을 observedAt으로 제공한다.
7. bridge·recall·미확정 액션은 inFlight로 나타낸다. 과도기 자산을 양쪽 도메인에서 동시에 더하지 않는다.

공식 ABI만으로 위 중복 관계와 funding 정산 시점을 확정하지 않았다. 따라서 임의의 합산식으로 생산용 source를 구현하거나 기본 배포 reader를 교체하지 않았다. `DeployPair`는 여전히 `HyperCoreNavReader`를 배포하며 운용 중 원금 추정치만 제공한다. 후속 USDC source는 현행 WHYPE 필드 맵을 복사하지 않고 모든 허용 spot token, 기본/HIP-3 DEX별 담보·포지션·부채·PnL, HIP-4 outcome의 미결제/만기·정산 가치를 같은 USDC quote로 한 번씩 정규화해야 한다. 한 시장의 raw 상태가 빠지면 complete=false로 거부한다.

## 이번 관측 검증 변경

- Quality에 MarkToMarket=3을 추가했다. 기존 Unavailable=0, CapitalEstimate=1, Realized=2는 유지한다.
- Observation 끝에 cycleId를 추가했다. **reader ABI 변경이므로 Vault와 reader를 함께 빌드·배포해야 한다.** 구버전 reader를 혼합하지 않는다. 업그레이드 기능은 없다.
- PortfolioNavReader는 Active이며 pending / exit가 없는 상태에서만 평가한다. source 범위·완전성·현재 Core block·가격·최대 5분 이내의 설정된 freshness를 확인한다. 다른 단계는 기존 명시적 원금 추정치 / 회수액 경로를 사용한다.
- pending인데 ReturnReady 또는 Idle인 상태는 Realized로 취급하지 않는다.
- Vault는 cycle·timestamp·quality와 Strategy 상태를 대조한다. timestamp / Core block 역행, 과거·미래 Core block의 평가 NAV를 거부한다. 실패 시 마지막 정상 금액·시각을 보존하고 quality를 Unavailable로 표시한다.
- effectiveNavQuality()는 캐시의 나이와 현재 상태를 다시 검사한다. MarkToMarket은 Core block이 바뀌거나 precompile이 실패해도 Unavailable이 된다. 저장된 navQuality만 보고 거래 가격으로 사용하면 안 된다.
- 재자본화 시 원금 추정치는 allocated + recapitalized로 새로 계산한다. 평가 손익에 추가 원금을 더한 값을 원금이라고 표시하지 않는다. 정산·Idle checkpoint에서는 Core block과 inFlight를 초기화한다.

totalAssets()는 운용 중 마지막 관측값 또는 원금 추정치를 반환한다. freshness나 실행 가능한 가격을 보장하지 않는다. effectiveNavQuality()도 입금 허가 함수가 아니다. 실제 입금은 Idle에서만 이루어지고 출금 정산은 실제 WHYPE 회수액으로 결정한다.

## 후속 확장에서 지킬 동작

착수 조건과 완료 추적은 [NAV-001](BACKLOG.ko.md#nav-001), [VAULT-001](BACKLOG.ko.md#vault-001), [LIQ-001](BACKLOG.ko.md#liq-001)에 둔다. 아래는 각 기능의 상세 설계 기준이다.

### 1. 생산용 Core 대차대조표 source

같은 EVM/Core block으로 고정한 관측을 공급 전후, short 전후, 펀딩 반영 전후, 이자 누적, 부분 체결, quote debt 발생·상환, 회수 전후에 수집한다. 거래·잔액 변화와 원장을 대조하여 중복 제거와 단위를 확정한다. API는 진단용 대조 자료이며 keeper가 제출하는 온체인 평가값으로 사용하지 않는다. mock 테스트만으로 완료로 보지 않는다.

### 2. 운용 중 즉시 입금과 지분 발행

입금 트랜잭션 안에서 검증된 reader로 현재 스냅샷을 읽어 **입금 직전** 주주 NAV를 계산한다. 캐시를 읽고 바로 mint하지 않는다. OZ virtual assets/shares 반올림 정책, 수수료·유동성 비용, 0 이하 순자산, 발행 상한, minShares/deadline을 적용한다.

기존 주주의 이익이 신규 유저에게 이전되거나 손실이 신규 입금으로 희석되는 사례, 입금 순서, pending Core 액션, 가격 조작, stale source, 소액 반올림을 검증한다. source가 없거나 불완전하면 maxDeposit/maxMint=0을 유지한다. 신규 자금은 우선 Vault 현금으로 보유한 뒤 배정하므로 입금마다 Core 주문을 만들 필요는 없다.

### 3. 출금 buffer와 부분 회수

확정 claim 준비금, 아직 주주 자산인 목표 유동성 buffer, recap 예산을 별도 항목으로 관리한다. buffer는 준비금 차감 후 주주 NAV를 기준으로 계산한다. 확정 claim 자금은 어떤 재투자·부채 상환에도 사용할 수 없다.

대기 요청이 있으면 정해진 epoch를 seal하고 같은 requestId 전체를 같은 가격·같은 비율로 처리한다. 선착순 buffer claim으로 일부 유저만 손실을 피하도록 만들지 않는다. buffer 부족분만 회수하도록 Strategy에 부분 close→담보 회수→부채 정리→recall 경로를 추가하고 잔존 포지션의 hedge·margin·부채·가스를 재검사한다. 부분 회수는 현재 returnToVault의 전량 종료 경로와 분리한다.

미확정 액션 판정·거절·무체결 복구가 먼저 검증되어야 한다. permissionless는 누구나 허용된 절차를 진행한다는 뜻이며 Core 처리 실패에도 즉시 지급한다는 보장이 아니다. 이 단계까지 완료한 뒤 외부 lending / liquidity 전략을 별도 adapter로 추가한다.

## 근거

- [Harmonix haUSDC 소개](https://paragraph.com/@harmonix-finance/introducing-hausdc-your-usdc-put-to-work): 전략 구성과 비동기 출금 방향 참고. CoreWriter / PM / 무허가 회수 구현을 이 글만으로 확인할 수 없다.
- [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540): 동기 입금 + 비동기 출금 및 requestId별 동등 처리.
- [HyperCore 연동](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore): precompile의 Core 시점과 비동기 쓰기 경계. 2026-09-20 재확인.
- [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin): spot / perp 통합, 자동 차입·이자·carry 관계. NAV adapter의 중복 제거식은 별도 검증이 필요하다.
