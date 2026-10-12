# 작업 백로그

최종 갱신: 2026-10-12 KST. 작업 우선순위·진행 상태·의존성·완료 조건의 관리 원본이다. 전체 구현/검증 상태는 [STATUS](STATUS.ko.md), 선택한 설계는 [DECISIONS](DECISIONS.ko.md)를 따른다.

상태: `READY` 착수 가능, `IN_PROGRESS` 진행 중, `WAITING` 명시한 외부 조건 대기, `PLANNED` 선행 결과 후 구체화, `DONE` 완료 조건 충족. P0은 기본 경로 검증, P1은 운용 전 통합 조건, P2는 상품 확장이다. 우선순위가 낮다고 운용 전 조건을 생략할 수 있는 것은 아니다.

## 실행 순서

**2026-10-06 구조 재확인:** 현행 source/verifier와 Vault, 브라우저 주문 경로, 대화 서버를 대조하고 로컬 gate를 재실행했다([결과](STATUS.ko.md#마지막-코드-검증)). 코드·완료 상태는 변경하지 않았다. NAV-001·VERIFIER-001의 통제 왕복, MARKET-002의 실제 agent 주문 귀속, OPS-001의 신고/가격 기록 전송·운영, 미지원 HIP-4는 계속 남는다.

**최신 NAV 구현:** [ADR-029](DECISIONS.ko.md#adr-029)로 등록 범위 평가기와 온체인 관측 검증기를 로컬 구현했다. [현행 명세](managed-precompile-nav.ko.md), [공개 계정 관측](managed-precompile-evidence.ko.md#raw-ledger-identity). 평가식은 모드와 무관한 하나이며 Vault 코드는 바꾸지 않았다. 자동 코드 리뷰를 반영했고, 사용자 선택에 따라 미등록 보유 신고와 급락 대기를 추가했다([구조 비교안](managed-scope-enforcement-options.ko.md)의 A). 다음 작업은 **ADR-029 정책 7개와 결정 대기 A·B·C·E·F 확정 → (A·B·F, 그리고 E에서 (다)를 고르면 그것도 검증기나 source를 바꾸므로 재구현) → 감시 봇·가격 기록 keeper(OPS-001) → 통제된 USDC 왕복·모드 전환 실측(ENV-001) → 독립 감사 → verifier 배포 설정**이다. 검증기와 source는 immutable이므로 코드가 바뀌는 선택지(A, B, F, E의 (다))는 배포 전에 정해야 한다. NAV-001·VERIFIER-001·VAULT-001은 그 전까지 IN_PROGRESS다.

2026-10-04 **Managed 구현 진행:** 공개 Factory·Vault proxy/고정 owner·Core 관리 함수·고유 요청/수수료·커스텀 최소 입금과 upgrade controller를 로컬 구현했다. [현행 명세](managed-usdc-vault-implementation.ko.md), [메인넷 코드/시나리오](managed-mainnet-scenarios.ko.md)를 따른다. 실자금 사용 전 통제 왕복으로 검증한 verifier가 필요하며 probe는 owner 자기 자금 실험 전용이다. 당시의 작업 순서는 위 "최신 NAV 구현"으로 대체됐다. upgrade 권한 기본안은 Vault owner·48시간 지연이다.

2026-10-04 [ADR-023](DECISIONS.ko.md#adr-023)으로 창설자 고정 owner·API 직접 매매·Vault onlyOwner 관리 함수의 구조를 확정했다. 상세 함수/권한은 [운용자 신뢰형 USDC 아키텍처](managed-usdc-vault-architecture.ko.md)를 따른다. Factory/고정 owner → 관리 함수/키 등록 → Core 왕복·정산 → 성과 수수료/시장별 검증 순서로 새 상품을 구현한다. 기존 WHYPE 자동 전략의 조건을 새 owner 운용 모델의 강제 주문 제한·운용자 협조 없는 회수 보장으로 복사하지 않는다.

**CORE-001**의 로컬 모형 재현과 초기 공급 전 lending 검사를 구현했다. 통제된 네트워크 왕복과 자동 공급 대응 상태 전이는 ENV-001 및 Core 관측 결과를 확보한 뒤 진행한다. 환경 확보 전에는 CORE-002의 복구 증거 검토와 실험 준비를 진행할 수 있다. Active 입금과 buffer는 NAV-001 이후다.

2026-10-02 [ADR-010](DECISIONS.ko.md#adr-010)으로 후속 배포 목표를 HyperEVM USDC 기반 새 쌍으로 변경했다. 현행 WHYPE 코드는 이 결정만으로 USDC를 지원하지 않는다. USDC-001의 CoreDepositWallet 양방향 증거와 USDC-002의 새 계약 구현·회계 검증을 첫 USDC 배포 후보의 선행 조건으로 추가한다.

2026-10-03 [ADR-011](DECISIONS.ko.md#adr-011)로 spot·HIP-3·HIP-4를 새 USDC Vault의 핵심 거래 범위로 확정했다. 고정 HYPE carry만 구현한 USDC 쌍은 첫 제품 완료 조건에 미달한다. 시장별 통제 거래·정산·NAV/exit은 MARKET-001, agent wallet·builder fee 권한/수수료 경로는 MARKET-002에서 추적한다.

2026-10-03 [ADR-014](DECISIONS.ko.md#adr-014)는 새 USDC Vault 주소 자체를 Core 계정으로 쓰고 누구나 Factory를 호출해 Vault를 생성하는 목표로 변경했다. [ADR-015](DECISIONS.ko.md#adr-015)는 창설자를 해당 Vault 운용자로 정하고 창설자 자신의 Core USDC 전송으로 활성화하는 절차로 정정했다. 기존 로컬 USDC Vault의 별도 Strategy 연결은 이 목표를 구현하지 않는다. [FACTORY-001](#factory-001)의 공개 생성·창설자 활성화·후속 확인과 USDC-002의 단일 주소 운용을 함께 충족해야 한다.

2026-10-03 [ADR-016](DECISIONS.ko.md#adr-016)은 다른 예치자의 실제 USDC 출금 이익 중 10%를 총 성과 수수료로 정했다. [ADR-017](DECISIONS.ko.md#adr-017)은 그 수수료의 20%를 플랫폼, 80%를 창설자/운용자에게 배분한다. 원가·손실 이월·고유 요청 ID·Claim 지급 준비금과 배분은 [FEE-001](#fee-001)에서 구현·검증한다. 당시 코드에는 없었으며 현재 Managed 구현과 커스텀 요율은 ADR-025/026를 따른다.

2026-10-03 [ADR-018](DECISIONS.ko.md#adr-018)의 창설자 자기자본 100 USDC는 유지한다. [ADR-019](DECISIONS.ko.md#adr-019)의 Core 잔액 기준 지분 발행은 ADR-021로 대체됐다. [ADR-020](DECISIONS.ko.md#adr-020)은 생성 거래에서 창설자 HyperEVM USDC를 새 Vault에 이체하고 Vault가 같은 거래에서 Core에 배정하는 첫 경로를 채택했다. 후속 [ADR-021](DECISIONS.ko.md#adr-021)은 지분을 실제 EVM USDC 수령 시 발행하고 Core 확인은 운용 개시 조건으로 바꿨다. Core 확인 전 공개 입금은 보류한다. [FACTORY-001](#factory-001)이 구현·검증을 추적한다.

2026-10-03 Core 직접 송금의 1 quote-token 비용은 공개 연동 감사상 송금인 잔액에서 전송액 외로 차감된다. 기본 생성 EVM→Core `deposit` 경로의 실제 gross 차감·Core net 수령과 101→100 가정은 [USDC-001](#usdc-001)의 통제 거래로 확인한다. 초기 제품의 Core 보유자는 자기 EVM 주소로 먼저 출금해 입금한다. Vault Core 직접 송금은 지분을 발행하지 않는 비요청 자산이다. 운용 중 창설자 지분의 출금 제한은 [OPEN-09](plans/README.md#정책-결정-등록부)의 제안 단계이며, Factory/Vault 구현 전에 이 정책을 확정해야 한다.

분야별 구현 초안과 요구사항/시험 매핑은 [기획 패키지](plans/README.md)에 있다. 기획 작성 완료는 아래 개발 항목의 DONE 조건을 대체하지 않는다.

| ID | 우선순위 | 상태 | 작업 | 선행 조건 |
| --- | --- | --- | --- | --- |
| [HV-003](#hv-003) | P0 | DONE | 운용 중 버퍼 즉시 출금 `redeemNow` 메인넷 적용: 새 v4 Vault 배포·검증·소액 실측 완료, v3 은퇴. 남음: keeper 상시 기록, verifier 통합 시험 | ADR-039 |
| [HV-004](#hv-004) | P0 | DONE | 헤지 현물·숏 perp 오라클 평가(ADR-040): v6로 메인넷 배포, 기록 없는 `redeemNow` 실측 | ADR-040 |
| [HV-005](#hv-005) | P1 | DONE | HyperVault 모듈 분리(v6, ADR-041): 메인넷 배포·검증 19항목 통과 | ADR-041 |
| [HV-006](#hv-006) | P1 | IN PROGRESS | USDC Carry 운영(LTV 확장) 계획 도구·Unified/PM 모니터링: dry-run·로컬 모니터 완료, 실행(--execute)·PM 실계정 검증 남음 | 런북 |
| [HV-002](#hv-002) | P0 | IN_PROGRESS | HyperVault v2 계약(kHYPE식 분리·양도 지분·HWM) + v3 owner 신뢰 모듈: USDC 메인넷 v2·v3 왕복 완료. 실거래 수익 과금·HYPE/UBTC·감사 남음 | ADR-037, ADR-038 |
| [HV-001](#hv-001) | P0 | IN_PROGRESS | HyperVault 해커톤 제출: USDC Vault 메인넷 왕복 2회 완료, FE 배포·영상·제출 남음 | 사용자 정보(영상·repo·팀), Vercel 배포 승인 |
| [ARCH-001](#arch-001) | P1 | DONE | Vault 아키텍처 기준선과 배포 단계·차단 조건 연결 | 구현·실측 완료와 별개 |
| [USDC-001](#usdc-001) | P0 | READY | HyperEVM USDC↔Vault Core 통제 실험 | 실측 완료에는 ENV-001 필요 |
| [USDC-002](#usdc-002) | P0 | IN_PROGRESS | USDC ERC7540 Vault 구현; 단일 Core 계정·거래·전체 회계 미완료 | USDC-001, FACTORY-001, FEE-001, MARKET-001/002, CORE-001~005 |
| [FACTORY-001](#factory-001) | P0 | IN_PROGRESS | 누구나 생성 시 EVM USDC 납입·창설자 지분 발행, Core 활성화 확인. **선제 활성화로 생성이 막히는 문제 미해결** | 단일 주소 Vault 템플릿, USDC-001 실측에는 ENV-001 |
| [FEE-001](#fee-001) | P0 | IN_PROGRESS | 사용자별 커스텀 성과 수수료(기본 10%)·원가·손실 회계 | 단일 주소 USDC Vault 템플릿, 검증된 정산 USDC |
| [MARKET-001](#market-001) | P0 | READY | spot·HIP-3·HIP-4 주문·상태·정산·회수 검증 | 실측 완료에는 ENV-001 필요 |
| [MARKET-002](#market-002) | P0 | IN_PROGRESS | owner 관리 함수·API wallet·builder fee 구현. FE 주문 화면(브라우저 agent 키)은 로컬 구현, 실주문·계정 귀속 미검증 | ADR-023·031, 단일 주소 Vault |
| [VERIFIER-001](#verifier-001) | P0 | IN_PROGRESS | Managed Core 결과·회수·종료 verifier: 온체인 관측 구현, 종료 복구 결정·통제 실측·정책 확정 남음 | ADR-029 확정, 실측에는 ENV-001 |
| [UPGRADE-001](#upgrade-001) | P1 | IN_PROGRESS | 커스텀 조건·proxy 업그레이드·지속 회귀 | 로컬 구현 완료, 실제 릴리스 후보 검토/실험 남음 |
| [CORE-001](#core-001) | P0 | IN_PROGRESS | PM 전환·자동 공급·bridge 상태 전이 | 실측 완료에는 ENV-001 필요 |
| [ENV-001](#env-001) | P0 | WAITING | 통제 가능한 테스트넷 운용 환경 | 프로젝트 계정·환경 정보 |
| [CORE-002](#core-002) | P1 | READY | 액션 최종성·reject/zero-fill 복구 설계 | 네트워크 검증에는 ENV-001 |
| [CORE-003](#core-003) | P1 | READY | recall sender·비용·순수령액 | 네트워크 검증에는 ENV-001 |
| [CORE-004](#core-004) | P1 | READY | quote sub-lot dust 처분·귀속 | CORE-003과 출금 결과 대조 |
| [CORE-005](#core-005) | P1 | READY | Core 가스 후원·소모·top-up 회계 | 비용 귀속 결정 및 ENV-001 |
| [CORE-006](#core-006) | P1 | PLANNED | PM health·청산·극단 손실 대응 | CORE-001, NAV-001의 관측 모델 |
| [NAV-001](#nav-001) | P1 | IN_PROGRESS | 생산용 HyperCore balance-sheet source | USDC-002, MARKET-001, CORE-001, CORE-003~005, ENV-001 |
| [STD-001](#std-001) | P1 | IN_PROGRESS | ERC7540/7575 적합성 검토 | 현행 회계·ABI |
| [STD-002](#std-002) | P1 | DONE | maxDeposit과 최소 발행 조건 일치 | STD-F01 수정·회귀 완료 |
| [STD-003](#std-003) | P1 | DONE | Vault로의 0 share 전송 호환성 검토 | ADR-008 채택·수정·회귀 완료 |
| [REL-001](#rel-001) | P1 | PLANNED | 네트워크 배포·운용 인계 기준 | USDC-001/002, MARKET-001/002, Core 통합, NAV-001, STD-001 |
| [VAULT-001](#vault-001) | P2 | IN_PROGRESS | Active 동기 입금·공정 발행 가격 | NAV-001 |
| [LIQ-001](#liq-001) | P2 | PLANNED | 출금 buffer·부분 회수 | VAULT-001, CORE-002~006 |
| [STRAT-001](#strat-001) | P2 | PLANNED | 외부 lending/liquidity 다중 전략 (Core 시장 범위와 별개) | LIQ-001 |
| [PROD-001](#prod-001) | P1 | READY | 상품 정책·비용·표시 통화 구체화 | OPEN 결정 등록부 |
| [RISK-001](#risk-001) | P1 | READY | 파라미터 profile·단위·스트레스 보정 | 로컬부터 시작, 실측 보정에는 ENV-001 |
| [OPS-001](#ops-001) | P1 | IN_PROGRESS | read-only indexer와 keeper 실행기. Managed 감시·가격 기록의 판단 부분만 구현, 전송·주기 실행 남음 | write 연동에는 Core 검증·ENV-001 |
| [UX-001](#ux-001) | P2 | IN_PROGRESS | 사용자/운영 화면과 read API. 탐색·생성·입출금·운용·주문·평가 범위·대화 화면 로컬 구현, 실제 지갑·네트워크 종단 확인 남음 | PROD-001, OPS-001의 데이터 계약 |
| [CHAT-001](#chat-001) | P2 | IN_PROGRESS | Vault별 대화 서버: 로컬 구현, 호스팅·운영 정책·실제 배포 남음 | ADR-032, 배포된 Factory |
| [SEC-001](#sec-001) | P1 | READY | 위협 모델 검토·독립 감사 인계 | 초기 검토 가능, 최종 검토는 배포 후보 코드 |
| [QA-001](#qa-001) | P1 | READY | 요구사항 추적 시험과 실험 원장 | 로컬부터 시작, 실측에는 ENV-001 |
| [ZPI-001](#zpi-001) | P2 | DONE | 별도 Zcash 인텐트 연구 명세와 오프라인 정산 모형 | 실자금 기능과 별개 |
| [ZPI-002](#zpi-002) | P2 | IN_PROGRESS | shielded 입금 귀속·서명·환불 권리 증거 | ZPI-001; 테스트 지갑 생성, 수신·증거 검증 필요 |
| [ZPI-003](#zpi-003) | P2 | PLANNED | 공동 Core 계정의 체결 최종성·완전한 잔액 대조 | ZPI-002, 통제 계정 |
| [ZPI-004](#zpi-004) | P2 | PLANNED | ZEC 수탁·솔버 실패·출금/탈출 경로 | ZPI-002/003 신뢰 모델 |
| [ZPI-005](#zpi-005) | P2 | READY | 금액·시점·소규모 배치의 프라이버시 누출 실험 | ZPI-001 |

<a id="arch-001"></a>
## ARCH-001 — Vault 아키텍처 기준선

**완료 (2026-10-02):** [아키텍처 문서](vault-architecture.ko.md)에 제품/배포 단위, Vault·Strategy·Core·reader·keeper의 신뢰 경계, 소유권·정산 불변조건, 실패 정책, 첫 배포 후보와 후속 확장 범위를 연결했다. 현행 ABI는 [구현 명세](split-implementation.ko.md)에, 실제 미완료 구현·실험은 아래 CORE/NAV/REL 항목에 남긴다. 설계 문서 완료를 출시 가능 상태로 해석하지 않는다.

<a id="usdc-001"></a>
## USDC-001 — HyperEVM USDC와 Vault Core 계정의 양방향 증거

설계: [ADR-010](DECISIONS.ko.md#adr-010)의 USDC 경로, [ADR-014](DECISIONS.ko.md#adr-014)의 단일 Vault 주소, [ADR-015](DECISIONS.ko.md#adr-015)의 Core 활성화, [ADR-021](DECISIONS.ko.md#adr-021)의 EVM 수령 기준 창설자 지분, [USDC 목표 경로](vault-architecture.ko.md#7-usdc-목표-경로와-검증-조건). 현행 WHYPE bridge 경로를 새 USDC 경로의 성공 증거로 재사용하지 않는다.

**완료 조건:** 프로젝트가 통제하는 계정에서 Circle native USDC 토큰/`CoreDepositWallet` 코드·주소·decimals와 Core token metadata를 확인한다. 대조 실험으로 새 Vault의 미활성 Core 계정에 Core USDC를 직접 보내고 송금인 차감·1 quote 수수료·Vault 실수령·후속 `userExists`를 전후 블록으로 확인하되, 이를 지분 발행 경로로 취급하지 않는다. 기본 생성 경로의 Vault `CoreDepositWallet.deposit`에서 101 EVM USDC 차감 시 Core 순수령 100이 되는지, 활성화 1 quote 비용의 정확한 차감 위치와 Core 실패·지연을 전후 블록에서 확인한다. `depositFor`와 `deposit`의 caller/수령자 차이도 검증한다. 창설자 지분은 EVM USDC 원금 실제 수령 시 한 번 발행하고 Core 확인에서 재발행하지 않는다. Core 초과·후속 비요청 송금은 분리한다. Vault Core 직접 송금 또는 Circle `depositFor(vault)`가 창설자/일반 사용자 지분으로 오인되지 않는지 시험한다. Core 계정 선입금/선제 활성화, 조회 실패, 99 수령, 중복 activation finalize, EVM 6자리/Core 8자리 변환, 자금 도착 후 확정 실패와 재시도·회수 경로를 검증한다. 창설자 EOA의 CoreWriter 직접 호출은 실제 source 주소·액션 성공·잔액 변화를 검증한 뒤 대체 UX로 인정한다. Factory CoreWriter 호출이 창설자 자금으로 오인되지 않아야 한다. Vault 자신의 `deposit(amount, destinationDex)` EVM 차감과 같은 Vault 주소의 Core credit을 대조한다. spot/perp 목적지·계정 모드·동일 블록 CoreWriter 거절 조건을 기록한다. Vault의 CoreWriter `SendAsset`로 Core USDC를 같은 주소 EVM으로 되돌리고 실제 수신·수수료·부분/지연을 확인한다. 실패·재실행·다른 cycle/외부 입금이 중복 원금이나 성공 판정으로 이어지지 않아야 한다. 제3자의 Vault Core USDC credit/임의 토큰 송금 및 Vault EVM USDC 직접 송금이 후속 운용 원금·이익·회수 완료로 오인되지 않는지도 통제 실험한다. `CoreDepositWallet`에 직접 ERC20 전송하지 않는다. mainnet profile은 testnet 결과를 복사하지 않고 따로 검증한다.

<a id="usdc-002"></a>
## USDC-002 — 단일 주소 운용자 USDC Vault

**2026-10-04 추가:** `ManagedUsdcVault/Factory`에 단일 proxy/Core 주소·owner 관리·현재 회계를 구현했다. 이전 구현 설명은 아래 이력이며, 현행 단일 주소 ABI는 [Managed 명세](managed-usdc-vault-implementation.ko.md)를 따른다. 생산 verifier와 실제 시장/회수 검증이 남아 IN_PROGRESS다.

**진행 (2026-10-03):** [AsyncUsdcVault](../src/AsyncUsdcVault.sol)와 [현행 명세](usdc-vault-implementation.ko.md)를 추가했다. 6자리 USDC 동기 입금·9자리 share, ERC7540 비동기 출금·claim, `depositFor` 정확한 allowance/차감, claim 준비금, 실제 반환액 기반 정산을 mock에서 검증했다. [ADR-013](DECISIONS.ko.md#adr-013)에 따라 Vault 직접 USDC 송금은 장부 밖으로 격리하고 가격·cap·배정·정산에 쓰지 않도록 했다. `IUsdcCycleStrategy`는 반환 준비를 묻는 인터페이스일 뿐 생산용 Core Strategy/terminal 증명이 아니다. 새 Factory, 외부 Strategy Core/EVM 송금의 귀속·격리, Core credit 관측, USDC CoreWriter 회수, spot·HIP-3·HIP-4 주문/정산, 완전 NAV와 통제 네트워크 시험은 아래 완료 조건으로 남는다.

**완료 조건:** 기존 WHYPE 쌍의 underlying이나 지분을 변경하지 않고, 6자리 USDC를 받는 새 Vault를 구현한다. Vault 주소 자체가 Core 계정과 CoreWriter caller이며, 외부 거래 모듈이 직접 다른 Core 계정으로 액션을 제출하지 못한다. 정확한 allowance를 통한 CoreDepositWallet 배정, cycle/action별 증거가 있는 Core credit 소비, [MARKET-001](#market-001)의 spot·HIP-3·HIP-4 거래·정산·USDC 회수, 실수령 기반 epoch 정산과 [FEE-001](#fee-001)의 순수령 성과 수수료를 상태 머신으로 검증한다. Vault Core/HyperEVM 주소로 들어온 비요청 자산을 실제 전략 원금·손익·회수분과 구분하고 미확인분이 NAV·exit·새 배정에 섞이지 않게 한다. Vault의 격리 USDC에 대한 회수/귀속 정책과 접근 권한도 별도 결정한다. HYPE carry는 필수 단일 전략이 아니다. EVM 6자리/Core 8자리, 시장별 담보·계정 활성화·가스·거래비·dust·부채·인플라이트의 소유권을 보존한다. 잔액 조회 실패는 0으로 치환하지 않는다. 현행 WHYPE 전용 Router/Strategy를 이름만 바꿔 배포하지 않는다. mock·fork·통제 네트워크 결과를 구분하고 전체 테스트·빌드 크기·ABI·명세를 갱신한다.

<a id="factory-001"></a>
## FACTORY-001 — 공개 USDC Vault 생성·초기 Core 배정

**2026-10-04 진행:** Factory 공개 생성, immutable owner, proxy bootstrap, EVM100 동기 share, Circle exact debit, 재발행 방지·다중 Vault 분리·선제 Core 활성화 거부를 구현/로컬 검증했다. 통제된 gross/net·활성화 효과와 production verifier가 남는다.

**미해결 — 선제 활성화로 생성이 막힌다 (2026-10-04 자동 리뷰 지적, 코드 미변경):** `ManagedVaultDeployer`는 nonce 기반 `CREATE`로 proxy를 만들므로 다음 Vault 주소를 미리 계산할 수 있다. `bootstrap`은 그 주소가 Core에 이미 존재하거나 USDC 잔액이 있으면 `CoreNotReady`로 revert하고, revert하면 deployer의 nonce가 되돌아가 다음 시도도 같은 주소를 쓴다. 따라서 누군가 예측 주소로 Core USDC를 한 번 보내면 그 Factory의 **모든 후속 생성이 계속 실패한다.** 공격 비용은 소액 송금과 계정 활성화 비용이다. 로컬 코드 판독으로 확인했고 네트워크에서 재현하지는 않았다. 수정 후보: 호출자가 고르는 salt를 섞은 `CREATE2`로 막힌 주소를 건너뛰게 하거나, 선제 활성화된 계정을 받아들이고 기존 Core 잔액을 비요청 자금으로 처리한다. 어느 쪽이든 Factory·Vault 변경이며 [ADR-029](DECISIONS.ko.md#adr-029)의 결정 대기 C다. 이 항목이 닫히기 전에는 Factory를 공개 배포하지 않는다.

설계: [ADR-014](DECISIONS.ko.md#adr-014), [ADR-020](DECISIONS.ko.md#adr-020), [ADR-021](DECISIONS.ko.md#adr-021), [공개 Factory 흐름](vault-architecture.ko.md#9-공개-factory와-core-활성화). 현행 WHYPE `VaultFactory.createPair`은 별도 Strategy형 WHYPE 배포기일 뿐 이 항목의 구현이 아니다.

**완료 조건:** 누구나 호출 가능한 `createVaultAndFund`가 검증된 단일 주소 Vault 템플릿을 배포하고 호출자를 변경 불가 owner·창설자 지분 수령자로 고정한다. Factory가 owner가 되거나 생성 후 변경/포기되는 경로를 두지 않고, 초기 자금 인식은 onlyFactory 1회로 제한한다. 창설자 EVM USDC 원금 100을 실제로 `transferFrom`하고 같은 EVM 거래에서 초기 환율 1 USDC당 1 share의 100 share(9자리 `100e9`)를 창설자에게 한 번 `_mint`한다. 활성화 비용 예산은 원금·share·수수료 원가·주주 NAV에서 분리한다. Vault가 같은 거래에서 제한된 Circle `deposit`을 호출할 경우 정확한 EVM 차감·allowance 초기화·실패 시 전체 revert와 `pendingCoreAllocation` 기록을 검증한다. 101 gross→100 Core net 가정은 [USDC-001](#usdc-001) 실측 전 생산 설정으로 고정하지 않는다. EVM 성공 후에는 `AwaitingActivation`에서 일반 사용자 입금·거래를 막되 창설자 share를 취소하거나 또 발행하지 않는다. 후속 블록의 permissionless `finalizeActivation`은 Vault 내부 `CoreRead.l1Block()`·`userExists`·고정 토큰/계정 모드의 `spotBalance`를 확인하고 정확한 순수령/비용·미확인 초과를 대조해 Ready 여부만 결정한다. 호출자 제공 잔액·수령자·keeper 보고를 신뢰하지 않는다. EVM 현금·인플라이트·확인된 Core 자산은 단위 변환 후 중복 없이 장부에 반영하고 실제 자산 결손은 NAV 손실로 드러낸다. Core 실패·99 수령·조회 실패·기대 외 초과·선제 활성화·비요청 송금은 공개 입금을 열지 않고 재조회·회수·손실/창설자 비용 복구 경로로 보낸다. Core에 자금이 있는 창설자는 자기 동일 주소 EVM으로 먼저 출금해 기본 경로를 사용하고, Vault Core 직접 송금이나 Circle `depositFor(vault)`를 share 발행 근거로 삼지 않는다. 일반 EVM 예치는 완전 실현 Idle NAV일 때만 동기 발행하며 Active 입금은 [NAV-001](#nav-001) 또는 별도 ERC-7540 비동기 입금 설계 전까지 닫는다. 자산·실행 코드·관리 함수의 수령지를 검증된 Factory 설정으로 제한하고 임의 Strategy·CoreWriter payload·사용자 자금 수령지 변경을 막는다. API 직접 매매의 시장/위험 판단은 ADR-023의 owner 신뢰 모델을 따르며 Factory가 모든 주문의 상한을 강제하지 않는다. 여러 창설자, 직접 EVM/Core 송금, 중복 생성/확정, 가격·발행량, 잘못된 Core 결과, 회수 지연을 mock과 통제 네트워크에서 검증한다. 시장 실행·출금·Core 회수까지 안전한 템플릿이 없으면 생산용으로 표시하지 않는다.

**활성화/가스 검증:** Circle `deposit`의 첫 Core 수신으로 활성화하고 CoreWriter는 후속 EVM 블록의 계정 확인 뒤에만 제출한다. 생성자·keeper·운용자의 HyperEVM HYPE 가스 부담을 인터페이스와 운영 절차에 명시한다. Vault EVM HYPE 선입금이 내부 CoreWriter 호출의 조건이라는 가정은 두지 않는다. Core→EVM 회수의 Core spot HYPE 요건은 [CORE-005](#core-005), 첫 수신 1 quote-token 비용과 실제 gross→net은 [USDC-001](#usdc-001)에서 검증한다. [공식 처리 순서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings)

**액션 구분:** `finalizeActivation`은 Vault 자체의 Core read 확인 함수로 구현하고 CoreWriter action 8 `Finalize EVM Contract`를 호출하지 않는다. action 8은 spot 토큰의 Core/EVM 계약 연결용이다. `userExists` 실패나 Core 수령 부족 시 운용 상태를 열지 않는 로컬/mock 검증과 통제 네트워크 확인을 분리한다. [공식 토큰 연결 절차](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers)

**EVM 성공과 Core 정산 경계:** Circle `deposit`의 `transferFrom`·입력 실패 시 Factory 생성·share 발행까지 revert되는 로컬 테스트를 추가한다. EVM 성공 뒤 Core credit 누락·지연·부족을 별도 상태로 재현하고, `finalizeActivation`에서 지분을 재발행하지 않는지 검증한다. 배포 대상 Circle 코드·`newCoreAccountFee` 설정·Core spot/perp 목적지별 경로를 확인한다. 특히 Core spot 직행과 Circle의 CoreWriter perp 전달을 구분하며, EVM receipt만으로 Core 순수령을 완료 판정하지 않는다. [Circle 공개 구현](https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CoreDepositWallet.sol)

<a id="fee-001"></a>
## FEE-001 — 커스텀 성과 수수료의 출금 회계

설계: [ADR-016](DECISIONS.ko.md#adr-016), [ADR-017](DECISIONS.ko.md#adr-017), [상세 원장·수식](performance-fee-architecture.ko.md). 이는 새 USDC 공개 Factory Vault의 요구다. 기존 WHYPE Vault와 현재 별도 Strategy형 `AsyncUsdcVault`에는 해당 수수료가 없다.

**2026-10-04 진행:** 고유 요청/원가/손실 이월/준비금, 부분 claim·80/20 분할·커스텀 요율을 `ManagedRedeem`에 구현했다. 실제 정산 근거와 표준 전체 대조는 남는다.

**완료 조건:** Factory가 창설자에게 고정 운용 역할·운용자 수령 주소를 주고 성과수수료는 기본 1,000 bps의 선택값, 플랫폼 배분율은 2,000 bps(성과 수수료 기준)로 유지한다. 기존 share/준비금이 있으면 요율 변경을 막고 요청의 요율을 고정한다. 플랫폼 Treasury도 Factory의 검증된 설정으로 고정한다. 운용자 외 사용자의 입금 실제 USDC를 보유 share 원가로 기록하고 요청 share의 비례 원가를 고정한다. 다른 원가의 요청을 같은 외부 ERC-7540 `requestId`로 묶지 않도록 내부 epoch와 고유 요청 ID를 분리한다. 양수 share 전송·타인 controller 합치기를 막거나 동등한 원가 귀속 방어를 증명하고, 한 주소의 동시 미완료 요청을 막아 손실 이월 순서를 고정한다. 실제 정산 USDC의 총 출금 권리에서 원가·이월 손실을 먼저 차감하고 이익에 해당 요청의 선택 요율만 과금한다. 전액 출금·재입금 뒤에도 같은 사용자 주소의 손실 이월과 수수료 소수 잔여가 유지된다. 수수료 금액을 Claim 전에 별도 인출/재투자하지 않고 총 권리를 준비금으로 잠근 뒤 Claim 때 사용자 순수령·운용자 80%·플랫폼 20%를 원자적으로 지급한다. 소액 분할에도 플랫폼 배분 비율의 누적 반올림을 보존한다. `maxWithdraw`, `redeem`, `withdraw`, 이벤트가 순수령을 일관되게 표현하고 부분 Claim의 합계가 단일 Claim과 같아야 한다. 운용자 자기 share, 손실, 수수료 지급 실패, operator/receiver, 두 사용자 같은 epoch, 소액 분할, 비요청 Core/EVM 송금, stale NAV와 실제 회수 지연을 테스트한다. ERC-4626/7540 조항 대조와 전체 회귀·빌드 크기 검사 후 상태·ABI·명세를 갱신한다.

<a id="market-001"></a>
## MARKET-001 — 첫 USDC 상품의 spot·HIP-3·HIP-4 거래 범위

설계: [ADR-011](DECISIONS.ko.md#adr-011), [시장별 아키텍처](vault-architecture.ko.md#8-usdc-다중-시장-거래-아키텍처). 이는 후속 외부 lending/LP 전략인 STRAT-001과 별개다.

**완료 조건:** 각 시장의 공식 asset ID와 metadata·계정 모드·quote/collateral·주문/취소/체결/정산 인터페이스를 확인한다. 프로젝트가 통제하는 Vault 계약 Core 계정의 등록 agent로 spot, HIP-3 DEX, HIP-4 outcome 각각의 소액 주문→취소/체결→USDC 가치 대조→위험 축소/매도 또는 만기 정산→회수 경로를 기록한다. HIP-3 DEX별 margin·halt/settlement 및 HIP-4 만기 payout·열린 주문·지연을 별도 원장으로 추적한다. 기본 perp만 읽는 source로 전체 NAV를 확정하지 않으며, 시장 하나의 read 실패·미지원·잔여 포지션은 공개 입금/정산 성공으로 숨기지 않는다. 각 시장을 실제로 거래할 수 있다는 검증 전에는 다중 시장 기능 완료로 표시하지 않는다.

<a id="market-002"></a>
## MARKET-002 — Agent wallet과 builder fee 권한·비용 경계

**계정 귀속 검증:** owner는 Vault의 등록 함수를 호출하고 Vault가 자신의 Core 계정에 Vault 전용 agent를 등록해야 한다. 같은 owner가 Vault A/B를 생성해도 각 전용 키의 주문·잔액 조회가 해당 Vault에 귀속되는지 확인한다. owner 개인 Core 계정이나 Factory를 master로 연결하지 않는다.

설계: [ADR-022](DECISIONS.ko.md#adr-022), [ADR-023](DECISIONS.ko.md#adr-023), [목표 함수/권한](managed-usdc-vault-architecture.ko.md#4-목표-함수와-권한). owner 신뢰형 직접 API 매매를 채택했고 함수 목록의 아키텍처를 작성했다. 관리 함수와 agent dry-run/서명 runner는 구현했으며 실제 메인넷 귀속·권한·회수 검증은 남아 있다.

**완료 조건:** Vault의 고정 owner만 API wallet 등록/교체/철회, USDC 양방향 배정/회수, 같은 주소 Core 내부 이동, lending 공급/회수, 계정 추상화, builder fee 승인 함수를 호출하도록 구현한다. 외부 receiver/user/subaccount 또는 raw payload를 주입하지 못하게 하고, Factory·agent·예치자·ERC-7540 operator가 운용 권한을 얻지 않게 한다. Core 활성화 후 Vault 자신의 action 9 등록과 실제 API 주문 계정 귀속을 통제 메인넷 소액 거래로 확인한다. 고정 agent 슬롯의 교체/철회·nonce/만료·구키 주소 재사용 방지·미체결/접수 주문 처리를 검증한다. 로컬 주소 삭제·action 제출만으로 Core 철회가 됐다고 표시하지 않는다.

**직접 주문과 회계:** API 매매의 시장/노출 위험은 owner에게 맡기며 EVM allowlist의 주문별 강제를 완료 조건으로 요구하지 않는다. agentSendAsset 동일 주소 이동을 포함해 API 거래가 관리 액션 관측·Idle 입금 가격·출금 정산과 겹치는 사례를 검증한다. 신규 입금 창과 정산 중 실제 포지션·주문·자금 이동 상태를 확인하고 미지원 자산/누락 read를 숨기지 않는다. owner가 포지션 종료와 Core 회수를 수행하고 예치자의 요청/확정 claim은 owner 추가 승인 없이 가능해야 한다. owner 협조 없는 강제 청산은 별도 후속 기능이다.

**FE 주문 화면 (2026-10-05, [ADR-031](DECISIONS.ko.md#adr-031), 로컬 구현):** 운용자가 FE에서 Vault 전용 agent 키를 만들고(브라우저에서 생성, 암호로 암호화해 그 브라우저에만 보관) `setApiWallet`으로 등록한 뒤, 등록 범위 안의 perp·spot 시장에 지정가·시장가 주문과 취소·leverage 변경을 서명해 보낸다. 서명은 공식 SDK의 벡터와 대조했고 주문 문자열(가격·수량 자릿수, 최소 주문 금액, asset id, builder 필드)은 단위 시험으로 고정했다. 주문 전송은 빌드 설정(`VITE_ENABLE_TRADING`)으로 따로 켜며 기본은 서명 없는 미리보기다. **남은 것:** 실제 주문을 한 번도 보내지 않았다. 컨트랙트 계정의 agent 주문이 Vault에 귀속되는지, 응답·오류 형식, 만료(`expiresAfter`)와 nonce 규칙의 실제 동작, builder 필드가 붙은 주문의 fee를 통제 소액 거래로 확인한다. 키 보관 방식(암호 강도, 잠금 해제 유지 시간, 다른 기기로의 이전)은 사용자 확정 대기다.

**Builder fee:** action 12의 고정 builder·상한 승인과 API 주문별 builder 필드 적용을 구분한다. 승인만으로 모든 API 주문에 fee가 붙는다고 가정하지 않는다. 실제 체결 fee·취소를 대조하며 성과 수수료의 플랫폼 20%와 별도 회계로 취급한다. 실계정 서명 비밀은 문서에 넣지 않는다. **페이백(2026-10-05, [ADR-030](DECISIONS.ko.md#adr-030), 미구현):** 플랫폼 builder 주소로 받은 fee의 50%를 Vault 배포자에게 돌려주며 계산은 플랫폼이 오프체인에서 한다. 남은 것은 Vault별 builder fee 수집과 집계, 지급 주기·수단, `builderFeeCap` 값, 예치자 고지 문구, 정산 기록의 공개 여부다. 온체인으로 검증되는 값이 아니므로 컨트랙트의 보장으로 표시하지 않는다.

**계정 설정/대출 액션:** Vault 자신의 action 15 공급·회수와 action 16 추상화 전환을 onlyOwner typed 함수로 감싼다. user는 Vault로 고정하고 token 단위·0=MAX를 명시하며 Core 결과·실패 복구를 확인한다. action 15는 직접 차입 액션이 아니며, 공식 Exchange 명세에서 agent 서명 borrowLend를 확인할 때까지 API wallet 기능으로 표시하지 않는다. 공식 SDK 예시의 초기 default 모드 조건 때문에 agentSetAbstraction을 자유로운 모드 전환 수단으로 쓰지 않는다. PM 자동 공급/출금 가능액과 [CORE-001](#core-001)의 관계를 검증한다.

<a id="verifier-001"></a>
## VERIFIER-001 — Managed Core 증거 verifier

**2026-10-04 진행:** [ManagedPortfolioNavVerifier](../src/managed/ManagedPortfolioNavVerifier.sol)에 외부 증명 없는 판정을 구현했다. pending ID/digest 결속, 제출보다 뒤의 Core 블록, 회수는 Vault가 실제 보유한 장부 밖 USDC만 편입, 도착하지 않은 회수는 owner의 포기 선언(`abandonRecall`)에서 대기 기간이 지난 뒤에만 닫히고 그때 도착분을 편입, 종료는 부채가 없고 가져올 수 있는 가치가 dust 상한(당시 0 초과 20 USDC 이하, 2026-10-05에 10 USDC 미만으로 낮춤) 안일 때. 지분 가격 기록(`recordPrice`)과 급락 직후의 발행 거부도 이 검증기에 있다. [명세](managed-precompile-nav.ko.md#액션-최종성). read-only mainnet preflight와 owner-funded probe 코드는 이 검증기의 증거가 아니다.

**정책 변경 대기:** 기존 완료 조건의 "제3자 동액 송금의 귀속 증명", "최종 처리 결과 연결", "주문·agent 종료 인증"은 온체인으로 얻을 수 없다. [ADR-029](DECISIONS.ko.md#adr-029)는 이를 "보유하지 않은 현금은 편입할 수 없다"와 처리 순서 판정으로 바꾸고 Core 쪽 거절의 관측 불가를 한계로 받아들인다. 사용자 확정 전에는 이 항목을 DONE으로 바꾸지 않는다.

**남은 완료 조건:** 통제 계정에서 EVM→Core 입금과 Core→EVM 회수의 실제 반영 블록·시스템 전송의 블록 내 순서·회수 실패(잔액 부족, 가스용 Core HYPE 부족, Circle 일시정지)를 관측해 `recallTimeoutBlocks`(10,000~2,000,000 Core 블록)와 `idleDustLimit`을 정한다. Core 블록 속도는 공개 관측 한 번(초당 약 14개)뿐이므로 다시 측정한다. Circle 입금이 다음 Core 블록까지 반영되지 않는 경우가 있는지 확인한다. 있다면 Deposit을 무조건 성공으로 보는 현재 판정은 그 금액이 빠진 NAV로 입금을 연다. 포기 뒤 늦은 도착과 다음 recall의 편입, agent 등록·해지의 실제 적용을 API로 대조한다. 등록 항목의 조회가 계속 실패할 때의 복구(ADR-029 결정 대기 A)를 정하고 필요하면 구현한다. 늦게 도착한 회수 금액은 Core가 거절하는 recall로만 편입되므로 그 운용 절차를 실측으로 확인한다. 활성화 입금이 부족하게 도착했을 때의 복구 경로는 Vault에 없으며 별도 설계가 필요하다. 독립 감사 뒤 배포 설정(`MANAGED_VERIFIER`, codehash)을 확정한다.

<a id="upgrade-001"></a>
## UPGRADE-001 — 커스텀 조건과 지속 가능한 upgrade

**진행:** 생성 시 커스텀 성과수수료·기본 10 USDC 최소 입금, Idle의 조건 변경, owner별 OZ Transparent proxy/ProxyAdmin·48시간 지연·Idle 실행·제안 취소를 구현했다. V2 fixture에서 같은 주소·지분/원가/요청/준비금/operator를 유지한 claim·다음 입금, 무권한/조기/Active/다른 config 거부와 recursive storage gate를 로컬 검증한다.

**남은 완료 조건:** 실제 production 새 구현의 의미·storage·migration 독립 검토, immutable Config 복원 manifest, 소액 메인넷 업그레이드 전후 전체 Core 주소/권리/다음 cycle 대조. 플랫폼 배분율 변경은 기본안에 포함하지 않는다. 업그레이드 권한이 자산·claim 코드도 바꿀 수 있는 신뢰 범위임을 상품에 표시한다. production verifier·실측 없이 전체 DONE으로 표시하지 않는다.

**FE가 의존하는 것과 그 한계 (2026-10-05):** Vault는 업그레이드할 수 있는 proxy이고 업그레이드 뒤에도 Factory의 `isVault`는 참이다. 그래서 FE는 Vault가 스스로 답하는 값(asset, controller)을 믿지 않고, Factory의 asset과 deployer가 그 Vault를 위해 만든 controller의 `implementation()`을 읽어 "생성 당시의 코드인지"를 판단한다. controller·첫 구현·proxy가 deployer nonce `3i`·`3i+1`·`3i+2`에 놓인다는 규칙은 [시험](../test/ManagedUsdcVault.t.sol)이 고정한다. **controller는 업그레이드 횟수를 기록하지 않는다.** 다른 구현으로 바꿨다가 처음 구현으로 되돌린 Vault는 FE에 변경 없음으로 보이고, 그 사이 storage가 바뀌었을 수 있다(두 번의 48시간 지연이 필요하다). 닫는 방법은 둘이다: controller에 실행 횟수를 추가한다(계약·bytecode 변경이므로 사용자 승인 사항), 또는 indexer가 controller의 `UpgradeExecuted` 이벤트를 수집해 FE에 제공한다(공식 RPC의 `eth_getLogs`는 조회 구간이 [50블록까지](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)여서 FE 혼자서는 전체 이력을 볼 수 없다).

<a id="core-001"></a>
## CORE-001 — PM 전환·자동 공급·bridge 상태 전이

기획: [PM 생명주기](plans/core-lifecycle.ko.md), [EX-01~03](plans/validation.ko.md#ex-01).

**문제:** 현재 `submitPortfolioMarginActivation()`, `advance()`, `_observeBridgeAndSupply()`는 raw spot bridge target을 확인한다. 자동 공급을 가정해 raw spot을 낮추면 진행·회수가 막힌다. 공개 정적 표본은 raw spot=0/supply>0을 보였지만 전환 전후 실험이 아니다.

**착수:** [Strategy](../src/HyperCoreStrategyAccount.sol)의 `startCycle`, 위 세 함수와 [Observer](../src/CoreActionObserver.sol)의 supply/withdraw 판정을 함께 검토한다. PM 전후 잔액 이동과 lending 상태 부재를 명시한 가설 테스트를 추가하고, 공식 ABI·계정 초기화 조건을 재확인한다. 조회 실패를 0으로 바꿔 통과시키지 않는다.

**2026-09-23 진행:** [로컬 모형](pm-lifecycle-model.ko.md)에 전액/부분/가스 포함 자동 공급, deadline/pause exit, 다음 cycle, 초기 read 실패를 재현했다. 이미 공급된 상태에서 별도 raw spot 유입으로 전액 공급을 추가 제출하던 조건은 [ADR-009](DECISIONS.ko.md#adr-009)의 진입 검사로 차단했다. 자동 공급 이후 진행·회수, 실제 PM 지연/실패, 원금·가스 귀속은 미해결이며 CORE-001 전체는 계속 IN_PROGRESS다. 검증 기록은 STATUS를 따른다.

**완료 조건:** 통제된 계정의 bridge→PM→공급/자동 공급→short→close→상환→회수→claim 원장과 전후 블록을 확보한다. 정상 왕복, PM 지연/실패, lending read 부재, 자동 공급, pause/마감 이후 회수를 설명하고 검증된 규칙으로 상태 전이를 맞춘다. 중복 공급·중복 hedge·cycle 간 자금 오인식이 없어야 한다. mock 재현만 끝났다면 항목 전체를 DONE으로 표시하지 않는다.

**근거:** [PM 실측](pm-nav-evidence.ko.md), [원시 carry 표본](reference/nav-pm-hype-carry-2026-09-21.json). 통제된 네트워크 관측에는 ENV-001이 필요하다.

<a id="env-001"></a>
## ENV-001 — 통제 가능한 테스트넷 운용 환경

기획: [실험 절차](plans/validation.ko.md), [배포·운영](plans/release-operations.ko.md).

**대기 이유:** 프로젝트가 통제하는 Strategy/Core 계정, 배포 주소와 실행 환경이 제공되지 않았다. 공개 표본 계정은 프로젝트 소유가 아니다. 현재 배포 스크립트는 31337만 허용한다.

**완료 조건:** chainId·RPC·컨트랙트 주소·역할·시장 metadata·테스트 자금/가스 준비와 실행 방식을 확인하고 재현 가능한 설정 및 거래/관측 기록을 남긴다. 비밀키·서명 비밀은 문서에 저장하지 않는다. fork/mock 실행과 실제 네트워크 CoreWriter 실행을 구분한다. 환경만 확보해도 전체 전략 검증이 끝난 것으로 표시하지 않는다.

<a id="core-002"></a>
## CORE-002 — 액션 최종성과 reject/zero-fill 복구

기획: [증거와 복구 모델](plans/action-recovery.ko.md).

**문제:** 현재 ExpectedEffect는 계정 효과다. 해당 cloid의 확정 receipt가 아니며 청산·외부 이동이 관측을 혼동시킬 수 있다. 무체결/거절 pending은 유지된다.

**완료 조건:** 성공·실패·아직 모름을 구분할 근거와 신뢰 모델을 명시한다. 늦은 체결·부분 체결·거절·무체결·외부 변화·청산에서 중복 실행 없는 복구를 검증한다. timeout 또는 HTTP 진단만으로 재시도 권한을 만들지 않는다. 새로운 attestation 모델을 선택하면 DECISIONS와 권한 명세를 함께 갱신한다. [현재 판정표](core-action-recovery.ko.md)

<a id="core-003"></a>
## CORE-003 — recall의 실제 수신과 순수령액

기획: [recall 원장](plans/action-recovery.ko.md), [EX-06](plans/validation.ko.md#ex-06).

**문제:** 현재 지정 sender와 요청 gross 금액 전체 수신을 요구한다. 실제 callback sender·전송 비용·net 금액은 미검증이다.

**완료 조건:** 통제된 전후 관측으로 sender·비용·수신 패턴을 확인하고, 부분/늦은 수신·강제 native 전송·재실행에서도 cycle 자금을 중복 인정하지 않는다. 실제 WHYPE 증가량으로 최종 반환/정산한다. 수신 기록과 terminal 검사를 분리한 동작을 유지한다.

<a id="core-004"></a>
## CORE-004 — quote sub-lot dust 귀속

기획: [소유권·dust 대안](plans/accounting-fees.ko.md).

**문제:** 잔여 quote가 terminal 정산을 막을 수 있다. 현재 다음 cycle로 무조건 넘기지 않는다.

**완료 조건:** 거래 최소 단위보다 작은 자산·부채의 처분/상환 경로, 비용, 이전 주주 귀속을 결정한다. 처리 불가능한 잔액을 숨기지 않으며 신규 주주와 손익을 섞지 않는다. 작은 잔액이 남은 회수·마지막 청구자·다음 cycle을 테스트한다.

<a id="core-005"></a>
## CORE-005 — 가스 후원·소모·top-up 회계

기획: [가스 후원 원장](plans/accounting-fees.ko.md), [위험·파라미터](plans/risk-parameters.ko.md).

**문제:** 초기 sponsorship cap과 고정 reserve floor만 있다. 가스 실제 소모, 운용 중 보충, 후원금과 주주 자산 귀속은 미완성이다. 같은 PM 계정의 예비금은 청산으로부터 물리적으로 분리되지 않는다.

**완료 조건:** 후원금·소모·보충·회수/잔여금·손실 귀속을 원장으로 정의한다. NAV와 Core terminal 검사가 같은 소유권 모델을 쓰고 reserve를 중복 차감하지 않는다. 가스 소진 및 청산 사례를 포함한다.

<a id="core-006"></a>
## CORE-006 — PM health·청산·극단 손실 대응

기획: [위험 신호와 축소 정책](plans/risk-parameters.ko.md).

**완료 조건:** 검증된 health 관측으로 조기 축소와 위험 제한을 정의한다. 가격 급변·부채 증가·청산·유동성 부족·전손에서도 상태와 회계가 맞고 확정 claim 준비금이 다른 위험에 사용되지 않는다. 기존 recap cap과 guardian/permissionless exit의 관계를 명시한다.

<a id="nav-001"></a>
## NAV-001 — 생산용 HyperCore balance-sheet source

기획: [필드 매핑·완전성·freshness](plans/nav-source.ko.md).

**2026-10-04 진행:** [HyperCorePrecompileSource](../src/nav/HyperCorePrecompileSource.sol)를 Vault별 owner 등록 범위·버전·입금 스위치와 모드 무관 단일 평가식으로 다시 구현했다. 공개 계정 16개의 블록 고정 관측에서 API 통합 잔액이 raw spot·lending·DEX별 equity의 합과 일치했고 DEX 사이 중복은 없었다. 가격은 reserve oracle(spot mark와 2% 이내) 또는 spot mark(호가 안·spread 1%)이며 timestamp 필드는 제거했다. HyperCore vault equity를 포함한다. 음의 DEX equity와 집계하지 않는 lending 장부는 발행을 닫는다. 범위 상한은 token 6·DEX 8·vault 2이고 공식 비용식의 [gas 모형](../test/ManagedNavGas.t.sol)에서 `mint`까지 소형 블록에 들어간다. [현행 명세](managed-precompile-nav.ko.md), [관측](managed-precompile-evidence.ko.md#raw-ledger-identity), [ADR-029](DECISIONS.ko.md#adr-029).

**남은 완료 조건:** 프로젝트가 통제하는 Vault 계정에서 같은 항등식을 거래 전후로 대조한다(Unified·PM 각각, 모드 전환 직후, isolated 변경, funding 정산 시각, 청산). lending 플래그를 켠 뒤 공급·PM 전환까지의 평가 실패 구간과 등록 순서, PM에서 수신 잔액이 자동 공급되어 `lending=false` token의 평가가 닫히는 조건을 실제 절차로 확인한다. 개별 precompile 조회의 비용은 mainnet에서 읽기 전용으로 측정했다(성공한 lending 조회 7,336 gas, 장부 확인 호출의 한도는 20,000; [관측](managed-precompile-evidence.ko.md#precompile-gas)). 남은 것은 실제 Vault 거래의 측정이다: 최대 범위 입금·`mint`의 gas와 precompile 주소의 cold 접근 비용을 small block 한도와 비교하고, 조회 비용이 다른 날에도 같은지 다시 측정한다. spot 호가로만 평가되는 토큰의 처리(ADR-029 결정 대기 B: 현행 유지, reserve token만 허용, 비중 상한)를 정하고 조작 비용 기준을 [RISK-001](#risk-001)에 남긴다. lot이 큰 토큰의 1 lot 미만 잔량이 종료 검사에서 0으로 처리되는 범위를 제한할지 정한다. **미등록 보유로 인한 지분 희석:** 신고(`reportToken`·`reportDex`·`reportCoreVault`)와 급락 대기(`recordPrice`·가격 창)를 로컬 구현했다. 남은 것은 신고를 실제로 수행할 감시 봇과 가격 기록 keeper([OPS-001](#ops-001)), `priceWindow`·`maxDrawdownBps`의 배포 값(실제 변동성에서 입금이 얼마나 자주 닫히는지 측정), API wallet이 계약 계정에서 실제로 할 수 있는 동작의 확인, 신고 대상이 아닌 outcome·sub-account의 처리, **발행자가 동결한 token 잔액을 팔 수 있는지의 테스트넷 확인**(팔 수 없다면 그런 token으로 신고를 비용 없이 유지할 수 있다. ADR-029 결정 대기 E), 그리고 **신고의 순서 경쟁**이다(신고는 지금 성립할 때만 Vault를 닫고 보관되는 신고는 한 건이어서, owner가 신고된 대상을 Core에서 비우거나 숨긴 가치를 다른 미등록 대상으로 옮긴 뒤 그것이 반영된 첫 블록에 감시자의 다음 신고보다 먼저 입금할 수 있다. 증명 뒤 일정 시간 닫아 두는 방법은 무비용 방해를 열어 넣지 않았다. ADR-029 결정 대기 F). 한쪽 호가가 빈 시장에서 `bbo`가 0을 반환한다는 전제는 한 블록·일곱 pair로만 관측했으므로([관측](managed-precompile-evidence.ko.md#empty-book)) 다른 날에 다시 확인한다. 감시 봇 없이는 급락 대기가 시간만 벌 뿐이므로 봇이 운영되기 전에는 운용 중 입금을 열지 않는다. 미지원 대상(HIP-4 비제로 수량·정산, USDC 외 담보 DEX 단위, staking, sub-account)은 근거를 확보한 뒤 별도로 추가한다. FE에 등록 범위·버전·평가 실패 사유와 "목록 완전성은 운용자 책임"을 표시한다. verifier 배포 설정과 독립 검토를 마친다. 표본 일치만으로 완료하지 않는다. legacy source의 [기존 수식](nav-liquidity-architecture.ko.md)을 그대로 복사하지 않는다.

<a id="std-001"></a>
## STD-001 — ERC7540/7575 적합성 검토

기획: [보안·표준 검토](plans/security-standards.ko.md).

**진행:** 2026-09-21~22 [표준 검토 보고서](standards-review.ko.md)와 추가 테스트를 작성했다. 주요 인터페이스·권한·이벤트·epoch·preview를 확인했고 STD-002/003의 한도·0 전송 항목은 수정·회귀 검증했다. 양수 직접 전송 제한을 포함한 전체 조항별 대조 마무리는 남아 IN_PROGRESS로 유지한다. 현재 부분 검토·테스트 통과를 완전 준수 인증으로 표현하지 않는다.

**완료 조건:** 공식 표준의 MUST/SHOULD 조항을 selector·interface ID·이벤트·operator·controller·requestId·부분 claim·동일 epoch 환율·preview/max 동작과 대조한다. 구현/테스트 근거와 남은 편차를 기록한다. OZ 사용 자체를 적합성 인증으로 표현하지 않는다.

<a id="std-002"></a>
## STD-002 — maxDeposit과 최소 발행 조건 일치

**수정 전 문제:** [STD-F01](standards-review.ko.md#std-f01--maxdeposit이-실행-불가능한-입금-한도를-광고함)의 donation/cap 경계에서 `maxDeposit=1`, `previewDeposit(1)=0`이고 입금은 revert했다. ERC4626 한도 요구사항과 불일치했다. 보고서의 최초 심각도 P2와 이 백로그의 운용 전 작업 우선순위 P1은 별도 척도다.

**완료 조건:** zero-share 입금 거부를 유지하면서 cap 내 양의 shares를 발행할 수 없는 경우 `maxDeposit`을 0으로 맞춘다. 알려진 반례 테스트를 수정 완료 회귀로 전환하고 donation·소액 cap·기존 shares·일반 최대 입금·maxMint와의 관계를 검증한다. 전체 회귀·빌드 크기를 확인하고 보고서와 현행 명세를 갱신한다.

**완료 근거 (2026-09-21):** capacity의 preview가 0이면 한도를 0으로 반환하도록 수정했다. 회귀 기대값이 기존 코드에서 실패하고 수정 후 통과함을 확인했으며, 최소 share 경계·준비금·cap/초기 입금/기부금 fuzz로 한도 실행과 초과 거부를 검증했다. 전체 회귀·포맷·빌드 크기 검사 통과. [실행 결과](STATUS.ko.md), [변경 명세](split-implementation.ko.md). ABI·storage layout은 유지하고 해당 경계의 revert는 `CapitalClosed`로 맞췄다.

<a id="std-003"></a>
## STD-003 — Vault로의 0 share 전송 호환성

**수정 전 문제:** [표준 검토의 STD-C01](standards-review.ko.md#std-c01--vault-주소로의-0-share-전송도-제한됨). request escrow 외 직접 share 전송을 막는 규칙이 0 전송에도 적용됐다. 일반 사용자 간 0 전송은 성공했다. ERC20의 zero-transfer 조항과 ERC4626의 전송 제한 허용 범위를 함께 검토했다.

**완료 조건:** 제한된 share 전송 정책과 통합 시 표시를 확정한다. 0 전송만 허용하는 안을 채택하면 양수 직접 전송 차단·request escrow·Transfer 이벤트·transferFrom allowance·burn 경계를 검증한다. 의도적 제한을 유지하면 근거와 호환성 제약을 명시한다. 정책 검토 전 확정 결함 수정이나 무제한 ERC20 호환성을 주장하지 않는다.

**완료 근거 (2026-09-22):** [ADR-008](DECISIONS.ko.md#adr-008)에 따라 양수에만 custody guard를 적용하고 0 전송은 OZ 이벤트 경로로 처리한다. 수정 전 실패/수정 후 통과, 이벤트·allowance fuzz·요청/준비금 불변·양수 우회 차단·정산 burn/claim·pause/shutdown·zero-address 검증과 전체 회귀·포맷·크기 검사를 완료했다. 양수 목적지/출처 제한은 현행 명세에 유지한다. [실행 결과](STATUS.ko.md)

<a id="rel-001"></a>
## REL-001 — 네트워크 배포와 운용 인계 기준

기획: [배포·운영·이전 절차](plans/release-operations.ko.md).

**완료 조건:** 선행 통합 항목을 해결하고 실제 환경의 token/market index·단위·역할·cap·비용·bytecode를 검증한다. 제한된 왕복 실행 기록과 독립 보안 검토 결과, 재현 가능한 배포 manifest 및 운용 절차를 남긴다. manifest에는 실제 chain/address/config/검증 근거만 기록한다. 현재 테스트 통과나 31337 guard 제거만으로 완료하지 않는다.

<a id="vault-001"></a>
## VAULT-001 — Active 동기 입금

**진행:** Managed Ready/Active의 입금 전 검증 NAV·즉시 mint·실패 gate를 구현하고 손익·기부·nonce/block·순차 입금·slippage rollback을 mock으로 검증했다. 2026-10-04 실제 Factory·Vault에 precompile 검증기를 연결한 [종단 시험](../test/ManagedLiveNav.t.sol)에서 활성화→범위 등록→운용 중 입금→Core 배정→손익 반영→회수→종료 정산을 확인했다. `mint`·`depositWithLimit`, 평가 불가 상태(DEX 결손·집계하지 않는 장부·조회 실패·가격 가드)의 전 입금 경로 차단과 재개, 두 Vault의 격리도 같은 시험에 있다. precompile 응답은 주입값이며, 통제 왕복과 정책 확정([NAV-001](#nav-001), [VERIFIER-001](#verifier-001)) 전에는 실제 운용 중 입금을 열지 않는다. 얇은 spot 시장의 가격 조작에 대한 발행 보호(진입 수수료·한도·lock-up)는 정하지 않았다. 평가는 EVM 블록 구성 시점의 Core 상태이므로 최대 한 블록 뒤처진 가격으로 발행된다.

기획: [발행 가격·실행 순서·view 함수](plans/active-deposits.ko.md).

**완료 조건:** 입금 트랜잭션 안에서 입금 직전의 검증된 NAV로 mint한다. 캐시/원금 추정치를 발행 가격으로 사용하지 않는다. 기존/신규 주주의 손익 이전, 순서, pending, stale source, 0 이하 순자산, 소액 반올림, 가격 조작을 검증한다. `minShares/deadline`과 입금 한도를 유지한다.

<a id="liq-001"></a>
## LIQ-001 — 유동성 buffer와 부분 회수

기획: [동일 epoch 전체 fulfillment와 부분 전략 회수](plans/liquidity-exits.ko.md).

**완료 조건:** [ADR-012](DECISIONS.ko.md#adr-012)의 첫 배포 후보는 목표 운용 buffer 0과 전량 회수 후 claim으로 별도 검증한다. 이 항목은 더 빠른/부분 출금을 도입할 때 claim 준비금·주주 buffer·recap 예산을 분리한다. 같은 requestId를 동일 가격/비율로 처리하고 선착순 손실 회피가 생기지 않게 한다. 부족분만 부분 close→담보 회수→상환→recall하며 남은 포지션의 hedge·margin·가스를 검사한다. 전량 종료와 부분 회수 상태를 구분한다.

<a id="strat-001"></a>
## STRAT-001 — 외부 다중 전략

기획: [adapter·배분·USDC 상품 경계](plans/multistrategy.ko.md).

**완료 조건:** LIQ-001 이후 외부 lending/LP 등 Core 시장 거래 밖의 구체적 대상과 배분·손실·회수·NAV source 계약을 설계하고 별도 custody adapter로 검증한다. spot·HIP-3·HIP-4는 MARKET-001의 첫 상품 요구이며 이 항목으로 미루지 않는다. 아직 외부 프로토콜이나 비중은 확정하지 않았다.

<a id="prod-001"></a>
## PROD-001 — 상품 정책 구체화

기획: [상품 요구사항](plans/product.ko.md), [열린 결정](plans/README.md). 완료 조건: 출시 단계·기준 자산·수수료/비용·성과 통화·요청 제약을 실제 제공 기능과 연결하고 필요한 정책을 DECISIONS에 기록한다. 초안의 권장값을 사용자 확정 요구로 확대하지 않는다.

<a id="risk-001"></a>
## RISK-001 — 파라미터 profile과 스트레스 보정

기획: [파라미터 명세](plans/risk-parameters.ko.md). 완료 조건: 단위/시장·계정 범위가 있는 profile, 검증 근거, 경계·스트레스 시험을 만든다. script 예시를 production 기본값으로 쓰지 않는다. health feed가 미확정이면 해당 자동 위험 동작도 미완료로 유지한다.

<a id="ops-001"></a>
## OPS-001 — Indexer와 keeper

기획: [운영 서비스](plans/keeper-indexer.ko.md). 완료 조건: read-only 수집/replay→dry-run→통제된 실행 순서로 구현하고 reorg·재시작·복수 keeper·tx replacement·Core 지연을 검증한다. DB/HTTP가 NAV나 pending 초기화의 신뢰 원천이 되지 않는다.

**Managed 발행 보호에 필요한 두 역할 (2026-10-05 추가, 판단 부분만 구현):** [명세](managed-precompile-nav.ko.md#미등록-보유-신고)의 장치는 누군가 호출해야 작동한다. (1) **감시:** 공개 API로 Vault Core 계정의 spot·lending·DEX별 perp·HyperCore vault·sub-account를 열거해 등록 범위와 비교하고, 범위 밖 보유를 `reportToken`·`reportDex`·`reportCoreVault`로 신고하며 소멸 전에 갱신한다. 계약이 보관하는 신고는 한 건이고 성립하는 동안 자리를 지키므로, 자리가 비어 있을 때 받아들여지는 대상 중 가장 큰 곳 하나를 올리고, 보관된 신고가 성립하지 않게 되면(보유가 옮겨지거나 owner가 그 대상을 등록하면) 바로 다음 대상을 신고한다. 등록된 token도 등록된 pair가 그 보유를 사 주지 않으면 신고할 수 있으므로, 등록된 token의 보유는 다른 pair를 거치는 신고 후보로 함께 낸다. 성립하지 않게 된 신고는 `clearReport`로 정리한다(정리하지 않아도 Vault는 열리지만 평가 gas가 든다). (2) **가격 기록:** Vault마다 `priceWindow / 4` 간격으로 `recordPrice`를 호출하고, 그 사이에도 직전 기록이 현재 가격보다 뚜렷이 낮으면 바로 기록해 표본을 되돌린다. 기록이 끊기면 입금이 닫히고 **종료 정산도 기록 뒤 반 창을 기다리게 되며**, 되돌리지 않으면 낮은 표본으로 급락 대기를 우회할 수 있다. 기록은 신고가 성립하는 동안, 관리 액션이 pending인 동안, 종료 중에도 계속한다. owner가 신고된 대상을 등록해 신고가 풀린 뒤에는 그 뒤의 기록만 이력으로 세므로, 직전 기록에서 `priceWindow / 8`이 지나는 대로 기록한다(그 안에서는 기록이 직전 기록의 가격만 바꾸고 시각은 그대로여서 이력이 되지 않는다). 둘 다 누구나 실행할 수 있고 신뢰 대상이 아니다.

- **구현된 것:** [scope_watch.py](../scripts/scope_watch.py)가 위 열거·비교와 호출 구성, 가격 기록 시점 판단을 하고, source·verifier가 배포돼 있으면 각 호출을 고정 블록의 `eth_call`로 시뮬레이션해 계약이 받아들이는 것만 `toSend`로 낸다. 서명·전송은 하지 않는다. 보낼 신고는 많아야 한 건으로 고른다(API 수치로 가장 커 보이는 대상, 보관된 신고가 이미 그곳이면 소멸이 가까울 때만). 오프라인 회귀와 공개 계정 1개에 대한 읽기 전용 실행([자료](reference/managed-scope-watch-2026-10-05.json), 가정한 범위)으로 확인했다.
- **남은 것:** 거래 전송(gas를 가진 키, nonce·재시도·replacement), 주기 실행과 여러 Vault 순회, 신고의 순서 경쟁에서 지지 않기 위한 빠른 재신고(보관된 신고가 성립하지 않게 된 것을 블록 단위로 감지해 다음 대상을 바로 신고), 알림(신고할 수 없는 보유·USDC 외 담보 DEX 경고, 등록 범위를 평가할 수 없어 가격 기록이 거부되는 상태가 이어지는 Vault), 배포된 source·verifier에 대한 시뮬레이션 경로의 실제 확인(지금은 주입한 응답으로만 시험), RPC의 revert 오류 형식 확인, HIP-4 outcome 잔액이 API에 어떻게 나타나는지 확인. 감시가 운영되기 전에는 운용 중 입금을 열지 않는다.

<a id="ux-001"></a>
## UX-001 — 사용자·운영 화면

**진행:** [FE](../frontend/README.ko.md)에 이름/커스텀 조건 생성, 입금/request/claim, owner 관리, demo/계약 모드, NAV 실패와 지갑 변경 처리를 구현했다. 2026-10-05 사용자 요청으로 볼트 탐색(Factory의 전체 볼트 목록), 볼트별 화면의 평가 범위 등록·신고·가격 기록, 운용자 주문([ADR-031](DECISIONS.ko.md#adr-031)), 대화([ADR-032](DECISIONS.ko.md#adr-032), [CHAT-001](#chat-001))를 추가했다. **남은 것:** 배포된 계약과 실제 지갑으로 하는 종단 확인(지금까지는 데모 모드와 주입한 RPC 응답으로만 확인했다), 주문 전송의 실제 확인([MARKET-002](#market-002)), indexer 기반 화면, 평가가 닫힌 사유와 "등록 범위의 완전성은 운용자 책임" 고지의 문구 확정, 번들 분할. 보안 리뷰 뒤에 남은 것: 호스팅 쪽에서 `frame-ancestors` 응답 헤더 설정(문서 안의 정책으로는 지정할 수 없다. 화면은 다른 origin의 frame 안에서 실행을 거부하는 것으로 보완한다), 기본 RPC의 요청 한도가 실제로 어떻게 적용되는지 확인하고 운영용 RPC endpoint 정하기(화면은 탭마다 분당 48~64건을 보낸다), 지갑 확장을 쓴 실제 브라우저와 macOS 외 환경의 화면 확인, 업그레이드 이력 표시([UPGRADE-001](#upgrade-001)), 범위 밖 보유를 신고하는 화면(지금은 감시 스크립트의 일이다), **범위 밖 token을 화면에서 팔 수 없다는 점**(거래 탭은 등록된 시장만 제공한다. 누군가 미등록 token을 Vault에 보내고 신고하면, 화면에서의 출구는 그 token을 등록하는 것뿐이고 그것이 신고를 풀면 가격 이력이 다시 시작된다. USDC pair가 없는 token은 등록할 수도 없어 손으로 등록한 API wallet과 다른 client가 필요하다. 보유 수량 이내의 매도 전용 주문을 범위 밖 token에도 허용할지 정한다. 계정 모드에 따라 그런 매도가 차입을 일으킬 수 있는지는 확인하지 않았다), 키 보관 방식과 암호 정책의 사용자 확정([ADR-031](DECISIONS.ko.md#adr-031)).

기획: [화면·read API](plans/frontend.ko.md). 완료 조건: 현재 ABI로 입금→request→claim과 고정 수령자 흐름을 실행하고 상태/가격 품질·지연·권한·실패를 정확히 표시한다. indexer lag와 평가 불가가 잘못된 거래 안내로 이어지지 않는다.

<a id="chat-001"></a>
## CHAT-001 — Vault별 대화 서버

설계: [ADR-032](DECISIONS.ko.md#adr-032), [서버 안내](../server/README.ko.md). 2026-10-05 사용자 요청("볼트 배포자와 유저가 대화할 수 있는 장소")으로 추가했다.

**구현된 것 (로컬):** Vault 주소별 대화방, EIP-712 지갑 서명 로그인(서버의 `CHAT_AUDIENCE`에 묶임)과 12시간 토큰, 체인에서 읽는 역할(운용자·예치자·방문자), 운용자·예치자만 쓰는 기본 정책, 운용자와 관리자 주소의 숨김, 작성 속도 제한, SQLite 저장. FE의 대화 탭이 이 서버를 쓴다. 시험은 stub 체인과 메모리 DB로 한다.

**남은 완료 조건:** 호스팅과 도메인·TLS, `SESSION_SECRET`·관리자 주소의 보관과 교체 절차, DB 백업과 보존 기간, 개인정보·이용 고지, 다중 지갑 스팸과 신고 처리(지금은 속도 제한과 숨김뿐이다), 프록시 뒤에서의 속도 제한 기준, 배포된 Factory에 대한 실제 역할 조회 확인, 컨트랙트 지갑 로그인 지원 여부, 작성 정책(예치자 한정 또는 공개)과 운용자 숨김 권한의 사용자 확정. 대화 내용은 NAV·권한·투자 판단의 근거가 아니며 화면에 그렇게 표시한다.

<a id="sec-001"></a>
## SEC-001 — 위협 검토와 감사 인계

기획: [보안 검토](plans/security-standards.ko.md). 완료 조건: 위협별 재현·수정·회귀·남은 가정을 기록하고 배포 후보 코드/설정/명세/원장을 독립 검토에 제공한다. 정적 검토만으로 독립 감사 완료를 표시하지 않는다.

<a id="qa-001"></a>
## QA-001 — 요구사항 추적 시험과 실험 기록

기획: [REQ 시험 행렬과 EX 실험](plans/validation.ko.md). 완료 조건: 각 요구사항의 모델 시험·필요 실측·미실행 이유를 추적하고 원시 자료와 결론을 재현 가능하게 남긴다. PASS_IN_MODEL과 PASS_OBSERVED를 구분하며 production 조건이 남으면 다른 기능 항목을 완료 처리하지 않는다.

<a id="zpi-001"></a>
## ZPI-001 — Zcash 비공개 인텐트 첫 오프라인 모형

**완료 (2026-10-04):** [연구 명세](zcash-private-intents.ko.md)와 [로컬 회계 모형](../scripts/private_intents_model.py)에 ZEC 입금→환전→Core credit→주문/부분 체결→개인별 손익→공동 잔액 대조→지급의 독립 경계를 기록했다. [공동 주문 배분 모형](../scripts/private_intents_batch.py)은 같은 시장·방향의 정수 lot 부분 체결과 거래비를 사용자에게 결정적으로 나눈다. [회계](../test/python/test_private_intents_model.py), [배분](../test/python/test_private_intents_batch.py), [통합 테스트](../test/python/test_private_intents_integration.py)는 두 사용자, 중복 영수증, 늦은 체결, 손실·출금 잠금, 무거래 환급, 하나의 공개 진입 주문에서 개인별 장부·공동 잔액 대조까지 재현한다. 모든 외부 영수증은 mock 입력이며 서명·Zcash/Hyperliquid 연결·네트워크 검증은 포함하지 않는다.

<a id="zpi-002"></a>
## ZPI-002 — shielded 입금과 사용자 권리 증거

**2026-10-04 진행:** Zcash testnet shielded 수신 지갑과 Hyperliquid testnet EVM 주소를 저장소 밖에 생성했다. Zcash lightwallet 동기화·Hyperliquid 빈 계정 API 조회를 확인했다. 무료 TAZ faucet의 1 TAZ 요청은 confirmed이고 지갑은 동일 txid의 Ironwood note를 블록 4,455,091에서 관측했다. tip 4,455,104에서 1 TAZ의 표준 지출 가능액도 확인했다. faucet에 제출한 CLI Orchard 수신 주소 출력과 지갑의 Ironwood note 분류 차이를 독립 확인해야 한다. viewing key만 사용한 별도 scanner, note의 인텐트 귀속·중복 방지·환불 권리는 아직 없다. Hyperliquid mock USDC는 공식 faucet의 동일 주소 mainnet 입금 조건 때문에 확보하지 못했다. testnet 키와 두 공개 주소의 연결을 문서나 fixture에 넣지 않는다.

**완료 조건:** 통제된 Zcash 지갑의 shielded 수신을 viewing key로 관측하고 금액·인텐트 귀속·최종성·중복 방지·환불 권리의 증거 범위를 정의한다. 일회용 인텐트 키 서명 검증과 암호화 메모/권리 연결을 독립 검토한다. 원시 지출키·비밀키를 문서나 fixture에 저장하지 않는다. 조회 실패를 미입금 0으로 치환하지 않는다. 표준 shielded ZEC만으로 조건부 스마트 계약 escrow가 된다고 가정하지 않는다.

<a id="zpi-003"></a>
## ZPI-003 — 공동 계정 체결·자산과 개인별 채무 대조

**완료 조건:** 통제 계정의 주문 ID별 제출·부분 체결·취소·늦은 체결·청산과 전체 Core 자산·부채·펀딩·수수료를 같은 범위와 시점으로 수집한다. 공동 주문의 체결 전 배분 약속, 정수 lot·수수료·rebate·상계 규칙과 사용자별 검증 가능성을 정의하고 오프라인 진입 배분 모형을 실제 영수증·청산 배치까지 연결한다. 개인별 장부 합계와 독립 관측 equity를 대조하고 누락·읽기 실패에서 지급을 잠근다. mock 합계 일치나 일부 공개 계정 표본을 생산용 지급 능력 증명으로 표시하지 않는다.

<a id="zpi-004"></a>
## ZPI-004 — 수탁·솔버 실패·지급 권리

**완료 조건:** ZEC 지출키 보관/임계 서명, 솔버의 이행 담보, 입금 후 견적 만료·환전 실패·Core 미수령·출금 지연의 환불/손실 귀속을 결정한다. 운영자 부재·검열·공동 계정 손실에서도 사용자가 무엇을 청구할 수 있는지 증명한다. FROST만으로 사용자 단독 탈출을 주장하지 않는다.

<a id="zpi-005"></a>
## ZPI-005 — 프라이버시 누출 측정

**완료 조건:** 배치 크기·금액·시각·단일 사용자 거래·고유 시장에서 공개 HyperCore 주문과 Zcash 입출금을 연결하는 공격을 모의한다. 공개 관찰자, 솔버, 운영자 각각의 관측 범위를 기록하고 제품의 프라이버시 설명을 측정 결과에 제한한다.

## 완료 기록

| ID | 상태·기록일 | 완료 범위와 근거 |
| --- | --- | --- |
| [ARCH-001](#arch-001) | DONE · 2026-10-02 | 프로젝트 아키텍처 기준선과 단계별 차단 조건 문서화. [기준선](vault-architecture.ko.md) |
| [STD-003](#std-003) | DONE · 2026-09-22 | Vault가 포함된 0 share 전송과 이벤트 허용, 양수 custody 보호·정산 회귀. [ADR-008](DECISIONS.ko.md#adr-008), [검토 기록](standards-review.ko.md) |
| [STD-002](#std-002) | DONE · 2026-09-21 | zero-share capacity에서 maxDeposit=0, 한도 실행·초과 거부·준비금·donation 회귀. [검토·수정 기록](standards-review.ko.md), 결과는 [STATUS](STATUS.ko.md) |
| FIX-001 | DONE · 2026-09-21 | position raw lots → 주문 단위 정규화, overflow 및 중복 hedge/close 회귀. [실측·수정](pm-nav-evidence.ko.md), 검증 결과는 [STATUS](STATUS.ko.md) |
| OBS-001 | DONE · 2026-09-21 | raw reader, 고정 블록 probe, 오프라인 PM 표본 대조. 생산용 NAV는 포함하지 않음. [출처](reference/README.md) |
| DOC-001 | DONE · 2026-09-21 | 핸드오버·문서별 SSOT·변경 이력·갱신 규칙. [문서 안내](README.md) |
| DOC-002 | DONE · 2026-09-21 | 분야별 기획 14개·요구사항/정책/가정/실험 매핑·JSON 예시 3개 작성. [기획 패키지](plans/README.md). 코드·실험·정책 채택 완료는 포함하지 않음 |

이관 이전의 구현은 [CHANGELOG](../CHANGELOG.md)에 요약했다. 현재 테스트가 통과한다고 미완료 통합 항목을 완료 처리하지 않는다.

<a id="asset-001"></a>
## ASSET-001 — 자산별 USDC/HYPE/UBTC Vault

**2026-10-11 추가:** ADR-034로 공개 Factory에서 [직접 배포](direct-vaults.ko.md) 경로로 변경. 직접 배포·owner bootstrap script, manifest 기반 기본 FE, 선점/중복 초기화·활성화 실패 롤백 회귀를 추가했다. 아래 완료 범위의 Factory는 이전 구현 기록이다. 남은 배포·주소/codehash 고정·실지갑 검증은 직접 Vault 기준으로 수행한다. 신규 주문·채팅 연결도 Factory 탐색 없이 manifest를 사용하도록 바꿔야 한다. HYPE/BTC 자동 PM 전략 실행·실계정 위험 제어는 완료 범위에 포함되지 않는다.


**IN_PROGRESS · 로컬 구현 완료, 네트워크 통제 왕복·출시 gate 대기 (2026-10-11).** [ADR-033](DECISIONS.ko.md#adr-033), [구현 명세](managed-asset-vault.ko.md).

완료한 범위: 자산별 공개 Factory, 동일 Vault/Core 주소, 원금 즉시 지분 발행, 별도 USDC 활성화, 예약 배정, asset별 bridge와 native HYPE Router, 기준 자산 NAV와 수수료, upgrade 기록, 기본 FE·배포 script·읽기 전용 mainnet metadata probe. mock 기반 입출금·수수료·단위·NAV·upgrade 회귀는 STATUS에 기록한다.

남은 완료 조건:

1. 세 자산 모두 통제한 신규 Core 활성화·실제 비제로 왕복·수령 gas·시스템 재고·실제 agent 주문 귀속을 확인한다.
2. Standard/Unified/PM에서 기준 자산 및 USDC 장부를 동시에 대조하고, 범위 누락·상방 가격 조작·읽기 실패 복구 등 기존 ADR-029의 미결 조건을 닫는다. 새 자산 verifier의 최대 scope mint gas도 측정한다.
3. 독립 보안 감사와 리뷰된 모듈·Factory 배포, 주소·codehash 고정, FE 실지갑 시나리오. 현재 실제 배포 주소·운영 keeper는 없다.
4. FE 기본 범위 외의 HIP-3·추가 spot 편집 및 새 Factory의 agent 주문·채팅 화면 통합. 현재 자산별 기본 화면은 생성·입출금·관리·기본 범위·가격 기록을 제공하며 기존 USDC의 주문·채팅 화면은 이전 Factory용이다.

신규 Factory는 선제 활성화만으로 생성이 막히는 경우를 허용한다. 기존 Factory의 FACTORY-001 결함까지 수정한 것으로 해석하지 않는다. 새 코드가 기존 USDC 주소의 자동 migration을 제공하지 않는다.


<a id="hv-001"></a>
## HV-001 — HyperVault 해커톤 프로토타입

**IN_PROGRESS · 2026-10-12.** [ADR-035](DECISIONS.ko.md#adr-035), [명세](hypervault.ko.md), [제출 패키지](hypervault-submission.md), 결과는 [STATUS](STATUS.ko.md#hypervault).

완료: USDC Vault 1개 메인넷 배포·검증, EVM 경로 활성화, 왕복 3회(owner seed, 별도 예치자, Active NAV 입금·Idle 즉시 출금), ERC-7540 대조, 영문 구조 문서, 버퍼 운영 정책(ADR-036), agent 주문 귀속, 현물/숏 헤지·펀딩 수령·청산, NAV 대 Core 장부 대조, 회수·정산·claim·수수료(손실 0) 확인, 감시 12규칙·keeper·AI 요약 루프 실행, HyperVault FE 실 Vault 연결과 Vercel 설정 준비.

남은 일:

1. ~~Vercel 배포·외부 접근·헤더 확인~~ 완료(`https://hypervault-plum.vercel.app`). 남은 것: `vault.hypurrquant.com` 연결(현재 Vercel 계정에 도메인 권한 없음: 대시보드에서 TXT 소유 확인 + Cloudflare CNAME 필요), 실지갑 입금·출금·claim을 FE로 1회 확인.
2. pitch·데모 영상, 공개 repo URL, 팀 정보 제출(사용자). Colosseum 대시보드에서 마감·필수 항목 재확인과 최종 제출.
3. 출시 전 별도: 버퍼 기반 즉시 부분 출금(ADR-036 제안, 새 Vault), HYPE/UBTC Vault 메인넷 왕복, PM 자격 규모의 차입 경로 실측, 팔 수 없는 gas 예비금 처리 방식, keeper/monitor 상시 운영, 독립 감사.

## kHYPE 자동 버퍼 참고 (2026-10-12)

외부 계약의 [입금·버퍼 배분 문서](khype-deposit-buffer.ko.md) 작성 완료. 우리 Vault의 자동 목표 버퍼·즉시 출금 풀 도입은 미채택/미구현이다. 추후 LIQ-001 검토 시 claim 준비금·주주 현금·미도착 회수액을 분리하고 목표 정책·실패 처리를 정한다. 이번 문서 작성으로 LIQ-001 완료 상태를 변경하지 않는다.

<a id="hv-002"></a>
## HV-002 — HyperVault v2: 지분 토큰·매니저·어카운턴트

**IN_PROGRESS · 2026-10-12.** [ADR-037](DECISIONS.ko.md#adr-037), 결과는 [STATUS](STATUS.ko.md#hypervault).

완료: 계약 3개와 배포 스크립트, 시험 20(기부 방어 포함), 리뷰 F1·F2 수정, USDC v2 메인넷 배포·검증, 왕복 1회(양도·HWM 과금·급등 대기·Active 입금·비동기 출금·Idle 출금), 운영 도구 `HV_VERSION=v2`, FE v2 manifest·표시·Vercel 재배포.

남은 일:

1. ~~실거래 수익 과금~~ v3 run 2에서 HYPE 가격 이익 0.0085에 수수료 0.00085 발행(소액). ~~API wallet 수동 차입~~ v3 run 2에서 supply·borrow·repay·withdraw 확인. 남은 것: 차입 USDC로 추가 현물 매수 + 같은 양 short(HYPE/BTC Vault 전략)를 최소 주문 이상 규모로 실행, 차입 USDC의 EVM 회수 가능 여부.
2. ~~실 verifier 통합 시험~~ v3 모듈로 `test/HyperVaultNav.t.sol` 추가. ~~수수료 발행과 3% 하락 대기 충돌~~ v3에서 하락 대기 제거(ADR-038).
3. v3 source의 가격 가드·범위 해제 규칙 시험은 v1 `HyperCorePrecompileSource` 시험(동일 코드)에 의존한다. 별도 이식은 하지 않았다.
4. 지분 토큰의 ERC-7575 `vault(asset)`·`VaultUpdate`, `mintWithLimit`.
5. HYPE/UBTC v2와 native router, 버퍼 기반 즉시 출금(ADR-036), 독립 감사.
6. [운영 갭](hypervault-operations-gap.md) v4 후보: guardian 정지(Idle·Active 입금, 배정), owner multisig·역할 분리, source의 대출 장부 probe 읽기, 전략 화이트리스트. 운영: monitor(`--loop --keeper`)·경보 웹훅을 서버/cron에 상시 배치, 출금 72h SLA 운영 절차.


<a id="hv-003"></a>
## HV-003 — 운용 중 버퍼 즉시 출금

[ADR-039](DECISIONS.ko.md#adr-039). **2026-10-12 적용**: 사용자 결정으로 새 Vault v4 `0xf9c0…6b4F` 배포·검증(getter 대조 포함), v3 청산·정산·은퇴, v4 Active 중 `redeemNow` 1 USDC 실측(0.998270 수령). 남은 일: keeper 가격 기록 상시화(약 75초), 실제 verifier 기록과의 통합 시험, 모듈 분리, 외부 보유자 v3 출금 안내. 이전 기록 — 완료: `HyperVault.redeemNow`(창 안 기록 필수, 0.1% 출금 수수료, operator 권한, 마지막 보유자 거부), 시험 11개, 리뷰 승인(코드), FE 즉시 출금 UI(셀렉터 감지). 남음: 배포 방식 결정 → 구현 immutable·`configHash`·저장소 레이아웃 대조 → (업그레이드면) propose 후 48시간 대기, Idle에서 execute / (새 Vault면) 배포·검증·manifest 교체·v3 정리 → 소액 실측. keeper 가격 기록 상시화(약 75초 간격, `priceWindow` 600초/8)가 전제다. 실제 verifier 기록 동작과의 통합 시험 추가. 다음 기능 전 모듈 분리(여유 293 bytes).


<a id="hv-004"></a>
## HV-004 — 오라클 평가 Vault (v5)

[ADR-040](DECISIONS.ko.md#adr-040). 완료: `HyperVaultNavSource` perp 오라클 모드·`oracleOnly` 게이트, `CoreRead.perpAssetInfo`, `redeemNow` 기록 면제(oracle-only 범위만), 시험(forge 360, Python 106), 같은 블록 등식 실측, 리뷰 1차 APPROVE+MEDIUM 2 → 반영 → 2차 APPROVE, `roundtrip.py` v5 범위 형식·오라클 사전 점검, monitor v5 규칙. 남음: v4 정리 여부 결정 → v5 배포·검증(평가식 mainnet 대조: 새 NAV vs API 계산) → FE manifest·즉시 출금 UI(기록 버튼 제거) → 문서.


<a id="hv-005"></a>
## HV-005 — HyperVault 모듈 분리 (v6)

배경: v5 코드의 HyperVault 런타임 24,442 B(한도 24,576, 여유 134). 순서: ① `HyperVaultLens`(view 전용: `previewRedeemNow`·`maxRedeemNow`·출금 대기·수수료 견적, FE 한 번 호출) ② Core 관리(배정·회수·API 지갑·대출·계정 모드·builder fee·`_record`/`_sync`)를 `external` 라이브러리 `HyperVaultCoreOps`로, 관련 상태는 ERC-7201 구조체로 묶음(새 Vault 배포라 레이아웃 변경 허용). 입금·출금·redeemNow·정산·수수료는 본체에 남김. 비채택: fallback 라우팅(diamond), 출금 대기열 별도 계약. 완료 조건: 기존 시험 전부 통과, 저장소 레이아웃 검사, 크기 측정, 독립 리뷰.


<a id="hv-006"></a>
## HV-006 — USDC Carry 운영과 모드별 모니터링

[런북](hypervault-usdc-carry-runbook.md). 완료: `carry_model.py`(문서 USDC 표 재현), `usdc_carry.py`(Unified: borrowLend 공급·차입 후 현물+숏 / PM: 자동 차입, 축소·청산 순서, 가드), `carry_rules.py`·`mode_monitor.py`(Unified·PM 규칙, 읽기 전용), `monitor.py --carry-rules`, 시험 16개. 로컬 상시 실행: v4(Unified, 3분)·제3자 PM 계정 `0x760a…0266`(읽기 전용 관찰, 4분). 확인된 제약: Unified는 현물이 증거금이 아니라 10배 숏 불가(기본 2배), 고LTV 목표 수익률은 PM 전제, PM은 Core $10k 초과 필요, v4 범위는 대출 장부를 세지 않아 공급 전 `scope --blp` 필요, v4 청산 시 0.0099 HYPE 먼지. 남음: 서명 실행·리뷰·소액 실측, PM 자동 차입 동작 자체 계정 확인, 유지증거금 표(margin table 52) 반영.
