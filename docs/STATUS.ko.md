# 현재 구현과 검증 상태

최종 갱신: 2026-10-12 KST. **프로토타입이며 실제 자금 운용 준비 완료 상태가 아니다.** 이 문서는 최신 구현 범위·검증 결과·배포 상태의 관리 원본이다. 작업 순서와 완료 조건은 [BACKLOG](BACKLOG.ko.md), 설계 이유는 [DECISIONS](DECISIONS.ko.md)를 따른다.

<a id="hypervault"></a>
## HyperVault 메인넷 통제 왕복 (2026-10-12)

### v6 — 오라클 평가 + 모듈 분리 (현행, 2026-10-13)

[ADR-040](DECISIONS.ko.md#adr-040)·[ADR-041](DECISIONS.ko.md#adr-041). 공개 FE의 입금 대상은 v6뿐이고 v4·v3는 출금 전용(은퇴).

| 항목 | 값 |
| --- | --- |
| HyperVault proxy (= Core 계정) | `0x6c4556b8068397AD2F3e69205b7C100CAf234883` |
| implementation / controller | `0x0985B073726B383fbFe0690E2521040511cbf993` / `0x5dbf9ed6ede0b703c5e3849b02553d44e262e1bb` |
| HyperVaultCoreOps (링크 라이브러리) / Lens | `0x5021afee36fd2ec6041a67fd03439d40c0bde1c4` / `0x236808860d971da83fea76e1848ded39175f3a60` |
| share / accountant | `0xe4479fb2a1cd0d747c3370a1c552f487cfbe2170` / `0xe99849f55fd601dbc8e13b624a2509f9496b4faa` |
| source / verifier | `0x1aD812aA6C49fD41908dE649CC9A3Dfff1E6E9e6` / `0xA9990cB1f9578910D2650782832A7890270D23A8` |
| configHash | `0xe1072b88eb90de94bcd1588737c0d0fecea2e4a93cd5bf53c72f32d6c0740a8f` |
| 한도 / 최소 입금 / 수수료 | 100,000 USDC / 10 USDC / 10% (HWM) |
| API wallet | agent6 `0xc404…D8aA` |

배포 검증 19항목 통과(구현이 기록된 CoreOps를 링크, CoreOps·구현·Lens 코드가 로컬 빌드와 같음 — CBOR 메타데이터 구간 제외: `--libraries` 설정이 메타데이터 해시에 들어가 실행 코드는 같고 해시만 다름). v6 run 1: bootstrap 20 + 활성화 1 → 오라클 범위(사전 점검: perp 159 = HYPE, 오라클 84.205 vs 현물 84.2285) → Core 19 배정(버퍼 1) → Unified → agent6 → 현물 0.13 @83.79 + short 0.13 @83.772(2배, 청산가 139.14) → `oracleOnly = true`, 가격 기록 0개 → owner `redeemNow` 0.5e9 → Lens 미리보기 499,128 = 실제 수령. monitor·keeper 루프(v6)는 이 세션 백그라운드. 이후 수동 차입 실측: HYPE 0.129909를 대출 담보로 공급, USDC 3 차입(건전성 2.35), 범위를 대출 포함으로 전환(`scope --blp`) — 전환 전 NAV는 `ScopeIncomplete`로 거부, 전환 후 컨트랙트 NAV 19.486148 = 같은 블록 재계산 19.486147(차이 1 raw). 대출 장부가 없는 계정에서는 대출 포함 설정 자체가 NAV를 멈추므로(0x0811 오류), 순서는 공급·차입 → 범위 전환이다.

v4 정리(2026-10-13): short 0.12 청산 @84.076 → 현물 0.11991601은 최소 주문 미만이라 버퍼 1.1을 Core로 보내 0.12 추가 매수 @84.312 → 0.23 매도 @84.333(먼지 0.0098 HYPE ≈ $0.83) → agent5 해지 → owner 출금 요청 → 회차 봉인 → 19.610888 회수 → 정산 → 수령. owner 회수 합계 20.66 USDC(입금 21.5 + 활성화 1).

v6 운용 현황(2026-10-13): owner 입금 누계 약 40 USDC, NAV 39.23. Unified 수동 차입 carry — 공급 HYPE 0.5696, 숏 0.55(8x cross, 청산가 99.75 = 현재가 +20.2%), USDC 차입 23.94(건전성 1.28, 차입 쪽 청산까지 −38.6%), Core USDC 약 11.9, EVM 버퍼 3.93. 헤지/NAV 약 116%. 숏 청산 거리는 Core USDC로만 정해지므로(HYPE는 cross 증거금 아님) 상승 시 차입 추가 또는 축소가 필요하다. 감시: `mode_monitor.py --name unified-v6`(3분) + `monitor.py --loop --keeper`(v6, 4분), 둘 다 이 세션의 백그라운드.

### v6 준비 — 모듈 분리 (ADR-041, 배포 완료: 위 절)

v5 변경(오라클 평가·100,000 USDC 한도)에 Core 관리 library·Lens 분리를 더한 다음 배포 후보. `bash scripts/test_managed.sh` exit 0 — forge 369 passed, Python 122 OK, 저장소 검사 통과. 크기: HyperVault 21,629 B, HyperVaultCoreOps 7,557 B, HyperVaultLens 5,029 B. 배포 드라이런 성공(라이브러리 1.70M + 스크립트 18.65M gas; 4.36 gwei에서 약 0.081 HYPE). 리뷰 2차 APPROVE.

USDC Carry 운영(HV-006): 계획 도구 dry-run, 로컬 모니터 상시 실행 — `.omc/hypervault/monitor-unified-v4.json`(v4, Unified 규칙 6개 ok), `.omc/hypervault/monitor-pm-observed.json`(제3자 PM 계정 읽기 전용 관찰, 6개 ok). 기존 keeper 루프는 FE `monitor.json`을 계속 갱신한다. 모두 이 머신의 세션 백그라운드 프로세스라 세션이 끝나면 멈춘다.

### v5 준비 — 오라클 평가 (ADR-040, 미배포)

코드·시험·리뷰(2차 APPROVE) 완료, 메인넷 미배포. 헤지된 현물 HYPE와 숏을 HYPE perp 오라클 한 가격으로 평가하고, oracle-only 범위에서는 `redeemNow`가 가격 기록 없이 지급한다. `bash scripts/test_managed.sh` exit 0 — forge 360 passed, Python 106 OK. 크기: HyperVault 24,442 B(여유 134), HyperVaultNavSource 17,653 B, HyperVaultNavVerifier 8,084 B. 같은 블록 실측으로 `accountValue = rawUsd + szi·mark` 등식 확인(차이 0).

### v4 — v3 + 운용 중 버퍼 즉시 출금 (은퇴, 2026-10-13)

[ADR-039](DECISIONS.ko.md#adr-039). 사용자 결정(새 Vault 배포)으로 v3 업그레이드 대신 새 Vault를 배포했다. 계약은 v3와 같은 구조(Share·Accountant·NavSource·NavVerifier)에 `HyperVault.redeemNow`가 추가된 구현이다. 공개 FE의 입금 대상은 v4뿐이고 v3는 출금 전용으로 남는다.

| 항목 | 값 |
| --- | --- |
| HyperVault proxy (= Core 계정) | `0xf9c05bf416F6E45bf3658A92C94fE4f8f03a6b4F` |
| implementation / controller | `0x90f9Bf846c3061fE42678f1741a83eAa6dD1Efcb` (codehash `0x867c1dc1…`) / `0x2f725651d083a485b75b381e7cf05a06018de4f4` |
| share / accountant | `0x6960fd2d19167ba2d6175e16a5f27342b6e0d29d` / `0x9a5c6a1bd9acdcc08803dd502379bc2f9d328459` |
| source / verifier | `0x94Ea87A22044AF089D98ACd59E983aEC04DB0290` / `0x96A41336fa0a271c7956d4d1b9e31272F10226bd` (창 600초·dust 2 USDC·회수 timeout 10,000, v3와 동일) |
| configHash | `0xe4d16e9a5597c2f3bae4b4238857e4e380bfcf6656a40bdac49abf5a455f7a3c` |
| API wallet | agent5 `0xA558…FD8D` (agent4는 v3에서 해지되어 재사용하지 않음) |

배포 검증: `verify` 15항목 통과. v3와 getter 대조 — owner·asset·bridge·treasury·builder(0)·builderFeeCap(0)·maximumAssets(1,000 USDC)·activationCost(1)·decimals(9)와 verifier priceWindow·idleDustLimit·recallTimeoutBlocks·bridge 일치. `performanceFeeBps`·`minimumDeposit`은 bootstrap 전 0이고 bootstrap 뒤 1000·10 USDC로 v3와 일치했다(저장소 값을 bootstrap이 생성자 값으로 채움). 새 proxy라 저장소 레이아웃 이전 문제는 없다.

v4 run 1: bootstrap 21.5 + 활성화 1 → 범위 USDC+HYPE → 19.35 Core 배정(버퍼 2.15) → Unified → agent5 승인 → 현물 0.12 HYPE @86.834 + short 0.12 @86.783(2배, 이번 실행만 Core 예비 USDC 2.5) → keeper `recordPrice` → **Active 중 owner `redeemNow` 1e9 지분 → 0.998270 USDC 즉시 수령**(eth_call 예상과 같음, 0.1% 수수료 포함), 버퍼 2.15 → 1.15, phase Active 유지. monitor 15규칙 ok(이후 버퍼 규칙은 목표 2.15 미달로 warn 가능). v4에서는 `price-history` 규칙이 실제 기록 나이를 본다(기록 없으면 즉시 출금 불가). keeper·monitor 상시 호스팅은 아직 없다.

FE(2026-10-12): 금융 앱형 디자인 정리 배포(CHANGELOG). FE 178 통과. 실제 서명 거래 단계 표시·다크 모드는 화면 미확인.

### v3 — 은퇴 (2026-10-12)

v3 run 3 정리: agent4로 short 0.12 청산 @87.046·현물 0.12 매도 @87.07 → agent4 해지 → epoch 4 봉인 → Core 28.778232 USDC 회수 → 정산 → owner Idle 즉시 출금 22.043688 USDC(입금 22). begin-exit가 owner 출금 요청보다 먼저 실행된 운영 순서 실수가 있었으나 Idle 즉시 출금으로 같은 결과가 됐다. 외부 보유자 `0xabf2…37d3`의 9.937698431 hvUSDC(= 9.95 USDC, v3 EVM 현금 전부)는 v3에 남아 있고 Idle이므로 언제든 즉시 출금된다. FE는 v3를 "retired, withdraw only"로 표시해 입금을 막는다. Core에 HYPE 0.00146 먼지(최소 단위 미만).

운영 도구 RPC(2026-10-12): `scripts/hypervault/hvlib.py`가 공개 `rpc.hyperliquid.xyz` 대신 서드파티 HyperEVM RPC 5개(hypurrscan·drpc·thirdweb·routeme·stakely)를 순환한다(일시 오류 시 다음 노드). 5개 모두 Active 중 `verifier.nav`(precompile 기반) 값이 일치함을 확인했다. sentio는 precompile 호출에 규격 위반 응답을 줘 제외했다. 쓰기는 nonce를 고정해 재시도해도 중복 실행되지 않는다. 공개 RPC는 FE 전용.

### v3 — owner 신뢰 NAV 모듈(신고·급락 대기 제거) (기록)

[ADR-038](DECISIONS.ko.md#adr-038), 원시 증거 [reference/hypervault-v3-mainnet-2026-10-12](reference/hypervault-v3-mainnet-2026-10-12/). 계약은 v2와 같은 HyperVault·Share·Accountant이고 source/verifier만 새 모듈이다. 공개 FE의 입금 대상은 v3뿐이다(v1·v2는 증거).

| 항목 | 값 |
| --- | --- |
| HyperVault proxy (= Core 계정) | `0x2affc225fa3566ea48Bc48e61b50e7Bbcf770516` |
| implementation / controller | `0x63688DDBb939aA5690F096529CF1b6f6aa91DDFa` (codehash `0xdc35f581…`) / `0xd286784c…060e` |
| share / accountant | `0x351d11605ec33916a42f7fbd1245a498bdb9c7a6` / `0x8819b82683fb419db0b61e107de13b3f84ae19ab` |
| source / verifier | `0xa6EFFFB6d8320bBc2422C3D2f7600D856ba2D393` (`HyperVaultNavSource`) / `0x9EFB88a5fb03bC1060b35F9Af4baE2B61e270b6e` (`HyperVaultNavVerifier`, 창 600초·dust 2 USDC·회수 timeout 10,000) |
| configHash | `0xd4f74aaf1789994dc28d888035da567e14848d67f3fe0d211911d0c0a4141e4b` |
| 계약 크기 (runtime) | NavSource 15,418 B, NavVerifier 7,831 B (HyperVault·Share·Accountant는 v2와 동일) |

v3 run 1 실측: 배포 5개 bytecode가 로컬 빌드와 완전 일치(immutable 제외), 검증 15항목 통과 → seed 11 + 활성화 1 → 범위 USDC → 9.9 배정 → **가격 기록 0개인 상태에서 Active 입금 10 → 10e9 발행** → Active 출금 요청 → exit·회수 9.9 → **하락 대기 없이 즉시 정산** → claim 21.0. 입출금 21.0 일치, 손실 0. Core gas용 HYPE 0.002는 owner가 `sendAsset`으로 보냈다(범위 밖). 시험: `test/HyperVaultNav.t.sol` 5개(실 source/verifier + HyperVault 통합: 이력 없는 발행, 50% 하락 뒤에도 입금, 기록 무관 정산, 평탄 아님이면 정산 거부, 창 최저 뒤 수수료, 읽기 실패 시 발행 중단). `bash scripts/test_managed.sh` exit 0 — forge 339 passed, Python 95 OK. FE 145 통과, Vercel 재배포(v3 화면·증거 v3/v2/v1 확인).

즉시 출금(ADR-039, 2026-10-12): `redeemNow`는 v3에 적용하지 않고 새 v4 Vault로 메인넷에 적용했다(위 v4 절).

v3 run 3 갱신(08:11 UTC): 입금자 2명(owner 22, 0xabf2…37d3 10 USDC), NAV 32.15, Core USDC 18.30(증거금 보강), short 청산가 228.47, EVM 버퍼 3.216. 헤지는 0.12 HYPE 그대로(추가 쌍은 최소 주문 때문에 미개설). v3 run 3 운용 중(2026-10-12 04:34 UTC~): owner 22 USDC, Core 현물 0.12168847 HYPE + perp short 0.12 HYPE(2배, Unified) + Core USDC 약 9.26, EVM 버퍼 2.216. verifier NAV 22.147331, 지분 가격 1.005975, monitor 15규칙 ok. agent4 `0xaAe5…E575`가 승인된 API wallet. 실제 연 수익은 헤지 비중 약 48%·Standard 기준이라 화면의 Target APR(PM 루프 8.7%)보다 낮다(90일 펀딩 기준 대략 4%대). monitor/keeper 상시 호스팅은 아직 없다.

FE 제품형 재디자인(2026-10-12): 랜딩·상품 3종(USDC Carry 라이브, HYPE/BTC Plus Coming soon·미배포)·Vault 상세의 보유 지분/가치 카드. 추정 APR은 2026-10-12 스냅샷 계산값(~5.3%/~1.3%/~0.7%)이며 약속이 아니다. FE 158 통과, `tsc`·빌드 통과, 1280/375 다크·라이트 확인, Vercel 재배포 후 배포본에서 글꼴·온체인 읽기 확인. 계약 변경 없음. 지갑 연결 상태의 Your position 실표시는 실제 지갑으로 확인하지 않았다.

운영 갭 보강(2026-10-12): [갭 분석](hypervault-operations-gap.md). monitor 15규칙(펀딩 24h/7d 평균, 출금 SLA 72h, NAV 이력 게시·원장 백필 36점, 경보 웹훅), FE `#/docs` 사용자 문서와 지분 가격 차트·실현 수익(30일 전 연환산 안 함). Python 101 OK, FE 155. 계약 변경 없음. 남은 운영 공백: 가드(긴급 정지)·multisig owner·전략 화이트리스트는 v4 계약 변경, monitor/keeper 상시 호스팅, 감사.

운영·화면(2026-10-12): monitor 14규칙(`blp-health` 추가, v3 대상 1회 실행 전부 ok; health 계산이 run 2 API 값 1.4613과 일치). FE Vault 화면에 실시간 포지션·거래 내역·시장 금리·누적 지분 가격 변화를 추가했다(Vault APR은 30일 이력 전 미표시). FE 시험 149, Python 98 OK(HyperVault 14).

v3 run 2 — **API wallet 수동 차입(BLP) 실측**: 계정 모드 `default`(PM 아님, 계정 가치 $10k 미만)에서 Vault의 API wallet이 L1 액션 `{type:"borrowLend", operation, token, amount}`로 HYPE 0.13 담보 공급 → USDC 5 차입(health 1.4614) → 상환(`amount` null = 전액, 이자 0.0000007) → 담보 회수를 모두 `ok`로 실행했다. 이 액션은 공개 Exchange 문서와 SDK 0.24에 없고 공식 웹앱 번들의 BorrowLendPage에서 형식을 확인했다(웹앱도 agent 키로 서명). 차입이 생긴 순간 USDC lending 장부가 범위에 없어 NAV가 `ScopeIncomplete`로 닫혔고, `scope --blp`(USDC·HYPE lending 장부 포함)로 재등록하자 verifier NAV 15.158817 = API 재계산 15.158818. 해제 뒤 HYPE 매도·회수·정산·claim: 입금 15.0 → 회수 15.008495. HYPE 가격 상승분 0.0085가 **실거래 이익으로 HWM 수수료 0.00085(848,567 지분)** 를 정산 시 발행했고 owner가 Idle 즉시 출금으로 회수했다. 차입 USDC를 EVM으로 회수할 수 있는지, PM 계정에서 수동 차입 비활성(문서) 여부는 실측하지 않았다.

### v2 — kHYPE식 분리·양도 가능 지분·HWM 수수료 (입금 화면에서 제외)

[ADR-037](DECISIONS.ko.md#adr-037), [구조](hypervault-architecture.md), [표준 대조](standards-review.ko.md#hypervault-v2), 원시 증거 [reference/hypervault-v2-mainnet-2026-10-12](reference/hypervault-v2-mainnet-2026-10-12/). 공개 FE는 v2만 입금 대상으로 둔다. v1은 증거로 남는다. 독립 감사 없음.

| 항목 | 값 |
| --- | --- |
| HyperVault proxy (= Core 계정) | `0x4Dd7a7ECB3Bc91792b83e0Ee5fFb5b0E7fF9C58B` |
| implementation / controller | `0x44B7464749AEfC58AA353031275aD2c1C1C0d5ed` (codehash `0x06e6e1f2…`) / `0xc6caa4b5…3fac` |
| share (hvUSDC, 9 dec) / accountant | `0xfe226ffa798dbce825b0f2aafe5218e0e134c065` / `0x92221ddeba71ba16b08710e8b4c6e11238362a1b` |
| source / bridge / verifier | v1 배포 재사용(변경 없음) |
| configHash | `0x76cc79466b621d6cb8b5caba6600e2ccfc98cebb595379de8525142f16dd0e6f` |
| 계약 크기 (runtime) | HyperVault 23,237 B(여유 1,339), Accountant 2,807 B, Share 2,521 B |

| 기능 | 구현 | 로컬 검증 | 네트워크 검증 | 배포 | 운영 |
| --- | --- | --- | --- | --- | --- |
| 분리 지분 토큰·양도 | O | O | O (3e9 전송 → 수령자 출금 요청·claim) | O | X |
| Vault 단위 HWM 수수료(지분 발행 80/20) | O | O (fuzz 포함) | O (합성 이익 0.5 → 수수료 0.05, 48,191,803 지분) | O | X |
| 보수적 가격(창 최저 기록)·급등 미과금·입금 대기 | O | O | O (상승 직후 수수료 0·rate 1.000·maxDeposit 0, 창 갱신 뒤 과금·재개) | O | X |
| 무revert 환율 조회(`convertTo*`/`totalAssets`) | O | O | O (Exiting·Idle 중 응답) | O | X |
| Active 입금(수수료 선정산 후 발행) | O | O | O (preview = 발행 9,638,553,471, gas 274,531) | O | X |
| ERC-7540 출금(controller/operator, 같은 epoch 합침) | O | O | O (pending 12.64e9 → 정산 13.1125 → claim) | O | X |
| v2 거래(agent)·HYPE/UBTC v2·native router | X | X | X | X | X |

v2 run 1 실측: 배포·검증 15항목 통과, 배포 bytecode가 로컬 빌드와 일치(immutable 제외). 배포 뒤 `forge fmt`로 공백만 바뀌어 현재 소스의 metadata hash는 배포본과 다르고 나머지 bytecode는 같다(HyperVault·Accountant). seed 12 + 활성화 1 → owner→demo-user 지분 3e9 전송 → 버퍼 정책으로 10.8 배정 → 기준 checkpoint(수수료 0) → **합성 이익**: owner가 Core에서 0.5 USDC를 Vault Core 계정으로 전송(`spotSend`는 owner Unified 계정이라 거부, `sendAsset` 성공; 거래 수익이 아님) → 직후 NAV 12.5, 수수료 0, rate 1.000, 입금 닫힘 → 약 10분 뒤 창 최저 1.0417 → checkpoint로 수수료 0.049999 USDC(10%) 지분 발행, HWM·rate 1.0375 → demo-user Active 입금 10 → 전액 요청(pending) → exit·회수 11.3(Core gas 0.00003682 HYPE)·정산 13.1125 → claim 13.1125(= 3 × 1.0375 + 10) → owner Idle 요청 즉시 정산·claim 9.3875. 입출금 합계 22.5 일치. demo-user 자금은 owner에게 반환했다. 정산 거래는 runner의 영수증 파싱 실패(cast가 JSON 두 개 출력)로 사후에 로그로 찾아 기록했고 파서를 고쳤다. 공개 RPC rate limit에 재시도를 추가했다.

검증 실행(v2): `bash scripts/test_managed.sh` exit 0 — forge 334 passed(HyperVault 20 포함: 기부 방어 3 추가), Python 95 OK, 크기·storage gate 통과. FE 시험 145 통과, 빌드 통과. Vercel 재배포 `https://hypervault-plum.vercel.app`(v2 Vault 화면의 HWM·rate·share 표시, 증거 화면 v2·v1, 375px 가로 스크롤 없음 확인). 리뷰 에이전트 검토 2회: F1·F2 수정 뒤 승인, 나머지 LOW는 [ADR-037](DECISIONS.ko.md#adr-037)·구조 문서에 기록.

### v1 — ManagedAssetVault (run 1~3, 입금 화면에서 제외)

[ADR-035](DECISIONS.ko.md#adr-035), [명세](hypervault.ko.md), [제출 패키지](hypervault-submission.md). **owner 자기 소액 자금으로 USDC Vault 1개를 메인넷에 배포해 왕복 3회를 완료했다.** 영문 구조: [hypervault-architecture.md](hypervault-architecture.md). HYPE/UBTC Vault는 배포하지 않았다. 독립 감사 없음. 실자금 상품 출시가 아니다.

| 항목 | 값 |
| --- | --- |
| Vault proxy (= Core 계정) | `0x46c0e94C07111390d7B1F49147AB397B2d991eAe` (chain 999) |
| controller / implementation | `0xf8f90463Eaf559B4da2f873b481A929363c34fCc` / `0xB2d69CFb6DF1735a2b450293Df334e257c7Bfb88` (codehash `0xce349b36…`) |
| source / bridge / verifier | `0xf4094199…0dc1` / `0x75798f27…10b2` / `0x72abc2bc…5b5c` |
| configHash | `0x66ed42fc9cbd7a5f5ecd218ae230f00e82aa822bfecb1c1379efb68f303703a2` |
| 원시 증거 | [reference/hypervault-mainnet-2026-10-12](reference/hypervault-mainnet-2026-10-12/) (단계별 전후 스냅샷·tx hash) |

| 기능 | 구현 | 로컬 검증 | 네트워크 검증 | 배포 | 운영 |
| --- | --- | --- | --- | --- | --- |
| USDC Vault 배포·검증·bootstrap·EVM 경로 활성화 | O | O | O (메인넷) | O (메인넷, 소액) | X |
| 입금·배정·회수·정산·claim | O | O | O (owner seed, 별도 예치자, Active NAV 입금; Idle 즉시 출금) | O | X |
| Active 중 NAV 기준 지분 발행 | O | O | O (run 3: 공식과 일치, 기존 지분 가치 보존. 지분 가격 1.0 상태) | O | X |
| ERC-7540 비동기 출금 | O | O | O (pending→claimable 전이, Idle 동일 거래 정산) | O | X |
| 유동성 버퍼 | 운영 정책만 | O | - | - | X (계약의 버퍼 기반 즉시 출금 없음, ADR-036) |
| agent 주문의 Vault 계정 귀속 | O | O | O (현물 매수·매도, perp 숏 진입·상환) | - | X |
| precompile NAV 대 Core 장부 | O | O | O (HYPE 현물: 차이 0, 숏 보유 Unified: 차이 0.0027) | O | X |
| USDC 전략 v0 runner | O | O (단위 시험) | O (헤지 진입·펀딩 수령·청산 1회) | - | X (주기 실행 없음) |
| Portfolio Margin | O (계약 action) | - | **실패 관측**: 계정 가치 < $10k라 Core가 적용하지 않음 | - | X |
| HYPE/BTC Vault·PM 추가 leg | O | O (mock·dry-run) | X | X | X |
| 규칙 감시 12개 + keeper | O | O | O (메인넷 Vault 대상 루프 실행) | - | X (상시 운영 아님) |
| AI 요약(advisory) | O | - | O (`claude -p`, 도구 없음) | - | X |
| FE (HyperVault 화면, 실 Vault manifest) | O | O (FE 시험 144) | O (배포본 실 RPC 읽기, 헤드리스 1280·375) | O (Vercel, **`https://vault.hypurrquant.com`** 연결 완료 2026-10-12: Cloudflare DNS CNAME → `cname.vercel-dns.com`(DNS only), `_vercel` TXT 소유 확인, Vercel Let's Encrypt 인증서. 기존 `hypervault-plum.vercel.app`도 유지) | X |

실측 사실:

- EVM→Core 활성화: bootstrap의 Circle deposit 1 USDC로 Vault Core 계정이 생성됐고 Core 잔액은 0.0이었다(1 USDC 전부 신규 계정 비용, Circle `newCoreAccountFee`=0).
- run 1: seed 11.78 → 배정 11.7 → agent가 HYPE 0.13 매수 → source 평가 = API USDC + HYPE × reserve(차이 0) → 0.12 매도 → 회수 10.833246 → 정산 → owner claim 10.913246. seed 11.78 대비 감소 0.866754(범위 밖 HYPE 약 0.85 + 거래·가스), owner 지출 12.78(seed + 활성화 1) 대비 1.866754.
- run 2: 별도 예치자 25 USDC → 배정 24.9 → runner가 현물 0.16 매수(86.343) 후 체결 수량 0.16 숏(86.307, 2x) → Unified에서 precompile 현물 USDC는 perp 증거금 제외·perp accountValue는 uPnL 포함으로 이중 계산 없음 → 18:00 UTC 펀딩 +0.000173 → 숏 상환·현물 매도 → 회수 24.881177 → 정산 → claim 24.981177. 손실이라 성과 수수료 0, `lossCarry` 18,823(0.018823 USDC).
- run 3: owner Idle 입금 15 → 배정 14.9 → 가격 기록 5분 뒤 입금 개방 → demo-user Active 입금 10이 `totalAssets` 15.000000·지분 15e9 기준 10e9 발행(공식 일치), 입금 후 NAV 25.0·owner 가치 15.0 유지 → demo-user 요청(pending 10e9) → exit·회수 14.9·정산(claimable 10e9) → claim 10 → Idle에서 owner 요청이 같은 거래에서 claimable 15e9 → claim 15. 손실 0.
- 출금 의미: Idle은 요청 즉시 정산, Active는 owner의 exit·전체 청산·회수·정산 뒤 claim. 사용자가 강제할 수단이 없고 한 명의 출금이 전체 전략 청산을 요구한다([구조 §7](hypervault-architecture.md#7-withdrawals-erc-7540)). ERC-7540 대조는 [표준 검토](standards-review.ko.md#managed-asset-vault): `totalAssets`/`convertTo*`가 NAV 검증 불가 시 revert하는 것이 ERC-4626과의 불일치다.
- `setAbstraction(PortfolioMargin)` EVM 거래는 성공했으나 Core 모드는 `default` 유지. verifier는 control action 성공으로 처리했다(관측 불가 경계 재현).
- Core→EVM 회수 전송 gas는 Core HYPE에서 차감(0.000176, 0.000212 HYPE).
- 소액 Vault에서 팔 수 없는 gas 예비 HYPE가 출금 정산의 300 bps 하락 대기를 막아 두 번 모두 HYPE를 범위에서 빼고 정산했다(ADR-035).
- keeper와 owner가 같은 키를 쓰면 nonce 충돌로 owner 거래가 거부됐다. keeper 전용 키로 분리했다.
- 감시 경보 기록([alerts.jsonl](reference/hypervault-mainnet-2026-10-12/alerts.jsonl)): `nav-ledger` −0.86/−0.83은 HYPE를 범위에서 뺀 의도된 차이, `delta`는 run 1의 비헤지 HYPE 보유, `margin` 1.002는 Unified에서 perp DEX 계정 가치를 담보로 쓴 이전 공식의 오탐이다. 공식을 유지 증거금 ÷ (USDC 잔액 + uPnL)로 고쳤고 같은 포지션에서 0.06~0.1로 계산된다. AI 요약은 "$0.85"를 "0.85 HYPE"로 잘못 읽은 적이 있어 수치 판정은 규칙 엔진만 한다.
- 운영 비용: 활성화 1 USDC, owner EVM 가스 약 0.007 HYPE(별도로 keeper·demo-user 가스 지갑에 0.01 HYPE 이체), 거래·스프레드 약 0.04 USDC, Vault Core 범위 밖 잔량 HYPE 0.0094.

배포본 확인(2026-10-12): 6개 화면 200·가로 스크롤 없음(1280/375), Vault 상세가 메인넷 현재 상태(Idle·지분 0·성과 수수료 10%/플랫폼 20%·Core USDC 0.00000031) 표시, 증거 화면 2개 회차·탐색기 링크 41개, 보안 헤더(frame-ancestors none, X-Frame-Options DENY, HSTS, nosniff), JSON no-cache, 지갑 없는 브라우저의 연결 시도는 영어 오류로 종료. 공개 빌드는 지갑 쓰기 허용 + 감사 전·owner 협조·상한 1,000 USDC 경고(사용자 결정). 실제 지갑 입금·출금·claim은 FE로 실행하지 않았다.

검증 실행(2026-10-12): `bash scripts/test_managed.sh` 통과 — forge 314 passed, Python 95 OK(HyperVault 신규 11 포함), 크기·storage gate exit 0. `bash scripts/test_frontend.sh` 통과 — FE 144 tests(FE 세션 실행 결과). Solidity 계약은 변경하지 않았다.

## 신규 구현: 자산별 Vault (2026-10-11)

[ADR-033](DECISIONS.ko.md#adr-033)의 자산별 회계와 [ADR-034](DECISIONS.ko.md#adr-034)의 [직접 배포](direct-vaults.ko.md)를 사용한다. 플랫폼이 USDC/HYPE/UBTC 각각 ManagedAssetVault proxy를 직접 배포하고 지정 owner가 bootstrap한다. 원금은 EVM 수령 후 즉시 지분 발행, 별도 USDC 활성화, owner 배정 큐 실행이다. HYPE native Router·기준 자산 NAV/수수료·ERC-7540 출금·48시간 upgrade를 유지한다. 기존 USDC Vault의 자동 migration은 아니다.

기본 FE는 검토된 배포 목록으로 Vault를 선택하고 입출금·예약 배정/회수·agent·정산·기본 평가 범위·가격 기록을 제공한다. 공개 생성 메뉴는 제거했다. 이전 Factory 코드는 이력 회귀용으로 남겼다. 직접 배포와 owner bootstrap 스크립트를 추가했다. **실배포·초기화·자산 왕복·서명 주문은 하지 않았다.** 주문·채팅의 직접 Vault 연동, PM 전략 자동 실행 및 실계정 위험 한도 검증은 남아 있다. [ASSET-001](BACKLOG.ko.md#asset-001).

사용자가 지정한 “볼트 수익률 비교” 세션과 메시지를 교환해 HYPE/BTC 상품 방향과 제안 APR/수수료를 구분했다. [kHYPE 오라클](khype-oracle.ko.md)은 고정 블록 48,237,883에서 활성 adapter 1개, 최소 유효 개수 1, OracleManager 반영 간격 하한 24시간·보고 freshness 1시간을 관측했다. 내부 offchain 수집 정확성·validator별 최신 보고를 증명한 것은 아니다.

메인넷 읽기 관측: EVM block 48,181,740에서 USDC EVM/Core decimals 6/8, HYPE 18/8(native 예외), UBTC 8/10 및 연결 ERC20 `0x9fdbda0a5e284c32744d2f17ee5c74b284993463`, HYPE·UBTC reserve를 확인하고 같은 block hash를 재확인했다. 초기 HYPE decimals 판정 실패도 보존했다. [원시 자료·범위](reference/README.md). 이 결과는 소액 왕복·NAV 전체성 증거가 아니다.

## 최신 구현: precompile NAV와 온체인 검증기

2026-10-04~05 [ADR-029](DECISIONS.ko.md#adr-029): 운용 중 **실시간 NAV와 동기 지분 발행**이 mock 없이 동작하도록 Vault의 `verifier` 자리에 들어갈 계약을 구현했다. 사용자가 [구조 비교안](managed-scope-enforcement-options.ko.md)에서 "A 먼저, B는 나중에"를 선택해, 등록하지 않은 보유 때문에 지분이 싸게 발행되는 문제에 대한 **신고 차단과 급락 대기**를 같은 두 계약에 추가했다. [현행 명세](managed-precompile-nav.ko.md).

- [HyperCorePrecompileSource](../src/nav/HyperCorePrecompileSource.sol): Vault별 owner 등록 범위(token 6·USDC DEX 8·HyperCore vault 2 이하)와 입금 스위치, 모드와 무관한 단일 평가식, 가격 가드(reserve oracle은 spot mark와 2% 이내, 그 외는 호가 안·spread 1%). 음의 DEX equity와 집계하지 않는 lending 장부는 발행을 닫는다. 이전의 `complete=false`·`observedAt=0`·immutable 목록·Standard 후보 장부는 제거했다.
- **미등록 보유 신고**(같은 계약): 누구나 범위 밖의 token·perp DEX·HyperCore vault를 지목하면 계약이 그 대상을 직접 읽는다. 차입·포지션이 있거나 팔 수 있는 보유(온전한 lot을 최우선 매수호가로 평가해 주문 최소 금액 이상)가 있으면 신고가 성립한다. 평가는 매번 신고된 대상을 다시 읽어 **지금도 성립하는 동안에만** 발행 평가와 종료 평가를 거부하므로, owner가 그 보유를 정리하면 바로 다시 열린다(등록으로 풀면 새 가격 기록이 반 창을 채운 뒤 열린다). Vault당 1건만 보관하고 **성립하는 신고는 자리를 지킨다**(그동안 다른 대상의 신고는 거부되고 같은 대상의 재신고는 기한만 늘린다). 1일 뒤 소멸하므로 다시 신고해 갱신한다. owner가 신고된 대상을 등록해 그 신고가 더 성립하지 않게 되면 신고는 목록에서 빠지고, 그때까지의 가격 기록은 발행과 종료의 이력으로 세지 않는다. 등록된 token도 등록된 USDC pair가 그 보유를 사 주지 않는 동안(종료 평가에서 0으로 세는 동안)에는 다른 pair에서 20 USDC 이상에 팔 수 있으면 신고할 수 있고, 그런 신고는 등록으로 풀리지 않는다. 이력의 재시작은 `configure`가 그 직전까지 성립하던 신고를 푼 경우에만 일어난다.
- **종료 평가**(같은 계약): 등록 범위에서 아직 팔 수 있는 가치만 센다. 1 lot 미만이거나 주문 최소 금액에 못 미치는 보유는 0으로 보고 가격 가드를 쓰지 않는다. 제3자가 보낸 소량이나 호가 상태가 종료 평가를 막지 않고(정산에 필요한 가격 기록은 호가 상태에 묶인다), 그런 잔량만 남은 token은 범위에서 뺄 수 있다.
- [ManagedPortfolioNavVerifier](../src/managed/ManagedPortfolioNavVerifier.sol): `verifyNav`(Core 순자산 + `availableCash`), `verifyAction`(뒤의 Core 블록·실제 도착 USDC), `abandonRecall`(도착하지 않은 회수는 owner의 포기 선언에서 대기 기간이 지난 뒤에만 닫힘), `verifyIdle`(부채 없음·가져올 수 있는 가치가 dust 상한 이하. 상한은 배포 시 10 USDC 미만으로 고정). 외부 action verifier와 `maxAge` 의존을 제거했다.
- **급락 대기**(같은 계약): 누구나 `recordPrice`로 지분 가격을 기록한다(Vault당 8건, 간격 안에서는 더 높은 가격만 직전 기록을 대체). `verifyNav`는 최근 창의 기록이 창의 절반 이상을 덮고 현재 가격이 그중 최고 기록보다 한도 넘게 낮지 않을 때만 값을 낸다. 종료 정산(`verifyIdle`)도 지급될 현금 기준 가격에 같은 두 조건을 적용한다(지분이 없는 Vault의 종료는 예외). 기록은 입금 스위치, 신고, pending 관리 액션과 무관하게 등록 범위의 가격으로 계속되고, Idle에서는 Vault가 발행에 쓰는 현금 기준 가격을 기록한다. 신고가 등록으로 답해진 뒤에는 그 뒤의 기록만 이력으로 센다. 창(10분~1일)과 한도(0.1~20%)는 배포 시 고정한다.
- `ManagedUsdcVault`·Factory·upgrade controller의 코드, ABI, storage, bytecode 크기는 바꾸지 않았다. FE가 쓰는 Vault·Factory ABI도 그대로이며, FE는 source와 verifier의 ABI를 추가로 내보낸다.
- 평가식의 근거로 공개 mainnet 계정 16개(Unified 10, PM 4, default 1, disabled 1)를 블록 고정으로 읽어 API 통합 잔액과 대조했다. [관측](managed-precompile-evidence.ko.md#raw-ledger-identity).
- lending 장부 확인에 쓰는 gas 한도(20,000)의 근거로 precompile 호출 비용을 mainnet에서 읽기 전용으로 측정했다. [관측](managed-precompile-evidence.ko.md#precompile-gas).
- [scope_watch.py](../scripts/scope_watch.py): 감시와 가격 기록의 **판단 부분**이다. 공개 API로 Vault Core 계정의 보유를 열거해 등록 범위와 비교하고 신고·갱신·정리 호출과 가격 기록 시점을 낸다. source·verifier가 배포돼 있으면 각 호출을 고정 블록의 `eth_call`로 시뮬레이션해 계약이 받아들이는 것만 보낼 목록에 넣는다. token은 USDC로 팔 수 있는 경로(직접 pair와 quote token을 한 번 거치는 pair)마다 후보를 내고, 등록된 token의 보유도 다른 pair를 거치는 후보로 낸다(등록된 pair가 그 보유를 사 주지 않을 때만 계약이 받아들인다). 보관되는 신고가 한 건이고 성립하는 동안 자리를 지키므로 보낼 신고도 많아야 한 건이다. 자리가 비어 있으면 받아들여지는 대상 중 가장 커 보이는 곳, 보관된 신고가 성립 중이면 소멸이 가까울 때의 갱신뿐이다. 서명·전송·주기 실행은 없다.

- 별도 컨텍스트의 자동 코드 리뷰를 세 번 받아 반영했다(모두 critical 0). 3차(2026-10-05)는 신고와 급락 대기를 대상으로 했고, 가격 기록 간격을 선점해 급락 대기를 우회하는 문제(high)와 종료 정산의 대기 부재·한순간의 증명으로 유지되는 신고 등을 지적했다. 그 수정의 재검증은 성립하는 신고를 밀어낼 수 없어 10 USDC 미끼 신고로 다른 신고와 가격 기록을 모두 막을 수 있던 문제(high)와, 기록을 끊으면 종료가 대기 없이 정산되던 문제를 지적했고 둘 다 반영했다. 재검증 2회차는 그때 넣은 "최신 증명이 자리를 차지" 규칙이 연 우회로를 지적했다(high 3: 미끼 신고를 등록으로 풀고 같은 블록에 입금, 제3자의 한 블록짜리 증명으로 성립 중인 신고 걷어내기, 처리될 수 없는 회수로 가격 기록 끊기). 성립하는 신고가 자리를 지키게 되돌리고, 신고가 등록으로 답해지면 가격 이력을 다시 시작하게 하는 것으로 반영했다. 재검증 3회차는 그 수정들이 유지됨을 확인하고 한 건(low: 미끼 신고 뒤에서 숨긴 token을 매수호가 없는 pair로 등록해 신고와 종료 평가를 벗어나는 경로)을 지적했다. 그 대응으로 넣은 규칙(보유 중인 token을 등록하면 이력 재시작)은 4회차에서 우회됨이 확인돼(빈 상태로 등록한 뒤 가치를 옮겨 넣음) 뺐고, 등록된 token도 종료 평가에 잡히지 않는 동안에는 신고할 수 있게 바꿨다. 5회차는 그 수정이 유지됨을 확인하고 부작용 두 건(low: 스스로 풀린 신고 때문에 무관한 범위 변경이 이력을 다시 시작하는 것, 최소 금액 근처의 잔량이 pair 사이의 작은 가격 차이로 신고되는 것)을 지적했으며, 둘 다 리뷰어가 시험한 형태로 반영했다. 6회차(마지막)는 그 두 수정이 유지되고 앞의 지적들이 다시 열리지 않았음을 확인했으며 코드 결함을 찾지 못했다. 4,800개 token 상태와 24개 DEX·vault 상태에서 한 블록 안의 `configure` 전후를 비교해, 성립 중인 신고가 풀린 362건 모두에서 이력이 다시 시작됐고 그 밖에는 이력이 바뀌지 않았다고 보고했다. 같은 보고가 지적한 명세의 틀린 문장, gas 모형의 신고 형태, 생존 변이 2건의 시험을 반영했다. 이 마지막 반영분(시험·주석·문서)은 다시 리뷰받지 않았다. 반영 내역, 반영하지 않은 제안과 그 근거, 남긴 한계는 [ADR-029](DECISIONS.ko.md#adr-029)의 검토 기록에 있다. 독립 보안 감사가 아니다.

**하지 않은 것:** 메인넷 배포·서명·입금·주문·회수, 프로젝트 계정의 통제 왕복, 독립 외부 감사, 신고·가격 기록 거래의 전송과 주기 실행([OPS-001](BACKLOG.ko.md#ops-001); 판단 부분만 구현). ADR-029의 정책 7개와 결정 대기 5개(A·B·C·E·F), `priceWindow`·`maxDrawdownBps`의 배포 값은 사용자 확정 대기다. **실자금 입금은 여전히 열지 않는다.**

**남은 위험:** 등록 범위의 완전성은 여전히 운용자 책임이다. 신고는 누군가 해야 성립하고, 급락 대기는 지연일 뿐이어서 신고가 없으면 창이 지난 뒤 낮은 가격으로 발행이 재개된다. **신고가 있어도 닫히지 않는 순서 경쟁이 있다.** 보관되는 신고는 한 건이고 지금 성립할 때만 Vault를 닫으므로, 악의적인 owner가 신고된 대상을 Core에서 비우거나(자기 소액 보유를 먼저 신고해 자리를 차지해 둔 경우 포함) 숨긴 가치를 다른 미등록 대상으로 옮긴 뒤, 그것이 반영된 첫 블록에 감시자의 다음 신고보다 먼저 입금하면 싸게 발행된다. 급락 대기 때문에 그 전에 가치가 반 창에서 한 창 동안 범위 밖에 있어야 하지만, owner가 등록 범위를 평가할 수 없는 상태(가드 밖의 호가, 집계하지 않는 lending 장부 등)로 두어 가격 기록을 끊으면 그 시간이 한두 블록으로 줄어든다. 이 구조에서는 막지 못한다(결정 대기 F). 한도 이하의 하락은 걸리지 않는다. keeper가 없으면 종료 정산도 기록 뒤 반 창을 기다리고, 팔 수 없는 잔량이 등록 범위에 남은 작은 Vault의 종료는 owner가 그 token을 범위에서 뺄 때까지 미뤄진다. 등록 token의 가격이 가드에 걸려 있는 동안에는 가격 기록이 되지 않으므로, 그런 token을 1 lot 이상 보유한 Vault의 종료도 owner가 그것을 팔거나 범위에서 뺄 때까지 정산되지 않는다. 매수호가가 없는 순간에는 보유 규모와 무관하게 token을 범위에서 뺄 수 있다. 신고와 가격 기록을 실제로 전송·운영하는 봇이 아직 없으므로 그 전에는 급락 대기가 시간만 번다. 낮게 기록된 가격 표본을 제 가격으로 되돌리는 일과 신고의 갱신도 봇의 몫이다. HIP-4 outcome과 sub-account는 신고 대상이 아니다. 발행자가 잔액을 동결할 수 있는 token으로 신고를 비용 없이 유지할 수 있는지는 확인하지 못했다(결정 대기 E). owner가 자기 다른 계정과 불리한 가격에 거래해 가치를 빼는 것은 이 구조에서 막지 못한다. Core 쪽 액션 거절은 관측할 수 없다. 등록 항목의 조회가 계속 실패하면 종료가 확정되지 않으며 복구 경로가 없다(결정 대기 A). spot 호가로만 평가되는 토큰은 얇은 시장에서 한 블록 조작에 취약하다(결정 대기 B). Vault 거래의 gas 수치는 비용식의 로컬 모형이고, 실측한 것은 개별 precompile 호출 비용뿐이다. HIP-4·USDC 외 담보 DEX·staking·sub-account는 평가하지 않는다. Factory의 선제 활성화 차단은 이전부터 있던 별개의 미해결 문제다([FACTORY-001](BACKLOG.ko.md#factory-001)).

## 최신 구현: 볼트 탐색·주문·대화 화면과 대화 서버

2026-10-05 사용자 요청("볼트를 만들고, 다른 유저의 볼트도 보고, 볼트 배포자가 주문도 넣을 수 있는 FE"와 "볼트 배포자와 유저가 대화할 수 있는 장소")으로 추가했다. 결정은 [ADR-031](DECISIONS.ko.md#adr-031)·[ADR-032](DECISIONS.ko.md#adr-032), 실행 방법은 [FE 안내](../frontend/README.ko.md)와 [대화 서버 안내](../server/README.ko.md)에 있다. **모두 로컬 구현이다. 실제 체인 쓰기, 실제 지갑 서명, 실제 주문 전송은 한 번도 하지 않았고 서버는 배포하지 않았다.**

- **볼트 탐색:** Factory가 만든 볼트를 indexer 없이 나열한다. Factory의 `vaultCount`와 deployer의 CREATE nonce 규칙으로 주소를 계산하고 `isVault`로 확인한다. 카드에는 생성 순번과 전체 주소·이름·운용자·단계·NAV·지분 가격·수수료·최소 입금과, 입금이 닫혀 있으면 그 이유(계약이 되돌린 오류)가 나온다. Factory 주소는 build 설정에 있으면 고정이고 화면에서 바꿀 수 없다. 설정에 없을 때만 입력란이 나오고 모든 화면에 그 사실을 표시한다.
- **볼트 만들기·입금·출금:** 이전 화면의 생성·`depositWithLimit`·`requestRedeem`·청구 흐름을 볼트별 화면으로 옮겼다. 승인은 입금액만큼만 하고, Vault에 남아 있는 USDC 승인은 금액과 함께 보여 주며 취소할 수 있다.
- **운용자 주문:** 운용자가 브라우저에서 Vault 전용 agent 키를 만들고(PBKDF2-SHA256 600,000회 + AES-GCM-256으로 암호화해 그 브라우저에만 저장) `setApiWallet`으로 등록한 뒤, 등록 범위 안의 perp·spot 시장에 지정가·Post-only·즉시 체결 주문과 취소를 서명한다. L1 action 서명(msgpack + EIP-712 Agent)은 직접 구현해 공식 Python SDK의 벡터와 대조했다. 주문 전송은 `VITE_ENABLE_TRADING`으로 따로 켜며 기본은 서명 없는 미리보기다. 암호는 12자 이상이고, 잠금 해제한 키는 10분 동안 쓰지 않으면 다시 잠기며, mid에서 1% 넘게 벗어난 지정가는 한 번 더 확인을 받는다. 주문 확인 상자는 뜬 뒤 0.7초 동안 전송 클릭을 받지 않고 30초가 지나면 무효가 된다. 취소와 reduce-only 주문은 등록 범위를 읽지 못한 상태에서도 보낼 수 있다(노출을 늘리는 주문만 범위 조회를 요구한다).
- **평가 범위:** 운용자가 등록 범위와 입금 스위치를 편집하고, 누구나 가격을 기록하며, 신고 목록을 보고 정리한다. 범위 밖 보유를 신고하는 화면은 없다.
- **대화:** Vault 주소별 대화방. 지갑의 EIP-712 서명 한 번으로 로그인하고(서버의 `CHAT_AUDIENCE`에 묶임) 12시간 토큰을 받는다. 역할(운용자·예치자·방문자)은 서버가 체인에서 읽는다. 기본 정책은 누구나 읽고 운용자·예치자만 쓰며, 운용자와 관리자 주소가 글을 숨길 수 있다. 서버는 Node 22 내장 모듈과 viem만 쓰고 메시지는 SQLite에 저장한다.
- **업그레이드된 Vault:** Vault는 업그레이드할 수 있는 proxy이고 업그레이드 뒤에도 Factory의 `isVault`가 참이다. 그래서 화면은 Vault가 스스로 답하는 asset과 controller를 믿지 않는다. 승인 대상은 Factory의 asset이고, 코드가 생성 당시와 같은지는 deployer가 그 Vault를 위해 만든 controller에 묻는다. 코드가 바뀐 Vault에는 경고를 띄우고 입금과 승인을 막으며(출금 요청과 청구는 유지), 제안된 업그레이드는 실행 가능 시각과 설치될 구현 주소를 보여 준다.
- **외부 자원:** production build에는 자기 origin의 스크립트·스타일·글꼴만 허용하고 연결은 설정한 RPC·거래소 API·대화 서버로만 허용하는 Content-Security-Policy가 들어간다. 외부 글꼴을 쓰지 않는다.
- **데모 모드:** 지갑과 네트워크 없이 예시 볼트 일곱 개로 위 흐름을 눌러 볼 수 있다. 계약 규칙을 손으로 옮긴 모형이며 Core 자금 이동은 흉내 내지 않는다.

**남은 위험과 미확인:** 컨트랙트 계정의 agent로 낸 주문이 실제로 Vault에 귀속되는지, 거래소의 응답·오류 형식과 nonce·만료 규칙의 실제 동작, builder 필드가 붙은 주문의 fee는 확인하지 못했다([MARKET-002](BACKLOG.ko.md#market-002)). agent 키는 출금은 못 하지만 거래는 할 수 있으므로, 페이지에 주입된 스크립트가 잠금 해제된 키를 쓰면 불리한 거래로 Vault 가치를 뺄 수 있다. upgrade controller가 업그레이드 횟수를 기록하지 않아, 다른 구현으로 바꿨다가 처음 구현으로 되돌린 Vault는 화면에 변경 없음으로 보인다([UPGRADE-001](BACKLOG.ko.md#upgrade-001)). 코드가 바뀐 Vault가 답하는 값 가운데 어느 것이 거짓인지는 화면이 가릴 수 없다. 화면이 보내는 RPC 요청은 mock 노드에서 센 값으로 탭마다 분당 48~64건, 목록 한 쪽을 처음 읽을 때 약 64건이다. 기본 RPC의 문서상 한도(IP당 분당 100건)가 실제로 어떻게 적용되는지는 확인하지 못했고, 운영 배포에는 자체 RPC endpoint가 필요할 수 있다. 대화 서버의 호스팅·백업·개인정보 고지·스팸 대응은 정해지지 않았다([CHAT-001](BACKLOG.ko.md#chat-001)). 키 보관 방식과 대화 정책의 세부 값은 구현자 기본값이며 사용자 확정 대기다.

## 현재 Managed USDC 요약

2026-10-04 [ADR-025/026](DECISIONS.ko.md#adr-025): `ManagedUsdcVault/Factory`에 Vault proxy=Core 계정, 고정 owner, 100 USDC 동기 창설자 지분, action 9/12/13/15/16 관리, 고유 ERC7540 요청·원가/손실/수수료·준비금, 생성 시 커스텀 성과수수료(기본10%)·최소 입금(기본10 USDC), owner의 48시간 지연·Idle 업그레이드를 구현했다. [현행 명세](managed-usdc-vault-implementation.ko.md), [메인넷 시험 코드/시나리오](managed-mainnet-scenarios.ko.md).

**이름·FE·입금 gate:** 이름 생성/owner rename, FE, Ready/Active의 검증된 NAV 동기 입금 gate를 구현했다. [FE 실행](../frontend/README.ko.md). NAV·액션·종료 검증은 위 "최신 구현"의 계약이 맡는다.

**아직 없는 것:** 통제 왕복으로 검증하고 독립 검토를 거친 verifier 배포, 실자금 Active 입금 개방, 네 시장의 통제 실거래·자산 왕복. `MockManagedVerifier`는 Vault 회계 단위 시험 전용이며 실제 Vault에 연결하지 않는다. 이전 `AsyncUsdcVault`는 별도 Strategy형 비교 구현으로 유지하고 누락된 accountedCash/직접 송금 격리를 복구했다.

메인넷 읽기 전용 사전 점검: 2026-10-04T04:43:06Z, chain999, EVM block `0x2d683f8`, USDC6 decimals, Circle/CoreWriter 코드 존재, Core block read, EVM block hash 재확인에 성공했다. [새 원시 자료](reference/managed-mainnet-preflight-2026-10-04.json). **서명·배포·입금·주문·회수·업그레이드 거래 없음.** proxy 구현 소스 대조·Core write 성공 증거로 해석하지 않는다.

문서 검증(2026-10-04 Managed 작업): 관련 Markdown 14개 파일의 로컬 파일 링크 591개, 변경 ADR/검증기/업그레이드 명시 앵커, 중복 명시 앵커와 코드 블록 균형을 점검했다(오류 0).

## 추가 mainnet precompile 관측

2026-10-04 [새 공개 관측](managed-precompile-evidence.ko.md): Standard/Unified/PM 세 공개 계정과 HIP-4 두 outcome을 읽었다. 각 자료의 EVM block hash 재확인은 성공했고 lending/encoded metadata/정산 후 잔액·가격 조회 오류는 원시 자료에 보존했다. 일부 실패 때문에 수집 도구는 exit 2를 반환했다. **오류 보존은 검증 결과이며 전체 read 성공이나 production NAV 승인이 아니다.** USDC metadata가 ERC20가 아닌 Circle CoreDepositWallet을 가리키는 점과 outcome8298의 active→settled 전환 후 잔액 조회 실패를 반영해 source와 회귀를 수정했다. 당시 source는 complete=false였다. 프로젝트 계정의 비제로 자금 왕복·HIP-4 지급 증거는 아니다.

같은 날 [raw 장부 항등식 관측](managed-precompile-evidence.ko.md#raw-ledger-identity): `scripts/equity_probe.py`로 13계정(1차)·16계정(2차)을 계정별 고정 블록에서 읽었고 모든 블록 hash 재확인에 성공했다. 2차에서 token별 API 잔액 36건은 일치 31·전후 구간 안 4·1 raw unit 차이 1, 비제로 DEX equity 20건은 모두 일치했다. Unified의 API 통합 잔액은 raw spot과 DEX별 equity의 합이었고 DEX 사이 중복은 없었다. 불일치로 분류된 3건(1차 PM USDC 1e-8 차이 2건, 2차 HLP equity의 비단조 변동 1건)은 원시 자료에 그대로 있다. **공개 계정의 읽기 전용 표본이며 생산 NAV 승인, 전체 계정 완전성 증명, 모드 전환·비USDC 담보 DEX 관측이 아니다.** 서명·자금 이동은 없다.

2026-10-04 [precompile gas 실측](managed-precompile-evidence.ko.md#precompile-gas): `scripts/precompile_gas_probe.py`가 배포하지 않는 계약의 creation code를 고정 블록의 `eth_call`로 실행해 gas 상한별 성공 여부를 읽었다(두 블록, 블록 hash 재확인 성공). 여섯 조회 모두 `1000 + 33 × (입력 + 출력)` gas에서 성공하기 시작했고 이는 문서 식의 절반쯤이다. 장부가 없는 계정의 lending 조회는 어떤 상한에서도 실패하며 전달된 gas를 전부 소모했다. Core가 모르는 계정에도 기본 DEX의 margin summary는 0으로 응답했다. **한 시점의 개별 호출 비용이며 Vault 거래 전체의 gas 실측이나 비용의 보증이 아니다.** 서명·배포·자금 이동은 없다.

2026-10-04(UTC) 감시 스크립트의 읽기 전용 실행: 공개 계정 1개에 가상의 범위(USDC·HYPE·기본 DEX)를 가정해 `scope_watch.py`를 실행했고, 그 범위 밖의 token 11개·perp DEX 1개·HyperCore vault 1개에 대한 신고 호출이 만들어졌다([자료](reference/managed-scope-watch-2026-10-04.json)). **배포된 source가 없어 계약의 판정(시뮬레이션)은 수행되지 않았고 보낼 목록은 비어 있다.** 실제 API 응답 형식에서 열거와 호출 구성이 동작한다는 확인이며, 신고가 성립한다는 증거가 아니다.

문서 검증(이번 precompile/FE 변경): Markdown 43개 파일의 로컬 링크 760개, 명시 앵커 중복·code fence 균형 오류 0.

## 이전 작업 기록

아래 날짜별 문단은 당시의 범위/검증 기록이다. 현재 Managed 기능·수치·미완료 조건은 위 요약과 이 문서의 마지막 검증 표를 우선한다.

2026-10-04 [ADR-028](DECISIONS.ko.md#adr-028) 문서 설계: 운용자 등록 목록의 완전성 신뢰, precompile의 실제 값 조회, 모드별 평가기, 현재 Core 상태 가격 정책, 입금 직전 동기 지분 발행을 채택했다. 당시에는 문서만 변경했고 source는 complete=false였다. 모드별 평가기 분리와 raw 합산식 검증 과제는 후속 [ADR-029](DECISIONS.ko.md#adr-029)의 단일 평가식 구현과 공개 계정 관측으로 대체됐다. 문서 검증(당시): Markdown 45개 파일의 로컬 링크 경로 877개, 중복 명시 앵커·코드 블록 균형 오류 0.


2026-10-04 ZPI 통제 테스트넷 환경: 저장소 밖 사용자 전용 디렉터리(`~/.local/share/zpi-testnet`, 디렉터리 700·비밀 파일 600)에 Zcash testnet 지갑과 Hyperliquid testnet 전용 EVM 키를 생성했다. Zcash 공식 `zcash-devtool` 소스 `5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8` 빌드를 사용했고, age identity로 mnemonic을 암호화했다. testnet lightwallet 서버가 `chain_name=test`를 반환했고 지갑을 동기화했다. 처음 잔액은 0 TAZ였다. 외부 커뮤니티 [fauzec](https://fauzec.com/) faucet이 shielded 주소로 1 TAZ를 송금했고, 요청 상태 `confirmed`·txid `72280714cdd5bc63b52b117ff0da5959981d05753ea5a0db8270e92f62971baa`를 반환했다. 지갑은 같은 txid를 블록 4,455,091에서 채굴된 **Ironwood 수신 note 1 TAZ**로 인식했다. tip 4,455,094에서는 총잔액 1 TAZ·지출 가능액 0이었지만, tip 4,455,104까지 재동기화 후 `balance --json`의 `ironwood_spendable=100000000` zatoshi(1 TAZ)를 확인했다. 도구의 기본 지출 가능 정책은 신뢰 note 3회·비신뢰 note 10회 확인이다. faucet에 제출한 주소는 CLI의 Orchard 수신 주소 출력이었는데 수신 기록은 Ironwood로 분류됐으므로, pool 선택·주소 인코딩은 [ZPI-002](BACKLOG.ko.md#zpi-002)에서 독립 확인한다. Hyperliquid testnet API의 새 계정 `accountValue=0.0`, `withdrawable=0.0`, 포지션 0개 조회는 읽기 전용 관측이다. 공식 mock USDC faucet은 같은 주소의 mainnet 입금 이력을 요구하므로 Core 거래 자금은 아직 없다. 비밀값·두 주소의 연결은 저장소 문서에 기록하지 않았고, 실제 주문·환전·출금은 수행하지 않았다. 이는 ZPI-002의 시작 환경이며 [ENV-001](BACKLOG.ko.md#env-001)의 Vault/Strategy 통제 환경을 충족하지 않는다.

2026-10-04 [ZPI-001](BACKLOG.ko.md#zpi-001): 현행 Vault와 분리된 [Zcash 비공개 인텐트 연구](zcash-private-intents.ko.md), Python 오프라인 회계 모형과 공동 주문 배분 모형을 추가했다. 입금·환전·Core credit·체결·전체 계정 대조·지급을 별도 mock 영수증으로 모델링하고 두 사용자, 부분 체결, 재사용, 손실·출금 잠금, 무거래 환급·epoch 동결, 정수 lot/거래비 배분을 검증했다. 공동 진입 주문의 부분 체결을 개인별 장부에 원자적으로 반영하고 출금 전 공동 잔액과 대조했다. 이번 변경의 Python 전체 회귀는 **36 tests passed**(신규 14); 별도 가중치 500개 오프라인 배분 추적에서도 최종 수량·단조 배분을 확인했다. 연구 코드에는 Zcash 지갑·서명·암호화·솔버·Hyperliquid 연결, 공동 청산 주문, 생산용 NAV가 없다. ZPI-001 당시에는 실제 입금·주문·출금을 수행하지 않았다. Solidity 코드·ABI·배포 산출물은 변경하지 않아 Solidity 테스트와 빌드 크기는 재실행하지 않았다. 출시 조건은 [ZPI-002~005](BACKLOG.ko.md#zpi-002)에 남는다.

2026-10-04 API wallet 귀속 문구 정정: Vault 전용 API wallet을 **Vault Core 계정의 agent**로 등록하고 owner는 등록·교체/키 운용을 담당한다고 다이어그램과 상세 명세에 명시했다. Vault별 agent의 실제 주문 귀속 검증은 MARKET-002의 미완료 조건이다. 문서만 수정했으며 코드 테스트·빌드·네트워크 거래는 실행하지 않았다.

2026-10-04 [ADR-023](DECISIONS.ko.md#adr-023): 운용자 신뢰형 공개 Vault의 고정 owner와 관리 함수 아키텍처를 작성했다. [상세 명세](managed-usdc-vault-architecture.ko.md)는 Factory owner 지정, API wallet/Core 자금 이동/lending/계정 모드의 onlyOwner 외부 함수, agent와 EVM 권한의 구분, owner 주도 회수와 예치자 요청/claim을 정한다. API 주문의 EVM 위험 한도 강제를 전제로 했던 목표 문구를 바로잡았다. 이번 변경은 문서만이며 실제 계약·ABI·Solidity/Python 테스트·빌드 크기·네트워크 거래에는 변경이 없다.

문서 검증(2026-10-04): 관련 Markdown 9개 파일의 로컬 링크·앵커 참조 496개, 중복 명시 앵커, 코드 블록 균형을 점검했다(오류 0). owner/API 서명자/예치자 권한과 기존 목표의 위험 제한·회수 조건을 내용상 대조했다.

2026-10-03 [ADR-022](DECISIONS.ko.md#adr-022) 설계: 창설자의 API wallet을 Vault 자신의 Core 계정에 등록해 주문에 쓰고, lending 공급·회수와 계정 추상화 전환은 Vault CoreWriter 액션으로 처리하는 권한 경계를 정했다. 공식 문서에는 agent 서명 `agentSetAbstraction`이 있지만 자유로운 모드 전환 조건은 확인되지 않았고, agent 서명 `borrowLend`는 공식 Exchange 명세에 없다. 현재 단일 주소 USDC Vault/Factory, action 9 등록, 키 관리, builder fee, 이 경로의 통제 메인넷 거래는 구현·실행되지 않았다. 이번 변경은 문서만이며 Solidity/Python 테스트·빌드 크기는 새로 실행하지 않았다.

문서 검증(2026-10-03): 이번 변경과 연결된 Markdown 7개 파일의 로컬 링크 361개·명시적/제목 앵커·코드 블록 균형을 점검했다(오류 0). 외부 출처는 공식 Hyperliquid CoreWriter·Exchange API·SDK 예시를 별도 조회했다.

2026-10-03 Circle 입금 경계 검토: 공식 `CoreDepositWallet` 인터페이스·Circle 공개 소스와 Hyperliquid EVM/Core 처리 순서를 대조했다. EVM `transferFrom`/계약 조건 실패와 후속 Core credit 확인을 분리했고, 지분 발행은 Vault의 실제 EVM USDC 수령에 근거한다는 ADR-021을 명확히 했다. Core spot 입금과 Circle 내부 CoreWriter perp 전달은 서로 다른 경로다. 배포 코드·설정 확인, 101→100 실측, 통제 네트워크 입금과 새 Solidity/Python 테스트는 수행하지 않았다.

문서 검증(2026-10-03): 관련 Markdown 5개 파일의 로컬 링크 342개·내부 앵커·코드 블록 균형을 확인했다(오류 0). 외부 출처는 Circle·Hyperliquid 공식 페이지와 Circle 공개 계약 구현을 별도 조회했다.

2026-10-03 Core action 8 의미 확인: 공식 문서상 `Finalize EVM Contract`는 Core spot 토큰과 EVM 토큰 컨트랙트 연결을 확정하는 액션이다. 제안된 Vault `finalizeActivation`과 구분했으며, Vault 생성·계정 활성화·Circle USDC 입금에 action 8을 쓰지 않는 설계를 명시했다. 문서만 수정했고 코드·ABI·배포·통제 네트워크 거래 및 Solidity/Python 테스트는 실행하지 않았다.

문서 검증(2026-10-03): 관련 Markdown 5개 파일의 로컬 링크 342개·내부 앵커·코드 블록 균형을 확인했다(오류 0). 외부 출처는 공식 활성화·토큰 연결·Circle 입금 페이지를 별도 조회했다.

2026-10-03 Core 활성화/가스 문서 정정: 첫 Core USDC 수신의 1 quote-token 비용과 각 HyperEVM 거래 제출자의 HYPE 가스를 구분했다. 생성 거래에서 Core를 활성화하더라도 같은 EVM 블록의 CoreWriter 액션은 거부된다는 공식 처리 순서를 반영했다. 단일 주소 USDC Vault·공개 Factory는 여전히 구현되지 않았으며, 실제 입금 gross→net과 Core→EVM 회수 비용은 통제 실험 전 미확정이다. 이번 변경은 문서만 수정했고 Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 실행하지 않았다.

문서 검증(2026-10-03): 이번 변경의 Markdown 5개 파일에서 로컬 링크 342개·내부 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL은 공식 문서의 관련 페이지를 별도 조회했다.

2026-10-02에 [Vault 아키텍처 기준선](vault-architecture.ko.md)을 작성해 구성 요소·신뢰 경계·회계 불변조건·단계별 기능·실측 차단 조건을 연결했다. **문서 작업이며 코드·ABI·배포·기존 테스트 결과는 변경하지 않았다.** CORE/NAV/보안/운영의 미완료 조건은 그대로다.

같은 날 후속 상품의 **HyperEVM Circle native USDC 입출금·USDC 지분**을 [ADR-010](DECISIONS.ko.md#adr-010)의 목표로 정했다. Vault에서 `CoreDepositWallet.depositFor`로 Strategy Core 계정에 USDC를 배정하는 설계이며 양방향 계약 실험은 [USDC-001](BACKLOG.ko.md#usdc-001), 새 계약 구현은 [USDC-002](BACKLOG.ko.md#usdc-002)에 남겼다. 당시 코드는 WHYPE 전용이었다. 후속 USDC Vault의 현재 부분 구현은 아래 기록을 따른다.

문서 검증(2026-10-02): 아키텍처·SSOT·현행 명세·상태·백로그·변경 이력의 로컬 링크와 명시적 앵커, 코드 블록 균형을 점검했다. USDC 경로를 추가한 뒤 관련 문서 링크·결정 상태를 다시 점검했다. Solidity/Python 테스트·새 네트워크 관측은 실행하지 않았다.

2026-10-03 [ADR-011](DECISIONS.ko.md#adr-011): 새 USDC Vault의 핵심 제품 범위를 spot·HIP-3·HIP-4(기본 perp 포함) 거래로 확정했다. 기존 기본 HyperCore Vault의 perp-only 제약과 다른 별도 EVM Vault/Strategy 계정 모델이다. 현재 코드는 이 시장별 주문·NAV·회수와 agent wallet·builder fee를 지원하지 않는다. [MARKET-001/002](BACKLOG.ko.md#market-001)에 남겼다. 공식 문서 확인과 설계 변경만 수행했고 새 거래·코드 테스트는 실행하지 않았다.

문서 검증(2026-10-03): 수정된 진입·설계·상태·백로그·기획·변경 이력 17개 Markdown 파일의 로컬 링크·내부 앵커·중복 명시 앵커·코드 블록 균형을 확인했다(오류 0). Solidity/Python 테스트와 네트워크 거래는 재실행하지 않았다.

2026-10-03 문서 정정: USDC 이동의 `depositFor` 호출 자체에는 사전 승인/확인 단계가 없고, Core 잔액 관측은 후속 Core 거래의 실행 조건임을 분명히 했다. 코드·ABI·네트워크 관측은 변경하지 않았다.

2026-10-03 [ADR-012](DECISIONS.ko.md#adr-012): 새 USDC 상품의 후보 표준을 stable OZ ERC4626 + ERC7540 동기 입금/비동기 출금으로 정리했다. Community ERC7540은 현재 의존성이 아니며, 다중 거래 시장은 다중 입금 자산을 뜻하지 않는다. 첫 배포 후보는 목표 운용 buffer 0과 전량 회수 후 epoch claim을 허용하되 확정 claim 준비금은 필수로 격리한다. 시장별 현금화 가능성, HIP-4 만기/대기, 실제 USDC 회수는 미검증이다. 문서·공식 표준/라이브러리 조사만 수행했고 새 코드·ABI·네트워크 실험·Solidity/Python 테스트는 없다.

문서 검증(2026-10-03): 이번 표준·유동성 판단을 반영한 Markdown 10개 파일의 로컬 링크·명시적/제목 앵커·코드 블록 균형을 점검했다(오류 0). 코드 테스트와 빌드 크기 검사는 재실행하지 않았다.

2026-10-03 **USDC-002 부분 구현:** [AsyncUsdcVault](../src/AsyncUsdcVault.sol)에 6자리 USDC 동기 입금·9자리 ERC4626 지분, ERC7540 비동기 출금·epoch 준비금, 한도/기한 보호 입금, 정확한 `CoreDepositWallet.depositFor` EVM 차감·allowance 초기화, 실제 USDC 반환액 기반 정산을 추가했다. [EpochRedeem](../src/vault/EpochRedeem.sol)의 이름/심볼 생성자를 일반화했으며 기존 WHYPE 지분 이름·ABI는 유지했다. [IUsdcCycleStrategy](../src/interfaces/IUsdcCycleStrategy.sol)는 `returnReady`/반환 신뢰 경계의 **인터페이스**이고 test mock 외 생산용 구현은 없다. 시장별 Core 거래·NAV·terminal 증명, USDC CoreWriter 회수, 통제 네트워크 왕복, 새 Factory는 미완료다. [현행 USDC 명세](usdc-vault-implementation.ko.md)

2026-10-03 **USDC 직접 송금 방어 보강:** Vault의 USDC 실제 잔액과 주주 장부 `accountedCash`를 분리했다. 직접 송금된 USDC는 가격·입금 한도·Core 배정·epoch 청구액에 들어가지 않으며 `unaccountedUsdc`로만 보인다. 장부 결손은 중단한다. Core/Strategy 계정으로 들어오는 외부 USDC·임의 토큰을 구분하는 생산용 구현은 여전히 없다. [ADR-013](DECISIONS.ko.md#adr-013), [USDC 명세](usdc-vault-implementation.ko.md)

2026-10-03 **공개 USDC Factory 목표:** [ADR-014](DECISIONS.ko.md#adr-014)에 따라 누구나 새 USDC Vault를 생성하고 Vault 주소 자체를 Core 계정으로 쓰는 목표를 채택했다. 활성화 경로는 [ADR-015](DECISIONS.ko.md#adr-015)로 정정했다. 창설자가 운용자가 되고 Core USDC를 Vault Core 주소로 직접 보내며, 다른 사용자가 HyperEVM USDC를 예치한다. Factory는 창설자 Core 자금을 인출하지 않는다. 창설자 전송과 후속 Core `userExists`/실수령·비용 확인을 나눈다. 당시 활성화 수신액을 주주 자금과 분리했던 회계는 후속 [ADR-019](DECISIONS.ko.md#adr-019)의 최초 Core100 지분 인식으로 대체됐다. 현행 `AsyncUsdcVault`는 여전히 별도 Strategy를 사용하고 USDC 공개 Factory·단일 주소 운용·activation gate는 없다. 이번 목표 변경을 위한 Solidity/Python 테스트나 네트워크 write를 실행하지 않았다. [FACTORY-001](BACKLOG.ko.md#factory-001)

문서 검증(2026-10-03): 공개 Factory·단일 주소 목표를 반영한 Markdown 9개 파일의 로컬 링크·명시적 ADR/작업/절 앵커·코드 블록 균형을 점검했다(오류 0). 외부 URL의 실제 네트워크 내용은 이 검사의 대상이 아니다.

문서 검증(2026-10-03): 이번 변경 관련 Markdown 7개 파일의 로컬 링크·ADR 앵커·코드 블록 균형을 점검했다(오류 0). 이 검사는 외부 URL 내용이나 자동 생성 제목 앵커 전체의 유효성 검증은 아니다.

2026-10-03 [ADR-015](DECISIONS.ko.md#adr-015): 창설자 운용 모델과 창설자 Core USDC 활성화를 설계에 반영했다. Factory EVM 생성과 창설자 Core 송금은 별도 단계다. 공식 CoreWriter·Core 전송·활성화 수수료 문서를 확인했으며 EOA 직접 CoreWriter, 자금 왕복 또는 네트워크 전송을 실험한 기록은 아니다. 코드·ABI·배포·기존 테스트 수/크기는 변경하지 않았다. 문서 링크·앵커·내용 검증 결과는 아래 작업 기록을 따른다.

문서 검증(2026-10-03): 이번 결정 정정과 연결된 Markdown 9개 파일의 로컬 링크·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 내용은 공식 문서의 별도 조회로 확인했고, Solidity/Python 테스트·빌드 크기 검사·네트워크 write는 이번 문서 변경에서 재실행하지 않았다.

2026-10-03 [ADR-016](DECISIONS.ko.md#adr-016): 새 공개 USDC 운용자 Vault의 다른 사용자 출금 이익 10% 성과 수수료를 목표 설계에 추가했다. [수수료 원장](performance-fee-architecture.ko.md)은 사용자별 USDC 원가·손실 이월·요청별 고유 ID·총 권리 준비금·Claim 시 사용자/운용자/플랫폼 분할을 정한다. 플랫폼 배분은 후속 [ADR-017](DECISIONS.ko.md#adr-017)을 따른다. 현행 `AsyncUsdcVault`/`EpochRedeem`에는 수수료나 요청별 원가가 없고 같은 epoch의 요청 ID를 공유한다. 이번 작업은 문서 변경이며 코드·ABI·배포·기존 검증 수치가 바뀌지 않았다. 공식 ERC-4626/7540 문서를 대조했지만 새 Solidity/Python 테스트·빌드 크기 검사·네트워크 write는 실행하지 않았다. 문서 링크·앵커 검증 결과는 아래 기록을 따른다.

문서 검증(2026-10-03): 성과 수수료 설계와 연결된 Markdown 14개 파일의 로컬 링크·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 전체에 대한 자동 링크 검사는 수행하지 않았다.

2026-10-03 [ADR-017](DECISIONS.ko.md#adr-017): 새 USDC Vault의 총 성과 수수료율 10%는 유지하고, 그 수수료의 20%를 플랫폼·80%를 창설자/운용자에게 배분하는 목표를 채택했다. Claim의 사용자 순수령액은 바뀌지 않는다. 현행 코드에는 fee 계산·플랫폼 Treasury·삼자 분할이 없다. 이번 설계 변경은 문서만 수정했고 코드·ABI·배포·기존 테스트 수/크기는 변경하지 않았다.

2026-10-03 [ADR-018](DECISIONS.ko.md#adr-018): 당시 새 USDC Vault 생성 거래에서 창설자가 HyperEVM USDC 100을 자기자본으로 납입하고 share를 받는 목표를 채택했다. 이 EVM 선납·별도 Core seed 경로는 후속 [ADR-019](DECISIONS.ko.md#adr-019)로 대체됐다. [FACTORY-001](BACKLOG.ko.md#factory-001)의 생성·창설자 자본·활성화 게이트는 아직 코드에 없다. 당시 통제된 Core→EVM 전송과 Factory 생성 거래를 실행한 기록은 없다. 문서 변경이며 코드·ABI·배포·기존 테스트 수/크기는 변경하지 않았다.

2026-10-03 창설자 자본/활성화 비용 정리: 공식 활성화 비용은 새 Core 계정 첫 수신 거래의 1 quote token이다. [OpenZeppelin의 연동 감사](https://www.openzeppelin.com/news/sponsored-periphery-audit)는 Core 송금 활성화 수수료가 송금인 잔액에서 전송액과 별도로 차감된다고 설명한다. 이 공개 감사 근거와 별개로 우리 Core 서명 전송의 실제 송금자/수령자 잔액은 통제 거래로 검증하지 않았다. 당시 EVM 자기자본 100·별도 Core seed 경로는 [ADR-019](DECISIONS.ko.md#adr-019)로 대체됐다. legacy HyperCore Vault는 최소 100 USDC 입금과 별도 100 USDC 생성 fee, 운용 중 창설자 지분 5% 이상 유지, 종료 시 포지션 청산을 공식 문서에 명시한다. 새 상품의 창설자 출금 제한은 [OPEN-09](plans/README.md#정책-결정-등록부)에 제안으로만 기록했고 코드·ABI·검증 수치는 바꾸지 않았다.

문서 검증(2026-10-03): 이번 정정 관련 Markdown 8개 파일의 로컬 링크 417개·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 검사했다(오류 0). 외부 URL 전체의 자동 검사, Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 실행하지 않았다.

문서 검증(2026-10-03): Core 활성화 수수료 차감 주체를 보강한 Markdown 6개 파일의 로컬 링크 354개·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 검사했다(오류 0). 코드·ABI 변경과 새 Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 없다.

2026-10-03 [ADR-019](DECISIONS.ko.md#adr-019): 사용자의 설계 정정에 따라 최초 Vault Core 주소에 실수령된 USDC 100을 창설자 지분으로 1회 인정하는 목표로 변경했다. 당시 첫 경로였던 배포 후 별도 Core 송금은 후속 [ADR-020](DECISIONS.ko.md#adr-020)에서 대체 경로로 이동했다. Core 잔액 조회는 송금자 신원을 증명하지 못하므로 Core-only 대체 경로의 제3자 후원도 등록된 창설자 지분으로 귀속한다. 현행 코드에 Core bootstrap share 발행·Factory activation gate는 없다. 새 Solidity/Python 테스트·빌드 크기 검사·통제 네트워크 거래를 수행하지 않았고 코드·ABI·배포·기존 수치는 변경하지 않았다.

2026-10-03 [ADR-020](DECISIONS.ko.md#adr-020): 당시 첫 공개 생성 경로를 생성 거래 내 창설자 HyperEVM USDC 이체와 새 Vault의 `CoreDepositWallet.deposit` 호출로 변경했다. 당시에는 창설자 Core100 최종 실수령 후에만 1회성 share를 발행하기로 했으나 이 발행 시점은 후속 [ADR-021](DECISIONS.ko.md#adr-021)로 대체됐다. Circle 공식 인터페이스는 Vault 호출자의 Core 계정 배정을 지원하지만, 101 EVM gross→100 Core net과 신규 계정 활성화의 정확한 비용 경로는 통제 거래로 검증하지 않았다. 이 변경은 문서 설계이며 Factory·단일 주소 Vault·비동기 복구 코드는 없고 ABI·기존 검증 수치도 바뀌지 않았다. 새 Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 실행하지 않았다.

문서 검증(2026-10-03): ADR-020 생성 시 납입 설계와 연결된 Markdown 12개 파일의 로컬 링크 519개·명시적/제목 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 전체의 자동 검사, Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 이번 문서 변경에서 실행하지 않았다.

2026-10-03 이전 창설자 지분 확정 절차 명시(후속 [ADR-021](DECISIONS.ko.md#adr-021)로 대체): 후속 EVM 블록에서 누구나 호출하는 `finalizeFounderFunding()`이 Vault 내부 Core read precompile로 `l1Block`·`userExists`·USDC spot 잔액을 확인하고, 조건 충족 시 저장된 창설자에게 초기 100 share를 한 번 발행하는 목표를 ADR-020·Factory 설계·FACTORY-001에 구체화했다. 호출자 제공 잔액이나 서명 없는 keeper 보고를 발행 근거로 삼지 않는다. Core 잔액으로 특정 Circle 입금의 출처를 증명하지 못한다는 한계는 유지한다. 이는 문서 설계이며 함수·Factory·단일 주소 Vault 코드는 아직 없고 이번 단계에서 Solidity/Python 테스트·빌드 크기 검사·네트워크 거래를 실행하지 않았다.

문서 검증(2026-10-03): 이 확정 절차를 수정한 Markdown 5개 파일의 로컬 링크 323개·명시적/제목 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 전체의 자동 검사는 수행하지 않았다.

2026-10-03 [ADR-021](DECISIONS.ko.md#adr-021): 첫 창설자 지분은 Vault가 실제 받은 EVM USDC 원금 100에 대해 생성 거래에서 발행하고, Core 확인은 지분 발행이 아닌 운용·공개 입금의 개방 조건으로 바꿨다. 일반 사용자도 EVM Vault 함수에서만 지분을 받고, Core 보유자는 동일 주소 EVM으로 먼저 출금한다. Vault Core 직접 송금은 지분으로 인정하지 않는다. 이전 ADR-019/020과 `finalizeFounderFunding()` 문단은 당시 설계 기록으로 남겨 대체 관계를 표시했다. Circle의 동일 주소 출금과 Hyperliquid의 EVM/Core 처리 순서를 공식 문서에서 확인했다. 이번 변경은 설계 문서만 수정했고 새 Factory·단일 주소 Vault 코드, ABI, 배포, 기존 테스트 수/크기는 변경하지 않았다. Solidity/Python 테스트·빌드 크기 검사·통제 네트워크 거래는 실행하지 않았다.

문서 검증(2026-10-03): ADR-021과 연결된 Markdown 12개 파일의 로컬 링크 531개·명시적/제목 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 전체의 자동 링크 검사는 수행하지 않았다.

문서 검증(2026-10-03): ADR-019 경로로 수정한 Markdown 13개 파일의 로컬 링크 514개·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 검사했다(오류 0). 외부 URL 전체의 자동 검사는 수행하지 않았다.

문서 검증(2026-10-03): ADR-017/018과 연결된 Markdown 14개 파일의 로컬 링크 493개·명시적/제목 앵커·중복 명시 앵커·코드 블록 균형을 확인했다(오류 0). 외부 URL 전체의 자동 검사는 수행하지 않았다. 이번 문서 변경에 대해 Solidity/Python 테스트·빌드 크기 검사·네트워크 거래는 실행하지 않았다.

## 작업 환경과 배포 상태

| 항목 | 확인된 상태 |
| --- | --- |
| 프로젝트 경로 | 저장소 루트 |
| Git | 2026-09-23 재확인 시 Git 저장소 아님. 추적 가능한 commit/tag/remote 없음 |
| 도구·의존성 | Solidity 0.8.28, Foundry, OpenZeppelin Contracts 5.4.0 |
| 빌드 설정 | `via_ir=true`, optimizer 1 run, EVM `cancun`; [foundry.toml](../foundry.toml) |
| 릴리스 | 미릴리스. package.json의 private 패키지 버전은 배포·릴리스 증거가 아님 |
| 배포 스크립트 | 기존 DeployPair는 31337만 허용. [DeployManagedVault](../script/DeployManagedVault.s.sol)는 chain999와 먼저 배포한 verifier 주소/codehash 설정 필요. source·verifier 배포 명령은 [시나리오](managed-mainnet-scenarios.ko.md)에만 있고 실행하지 않음; 미배포 |
| 네트워크 작업 | 2026-10-04 새 메인넷 read-only preflight. 배포·서명·주문·자금 이동 없음 |
| 통제 가능한 운용 환경 | 프로젝트 소유 테스트넷 Strategy 주소·배포 정보·서명 설정이 제공되지 않음 |
| 표준·보안 검토 | [표준 대조·재현 검토](standards-review.ko.md) 수행. maxDeposit 불일치와 0 share 전송 거부 수정·회귀 검증 완료. 양수 직접 전송 제약 유지. 전체 적합성 검토·독립 외부 감사 미완료 |

## 구현 범위

Managed 행 이외의 기존 HYPE/분리 Strategy 기능은 새 owner 수동 운용 상품과 별개다.

| 영역 | 구현된 동작 | 검증 범위와 제한 |
| --- | --- | --- |
| 지분·출금 회계 | OZ ERC4626/ERC20 기반 지분, ERC7540 요청·operator·epoch·부분 claim, 준비금 격리 | 로컬 단위·fuzz·invariant. 세부 ABI·수식은 [구현 명세](split-implementation.ko.md) |
| Managed USDC | 단일 proxy/Core 계정·owner 관리·커스텀 조건·수수료·upgrade | mock 회귀; 통제 시장 거래 없음. [현행 명세](managed-usdc-vault-implementation.ko.md) |
| Managed NAV·검증기 | Vault별 등록 범위의 precompile 평가, 운용 중 동기 발행 가격, 액션 최종성, 종료 flat 검사 | precompile 응답 주입 단위·종단 시험과 공개 계정 관측. 통제 왕복·독립 검토·배포 없음. [명세](managed-precompile-nav.ko.md) |
| 이전 USDC Vault 로컬 구현 | 별도 USDC ERC7540 지분·입금·epoch claim, `depositFor` 호출과 EVM 차감 확인, 준비금 및 직접 USDC 송금 격리 | 이전 구현 mock 12개 시험. 별도 Strategy의 실제 Core credit/회수 구현은 없음. [명세](usdc-vault-implementation.ko.md) |
| 입금 | WHYPE, Router를 통한 native HYPE; 완전 Idle에서만 deposit/mint | Active 입금과 async deposit 미구현 |
| 계정·운용 | immutable Vault / Strategy 연결, Strategy 주소가 CoreWriter 호출. API wallet 미사용 | bridge→PM→supply→short 상태 머신은 mock 검증. 실제 PM 전환과 공급 전이는 미검증 |
| 초기 공급 검사 | 첫 explicit supply 직전 HYPE lending supply/borrow 비제로이면 거부. read 실패 전파 | 초기 baseline 변화 뒤 추가 전액 공급 제출 차단. 자동 공급 지원·귀속 판정은 아님 |
| 회수 | 조건 충족 시 누구나 exit/advance/recap/settle 진행, 고정 beneficiary adapter로 제3자 지급 실행 | 미확정 action과 잔여 자산으로 멈출 수 있음. 실네트워크 최종 지급 가능성 미검증 |
| 액션 관측 | 식별자·pending·방향/수량 효과 관측, 독립 `syncPendingAction`, recall 수신 기록 분리 | 효과는 cloid별 확정 receipt가 아님. reject/zero-fill 자동 복구 미완성 |
| 기본 NAV | Active는 `CapitalEstimate`, 회수/Idle은 실현 잔액 | Active 값은 현재 공정 가치나 신규 지분 발행 가격이 아님 |
| 선택형 NAV | `PortfolioNavReader` / `PortfolioNavMath`, 범위·cycle·시점 검증 | mock source로 계산 검증. 생산용 `IStrategyBalanceSheet` 구현체 없음 |
| raw 계정 조회 | `HyperCoreAccountReader`, 고정 블록 probe와 오프라인 대조 | raw reader는 NAV source가 아니며 기본 배포에 연결하지 않음 |
| 수량 정규화 | raw position size lots → CoreWriter 1e8, SafeCast 범위 검사 | 비제로 PM 표본과 회귀 테스트. `orderSizeLot`와 실제 시장 metadata의 일치는 별도 설정 검증 필요 |
| 배포 구성 | atomic Factory, 두 deployer, 불변 생성 코드 조각 | 로컬 생성·연결·코드 복원 검증. 라이브 배포 설정 아님 |
| legacy | `HyperCoreVault`와 테스트 유지, position 단위 수정 반영 | 회귀 비교용이며 새 배포 경로 아님 |

## 최근 실측과 미검증 경계

[2026-09-21 PM 실측](pm-nav-evidence.ko.md)은 raw szi 단위 오류, API 통합 spot과 raw spot의 차이, 일부 lending read 실패를 확인했다. HYPE carry 한 표본에서 lending net과 기본 DEX accountValue로 재구성한 잔액이 API와 맞았다. 전체 계정 NAV나 PM 전환 성공의 증명은 아니다.

공개 계정의 정적 잔액으로는 PM 활성화 직후의 자동 공급 순서를 알 수 없다. HTTP 응답은 동일 블록에 고정되지 않는다. 조회 실패는 0으로 취급하지 않으며, snapshot의 `productionNavReady`와 `activeDepositsAuthorized`는 false다. [원시 자료 출처](reference/README.md)

2026-09-23 [PM 생명주기 모형](pm-lifecycle-model.ko.md)에서는 자동 공급으로 raw spot이 감소하면 진행 및 deadline/pause 이후 회수가 막히는 조건을 재현했다. 외부 raw spot 보충 뒤 전액 공급을 추가 제출하는 경로는 초기 lending 검사로 차단했다. 이 모형의 잔액 전환은 직접 주입한 가정이며 실제 네트워크 동작이나 출금 성공을 입증하지 않는다.

## 마지막 코드 검증

2026-10-11 자산별 Vault 변경 후 아래 검증을 실행했다. Solidity와 Python은 Core 효과를 주입한 모형이며 메인넷 사실과 구분한다. 새 mainnet 조회는 metadata 및 kHYPE oracle 설정 범위다. Python·storage gate는 직전 같은 날 결과를 유지하며 이번 직접 배포/FE 변경에서는 재실행하지 않았다. 서버 코드는 변경하지 않았고 서버 단독 gate는 2026-10-06 결과를 유지한다.

| 명령 | 마지막 결과 |
| --- | --- |
| `forge fmt --check` | 통과 |
| `forge test --offline` | 25 suites, 314 passed, 0 failed, 0 skipped |
| 이전 AsyncUsdcVault / Managed Vault(mock verifier) 집중 시험 | 각각 12 / 38 passed |
| precompile NAV 단위 / 실제 Vault 종단 / gas 모형 시험 | 58 / 30 / 4 passed (위 전체 결과에 포함) |
| 자산별 Vault / 실제 source+asset verifier 집중 시험 (전체 포함) | 17 / 6 passed |
| 신규 asset storage baseline→현행→V2 fixture | 33개 기존 필드 재귀 호환 검사 통과 |
| stateful invariant (위 실행에 포함) | 256 runs, 128,000 calls, 0 reverts |
| `python3 -m unittest discover -s test/python -v` | 84 passed (이전 82 + asset metadata preflight 2; 저장된 공개 관측 회귀 포함) |
| `forge build --offline --sizes` | 성공, 크기 제한 검사 통과 |
| `bash scripts/test_managed.sh` | 전체 gate exit 0; baseline의 기존 storage 31개 보존 및 현행→V2의 32개 필드 재귀 호환 검사 통과 |
| `bash scripts/test_frontend.sh` | ABI drift 없음, format·typecheck·production build와 built page의 정책 검사 통과, unit 125 passed |
| `bash scripts/test_server.sh` (2026-10-06, 이번 변경에서 재실행하지 않음) | format·typecheck 통과, unit 144 passed (stub 체인, loopback의 가짜 노드, 메모리 DB) |

직접 Vault 변경 후 로그: `/tmp/direct-all-tests.log`(전체 Solidity), `/tmp/direct-sizes-final.log`(bootstrap script 포함 빌드 크기), `/tmp/direct-fe-gate.log`(FE 전체 gate). 직접 owner 초기화 권한·세 자산 발행·중복 거부·활성화 실패 롤백 시험 2개와 manifest 시험 2개를 추가했다. production Vault/storage 코드는 바꾸지 않아 Python·storage 전체 gate는 직전 결과를 유지한다.

직전 자산별 구현 로그: `/tmp/asset-managed-gate.log`(새 upgrade fixture 추가 전 전체 gate exit 0), `/tmp/asset-forge-final.log`(추가 fixture 포함 최종 전체 312 passed), `/tmp/asset-build-verified.log`(최종 크기), `/tmp/asset-fe-gate.log`(FE 전체 gate). 신규 asset storage baseline과 V2 fixture의 추가 검사를 독립 실행하고 공통 gate에도 추가했다. FE 첫 실행의 localhost `listen EPERM`은 sandbox 제한이었으며 localhost 사용 권한으로 재실행해 통과했다. 중간 실패 테스트에는 reserve precompile fixture 주소와 Foundry expectRevert 사용 오류가 있었고 수정 후 위 전체 결과를 확인했다.

직접 Vault 브라우저 확인: 별도 agent-browser 세션에서 `#/assets`와 이전 `#/create` URL 모두 기본 직접 Vault 화면을 표시하고 생성 메뉴가 없음을 확인했다. 아직 배포 목록이 비어 있어 입출금은 비활성이다. 캡처 `/tmp/direct-vault-ui.png`; 실지갑·배포 Vault 연동 증거가 아니다.

직전 브라우저 확인: `agent-browser` 별도 세션에서 서명 없는 페이지 로드와 가짜 eth_call 응답으로 세 자산 선택·기본 원금/최소 입금 단위를 확인했다. 실제 Factory나 지갑 거래 연결 테스트가 아니다. 캡처는 `/tmp/asset-vault-ubtc-ui.png`, `/tmp/asset-vault-hype-ui.png`이며 예시 금액은 mock이다.

신규 계약의 최종 runtime / initcode 크기(bytes):

| 계약 | Runtime | Initcode (constructor 인자 제외) |
| --- | ---: | ---: |
| DeployManagedAssetVault (배포 script) | 12,814 | 12,840 |
| BootstrapManagedAssetVault (운영 script) | 4,400 | 4,426 |
| ManagedAssetVault | 24,102 | 27,353 |
| ManagedAssetVaultV2Fixture | 24,241 | 27,492 |
| ManagedAssetVaultFactory | 5,556 | 45,693 |
| ManagedAssetDeployer | 10,328 | 38,438 |
| ManagedAssetBridge | 5,651 | 8,267 |
| ManagedAssetNavVerifier | 8,810 | 9,542 |

Vault runtime 여유는 474 bytes다. Factory의 3개 template constructor 인자를 포함한 실제 생성은 로컬 테스트에서 수행했다. 새 verifier의 최대 scope mint gas는 별도 측정이 남아 있으며 기존 USDC gas 상한을 그대로 주장하지 않는다.

precompile NAV 단위 시험은 평가식·단위와 USDC 장부 합산 fuzz, 나누어떨어지지 않는 값의 내림·올림, 공개 계정 raw 값 fixture(Unified·PM), 등록 권한·정렬·상한·metadata 대조, 보유 항목 제거 거부와 팔 수 없는 잔량의 제외, 집계하지 않는 lending 장부 거부와 대조 조회(길이 확인, 응답한 장부 확인의 대체), 조회 실패·비정상 응답, 가격 가드의 경계값(spread 1%, oracle 2%), 팔 수 없는 보유가 종료를 막지 않는 조건, 입금 스위치, 음의 DEX equity와 음의 Core 순자산, 신고의 성립·재확인·갱신·소멸·한 건 제한(token·차입·공급·quote 경유의 두 단계 최소 금액·DEX·HyperCore vault)과 한순간의 증명이 Vault를 계속 닫지 못하는 것, 성립하는 신고가 다른 증명에 자리를 내주지 않는 것과 재신고가 보관된 증명 경로를 바꾸지 않는 것, 신고된 대상의 등록이 신고를 지우고 가격 이력을 다시 시작하는 것(다른 대상의 등록은 신고와 이력을 그대로 둠), 등록된 token이 종료 평가에 잡히지 않는 동안의 신고와 잡히는 순간의 해소(등록된 pair의 주문 최소 금액 경계와 다른 pair의 두 배 경계, 차입, 공급, USDC), 스스로 풀린 신고는 범위 변경으로 지워질 뿐 이력을 다시 시작하지 않는 것, 종류·index·vault 주소가 모두 같아야 재신고로 보는 것, 한도와 정확히 같은 가격의 발행 허용, 가격 기록의 간격·대체·창·절반 창 요건과 급락 한도의 경계값, 입금 스위치·신고·pending 액션이 가격 기록을 멈추지 못하는 것, Idle의 현금 기준 기록, 종료 정산의 급락 대기와 지분 없는 종료의 예외, 지분이 없을 때의 기록 거부, dust 상한의 범위, 이벤트 내용, pending 결속·Core 블록 조건, 회수 도착·owner 포기 선언·선언부터의 대기·부분 편입, 종료 조건, 생성자 범위를 검사한다. 종단 시험은 실제 Factory·Vault로 활성화→범위 등록→가격 기록→운용 중 `deposit`·`mint`·`depositWithLimit`→Core 배정→손익→spot 보유의 가격 반영과 가격 가드→평가 불가 상태의 모든 입금 경로 차단(같은 경로가 열린 Vault에서는 통과함을 대조)→범위 밖으로 옮긴 가치의 급락 대기와 신고→가치를 잠깐씩만 빼며 낮은 가격을 기록하는 시도의 무력화→미끼 신고를 등록으로 풀어도 입금이 열리지 않는 것→미끼 신고 뒤에서 숨긴 token을 매수호가 없는 pair로 등록해도, 빈 상태로 등록해 둔 token에 가치를 나중에 옮겨 넣어도 그 token을 신고할 수 있어 종료가 정산되지 않는 것→처리되지 않는 회수가 걸린 동안의 가격 기록→범위 밖 가치를 남긴 종료의 대기와 신고 뒤 정산→기록이 끊긴 Vault의 종료가 기록을 기다리는 것→회수·거절된 회수의 포기·부족·늦은 도착→agent 등록·해지→종료 정산→청구, 전액 상환 뒤의 재개, 종료 중 제3자가 보낸 token이 정산을 막지 않는 것, 같은 source·verifier를 쓰는 두 Vault의 격리를 실행한다. 신고가 없으면 급락 대기가 지나 낮은 가격으로 발행이 재개되고 종료도 정산된다는 한계도 종단 시험이 그대로 고정한다(`testWithoutAReportTheDrawdownPauseOnlyBuysTime`·`testWithoutAReportTheExitPauseOnlyBuysTime`). 닫지 못한 다른 한계도 같은 방식으로 고정했다: 신고된 대상을 비운 첫 블록의 순서 경쟁(`testEmptyingTheReportedVenueIsARaceTheWatcherHasToWin`), 가격이 거부된 등록 token이 기록과 종료를 멈추는 것(`testARefusedPriceStopsTheRecordsUntilTheOwnerDropsTheToken`), 팔 수 없는 잔량이 작은 Vault의 정산을 미루는 것(`testAnUnsellableRemainderDelaysASmallExitUntilItLeavesTheScope`). Managed Vault 시험에는 FE의 볼트 목록이 쓰는 주소 규칙(deployer nonce)을 고정하는 시험 1건을 추가했다.

gas 모형 시험은 precompile 자리에 비용식을 따르는 stub을 넣는다(오류 시 전달된 gas 전량 소모). 최대 범위·가장 비싼 경로에, 더는 성립하지 않지만 평가마다 다시 읽히는 신고 한 건(가장 비싼 형태인, quote token을 거쳐 신고된 등록 token)을 더한 상태에서 [공식 비용식](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)(`2000 + 65 × (입력 + 출력)`)으로 평가 1회 625,637, `deposit` 1,426,925, `mint` 2,602,132 gas였고, 실측에 맞는 식(`1000 + 33 × (입력 + 출력)`)으로는 427,987·1,031,626·1,811,531이었다. 소형 블록 한도는 3M이다. 집계하지 않는 lending 장부가 있는 평가는 gas 한도를 1,000~150,000 구간에서 97 단위로, 올바른 거부가 처음 나오는 경계 아래 6,000 구간에서는 1 단위로 조여도 값을 반환하지 못했고, 범위 변경도 300,000까지 311 단위로 조였을 때 그 token을 내보내지 못했다. **이 수치는 모형 측정이며 Vault 거래의 네트워크 실측이 아니다.** 모형은 측정 전에 같은 주소·slot을 읽어 두므로 첫 접근 비용이 거의 반영되지 않는다.

변이 검사(2026-10-05, 최종 코드): source와 verifier에 손으로 고른 변이 145개(조건 제거·경계 변경·이벤트 제거·순서 변경)를 별도 사본에서 하나씩 적용해 NAV 시험 세 파일을 실행했다. 142개가 시험 실패로 검출됐고 3개가 통과했다. 통과한 것 가운데 2개(재신고 때의 이벤트 누락, 대상을 등록하지 않는 범위 변경이 낡은 신고를 지우는 것)는 시험이 없던 것이어서 검사를 추가했고, 추가한 뒤 그 두 변이를 다시 실행해 검출을 확인했다. 남은 1개는 lending 장부 확인 뒤의 남은 gas 검사 줄을 지우는 변이다. 그 줄이 없어도 gas를 조인 호출은 뒤따르는 조회나 저장을 마칠 gas가 없어 값을 내지 못하므로 지금 구조에서는 결과가 같다. 뒤따르는 조회의 순서가 바뀌어도 성립하도록 남겨 둔 방어이며 시험으로 고정돼 있지 않다. 리뷰어들이 회차마다 보고한 생존 변이에는 시험을 추가했고, 그 가운데 이 목록에 넣은 것은 모두 검출됐다(리뷰어의 변이 전부를 이 목록으로 다시 실행한 것은 아니다). 변이 목록은 임시 스크립트였고 저장소에 넣지 않았다. 고른 변이에 대한 결과이며 시험의 완전성 증명이 아니다.

USDC mock 12개는 단위·표준 인터페이스, Circle 호출 형식의 정확한 차감, 두 사용자 동일 epoch 손실 배분, 준비금 재배정 차단, 미수신/잘못된 반환값, 전손 뒤 신규 입금 차단, slippage 보호, guardian pause/exit과 Vault 직접 USDC 송금 격리·장부 결손·rounding dust 지급 장부를 검사한다. 기존 PM 모형 9개와 공급 검사 4개도 재실행해 통과했다. 한계를 기대하는 모형의 PASS는 해당 Core 기능의 성공을 뜻하지 않는다.

기존 async 회계·router·Factory/배포 script·legacy·Core 효과 관측·수량 변환·NAV·raw reader와 표준 검토 20개를 함께 재실행했다. maxDeposit·0 전송 수정의 회귀도 유지한다. 전체 테스트 통과를 완전한 표준 준수 판정으로 확대하지 않는다. Python 회귀는 고정 블록, 실패/0 구분, signed ABI, Decimal 단위 비교, 저장된 PM 표본과 ZPI 오프라인 모형을 검사한다. mock/fork 결과는 실제 비동기 CoreWriter 실행의 증거가 아니다.

전체 회귀·포맷·크기·storage gate는 `bash scripts/test_managed.sh`로 반복 실행한다. 이번 실행의 로그는 보관하지 않았다. 캐시의 storageLayout 누락을 방지하려고 clean rebuild와 명시 extra_output을 사용한다. 재현 명령과 환경 설명은 [HANDOVER](../HANDOVER.ko.md)에 있다.

문서 검증(2026-09-23): PM 모형 보고서·현행 명세·ADR-009·SSOT·핸드오버를 갱신하고 Markdown 로컬 링크·내부 앵커·코드 블록을 점검했다. 공식 PM/Core 연동·처리 순서·계정 초기화 설명을 재확인했으며 실제 상태 전이와 혼동하지 않도록 경계를 기록했다. 새 RPC 실험·프로토콜 write 검증은 수행하지 않았다.

## FE와 대화 서버 검증

2026-10-05 볼트 탐색·주문·대화 화면과 대화 서버의 검증이다. **실제 지갑, 실제 체인 쓰기, 실제 주문 전송은 포함하지 않는다.**

- **반복 gate:** `bash scripts/test_frontend.sh`(ABI drift 검사, TypeScript 검사, Prettier, Vite production build, unit)와 `bash scripts/test_server.sh`(Prettier, TypeScript 검사, unit). 수치는 위 표에 있다. FE의 unit은 주소 규칙과 Factory 설정, 대화 client와 표시, Content-Security-Policy와 frame 거부, 데모 모형, 입출금 판단, 오류 문구, 화면 이동, 평가 범위와 가격 이력, 주문 판단과 확인 시간 규칙, agent 키 기록, 주문 wire 형식, L1 action 서명을 검사한다. 대화 client 시험은 서버의 실제 서명 검증 코드를 불러 대조한다.
- **서명 대조:** L1 action 서명(msgpack + EIP-712 Agent)과 주문 wire 형식을 로컬에 설치한 공식 Python SDK가 만든 벡터와 비교했다. 서명이 거래소에서 받아들여지는지는 확인하지 않았다.
- **브라우저 확인(mock):** 데모 모드의 화면들을 1280px·390px에서 열어 가로 넘침이 없는지 확인했다. 계약 모드는 RPC·거래소·대화 서버 응답을 주입하는 임시 harness로 탐색→볼트 화면→입금·출금 요청→평가 범위 편집과 가격 기록→주문 미리보기와 전송 실패·결과 불명 처리→코드가 바뀐 Vault의 경고와 입금 차단→제안된 업그레이드 표시를 눌러 봤다. 같은 확인을 Content-Security-Policy가 들어간 production build에도 했다. **harness는 저장소에 넣지 않은 임시 도구이고 주입한 응답에 대한 확인이므로, 배포된 계약과 실제 지갑으로 하는 종단 확인을 대신하지 않는다.**
- **보안 리뷰:** 별도 컨텍스트의 보안 리뷰를 두 번 받아 반영했다(반영 내역은 [CHANGELOG](../CHANGELOG.md)). 1차는 FE의 서명·체인 읽기 코드와 대화 서버를 봤고(16건), 2차는 그 수정의 확인과 화면 코드를 봤다(FE high 1·medium 3·low 7, 서버 잔여 사항). 리뷰어는 built page를 headless Chrome에서 가짜 노드·가짜 거래소·가짜 지갑에 붙여 눌러 보는 방식으로 확인했다. 독립 보안 감사가 아니다.
- **하지 않은 것:** 지갑 확장을 쓴 실제 브라우저 확인, macOS Chrome 외 환경의 화면 확인, 배포된 Factory에 대한 목록·역할 조회, 서버 배포. Vite의 500kB 초과 chunk 경고가 남아 있다.

## 후속 기획 상태

[기획 패키지](plans/README.md)에 상품, PM 생명주기, 액션 복구, NAV, 회계·비용, Active 입금, 부분 출금, 위험, keeper/indexer, 화면, 보안/표준, 검증, 배포/운영, 다중 전략의 초안과 미실행 JSON 템플릿을 작성했다. 이들은 PROPOSED/CONDITIONAL이며 계약·서비스 구현 상태를 변경하지 않는다. 열린 제품 정책과 실측 가정을 분리해 추적한다. 현재 테스트와 bytecode 크기는 이 문서의 검증·크기 표를 따른다.

2026-09-21 기획 검증: 분야별 초안 14개의 상태 표시, 요구사항 18개의 시험 매핑, EX/신규 backlog ID 연결, 로컬 파일 링크·앵커·코드 블록, JSON 템플릿 3개의 파싱과 미실행 상태를 확인했다. 당시 정책 선택 8개와 외부 가정 7개는 열린 조건이었다. 2026-10-02 OPEN-01은 ADR-010으로 해결했으며 AS-08/09는 새 USDC 경로의 미검증 가정으로 추가했다. 과거 기획 검증으로 이 가정을 입증한 것은 아니다.

## 마지막 빌드 크기

2026-10-06 `bash scripts/test_managed.sh` 안의 `forge build --offline --force --sizes`로 재확인했다. 아래 크기는 이전 실행과 같다. 2026-10-04 기록과 비교해 바뀐 것은 `HyperCorePrecompileSource`(13,811 → 20,795)와 `ManagedPortfolioNavVerifier`(3,632 → 6,787)뿐이고 나머지는 이전 수치와 같다.

| 계약 | Runtime bytes | Initcode bytes |
| --- | ---: | ---: |
| AsyncHypeVault | 20,319 | 22,952 |
| AsyncUsdcVault | 16,708 | 19,366 |
| ManagedUsdcVault | 24,362 | 27,552 |
| ManagedUsdcVaultFactory | 2,853 | 39,653 |
| ManagedVaultDeployer | 7,550 | 35,851 |
| ManagedUpgradeController | 2,753 | 2,924 |
| ManagedUsdcVaultV2Fixture (test) | 24,554 | 27,744 |
| ManagedPortfolioNavVerifier | 6,787 | 7,454 |
| HyperCorePrecompileSource | 20,795 | 21,271 |
| ManagedCoreMainnetProbe (experiment) | 5,467 | 5,913 |
| PrecompileGasProbe (experiment, 배포하지 않음) | 57 | 921 |
| HyperCoreStrategyAccount | 21,710 | 24,399 |
| CoreActionObserver | 3,621 | 3,647 |
| HyperCoreRiskOracle | 5,369 | 6,550 |
| HyperCoreAccountReader | 4,427 | 4,453 |
| PortfolioNavReader | 3,663 | 4,122 |
| VaultDeployer | 23,647 | 23,673 |
| StrategyDeployer | 846 | 25,941 |
| DeployPair | 18,553 | 18,579 |
| HyperCoreVault (legacy) | 24,573 | 28,100 |

Managed Vault runtime 여유는 **214 bytes**, V2 회귀 fixture는 **22 bytes**다. 추가 기능에는 모듈 분리 등 크기 재설계가 필요하며 upgrade 가능성이 무제한 bytecode 증가를 뜻하지 않는다. immutable Config별 implementation과 proxy를 함께 배포하므로 메인넷의 큰 거래 gas/big-block 경로를 확인해야 한다.

기존 WHYPE 배포 경로의 VaultDeployer는 runtime 한도까지 929 bytes, legacy는 3 bytes가 남는다. Vault를 확장할 때 deployer도 검사한다. 생성 코드 조각은 constructor가 반환한 실제 보관 코드이므로 컴파일러의 `CreationCodeChunk` 표기만으로 배포 크기를 판단하지 않는다. Factory 테스트가 복원 코드와 pair 생성을 검사한다.

OZ 동기 출금 경로의 unreachable 경고와 lint 경고가 있다. 빌드 성공을 경고가 없다는 의미로 쓰지 않는다.

## 다음 작업과 운용 전 조건

[CORE-001](BACKLOG.ko.md#core-001)의 로컬 재현과 초기 공급 방어는 반영했으며, 다음 단계는 통제된 전환·왕복 관측과 자동 공급 대응 설계다. 필요한 테스트넷 환경은 [ENV-001](BACKLOG.ko.md#env-001)에서 추적한다. 환경 확보 전에는 CORE-002 복구 증거 검토와 실험 준비를 진행할 수 있다.

Managed 상품의 다음 단계는 [ADR-029](DECISIONS.ko.md#adr-029)의 정책·결정 대기 확정, 신고를 수행할 감시 봇과 가격 기록 keeper([OPS-001](BACKLOG.ko.md#ops-001)), [NAV-001](BACKLOG.ko.md#nav-001)·[VERIFIER-001](BACKLOG.ko.md#verifier-001)의 통제 왕복이다. 기존 WHYPE 전략의 출금 완료 가능성은 [CORE-002](BACKLOG.ko.md#core-002)~[CORE-006](BACKLOG.ko.md#core-006)에 남는다. 구체적인 미해결 목록과 완료 여부는 BACKLOG에만 갱신한다. 이 문서의 테스트 통과는 해당 조건을 대신하지 않는다.

표준 검토에서 확인한 입금 한도 불일치와 0 share 전송 거부는 수정했으며 [STD-002](BACKLOG.ko.md#std-002)·[STD-003](BACKLOG.ko.md#std-003)에 완료 근거를 연결했다. 전체 표준 검토는 [STD-001](BACKLOG.ko.md#std-001)에서 추적하며, 양수 직접 전송 제한은 현행 명세에 계속 명시한다.

## 2026-10-12 kHYPE 버퍼 문서화

[입금 배분 문서](khype-deposit-buffer.ko.md)에 검증 소스의 우선순위·유효 버퍼·Core 제출/위임 큐 경계를 기록했다. 우리 계약에 자동 목표 버퍼 기능을 추가하지 않았다. 이번 변경은 문서만이며 코드 테스트를 새로 실행하지 않았다.
