# PM NAV 실측과 포지션 수량 수정

작성일: 2026-09-21 KST. 모든 네트워크 작업은 공식 공개 RPC / Info API의 읽기 전용 조회다. 계정 모드 변경, 주문, 입출금, 배포, 서명은 수행하지 않았다.

이 문서는 해당 시점의 관측·해석·수정 근거를 보존한다. 이후 구현/검증 상태는 [STATUS](STATUS.ko.md), 남은 작업과 완료 여부는 [BACKLOG](BACKLOG.ko.md)에서 갱신한다. 아래 미검증 사항은 수집 당시의 한계이며 실측을 새로 수행한 경우 날짜·원시 자료·정정 이유를 추가한다.

## 확보한 근거

- [첫 표본](reference/nav-mainnet-2026-09-20.json): 기존 공개 CoreWriter 계정과 공식 문서의 backstop 시스템 계정. UTC 9월 20일에 수집했다. 두 계정은 각각 unifiedAccount / default이며 PM 표본으로 간주하지 않는다.
- [공개 표본 선택 기록](reference/nav-public-account-discovery-2026-09-21.json): 공식 리더보드에서 계정 가치 범위를 제한해 선택한 24개 중 API에서 PM으로 관측된 계정 4개. 전수조사나 PM 보급률 추정이 아니다.
- [PM 4개 계정 스냅샷](reference/nav-pm-mainnet-2026-09-21.json): HYPE/USDC, HYPE perp와 기본 DEX를 동일 EVM 블록으로 조회. 일부 계정의 lending read 실패를 원문 그대로 보존했다.
- [HYPE carry 표본](reference/nav-pm-hype-carry-2026-09-21.json): EVM block `0x2c4ef5d`, Core block `1155221453`. 선택한 조회 집합은 모두 성공했고 종료 시 같은 EVM block hash를 재확인했다. 전체 계정 자산·모든 DEX를 조회했다는 뜻은 아니다.
- [수식 대조 결과](reference/nav-pm-hype-reconciliation-2026-09-21.json): 블록 고정 onchain 관측과 별도 시점 HTTP 응답 비교. `productionNavReady=false`, `activeDepositsAuthorized=false`를 유지한다.

## 발견하고 수정한 수량 오류

HYPE carry 표본의 raw position `szi=-141643`은 API의 `-1416.43 HYPE`에 대응한다. 같은 블록의 perpAssetInfo는 `szDecimals=2`다. CoreWriter 주문은 고정 1e8 단위이므로 다음 변환이 필요하다.

```text
humanSize = rawSzi / 10^szDecimals
orderSize = rawSzi × 10^(8 - szDecimals)
          = -141643 × 10^6
          = -141643000000
```

기존 코드와 mock은 raw szi도 1e8 단위라고 가정했다. 그 결과 실제 short를 지나치게 작게 읽어 추가 short를 반복하거나 close 주문량을 잘못 계산할 수 있었다.

수정 사항:

- `HyperCoreRiskOracle.positionSize(account, asset)`가 검증된 시장 설정의 `orderSizeLot`로 변환한다. `orderSizeLot`는 반드시 `10^(8-szDecimals)`여야 한다. raw market metadata와 설정의 일치 여부는 배포 검증 조건이며 생성자가 네트워크에서 자동 검증하지 않는다.
- Strategy의 헤지 비율·남은 주문량·close 수량·pending 이전 수량과 ActionObserver의 이후 수량을 모두 CoreWriter 단위로 맞췄다. legacy 비교용 Vault에도 같은 변환을 적용했다.
- 변환 후 int64 범위를 넘으면 SafeCast가 revert하며 절삭하지 않는다.
- mock은 실제 raw size-lot ABI를 사용하도록 변경했다. 실측 `-141643` 회귀, `100 HYPE` hedge 완료 후 추가 주문이 없는지, 전체 close와 부분 체결의 `50e8` 효과량을 검증했다.

RiskOracle 인터페이스에 함수가 추가되고 ActionObserver.Context 끝에 riskOracle 주소가 추가됐다. Strategy / RiskOracle / ActionObserver를 함께 재빌드·배포해야 한다. 기존 배포를 제자리에서 변경하는 업그레이드 기능은 없다. PendingAction의 positionBefore는 1e8 단위이며 raw precompile 값이 아니다.

## API의 spot total과 precompile의 spot total은 다르다

[공식 Spot API 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)는 PM·통합 계정에서 spot API를 거래 잔액의 기준으로 지정한다. 이 지침을 `0x0801`의 raw spotBalance도 같은 통합 값이라는 뜻으로 해석해서는 안 된다.

실측 PM 계정에서 raw HYPE spot total은 0이지만 API total은 `1416.43282556 HYPE`다. 이 값은 lending 공급량에 나타난다. raw USDC spot total도 0이지만 API USDC total은 음수다.

