# 문서 기준과 관리 규칙

이 문서는 문서별 SSOT(Single Source of Truth, 단일 관리 원본)를 지정한다. 최종 갱신: 2026-10-12 KST.

## 어디에 무엇을 기록하는가

| 질문 | 관리 원본 | 갱신 시점 |
| --- | --- | --- |
| 현재 무엇이 구현됐고 검증됐는가? | [STATUS.ko.md](STATUS.ko.md) | 구현 범위·검증 결과·배포 상태 변경 |
| 어떤 구조를 왜 선택했는가? | [DECISIONS.ko.md](DECISIONS.ko.md) | 설계 결정 채택·변경·폐기 |
| 다음 작업과 완료 조건은 무엇인가? | [BACKLOG.ko.md](BACKLOG.ko.md) | 작업 시작·완료·우선순위·의존성 변경 |
| 실제로 무엇이 바뀌었는가? | [CHANGELOG.md](../CHANGELOG.md) | 코드·ABI·동작·주요 문서 변경 |
| 새 세션은 어디서 시작하는가? | [HANDOVER.ko.md](../HANDOVER.ko.md) | 진입 파일·재현 명령·인계 방법 변경 |
| 다음 기능의 구체적인 기획과 미결 정책은 무엇인가? | [plans/README.md](plans/README.md) 및 분야별 기획서 | 제안 동작·요구사항·OPEN 결정·검증 설계 변경 |
| 현재 계약의 ABI·회계·권한은 무엇인가? | [split-implementation.ko.md](split-implementation.ko.md) | 해당 구현 변경 |
| HyperVault 해커톤 범위·전략 v0·운영 도구·메인넷 왕복과 제출 문안은? | [영문 구조](hypervault-architecture.md), [hypervault.ko.md](hypervault.ko.md), [제출 패키지(영문)](hypervault-submission.md), [ADR-035](DECISIONS.ko.md#adr-035), v2 [ADR-037](DECISIONS.ko.md#adr-037)·[표준 대조](standards-review.ko.md#hypervault-v2), [운영 갭·수익/위험](hypervault-operations-gap.md), [사용자 가이드](hypervault-user-guide.ko.md) | runner·monitor·전략 정책·제출 문안 변경; 결과는 STATUS |
| 자산별 USDC/HYPE/UBTC Vault의 발행·전송·NAV·FE는 무엇인가? | [자산별 구현 명세](managed-asset-vault.ko.md), [ADR-033](DECISIONS.ko.md#adr-033) | 신규 asset Factory·bridge·denomination verifier·Router 변경 |
| 단일 주소 owner USDC Vault의 현재 ABI·수수료·최소 입금·업그레이드는 무엇인가? | [Managed USDC 구현 명세](managed-usdc-vault-implementation.ko.md) | Managed 계약·proxy·정산·설정 변경 |
| Managed precompile 공개 mainnet 관측은 무엇을 입증하는가? | [관측·수정 근거](managed-precompile-evidence.ko.md) | 새 raw 수집·관측 해석·구현 불일치 수정 |
| Managed의 실시간 NAV·액션 최종성·종료 검증은 어떻게 동작하고 무엇을 증명하지 못하는가? | [precompile NAV 명세](managed-precompile-nav.ko.md), [ADR-029](DECISIONS.ko.md#adr-029) | 평가식·등록 범위·가격 가드·판정 규칙·한계 변경 |
| 미등록 보유로 인한 지분 희석을 어떤 구조로 막는가? (구조 비교와 선택 근거) | [구조 비교안](managed-scope-enforcement-options.ko.md). 사용자가 A(현행 구조 + 신고 차단·급락 대기)를 선택했고 구현은 [현행 명세](managed-precompile-nav.ko.md), 결정은 [ADR-029](DECISIONS.ko.md#adr-029)가 관리 | 비교 대상이 바뀌거나 B(Vault 경유 주문)를 다시 검토할 때 |
| 운용자 등록 목록 NAV를 채택한 배경과 검증 시나리오는 무엇인가? | [Unified·PM NAV 설계](managed-unified-pm-nav.ko.md) | 설계 배경·시나리오 변경; 현행 동작은 precompile NAV 명세 |
| FE의 실행·설정·화면 범위는 무엇인가? (탐색·생성·입출금·운용·주문·평가 범위·대화) | [FE 안내](../frontend/README.ko.md) | UI·설정·브라우저 검증 변경; 수치는 STATUS |
| 운용자 주문은 어떤 키로 서명하고 그 키는 어디에 있는가? | [ADR-031](DECISIONS.ko.md#adr-031) (브라우저에 암호화해 둔 Vault 전용 agent 키) | 키 보관·서명·주문 전송 방식 변경; 구현 상태는 [MARKET-002](BACKLOG.ko.md#market-002) |
| Vault별 대화는 어디에 저장되고 누가 쓸 수 있는가? | [ADR-032](DECISIONS.ko.md#adr-032), [대화 서버 안내](../server/README.ko.md) (API·환경 변수·하지 않는 것) | 로그인·역할·작성 정책·저장 방식 변경; 구현 상태는 [CHAT-001](BACKLOG.ko.md#chat-001) |
| Managed USDC 메인넷 실험의 코드·명령·시나리오는 무엇인가? | [메인넷 시나리오](managed-mainnet-scenarios.ko.md) | probe·agent·배포·회귀 절차 변경; 실행 결과는 STATUS |
| 새 USDC ERC7540 Vault의 현재 ABI·회계·Strategy 경계는 무엇인가? | [usdc-vault-implementation.ko.md](usdc-vault-implementation.ko.md) | USDC Vault 또는 연결 인터페이스 변경 |
| Vault 프로젝트의 구성·신뢰 경계·배포 단계는 무엇인가? | [vault-architecture.ko.md](vault-architecture.ko.md) | 아키텍처 경계·출시 조건 변경 |
| 별도 Zcash 비공개 인텐트 연구의 프라이버시·신뢰·오프라인 모형은 무엇인가? | [zcash-private-intents.ko.md](zcash-private-intents.ko.md) | ZPI 연구 범위·위협 모델·검증 게이트 변경; 진행 상태는 STATUS/BACKLOG |
| 새 USDC Vault의 EVM/Core 입금과 지분 발행을 어떻게 구분하는가? | [ADR-021](DECISIONS.ko.md#adr-021), [ADR-020](DECISIONS.ko.md#adr-020), [공개 Factory 설계](vault-architecture.ko.md#9-공개-factory와-core-활성화) | EVM100 창설자 지분·Core 활성화·Core 보유자 경로 설계 변경; 구현 상태는 [FACTORY-001](BACKLOG.ko.md#factory-001) |
| 공개 Vault 운용자의 API wallet과 Core 계정 설정은 어떻게 구분하는가? | [ADR-022](DECISIONS.ko.md#adr-022), [다중 시장 아키텍처](vault-architecture.ko.md#8-usdc-다중-시장-거래-아키텍처) | agent 등록·직접 주문·action 15/16 권한 설계; 구현 상태는 [MARKET-002](BACKLOG.ko.md#market-002) |
| 고정 owner의 USDC Vault 관리 함수와 예치자 권한은 무엇인가? | [운용자 신뢰형 상세 아키텍처](managed-usdc-vault-architecture.ko.md), [ADR-023](DECISIONS.ko.md#adr-023) | Factory owner 지정·API/자금 이동/lending/모드 함수·owner 주도 회수 변경; 현재 ABI와 구분 |
| builder fee의 절반을 Vault 배포자에게 돌려주는 규칙은 어디에 있는가? | [ADR-030](DECISIONS.ko.md#adr-030) (오프체인 정산, 컨트랙트 변경 없음) | 페이백 비율·정산 방식·고지 변경; 구현 상태는 [MARKET-002](BACKLOG.ko.md#market-002) |
| 예치자 출금 이익 10%를 운용자·플랫폼에 어떻게 배분하는가? | [ADR-016](DECISIONS.ko.md#adr-016), [ADR-017](DECISIONS.ko.md#adr-017), [성과 수수료 원장](performance-fee-architecture.ko.md) | 수수료율·원가·손실 이월·80/20 배분 설계 변경; 구현 상태는 [FEE-001](BACKLOG.ko.md#fee-001) |
| 표준 조항과 구현의 대조 근거·반례는 무엇인가? | [standards-review.ko.md](standards-review.ko.md) | 표준 검토·결함 재현·수정 후 재검토; 실행 수치는 STATUS, 작업 상태는 BACKLOG |
| Core 액션을 어떻게 관측하고 소비하는가? | [core-action-recovery.ko.md](core-action-recovery.ko.md) | 관측·pending·복구 동작 변경 |
| PM 생명주기 가설에서 어떤 코드 경로가 막히는가? | [pm-lifecycle-model.ko.md](pm-lifecycle-model.ko.md) | 로컬 모형·공급 진입 검사 근거 변경; 네트워크 실측과 분리 |
| NAV source와 유동성 확장의 계약은 무엇인가? | [nav-liquidity-architecture.ko.md](nav-liquidity-architecture.ko.md) | NAV 모델·발행 가격·유동성 설계 변경 |
| 실측에서 어떤 사실을 확인했는가? | [pm-nav-evidence.ko.md](pm-nav-evidence.ko.md), [reference/README.md](reference/README.md) | 새 관측·해석 정정 추가 |

[루트 README](../README.md)는 소개와 탐색용이다. README와 핸드오버에 최신 테스트 수, 계약 크기, 전체 미완료 목록을 복사하지 않는다. STATUS는 현황, BACKLOG는 실행 가능한 작업, 상세 명세는 동작과 수식을 관리한다. 문서 사이에는 링크와 고정 ID를 사용한다.

`plans/`는 구현 전 제안의 관리 원본이다. 그 안의 API·상태·수치는 채택/구현 표시가 없으면 실제 ABI나 운영 설정이 아니다. 제안 채택 시 DECISIONS, 구현 후 현행 상세 명세를 갱신하며 계획 작성 완료와 기능 완료를 구분한다. 사업 정책 선택은 plans의 OPEN ID, 외부 사실 검증은 AS ID, 시험은 EX ID로 연결한다.

## 문서가 서로 다를 때

- **실제 동작**은 현재 코드와 테스트에서 확인한다. 문서가 다르면 불일치로 기록하고 해당 상세 명세와 STATUS를 고친다. 문서만 보고 과거 구현으로 되돌리지 않는다.
- **의도한 설계**는 DECISIONS의 채택된 결정과 현행 상세 명세를 따른다. 결정과 구현의 차이는 BACKLOG에 남긴다. 계획을 구현 완료로 표시하지 않는다.
- **네트워크 사실**은 출처·시점·블록·조회 범위가 있는 원시 자료로 판단한다. 과거 스냅샷은 현재 프로토콜 지원을 보장하지 않는다. 공개 계정 관측, 통제된 거래 실험, mock 가정을 구분한다.
- **진행 상태**는 STATUS와 BACKLOG만 갱신한다. 과거 CHANGELOG의 완료 기록이나 계획 문구로 현재 상태를 덮어쓰지 않는다.

## 이력 문서

아래는 당시 조사·설계·legacy 동작의 기록이며 현재 구현이나 배포 절차의 관리 원본이 아니다.

| 문서 | 보존 목적 |
| --- | --- |
| [vault-strategy-plan.ko.md](vault-strategy-plan.ko.md) | 최초 Vault / Strategy 분리 기획 |
| [contract-change-spec.ko.md](contract-change-spec.ko.md) | 분리 구현 전 변경 명세 |
| [implementation.ko.md](implementation.ko.md) | legacy 단일 Vault 호출 가이드 |
| [deployment-config.ko.md](deployment-config.ko.md) | 당시 네트워크 조사·legacy 설정 |
| [research.ko.md](research.ko.md) | 초기 연구와 당시 검증 결과 |

이력 문서의 과거 테스트 수·설계안은 당시 기록으로 남긴다. 새로운 사실은 현행 문서에 쓰고 필요한 정정 링크를 추가한다. `reference/*.json` 원시 스냅샷은 덮어쓰지 않고 새 파일과 수집 맥락을 추가한다.

## 작업을 끝낼 때

1. BACKLOG의 관련 ID와 완료 조건을 확인한다. 진행 중이면 `IN_PROGRESS`, 일부만 끝나면 남은 조건을 기록한다.
2. 코드 동작이 바뀌면 관련 상세 명세를 갱신한다. 설계 변경은 DECISIONS에 새 ID로 추가하고 기존 결정의 대체 관계를 남긴다.
3. 검증한 명령·결과·날짜·한계를 STATUS에 갱신한다. 실행하지 않은 테스트는 통과했다고 쓰지 않는다. 문서만 변경하면 문서 검증만 기록한다.
4. CHANGELOG의 Unreleased에 완료한 변경과 ABI 영향을 적는다. 계획과 미해결 항목은 BACKLOG로 연결한다. 릴리스하지 않았으면 버전·커밋·배포 주소를 만들지 않는다.
5. 완료 조건을 충족한 BACKLOG 항목만 `DONE`으로 바꾸고 근거를 연결한다. 기존 ID를 삭제하거나 다른 작업에 재사용하지 않는다.
6. 링크가 실제 파일을 가리키는지 확인한다. 진입 경로나 명령이 바뀐 경우에만 HANDOVER와 README를 함께 고친다.

별도 승인 절차를 추가하는 규칙은 아니다. 사용자 요청 범위 안에서 작업하고 결과와 한계를 추적하기 위한 규칙이다.

## 직접 Vault 생성 경로 (ADR-034)

| 문서 | SSOT 범위 |
| --- | --- |
| [직접 Vault](direct-vaults.ko.md) | 플랫폼 배포·owner bootstrap·배포 목록 기반 FE, 자산 명세의 이전 Factory 경로 대체 |
| [kHYPE 오라클](khype-oracle.ko.md) | 외부 보상 보고·교환비율 구조와 조회 근거. 우리 NAV 명세를 대체하지 않음 |

## kHYPE 입금 배분 참고

[kHYPE 입금·버퍼·Core 배분](khype-deposit-buffer.ko.md)은 외부 컨트랙트 함수·우선순위·유효 버퍼의 설명 원본이다. 우리 자동 버퍼 도입 결정이나 구현 완료를 뜻하지 않는다.
