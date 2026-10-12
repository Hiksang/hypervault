# Managed precompile 공개 mainnet 관측

2026-10-04. [source 명세](managed-precompile-nav.ko.md)의 가정을 읽기 전용 RPC로 대조했다. 아래 계정은 기존 연구에서 발견한 **공개 계정**이며 프로젝트가 통제하는 Vault나 테스트 지갑이 아니다. 서명·입금·주문·회수·배포는 실행하지 않았다. 모든 precompile 조회는 각 파일의 단일 EVM 블록에 고정하고 수집 후 같은 블록 hash를 재확인했다. HTTP Info 응답은 block-pinned가 아니다.

## 1. Standard / Unified / PM

[새 원시 관측](reference/managed-precompile-modes-2026-10-04.json), [대조 결과](reference/managed-precompile-modes-reconcile-2026-10-04.json).

- 수집: `2026-10-04T10:40:09.672599+00:00`
- EVM block `0x2d6d90c`, hash `0x4732a2d3bc3da30978dc04aa85cd25983cdfda06a2803f389d0d56305fae274e`
- Core block `1171324780`; block hash 재확인 성공.

### USDC bridge metadata 수정

Core USDC tokenInfo의 weiDecimals=8, evmExtraWeiDecimals=-2였고, evmContract는 `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`였다. 이는 Circle CoreDepositWallet 주소이며 Vault가 받는 USDC ERC20 `0xb88339cb7199b77e23db6e890353e22632ba630f`와 다르다. 처음 adapter의 ERC20 직접 비교를 **별도 immutable usdcCoreBridge와 비교**하도록 수정했다. 6자리 ERC20와 Core8→EVM6 변환 조건을 따로 검사한다. 테스트도 bridge와 ERC20를 서로 다른 주소로 구성한다.

### lending 실패는 부채 0이 아니다

Standard(`disabled`)와 Unified 표본의 HYPE/USDC lending 조회는 `PrecompileError`였고 spot/margin 조회는 성공했다. 오류를 0 supply/debt로 바꾸지 않았다. 따라서 probe의 completePinnedReadSet=false / exit 2가 예상되며 자료 전체를 성공한 완전 NAV로 표시하지 않는다. 일부 계정에서 호출이 실패했다는 관측을 해당 모드의 모든 계정에서 lending이 불가능하다는 증명으로 확대하지 않는다.

### PM 표본의 부분 산식

PM 표본에서는 raw HYPE spot=0, lending supply.value=`195934874775`(후보 HYPE8 단위), USDC spot=0, borrow.value=`8937185103020`, 기본 DEX accountValue=`35473443945`(후보 USDC6 단위)를 관측했다.

```text
HYPE 후보 수량 = 0 + 195934874775 / 1e8 = 1959.34874775
USDC 후보 잔고 = 0 - 8937185103020 / 1e8 + 35473443945 / 1e6
               = -53898.4070852
```

HYPE는 전후 HTTP 값과 일치했고 USDC는 HTTP 전후 범위 안에 있었다. **이 표본은 알려진 HYPE/USDC·기본 DEX만 설명한다.** 다른 자산·DEX·공유 담보·누락 포지션이 없다는 증명이 아니며 PM production NAV 개방 조건을 충족하지 않는다. source의 Standard 후보 합산을 PM 일반 공식으로 승격하지 않았다.

## 2. HIP-4 encoded ID와 만기

[HTTP metadata](reference/managed-outcome-meta-2026-10-04.json), [active 원시 관측](reference/managed-outcome-precompile-2026-10-04.json), [만기 후 원시 관측](reference/managed-outcome-after-expiry-2026-10-04.json).

| 관측 | EVM block | Core/상태 근거 |
| --- | --- | --- |
| active · 10:43:04 UTC | `0x2d6d9be` | outcome 1473 및 8298 status=1 |
| 만기 후 · 10:45:24 UTC | `0x2d6da4c` | 동일 outcome 8298 status=2, settledValue=0 |