이 표본에서는 아래 **후보 항등식**이 API 값과 맞았다. 부채는 basis가 아닌 이자 포함 value를 사용했다.

```text
HYPE 잔액 후보 = raw spot HYPE + lending supply HYPE - lending borrow HYPE
              = 1416.43282556 HYPE

USDC 잔액 후보 = raw spot USDC + lending supply USDC - lending borrow USDC
              + 기본 DEX accountValue
              = -30934.88378434 USDC
```

이는 PM 계정 전체 NAV나 일반적인 모든 DEX의 합산식이 검증됐다는 뜻은 아니다. 여러 자산·DEX를 사용하는 다른 표본에서는 기본 DEX만 더한 후보가 통합 API 값과 달랐다. API 통합 잔액에 lending supply나 accountValue를 다시 더하면 중복 계산할 수 있다. accountValue를 사용할 때 미실현손익을 다시 더하거나 `cumFunding`을 미수익으로 취급하는 것도 금지한다. 누적 펀딩 통계는 아직 정산되지 않은 펀딩 잔액과 다르다.

## 실측 단위와 실패 처리

| 필드 | 관측 |
| --- | --- |
| HYPE / USDC raw spot 수량 | 비제로 표본에서 1e8 스케일 API 값과 일치 |
| HYPE / USDC lending basis·value | 비제로 표본에서 1e8 일치 또는 이자 누적 전후 API 구간에 포함 |
| 기본 DEX margin accountValue / rawUsd | 비제로 PM 표본에서 1e6 스케일과 일치 |
| HYPE position szi | raw size lots; szDecimals=2인 표본에서 1e2 |
| HYPE position entryNtl | 표본의 quote notional은 1e6 후보; szi와 단위가 다름 |
| reserve oraclePx | HYPE raw `92823897` ↔ API `92.823897`, USDC raw `1` ↔ API `1.0`; 공통 1e8로 나누면 안 됨 |
| lending 상태가 없는 토큰·계정 조합 | API에서는 생략돼도 precompile은 PrecompileError를 반환한 사례 있음 |

0 값만으로 단위를 확인했다고 판정하지 않는다. API 생략·조회 실패를 0 부채나 0 자산으로 변환하지 않는다. raw lending 실패 때문에 현재 Strategy의 clean-account/bootstrap 검사도 막힐 수 있으므로 계정 초기화 조건을 별도 검증해야 한다.

## 추가한 도구와 조회 계약

`scripts/nav_probe.py`는 주소와 chainId를 검사하고 명시적인 EVM block number에 모든 precompile 조회를 고정한다. block 확보가 실패하면 latest로 대체하지 않는다. 종료 시 같은 block hash를 확인하고 모든 API 응답은 block-pinned가 아님을 표시한다. 정수와 Decimal로 비교하고 오류·raw bytes를 보존한다. 일부 조회가 실패하면 결과 파일은 보존하되 exit code 2를 반환한다. 기존 파일은 덮어쓰지 않는다.

```sh
python3 scripts/nav_probe.py --network mainnet --account <Core-owner-address> --output docs/reference/new-snapshot.json
python3 scripts/nav_reconcile.py docs/reference/new-snapshot.json --output docs/reference/new-reconciliation.json
```

`HyperCoreAccountReader`는 spot/lending/position/margin/mark/oracle/reserve를 읽는 원시 관측 계약이다. `IStrategyBalanceSheet`가 아니며 complete나 NAV를 반환하지 않는다. 모든 읽기는 gas와 응답 길이를 제한한다. 시장·계정 범위를 반환하고 signed margin을 보존한다. `evmObservedAt`은 조회 시각이며 가격의 마지막 갱신 시각이 아니다. 배포 스크립트에는 연결하지 않았다.

## 생산용 source 연결 전 남은 검증

1. PM 활성화 전후 bridge·spot·자동 공급·lending 변화를 관측해야 한다. 현재 Strategy의 수동 supply와 spot 기반 bridge 관측 가정은 이번 정적 표본으로 검증되지 않았다. PM 활성화 뒤 raw spot이 0이 되는 경우를 처리할 수 있는지 특히 확인해야 한다.
2. 단일 허용 시장·두 토큰만 보유한다는 완전성 조건과 다른 DEX·외부 자산·격리 포지션의 배제를 증명해야 한다. 일반 공개 계정의 전체 NAV를 HYPE/USDC 조회만으로 계산하지 않는다.
3. 공급·차입·부분 체결·펀딩 시각·부채 상환·recall을 잇는 전후 원장이 필요하다. 이번 공개 계정 관측은 프로젝트가 통제한 거래 실험이 아니다.
4. Core 가스 후원금 귀속, 미확정 액션, recall 수수료, 공급 회수·quote 잔량을 포함해야 한다.

따라서 기본 배포는 여전히 원금 추정 reader를 사용하고 운용 중 입금은 닫혀 있다. 이번 수정은 실자금 운용 준비 완료를 의미하지 않는다.
