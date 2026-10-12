# HyperCore HYPE vault 배포 파라미터와 통합 체크리스트

이력 문서다. 최신 배포/검증 상태는 [STATUS](STATUS.ko.md), 통합 작업의 완료 여부는 [BACKLOG](BACKLOG.ko.md)를 따른다. 당시 네트워크 식별자와 조건을 재검증 없이 새 배포에 사용하지 않는다.

이 문서의 `HyperCoreVault.Config`와 bootstrap 순환 의존 설명은 legacy 구현 기준이다. 신규 분리 계약은 먼저 bridge한 뒤 PM을 확인하도록 변경됐으며, 새 배포 설정과 남은 통합 제약은 [분리 구현 현황](split-implementation.ko.md)에 기록한다. 아래 네트워크 관측은 당시 시점의 자료다.

기준 시각은 2026-09-19 KST다. 아래 네트워크 식별자는 공식 RPC/info endpoint를 읽기 전용으로 다시 조회했고, 저장된 근거는 `reference/mainnet-probe.json`, `reference/testnet-probe.json`, `reference/live-market-read-2026-09-19.json`, `reference/mainnet-corewriter-observation-2026-09-19.json`, `reference/L1Read.sol`에 있다. action 1을 제외한 probe는 write 성공을 증명하지 않는다.

## 네트워크 및 자산 식별자

| 항목 | Mainnet | Testnet | 판정 |
|---|---:|---:|---|
| chain ID | `999` | `998` | 확정 |
| RPC | `https://rpc.hyperliquid.xyz/evm` | `https://rpc.hyperliquid-testnet.xyz/evm` | 확정 |
| CoreWriter | `0x3333333333333333333333333333333333333333` | 동일 | 확정 |
| HYPE system address | `0x2222222222222222222222222222222222222222` | 동일 | 확정 |
| canonical WHYPE | `0x5555555555555555555555555555555555555555` | 동일 | 코드 존재 확인 |
| HYPE token index | `150` | `1105` | 2026-09-18 UTC 재확인 |
| USDC token index | `0` | `0` | 2026-09-18 UTC 재확인 |
| HYPE perp action/reference index | `159` | `135` | 2026-09-18 UTC 재확인 |
| HYPE/USDC spot reference index | `107` | `1035` | 2026-09-18 UTC 재확인 |
| HYPE/USDC spot action asset | `10107` | `11035` | `10000 + spot index` |
| HYPE `szDecimals` / `weiDecimals` | `2 / 8` | `2 / 8` | 재확인 |
| USDC `szDecimals` / `weiDecimals` | `8 / 8` | `8 / 8` | 재확인 |
| HYPE perp 모드 | 일반 HYPE perp | `strictIsolated`, `onlyIsolated=true` | 테스트넷 HYPE는 PM carry E2E 대상으로 부적합 |

## 현재 운용 가능성 판정

목표 순서는 `사용자 HYPE 입금 → vault 주소의 Core 계정으로 전송 → PM 활성화 → HYPE lending supply → HYPE perp short`다. CoreWriter는 caller인 vault 컨트랙트 자신의 Core 계정에 action을 귀속시키므로 이 경로 자체에는 API wallet이 필요하지 않다. keeper는 정해진 EVM 함수를 호출하고 공개 API/read precompile로 결과를 관측할 뿐 Core 자산의 서명권을 갖지 않는다.

다만 2026-09-19 현재 전체 경로를 production-ready로 판정할 수는 없다.

