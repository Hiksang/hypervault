# Managed Vault: precompile NAV 구현과 증명 경계

2026-10-05. 운용 중 **동기 지분 발행**을 위한 온체인 NAV·발행 보호·액션 최종성·종료 검증의 현행 구현 관리 원본이다. 채택 근거는 [ADR-027](DECISIONS.ko.md#adr-027)·[ADR-028](DECISIONS.ko.md#adr-028)·[ADR-029](DECISIONS.ko.md#adr-029), 회계식과 gas의 관측 근거는 [공개 mainnet 관측](managed-precompile-evidence.ko.md), Vault 본체는 [현행 Vault 명세](managed-usdc-vault-implementation.ko.md), 실행 수치는 [STATUS](STATUS.ko.md)를 따른다.

**상태:** 로컬 구현·mock precompile 회귀 완료. 회계식과 precompile gas는 공개 계정의 읽기 전용 관측으로 대조했다. 별도 컨텍스트의 자동 코드 리뷰를 받아 반영했으며 이는 독립 보안 감사가 아니다. **프로젝트 계정의 통제 왕복(입금·거래·회수), 독립 보안 감사, 메인넷 배포는 하지 않았다.** 실자금 개방 조건은 [BACKLOG](BACKLOG.ko.md#nav-001)에 남는다.

## 구현 흐름

```text
owner가 Vault별 평가 범위 등록 (token / USDC perp DEX / HyperCore vault)
  → HyperCorePrecompileSource.evaluate(vault): 같은 EVM 호출에서 L1Read precompile 조회·평가
  → ManagedPortfolioNavVerifier.verifyNav: Core 순자산 + Vault.availableCash(), 지분 가격 기록과 대조
  → ManagedUsdcVault.totalAssets
  → 입금 전 preview → 정확한 EVM USDC 수령 → 같은 거래에서 share 발행
```

| 계약 | 책임 |
| --- | --- |
| [HyperCorePrecompileSource](../src/nav/HyperCorePrecompileSource.sol) | Vault별 등록 범위·버전·입금 스위치, precompile 평가, 범위 밖 보유의 신고와 확인, raw 진단 조회 |
| [ManagedPortfolioNavVerifier](../src/managed/ManagedPortfolioNavVerifier.sol) | Vault의 immutable `verifier`. `verifyNav`·`recordPrice`·`verifyAction`·`abandonRecall`·`verifyIdle` |
| [CoreRead](../src/CoreRead.sol) | selector 없는 ABI 입력, bounded gas, 반환 길이 검사. 실패·빈 응답을 0으로 바꾸지 않음 |
| [IManagedCoreNavSource](../src/interfaces/IManagedCoreNavSource.sol) | source와 verifier 사이의 평가 인터페이스 |

Vault 코드·ABI·storage는 바꾸지 않았다. Factory template의 `verifier`에 이 검증기를 넣어 배포하면 연결된다. 한 source/verifier를 여러 Vault가 공유하며 등록 범위·신고·가격 기록·회수 포기 기록은 모두 Vault 주소별이다. 외부 서명·keeper 보고·owner 입력 금액은 없고 `proof` 인자는 사용하지 않는다.

## 평가식

precompile은 계정 모드(Standard·Unified·Portfolio Margin)와 무관하게 **서로 겹치지 않는 raw 장부**를 반환한다. API가 보여 주는 통합 잔액은 이 장부의 합이다. 공개 계정 16개(Unified 10, PM 4, default 1, disabled 1)의 관측이며 Standard 계열은 2개뿐이다([관측](managed-precompile-evidence.ko.md#raw-ledger-identity)). 이에 따라 모드별 평가기를 나누지 않고 하나의 식을 쓰며 계정 모드를 조회하지 않는다.

```text
equity(token) = spotBalance.total                          # 0x0801, hold 포함값
              + lending supply.value − borrow.value         # 0x0811
              + (USDC만) Σ accountMarginSummary(dex).accountValue   # 0x080f, 등록 DEX
              + (USDC만) Σ userVaultEquity(coreVault).equity        # 0x0802, 등록 vault

Core NAV(USDC 1e18) = Σ equity(token) × price(token) / 10^weiDecimals
Vault NAV(USDC 1e6) = floor(Core NAV) + Vault.availableCash()
```

- spot `hold`·`entryNtl`, `marginUsed`, position PnL·funding을 다시 더하지 않는다. `accountValue`에 이미 mark 기준 미실현 손익과 지급된 funding이 들어 있다. 미지급 누적 funding은 포함되지 않는다. `hold`는 장부가 아니므로 `total`과 비교하지도 않는다.
- lending은 원금 `basis`가 아니라 이자 반영 `value`다. token의 차입은 음수로 남긴다.
- **등록 DEX의 `accountValue`가 음수이면 발행 평가는 `NegativeDexEquity`로 거부한다.** DEX 장부의 결손은 spot이나 다른 DEX 잔액에 소구할 수 없으므로 상계하면 NAV가 실제보다 낮아져 신규 지분이 과다 발행된다. 종료 평가는 음수를 그대로 합산하고 부채로 표시한다.
- 단위: spot·lending은 token `weiDecimals`(USDC 8), margin summary와 vault equity는 USDC 6자리다. 자산은 내림, 부채는 올림으로 환산한다.
- `availableCash()`만 더한다. EVM 직접 송금·확정 claim 준비금은 제외된다([ADR-013](DECISIONS.ko.md#adr-013)).
- **Core 계정으로 들어온 비요청 자금은 구분할 수 없으므로 계정 순자산에 포함된다.** 기존 주주의 가치가 오를 뿐 송금자에게 지분이 생기지 않는다.

## 등록 범위

`configure(vault, tokens, dexes, coreVaults, enabled)`는 해당 Vault의 `owner()`만 호출하며 범위 전체를 교체한다. 목록은 오름차순·중복 금지이고 USDC는 필수다. 상한은 **token 6개·DEX 8개·HyperCore vault 2개**다([gas](#gas)). 변경마다 `version`이 증가하고 `ScopeConfigured` 이벤트에 전체 범위가 남는다. 검증에 실패한 변경은 기존 범위를 건드리지 않는다.

| 항목 | 호출자가 주는 값 | Core에서 대조하는 값 |
| --- | --- | --- |
| token | index, USDC 직접 pair, `lending`, `reservePrice` | `tokenInfo`의 decimals(`szDecimals ≤ 8`, `szDecimals ≤ weiDecimals ≤ 18`). USDC는 Circle bridge 주소, EVM 6자리, `szDecimals = weiDecimals`. 그 외는 `spotInfo`의 base/quote, `reservePrice`이면 reserve 조회 성공 |
| DEX | index | `accountMarginSummary` 조회 성공(없는 DEX는 precompile 오류) |
| coreVault | HyperCore vault 주소 | `userVaultEquity` 조회 성공 |

decimals·가격·잔액은 호출자가 입력하지 못한다. **DEX의 담보 토큰은 precompile로 확인할 수 없으므로 USDC 담보 DEX만 등록해야 한다.** 이 조건은 owner 책임이다.

항목은 보유가 없을 때만 범위에서 뺄 수 있다(`ScopeInUse`). token은 차입이 없고 `spot + lending 공급`에 **팔 수 있는 것이 없어야** 한다. 온전한 lot(`10^(weiDecimals − szDecimals)` wei, 주문 최소 단위)을 최우선 매수호가로 평가해 10 USDC 미만이면 팔 수 없는 잔량이므로 남긴 채 뺄 수 있다. 누군가 보낸 소량이 token을 범위에 묶어 두지 못하게 하기 위해서다. 매수호가 조회가 실패하면 뺄 수 없다. DEX는 summary 네 필드 0, vault는 equity 0이어야 한다. `lending` 해제는 공급이 1 lot 미만이고 차입이 0이거나, 해당 토큰의 lending 장부가 없어 조회가 실패할 때만 허용한다.

**이 기준은 그 순간의 매수호가만 본다.** 매수호가가 없거나 아주 낮은 순간에는 보유 규모와 무관하게 token을 뺄 수 있다. 빠진 보유는 그때부터 다른 범위 밖 보유와 같다. 지분 가격의 하락으로 보이므로 [급락 대기](#발행-가격-기록과-급락-대기)가 걸리고, 매수호가가 돌아오면 [신고](#미등록-보유-신고)할 수 있다. spot mark로 한 번 더 제한하는 안은 채택하지 않았다. 호가가 빈 시장에서도 mark는 마지막 값으로 남아 있어([관측](managed-precompile-evidence.ko.md#empty-book)) 팔 수 없는 보유가 다시 token을 범위에 묶게 된다. 그 token은 가격 가드에 걸려 있으므로 발행도 가격 기록도 할 수 없고, 기록이 없으면 종료도 정산되지 않는다. 얇은 시장의 mark는 owner도 움직일 수 있어 막는 효과도 작다. 유동성 있는 token만 등록하게 하는 [결정 대기 B](DECISIONS.ko.md#adr-029)가 이 경우를 없앤다.

`lending=true`인 token은 조회가 반드시 성공해야 하고 실패는 평가 거부다. `lending=false`인 token도 매 평가에서 장부를 확인한다([확인 방식](#gas)). 장부가 없으면 통과한다. 공급이 1 lot 미만이고 차입이 0이면 그 공급을 보유에 더한 뒤 통과한다. **집계하지 않는 장부에 1 lot 이상의 공급이나 차입이 있으면 `ScopeIncomplete`로 거부한다.** 반환 길이가 다른 응답은 "장부 없음"이 아니라 `InvalidObservation`이다. PM의 자동 공급이나 등록을 잊은 공급이 NAV에서 조용히 빠지지 않고 입금·종료를 닫는다. USDC는 `configure`가 lot 1 wei를 요구하므로 한 단위도 누락되지 않는다.

`setEnabled(vault, false)`는 owner의 입금 스위치다. 꺼진 범위는 `evaluate`가 거부해 Ready/Active의 입금이 닫히고, 종료 검증(`exposure`)은 계속 동작한다. Idle은 검증기를 거치지 않고 실현 현금으로 발행하므로 이 스위치의 영향을 받지 않는다.

**범위의 완전성은 owner 책임이다.** 제공된 ABI는 계정의 모든 토큰·DEX·outcome을 열거하지 못하며 API wallet은 등록되지 않은 시장도 거래할 수 있다. 미등록 노출은 평가에 보이지 않고, 그 사이의 입금은 싸게 발행되어 기존 주주가 희석된다. 컨트랙트가 이것을 스스로 찾아낼 수는 없다. 대신 아래 두 장치가 있다: 누구나 범위 밖 보유를 증명해 Vault를 닫을 수 있고([신고](#미등록-보유-신고)), 지분 가격이 급락한 직후에는 발행하지 않는다([급락 대기](#발행-가격-기록과-급락-대기)). 지원하지 않는 대상은 HIP-4 outcome(수량 단위·정산 미검증), USDC 외 담보 DEX, staking, sub-account, HIP-3 backstop 예치다.

## 미등록 보유 신고

전체 보유는 온체인에서 열거할 수 없지만 **이름이 주어진 대상의 잔액은 읽을 수 있다.** 그래서 찾는 일은 오프체인(공개 API로 열거), 확인은 온체인으로 나눈다. 신고자를 신뢰하지 않는다.

| 함수 | 성립 조건 (등록 범위가 책임지지 않는 대상을 지금 읽었을 때) |
| --- | --- |
| `reportToken(vault, token, pair, viaQuote, quotePair)` | **등록되지 않은 token:** 차입이 있음. 또는 `spot + lending 공급`의 온전한 lot을 지목한 pair의 최우선 매수호가로 평가해 [주문 최소 금액](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses)(`MinTradeSpotNtl`) 이상. `pair`는 그 token이 base인 spot pair다. USDC로 호가되지 않으면 `quotePair`(quote token의 USDC pair)를 거치며, **두 단계 모두** 최소 금액을 넘어야 한다(첫 단계는 quote token 10개, 둘째 단계는 10 USDC). **등록된 token:** 차입이 없고, 등록된 USDC pair가 그 보유를 주문 최소 금액 미만으로 치며(종료 평가가 0으로 센다), 지목한 pair에서는 최소 금액의 두 배인 **20 USDC 이상**에 팔 수 있을 때. 첫 단계의 조건은 같다(quote token 10개). USDC는 신고할 수 없다 |
| `reportDex(vault, dex)` | 포지션이 있음(`ntlPos ≠ 0`). 또는 `accountValue`가 원시 단위로 10e6 이상(USDC 담보 DEX에서 10 USDC) |
| `reportCoreVault(vault, coreVault)` | equity 10 USDC 이상 |

- **신고는 그 대상이 지금도 성립하는 동안에만 Vault를 닫는다.** `evaluate`와 `exposure`는 평가할 때마다 신고된 대상을 다시 읽고, 성립하면 `OpenReport`로 거부한다. 그동안 입금이 닫히고 종료 정산도 확정되지 않는다. 가격 기록은 계속된다([아래](#발행-가격-기록과-급락-대기)). owner가 그 보유를 팔거나 등록 범위 안으로 되돌리면 그 순간부터 다시 평가된다. 별도의 해제 호출이 필요 없다. 등록해서 답하는 경우는 아래 규칙을 따른다.
- 신고 한 번에 한 순간의 증명만 있으면 되지만, 그 순간이 지나면 효력도 없다. 매수호가를 잠깐 세워 신고한 뒤 호가를 거두면 신고는 목록에 남아도 아무것도 닫지 않는다.
- 신고는 Vault당 **한 건**만 보관한다. 평가마다 다시 읽는 비용 때문이다. **성립하는 신고는 자리를 지킨다.** 그동안 다른 대상의 신고는 `NotReportable`로 거부되고, 같은 대상을 다시 신고하면 기한만 갱신되며 보관된 증명 경로(`pair`·`quotePair`)는 바뀌지 않는다. 소멸했거나 더는 성립하지 않는 신고는 새 증명에 자리를 내준다. 성립 중인 신고를 다른 증명이 밀어낼 수 있으면, 제3자가 아무도 거래하지 않는 token을 Vault에 보내고 한 블록 동안만 매수호가를 세워 신고한 뒤 호가를 거두는 것으로 진짜 신고를 걷어낼 수 있다.
- **owner의 `configure`가 성립 중인 신고를 풀면 그 신고는 목록에서 빠지고, 그때까지의 가격 기록은 발행과 종료의 이력으로 세지 않는다**(`reportAnsweredAt`). `configure`는 범위를 바꾸기 직전에 보관된 신고가 성립하는지 읽고, 바꾼 뒤 그 대상이 등록돼 있으면 다시 읽는다. 등록 뒤에 성립하지 않으면 목록에서 지우고, 직전까지 성립하던 신고였다면 이력을 다시 시작한다. 그 전에 이미 성립하지 않게 된 신고나 소멸한 신고는 지워질 뿐이다. 스스로 풀린 신고가 목록에 남아 있다는 이유로, 나중의 무관한 범위 변경이 입금과 정산을 닫지 않게 하기 위해서다. DEX와 HyperCore vault는 등록하면 항상 신고가 풀린다. token은 등록 뒤에도 아래의 등록된 token 조건이 성립하면 신고가 남고, 그렇지 않으면 풀린다. 풀리는 경우는 셋이다. 등록된 pair가 그 보유를 10 USDC 이상으로 사 준다(이제 종료 평가가 센다). 차입 때문에 신고된 것이었다(이제 평가가 부채로 다룬다). 지목된 pair에서의 가치가 10 USDC 이상 20 USDC 미만이다(등록된 token으로는 신고 크기에 못 미친다). **마지막 경우 그 보유는 등록 뒤 종료 평가에 잡히지도 않고 신고할 수도 없다.** 이력은 다시 시작되지만 token당 20 USDC 미만이 보이지 않게 된다. 이 규칙을 둔 이유는 자리가 하나라는 데 있다. owner가 자기 소액 보유(10 USDC)를 먼저 신고해 두면 진짜 대상은 아무도 올릴 수 없는데, 그 소액 대상을 등록하면 Core 액션 없이, 따라서 블록을 넘기지 않고 신고가 풀린다. 등록 뒤에는 새 기록이 `priceWindow / 2`를 채워야 입금과 정산이 다시 열린다. 이 규칙은 한 블록 안에서 끝나던 경로를 아래의 순서 경쟁으로 되돌릴 뿐이다. owner는 등록과 같은 거래에서 자기의 다른 소액 보유를 다시 신고해 자리를 또 차지할 수 있다. 그 전의 기록은 이력에서만 빠지고 최고 가격의 기준으로는 계속 쓰인다. 신고를 받고 정직하게 등록한 owner도 같은 대기를 겪는다.
- **등록된 token도 등록 범위가 그 보유를 책임지지 않는 동안에는 신고할 수 있다.** 등록된 token은 종료 평가에서 등록된 USDC pair의 매수호가로만 세고 주문 최소 금액 미만이면 0으로 보므로, 그 pair에 매수호가가 없으면 다른 pair에서 팔 수 있는 보유도 0으로 잡힌다. 등록됐다는 이유만으로 신고할 수 없게 두면, 그런 token에 가치를 두는 것으로 신고와 종료 평가를 모두 벗어난다. owner가 미끼 신고로 감시자를 막아 둔 채 숨긴 token을 그런 pair로 등록해도 되고, 빈 상태로 먼저 등록해 두고 다른 미등록 대상에 두었던 가치를 나중에 옮겨 넣어도 된다. 그래서 등록된 token은 차입이 있거나(평가가 부채로 다룬다) 등록된 pair에서 팔 수 있는 가치가 있을 때(종료 평가가 센다)에만 신고 대상에서 빠진다. 그 밖에는 신고할 수 있되, **지목한 pair에서 주문 최소 금액의 두 배(20 USDC) 이상**에 팔 수 있어야 한다. 등록된 pair가 10 USDC에 조금 못 미치게 치는 잔량이 다른 pair의 조금 높은 호가만으로 신고되면, 제값으로 평가되고 있는 Vault를 작은 잔량 하나로 누구나 닫을 수 있기 때문이다(리뷰 중 공개 시장을 한 번 읽었을 때 같은 token의 pair 사이 매수호가 차이는 최대 20%였다). 결과적으로 등록된 token 보유는 종료 평가에 잡히거나, 다른 pair에서 20 USDC 이상에 팔 수 있으면 신고할 수 있다. **이 보장에는 조건이 있다.** 신고 자리가 비어 있어야 하고(아래), 그 token이 base인 pair의 매수호가로만, pair 두 개 이내의 경로로만 증명할 수 있으며, 차입이 있는 동안에는 신고할 수 없다. 등록된 pair가 사 주게 되면 그 신고는 더 성립하지 않고, 종료 평가가 그 가치를 세어 `CoreNotFlat`으로 정산을 막는다([시험](../test/ManagedLiveNav.t.sol)의 `testAHiddenTokenCannotBeRegisteredOutOfReachBehindADecoy`·`testATokenRegisteredEmptyAndFilledLaterCanStillBeNamed`). 등록된 DEX와 HyperCore vault는 잔액이 그대로 평가에 들어오므로 신고할 수 없고, USDC도 신고할 수 없다. 방해 비용은 미등록 token보다 크다. 제3자가 등록된 token을 보내고 다른 pair에 매수호가를 세워 신고하려면, 그 호가가 20 USDC 이상을 사 주어야 하고 등록된 pair가 치는 값의 두 배를 넘어야 한다. owner가 그 호가에 팔면 그 금액을 Vault가 받는다.
- **한 건만 보관하는 데서 오는 한계.** 보관된 신고가 가리키지 않는 대상은 평가 때 읽지 않는다. 누군가 먼저 신고한 대상이 성립하는 동안에는 더 큰 보유가 따로 있어도 올릴 수 없다. 그동안 Vault는 닫혀 있지만, 그 신고가 풀리는 블록에는 아무것도 걸려 있지 않다. **그 블록은 누구나 쓸 수 있다.** 악의적인 owner는 자기 소액 보유를 신고해 자리를 차지해 두거나 감시자가 신고한 대상에서 가치를 다른 미등록 대상으로 옮긴 뒤, Core에서 신고된 대상을 비우고, 그것이 반영된 첫 블록에서 감시자의 다음 신고보다 먼저 입금하면 싸게 발행된다([시험](../test/ManagedLiveNav.t.sol)의 `testEmptyingTheReportedVenueIsARaceTheWatcherHasToWin`). 정직한 owner에게서도 생긴다. 보관된 신고가 작은 대상을 가리키는데 더 큰 보유가 아직 범위 밖에 있는 상태에서 그 작은 대상을 정리하면, 그 블록에 들어온 제3자의 입금이 싸게 발행된다. 그래서 신고된 대상을 정리하기 전에 다른 범위 밖 보유를 모두 등록하거나 회수한다([운용 순서](#운용-순서)). 이 한 블록의 순서 경쟁은 이 구조에서 닫히지 않는다. 증명의 효력을 일정 시간 유지하면 없어지지만, 제3자가 순간 호가만으로 비용 없이 Vault를 닫아 둘 수 있게 되므로 넣지 않았다([결정 대기 F](DECISIONS.ko.md#adr-029)).
- 신고는 **1일** 뒤 소멸한다. 보유가 계속되면 감시자가 갱신한다. 기한을 두는 이유는 신고된 대상을 더 읽을 수 없게 됐을 때다. 조회 실패는 "보유 없음"으로 보지 않으므로 그 신고가 소멸할 때까지 평가가 거부되는데, 그 기간이 하루를 넘지 않는다. 그동안에는 범위 변경도 되지 않는다. `configure`가 소멸하지 않은 신고의 대상을 먼저 읽기 때문이다. 그런 신고는 갱신할 수도 없다.
- `clearReport(vault, index)`는 누구나 호출하는 목록 정리다. 소멸했거나 성립하지 않는 신고만 지워지고 성립하면 `ReportStands`다. 지우지 않아도 Vault는 열리지만, 남아 있는 신고는 평가마다 다시 읽히므로 gas가 든다([gas](#gas)).
- 방해 비용: 신고가 Vault를 닫고 있으려면 그 보유가 실제로 팔 수 있는 상태여야 한다. 방해하려는 제3자가 세운 매수호가는 그동안 체결될 수 있고, owner가 실제로 팔면 제3자는 10 USDC 이상을 Vault에 주게 된다. owner가 팔지 않는 동안에는 그 호가를 유지하는 데 비용이 들지 않는다. 매수호가가 없는 token은 그 순간에는 신고할 수 없다. 끝내 매수호가가 돌아오지 않으면 그 보유는 옮겨 둔 가치가 아니라 손실과 같고, 돌아오면 그때 신고할 수 있다.

**신고로 잡을 수 없는 것:** HIP-4 outcome(수량 단위와 전송 가능성을 확인하지 못해 제외했다), sub-account로 옮긴 자금(온체인에서 관계를 확인할 수 없다), HIP-3 backstop 예치, 대상마다 10 USDC 미만으로 나눠 둔 보유(합계는 대상 수 × 10 USDC까지 될 수 있다), 그 순간 어느 pair에도 매수호가가 없는 token(크기와 무관하다), pair 두 개(quote token 하나)를 넘게 거쳐야 USDC가 되는 token, 포지션 없이 결손만 남은 DEX, 보관된 신고가 성립하는 동안의 다른 모든 대상, 그리고 아무도 신고하지 않은 보유. **등록된 DEX와 HyperCore vault도 신고할 수 없다.** 그 잔액은 평가에 그대로 들어오지만, 담보가 USDC가 아닌 DEX를 등록하면 그 equity가 USDC로 잘못 읽히며 이것은 컨트랙트가 확인할 수 없는 owner 책임이다. 등록된 token은 등록된 pair가 그 보유를 주문 최소 금액 이상으로 사 주는 동안 신고할 수 없고, 등록된 pair가 10 USDC 미만으로 치는 보유는 다른 pair에서 20 USDC 미만이면 신고할 수 없다(등록 token 5개까지, 각 20 USDC 미만). owner가 그 pair의 호가를 좌우할 수 있으면 보유를 실제보다 낮게(그러나 10 USDC 이상으로) 세게 만들 수 있고, 그때 종료는 그 가치 때문에 정산되지 않지만 발행 평가는 낮아진 가격을 쓴다([결정 대기 B](DECISIONS.ko.md#adr-029)). staking은 Vault와 agent 어느 쪽으로도 실행할 경로가 없어 대상에 넣지 않았다. 찾는 일은 [scope_watch.py](../scripts/scope_watch.py)가 한다. 공개 API로 보유를 열거해 등록 범위와 비교하고, 신고·갱신·정리 호출을 만들어 배포된 계약에 `eth_call`로 시뮬레이션한 뒤 계약이 받아들이는 것만 보낼 목록에 넣는다. 읽기 전용이며 거래를 보내고 주기적으로 실행하는 부분은 아직 없다([BACKLOG](BACKLOG.ko.md#ops-001)).

**확인하지 못한 방해 경로:** token 발행자가 특정 계정의 잔액을 동결할 수 있는 token이 있다(공식 SDK의 `spotDeploy` `freezeUser`). 동결된 잔액을 팔 수 없다면, 그런 token을 Vault에 보내고 자기 매수호가를 세워 둔 사람은 비용 없이 신고를 유지할 수 있다. 동결된 잔액의 동작은 공개 문서에 없고 테스트넷 확인이 필요하다([BACKLOG](BACKLOG.ko.md#nav-001)). 이 경우의 복구(owner 선언과 지연을 거친 제외)는 [결정 대기 E](DECISIONS.ko.md#adr-029)이며, 결정 대기 A와 같은 형태의 문제다.

## 가격 정책

| token | 가격 | 거부 조건(`PriceGuard`) |
| --- | --- | --- |
| USDC | 1 (가치 통화. 달러 peg 보장이 아님) | — |
| `reservePrice=true` | `borrowLendReserveState.oraclePx` (0x0812). [프로토콜의 spot·perp mark·perp oracle 중앙값](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin) | spot mark 0, oracle 0, **oracle과 spot mark(0x0808)의 차이가 mark의 2% 초과** |
| `reservePrice=false` | `spotPx` (0x0808, spot mark) | 가격 0, 호가 한쪽 없음·역전, 가격이 `[bid, ask]` 밖, spread가 ask의 1% 초과 |

어느 가격을 쓸지는 owner가 등록 때 정한 `reservePrice` 플래그를 따른다. raw 가격은 `10^(8 − szDecimals)` 단위이고 `price18 = raw × 10^(10 + szDecimals)`다. 순보유가 0인 token은 가격을 읽지 않으므로 보유하지 않은 token의 호가 이상이 NAV를 닫지 않는다. 차입이 없고 보유가 1 lot 미만인 token은 가격이 거부돼도 0으로 보고 넘어간다. 1 lot 이상이나 차입은 반드시 가격이 있어야 한다. 따라서 owner가 다 팔고도 등록해 둔 token에 누군가 1 lot 이상을 보내면, 그 token의 가격이 거부되는 동안(호가가 넓거나 비어 있을 때) 입금이 닫힌다. 그 잔량이 팔 수 없는 크기이면 owner는 token을 범위에서 빼서 입금을 다시 열 수 있다([등록 범위](#등록-범위)). **다 판 token은 같은 단계에서 범위에서 뺀다.** 가격 조회 자체가 실패하면 dust여도 오류다.

가격별 갱신 timestamp는 precompile에 없으므로 요구하지 않는다. 평가 시점은 **이 EVM 블록이 구성될 때의 Core 상태**이고 `l1BlockNumber`를 함께 반환한다. 이전 구현의 `observedAt`·`maxAge`·`complete` 필드는 제거했다.

reserve oracle은 perp가 없는 토큰에서 고정값이거나 spot 호가를 그대로 따를 수 있으므로 spot mark와의 일치를 함께 요구한다. 두 가드는 **가격의 폭과 서로의 일치만 제한하며 수준을 보증하지 않는다.** 얇은 시장에서는 한 블록 동안 양쪽 호가를 원하는 가격에 세울 수 있다. 하방 조작은 아래의 급락 대기가 발행을 막지만, 호가로만 평가되는 토큰을 허용할지는 [결정 대기](DECISIONS.ko.md#adr-029)다. perp 평가는 Hyperliquid mark를 그대로 따르며 HIP-3 DEX의 mark 품질은 해당 DEX에 의존한다.

## Vault 연결

- `verifyNav`는 Vault의 asset·`actionNonce`·`configHash`가 호출 인자와 같은지 확인한 뒤 평가한다.
- Core 순자산이 음수이면 `NegativeCoreEquity`로 거부한다. Core 부채는 EVM 현금에 소구할 수 없으므로 현금과 상계하면 NAV가 낮아져 신규 지분이 과다 발행된다.
- Idle은 실현 cash 가격을 유지한다. Ready/Active는 검증기 NAV를 쓴다. 관리 액션 pending·Exiting·범위 미등록/비활성·조회 실패·가격 가드·DEX 결손·성립한 신고·가격 기록 부족·급락 대기에서는 `totalAssets()`가 revert하고 `maxDeposit`·`maxMint`는 0이며 `deposit`·`mint`·`depositWithLimit`과 controller 인자가 있는 두 overload는 `CapitalClosed`다. upgrade 제안 중에는 `totalAssets()`는 값을 반환하고 `maxDeposit`만 0이 된다. 실패를 NAV 0으로 바꾸지 않는다. 상환 요청(`requestRedeem`)은 요청 시점에 가격을 쓰지 않으므로 평가 불가 상태에서도 열려 있다.
- 새 USDC는 EVM 현금으로 남고 owner가 후속 Core 배정을 결정한다.

### 발행 가격 기록과 급락 대기

범위 밖으로 옮겨진 가치는 온체인에서 손실과 똑같이 지분 가격의 하락으로 보인다. 그래서 원인을 가리지 않고 **지분 가격이 떨어진 직후에는 발행하지 않는다.**

- `recordPrice(vault)`는 누구나 호출해 현재 지분 가격 `(순자산 + 1) × 1e30 / (totalSupply + 1000)`을 기록한다. 순자산은 `availableCash`에 등록 범위의 Core 순자산(`scopeValue`)을 더한 값이다. Vault당 8건을 보관하고, 새 기록은 직전 기록에서 `priceWindow / 8`보다 지난 뒤에만 추가된다. 가장 오래된 기록은 창을 벗어난 뒤에만 덮어쓰인다.
- **그 간격 안에서는 더 높은 가격만 직전 기록의 가격을 대체한다**(시각은 그대로). 같거나 낮은 가격은 `PriceRecordTooSoon`이다. 먼저 기록한 사람이 그 표본을 독점하지 못하게 하기 위해서다.
- 지분이 하나도 없으면 `NoShares`로 거부한다(그때의 비율은 가격이 아니다). **관리 액션이 pending이어도 기록한다.** 전송 중인 자금은 어느 장부에도 없어 그때의 가격은 낮게 나올 뿐 높게 나오지 않고, 낮은 기록은 기준을 내리지 않는다. pending이 기록을 막으면 owner가 Core가 처리할 수 없는 회수를 걸어 둔 채(포기를 선언하고 대기 기간이 지날 때까지 닫히지 않는다) 기록을 끊을 수 있다.
- **범위 스위치와 신고도 기록을 멈추지 못한다.** `scopeValue`는 `evaluate`와 같은 식·같은 가격 가드로 등록 범위를 평가하되 `setEnabled`와 신고를 보지 않는다. 발행과 종료가 모두 이 기록을 요구하므로, owner가 붙잡아 둘 수 있는 상태로 기록이 끊기면 그것이 창을 비우는 수단이 된다. 신고가 성립하는 동안의 기록은 범위 밖 가치가 빠진 낮은 가격일 수 있지만 낮은 기록은 기준을 내리지 않는다. **등록 범위 자체를 평가할 수 없는 상태(가격 가드, 집계하지 않는 lending 장부, 음의 DEX equity, 조회 실패, 음의 Core 순자산, 범위 미등록)에서는 기록도 되지 않는다.** owner는 이 상태를 만들 수 있다(예: 등록 token의 호가를 가드 밖으로 두기, 집계하지 않는 장부에 공급하기). 이 경로의 한계는 아래에 적었다.
- **Idle에서는 현금 기준 가격 `(availableCash + 1) × 1e30 / (totalSupply + 1000)`을 기록한다.** Idle의 Vault가 실제로 발행에 쓰는 비율이며 Core를 읽지 않는다. 종료 뒤 Core에 남은 dust까지 넣으면, 지분이 거의 남지 않았을 때 그 비율이 수만 배로 튀어 다음 운용 기간의 발행을 한 창 동안 닫는다.
- `verifyNav`는 최근 `priceWindow` 안의 기록만 본다. 그중 **마지막으로 신고가 답해진 시각(`reportAnsweredAt`)보다 뒤에 만든** 가장 오래된 기록이 `priceWindow / 2` 이상 지나 있어야 하고(`PriceHistoryTooShort`), 현재 가격이 창 안 최고 기록의 `(1 − maxDrawdownBps)` 이상이어야 한다(`PriceDropCooldown`).
- 두 값은 배포 시 고정한다. `priceWindow`는 10분~1일, `maxDrawdownBps`는 10~2,000이다.
- 판정은 최고 기록을 기준으로 하므로 낮은 가격을 기록해도 기준이 내려가지 않는다.
- **종료 정산에도 같은 두 조건이 있다.** `verifyIdle`은 정산으로 지급될 현금 기준의 지분 가격(`availableCash` ÷ 지분)이 창 안 최고 기록보다 한도 넘게 낮으면 `PriceDropCooldown`으로, 창 안의 가장 오래된 기록이 `priceWindow / 2`를 채우지 못하면 `PriceHistoryTooShort`로 거부한다. 범위 밖에 가치를 남긴 채 정산하면 상환자가 그만큼 덜 받기 때문이다. 기록이 없을 때 정산을 허용하면, 기록이 끊긴 채 한 창이 지난 Vault는 가치를 뺀 직후에도 곧바로 정산된다. **지분이 없는 Vault의 종료는 두 조건을 보지 않는다.** 지분이 없으면 어떤 단계에서도 기록할 수 없고 그 종료는 아무에게도 지급하지 않는다. 이 예외가 없으면 전액 상환 뒤 입금을 받기 전에 관리 액션으로 Idle을 벗어난 Vault는 다시 Idle로 돌아오지 못한다.
- `nav(vault)`는 발행 평가에서 가격 기록 검사만 생략한 조회용 함수다. 범위 비활성·성립한 신고·가격 가드·DEX 결손처럼 발행 평가가 거부되는 상태에서는 이 조회도 실패한다. 기록에 쓰이는 값과 달리 스위치와 신고를 따른다.

결과적으로 지분 가격이 한도를 넘게 떨어지면, 그 전의 기록이 창을 벗어나고 새 기록이 `priceWindow / 2`를 채울 때까지 입금이 닫힌다. 하락 직전에 기록이 있었으면 그 시간은 `priceWindow`에 가깝고, 하락 전 절반 창 동안 아무도 기록하지 않았으면 `priceWindow / 2`까지 짧아진다. 기록이 계속 만들어지는 Vault에서는 이 시간이 곧 가치가 범위 밖에 있어야 하는 시간이고, 감시자가 그 보유를 신고할 수 있는 시간이다. 이 장치는 지분 가격이 갑자기 낮게 평가되는 다른 경우에도 작동한다: 얇은 시장의 하방 가격 조작, 전송 중인 회수를 포기한 직후, Core 입금의 반영 지연.

가치를 기록하는 블록에만 잠깐 범위 밖에 두어 낮은 표본을 쌓는 방법은, 가치가 돌아온 뒤 누군가 그 표본을 제 가격으로 되돌리면 통하지 않는다. **누군가 실제로 되돌려야 한다.** [scope_watch.py](../scripts/scope_watch.py)는 표본 사이에도 현재 가격이 직전 기록보다 한도의 절반 넘게 높으면 기록을 보내도록 판단한다.

**owner가 기록을 끊을 수 있으면 이 대기는 가치가 범위 밖에 있는 시간이 아니게 된다.** owner가 등록 범위를 평가할 수 없는 상태로 만들어 두면(위) 그동안 아무도 기록하지 못하고, 가치는 범위 안에 있으므로 신고할 것도 없다. 제 가격의 기록이 창을 벗어난 뒤 owner는 한 블록 동안만 범위를 평가 가능하게 하고 낮은 가격을 기록하고, 반 창 뒤 한 블록에서 가치를 범위 밖에 둔 채 입금하거나 정산한다. 첫 기록에는 가치를 범위 밖에 둘 필요조차 없다. 관리 액션이 pending인 동안에는 전송 중인 자금이 어느 장부에도 없어 같은 낮은 가격이 기록된다. 가치가 범위 밖에 있어야 하는 것은 한두 블록뿐이다. 낮은 기록을 만드는 블록의 신고는 가치가 돌아오면 효력이 없고, 마지막 블록은 위 신고의 순서 경쟁과 같다. 관리 액션 pending으로 기록을 끊는 길은 막았지만(위), 평가할 수 없는 범위로 끊는 길은 남아 있다. 그 상태에서도 기록이 되게 하면 낮은 표본을 블록 하나 없이 얻게 되어 더 나빠지므로 그렇게 하지 않았다.

**이것은 지연이지 증명이 아니다.** 아무도 신고하지 않으면 창이 지난 뒤 낮은 가격이 새 기준이 되어 발행이 재개되고, 종료도 창이 지나면 정산된다([시험](../test/ManagedLiveNav.t.sol)의 `testWithoutAReportTheDrawdownPauseOnlyBuysTime`·`testWithoutAReportTheExitPauseOnlyBuysTime`). **의도적인 owner를 상대로 두 장치가 보장하는 것은 길어야 한 창의 지연과, 그 끝에서 감시자가 한 블록의 순서 경쟁을 이겨야 한다는 조건뿐이다.** 등록을 잊은 owner의 실수와, 감시자가 제때 신고하는 경우의 악용은 막는다. 한도 이하의 하락은 걸리지 않는다. 대가도 있다.

- 실제 손실이 한도를 넘은 직후에도 입금이 닫히고 종료 정산이 한 창까지 늦어진다. 포지션 정리 비용이 한도를 넘으면 종료마다 그렇게 되므로 한도는 그보다 크게 잡는다.
- **팔 수 없는 잔량이 등록 범위에 남아 있으면 정산이 한 창보다 오래 미뤄질 수 있다.** 기록은 그 잔량을 가격(mark 또는 oracle)으로 평가하고 정산은 현금만 지급하므로, 잔량이 순자산에서 차지하는 비율이 한도를 넘으면 기록이 이어지는 동안 정산이 계속 거부된다. 종료가 남길 수 있는 것은 dust 상한에 token당 10 USDC 미만을 더한 값이어서, 등록 token 5개까지 합해 60 USDC 미만이므로, 한도 5%에서는 순자산 약 1,200 USDC 미만, 0.1%에서는 약 60,000 USDC 미만인 Vault에서 생길 수 있다. owner가 그 token을 범위에서 빼면 이후의 기록에는 들어가지 않고 한 창 뒤 정산된다([시험](../test/ManagedLiveNav.t.sol)의 `testAnUnsellableRemainderDelaysASmallExitUntilItLeavesTheScope`). 종료 절차에 이 단계를 넣었다([운용 순서](#운용-순서)).
- 누군가 `priceWindow / 2`보다 짧은 간격으로 가격을 기록해야 한다. 기록이 끊긴 Vault는 기록 뒤 `priceWindow / 2`가 지나야 입금이 열리고 종료가 정산된다. keeper가 없어도 owner나 상환자가 직접 기록할 수 있다. **다만 등록 token의 가격이 가드에 걸려 있는 동안에는 기록할 수 없다.** 그런 token을 1 lot 이상 보유한 채(누군가 보낸 1 lot도 마찬가지다) 마지막 기록이 창을 벗어나면, owner가 그것을 팔거나 범위에서 뺀 뒤 새 기록이 반 창을 채울 때까지 종료가 정산되지 않는다([시험](../test/ManagedLiveNav.t.sol)의 `testARefusedPriceStopsTheRecordsUntilTheOwnerDropsTheToken`). 종료 평가 자체는 호가 상태에 묶이지 않지만 가격 기록은 묶인다. USDC만 등록한 Vault에는 이 경로가 없다.
- 가격을 잠깐 끌어올린 순간을 기록하면 그 기록이 창에 있는 동안 입금이 닫힌다. 간격 안에서도 더 높은 가격은 기록되므로 그 시점을 고르기가 쉽다.
- Idle의 발행은 검증기를 거치지 않으므로 두 장치가 적용되지 않는다. Idle의 기록은 그 현금 기준 가격이어서 운용을 다시 시작할 때 기록이 이어진다. 전액 상환으로 끝난 운용 기간의 기록이 창 안에 남아 있으면, 그 기간이 한도 넘는 수익으로 끝난 경우 다음 기간의 첫 발행이 그 창 동안 닫힌다.

<a id="gas"></a>
### gas

한 입금 거래는 평가를 2회(`maxDeposit`, `previewDeposit`), `mint`는 4회 수행한다. 최대 범위(token 6·DEX 8·vault 2)를 가장 비싼 경로(전 토큰 보유·lending 장부 없음·reserve 가격)로 채우고, 더는 성립하지 않지만 목록에 남아 평가마다 다시 읽히는 신고 한 건을 더한 [로컬 모형](../test/ManagedNavGas.t.sol)의 값이다. 그 신고는 가장 비싼 형태로 골랐다: quote token을 거쳐 신고된 등록 token이며, 평가마다 lending 장부 확인, 그 token의 등록된 pair, 경로의 두 pair를 다시 읽는다. [소형 블록 한도](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture)는 3M이다.

| 대상 | [문서의 비용식](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore) `2000 + 65 × (입력 + 출력)` | 2026-10-04 실측에 맞는 식 `1000 + 33 × (입력 + 출력)` |
| --- | ---: | ---: |
| 평가 1회 | 약 0.63M | 약 0.43M |
| `deposit` | 약 1.43M | 약 1.03M |
| `mint` | 약 2.60M | 약 1.81M |

- 두 열 모두 **모형 값이며 Vault 거래의 네트워크 실측이 아니다.** 실측한 것은 개별 precompile 호출의 비용이다. 다섯 가지 형태의 조회가 모두 문서 값의 절반쯤인 `1000 + 33 × (입력 + 출력)`에서 성공하기 시작했고, 오류는 전달된 gas를 전부 소모했다([관측](managed-precompile-evidence.ko.md#precompile-gas)). 범위 상한은 더 비싼 문서 식으로 정했다. 상한을 token 8·DEX 12로 올리면 그 식에서 `mint`가 3M을 넘는다.
- 위 값은 함수를 직접 호출했을 때다. 같은 거래에서 `previewMint`를 먼저 부르는 컨트랙트는 평가가 한 번, `maxMint`를 부르면 두 번 더 든다. **최대 범위에서는 문서 식 기준으로 `previewMint`와 `mint`를 한 거래에 넣을 수 없다**(약 3.23M, `maxMint`까지 부르면 약 3.85M).
- 모형은 측정 전에 같은 주소와 slot을 한 번 읽어 두므로 첫 접근(cold) 비용이 거의 반영되지 않는다. 실제 거래의 gas는 측정하지 않았다.
- `lending=false` token의 장부 확인은 gas 20,000으로 제한한 호출이다. 성공한 조회는 문서 식으로 14,480, 실측으로 7,336이다. 장부가 없으면 그 20,000이 소모된다. 이 실패를 "장부 없음"으로 받아들이기 전에 두 가지를 확인한다.
  - 호출 뒤 남은 gas가 `20,000 / 63` 이하이면 거부한다. EIP-150에 따라 gas를 조여 확인만 실패시킨 호출자에게는 그 이상 남을 수 없다.
  - 평가당 한 번, 같은 형태(입력 64·출력 128바이트)이고 어떤 계정에도 응답하는 조회(기본 DEX의 margin summary)가 같은 20,000 안에서 128바이트로 응답해야 한다. precompile 비용이 올라 확인이 항상 실패하게 되는 경우를 조용히 넘기지 않기 위해서다. 그 평가에서 장부 확인이 한 번이라도 응답했으면 그것이 더 직접적인 증거이므로 이 대조 조회를 생략한다.
  - 남는 한계: 대조 조회는 같은 형태의 조회가 한도 안에 든다는 것만 보여 준다. lending precompile(0x0811)만 비싸지거나 모든 계정에 실패하게 바뀌면, 장부가 있는 token이 하나도 등록돼 있지 않은 Vault에서는 집계하지 않는 장부가 "없음"으로 읽힌다.
- 모형 시험은 gas 한도를 1,000~150,000에서 97 간격으로, 그리고 정상 거부가 처음 나타나는 지점 아래 6,000 구간은 1 간격으로 훑는다. 집계하지 않는 장부가 있는 평가는 어디서도 값을 반환하지 않았다. 범위 변경도 311 간격으로 훑었다. 모든 gas 값을 본 것은 아니다.

## 액션 최종성

Core는 CoreWriter 액션의 영수증을 EVM에 돌려주지 않는다. 검증기는 Vault의 `pendingAction()`과 ID·digest가 같은지 확인하고 [공식 처리 순서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings)에 근거해 판정한다. EVM→Core 전송과 지연 대상이 아닌 CoreWriter 액션은 그 EVM 블록 직후 처리되므로 **더 뒤의 Core 블록**은 이미 그 결과를 반영한다. `syncCoreAction(id, "")`과 `finalizeActivation("")`은 누구나 호출할 수 있다.

| kind | 판정 |
| --- | --- |
| 공통 | `l1BlockNumber > submittedCoreBlock`이 아니면 `ActionNotFinal` |
| Deposit | 성공, `receivedAssets = assets`. 활성화 시 Vault가 `userExists`와 Core USDC 100 이상을 추가 확인 |
| Recall | `unaccountedUsdc() ≥ assets`이면 성공하고 정확히 `assets`만 장부에 편입. 부족하면 대기. **owner가 `abandonRecall(vault, id)`로 포기를 선언하고 그 선언에서 `recallTimeoutBlocks`가 지났을 때만** 닫히며, 그때 도착해 있던 금액을 편입한다(0이면 실패) |
| Agent·RevokeAgent·Control | 성공으로 보고. **Core 쪽 거절은 관측할 수 없다** |

Recall은 Vault가 실제로 보유한 장부 밖 USDC만 편입하므로 영수증으로 현금을 만들 수 없다. 제3자가 같은 금액을 EVM으로 보내 도착을 가장해도 편입액은 실제 잔액이고 Core 자금은 계속 NAV에 남는다.

**시간만으로는 회수가 실패 처리되지 않는다.** 전송 중인 USDC를 두고 pending이 풀리면 NAV가 그만큼 낮게 평가되므로, 닫는 결정은 owner만 내린다. 선언은 회수를 제출한 Core 블록에서는 할 수 없고, 대기는 제출이 아니라 **선언한 Core 블록부터** 센다. 같은 액션을 다시 선언해 시계를 옮길 수 없고, 선언은 그 액션 ID에만 적용된다. `recallTimeoutBlocks`는 배포 시 10,000~2,000,000 **Core 블록**으로 고정한다. 2026-10-04 공개 관측에서 Core 블록은 초당 약 14개였으므로 약 12분~40시간에 해당하지만, 이 속도는 프로토콜 상수가 아니다. owner는 API로 Core의 거절을 확인한 뒤에만 포기해야 한다.

포기 뒤 일부만 도착했으면 그 금액이 편입되어 부족분이 NAV 손실로 드러난다. 포기 뒤 늦게 도착한 USDC는 장부 밖에 남아 NAV에 들어가지 않는다. 그동안 지분 가격은 낮게 보이므로 급락 대기가 발행을 막는다. 이 USDC는 **Core가 거절하는** 같은 금액 이하의 recall이 확정될 때 편입된다. Core가 그 recall을 실행하면 이미 있던 금액이 편입되는 대신 새로 보낸 금액이 다시 전송 중이 된다. Vault에는 장부 밖 USDC를 Core 액션 없이 편입하는 함수가 없다.

agent 등록·해지의 Core 적용 여부는 온체인으로 읽을 수 없다. `apiWallet` 저장값은 "제출 후 Core 블록이 지났다"는 뜻이며 실제 적용은 API로 확인해야 한다. Deposit도 같은 규칙이다. Circle 입금의 Core 반영이 한 블록 넘게 지연되면 그 금액이 빠진 NAV가 나오고, 그 하락이 한도를 넘으면 급락 대기가 발행을 막는다. 이 지연의 실제 분포는 관측하지 않았다.

## 종료 검증

`verifyIdle`은 아래를 모두 만족할 때만 통과한다(`CoreNotFlat`, 신고는 `OpenReport`, 가격은 `PriceHistoryTooShort`·`PriceDropCooldown`).

- 지금 성립하는 신고가 없다.
- 마지막으로 신고가 답해진 뒤에 만든 창 안의 가장 오래된 가격 기록이 `priceWindow / 2` 이상 지나 있고, 지급될 현금 기준의 지분 가격이 창 안 최고 기록보다 한도 넘게 낮지 않다([급락 대기](#발행-가격-기록과-급락-대기)). 지분이 없는 Vault에는 이 조건을 적용하지 않는다.
- 등록 범위에 차입·perp 포지션·음의 DEX equity가 없다.
- **아직 가져올 수 있는 가치**가 0 이상 `idleDustLimit` 이하다. 이 값은 USDC 장부(spot·lending 순액·DEX equity·vault equity)에, token별로 팔 수 있는 보유를 최우선 매수호가로 평가해 더한 것이다.

token 보유는 온전한 lot만 세고, 그 가치가 매수호가 기준 10 USDC(주문 최소 금액) 미만이면 0으로 본다. Core가 그 주문을 받지 않으므로 owner가 팔 수 없기 때문이다. 종료 평가는 가격 가드를 쓰지 않는다. 호가가 넓어도 매수호가가 있으면 팔 수 있고, 매수호가가 없으면 팔 수 없다. 따라서 누군가 등록 token 소량을 Vault의 Core 계정으로 보내거나 시장이 죽어도 그것이 "Core에 남은 것"으로 세어지지는 않는다(같은 송금이 발행을 닫을 수는 있다. [가격 정책](#가격-정책)). **다만 정산에 필요한 가격 기록은 호가 상태에 묶인다.** 그 token의 가격이 가드에 걸려 있고 Vault가 1 lot 이상 보유하면 기록할 수 없으므로, 마지막 기록이 창을 벗어난 뒤에는 owner가 그 token을 팔거나 범위에서 빼야 정산이 다시 가능해진다([급락 대기](#발행-가격-기록과-급락-대기)의 대가). 팔 수 있는 양(10 USDC 이상)을 보내면 owner가 팔아 회수해야 하고, 그 금액은 주주에게 귀속된다.

**종료를 방해하는 데 드는 값은 dust 상한이고, 작은 Vault에서는 그보다 작을 수 있다.** 종료 중 누군가 Vault의 Core 계정에 `idleDustLimit`을 조금 넘는 USDC를 보내면 owner는 회수와 sync를 한 번 더 해야 정산할 수 있다. 보낸 돈은 주주에게 귀속되지만 반복할 수 있으므로, 상한을 정할 때 이 값이 곧 방해 한 번의 비용임을 고려한다. 순자산이 작은 Vault에서는 등록 token을 팔 수 없는 양(10 USDC 미만)만 보내도 그 가치가 급락 한도를 넘어, owner가 그 token을 범위에서 뺄 때까지 정산이 미뤄진다([급락 대기](#발행-가격-기록과-급락-대기)의 대가).

`idleDustLimit`은 배포 시 0보다 크고 10 USDC 미만(최대 9.999999 USDC)으로 고정한다. 0을 허용하지 않는 이유는 회수 단위(USDC 6자리)보다 작은 Core 잔액(8자리)이 어떤 회수로도 옮겨지지 않기 때문이다. 10 USDC 이상을 허용하지 않는 이유는 그것이 신고가 성립하는 크기이기 때문이다. 종료가 등록 대상에 남기는 것은 신고될 만한 크기가 되지 않는다. 종료 뒤 Core에 남을 수 있는 것은 이 상한과, token마다 팔 수 없는 잔량(매수호가 기준 10 USDC 미만, 또는 매수호가가 없는 보유 전부)이다. 남은 것은 정산 가격에 들어가지 않고 다음 운용 기간의 주주에게 귀속된다. **매수호가가 없는 순간의 보유는 크기와 무관하게 0으로 본다.** 그 보유를 다른 pair에서 20 USDC 이상에 팔 수 있으면 누구나 신고해 정산을 막을 수 있지만([미등록 보유 신고](#미등록-보유-신고)), 그보다 작거나 어느 pair에서도 팔 수 없으면 그대로 남는다. 얇은 시장의 토큰을 그런 순간에 남기는 것은 owner 신뢰 범위이며, 유동성 있는 token만 등록하게 하는 [결정 대기 B](DECISIONS.ko.md#adr-029)와 연결된다.

HyperCore vault 예치는 lock-up이 끝나 인출해야 0이 되고, 그 인출은 API wallet으로 수행하므로 **agent 해지보다 먼저** 끝내야 한다.

## 운용 순서

1. `createVaultAndFund` → 다음 블록에 `finalizeActivation("")` → Ready.
2. owner가 `configure`로 범위를 등록하고 켠다. 누군가 `recordPrice`를 호출하고 `priceWindow / 2`가 지나야 입금이 열린다. 기록은 범위를 꺼 둔 상태에서도 할 수 있다.
3. keeper가 `recordPrice`를 주기적으로 호출한다. 간격은 `priceWindow / 2`보다 짧아야 하고, [scope_watch.py](../scripts/scope_watch.py)는 한 번 빠져도 입금이 닫히지 않도록 `priceWindow / 4`를 쓴다(`priceWindow / 8` 이하 간격에서는 새 기록이 추가되지 않고, 직전 기록보다 높은 가격만 그 기록의 가격을 바꾼다). 감시자는 같은 스크립트로 Vault의 Core 보유를 열거해 범위 밖 보유를 신고한다. 보관되는 신고는 한 건이므로 자리가 비어 있을 때 계약이 받아들이는 대상 중 가장 큰 곳 하나를 보내고, 성립 중인 신고는 누가 올린 것이든 소멸이 가까워지면 갱신한다(소멸 시각은 누구나 알 수 있는 순간이다). 성립 중인 신고가 풀리면 곧바로 다음 대상을 올린다.
4. 새 token·DEX·vault를 쓰기 **전에** 등록한다. 신고를 받은 뒤에 그 대상을 등록해 신고가 풀리면 그 시점부터 새 가격 기록이 반 창을 채울 때까지 입금과 정산이 닫힌다. **token은 USDC pair에 매수호가가 실제로 있는 것만 등록한다.** 등록된 pair가 사 주지 않는 token 보유는 누구나 신고할 수 있고, 팔아서 회수할 때까지 입금과 정산이 닫힌다. 신고된 대상을 정리할 때는 먼저 다른 범위 밖 보유를 모두 등록하거나 회수한다. 신고가 풀리는 블록에 다른 보유가 범위 밖에 남아 있으면 그 블록의 입금이 싸게 발행된다. lending 공급을 하면 대상 token의 `lending`을 켠다. **Portfolio Margin에서는 담보로 쓰일 수 있는 모든 등록 token의 `lending`을 켠다.** 자동 공급이 잔액을 lending 장부로 옮기기 때문이다. 장부가 없는 token에 먼저 켜면 장부가 생길 때까지, 장부가 생긴 뒤에도 켜지 않으면 켤 때까지 평가가 거부돼 입금이 닫힌다. 어느 순서든 잘못된 가격으로 발행되지는 않는다.
5. 관리 액션 뒤에는 다음 블록에 `syncCoreAction`을 호출한다. pending 동안 입금은 닫힌다. **지분이 하나도 없는 Vault에서는 관리 액션을 하지 않는다.** 먼저 Idle에서 입금을 받는다. 지분 없이 Idle을 벗어나면 가격을 기록할 수 없어 입금이 열리지 않고, 다시 종료 절차(`beginExit` → `settleEpoch`)를 거쳐 Idle로 돌아와야 한다.
6. 회수가 도착하지 않으면 API로 Core의 거절을 확인하고 `abandonRecall` → 선언에서 대기 기간이 지난 뒤 `syncCoreAction`.
7. 종료: 포지션 정리 → HyperCore vault 인출 → `recallUsdcFromCore` → sync → `revokeApiWallet` → sync → `beginExit` → `settleEpoch(epoch, "")`. 정산에는 반 창 이상 된 가격 기록이 필요하므로 종료 중에도 기록을 이어 간다. 팔 수 없는 잔량이 남은 token은 `configure`로 범위에서 빼고, 그 잔량이 순자산의 한도 비율을 넘었다면 뺀 뒤 한 창을 기다린다.

## 검증 범위와 한계

[단위 시험](../test/ManagedPrecompileNav.t.sol)은 precompile 응답을 주입해 평가식·단위·반올림·범위 규칙·신고·가격 가드·조회 실패·가격 기록과 급락 대기·최종성·회수 포기·종료 조건을 검사한다. 일부 fixture는 공개 계정의 실제 raw 값이다. [종단 시험](../test/ManagedLiveNav.t.sol)은 실제 Factory·Vault에 이 검증기를 연결해 활성화→등록→가격 기록→운용 중 `deposit`·`mint`·`depositWithLimit`→Core 배정→손익→범위 밖으로 옮긴 가치와 신고→회수·포기·늦은 도착→종료 정산→청구와 두 Vault의 격리를 실행한다. [gas 시험](../test/ManagedNavGas.t.sol)은 비용식 모형이다. 세 시험 모두 주입한 precompile 응답을 쓰며 네트워크 증거가 아니다.

**알려진 한계 (구현하지 않은 것):**

- **owner의 거래는 신뢰 대상이다.** owner가 자기 다른 계정과 불리한 가격에 거래해 가치를 빼는 것은 이 구조에서 막을 수 없다. 신고와 급락 대기는 등록 누락과 발행 악용을 다룬다. 다른 구조와의 비교는 [구조 비교안](managed-scope-enforcement-options.ko.md)에 있다.
- 신고는 누군가 해야 하고, outcome과 sub-account는 신고할 수 없다. 급락 대기는 발행과 종료 모두에서 지연이지 증명이 아니다(위). 가격 표본을 제 가격으로 되돌리는 일과 신고의 갱신도 누군가 해야 한다.
- **의도적인 owner를 상대로 두 장치가 보장하는 것은 길어야 한 창의 지연과 한 블록의 순서 경쟁이다.** 신고는 지금 성립할 때만 Vault를 닫으므로, owner가 신고된 대상을 Core에서 비우거나 숨긴 가치를 다른 미등록 대상으로 옮긴 직후의 블록에 감시자보다 먼저 입금·정산하면 통과한다(위 미등록 보유 신고). 등록 범위를 평가할 수 없는 상태로 두어 가격 기록을 끊을 수 있으면, 가치가 범위 밖에 있어야 하는 시간도 한두 블록으로 줄어든다(위 급락 대기). 이 구조에서 닫지 못한 한계이며, 주문을 Vault 함수로만 내게 하는 구조([구조 비교안](managed-scope-enforcement-options.ko.md)의 B)에서만 없어진다.
- 매수호가가 없는 순간에는 보유 규모와 무관하게 token을 범위에서 뺄 수 있다(위 등록 범위).
- 동결할 수 있는 token을 이용한 신고 유지(위 미등록 보유 신고)는 확인하지 못했고 복구 경로가 없다([결정 대기 E](DECISIONS.ko.md#adr-029)).
- **등록 항목의 조회가 계속 실패하면 복구 경로가 없다.** 등록 token의 호가 조회, 등록 DEX·vault의 조회가 프로토콜 변경으로 실패하게 되면 평가도 범위 변경도 할 수 없어 종료가 확정되지 않는다. 검증기는 immutable이고 Vault upgrade는 Idle에서만 가능하다. owner의 선언과 지연을 거쳐 그런 항목을 제외하게 할지는 [결정 대기 A](DECISIONS.ko.md#adr-029)다. 시장이 죽었지만 조회는 되는 token은 종료 평가를 막지 않는다. 가격 기록은 막으므로 owner가 그 token을 범위에서 빼야 한다(위 종료 검증).
- 호가로만 평가되는 토큰의 한 블록 가격 조작(위 가격 정책)과 매수호가가 없는 순간의 종료(위 종료 검증).
- lot이 큰 토큰(`szDecimals`가 작고 단가가 높은 경우)은 1 lot 미만 잔량의 가치가 클 수 있다. 그런 토큰은 등록하지 않는다.
- Circle이 bridge 주소를 바꾸면 `configure`가 `InvalidObservation`으로 막혀 범위를 수정할 수 없다. 기존 범위의 평가는 계속된다.
- 평가는 EVM 블록 구성 시점의 Core 상태이므로 최대 한 블록 뒤처진 가격으로 발행된다. 상환이 비동기라 같은 블록의 왕복 차익은 불가능하다.
- Factory의 선제 활성화 차단은 이 변경 이전부터 있던 별개의 문제다([FACTORY-001](BACKLOG.ko.md#factory-001)).

**관측으로 확인한 것 (표본 한 번):** 한쪽 또는 양쪽 호가가 빈 spot 시장에서 `bbo`는 되돌리지 않고 빈 쪽을 0으로 반환했고 `spotPx`는 0이 아닌 값을 유지했다([관측](managed-precompile-evidence.ko.md#empty-book)). 신고와 종료 평가가 "매수호가 0 = 팔 수 없음"으로 읽는 전제다.

**확인하지 못한 것:** 프로젝트 Vault 계정의 실제 EVM↔Core 왕복과 시스템 전송의 블록 내 순서, Circle 입금 지연·일시정지 시 동작, 모드 전환 직후의 장부 이동, PM에서 수신 잔액이 자동 공급되는 조건, USDC 외 담보 DEX 단위, HIP-4 수량·정산, 음의 계정 가치가 남는 경우, Vault 거래 전체의 실제 gas, API wallet이 실제로 할 수 있는 동작의 범위. 이 항목은 [통제 실험](managed-mainnet-scenarios.ko.md)과 독립 감사로 닫는다.
