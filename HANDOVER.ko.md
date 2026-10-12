# HyperCore Vault 작업 핸드오버

최종 갱신: 2026-10-12 KST. 다른 세션이 작업을 재개하기 위한 진입 문서다. 현재 테스트 수·계약 크기는 STATUS, 다음 작업의 상태·완료 조건은 BACKLOG를 관리 원본으로 삼는다.

## HyperVault 해커톤 (2026-10-12)

**현행은 v6**([ADR-040](docs/DECISIONS.ko.md#adr-040) 오라클 평가 + [ADR-041](docs/DECISIONS.ko.md#adr-041) 모듈 분리): 메인넷 v6 USDC Vault `0x6c4556b8068397AD2F3e69205b7C100CAf234883`(Active, 헤지 0.13 HYPE, API wallet agent6, 한도 100,000 USDC). v4 `0xf9c0…6b4F`·v3 `0x2aff…0516`은 은퇴(출금 전용). 운영 명령은 `HV_VERSION=v6 HV_RUN=v6-run<N> HV_AGENT=agent6 python3 scripts/hypervault/roundtrip.py --execute <cmd> [args]`(배포 정보 `.omc/hypervault/deployment-v6.json`). RPC는 빠른 4개(hypurrscan·drpc·공용·thirdweb)를 순환하고 `HV_RPC_URL`로 하나에 고정할 수 있다. 쓰기는 `--async` 전송 + 영수증 조회, nonce 고정. 즉시 출금은 oracle-only 범위라 가격 기록이 필요 없다(기록은 수수료 상한용으로 keeper가 남긴다). USDC Carry 확장 운영은 [런북](docs/hypervault-usdc-carry-runbook.md). 아래는 v1 기록이다.

[영문 구조](docs/hypervault-architecture.md)·[ADR-035](docs/DECISIONS.ko.md#adr-035)·[ADR-036](docs/DECISIONS.ko.md#adr-036)·[명세](docs/hypervault.ko.md)·[제출 패키지](docs/hypervault-submission.md)를 먼저 읽는다. 메인넷 USDC Vault `0x46c0e94C07111390d7B1F49147AB397B2d991eAe`에서 왕복 3회를 마쳤고 현재 Idle·지분 0이다. 키는 저장소 밖 `~/.config/hypervault/*.key`(owner·agent·agent2·keeper·demo-user)에 있고 한 번 해제한 agent 키는 다시 쓰지 않는다(`HV_AGENT`로 새 키 지정). 루트 `.env`에 사용자 키가 있으므로 커밋·제출 패키지에서 제외한다. 운영 명령은 `python3 scripts/hypervault/roundtrip.py --help`이며 기본은 시뮬레이션이다. 남은 작업은 [HV-001](docs/BACKLOG.ko.md#hv-001).

## 현재 제품 경로 변경 (2026-10-11)

사용자가 공개 Factory 대신 플랫폼 직접 Vault 배포를 요청했다. [ADR-034](docs/DECISIONS.ko.md#adr-034)와 [직접 배포 명세](docs/direct-vaults.ko.md)를 우선 읽는다. 기본 FE는 검토된 VITE_DIRECT_VAULTS 목록을 사용한다. 배포/owner bootstrap 스크립트는 별도이며 실제 배포는 하지 않았다. 아래 공개 Factory 설명은 이전 경로 기록이다. [kHYPE 오라클 검토](docs/khype-oracle.ko.md)는 외부 보고 기반 교환비율과 우리 precompile NAV의 차이를 설명한다.

## 시작 위치와 읽는 순서

프로젝트 경로는 이 저장소의 루트다. 아래 문서를 먼저 읽고 해당 작업의 상세 명세와 코드를 확인한다.

| 순서 | 문서 | 목적 |
| --- | --- | --- |
| 1 | [문서 기준](docs/README.md) | SSOT 소유 범위와 갱신 규칙 |
| 2 | [현재 상태](docs/STATUS.ko.md) | 환경·구현·검증·배포 상태 |
| 3 | [설계 결정](docs/DECISIONS.ko.md) | 채택한 구조와 아직 확정하지 않은 가정 |
| 4 | [작업 백로그](docs/BACKLOG.ko.md) | 다음 READY 작업, 의존성, 완료 조건 |
| 5 | [변경 이력](CHANGELOG.md) | 완료한 변경과 ABI 영향 |

새 Managed USDC 작업은 [현행 구현](docs/managed-usdc-vault-implementation.ko.md)과 [메인넷 시나리오](docs/managed-mainnet-scenarios.ko.md)를 읽는다.

Core 관련 작업은 [PM 실측](docs/pm-nav-evidence.ko.md), [분리 구현 명세](docs/split-implementation.ko.md), [액션 관측 명세](docs/core-action-recovery.ko.md)를 함께 읽는다. NAV/입금 변경은 [NAV·유동성 설계](docs/nav-liquidity-architecture.ko.md)를 읽는다. 최초 기획서와 legacy 설명은 이력 자료이며 현재 구현을 덮어쓰는 기준이 아니다.

후속 기능은 [전체 기획 패키지](docs/plans/README.md)에서 요구사항·제안 상태/수식·검증 절차·미결 정책을 확인한다. 계획의 함수명과 상태는 현재 ABI가 아니며 PROPOSED/CONDITIONAL 안을 채택된 결정으로 취급하지 않는다. 특히 Core 작업은 생명주기·복구, NAV 작업은 source·입금·부분 출금 계획을 함께 본다.

Zcash 기반 비공개 선물 인텐트는 기존 Vault와 분리된 [연구 명세](docs/zcash-private-intents.ko.md)와 [ZPI 백로그](docs/BACKLOG.ko.md#zpi-001)를 따른다. Python 모형은 공동 진입 주문의 부분 체결을 사용자별 회계에 연결했지만, `mock_*` 영수증은 체인 관측·서명·지급 증거가 아니다. 재현 명령은 `python3 -m unittest discover -s test/python -v`이며 최신 결과는 STATUS에 있다.

2026-10-04 ZPI testnet용 Zcash 지갑·Hyperliquid EVM 키를 `~/.local/share/zpi-testnet`에 생성했다. 이 디렉터리는 저장소 밖이며 비밀 파일을 포함하므로 내용을 문서·로그·채팅에 복사하지 않는다. Zcash 실험용 `zcash-devtool` 실행 파일과 공개 주소·faucet 식별자만 담은 `public-manifest.json`도 같은 디렉터리에 있고 지갑 네트워크는 `test`다. 1 TAZ faucet 송금은 지갑에서 Ironwood note로 관측됐고 표준 확인 뒤 1 TAZ가 지출 가능해졌다. Hyperliquid Core 계정은 잔액 0이며 공식 mock USDC faucet의 동일 주소 mainnet 입금 조건을 충족하지 않는다. [STATUS](docs/STATUS.ko.md)와 [ZPI-002](docs/BACKLOG.ko.md#zpi-002)를 먼저 확인하고 viewing key만 사용한 독립 관측을 진행한다. Vault/Strategy용 ENV-001은 별개로 대기 중이다.

지분·입출금 변경은 [표준 검토](docs/standards-review.ko.md)도 읽는다. `maxDeposit` 반례와 Vault가 포함된 0 share 전송 거부는 수정 후 회귀 테스트로 전환했다. 양수 직접 전송은 요청 custody 보호를 위해 계속 제한하며 테스트 통과를 전체 표준 준수로 해석하지 않는다. 수정 시 테스트의 기대값과 검토 판정을 함께 갱신한다.

## 자산별 Vault 확장

2026-10-11 [ADR-033](docs/DECISIONS.ko.md#adr-033)에 따라 새 `ManagedAssetVault/Factory`, `ManagedAssetBridge`, `ManagedAssetNavVerifier`, `ManagedHypeRouter`와 `#/assets` FE를 구현했다. [신규 명세](docs/managed-asset-vault.ko.md)를 먼저 읽는다. USDC/HYPE/UBTC 중 하나를 선택하고 원금은 즉시 지분 발행·EVM 현금으로 보관, 활성화는 별도 USDC, Core 배정은 예약·실행한다. 기존 USDC 계약의 storage-compatible upgrade가 아니다. 새 Vault의 legacy getter `basisUsdc/unaccountedUsdc` 값은 기준 자산 단위다. 테스트·크기·메인넷 읽기 관측은 STATUS, 실제 왕복·배포·새 FE 주문/채팅 통합은 ASSET-001을 따른다. 재현 gate는 아래와 같고 metadata probe는 `python3 scripts/managed_asset_preflight.py --output /tmp/new-asset-preflight.json`이다.

## 인계 시 특히 주의할 맥락

**현재 Managed 구현:** [현행 ABI/회계/upgrade](docs/managed-usdc-vault-implementation.ko.md)와 [메인넷 실행 시나리오](docs/managed-mainnet-scenarios.ko.md)를 먼저 읽는다. `ManagedUsdcVault/Factory`는 단일 proxy/Core 주소·owner 관리·Vault 전용 agent·커스텀 수수료/최소 입금·OZ proxy 업그레이드를 로컬 구현했다. 기본안은 성과수수료 10%, 플랫폼 몫 20%, 최소 입금 10 USDC, Vault owner 제안 후 48시간·Idle 업그레이드다. 이름 설정·기본 FE와 Ready/Active NAV 입금 gate도 구현했다. **실시간 NAV·액션 최종성·종료 검증은 [precompile NAV 명세](docs/managed-precompile-nav.ko.md)의 `HyperCorePrecompileSource`·`ManagedPortfolioNavVerifier`가 맡는다.** 외부 서명 NAV는 사용자가 거절했다. 평가식의 근거는 [공개 계정 관측](docs/managed-precompile-evidence.ko.md#raw-ledger-identity)이다. `bash scripts/test_managed.sh`가 전체 회귀/크기/storage gate다. FE 의존성 설치 후 `bash scripts/test_frontend.sh`로 ABI/format/build/unit 검증을 수행한다. 실제 메인넷 write는 하지 않았고 raw 자료는 읽기 전용 근거다. 다음 작업은 [ADR-029](docs/DECISIONS.ko.md#adr-029)의 정책·결정 대기 항목 확정과 [NAV-001](docs/BACKLOG.ko.md#nav-001)·[VERIFIER-001](docs/BACKLOG.ko.md#verifier-001)의 통제 왕복이다. Factory는 선제 활성화로 생성이 막히는 문제가 남아 있어 공개 배포하지 않는다([FACTORY-001](docs/BACKLOG.ko.md#factory-001)).

**USDC owner 설계 이력:** 2026-10-04 사용자는 예치자가 운용자를 신뢰하는 상품임을 확정했다. [ADR-023](docs/DECISIONS.ko.md#adr-023)과 [관리 함수 상세](docs/managed-usdc-vault-architecture.ko.md)를 우선 적용한다. Factory 호출자를 변경 불가 owner로 설정하고, API wallet 등록·Core 자금 왕복·Borrow/Lend 공급/회수·계정 모드 변경·builder fee 승인을 Vault의 onlyOwner 외부 함수로 제공한다. API 직접 주문에 EVM 시장/위험 검사 강제를 요구하지 않는다. 출금의 포지션 정리·Core 회수는 owner가 수행하고 요청 및 확정 claim에는 owner 추가 승인이 필요 없다. 해당 목표의 현재 구현 범위는 위 Managed 명세를 따른다.

사용자는 OpenZeppelin을 사용한 Vault / Strategy 분리와 permissionless 출금 경로를 원한다. 기존 WHYPE 제품은 [ADR-003](docs/DECISIONS.ko.md#adr-003)의 코드다. 2026-10-02 사용자는 후속 상품의 HyperEVM USDC 입금·계약의 Core 이동 경로를 제안했고 [ADR-010](docs/DECISIONS.ko.md#adr-010)으로 새 USDC 쌍의 목표를 정했다. 2026-10-03에는 [USDC ERC7540 Vault](docs/usdc-vault-implementation.ko.md)의 입출금·배정/정산 경계를 별도 로컬 구현했지만 **생산용 Strategy·Factory·시장별 거래·회수 증명은 없다.** [USDC-001/002](docs/BACKLOG.ko.md#usdc-001)가 미완료이므로 실자금 USDC 상품으로 배포하지 않는다. 기존 계정/API wallet 모델은 [ADR-004](docs/DECISIONS.ko.md#adr-004)에 있다. 새 USDC 상품은 [ADR-011](docs/DECISIONS.ko.md#adr-011)의 spot·HIP-3·HIP-4 거래가 핵심이며 고정 HYPE carry로 설명하지 않는다. 시장별 통제 실험·agent/builder fee 권한 과제는 [MARKET-001/002](docs/BACKLOG.ko.md#market-001)에 있다.

후속 [ADR-014](docs/DECISIONS.ko.md#adr-014)·[ADR-021](docs/DECISIONS.ko.md#adr-021)은 새 USDC 상품의 목표를 **Vault 주소 자체가 Core 계정**이고 **누구나 자신이 운용할 Vault를 Factory에서 생성·EVM USDC 원금 100을 납입**하는 방식으로 정했다. 다른 사용자는 Core 활성화와 검증된 입금 가격 확보 후 HyperEVM USDC를 예치한다. 기존 `AsyncUsdcVault`의 별도 Strategy 연결은 이전 구현이며 새 목표는 별도 `ManagedUsdcVault`에 반영했다. 첫 경로는 창설자가 Factory에 HyperEVM USDC를 승인하고 `createVaultAndFund` 한 거래에서 새 Vault가 USDC를 수령해 창설자 지분을 발행하며 Circle `deposit`으로 자기 Core에 배정한다. Core 활성화·순수령은 후속 블록에서 확인해 운용만 개방하고 지분은 재발행하지 않는다. [FACTORY-001](docs/BACKLOG.ko.md#factory-001)과 [아키텍처 9절](docs/vault-architecture.ko.md#9-공개-factory와-core-활성화)을 먼저 따른다.

[ADR-021](docs/DECISIONS.ko.md#adr-021)은 창설자 지분 발행 근거를 Vault가 실제 수령한 EVM USDC 100으로 바꿨다. [ADR-020](docs/DECISIONS.ko.md#adr-020)의 생성 거래 내 Core 배정은 유지하되 Core 확인은 운용 개시 조건이다. 101 EVM USDC가 정확히 Core100이 되는지는 미검증이다. 창설자나 일반 예치자가 Core에만 자금을 보유하면 Circle 출금으로 자기 동일 주소 EVM에 옮긴 후 Vault 함수로 입금해야 한다. Factory는 창설자 Core 잔액을 EVM 거래에서 인출할 수 없다. Core 자금 도착 후 실패는 EVM 거래로 소급 환불할 수 없으며 재조회·Core 회수 검증은 [FACTORY-001](docs/BACKLOG.ko.md#factory-001)을 따른다.

[ADR-022](docs/DECISIONS.ko.md#adr-022)는 Vault 전용 API wallet을 해당 Vault의 활성화된 Core 계정에 Vault 자신의 CoreWriter action 9로 등록하는 목표다. 키는 창설자가 오프체인에서 만들며 API 직접 주문은 EVM 위험 검사 밖에서 실행된다. 계정 추상화 action 16과 lending 공급·회수 action 15는 Vault 권한 경로로 구현한다. 공식 API에 `agentSetAbstraction`은 있지만 자유로운 모드 전환으로 보지 않고, agent 서명 `borrowLend`는 공식 Exchange 명세에서 확인되지 않았다. 구현·계약 계정 실거래·철회/비상 경계는 [MARKET-002](docs/BACKLOG.ko.md#market-002)에 남아 있다.

새 Core 계정의 1 quote-token 활성화 비용은 창설자 EVM USDC 100 지분의 원가에 넣지 않는다. 기본 EVM→Core `deposit`과 Core 직접 송금의 비용·실수령 대조 실험은 [USDC-001](docs/BACKLOG.ko.md#usdc-001)에서 검증한다. 창설자 지분의 운용 중 출금 제한은 [OPEN-09](docs/plans/README.md#정책-결정-등록부)의 미결 제안이다.

[ADR-016](docs/DECISIONS.ko.md#adr-016)은 **다른 사용자 출금 이익의 10%**를 총 성과 수수료로 정하고 [ADR-017](docs/DECISIONS.ko.md#adr-017)은 그 20%를 플랫폼·80%를 운용자에게 배분한다. 사용자별 원가·손실 이월·고유 ERC-7540 요청 ID와 Claim 시 사용자/운용자/플랫폼 분할은 [수수료 명세](docs/performance-fee-architecture.ko.md), 구현 완료 조건은 [FEE-001](docs/BACKLOG.ko.md#fee-001)을 따른다. 이전 `AsyncUsdcVault`/`EpochRedeem`은 수수료가 없고 epoch ID를 공유한다. Managed 구현은 고유 요청 ID와 ADR-026의 커스텀 요율을 사용한다.

최근 수정은 raw position size lots를 주문의 1e8 단위로 정규화한 것이다. 이를 되돌리거나 raw szi를 주문량과 직접 비교하지 않는다. 관련 ABI가 함께 바뀌었으므로 RiskOracle / Strategy / Observer를 구버전과 섞지 않는다. [실측 및 수정 근거](docs/pm-nav-evidence.ko.md)

PM 전환 뒤 자동 공급과 현재 bridge/supply 흐름의 충돌은 [로컬 모형](docs/pm-lifecycle-model.ko.md)으로 재현했다. Core read를 직접 주입한 결과이며 공개 정적 표본과 마찬가지로 통제한 네트워크 전환 실험은 아니다. 초기 공급 직전에 lending supply/borrow가 비제로면 추가 전액 공급을 거부하는 [ADR-009](docs/DECISIONS.ko.md#adr-009)를 반영했다. 자동 공급 후 raw spot target에서 진행·회수가 막히는 한계는 남아 있다. 모형 테스트의 PASS를 자동 공급 지원 완료로 읽지 않는다.

다음 [CORE-001](docs/BACKLOG.ko.md#core-001) 단계는 계정 초기화·첫 PM·다음 cycle의 전후 관측과 자금 귀속 검증이다. 읽기 실패를 0으로 치환하거나 운영자 PM 확인을 프로토콜 성공 증명으로 바꾸지 않는다. 환경 확보 전에는 CORE-002의 복구 증거 검토를 병행할 수 있다.

USDC 목표 경로는 [Vault 아키텍처 7절](docs/vault-architecture.ko.md#7-usdc-목표-경로와-검증-조건)과 [Circle 공식 입금 인터페이스](https://developers.circle.com/cctp/references/coredepositwallet-contract-interface)를 읽는다. 목표는 Vault가 `deposit`으로 자기 Core 계정에 배정하고 자기 CoreWriter `SendAsset`로 EVM에 회수하는 것이다. 현행 코드의 `depositFor(Strategy, ...)`는 이전 로컬 구현이다. 통제 실험 전 어느 경로도 성공한 자금 왕복으로 기록하지 않는다. 단순 USDC ERC20 송금을 `CoreDepositWallet`에 보내면 입금되지 않고 자금이 묶인다는 공식 경고를 따른다.

테스트넷 실행 환경의 확보 여부는 [ENV-001](docs/BACKLOG.ko.md#env-001)을 확인한다. 공개 스냅샷의 주소는 사용자가 운용하도록 제공한 계정이 아니다. fork/mock에서 Core read가 가능해도 실제 비동기 CoreWriter 처리까지 재현되는 것은 아니다.

## 최신 NAV 구현 인계

[ADR-029](docs/DECISIONS.ko.md#adr-029)와 [현행 명세](docs/managed-precompile-nav.ko.md)를 읽는다. [ADR-028](docs/DECISIONS.ko.md#adr-028)의 운용자 등록 목록 + precompile 평가 + 입금 전 동기 발행을 구현했다. 이어받을 때 지킬 것:

- 평가기는 모드와 무관한 하나다. precompile의 spot·lending·DEX별 margin 계정은 겹치지 않는 raw 장부이며 `accountValue`에 PnL이 이미 들어 있다. API의 통합 잔액이나 `hold`를 더하지 않는다.
- 조회 실패를 0으로 바꾸지 않는다. lending 조회 실패를 "장부 없음"으로 받아들이는 곳은 `_ledger` 하나뿐이고(미집계 장부 확인, 플래그 해제, 신고 확인이 쓴다), 장부가 있는데 집계하지 않으면 `ScopeIncomplete`로 닫는다. 그 확인은 gas 20,000으로 제한한 호출이며, 실패를 받아들이기 전에 남은 gas(`20,000 / 63` 초과)와 같은 형태의 대조 조회 성공을 확인한다. 이 두 확인을 빼거나 한도를 조회 비용(문서 식 14,480, 실측 7,336) 아래로 내리지 않는다.
- 결손은 상계하지 않는다. 음의 DEX equity는 발행을 닫고(`NegativeDexEquity`) Core 순자산이 음수이면 EVM 현금과 합치지 않는다(`NegativeCoreEquity`).
- 도착하지 않은 회수를 시간만으로 닫지 않는다. 닫는 경로는 owner의 `abandonRecall`과 대기 기간뿐이다. 누구나 닫을 수 있게 만들면 전송 중인 USDC가 빠진 NAV로 입금이 열린다.
- 범위 상한(token 6·DEX 8·vault 2)을 올리려면 [gas 모형 시험](test/ManagedNavGas.t.sol)에서 `mint`가 소형 블록 3M 안에 남는지 다시 확인한다. 상한은 문서의 비용식으로 정했다. 실측 비용은 그 절반쯤이었지만([관측](docs/managed-precompile-evidence.ko.md#precompile-gas)) 한 시점의 값이라 상한의 근거로 쓰지 않는다.
- 종료 평가는 가격 가드를 쓰지 않고 "팔 수 있는가"(온전한 lot, 매수호가 기준 10 USDC 이상)만 본다. 팔 수 없는 잔량이나 시장 상태가 종료를 막게 되돌리지 않는다.
- 잔액·가격·decimals를 호출자 입력으로 받지 않는다. `complete=true`류 플래그, owner NAV 입력, 외부 서명자를 추가하지 않는다.
- 등록 범위의 완전성은 운용자 신뢰이고 미등록 노출은 NAV·종료 검증에 보이지 않는다. 이를 자동 증명으로 표시하지 않는다.
- Vault runtime 여유는 214 bytes다. NAV 쪽 변경은 source/verifier에서 하고 Vault를 건드리면 크기·storage gate를 다시 확인한다.
- 미등록 보유로 인한 지분 희석은 사용자가 "현행 구조 유지 + 신고 차단 + 급락 대기"를 선택해 구현했다([구조 비교안](docs/managed-scope-enforcement-options.ko.md)의 A). 주문을 Vault 함수로만 제출하는 구조(B)는 나중에 별도 Vault 유형으로 검토하며, builder fee 페이백 모델([ADR-030](docs/DECISIONS.ko.md#adr-030))과 양립하지 않는다는 점을 함께 본다.
- 신고는 대상의 잔액을 컨트랙트가 직접 읽어 확인하는 것이다. 신고자 주소·서명·오프체인 보고를 근거로 Vault를 닫거나 여는 기능을 추가하지 않는다. 신고는 평가마다 다시 읽어 지금도 성립할 때만 Vault를 닫는다. 한 번 성립하면 해제할 때까지 닫아 두는 표시 방식으로 되돌리지 않는다(한순간의 호가로 누구나 Vault를 닫을 수 있게 된다).
- 보관하는 신고는 Vault당 한 건이고 **성립하는 신고는 자리를 지킨다.** 그동안 다른 대상의 신고는 거부되고 같은 대상의 재신고는 기한만 늘린다(보관된 증명 경로는 그대로). 다른 증명이 성립 중인 신고를 밀어내게 바꾸지 않는다(제3자가 한 블록짜리 token 증명으로 진짜 신고를 걷어낼 수 있게 된다).
- owner가 신고된 대상을 `configure`로 등록해 그 신고가 더 성립하지 않게 되면 신고는 목록에서 빠지고, 그때까지의 가격 기록은 발행과 종료의 이력으로 세지 않는다(`reportAnsweredAt`). 이 규칙을 빼지 않는다. 자리가 하나여서 owner가 자기 소액 보유를 먼저 신고해 둘 수 있는데, 이 규칙이 없으면 그 대상을 등록해 같은 블록에서 신고를 풀고 입금할 수 있다. 모든 `configure`에서 이력을 다시 시작하게 넓히지도 않는다(시장을 추가할 때마다 입금이 반 창 동안 닫힌다).
- 등록된 token을 신고 대상에서 무조건 빼게 되돌리지 않는다. 등록된 token은 등록된 USDC pair의 매수호가로만 종료 평가에 들어가므로, 그 pair가 사 주지 않는 보유는 신고할 수 있어야 한다. 아니면 매수호가 없는 pair로 등록한 token에 가치를 옮겨 신고와 종료 평가를 모두 벗어난다. 신고 대상에서 빠지는 것은 차입이 있거나 등록된 pair에서 팔 수 있는 가치가 있을 때뿐이다. 등록된 token의 신고에는 다른 pair에서 주문 최소 금액의 두 배를 요구하며 이 값을 한 배로 내리지 않는다(등록된 pair가 최소 금액 바로 아래로 치는 잔량이 pair 사이의 작은 가격 차이로 신고돼 Vault가 닫힌다). `reportAnsweredAt`은 `configure`가 그 직전까지 성립하던 신고를 풀었을 때만 기록한다. 목록에 남은 신고의 대상이 등록돼 있다는 것만으로 기록하게 되돌리지 않는다(스스로 풀린 신고 때문에 무관한 범위 변경이 입금을 닫는다). "보유 중인 token을 등록하면 이력을 다시 시작한다"는 규칙은 넣었다가 뺐다. 빈 상태로 등록한 뒤 가치를 옮겨 넣으면 우회된다.
- 남은 것은 신고된 대상을 Core에서 비운 뒤 첫 블록의 순서 경쟁이다. 증명 뒤 일정 시간 닫아 두는 장치는 무비용 방해를 열기 때문에 넣지 않았다([ADR-029](docs/DECISIONS.ko.md#adr-029) 결정 대기 F).
- 급락 대기의 기준은 창 안의 최고 기록이다. 낮은 기록으로 기준이 내려가게 바꾸지 않는다. 기록 간격 안에서 더 높은 가격이 직전 기록을 대체하는 규칙을 빼지 않는다(먼저 기록한 쪽이 낮은 표본을 독점해 대기를 우회한다). 종료 정산에도 같은 한도와 같은 기록 길이 요건이 적용된다. 기록이 없을 때 정산을 허용하게 되돌리지 않는다. 예외는 지분이 없는 Vault의 종료 하나다(지급받는 사람이 없고, 이 예외가 없으면 빈 Vault가 Idle로 돌아오지 못한다).
- 가격 기록은 `scopeValue`로 읽는다. 입금 스위치나 신고에 따라 기록이 멈추게 `evaluate`에 다시 묶지 않고, 관리 액션이 pending일 때 거부하게 되돌리지도 않는다(둘 다 기록을 끊어 창을 비우는 수단이 된다). 반대로 등록 범위를 평가할 수 없는 상태에서도 기록되게 바꾸지 않는다(낮은 표본을 블록 하나 없이 얻게 된다). Idle에서는 Vault가 발행에 쓰는 현금 기준 가격을 기록한다. Core 잔량을 넣으면 지분이 거의 없을 때 가격이 튄다.
- `idleDustLimit`의 상한(`MAX_IDLE_DUST`)은 10 USDC 미만이다. 신고가 성립하는 크기(10 USDC) 이상으로 올리지 않는다.
- token을 범위에서 뺄 수 있는지는 그 순간의 매수호가로만 판정한다. spot mark로 한 번 더 제한하지 않는다. 호가가 죽은 시장에도 mark는 남아 있어([관측](docs/managed-precompile-evidence.ko.md#empty-book)) 팔 수 없는 보유가 token을 범위에 묶는다.
- ADR-029의 정책 7개와 결정 대기 A(조회 실패 항목의 복구)·B(호가 평가 토큰)·C(Factory 선제 활성화)·E(팔 수 없는 신고 대상의 복구, 동결 token 확인 필요)·F(신고 효력의 유지 시간)는 사용자 확정 대기다. source와 검증기는 immutable이므로 코드가 바뀌는 선택지(A, B, F, E의 (다))는 배포 전에 정한다. 프로젝트 계정의 통제 왕복·모드 전환 실측·독립 감사 전에는 실자금 입금을 열지 않는다. 설계 배경은 [Unified·PM NAV 설계](docs/managed-unified-pm-nav.ko.md)에 있다.

## 코드 지도

| 파일 | 책임 |
| --- | --- |
| [AsyncHypeVault](src/AsyncHypeVault.sol), [EpochRedeem](src/vault/EpochRedeem.sol) | 지분·역할·배정·NAV 캐시, 요청·epoch·준비금·claim |
| [ManagedUsdcVault](src/ManagedUsdcVault.sol), [Factory](src/ManagedUsdcVaultFactory.sol), [UpgradeController](src/managed/ManagedUpgradeController.sol) | 단일 proxy/Core 주소, 고정 owner·커스텀 조건·수수료·upgrade |
| [HyperCorePrecompileSource](src/nav/HyperCorePrecompileSource.sol), [ManagedPortfolioNavVerifier](src/managed/ManagedPortfolioNavVerifier.sol) | Vault별 등록 범위의 precompile NAV, 액션 최종성·종료 검증. 통제 왕복 미검증 |
| [AsyncUsdcVault](src/AsyncUsdcVault.sol), [IUsdcCycleStrategy](src/interfaces/IUsdcCycleStrategy.sol) | USDC ERC7540 입출금, `depositFor` 배정과 실제 USDC 회수·terminal 신뢰 경계. Strategy 구현은 미완료 |
| [HyperCoreStrategyAccount](src/HyperCoreStrategyAccount.sol) | Core 자산 보관, 운용/회수 상태 전이 |
| [HyperCoreRiskOracle](src/HyperCoreRiskOracle.sol) | 가격·lot·슬리피지·부채 대응량·position 정규화 |
| [CoreActionObserver](src/CoreActionObserver.sol) | pending 전후 계정 효과 분류 |
| [CoreRead](src/CoreRead.sol), [CoreActions](src/CoreActions.sol) | bounded raw read, typed CoreWriter payload |
| [HyperCoreNavReader](src/HyperCoreNavReader.sol) | 기본 배포의 원금 추정/실현 잔액 reader |
| [PortfolioNavReader](src/PortfolioNavReader.sol), [PortfolioNavMath](src/nav/PortfolioNavMath.sol) | 선택형 정규화 NAV 계산과 검증 |
| [IStrategyBalanceSheet](src/interfaces/IStrategyBalanceSheet.sol) | 생산용 source가 충족해야 하는 인터페이스 |
| [HyperCoreAccountReader](src/HyperCoreAccountReader.sol) | raw 계정 진단. NAV source 아님 |
| [HypeRouter](src/HypeRouter.sol), [FixedReceiverController](src/FixedReceiverController.sol) | native 입출금, 고정 beneficiary 제3자 claim |
| [VaultFactory](src/VaultFactory.sol), [DeployPair](script/DeployPair.s.sol) | atomic pair·deployer·생성 코드 조각, 로컬 배포 리허설 |
| [HyperCoreVault](src/HyperCoreVault.sol) | legacy 회귀 비교용 |
| [scope_watch.py](scripts/scope_watch.py), [book_probe.py](scripts/book_probe.py) | Managed 감시·가격 기록의 판단(읽기 전용), 빈 호가의 precompile 응답 관측 |
| [frontend/](frontend/README.ko.md) | 볼트 탐색·생성·입출금·운용·주문·평가 범위·대화 화면. 주문 서명은 `src/hyperliquid/`, 계약 조회·전송은 `src/chain.ts` |
| [server/](server/README.ko.md) | Vault별 대화 서버(지갑 서명 로그인, SQLite). NAV·권한의 신뢰 원천이 아님 |

## 로컬 검증

```sh
cd <저장소 루트>
forge fmt --check
forge test --offline
python3 -m unittest discover -s test/python -v
forge build --offline --sizes
bash scripts/test_managed.sh    # 위 전체 + storage gate
bash scripts/test_frontend.sh   # frontend와 server에 npm ci 후: ABI drift, format, build, unit
bash scripts/test_server.sh     # server에 npm ci 후: format, typecheck, unit
```

의존성이 없을 때만 `npm ci --ignore-scripts`로 설치한다. offline 빌드는 설정된 solc가 이미 설치된 환경을 전제로 한다. Solidity 빌드/테스트를 동시에 여러 프로세스로 돌리지 않는다. Git 상태는 로컬에서 재확인하며 브랜치·원격 저장소의 존재를 가정하지 않는다.

Core 변경의 집중 검증 예시:

```sh
forge test --offline --match-contract HyperCoreStrategyAccountTest
forge test --offline --match-contract 'CollateralAdmissionTest|PmLifecycleModelTest'
forge test --offline --match-contract CoreActionObserverTest
forge test --offline --match-contract HyperCoreRiskOracleTest
forge test --offline --match-path test/PortfolioNav.t.sol
forge test --offline --match-contract HyperCoreAccountReaderTest
forge test --offline --match-path 'test/Managed*Nav*.t.sol'
```

현재 코드에 적절한 회귀 테스트를 실행하고 결과를 STATUS에 기록한다. 문서만 바꾸는 경우 링크와 내용 일관성을 확인하고 코드 테스트를 새로 통과했다고 쓰지 않는다. 테스트 수와 크기의 마지막 기록은 [STATUS](docs/STATUS.ko.md)에만 갱신한다.

## 읽기 전용 관측 도구

아래 `<...>`는 실제 대상 값으로 바꾼다. 출력에는 새 파일명을 사용한다.

```sh
python3 scripts/nav_probe.py --network mainnet --account <Core-owner-address> --output docs/reference/new-snapshot.json
python3 scripts/nav_reconcile.py docs/reference/new-snapshot.json --output docs/reference/new-reconciliation.json
python3 scripts/action_status.py --network mainnet --account <Strategy-address> --cloid <16-byte-hex> --output /tmp/new-order-status.json
python3 scripts/equity_probe.py --network mainnet --account <Core-account> --output docs/reference/new-equity.json
python3 scripts/precompile_gas_probe.py --network mainnet --with-ledger <account> --without-ledger <account> --token 150 --output docs/reference/new-gas.json
python3 scripts/scope_watch.py --network mainnet --vault <Vault> --source <source> --verifier <verifier> --output docs/reference/new-watch.json
python3 scripts/scope_watch.py --network mainnet --vault <Core-account> --assume-token 0 --assume-dex 0 --output docs/reference/new-watch.json
python3 scripts/book_probe.py --network mainnet --output docs/reference/new-empty-book.json
```

`nav_probe.py`는 여러 `--account`를 지원하고 모든 precompile 조회를 명시한 동일 EVM 블록에 고정한다. `equity_probe.py`는 계정별 고정 블록에서 모든 perp DEX·보유 token·lending·vault equity를 읽어 API 통합 잔액과 대조한다. 공개 RPC는 batch 20건·분당 호출 제한이 있어 계정 사이에 쉰다. `precompile_gas_probe.py`는 `forge build --offline`으로 만든 probe artifact를 고정 블록의 `eth_call` creation code로 실행해 read precompile의 gas를 잰다. 배포·서명·전송이 없다. `scope_watch.py`는 Managed Vault의 Core 계정이 등록 범위 밖에 가진 token·DEX·HyperCore vault를 공개 API로 찾아 신고·갱신·정리 호출을 만들고 가격 기록 시점을 판단한다. 등록된 token의 보유도 다른 pair를 거치는 신고 후보로 낸다. source·verifier 주소를 주면 각 호출을 고정 블록의 `eth_call`로 시뮬레이션해 계약이 받아들이는 것만 `toSend`에 넣는다. source가 없으면 `--assume-*`로 가정한 범위와 비교만 하고 신고는 시뮬레이션하지 않으므로 `toSend`에 신고가 들어가지 않는다(verifier만 주면 가격 기록은 시뮬레이션한다). 계약이 보관하는 신고는 한 건이고 성립하는 동안 자리를 지키므로 `toSend`의 신고도 많아야 한 건이다: 자리가 비어 있으면 받아들여지는 대상 중 API 수치로 가장 커 보이는 곳(`hintUsdc`, 순위용 추정값이고 평가가 아니다), 보관된 신고가 성립 중이면 소멸이 가까울 때의 갱신뿐이다. 호출 인코딩에 `cast`가 필요하고 서명·전송은 하지 않는다. 이 스크립트는 조회가 하나라도 실패하면 보유를 비어 있다고 보지 않고 결과 없이 exit 1로 끝난다. `book_probe.py`는 한쪽 호가가 빈 spot 시장에서 `bbo`·`spotPx` precompile이 무엇을 반환하는지 고정 블록에서 읽는다. 다른 관측 도구는 일부 조회 실패 시 원시 자료를 저장하고 exit code 2를 반환한다. 결과를 삭제하거나 실패 값을 0으로 고치지 않는다. HTTP 응답은 block-pinned가 아니다. 네트워크 DNS/권한 오류를 프로토콜 실패로 해석하지 않는다.

오프라인 대조와 HTTP 주문 진단은 온체인 NAV·재시도 권한을 만들지 않는다. 새 관측의 출처와 한계는 [reference/README](docs/reference/README.md) 및 관련 증거 문서에 기록한다. 기존 원시 스냅샷을 덮어쓰지 않는다.

## FE와 대화 서버 인계

[ADR-031](docs/DECISIONS.ko.md#adr-031)(브라우저 agent 키로 주문 서명)과 [ADR-032](docs/DECISIONS.ko.md#adr-032)(지갑 서명 로그인 대화 서버)를 읽는다. 실행 방법과 환경 변수는 [frontend/README](frontend/README.ko.md)와 [server/README](server/README.ko.md)에 있다. 이어받을 때 지킬 것:

- agent 키는 브라우저에서 만들고 암호로 암호화해 그 브라우저에만 둔다. 서버나 로그로 보내는 경로를 만들지 않는다. 주문 전송(`VITE_ENABLE_TRADING`)과 계약 쓰기(`VITE_ENABLE_WRITES`)는 기본으로 꺼져 있고, **실제 주문·서명 전송·메인넷 쓰기는 한 번도 실행하지 않았다.**
- 주문 서명은 공식 SDK의 벡터와 대조한 것이다(`frontend/src/hyperliquid/signing.test.ts`). 서명·주문 문자열 규칙을 바꾸면 그 벡터를 다시 통과시킨다. 컨트랙트 계정의 agent로 낸 주문이 실제로 Vault에 귀속되는지는 확인하지 않았다([MARKET-002](docs/BACKLOG.ko.md#market-002)).
- 주문 화면이 등록 범위 안의 시장만 고르게 하는 것은 실수를 줄이는 장치이지 보안 경계가 아니다.
- 볼트 목록은 Factory의 `vaultCount`와 deployer의 CREATE nonce 규칙으로 계산하고 `isVault`로 확인한다(`test/ManagedUsdcVault.t.sol`의 `testVaultAddressesCanBeEnumeratedFromTheDeployerNonce`가 규칙을 고정한다). 서버나 indexer를 Vault의 존재·NAV·권한의 근거로 쓰지 않는다.
- 대화 서버의 로그인 서명은 서버의 `CHAT_AUDIENCE`에 묶인다. FE의 `VITE_CHAT_URL`과 글자 그대로 같아야 한다. 계약 조회는 EIP-3668 offchain lookup을 따라가지 않게 꺼 두었다(서버와 FE 모두 `ccipRead: false`). 다시 켜지 않는다.
- 계약 ABI가 바뀌면 `frontend`에서 `npm run abi`로 다시 내보낸다. `scripts/test_frontend.sh`가 drift를 검사한다.

## 다음 세션에 전달할 프롬프트

> 저장소 루트의 `HANDOVER.ko.md`를 읽고 작업을 이어서 진행해줘. 연결된 SSOT 문서에서 현재 상태와 설계 결정을 확인하고 BACKLOG의 다음 READY 작업부터 진행해줘. PM 전환·자동 공급 항목이 남아 있으면 먼저 가설을 재현하고 검증해줘. 최근 raw position 수량 정규화는 유지하고, 실제 관측·mock 가정·미검증 사항을 구분해줘. 완료한 변경은 관련 명세, STATUS, BACKLOG, CHANGELOG에 반영해줘.