| 단계 | 수단 | 현재 판정 |
|---|---|---|
| 새 vault Core 계정 활성화 | 다른 Core 계정이 vault 주소에 최초 전송 | 신규 계정은 첫 수신 때 quote token 1개 activation fee가 필요하며, 미활성 계정은 CoreWriter를 사용할 수 없다. 현재 `seedCoreAccount()`의 HYPE 전송만으로 이 조건이 충족된다고 가정하면 안 된다. |
| EVM HYPE → vault Core spot | native HYPE를 `0x2222...2222`에 value 전송 | 공식 문서가 contract와 EOA 모두 지원한다고 명시한다. 최초 전송과 CoreWriter action은 같은 EVM block에서 묶지 않는다. |
| PM 모드 | action 16, abstraction `3` | action 표에는 존재한다. 신규 contract master는 거래량 이력이 없으므로 Core account value `>$10k`를 먼저 충족해야 한다. 실제 mainnet contract-account 성공은 별도 소액 write로 확인해야 한다. |
| HYPE lending supply | action 15, operation `0` | 최신 action 표에는 존재하지만 PM 본문에는 아직 future upgrade라는 문장이 남아 있다. mainnet supply/withdraw의 실제 상태 변화와 단위를 검증해야 한다. |
| HYPE perp short | action 1 sell IOC | mainnet CoreWriter action 1의 실제 contract 주문·체결은 공개 체인/API에서 관측된다. vault의 PM/cross 상태와 HYPE 주문은 별도로 검증해야 한다. |
| Core HYPE → vault EVM | action 13 send asset | 인코딩 경로는 구현됐지만 발신자, gas 차감 순수령액, 재호출 안전성을 소액 왕복으로 검증해야 한다. |
| permissionless exit | EVM crank 함수들 | API wallet 없이 설계돼 있다. 현재는 reject/zero-fill을 신뢰 없이 만료시키는 경로가 없어 영구 정지 가능성이 남는다. |

공식 HyperEVM 개요에는 아직 write system contracts가 mainnet에 live하지 않다는 문장이 남아 있지만, mainnet `0x3333...3333`의 bytecode와 최근 action 1 실행·체결 관측은 그 문구와 충돌한다. 그러므로 bytecode나 action 1 하나만으로 action 15/16/13까지 활성화됐다고 추론하지 않고 기능별 write 증거를 요구한다.

현재 구현 순서 `seed → action 16 → enable → 사용자 HYPE bridge`는 신규 vault에서 순환 의존을 만든다. PM 자격을 얻으려면 share-backed HYPE가 먼저 Core에 있어야 하지만 `startStrategy()`는 PM을 외부 확인한 뒤에만 bridge할 수 있다. `$10k` 이상의 무상 seed는 share를 발행하지 않고 종료 시 vault 자산으로 섞이므로 임시 bootstrap 자금으로 사용할 수 없다. 배포 전 `share-backed bootstrap bridge → action 16 → 외부 PM 확인 → action 15/1` 상태와 PM 실패 시 permissionless recall/환불 경로를 구현해야 한다.

## `HyperCoreRiskOracle.Config`

두 네트워크 모두 HYPE의 `szDecimals`가 2이므로 수량 lot은 `0.01 HYPE`, CoreWriter order 단위로 `1_000_000`이다.

| 필드 | Mainnet | Testnet | 산출 근거 |
|---|---:|---:|---|
| `perp.actionAsset` | `159` | `135` | `meta`의 HYPE 인덱스 |
| `perp.referenceIndex` | `159` | `135` | oracle precompile의 perp 인덱스 |
| `perp.readToOrderMultiplier` | `10_000` | `10_000` | `1e8 / 10^(6-2)` |
| `perp.maxPriceDecimals` | `4` | `4` | `6 - szDecimals` |
| `perp.orderSizeLot` | `1_000_000` | `1_000_000` | `0.01 * 1e8` |
| `spot.actionAsset` | `10_107` | `11_035` | `10000 + spot index` |
| `spot.referenceIndex` | `107` | `1035` | spot price precompile의 raw spot index |
| `spot.readToOrderMultiplier` | `100` | `100` | `1e8 / 10^(8-2)` |
| `spot.maxPriceDecimals` | `6` | `6` | `8 - baseSzDecimals` |
| `spot.orderSizeLot` | `1_000_000` | `1_000_000` | `0.01 * 1e8` |
| `maxSlippageBps` | 정책값 | 정책값 | 로컬 테스트값 `100`; 실거래 depth로 결정 |
| `maxBboDeviationBps` | 정책값 | 정책값 | 로컬 테스트값 `200`; oracle/BBO 장애 테스트 후 결정 |

가격 read 단위는 perp가 `raw / 10^(6 - szDecimals)`, spot이 `raw / 10^(8 - baseSzDecimals)`다. CoreWriter 주문 가격과 수량은 모두 사람 단위의 `1e8` 배다.

