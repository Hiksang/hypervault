# Managed Vault: 미등록 보유 방지 구조 비교안

2026-10-04 작성, 2026-10-05 선택 반영. **상태: 사용자가 "A 먼저, B는 나중에"를 선택했다. A안은 로컬 구현됐고 B·C안은 구현하지 않았다.** 사용자가 "등록하지 않은 자산을 운용하면 지분이 잘못 발행되는 문제는 방지돼야 한다"고 지적했고, 현행 구조를 유지하는 방법과 구조를 바꾸는 방법의 비교를 요청했다. 이 문서는 그 비교이며 선택의 근거로 남긴다. 결정은 [ADR-029](DECISIONS.ko.md#adr-029)에 있고, **현행 동작은 [precompile NAV 명세](managed-precompile-nav.ko.md)가 관리한다.** 3절은 선택 당시의 초안이라 구현과 다른 점이 있다(아래).

**초안과 구현의 차이:** 이름이 다르다. 초안의 `report`는 `reportToken`·`reportDex`·`reportCoreVault`, `checkpoint`는 `recordPrice`가 됐고, 해제 호출은 성립하지 않는 신고를 목록에서 지우는 `clearReport`만 남았으며, 기록 간격은 생성자 인자가 아니라 `priceWindow / 8`로 고정했다. 신고 대상에서 outcome을 뺐다(수량 단위와 전송 가능성을 확인하지 못했다). 신고는 표시를 남기는 방식이 아니라 평가마다 대상을 다시 읽어 지금도 성립할 때만 Vault를 닫는다. Vault당 1건만 보관하고 성립하는 신고는 자리를 지키며(그동안 다른 대상의 신고는 거부, 같은 대상의 재신고는 기한만 연장), 1일 뒤 소멸하므로 다시 신고해 갱신한다. owner가 신고된 대상을 등록해 신고를 풀면 그때까지의 가격 기록은 발행과 종료의 이력으로 세지 않는다. 등록된 token도 등록된 pair가 그 보유를 사 주지 않는 동안에는 신고할 수 있다. 급락 대기는 종료 정산에도 기록 길이 요건과 함께 적용되고, 기록 간격 안에서는 더 높은 가격이 직전 기록을 대체한다. 가격 기록은 입금 스위치, 신고, pending 관리 액션과 무관하게 계속된다. 급락 대기의 창과 한도는 초안 값이 아니라 배포 시 정하는 인자(10분~1일, 0.1%~20%)다. 이후 사용자가 builder fee 페이백 모델을 확정했고([ADR-030](DECISIONS.ko.md#adr-030)), 이는 B안과 양립하지 않는다.

## 1. 문제

현행 NAV는 owner가 등록한 범위만 평가한다([등록 범위](managed-precompile-nav.ko.md#등록-범위)). owner의 API wallet은 등록하지 않은 시장도 거래할 수 있으므로, 등록 범위 밖으로 옮겨진 가치는 NAV에서 빠지고 그동안의 입금은 싸게 발행된다.

```text
실제 순자산 N, 범위 밖으로 옮겨진 가치 H, 그 사이의 입금 D
발행 가격은 (N − H) 기준 → 기존 주주에서 입금자로 넘어가는 가치 = D × H / (N − H + D)
예: H = N/2, D = N/2 → N/4
```

- **실수:** 등록을 빠뜨린 채 매수하면 등록할 때까지의 모든 입금이 싸게 발행된다.
- **악용:** owner가 가치를 범위 밖으로 옮기고, 다른 주소로 입금하고, 되돌린다. EVM 블록 한두 개 간격으로 끝난다.

컨트랙트가 이것을 그냥 막지 못하는 이유는 세 가지다.

1. HyperCore에는 API wallet의 거래 대상을 제한하는 권한이 없다.
2. precompile은 "대상 X의 잔액"은 읽지만 계정이 무엇을 보유하는지 열거하지 못한다.
3. 범위 밖으로 옮겨진 가치와 실제 손실은 온체인에서 똑같이 NAV 하락으로 보인다.

API wallet이 할 수 있는 일의 범위는 다음과 같다. [공식 Exchange 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)의 서명 형식으로 구분한 것이며 프로젝트 계정에서 실행해 본 결과가 아니다.

| 구분 | 액션 |
| --- | --- |
| API wallet 서명으로 가능 | 주문·취소·수정, TWAP, leverage·isolated margin 변경, `agentSendAsset`(같은 계정의 spot↔perp DEX 이동), `vaultTransfer`(HyperCore vault 예치·인출), `agentSetAbstraction`, outcome 조작 |
| 계정 본인 서명 필요 | `usdSend`·`spotSend`·`sendAsset`·`withdraw3`(다른 주소로의 송금·출금), staking, agent 승인, builder fee 승인 |

Vault는 계약이라 본인 서명을 할 수 없고, 아래 줄의 동작은 Vault가 CoreWriter 함수로 제공할 때만 가능하다. 따라서 API wallet은 자금을 **계정 밖으로 보내지 못하지만** 계정 안에서 미등록 spot token·미등록 perp DEX·미등록 HyperCore vault·outcome으로 옮길 수 있다. 이 네 가지는 모두 대상을 지정하면 precompile로 잔액을 확인할 수 있다. sub-account 생성·이체가 API wallet으로 가능한지는 확인하지 못했다.

## 2. 비교 대상

| 안 | 요약 |
| --- | --- |
| **A** | 현행 구조 유지. 검증기 쪽에 보호 장치 두 개(신고 차단, 급락 대기)를 추가 |
| **B** | 주문을 Vault 함수로만 제출. API wallet을 쓰지 않고 등록 자산만 주문 가능 |
| **C** (참고) | 운용 중에는 발행하지 않고 전액 현금 상태(Idle)에서만 발행 |

## 3. A안 — 현행 구조 + 보호 장치

Vault 본체·입출금 방식·API 매매는 그대로다. 변경은 [source](../src/nav/HyperCorePrecompileSource.sol)와 [verifier](../src/managed/ManagedPortfolioNavVerifier.sol)에만 들어간다.

### 3.1 신고 차단

전체 보유는 온체인에서 열거할 수 없지만 오프체인 공개 API로는 열거할 수 있다. 그래서 **찾는 일은 오프체인, 확인은 온체인**으로 나눈다.

- 누구나 `report(vault, 종류, 대상)`을 호출한다. 컨트랙트가 그 대상의 잔액을 precompile로 직접 읽고, 등록 범위에 없으면서 임계값 이상이면 그 Vault를 "범위 불완전"으로 표시한다. 신고자를 신뢰하지 않는다.
- 표시된 동안 발행 평가(`evaluate`)와 종료 평가(`exposure`)가 모두 거부된다. 입금이 닫히고 종료 정산도 확정되지 않는다.
- owner가 그 대상을 등록하거나 임계값 미만으로 줄이면 누구나 해제를 호출하고, 컨트랙트가 다시 읽어 확인한다.

| 대상 | 온체인 확인 | 임계값(초안) |
| --- | --- | --- |
| spot token | `spotBalance` + lending 장부, 가격은 호출자가 지정한 pair를 `spotInfo`로 검증해 읽음 | 보유 × 최우선 매수호가 ≥ 10 USDC, 또는 차입 존재 |
| perp DEX | `accountMarginSummary` | `accountValue` ≥ 10 USDC 또는 포지션 존재 |
| HyperCore vault | `userVaultEquity` | equity ≥ 10 USDC |
| outcome | encoded ID의 `spotBalance` | 보유 × 가격 ≥ 10 USDC |

임계값을 주문 최소 금액(10 USDC)으로 두는 이유는 방해 공격 때문이다. 제3자가 미등록 토큰을 Vault의 Core 계정으로 보내 신고하려면 매번 10 USDC 이상을 줘야 하고, owner는 그것을 팔 수 있다(주문 최소 금액 이상이므로). 매수호가가 없는 토큰은 신고 대상이 아니다. 팔 수 없는 보유는 숨긴 가치가 아니라 손실과 같다.

감시는 봇이 한다. [equity_probe.py](../scripts/equity_probe.py)가 이미 계정의 DEX·token·vault 보유를 열거하므로, 등록 범위와 비교해 신고 거래를 만드는 부분을 더하면 된다. 신고 거래는 누구나 보낼 수 있어 플랫폼 봇 하나에 의존하지 않는다.

**이것만으로는 악용을 막지 못한다.** 가치를 옮긴 다음 블록에 입금하면 봇이 따라갈 수 없다. 그 틈은 3.2가 닫는다.

### 3.2 급락 대기

범위 밖으로 가치가 옮겨지면 지분 가격이 그 순간 떨어진다. 원인이 무엇이든 **급락 직후에는 발행하지 않는다.**

- 검증기가 Vault별로 최근 지분 가격 기록을 보관한다. 누구나 `checkpoint(vault)`로 현재 가격을 기록한다.
- 발행 평가는 두 조건을 요구한다. 최근 창 `W` 안의 기록이 `W/2` 이상의 기간을 덮을 것, 그리고 현재 가격이 창 안 최고 기록의 `(1 − δ)` 이상일 것. 아니면 거부해 입금이 닫힌다.
- 결과적으로 가격이 `δ` 넘게 떨어지면 그 전 기록이 창에서 빠질 때까지 발행이 닫히고, 그 시간 동안 봇이 신고할 수 있다.

한 창에서 옮길 수 있는 가치는 `δ × N` 이하로 제한되고, 넘어가는 가치도 그 이하다. 초안 값은 `W` 30분, `δ` 2%, 기록 간격 5분이며 실측과 상품 성격으로 정한다.

이 장치는 지분 가격이 갑자기 낮게 평가되는 다른 경우에도 작동한다: 얇은 시장의 하방 가격 조작([ADR-029](DECISIONS.ko.md#adr-029) 결정 대기 B), 전송 중인 회수를 포기한 직후, Circle 입금 반영 지연.

대가는 세 가지다. 실제 손실이 `δ`를 넘은 직후에도 한동안 입금이 닫힌다. 주기적으로 가격을 기록하는 keeper가 필요하고, 기록이 끊기면 입금이 닫힌다. 한동안 기록이 없던 Vault의 첫 입금은 기록 뒤 `W/2`를 기다려야 한다.

### 3.3 막는 것과 남는 것

- 막는 것: 등록 누락(실수), 가치를 옮긴 직후의 입금(악용), 신고된 미등록 보유를 남긴 채의 종료 정산.
- 남는 것: owner가 자기 다른 계정과 불리한 가격에 거래해 가치를 빼는 것. API 매매를 허용하는 한 **거래에 대해서는 owner를 신뢰해야 한다.** 한 창에 `δ` 이하의 소액 이전. 봇이 아무도 없을 때 `W`를 넘겨 숨긴 경우. sub-account 경로(미확인).
- 구현 뒤 리뷰에서 확인된 남는 것(2026-10-05): 감시 봇이 있어도, owner가 신고된 대상을 Core에서 비우거나 그 가치를 아직 신고되지 않은 대상으로 옮긴 뒤 그것이 반영된 첫 블록에 봇의 다음 신고보다 먼저 입금하면 발행된다. 급락 대기는 그 전에 가치가 반 창에서 한 창 동안 범위 밖에 있게 만들지만, owner가 등록 범위를 평가할 수 없는 상태로 두어 가격 기록을 끊으면 그 시간은 한두 블록으로 줄어든다. 신고가 "지금 성립할 때만" 닫는 한 이 한 블록의 순서 경쟁은 A에서 닫히지 않고, 주문 경로 자체를 제한하는 B에서만 없어진다. 신고의 효력을 시간으로 유지하는 방법은 제3자의 무비용 방해를 열기 때문에 넣지 않았다([현행 명세](managed-precompile-nav.ko.md#미등록-보유-신고), [ADR-029](DECISIONS.ko.md#adr-029) 결정 대기 F).

### 3.4 작업 범위

- source: 신고·해제 함수, 대상별 확인, 표시 상태에서의 평가 거부.
- verifier: 가격 기록, 창 검사, 생성자 인자(`W`, `δ`, 기록 간격).
- Vault·Factory·FE ABI: 변경 없음.
- 시험: 단위·종단·gas 모형에 신고·해제·방해 공격·급락·기록 공백 경로 추가.
- 운영: 감시 봇과 기록 keeper. 조회 부분은 오프라인으로 시험할 수 있고, 거래 전송에는 gas를 가진 키가 필요하다.
- 실측: API wallet의 `vaultTransfer`·`agentSendAsset`이 계약 계정에서 실제로 되는지, 미등록 대상의 precompile 조회.

## 4. B안 — Vault 경유 주문

### 4.1 구조

```text
owner(또는 owner가 지정한 EVM 거래 키)
  → Vault.placeOrder(asset, isBuy, limitPx, sz, reduceOnly, tif, cloid)
      1. asset이 등록 범위의 token/DEX에 속하는지 확인
      2. (선택) 가격 밴드·규모 한도 확인
      3. CoreWriter action 1 제출
```

API wallet은 등록하지 않는다. spot↔DEX 이동, lending 공급, HyperCore vault 예치 같은 자금 이동 함수도 등록 대상으로만 허용한다. NAV·발행·종료 검증은 현행 source/verifier를 그대로 쓴다.

### 4.2 CoreWriter로 할 수 있는 것

[공식 액션 표](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore) 기준이다.

| 구분 | 내용 |
| --- | --- |
| 있음 | limit 주문(ALO·GTC·IOC, reduce-only, cloid), oid·cloid 취소, spot↔perp·DEX 간 이동, lending 공급·회수, 계정 모드 변경, HyperCore vault 예치·인출, outcome 조작 |
| 없음 | 주문 수정, TWAP, trigger(TP/SL), 예약 취소, leverage·isolated margin 변경, 주문의 builder 코드 |
| 지연·비용 | 주문과 vault 이체는 Core에서 수 초 지연된다. CoreWriter 기본 호출은 약 47,000 gas |

### 4.3 완전성

등록 범위 밖의 노출을 만드는 경로가 Vault 함수에 없으므로 미등록 보유가 주문으로는 생기지 않는다. 외부에서 들어온 미등록 토큰은 NAV에 보이지 않지만 기존 주주에게 손해가 아니다.

남는 구멍은 미체결 주문이다. precompile에 미체결 주문 조회가 없어서, 토큰을 범위에서 뺀 뒤 남아 있던 GTC 주문이 체결되면 미등록 보유가 생긴다. 첫 버전은 IOC만 허용하거나, Vault가 cloid를 추적해 취소한 뒤에만 제거를 허용해야 한다. 주문의 체결·거절은 온체인 영수증이 없다. NAV는 잔액을 직접 읽으므로 영향이 없고 owner는 API 조회로 확인한다.

### 4.4 얻는 것

미등록 보유의 원천 차단 외에, **운용 규칙을 온체인으로 강제할 수 있게 된다.** A안에서는 불가능한 것이다.

- 자산 제한: 등록 범위(필요하면 플랫폼이 정한 유동성 있는 자산 목록) 안에서만 주문.
- 가격 밴드: 제출 시점의 mark·spot 가격 대비 limit 가격의 범위를 제한한다. owner가 자기 계정과 불리한 가격에 거래해 가치를 빼는 것이 주문당 밴드 폭 이내로 줄어든다.
- 규모 한도: 주문 notional, 총 노출.

손실이 나는 매매 판단 자체는 여전히 owner의 재량이다. 다만 "owner를 모르는 예치자"가 믿어야 하는 범위가 A안보다 훨씬 좁다.

### 4.5 잃는 것

- 속도: 주문마다 EVM 거래(1초 블록)와 Core의 수 초 지연. 고빈도·마켓메이킹은 할 수 없다.
- 주문마다 owner의 EVM 서명과 gas.
- 주문 유형 제한, leverage·isolated margin 변경 불가. 기본 leverage 값과 isolated 전용 자산의 동작은 확인하지 못했다.
- **builder fee:** CoreWriter 주문에는 builder 필드가 없다. 플랫폼의 builder fee 수익([ADR-011](DECISIONS.ko.md#adr-011), [MARKET-002](BACKLOG.ko.md#market-002))이 이 경로에서는 발생하지 않는다.
- 기존 API·SDK·봇을 쓸 수 없고 주문 화면과 도구를 직접 만들어야 한다.

### 4.6 작업 범위

- Vault: runtime 여유가 214 bytes라 주문·한도 로직을 넣을 수 없다. delegatecall 모듈로 분리해야 한다(Core 액션은 CoreWriter를 호출한 주소에 귀속되므로 Vault 주소의 문맥에서 실행돼야 한다). agent 함수 제거, 자금 이동 함수의 대상 제한, storage·크기 gate 재검증. 메인넷 배포 전이라 upgrade가 아니라 재구성으로 할 수 있다.
- source: 주문 자산과 등록 token/DEX의 대응 조회, 가격 밴드용 조회.
- 시험: Managed Vault 시험의 agent 경로 재작성, 자산 제한·밴드·범위 제거·미체결 주문 시험.
- FE: 주문·취소 화면. 호가와 체결 내역은 API 조회.
- 실측: 계약 계정 CoreWriter 주문의 귀속·지연·IOC 체결, spot·HIP-3 asset ID, 주문 최소 금액, 기본 leverage, isolated 전용 자산, Unified·PM에서의 주문.
- 결정 변경: [ADR-023](DECISIONS.ko.md#adr-023)(API 직접 매매)을 대체하고 ADR-011·[ADR-022](DECISIONS.ko.md#adr-022)·MARKET-002를 다시 정의한다.

## 5. C안 (참고) — 평탄 시점 발행

Ready/Active의 발행을 닫아 두면 Vault는 전액 실현 현금인 Idle에서만 지분을 발행한다. 발행 가격이 실제 USDC 잔액이라 NAV 신뢰 문제가 없다. 코드 변경도 거의 없다. 대신 운용 중에는 입금할 수 없고, 이는 이번 작업의 출발점인 "운용 중 실시간 발행" 요구를 포기하는 것이다. 기준선으로만 적는다.

## 6. 비교

| | A. 현행 + 보호 장치 | B. Vault 경유 주문 | C. 평탄 시점 발행 |
| --- | --- | --- | --- |
| 미등록 보유 | 생기면 감지해 입금·종료를 닫음 | 주문으로는 생기지 않음 | 발행에 영향 없음 |
| 가치를 옮긴 직후의 입금 | 급락 대기로 차단(`δ` 이하는 남음) | 해당 없음 | 해당 없음 |
| owner의 거래에 대한 신뢰 | 필요 | 필요하지만 자산·가격·규모를 온체인으로 제한 가능 | 필요 |
| 매매 방식 | API 직접, 모든 주문 유형 | Vault 거래, limit·IOC 중심, 수 초 지연 | API 직접 |
| builder fee | 유지 | 없음 | 유지 |
| 운용 중 실시간 발행 | 유지(급락 직후 일시 중단) | 유지 | 없음 |
| Vault 변경 | 없음 | 재구성 | 없음 |
| 운영 부담 | 감시 봇, 기록 keeper | 주문 도구·화면 | 없음 |
| 작업 규모 | 중간(계약 2개) | 큼(Vault·FE·운용 모델) | 작음 |
| 바뀌는 결정 | ADR-029에 추가 | ADR-023 대체, ADR-011·022 재정의 | ADR-027·028의 운용 중 발행 철회 |

## 7. 권고

갈림길은 기술이 아니라 **예치자가 owner를 얼마나 신뢰하는 상품인가**다.

- owner가 알려진 운용자이고 API 매매의 자유와 builder fee가 상품의 핵심이면 **A**가 맞다. 실수와 발행 악용을 막고, 거래는 신뢰에 맡긴다.
- 누구나 만든 Vault에 모르는 사람이 예치하는 시장을 목표로 하고 owner의 재량을 온체인으로 묶어야 하면 **B**가 맞다. B만이 자산·가격·규모를 강제할 수 있다.

구현자 권고는 **A를 먼저 넣고, B는 필요해질 때 별도 Vault 유형으로 추가하는 것**이었고 사용자가 이를 선택했다. 두 안은 배타적이지 않다. A는 Vault를 바꾸지 않고 현재 구조에 바로 들어가며, B를 나중에 택하더라도 A의 급락 대기는 가격 조작 방어로 계속 쓸 수 있다.

## 8. 확인하지 못한 것

- API wallet의 `vaultTransfer`·`agentSendAsset`·leverage 변경이 계약 계정에서 실제로 동작하는지. 위 권한 표는 문서의 서명 형식에 따른 구분이다.
- sub-account 생성·이체가 API wallet으로 가능한지. 가능하면 A안의 신고로도 확인할 수 없다.
- 계약 계정의 CoreWriter 주문 동작 전반(지연 시간, IOC, 기본 leverage, isolated 전용 자산).
- 급락 대기의 `W`·`δ`가 실제 변동성에서 입금을 얼마나 자주 닫는지.
