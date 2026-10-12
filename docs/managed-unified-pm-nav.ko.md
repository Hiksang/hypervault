# Managed Vault: Unified·Portfolio Margin NAV 설계

작성: 2026-10-04 KST. [ADR-028](DECISIONS.ko.md#adr-028)의 상세 설계 원본이다. 사용자는 Unified 또는 Portfolio Margin(PM), Vault 전용 API wallet의 직접 거래, 외부 NAV 서명자 없이 precompile 평가, 운용 중 즉시 지분 발행을 선택했다.

**문서의 상태:** 채택 당시의 설계 배경이다. 구현은 [ADR-029](DECISIONS.ko.md#adr-029)와 [현행 명세](managed-precompile-nav.ko.md)가 관리한다. 이 문서가 미확정으로 둔 항목 중 다음은 [공개 계정 관측](managed-precompile-evidence.ko.md#raw-ledger-identity)과 구현으로 정리됐다.

| 이 문서의 미확정 항목 | 현재 |
| --- | --- |
| raw 필드의 모드별 합산식, `perpResidual` | DEX별 `accountValue`를 그대로 합한다. Unified·PM·Standard에서 같은 식이며 DEX 사이 중복은 관측되지 않았다 |
| `UnifiedNavAdapter`/`PortfolioMarginNavAdapter` 분리, 모드 전환 인증 | 평가기 하나. 평가가 모드에 의존하지 않으므로 모드 조회가 필요 없다 |
| 조회 실패 시 lending 부재 인증 | 집계하는 token의 실패는 거부. 집계하지 않는 token은 장부가 없거나 공급 1 lot 미만·차입 0일 때만 통과하고 그 이상이면 `ScopeIncomplete` |
| `observedAt`·`maxAge` 의미 변경 | 필드를 제거하고 같은 호출의 Core 블록을 반환한다 |
| Core 비요청 자금 귀속 | 계정 순자산에 포함(ADR-029, 사용자 확정 대기) |

남은 항목은 통제 계정의 전후 대조, 모드 전환 직후·청산·funding 시점, HIP-4 단위/정산, USDC 외 담보 DEX, Spot 가격 허용 정책의 강화(ADR-029 결정 대기 B), 종료가 막힐 때의 복구(결정 대기 A), 실제 gas(시장 수 상한은 비용식 모형으로 token 6·DEX 8로 정함), FE 표시다. 아래 본문의 계약명·후보식·"미완료" 서술은 채택 당시 기록이며 현행 ABI가 아니다.

## 1. 채택한 구조와 신뢰 범위

```text
운용자가 자산·DEX·outcome·가격 경로를 사전 등록
  → Vault별 평가 목록과 버전
  → UnifiedNavAdapter 또는 PortfolioMarginNavAdapter
  → 같은 Core 상태의 잔액·공급·부채·Perp 잔액·가격 조회
  → 중복 제거와 USDC 환산
  → EVM 장부 현금 합산
  → 입금 전 NAV로 같은 EVM 거래에서 지분 발행
```

| 항목 | 책임·신뢰 |
| --- | --- |
| 수량·부채·가격 | 계약이 precompile에서 읽는다. 운용자 입력 금액을 채택하지 않는다. |
| 거래 대상 목록의 완전성 | 운용자가 실제 사용하는 모든 대상을 등록한다는 신뢰를 둔다. |
| 단위·중복 제거·환산 | 모드별 평가기의 검증된 코드가 수행한다. |
| 주문 실행 | Vault 전용 API wallet으로 직접 거래한다. EVM 목록이 Core 주문을 강제 제한하지 않는다. |
| NAV 보고자 | 별도 외부 서명자·정족수·owner NAV 입력을 도입하지 않는다. |

제공된 L1Read ABI에는 계정의 모든 보유 토큰·DEX·outcome을 열거하는 조회가 없다. 등록 목록의 모든 조회가 성공해도 목록 밖 노출이 없음을 증명하지는 않는다. **이 설계가 보장하는 것은 운용자가 완전하게 등록한 범위의 온체인 평가다.** 누락이 없는 계정 전체 NAV의 무신뢰 증명으로 표시하지 않는다. 미등록 자산·부채가 발견되면 입금을 중단하고 목록과 평가를 복구해야 하지만, 계약이 모든 누락을 자동 감지할 수 있다는 보장은 없다.

## 2. NAV의 정의

NAV는 정한 평가가격으로 계산한 주주 순자산이다. 즉시 전량 매도했을 때의 실수령액·출금 가능액·청산 담보가치와 같다고 가정하지 않는다. USDC를 가치 기준으로 사용하고 USDC 자체는 1 USDC로 평가한다.

```text
Core NAV = Σ(토큰별 순자산 수량 × 토큰의 USDC 평가가격)
           + 아직 위 항목에 포함되지 않은 권리의 평가액

Vault NAV = 주주에게 귀속된 Core NAV + Vault.availableCash()
```

`availableCash()`는 장부 현금에서 확정 claim 준비금을 뺀 값이다. EVM raw USDC 잔액이나 새 입금액을 입금 전 NAV에 더하지 않는다. 출금 준비금을 다시 차감하지 않는다. Core 비요청 송금의 귀속은 별도 미해결 항목이며 계정 총자산을 무조건 주주 자산으로 바꾸지 않는다. [ADR-013](DECISIONS.ko.md#adr-013)의 기존 귀속 정책을 이 문서로 변경하지 않는다.

### 토큰별 재구성 후보

```text
B(token) = rawSpot(token)
         + lendingSupplyValue(token)
         − lendingBorrowValue(token)
         + perpResidual(token)
```

`perpResidual`은 위 Spot/Lending 항목과 겹치지 않는 해당 정산 토큰의 Perp 회계 기여분이다. **현재 precompile에 이 이름의 필드는 없다.** `accountMarginSummary(dex, vault).accountValue`를 그대로 합할 수 있는지, 공유 담보 조정이 필요한지 Unified/PM별로 확정해야 한다. `accountValue - rawUsd`를 자동으로 정답으로 채택하지도 않는다. 일반화한 생산 공식은 아직 없다.

- `accountValue`를 equity로 반영한 범위에는 position PnL·누적 funding을 다시 더하지 않는다.
- `marginUsed`·Spot `hold`는 잠긴 자산이라는 이유만으로 NAV에서 차감하지 않는다. `hold`를 자산에 추가하지도 않는다.
- Lending은 원금 `basis`가 아닌 이자 반영 `value`를 사용한다. 누적 이자를 별도 항목으로 또 더하지 않는다.
- PM LTV·청산 haircut은 위험 지표다. 주주 NAV 가격에 자동 적용하지 않는다.
- USDT 등 다른 정산 토큰은 USDC 환산 경로가 필요하다. 다른 stablecoin을 임의로 1 USDC로 고정하지 않는다.
- 음수 Perp equity·부채를 0으로 잘라 버리지 않는다. 모든 항목을 합산한 순자산이 0 이하이고 기존 지분이 있으면 신규 발행을 닫는다.

### 현재 확보한 근거

[공개 PM 표본](managed-precompile-evidence.ko.md)에서 raw HYPE Spot은 0이고 Lending 공급액에 HYPE가 나타났다. USDC는 `raw Spot + 공급 − 차입 + 기본 DEX accountValue` 후보가 별도 시점 API 통합 잔액 구간과 부합했다. 이는 여러 DEX·격리 포지션·모드 전환 전체의 항등식을 입증하지 않는다. API `spotClearinghouseState.total`과 precompile `spotBalance.total`을 동일 필드로 취급하지 않는다.

## 3. 평가기와 등록 목록

### 모드별 평가기

- `UnifiedNavAdapter`: 통합 담보·기본/HIP-3·Cross/Isolated 회계의 중복 관계를 검증한 뒤 구현한다. Unified라는 이유만으로 기존 Lending 노출이 없다고 가정하지 않는다.
- `PortfolioMarginNavAdapter`: 자동 공급·차입·이자·상환과 한도 도달 시 동작 변화까지 포함한다. PM 계정의 모든 자산이 자동 공급되거나 차입 가능한 것은 아니다.
- 평가기에 사용한 모드·목록 버전·평가 정책 버전·현재 Core 블록·검증 실패 사유를 결과에 연결한다. 현행 `complete` 하나로 온체인 조회 성공과 운용자 목록 신뢰를 뭉뚱그리지 않는다.

모드 변경 요청 중에는 신규 입금을 닫는다. 목표 모드를 EVM storage에 기록하는 것만으로 Core 전환 성공을 인증하지 않는다. 제공된 ABI에는 직접적인 계정 모드 조회가 없으므로 전환 확인 방법과 API agent가 가능한 모드 변경 범위를 별도 검증해야 한다. 확인할 수 없는 경우 임의로 평가기를 전환하지 않는다. 현재 Core 관리 액션 verifier 미완료 문제도 별도로 남는다.

### 등록·변경 규칙

등록 항목은 token ID, token decimals, Spot 가격 경로, DEX ID와 정산 토큰/단위, Lending 조회 대상, HIP-4 outcome/side와 quote·수량 단위다. onchain metadata가 제공되는 필드는 반드시 대조하고, 제공되지 않는 필드는 검증 근거와 설정 신뢰를 별도로 명시한다. 운용자에게 임의 decimals·가격을 입력해 평가를 부풀릴 권한을 주지 않는다.

1. owner는 새 대상의 거래 전에 등록한다. 가격 조회와 metadata 검증에 실패하면 평가 대상으로 활성화하지 않는다.
2. 목록 변경 시 버전을 증가시키고 이전 견적을 무효화한다. 검증이 끝나지 않은 변경 상태에서는 신규 입금을 닫는다.
3. 제거는 잔액·공급·차입·포지션·정산 권리가 모두 해소됐을 때만 허용한다. 0임을 확인할 수 없으면 제거하지 않는다.
4. API의 미체결 주문·늦은 체결까지 모든 소멸을 precompile로 인증할 방법은 아직 없다. 제거 시 운용자의 주문 정리 책임과 인증 한계를 기록한다. 미등록 거래를 자동 차단한다고 표시하지 않는다.
5. 지원 범위와 최대 조회 수를 제한해 한 EVM 거래에서 모든 항목을 평가할 수 있게 한다. 정확한 상한은 가스 측정으로 정하며 현재 source의 한도를 미래 제품 보장으로 복사하지 않는다.

## 4. 시점·가격·단위 정책

현재 Core 블록의 precompile 평가가격을 사용하는 정책을 채택한다. 각 입력은 같은 EVM 실행에서 읽으며 결과 Core 블록은 `CoreRead.l1Block()`와 일치해야 한다. 오프체인 실험은 EVM block number/hash를 고정한다. 과거 캐시나 사용자가 제출한 가격으로 mint하지 않는다.

precompile의 최신 Core 상태 보장은 가격 원천의 마지막 업데이트 시각을 제공한다는 뜻이 아니다. 이 정책에서는 제공되지 않는 가격별 timestamp를 필수 필드로 요구하지 않는다. `block.timestamp`를 쓴다면 EVM 관측 시각으로만 정의한다. 현행 `observedAt`의 oldest-price 의미와 `maxAge` 검사는 코드·인터페이스·회귀 테스트를 함께 수정해야 하며, 기존 필드에 현재 시각을 넣어 통과시키는 변경으로 대체하지 않는다.

가격 경로는 metadata와 quote 통화를 확인한다. Spot 가격 조작·유동성 부족·0 가격·지원되지 않는 환산은 별도 평가 실패/허용 정책을 마련한다. 원천 timestamp 조건의 변경이 이 문제를 해결하지 않는다. HIP-3를 포함한 Perp 가격과 Spot 가격의 정책을 명시하고 실제 청산가를 보장하지 않는다.

Core token·Lending·Perp quote·HIP-4 단위를 각각 확인한다. 최종 USDC6로 변환할 때 자산은 내림, 부채는 올림 등 일관된 반올림 규칙과 허용 오차를 시험에 기록한다. raw size lots를 고정 1e8 주문량으로 오해하지 않는다. 읽기 실패·빈 반환·잘못된 metadata를 잔액 0으로 바꾸지 않는다.

## 5. HIP-4와 자금 이동

HIP-4는 상태를 먼저 읽는다. active의 encoded side 잔액과 가격을 평가하고, settled에서는 공식 정산의 quote 전환과 실제 반영 위치를 확인한다. 전환된 quote와 과거 outcome 가치를 함께 더하지 않는다. 정산 후 조회 실패나 pruned를 가치 0의 증거로 취급하지 않는다. 비제로 보유분의 수량 단위·양쪽 side·multi-outcome 권리를 포함한 통제 실측 전에는 지원 완료로 표시하지 않는다.

EVM→Core 배정·Core→EVM 회수는 pending 동안 기존 정책에 따라 입금을 닫는다. EVM에서 차감된 금액과 아직 Core에 반영되지 않은 금액을 동시에 자산으로 계산하거나 누락된 손실로 확정하지 않는다. 단순 잔액 증가는 특정 전송의 출처 증명이 아니므로 결과 확인·귀속은 별도 verifier 과제다. API 직접 주문은 EVM pending 원장을 통과하지 않으며, `pendingAction == 0`은 미체결 Core 주문이 없다는 뜻이 아니다. 일반적인 열린 주문/운용 포지션 자체를 입금 불가 사유로 삼지 않고 현재 반영된 자산·부채를 평가한다.

## 6. 운용 중 입금과 표시

1. Ready/Active, 모드/목록 유효, 관리 액션 pending 없음, upgrade/exit 제한을 확인한다.
2. 현재 precompile 결과로 **입금 전** Core 순자산을 계산하고 `availableCash()`를 더한다.
3. 현행 OZ virtual asset/share 반올림과 `minShares`·deadline·최소 입금·cap을 적용한다.
4. EVM USDC의 실제 수령액을 확인하고 같은 거래에서 장부와 지분을 갱신한다. 실패하면 EVM 거래 전체가 revert한다.
5. 새 자금은 EVM 장부 현금이며 후속 Core 배정 시점은 운용자가 결정한다. 반복 입금은 직전 입금으로 늘어난 현금을 반영한다.

FE에는 평가 모드, 등록 범위/버전, Core 블록, 평가 성공/실패 이유와 함께 “자산·가격은 온체인 조회, 거래 대상 등록은 운용자 책임”을 보여준다. 검증 실패를 NAV 0으로 표시하지 않는다. 출금은 기존 ERC-7540 요청·회수·확정 claim 경로를 유지한다.

## 7. 검증 시나리오와 구현 순서

| 시나리오 | 확인할 관계 |
| --- | --- |
| Unified 기본 Spot·Perp 전환 | 계정 내부 이동으로 NAV가 중복 증가하지 않는지 |
| 같은 담보로 기본 DEX + HIP-3 거래 | 공유 담보는 한 번, 각 손익은 한 번 반영되는지 |
| USDC·비USDC 정산 DEX 동시 운용 | quote 단위·환산·양/음 equity 처리 |
| Cross·Isolated 개설/변경/종료 | 격리 담보·손익이 누락/중복되지 않는지 |
| PM 자동 공급·차입·이자·상환 | Spot/Lending/Perp 필드의 정확한 전후 대응 |
| PM 한도 도달·모드 전환 | fallback 상태에서도 평가 가능 여부를 정확히 판정하는지 |
| funding·거래 수수료·부분 체결 | 실제 순자산 변화와 평가 변화의 일치 |
| HIP-4 양 side 보유·만기·multi-outcome | quote 지급 전후 가치가 한 번만 반영되는지 |
| 직접 EVM/Core 송금·회수 pending | 주주 귀속·확정 준비금·이동 중 금액 구분 |
| 등록 추가·제거·목록 밖 거래 | 설정 검증과 자동 검출 불가능한 범위를 구분하는지 |
| 실제 손익 중 신규 입금·연속 입금 | 기존/신규 주주 간 가치 이전과 반올림 오차 |
| read 실패·가격 이상·가스 상한 | 원인별 입금 거부와 실패 값의 보존 |

공개 계정 읽기는 가설 수집이다. 통제 계정의 작업 전후 영수증·단일 블록 raw read·단위·전체 실험 범위로 회계식을 확정한다. HTTP는 개발 대조용이며 계약의 가격/잔액/서명 입력이 아니다. mock은 확정한 규칙의 회귀에 사용하며 프로토콜 동작의 증거로 대신하지 않는다.

구현 순서는 등록 목록·결과 타입 설계 → 두 모드의 통제 회계식 검증 → 평가기와 Core 결과 verifier → timestamp 의미 수정/입금 연결 → HIP-4·다중 DEX·FE·회귀 통합이다. 시장별 시험은 병행 가능하다. 기존 verifier/config는 immutable 의존성이 있으므로 새 adapter를 setter 하나로 끼워 넣을 수 있다고 가정하지 않는다. 새 Factory 설정 또는 검토된 upgrade/migration의 configHash·storage 호환 경로를 설계하고, 계약 크기·기존 claim 회귀를 확인한다.

## 8. 미확정 사항과 공식 근거

채택된 것은 **운용자 등록 목록 + 모드별 precompile 평가 + 입금 직전 동기 지분 발행**이다. 미확정 사항은 raw 필드의 모드별 합산식, 모드 전환 인증, 조회 실패 시 Lending 부재의 인증, HIP-4 단위/정산, Core 비요청 자금 귀속, Spot 가격 허용 정책, 최대 가스/시장 수다. 이 항목이 해결되지 않은 source를 생산용으로 연결하지 않는다.

2026-10-04 공식 문서 확인:

- [Account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes): Unified·PM 담보 공유와 API 개별 DEX 상태 해석. precompile의 중복 관계까지 증명하는 문서는 아니다.
- [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin): 자동 공급·차입·이자·한도와 청산 구조.
- [Spot Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot): 통합 잔액의 API 기준. raw precompile과 구분한다.
- [Interacting with HyperCore](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore): precompile 시점·호출 실패·CoreWriter 액션.
- HIP-4 세부 공식 근거와 실제 관측은 [관측 문서](managed-precompile-evidence.ko.md)의 링크와 원시 자료를 따른다.