두 블록 hash는 각각 `0x383f7c6283409e3f7765220f7f9747e23d97204362b68142b56c348ac3baabd8`, `0x3e67f7619b0434153170f23b89f44a5cbcf4d8a1b863d028a73390cd33d8e665`이며 수집 후 동일성을 확인했다.

- `100000000 + outcome * 10 + side`를 spotBalance/spotPx 입력으로 사용했다. active 표본에서 양쪽 호출은 성공했다. 해당 계정의 outcome 잔액은 0이므로 **수량 decimals의 비제로 증거는 아니다**.
- outcome1473의 양 side raw price는 `60647000`과 `39353000`이고 합계 `1e8`이었다. outcome8298은 각각 `50000000`이었다. 가격 정규화의 한 표본일 뿐 모든 outcome/quote/원천 freshness를 입증하지 않는다.
- 같은 encoded ID를 tokenInfo/spotInfo에 넣으면 두 outcome 모두 오류였다. 공식 ABI도 encoded 지원을 spotBalance/spotPx에만 명시한다. 일반 spot metadata 경로를 outcome에 재사용하지 않는다.
- 8298의 만기 후 상태는 settled이며 fraction=0이었다. **settledValue=0은 정당한 No 정산이며 미존재/미확인과 다르다.** 이후 양 side spotBalance/spotPx가 오류를 반환했다.
- source는 이제 outcomeStatus를 먼저 읽는다. active일 때만 잔액/가격을 읽고 `balanceQueried=true`를 반환한다. settled/pruned는 상태만 반환하고 balanceQueried=false다. 구조체의 기본 0을 알려진 잔액 0으로 해석하면 안 된다.

[공식 HIP-4 명세](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets)는 정산 시 quote token으로 자동 전환된다고 설명한다. 위 관측은 그 설명과 양립하지만, **비제로 보유 계정의 실제 quote 수령·수수료·단위 전환을 관측한 것은 아니다.** 따라서 만기 이후 별도 outcome receivable을 NAV에 더하는 구현은 하지 않았다. pruned(status3)는 로컬 테스트만 있고 이번 네트워크 표본에는 없다.

<a id="raw-ledger-identity"></a>
## 3. 모드와 무관한 raw 장부 항등식