현재 메인넷 HYPE가 약 92달러일 때 허용되는 최소 가격 간격은 약 `0.001 USD`, 즉 order 단위 `100_000`이다. 가격이 100달러를 넘으면 5 유효숫자 제한 때문에 `0.01 USD`, 즉 `1_000_000`으로 바뀐다. `HyperCoreRiskOracle`은 가격 크기와 perp/spot별 최대 소수 자릿수(각각 4와 6)를 사용해 매 호출마다 동적으로 반올림한다.

2026-09-18 22:07 UTC의 읽기 샘플은 다음과 같았다.

| 네트워크 | perp oracle / BBO (human) | spot reference / BBO (human) | 의미 |
|---|---|---|---|
| Mainnet | `91.9965 / 92.032–92.033` | `91.996 / 91.996–91.997` | 단위 배수 확인, 정상 범위 |
| Testnet | `29.0715 / 11–70` | `25.253 / 25.253–32.89` | 큰 괴리; 200 bps guard가 주문을 차단해야 함 |

## `HyperCoreVault.Config`

| 필드 | Mainnet | Testnet | 비고 |
|---|---:|---:|---|
| `wrappedHype` | `0x5555...5555` | 동일 | canonical WHYPE |
| `coreWriter` | `0x3333...3333` | 동일 | system contract |
| `hypeSystem` | `0x2222...2222` | 동일 | HYPE Core/EVM 전송 주소 |
| `riskOracle` | 배포한 oracle | 배포한 oracle | 위 네트워크 설정과 일치 확인 |
| `initialOwner` | 운영 multisig | 테스트 운영자 | 외부 결정 |
| `expectedChainId` | `999` | `998` | 0으로 비활성화하지 않음 |
| `minimumDeposit` | 초기 후보 `0.01 ether` | 동일 | HYPE lot과 맞춘 UX 값; 프로토콜 상수 아님 |
| `maximumTotalAssets` | bootstrap 설계 후 결정 | 테스트 규모 | 신규 contract master의 PM 자격은 account value `>$10k` 또는 weighted volume `>$5M`; `1 HYPE` cap으로는 현재 가격에서 PM 활성화가 불가능 |
| `cycleDuration` | 초기 후보 `1 days` | 동일 | 상품 정책값; funding은 시간당 반영 |
| `hypeToken` | `150` | `1105` | Core token index |
| `quoteToken` | `0` | `0` | Core USDC token index |
| `hypePerpAsset` | `159` | `135` | 테스트넷 제약 주의 |
| `hypeSpotAsset` | `10107` | `11035` | order asset ID |
| `coreGasReserve` | 초기 후보 `1_000_000` | 동일 | 0.01 HYPE; 배포 직전 base fee로 재계산 |
| `debtDust` | `0` | `0` | 현재 constructor가 강제 |
| `quoteDust` | staging 후보 `100` | 동일 | constructor 상한 `1_000_000`; lot 미만 잔액은 별도 분기로 이월 |
| `collateralDust` | `0` | `0` | 현재 constructor가 강제 |
| `repayBufferBps` | staging 후보 `10_100` | 동일 | 수수료·이자 여유 정책값 |
| `minHedgeBps` | staging 후보 `10_000` | 동일 | 정확한 delta hedge 우선; 9,900은 1% 미헤지 허용 |
| `maxHedgeBps` | staging 후보 `10_000` | 동일 | 기존/초과 포지션을 허용하지 않음 |

Core→EVM HYPE 전송 비용은 다음 EVM 블록의 `200,000 * baseFee`다. Core HYPE wei로 필요한 최소 reserve는 `ceil(200000 * baseFeeWei / 1e10)`이다. 조회 당시 두 네트워크의 base fee가 0.1 gwei여서 비용은 `2,000` Core wei, 즉 `0.00002 HYPE`였다. `1_000_000` Core wei(0.01 HYPE)는 현재 비용보다 충분히 크고 HYPE lot에도 맞지만, 네트워크 상수가 아니므로 배포 직전과 운영 중 다시 확인한다.

USDC Core wei가 8자리라는 가정 아래 `quoteDust=100`은 0.000001 USDC다. 0.01 HYPE lot 때문에 더 큰 잔액이 남을 수 있으므로, 현재 구현은 반올림한 `buySize`가 0이면 `QuoteResidualCarried`를 emit하고 recall로 진행한다. 이 quote는 Core 계정에 남아 다음 cycle로 이월되며 이번 HYPE 실현 NAV에는 포함되지 않는다. 모든 share가 나가면 잔액이 기존 cohort에 귀속되지 못하고 stranded될 수 있으므로 production 정산 정책은 추가로 정해야 한다. constructor는 임의로 큰 무시 한도를 막기 위해 `quoteDust <= 1_000_000`을 강제한다.