[ADR-028](DECISIONS.ko.md#adr-028)이 검증 과제로 남긴 "모드별 합산식과 중복 관계"를 공개 계정으로 대조했다. `scripts/equity_probe.py`는 계정마다 HTTP 조회(전) → 한 EVM 블록에 고정한 precompile batch → HTTP 조회(후) → 같은 블록 hash 재확인 순서로 수집한다. 가설은 **precompile이 모드와 무관하게 서로 겹치지 않는 raw 장부를 반환하고, API의 통합 잔액은 그 합**이라는 것이다.

| 자료 | 수집(UTC) | 계정 | 계정별 고정 EVM block | 가격 block |
| --- | --- | --- | --- | --- |
| [1차](reference/managed-equity-modes-2026-10-04.json) | 2026-10-04T11:59:34 | 13 (Unified 7, PM 4, default 1, disabled 1) | `0x2d6ec08`–`0x2d6ecc5` | `0x2d6ebf9` |
| [2차](reference/managed-equity-modes-rerun-2026-10-04.json) | 2026-10-04T12:07:01 | 16 (Unified 10, PM 4, default 1, disabled 1) | `0x2d6edd0`–`0x2d6eebc` | `0x2d6edc1` |

두 자료의 모든 블록 hash 재확인은 성공했다. 2차는 HyperCore vault equity 조회와 1 raw unit 분류를 추가한 재수집이다.

| 2차 대조 항목 | 결과 |
| --- | --- |
| token별 API 잔액과 raw 장부 합 (36건) | 일치 31, 전후 구간 안 4, 1 raw unit 차이 1, 불일치 0 |
| 비제로 DEX `accountValue`와 API (20건) | 일치 20 |
| vault equity와 API (18건, 0 포함) | 일치 15, 전후 구간 안 2, 불일치 1 |
| lending 조회 성공 여부와 API 장부 존재 | 16계정 모두 같음 |
| 존재하지 않는 DEX index(11) 조회 | 16계정 모두 `PrecompileError` |

vault equity 불일치 1건은 HLP 가치가 두 HTTP 조회 사이에서 오르내린 경우다(고정 블록 857304.270507, 전 857304.269985, 후 857304.168365). 단위 차이가 아니며 다른 표본은 6자리에서 일치했다. 1차의 token 27건은 일치 23, 구간 안 2, 불일치 2였고 DEX 18건은 모두 일치했다. 그 불일치 2건은 PM 계정 USDC에서 **정확히 1e-8** 차이다. API는 이자 반영 값을 합산한 뒤 절사하고 precompile 합은 절사된 값을 더하기 때문이며, 당시 분류기에 이 허용이 없었다. 원시 파일은 그대로 보존한다.

확인한 관계:

- **Unified:** `API spot total(USDC) = raw spot + Σ USDC DEX accountValue`. raw spot만으로는 맞지 않는다. 예: `0x0d82…` block `0x2d6edd0`에서 93110.462562 + 5596.630612 + 401.498746 = 99108.59192로 API와 같다. cross·isolated 포지션, 기본 DEX와 HIP-3 DEX(xyz·para·mkts·io) 3~4개를 함께 쓰는 계정에서도 DEX별 값이 겹치지 않았다.
- **Portfolio Margin:** `API total = raw spot + supply.value − borrow.value + accountValue`. raw spot은 0이고 HYPE·UBTC는 lending 공급 장부에, USDC 차입은 차입 장부에 있다.
- **Unified의 lending:** 공급·차입이 있는 Unified 계정(`0xfe4e…`, `0xced4…`)에서 API spot total은 lending을 포함하지 않았다. lending은 모드와 무관한 별도 장부다.
- **Standard·default:** API가 raw 값을 그대로 보여 준다.
- Unified·PM 14계정의 USDC raw `hold`는 모두 0이었다. API가 보여 주는 USDC hold(perp 증거금 등)는 합성 값이다. spot 주문에 묶인 토큰(PURR 1건)은 raw `hold`에도 나타났고 `total`에 포함돼 있었다. `hold`는 NAV에 더하지 않는다.
- lending 조회는 계정에 그 token의 장부가 없으면 오류이고, 값이 0이어도 장부가 있으면 성공한다.
- vault equity는 USDC 6자리이고, 해당 vault에 지분이 없는 계정은 0으로 성공한다. [별도 표본](reference/managed-vault-equity-edge-2026-10-04.json)에서 닫힌 vault 2개도 0으로 성공했고 vault가 아닌 주소는 오류였다.

가격 입력(가격 block 기준): `spotPx`는 API의 spot `markPx`와 같았고 다섯 pair 모두 `[bid, ask]` 안에 있었다. `bbo(10000 + pair)`와 reserve `oraclePx`는 같은 `10^(8 − szDecimals)` 단위다. HYPE는 spotPx 90.298, 호가 90.298/90.299, reserve oracle 90.300518이었다. USDE(235)는 reserve가 없어 조회가 실패했다.

Core 블록 속도: 두 파일의 계정별 `l1BlockNumber` 조회 29건은 679.5초 동안 9,443 증가했다(초당 약 13.9, EVM 블록 692개에 대해 블록당 약 13.6). 시각은 HTTP 호출의 클라이언트 시각이어서 초 단위 오차가 있고, 12분 구간 한 번의 값이다. [검증기의 회수 대기 기간](managed-precompile-nav.ko.md#액션-최종성)을 시간으로 환산할 때의 근거이며 프로토콜 상수가 아니다.

**한계:** 공개 계정의 읽기 전용 표본이며 프로젝트 Vault가 아니다. HTTP는 블록에 고정되지 않는다. 계정당 token은 최대 4개만 읽었다. 모드 전환 직후, 청산 진행 중, funding 정산 시점은 관측하지 않았다. 현재 메타데이터에서 USDC 외 담보 DEX(flx·vntl·hyna·km·cash)는 모두 delisted·미결제 0이어서 **비USDC 담보 DEX의 단위는 관측할 수 없었다.** 이 결과는 현행 평가식의 근거이고 생산 NAV 승인이나 등록 범위의 완전성 증명이 아니다.

<a id="precompile-gas"></a>
## 4. precompile gas 실측

2026-10-04 공개 mainnet RPC에서 read precompile이 실제로 얼마의 gas를 요구하는지 측정했다. [precompile_gas_probe.py](../scripts/precompile_gas_probe.py)가 [PrecompileGasProbe](../test/mainnet/PrecompileGasProbe.sol)의 creation code를 한 블록에 고정한 `eth_call`로 실행한다. constructor가 gas 상한을 건 staticcall을 수행하고 결과를 반환하므로 배포·서명·전송이 없다. 원시 자료는 [1차](reference/managed-precompile-gas-2026-10-04.json)(block `0x2d71273`)와 [2차](reference/managed-precompile-gas-control-2026-10-04.json)(block `0x2d712ec`)다.

| 조회 | 입력/출력 바이트 | [문서 식](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore) `2000 + 65 × (입력 + 출력)` | 성공하는 최소 gas |
| --- | --- | ---: | ---: |
| lending `0x0811` (장부 있음) | 64 / 128 | 14,480 | 7,336 |
| accountMarginSummary `0x080f` | 64 / 128 | 14,480 | 7,336 |
| spotBalance `0x0801` | 64 / 96 | 12,400 | 6,280 |
| borrowLendReserveState `0x0812` | 32 / 256 | 20,720 | 10,504 |
| coreUserExists `0x0810` | 32 / 32 | 6,160 | 3,112 |
| l1BlockNumber `0x0809` | 0 / 32 | 4,080 | 2,056 |

- 최소 gas는 여섯 조회(입력·출력 크기로는 다섯 형태) 모두 **`1000 + 33 × (입력 + 출력)`과 정확히 같았다.** 상한보다 1 작은 호출은 실패하고 상한에서 성공했다. 문서 식의 약 절반이다. 왜 다른지는 확인하지 못했다.
- 성공한 조회가 쓴 gas는 상한을 얼마로 주든 같았다(호출 비용 포함 편차 2 이하).
- 장부가 없는 계정의 lending 조회는 상한 7,336·14,480·20,000·50,000·200,000 모두에서 실패했고, 호출자가 쓴 gas는 매번 상한 + 259였다. **오류는 전달된 gas를 전부 소모한다.**
- Core가 모르는 계정(`coreUserExists`가 false인 임의 주소)에 대해서도 기본 DEX의 `accountMarginSummary`는 0으로 채운 128바이트를 반환했다.
- 블록 header의 gas 한도는 3,000,000이었다.

이 결과가 뒷받침하는 것: [source의 lending 장부 확인](managed-precompile-nav.ko.md#gas)이 쓰는 20,000 gas 한도는 성공한 조회에 충분하고(실측 7,336, 문서 식 14,480), 장부가 없으면 그 한도만 소모된다. 같은 형태의 대조 조회로 기본 DEX의 margin summary를 쓸 수 있다.

**한계:** 한 시점·두 블록의 관측이며 비용은 프로토콜 상수가 아니다. 개별 precompile 호출의 비용이고 Vault 입금 거래 전체의 gas가 아니다. precompile 주소의 첫 접근 비용은 측정에서 제외했다(먼저 한 번 호출한 뒤 측정). 범위 상한은 더 비싼 문서 식으로 정했다.

<a id="empty-book"></a>
## 5. 호가가 빈 spot 시장의 `bbo`·`spotPx` 응답

2026-10-05 공개 mainnet에서 [book_probe.py](../scripts/book_probe.py)로 한 번 관측했다. HTTP API의 `spotMetaAndAssetCtxs`에서 mid 가격이 없는 USDC 호가 pair 20개를 찾고, `l2Book`으로 어느 쪽이 비었는지 확인한 뒤, 한 블록(`0x2d74e5d`)에 고정한 `eth_call`로 `bbo`(0x080e)와 `spotPx`(0x0808)를 읽었다. 원시 자료는 [reference](reference/managed-spot-book-empty-side-2026-10-05.json)에 있다. 서명·전송은 없다.

| 호가 상태 (API) | 표본 | `bbo`가 되돌린 경우 | 빈 쪽을 0으로 반환 | `spotPx`가 0이 아님 |
| --- | ---: | ---: | ---: | ---: |
| 양쪽 모두 없음 | 3 | 0 | 매수 3/3, 매도 3/3 | 3/3 |
| 매수호가 없음 | 1 | 0 | 매수 1/1 | 1/1 |
| 매도호가 없음 | 3 | 0 | 매도 3/3 | 3/3 |

- `bbo`는 일곱 pair 모두에서 응답했고, 빈 쪽의 값은 0이었다.
- `spotPx`는 호가가 전혀 없는 pair에서도 0이 아닌 값을 유지했다(예: pair 189는 양쪽 호가가 없고 mark는 620).
- 매도호가만 없는 pair 200은 mark(1.715)가 매수호가(1.87)보다 낮았다. mark가 호가 범위 밖에 있을 수 있다는 뜻이며, 이런 상태는 [가격 가드](managed-precompile-nav.ko.md#가격-정책)가 거부한다.

이 결과가 뒷받침하는 것: [신고](managed-precompile-nav.ko.md#미등록-보유-신고)와 [종료 평가](managed-precompile-nav.ko.md#종료-검증)가 매수호가 0을 "팔 수 없음"으로 읽는 전제(호가를 거두면 조회가 실패하는 것이 아니라 0이 반환된다)와, mark를 기준으로 범위 제외를 제한하면 호가가 죽은 token이 범위에 묶인다는 판단이다.

**한계:** 한 블록·일곱 pair의 표본이다. HTTP 조회는 그 블록에 고정되지 않으므로 호가 상태와 precompile 응답 사이에 시차가 있을 수 있다. 같은 독립 조회를 3차 코드 리뷰도 다른 블록(`0x2d739d1`)에서 수행해 같은 결과를 보고했지만 그 자료는 저장소에 넣지 않았다. 프로토콜이 이 동작을 보장한다는 문서는 찾지 못했다.

## 재현

기존 파일을 덮어쓰지 말고 새 이름을 쓴다. CLI exit 2는 부분 실패 자료가 저장됐음을 뜻한다. metadata나 lending 실패를 지운 뒤 성공으로 재분류하지 않는다.

```sh
python3 scripts/nav_probe.py --network mainnet --account <공개 Core 계정> --output docs/reference/new-modes.json
python3 scripts/nav_reconcile.py docs/reference/new-modes.json --output docs/reference/new-modes-analysis.json
python3 scripts/outcome_probe.py --network mainnet --outcome <outcome id> --account <공개 Core 계정> --output docs/reference/new-outcome.json
python3 scripts/equity_probe.py --network mainnet --account <공개 Core 계정> --output docs/reference/new-equity.json
forge build --offline && python3 scripts/precompile_gas_probe.py --network mainnet --with-ledger <lending 장부가 있는 공개 계정> --without-ledger <장부가 없는 공개 계정> --token 150 --output docs/reference/new-gas.json
python3 scripts/book_probe.py --network mainnet --output docs/reference/new-empty-book.json
```

`equity_probe.py`는 계정을 16개까지 받고 공개 RPC의 속도 제한 때문에 계정 사이에 기본 15초를 쉰다. exit 2는 블록 hash 불안정 또는 불일치 분류가 있다는 뜻이며 자료는 저장된다.

관측 도구는 오프체인 대조용이고 계약의 NAV 증명 입력이 아니다. 원시 자료를 사용하는 Python 회귀와 Solidity response-injection 회귀를 구분한다. 1·2절의 실측으로 고친 코드는 USDC bridge metadata 검사와 HIP-4 상태 우선 조회이고, 3절은 [현행 평가식](managed-precompile-nav.ko.md)의 근거다. 4절은 lending 장부 확인의 gas 한도와 gas 모형의 근거다. 5절은 매수호가 0을 "팔 수 없음"으로 읽는 규칙의 근거다. 프로젝트 계정의 통제 왕복, 모드 전환 전후, 통제된 비제로 HIP-4 payout은 여전히 미완료다.