## 단위 검증 상태

- HYPE EVM은 18자리, Core HYPE는 8자리다. 정확한 변환 계수는 `1e10`이다.
- Core spot HYPE와 USDC는 모두 `weiDecimals=8`이다. Spot balance와 action 15의 `wei`는 해당 token wei로 해석한다.
- `BorrowLendUserTokenState.borrow.value`와 `supply.value`도 현재 token wei로 보이는 것이 가장 강한 해석이다. reserve 총량을 1e8로 나누면 현실적인 HYPE/USDC 수량이 되고 action 15와 일치한다.
- 다만 공식 `L1Read.sol` ABI는 `BasisAndValue`의 단위를 명시하지 않는다. 따라서 `value` 단위는 소액 supply/withdraw와 실제 PM borrow를 만들고 precompile 전후 delta를 비교하기 전까지 **통합 가정**이다. `basis`는 회계 원금, `value`는 이자가 반영된 현재 수량으로 보이지만 역시 live 검증이 필요하다.
- EVM USDC 계약은 6 decimals이지만 이 vault 경로는 Core USDC token wei 8자리를 사용한다. 두 단위를 섞으면 안 된다.

## 배포 전 순서

1. 배포 시점에 `spotMeta`, `meta`, token info read precompile로 모든 index와 decimals를 재검증한다.
2. 신규 vault 주소에 Core에서 quote token을 전송해 activation fee를 지불하고, 다음 EVM block 이후 `userExists`를 확인한다.
3. share-backed bootstrap bridge와 실패 시 permissionless recall/환불 상태를 구현하고 회계 invariant를 검증한다.
4. 사용자에게 공개한 최소 모집액이 Core에서 `$10k` PM 자격을 안정적으로 넘는지 확인한다. 상한은 더 엄격한 최신 PM 제한과 운영 risk cap 아래에 둔다.
5. action 16 전 open position/order/TWAP이 없음을 확인하고, 전송 후 공식 API `userAbstraction`이 `portfolioMargin`인지 확인한다. 단순 CoreWriter call 성공이나 owner 확인만으로 통과시키지 않는다.
6. mainnet 별도 테스트 계약으로 action 15 supply/withdraw의 spot 및 lending delta와 단위를 확인한다.
7. 소액 IOC 주문으로 perp/spot asset ID, 가격 단위, lot, cloid, reduce-only, cross/isolated 및 부분 체결 상태 변화를 확인한다.
8. 테스트넷 HYPE perp는 strict isolated이므로 HYPE PM carry 성공 증거로 쓰지 않는다. PM 호환 자산 통합 시험과 HYPE transfer 시험을 분리한다.
9. CoreWriter action이 reject 또는 zero-fill될 때 `pendingAction`을 안전하게 해제/재시도할 방법을 구현한다. 현재 read 변화만 기다리는 상태는 영구 정지가 가능하다.
10. Core→EVM recall 때 실제 native HYPE 발신자가 `0x2222...2222`인지, 수신액이 요청 gross인지 gas 차감 net인지 소액으로 확인한다.
11. 전체 종료에서 perp=0, quote debt=0, lending supply=0, spot hold=0, HYPE 수신 및 share 정산을 같은 시나리오로 확인한다.
12. 운영 cap과 oracle deviation은 실제 depth, PM borrow cap, HYPE supply cap 및 청산 stress test를 기준으로 정한다.
13. 독립 보안 감사와 제한된 파일럿을 통과하기 전 mainnet 사용자 자금을 받지 않는다.

## 근거

- 로컬 공식 ABI snapshot: `reference/L1Read.sol`
- 로컬 read-only 근거: `reference/mainnet-probe.json`, `reference/testnet-probe.json`, `reference/live-market-read-2026-09-19.json`, `reference/mainnet-corewriter-observation-2026-09-19.json`
- 공식 문서: [Interacting with HyperCore](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), [Interaction timings](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings), [Activation gas fee](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee), [Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids), [Tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size), [HyperCore ↔ HyperEVM transfers](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers), [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin), [HyperEVM overview](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperevm)
