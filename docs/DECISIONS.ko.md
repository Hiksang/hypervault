# 설계 결정 기록

최종 갱신: 2026-10-05 KST. 기존 대화·기획·구현의 기준을 이관한 기록이며 모든 결정을 이 날짜에 새로 내렸다는 뜻은 아니다. 현재 완료 상태는 [STATUS](STATUS.ko.md), 실행 항목은 [BACKLOG](BACKLOG.ko.md)에서 관리한다.

상태: `ACCEPTED`는 채택된 설계, `BASELINE`은 현재 구현을 유지하는 작업 기준, `PROPOSED`는 미채택 제안, `SUPERSEDED`는 후속 결정으로 대체됨을 뜻한다. BASELINE을 사용자에게 확인된 영구 상품 요구로 확대하지 않는다. 변경 시 새 ID를 만들고 이전 항목에 대체 ID를 연결한다.

<a id="adr-001"></a>
## ADR-001 — Vault와 StrategyAccount 분리

**상태: ACCEPTED (현행 WHYPE 구현); USDC 계정 분리는 [ADR-014](#adr-014)로 대체.** 사용자 지분·출금 요청·준비금·정산은 Vault, Core 자산과 주문·공급·회수 상태는 Strategy가 담당한다. 현행 WHYPE의 ERC7540 회계와 운용 계정 분리를 유지한다.

두 계약은 한 번 연결되며 proxy·Strategy 교체·임의 관리자 출금 기능은 없다. 상품이나 자산을 바꾸는 경우 새 쌍과 명시적인 이전 경로가 필요하다. [구현 명세](split-implementation.ko.md)

<a id="adr-002"></a>
## ADR-002 — OZ 기반 지분과 ERC7540 비동기 출금

**상태: ACCEPTED.** stable OpenZeppelin ERC4626/ERC20을 기반으로 비동기 출금을 직접 구현한다. ERC7540은 Ethereum 표준이며 OpenZeppelin 고유 표준이 아니다. Community ERC7540은 현재 의존성이 아니다.

지분은 escrow 후 epoch 정산에서 소각한다. 같은 requestId의 환율과 준비금을 공유하며 부분 claim, 전손, dust 귀속을 명시한다. 확정 claim 채무는 주주 NAV·투자·recap에서 제외한다. 표준 claim 권한과 ERC20 allowance는 별개다. 전체 표준 적합성 검증은 [STD-001](BACKLOG.ko.md#std-001)에서 추적한다.

<a id="adr-003"></a>
## ADR-003 — WHYPE 기준 1x HYPE carry 유지

**상태: SUPERSEDED (후속 상품 목표는 [ADR-010](#adr-010)); 현행 코드 기준선은 유지.** 현재 구현의 입출금·지분 회계는 WHYPE, native HYPE는 Router에서 변환한다. HYPE 공급과 같은 수량의 short를 조합한다. 별도 USDC 차입으로 현물을 더 사는 레버리지 전략은 이 구현 범위에 포함하지 않는다.

2026-10-02 이전에는 USDC 기준 Vault로 전환한다는 후속 결정이 없어 기존 구현을 유지했다. 같은 수량의 hedge는 대략 quote 통화 기준 델타 중립이며 HYPE 수량 보존을 보장하지 않는다. 후속 USDC 상품은 기존 코드를 제자리에서 변경하거나 현행 지분의 underlying을 바꾸지 않고 새 배포 쌍으로 구현한다. [자산 기준과 NAV 설계](nav-liquidity-architecture.ko.md)

<a id="adr-004"></a>
## ADR-004 — Strategy 주소가 Core 실행 주체

**상태: ACCEPTED (현행 WHYPE 구현 범위).** Core 계정 소유자와 CoreWriter caller는 Strategy의 EVM 주소다. 현재 코드는 API wallet을 발급하거나 등록하지 않는다. keeper는 EVM에서 허용된 상태 전이를 호출한다. 새 USDC 다중 시장 상품의 agent wallet·builder fee 경로는 [ADR-011](#adr-011)의 별도 권한 검토 대상이며 이 결정만으로 구현됐다고 보지 않는다.

누구나 실행 가능한 회수 진행과 고정 beneficiary 지급 경로를 유지한다. 표준 claim은 controller/operator가 실행하고, 제3자 지급은 `FixedReceiverController`를 이용한다. 이 설계는 Core에서 미확정인 액션을 무시하고 즉시 지급하는 기능을 뜻하지 않는다. [권한·수령 방식](split-implementation.ko.md)

<a id="adr-005"></a>
## ADR-005 — 미확정 Core 액션은 증거 없이 재시도하지 않음

**상태: ACCEPTED.** 한 번에 하나의 금융 pending을 추적하고 cycle/action 식별자와 payload 정보를 유지한다. 경과 시간, HTTP status, 단일 잔액 변화만으로 실패 확정·pending 삭제·재주문을 허가하지 않는다.

새 운용자 신뢰형 USDC의 API 직접 주문은 이 EVM pending 원장을 경유하지 않는다. [ADR-023](#adr-023)의 관리 액션 원장과 계정 전체 관측을 구분하며, 모든 거래가 EVM에서 직렬 통제된다고 가정하지 않는다.

`ExpectedEffect`는 계정에서 기대한 변화의 관측이며 cloid별 receipt 증명이 아니다. 확정 실패 판정이나 새로운 attestation 신뢰 모델을 도입하려면 별도 결정과 검증이 필요하다. PM bootstrap 확인도 운영자 기록이라는 한계를 유지한다. [관측 명세](core-action-recovery.ko.md), [CORE-002](BACKLOG.ko.md#core-002)

<a id="adr-006"></a>
## ADR-006 — 검증된 NAV 이후 Active 입금과 부분 회수

**상태: ACCEPTED.** 확장 순서는 생산용 source·공정 가격 검증 → 운용 중 동기 입금 → 필요시 유동성 buffer와 부분 회수 → 외부 다중 전략이다. 첫 USDC 배포 후보의 전량 회수 방식은 [ADR-012](#adr-012)를 따른다. Harmonix haUSDC 글은 제품 방향 참고이며 그 서비스의 CoreWriter·PM·API wallet 구현을 확인한 근거로 쓰지 않는다.

source는 같은 시점과 통화의 자산·부채·손익을 중복 없이 제공해야 한다. 원금 추정치나 오래된 캐시로 새 지분을 발행하지 않는다. source와 reader는 immutable이다. 현 단계에서는 Idle 입금과 실현 WHYPE 기반 출금 정산을 유지한다. [NAV 상세 설계](nav-liquidity-architecture.ko.md)

<a id="adr-007"></a>
## ADR-007 — raw 관측·단위·완전성을 명시

**상태: ACCEPTED.** API 통합 잔액과 raw precompile 값을 구분한다. read 실패·API 생략을 0으로 치환하지 않는다. `rawSzi × orderSizeLot`로 주문 단위를 맞추며 `orderSizeLot=10^(8-szDecimals)` 설정을 검증한다. 범위 초과는 거부한다.

다른 필드의 decimals를 유추해 공통 적용하지 않는다. accountValue에 이미 포함된 PnL이나 통합 잔액에 포함된 lending을 다시 더하지 않는다. `cumFunding`은 미정산 수익으로 취급하지 않는다. 일부 표본의 항등식이 맞아도 전체 계정 NAV의 완전성으로 확대하지 않는다. [실측 근거](pm-nav-evidence.ko.md)

<a id="adr-008"></a>
## ADR-008 — 0 share 전송은 OZ ERC20 경로로 처리

**상태: ACCEPTED.** 유효한 비제로 주소 사이의 0 share `transfer/transferFrom`은 Vault 주소가 포함돼도 성공하고 `Transfer` 이벤트를 발생시킨다. ERC20의 0 전송 규칙에 맞추며, 비양도 Vault 예외를 현재 양도 가능한 지분의 0 전송 거부 근거로 사용하지 않는다. [표준 검토](standards-review.ko.md#std-c01--vault-주소로의-0-share-전송도-제한됨)

`EpochRedeem._update`의 custody 제한은 양수 수량에만 적용한다. `super._update`와 OZ 주소·allowance 검사를 유지하며 조기 return으로 이벤트를 생략하지 않는다. 0 전송은 출금 요청·claim 권한을 만들지 않고 0 share `requestRedeem`은 계속 거부한다. Vault가 관여하는 양수 직접 전송은 차단하며 요청 escrow와 정산 burn만 허용한다. 이는 목적지 제한을 완전히 없애는 결정이 아니다.

<a id="adr-009"></a>
## ADR-009 — 초기 공급 전에 lending 무노출 조건을 다시 확인

**상태: ACCEPTED.** `startCycle`에서 확인한 HYPE lending 무노출 조건을 첫 explicit supply 직전에 다시 검사한다. 성공한 read의 `supply.value` 또는 `borrow.value`가 비제로이면 기존 `ResidualExposure`로 거부한다. 검사를 통과한 뒤 bridge target을 지우고 원래 수량을 제출한다. read 실패는 계속 revert하며 0으로 치환하지 않는다. [모형 재현 근거](pm-lifecycle-model.ko.md)

이 결정은 기존 공급이 생긴 뒤 외부 raw spot 증가로 target만 충족되는 경우 전액 공급을 추가 제출하지 않도록 한다. supply 잔액을 이번 bridge 원금으로 인정하거나 hedge 개설을 허가하지 않는다. 정상 명시적 공급 이후의 pending 관측 조건은 유지한다. ABI·storage·PM attestation 신뢰 모델은 바꾸지 않는다.

자동 공급 지원과 회수 완료 가능성을 해결한 결정이 아니다. raw spot target 미달은 여전히 진행을 막는다. spot+supply 합산, bridge 관측 저장만으로 검사 생략, 부분 자동 공급의 부족분 계산, 가스/다음 cycle 귀속은 실측과 별도 설계가 필요하다.

<a id="adr-010"></a>
## ADR-010 — 후속 Vault의 HyperEVM USDC 입금과 Strategy Core 계정

**상태: ACCEPTED (USDC 자산·이동 경로); 별도 Strategy 주소는 [ADR-014](#adr-014)로 대체.** 후속 상품은 HyperEVM의 Circle native USDC를 기초자산으로 한다. 사용자는 HyperEVM에서 Vault에 USDC를 예치하고 USDC 기준 share·출금 권리를 가진다. 기존 WHYPE 쌍과 지분의 기초자산은 변경하지 않는다. 후속 상품의 운용 결과는 USDC로 회수·정산한다. HYPE 현물 매수와 perp short는 가능한 거래 조합의 한 예이며 상품의 고정 전략이나 시장 범위를 뜻하지 않는다. 목표 거래 범위는 [ADR-011](#adr-011)이 정한다. 이 결정 자체는 수수료·cap·위험 수치나 수익률을 확정하지 않았고, 후속 USDC 성과 수수료는 [ADR-016](#adr-016)이 정한다.

Vault가 배정한 USDC를 HyperCore의 **Strategy 주소**로 보내는 기본 경로는 Circle `CoreDepositWallet.depositFor(strategy, amount, destinationDex)`다. Vault는 해당 계약에 정확한 allowance를 주고 바로 호출한다. 이는 Vault→Strategy의 별도 EVM ERC20 전송과 Strategy의 `deposit` 호출을 한 단계 줄이고 중간 잔액의 소유권 추적도 단순화한다. 입금 전에 사람이 Core 도착을 검증하거나 별도로 승인할 단계는 없다. 다만 EVM 호출 성공만으로 같은 EVM 블록에서 Core 잔액이 생겼다고 가정하지 않으며, **후속 Core 거래를 제출하기 전** Strategy의 사용 가능 잔액을 자동 관측한다. USDC를 `CoreDepositWallet` 주소로 단순 ERC20 송금하는 방식은 Circle 문서상 입금이 되지 않고 자금이 묶이므로 금지한다. `destinationDex`는 필요한 최초 Core 동작과 계정 모드에 맞춰 검증된 값으로 고정한다. Strategy가 직접 `deposit`을 호출하는 경로는 필요할 때 별도 검토하며 두 경로를 한 cycle에서 혼용하지 않는다.

역방향은 Strategy의 CoreWriter `SendAsset`로 USDC를 연결된 EVM 수령 경로에 이동시키고 Strategy의 실제 HyperEVM USDC 수신을 확인한 뒤 Vault에 반환하는 설계다. 계약 발신 `SendAsset`의 source DEX·계정 모드·수신자 제약·순수령액은 통제된 네트워크 실험으로 검증하기 전까지 `CONDITIONAL`이다. 계정 활성화 비용, HyperEVM HYPE 가스, EVM 6자리/Core 8자리 단위 변환과 잔여량을 원장에 포함한다. `depositFor`와 CoreWriter를 같은 블록에서 연속 사용해 결과를 확정했다고 가정하지 않는다. [USDC 경로 설계](vault-architecture.ko.md#7-usdc-목표-경로와-검증-조건), [USDC-001](BACKLOG.ko.md#usdc-001)

위 두 문단의 **별도 Strategy 수신·반환 주소는 이전 설계 기록**이다. 새 USDC 제품의 현행 목표 주소와 공개 생성/활성화는 [ADR-014](#adr-014)를 적용하며, 검증되지 않은 Core credit·역방향 전송 조건은 유지한다.

<a id="adr-011"></a>
## ADR-011 — USDC Vault의 필수 거래 범위는 spot·HIP-3·HIP-4

**후속 권한 구체화:** 아래 시장 지원·NAV/회수 요구는 유지한다. [ADR-023](#adr-023)은 운용자가 API wallet으로 직접 주문하는 신뢰 모델을 채택하므로 시장/노출 정책을 EVM에서 모든 주문에 강제한다는 가정은 적용하지 않는다.

**상태: ACCEPTED (제품 목표; 구현·시장별 실측 미완료).** 새 상품은 Hyperliquid의 기본 HyperCore Vault를 재사용하지 않는다. [ADR-014](#adr-014)에 따라 HyperEVM USDC 입출금·지분 Vault 주소 자체를 Core 계정으로 쓴다. 기본 Vault의 validator 운영 perp 중심 범위를 넘어 **HyperCore spot, HIP-3 builder-deployed perps, HIP-4 outcomes**를 거래할 수 있는 것이 핵심 제품 요구다. validator 운영 perp도 지원 대상이다. 고정 HYPE carry만 수행하는 첫 USDC 상품은 이 요구를 충족하지 않는다. 현행 WHYPE 프로토타입은 이 결정으로 기능이 추가되지 않는다. [다중 시장 아키텍처](vault-architecture.ko.md#8-usdc-다중-시장-거래-아키텍처)

시장별 주문·취소와 조회 범위, 담보/자산/부채·수수료·만기 정산, 위험 한도와 USDC 회수 경로를 명시한 adapter를 둔다. share 가격은 spot 잔고만 또는 기본 perp 계정만으로 확정하지 않는다. HIP-3 DEX별 상태와 HIP-4 outcome의 미결제·만기·정산 가치를 빠뜨리거나 중복 계산하면 신규 지분 발행·출금 정산을 중단한다. 시장별 지원 가능성은 공식 asset ID·계정 모드·CoreWriter/API 기능과 통제된 네트워크 거래로 확인한다. HIP-4는 제한된 출시 범위를 시장 전체 지원으로 확대하지 않는다.

Agent/API wallet은 현재 발급·등록되지 않는다. Hyperliquid는 CoreWriter action 9로 agent 등록, action 12로 builder fee 상한 승인을 제공하지만, 현재 CoreWriter order action 1에는 builder 파라미터가 없다. Agent 서명 API 주문·builder fee를 도입하면 오프체인 키 보관, 허용 액션·시장, fee 한도, nonce/만료·교체, 재시도와 permissionless 회수의 권한 경계를 별도 채택·검증한다. 승인만으로 모든 주문에 fee가 발생한다고 가정하지 않는다. [권한/수수료 과제](BACKLOG.ko.md#market-002)

<a id="adr-012"></a>
## ADR-012 — USDC 단일 자산 Vault의 표준과 초기 출금 유동성

**상태: ACCEPTED (후속 상품 설계 목표; Vault 부분 구현·실측 미완료).** 사용자가 HyperEVM **USDC만 입금하고 USDC만 청구**하는 새 상품은 stable OpenZeppelin Contracts의 ERC20/ERC4626을 지분·입금 기반으로 쓰고 ERC7540의 **동기 입금 + 비동기 출금** 요청·epoch 정산을 구현한다. Core에서 거래하는 spot token·HIP-3 담보·HIP-4 outcome은 내부 포트폴리오 자산이지 사용자 입금 자산이 아니므로 다중 입금 자산용 ERC7575 진입점을 추가할 이유가 없다. ERC7540이 요구하는 `share()`와 ERC165 호환성은 유지한다. [USDC Vault](usdc-vault-implementation.ko.md)는 기존 epoch 회계를 재사용하되 자산별 입출금·정산 조건을 별도 검증한다. OpenZeppelin Community Contracts에는 ERC7540 모듈이 있으나 stable `@openzeppelin/contracts` 5.4.0 의존성에 포함되지 않고, 해당 저장소의 미감사·호환성 보장 부재를 고려해 기본 의존성으로 채택하지 않는다. [표준 선택 근거](standards-review.ko.md#후속-usdc-vault의-표준-선택)

첫 USDC 배포 후보는 **즉시 출금이나 운용 중 부분 출금을 약속하지 않는다.** 목표 운용 USDC buffer는 0으로 시작할 수 있으며, epoch 요청 후 허용된 모든 시장 포지션을 종료·매도·만기 정산하고 실제 USDC를 Vault로 회수한 다음 동일 requestId를 같은 환율로 확정한다. 이때 이미 확정된 `reservedClaimAssets`는 **필수 지급 준비금**이며 투자용 buffer와 다르다. 확정 청구액을 다시 Core에 배정하지 않는다. HIP-4처럼 제때 현금화할 수 없는 시장은 전량 회수 가능성과 최대 대기 기간을 검증하기 전 배포 후보의 허용 시장에서 제외한다. buffer가 없어도 지연·실패 없는 출금을 보장하는 것은 아니다. 더 빠른 출금이나 cycle 유지 부분 회수를 제공할 때에는 검증 NAV, 동일 epoch 비례 정산, 잔존 포지션 위험과 buffer/회수 규모를 [LIQ-001](BACKLOG.ko.md#liq-001)에서 별도로 설계한다. HyperEVM 거래 가스용 HYPE는 USDC 유동성 buffer와 별도 운영 자금이다. [출금 상세](plans/liquidity-exits.ko.md)

<a id="adr-013"></a>
## ADR-013 — USDC Vault의 비요청 송금은 주주 현금에서 격리

**상태: ACCEPTED (Vault 로컬 구현; Core/Strategy 방어 미완료).** Vault가 `deposit/mint`로 실제 받은 USDC와 연결된 Strategy의 정산 반환으로 실제 받은 USDC만 `accountedCash`에 더한다. Core 배정·claim·rounding dust 지급은 이 장부에서 뺀다. `availableCash = accountedCash - reservedClaimAssets`이고, 실제 USDC 잔액이 장부보다 작으면 중단한다. 누구나 Vault 주소에 직접 보낼 수 있는 USDC는 `unaccountedUsdc`로만 관측하고 지분 가격·입금 한도·epoch 지급·다음 Core 배정에 포함하지 않는다. 임의 ERC20도 USDC 자산 장부에 포함하지 않는다. 비요청 토큰의 회수·귀속 정책은 아직 채택하지 않았으므로 자동 흡수·관리자 인출 권한을 추가하지 않는다. [현행 구현](usdc-vault-implementation.ko.md)

이 격리는 Vault EVM 주소로 **직접** 들어온 토큰에 한정된다. 현행 로컬 코드의 별도 Strategy Core 계정이나 [ADR-014](#adr-014)의 단일 Vault Core 계정에 제3자가 Circle `depositFor`로 USDC를 credit하거나 임의 Core 토큰을 보내는 것은 송금 자체를 막을 수 없다. 생산용 Core 실행 로직은 cycle별 예상 입금·액션 식별자·전후 잔액/포지션·인플라이트를 대조하고 미확인 증가분을 운용·정산·NAV에서 격리하거나 확정 전 중단해야 한다. **전후 잔액만으로 동액의 외부 입금과 자기 입금을 구별할 수 없으므로** 귀속 증거가 없으면 성공으로 판정하지 않는다. EVM USDC 직접 수신도 검증된 회수분과 구분해야 한다. 이 수신 경계의 실제 구현·통제 실험은 [USDC-001/002](BACKLOG.ko.md#usdc-001)에 남는다.

<a id="adr-014"></a>
## ADR-014 — 공개 USDC Factory와 Vault 주소의 Core 계정

**후속 권한 구체화:** [ADR-023](#adr-023)에 따라 창설자는 변경 불가 owner이며 별도 owner whitelist 없이 typed 관리 함수의 `onlyOwner`로 통제한다. 검증된 계약 템플릿과 자금 수령 경로는 유지하되 API 주문의 시장/위험 한도를 Factory가 강제한다는 의미로 해석하지 않는다.

**상태: ACCEPTED (목표 설계; 코드·통제 실험 미완료).** 누구나 고정된 배포 템플릿의 새 USDC Vault를 생성할 수 있다. 창설자가 주소별 운영 역할·상한 등 허용된 설정을 선택하되, 사용자 지분 계약·CoreWriter 액션 제한·검증된 시장 모듈을 임의 코드로 바꾸거나 Factory 권한으로 주주 자금을 이동할 수는 없다. 창설자 관리 Vault와 프로젝트가 직접 운영하는 Vault는 출처와 역할을 명시해 혼동하지 않는다. Factory는 생성 허가자나 모든 Vault의 관리자가 되지 않는다. 현행 WHYPE Factory와 이미 작성한 `AsyncUsdcVault`의 별도 Strategy 연결은 새 상품의 구현 목표가 아니다.

Vault의 HyperEVM 주소 자체가 Core 계정 소유자다. Vault가 `CoreDepositWallet.deposit` 또는 자기 주소를 recipient로 한 `depositFor`를 호출하고, CoreWriter 액션도 Vault 주소에서 제출한다. Core→EVM USDC 수신자는 같은 Vault 주소다. 시장별 로직을 별도 계약에 두더라도 외부 모듈의 직접 CoreWriter 호출은 모듈 주소의 Core 계정에 귀속되므로, Vault의 제한된 실행 함수 또는 검증된 내부 라이브러리 경계를 통해야 한다. 자산 장부·출금 준비금·비요청 송금 격리는 [ADR-013](#adr-013)을 유지한다. 이 단일 주소 흐름과 크기/권한 분리는 실측·빌드 확인이 필요하다.

활성화 자금 출처와 절차에 관한 이 결정의 이전 `Factory → depositFor(newVault)` 제안은 [ADR-015](#adr-015)로 대체한다. 공개 생성·단일 Vault/Core 주소 결정은 유지한다.

<a id="adr-015"></a>
## ADR-015 — 창설자 운용 Vault와 창설자 Core USDC 활성화

**상태: PARTIALLY SUPERSEDED by [ADR-021](#adr-021) (운용자·계정 권한 목표는 유지; Core 직접 송금으로 지분을 받는 경로는 초기 제품에서 제외).** 공개 Factory에서 Vault를 만드는 사람은 그 Vault의 **운용자**가 된다. 다른 사용자는 HyperEVM USDC를 Vault의 `deposit/mint`에 예치해 지분을 받고, 운용자는 허용된 spot·HIP-3·HIP-4·기본 perp 시장의 포지션을 관리한다. 생성자/운용자 권한은 생성 시 고정된 규칙으로 부여하고 이후 변경 정책도 명시해야 한다. Factory 호출자가 임의 실행 코드나 무제한 자금 이체 권한을 선택할 수는 없다. 예치자 출금·claim, 위험 한도, 강제 종료 경로는 운용자에게 종속되지 않게 설계한다.

**아래의 Core 직접 송금으로 창설자 지분을 발행하는 절차는 ADR-021에서 초기 제품 경로로 제외된 이전 설계다.** Vault는 `AwaitingActivation`으로 배포한다. 기본 생성 자금 배정은 [ADR-020](#adr-020)의 HyperEVM USDC 경로를 따른다. 창설자가 이미 자기 HyperCore 계정에 USDC를 보유한 경우에는 새 Vault의 동일 주소 Core 계정으로 직접 전송하는 대체 경로를 지원한다. [ADR-019](#adr-019)에 따라 최초 **실수령 Core USDC 100은 창설자 자기자본·지분의 근거**이며, 활성화만을 위한 별도 송금이 아니다. Core 송금으로 신규 계정을 활성화할 때 수수료는 송금인 Core 잔액에서 전송액과 별도로 차감되는 구조라는 [OpenZeppelin의 연동 감사 근거](https://www.openzeppelin.com/news/sponsored-periphery-audit)가 있다. 예를 들어 창설자가 Core USDC 100을 보내려면 100 전송액과 1 quote-token 비용을 충당할 잔액이 필요하며, Vault 수령액이 자동으로 99가 되는 것으로 계산하지 않는다. 우리 서명 전송 경로의 전후 잔액은 통제 거래로 확인해야 한다. Factory는 창설자의 Core 잔액을 인출하지 않는다. CoreWriter 액션은 EVM에서 호출한 계정의 Core 주소에 귀속되므로 Factory가 CoreWriter를 호출하면 Factory의 Core 자금이 원천이다. Core-only 대체 경로는 창설자 본인이 서명한 HyperCore `sendAsset`/해당 계정 모드의 USDC 전송이다. 창설자 EOA가 EVM의 CoreWriter를 직접 호출하는 UX는 source 주소·action 성공을 통제 실험한 뒤 추가한다. 이 Core-only 대체 경로는 Factory 생성 EVM 거래와 별도의 창설자 서명·Core 전송 단계이며 원자적 단일 거래로 표시하지 않는다. [CoreWriter 공식 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), [Core 전송 API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint), [활성화 수수료](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee)

후속 블록에서 `userExists(vault)`와 실제 Core 잔액·활성화 비용을 관측한다. `userExists`만으로 창설자 송금의 출처나 금액은 증명되지 않으며 Core 잔액 조회만으로도 송금자를 증명할 수 없다. [ADR-019](#adr-019)의 1회성 창설자 자본 인식은 출처 증명 대신 **초기 Core USDC 실수령과 창설자 수익권 귀속**을 정책으로 택한다. 그 외 미확인 잔액을 주주 NAV·운용 가능액에서 배제하는 회계 경계를 온체인에서 확인해야 한다. Core 전송 기록의 송금자·금액 대조는 별도의 관측 증거로 보관하며, 그 기록을 온체인에서 검증할 방법이 없으면 `finalizeActivation`이 이를 증명한다고 표현하지 않는다. 제3자의 선제 활성화나 초과 송금은 운용자 권한·지분을 자동으로 만들지 않는다. 초과·미확인 자금을 관리자에게 무조건 인출시키지 않고 안전하게 격리한다. [Factory 작업](BACKLOG.ko.md#factory-001)

<a id="adr-016"></a>
## ADR-016 — USDC Vault 출금 이익의 10%를 총 성과 수수료로 징수

**상태: ACCEPTED (새 USDC 상품의 총 수수료율; 배분은 [ADR-017](#adr-017), 코드·회계 검증 미완료).** [ADR-015](#adr-015)의 공개 Factory Vault에서는 다른 예치자의 **실제 USDC 출금 이익 중 10%**를 총 성과 수수료로 징수한다. 각 Vault의 수수료율은 첫 템플릿에서 1,000 bps로 고정하고 운용자가 올릴 수 없다. 당시 제안한 수령 주소는 생성 시의 운용자 주소였다. 운용자 자신의 share, 입금 원금, 손실, 창설자 Core 활성화 자금에는 성과 수수료를 매기지 않는다. 관리·입금·정액 출금 수수료는 이번 결정에 포함하지 않는다. 이 결정은 WHYPE 프로토타입의 수수료를 바꾸지 않는다.

위 문단의 **성과 수수료 전액을 운용자에게 지급한다는 배분은 [ADR-017](#adr-017)로 대체**한다. 사용자에게 부과하는 이익의 10%라는 총 수수료율은 유지한다.

사용자별 실제 납입 USDC 원가와 확정 손실 이월을 보존한다. 출금 요청 시 해당 share의 원가를 잠그고, 실제 회수액으로 요청의 총 권리를 정산한 뒤 `max(총 권리 − 해당 원가 − 이전 손실 이월, 0)`의 10%를 청구한다. 손실 이월과 소수 수수료 잔여는 다음 요청까지 유지해 손실 회복 전 징수와 소액 분할 회피를 막는다. 사용자가 Claim을 실행할 때 Vault는 총 권리에서 수수료를 떼어 [ADR-017](#adr-017)의 운용자/플랫폼 비율로, 나머지를 사용자에게 같은 거래로 지급한다. 총 권리 전체는 Claim 전까지 재투자 불가 준비금으로 잠근다. Pending 단계의 원금 추정이나 확인되지 않은 Core 수익으로 fee를 선징수하지 않는다.

사용자별 순수령 환율이 달라지므로 동일 epoch의 모든 사용자에게 같은 외부 `requestId`를 주는 현행 구조는 적용하지 않는다. 내부 정산 epoch와 사용자별 고유 ERC-7540 요청 ID를 분리한다. 첫 유료 템플릿에서 양수 share 직접 양도와 다른 사람의 controller로 요청을 합치는 행위를 제한하고 한 사용자에게 한 번에 하나의 미완료 요청만 허용해 원가·손실 이월의 순서를 고정한다. operator의 대리 호출은 owner/controller가 동일한 권리를 유지하는 범위에서 허용한다. 순수령 `maxWithdraw`·`redeem/withdraw`와 Claim 시 수수료 지급의 표준 적합성은 구현 전 검증해야 한다. [상세 수식·원장](performance-fee-architecture.ko.md), [FEE-001](BACKLOG.ko.md#fee-001), [ERC-7540 요청 ID 규칙](https://eips.ethereum.org/EIPS/eip-7540#request-ids)

<a id="adr-017"></a>
## ADR-017 — 성과 수수료의 20%를 플랫폼에 배분

**상태: ACCEPTED (새 USDC 상품 목표; 구현 미완료).** [ADR-016](#adr-016)의 사용자 이익 10% 성과 수수료 총액을 유지하되, 징수한 수수료의 **20%는 플랫폼**, 나머지 **80%는 해당 Vault 창설자/운용자**에게 지급한다. 사용자에게 10%와 별도로 플랫폼 수수료를 추가하지 않는다. 따라서 과금 대상 이익 20 USDC라면 사용자 성과 수수료는 2 USDC, 사용자 순수령은 총 출금 권리에서 2 USDC를 뺀 값, 운용자 몫은 1.6 USDC, 플랫폼 몫은 0.4 USDC다. 이 수치는 총 이익의 각각 8%와 2%에 해당한다.

첫 템플릿의 수수료율(1,000 bps)과 플랫폼 배분율(성과 수수료의 2,000 bps)은 배포 코드에서 고정한다. 창설자는 생성 시 수령 주소나 배분율을 임의로 바꾸지 못한다. 사용자 순수령·운용자 몫·플랫폼 몫의 합은 확정 총 출금 권리와 같아야 한다. 작은 출금을 나눠 플랫폼 몫의 반올림을 회피하지 못하도록 잔여 정밀도를 이어받는다. Claim 전에 성과 수수료 **전체**를 출금 준비금에서 분리해 선인출하지 않고, Claim에서 세 주소로 원자적으로 지급한다. 플랫폼 Treasury의 주소·변경 권한은 Factory의 검증된 설정으로 제한하고 실제 주소는 배포 manifest에 기록한다. [상세 분할 원장](performance-fee-architecture.ko.md), [FEE-001](BACKLOG.ko.md#fee-001)

<a id="adr-018"></a>
## ADR-018 — 생성 시 창설자 자기자본 100 USDC

**상태: PARTIALLY SUPERSEDED by [ADR-019](#adr-019), 첫 EVM 납입·즉시 지분 발행은 [ADR-021](#adr-021)에서 다시 채택.** 창설자 초기 자기자본 100 USDC는 플랫폼 생성 수수료가 아니며 창설자에게 share를 발행한다는 정책은 유지한다. 아래의 **생성 EVM 거래에서만 100 USDC를 납입한다는 경로**와 Core 직접 전송은 지분으로 인정하지 않는다는 제한은 ADR-019로 대체한다. 운용자 자신의 share는 [ADR-016](#adr-016)의 성과 수수료 과금 대상이 아니다. 창설자 지분의 운용 중 출금 제한은 [OPEN-09](plans/README.md#정책-결정-등록부)에서 정한다.

**다음 두 문단은 ADR-019로 대체된 이전 경로다.** 당시 첫 지분 발행 경로는 Factory 생성 EVM 거래에서 창설자 USDC 100을 `transferFrom`으로 받아 새 Vault의 생성자 전용 `deposit` 경로에 넣고 같은 거래에서 share를 발행하는 것이었다. Factory는 USDC를 영구 보유하지 않고 Vault는 실제 수신액만 장부·원가에 넣도록 했다. 활성화 전에는 일반 사용자 입금과 Core 거래를 닫고, 실패 시 장부의 EVM 원금만 반환하는 취소 경로를 제안했다.

창설자가 자금을 Core에 보유 중이면 공식 Core→HyperEVM USDC 전송으로 **같은 창설자 EVM 주소**에 옮긴 뒤 위 100 USDC 예치를 실행할 수 있다. Circle은 이 전송의 EVM 수신자를 원래 Core 주소와 같은 주소로 제한한다. 반면 창설자가 Core USDC 100을 **Vault Core 주소로 직접 전송**하면 Core 잔액 증가는 읽을 수 있어도 EVM 계약이 그 송금자를 검증해 창설자 share를 안전하게 발행할 방법이 현재 확인되지 않았다. 따라서 이 직접 전송은 생성자 투자금으로 자동 인정하지 않고 [ADR-015](#adr-015)의 활성화/미확인 자산 격리 규칙을 따른다. Core 계정 활성화의 1 quote-token 비용은 창설자 자기자본 100과 **별도**이며 주주 원금으로 계상하지 않는다. 따라서 100 USDC 창설자 지분이 자동으로 99 USDC가 되지 않는다. Core 직접 송금의 수수료는 별도 송금자 잔액에서 지출한다는 외부 감사 근거가 있으나, 우리 송금 경로의 차감액·Vault 수령액은 통제 거래 전후에 대조해야 한다. [창설 흐름](vault-architecture.ko.md#9-공개-factory와-core-활성화), [Factory 작업](BACKLOG.ko.md#factory-001), [Circle Core→EVM 전송](https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-hyperevm), [활성화 비용](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee)

<a id="adr-019"></a>
## ADR-019 — 최초 Core USDC 100을 창설자 지분으로 인식

**상태: PARTIALLY SUPERSEDED by [ADR-020](#adr-020) 및 [ADR-021](#adr-021).** 창설자 초기 자기자본 100과 중복 발행 금지 원칙은 유지한다. Core 실수령 후에야 share를 발행하는 시점과 Core 직접 송금의 창설자 지분 귀속은 ADR-021의 EVM 입금 기준으로 대체됐다. 아래 Factory 생성 **후** 창설자 Core 송금 경로를 유일한 첫 경로로 삼았던 부분은 ADR-020의 생성 거래 내 EVM 조달·Core 배정으로 대체한다. Core에서 직접 자금을 조달하는 별도 송금 경로도 [ADR-021](#adr-021)의 초기 제품에서는 지원하지 않는다.

**아래 세 문단은 ADR-021로 대체된 Core 잔액 기반 지분 발행 절차다.** Vault의 `AwaitingActivation` 동안 거래·일반 예치·타 지분 발행을 금지한다. 생성 시 Core 계정이 이미 존재하거나 Core USDC가 선입금된 주소는 거부하고, 이후 최초 Core spot USDC 실수령을 별도 장부에 관측한다. 후속 EVM 블록에서 `userExists`와 해당 Vault 주소의 **정확한 토큰 ID·계정 모드·8자리 Core USDC 잔액**을 조회한다. 조회 실패는 0으로 바꾸지 않는다. 실수령 100 USDC 미만이면 대기하고, 100 이상이면 정확히 100만 창설자 자본으로 인식한다. 6자리 ERC20 USDC 기준 원가·share 수량으로 단위 변환하며 초과 USDC·다른 자산은 지분·NAV에서 격리한다. 일회성 `founderFundingFinalized`를 설정해 중복 발행을 막고 이 전후로 `totalAssets`가 창설자 자본을 정확히 한 번 포함하게 한다. 이 경로는 EVM ERC20 `transferFrom`이 없으므로 일반 ERC-4626 `deposit/mint`로 표시하지 않고 별도 bootstrap 이벤트·함수로 기록한다. [ERC-4626 자산 입금 규칙](https://eips.ethereum.org/EIPS/eip-4626#deposit)

Core 잔액 조회는 **누가 보냈는지 증명하지 못한다.** 따라서 첫 100 USDC를 누가 후원했든 최종 확인된 실수령액을 등록된 창설자에게 귀속하는 정책이다. 이것은 창설자가 자기 자금을 냈다는 암호학적 증명이 아니며, 제3자가 100을 먼저 보내도 그 100만 창설자 지분이 된다. 예치자에게는 이 후원 가능성을 표시한다. 제3자가 보낸 100도 실제 Vault 자산이므로 지분 발행으로 주주 자산이 부족해지지는 않는다. 100 초과분과 지분 확정 후 비요청 입금은 자동으로 창설자 몫이 되지 않는다. Core 자산의 출처·잔액·상태가 불명확하면 일반 예치를 열지 않는다. 창설자 지분의 출금 제한은 [OPEN-09](plans/README.md#정책-결정-등록부)에서 정한다.

Core 송금·활성화는 Factory 생성 EVM 거래와 비동기이므로 생성 실패 시 Core 송금을 되돌린다고 약속하지 않는다. 자금 도착 전 빈 Vault는 취소할 수 있어야 하며, 도착 후 확정 실패 시에는 Core 상태 재조회·재시도와 검증된 Core→EVM 회수 절차가 필요하다. 계약이 창설자 Core 원금을 안전하게 되돌릴 수 있음을 통제 거래로 보이기 전에는 실자금 생성 경로를 열지 않는다. [공개 Factory 설계](vault-architecture.ko.md#9-공개-factory와-core-활성화), [FACTORY-001](BACKLOG.ko.md#factory-001), [USDC-001](BACKLOG.ko.md#usdc-001)

<a id="adr-020"></a>
## ADR-020 — Vault 생성 거래에서 창설자 USDC를 Core에 함께 배정

**상태: PARTIALLY SUPERSEDED by [ADR-021](#adr-021) (생성 거래 내 창설자 EVM 납입·Core 배정은 유지; Core 확인 후 지분 발행은 대체).** 창설자가 생성 후 다시 Core USDC를 보내야 하는 부담을 없애기 위해 첫 생성 API를 `createVaultAndFund`로 정한다. 창설자가 HyperEVM USDC를 Factory에 승인하면, Factory가 동일 EVM 거래에서 (1) Vault를 배포하고 창설자를 고정하며 (2) 창설자의 USDC를 Vault로 정확히 이체하고 (3) Vault가 `CoreDepositWallet.deposit(grossAmount, spotDex)`을 호출해 **자기 Core 주소**에 배정한다. Circle의 `deposit`은 호출자와 Core 수령자가 같으므로 Vault가 호출한다. `depositFor`를 쓸 경우 Factory가 호출자·송금인이 되고 새 Vault를 수령자로 지정할 수 있지만 첫 구현은 자산 이동 주체를 Vault로 통일한다. [Circle 공식 `deposit`/`depositFor` 인터페이스](https://developers.circle.com/cctp/references/coredepositwallet-contract-interface)

**아래의 Core 확인 후 지분 발행 절차는 ADR-021에서 EVM 수령 시 지분 발행·Core 확인 시 운용 개방으로 대체됐다.** 창설자 지분의 **목표 순수령 Core USDC는 100**이다. 신규 Core 계정 첫 수신에는 1 quote-token 비용이 있으므로 101 USDC를 EVM에서 보낼 수 있다는 모델은 테스트 입력이지만, `CoreDepositWallet.deposit` 경로가 실제 101→Core100으로 처리된다는 통제 거래 증거는 아직 없다. Factory는 승인 상한·EVM 실제 차감액·정확한 allowance를 검증하고 생성 거래가 EVM에서 실패하면 배포·USDC 이체를 함께 되돌린다. EVM 거래 성공은 Core 도착이나 활성화의 확정이 아니다. 새 Vault는 `AwaitingActivation`에 머물며 후속 블록의 `userExists`·정확한 Core spot USDC 실수령을 확인한다. **정확히 100**이 확인되면 이를 창설자 자본·원가로 1회 인식하고 share를 발행한다. 100 초과는 최초 100의 귀속과 초과분 격리가 검증되기 전 자동 확정하지 않는다. 100 미만, 조회 실패, 비용 초과, 예상 외 초과 수령이면 일반 사용자 입금·거래를 열지 않고 회계·복구 절차를 따른다. 추가 EVM 납입을 자동으로 강요하지 않도록 이 순수령 결과를 출시 전 통제 실험으로 고정해야 한다.

지분 확정은 후속 EVM 거래의 Vault `finalizeFounderFunding()`에서 실행한다. 이 함수는 누구나 호출할 수 있지만, 호출자가 금액·수령자·Core 잔액을 제출하지 않는다. Vault가 생성 시 고정한 창설자·Core USDC token ID·목표 순수령액과 생성 EVM/Core 블록을 보관하고, 다음 EVM 블록 이후 `CoreRead.l1Block()`·`CoreRead.userExists(address(this))`·`CoreRead.spotBalance(address(this), usdcToken)`을 직접 읽는다. 유효한 후속 Core 상태에서 spot `total`이 목표 100 USDC(8자리 단위)에 도달하고 미확인 초과분이 없을 때만 `founderFundingFinalized`를 설정하고, 6자리 자산 장부에 100 USDC를 한 번 넣고, 초기 환율 1 USDC당 1 share(9자리 share 기준 `100e9` 단위)를 `_mint(founder, ...)`로 발행해 `Ready`로 전환한다. 모든 상태 변경과 `_mint`는 같은 EVM 거래에서 원자적으로 이뤄진다. 누가 호출해도 지분은 저장된 창설자에게만 간다. 조회 실패·잔액 부족·중복 호출은 발행 없이 revert하거나 대기한다. 생성 직후 같은 EVM 블록의 Core read로는 이번 EVM→Core 이동을 확인할 수 없다. [Hyperliquid 처리 순서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings), [read precompile](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)

이 검사는 Vault의 Core 자산 보유와 활성화를 확인하지만 특정 Circle `deposit` 호출의 개별 credit을 증명하지는 않는다. 제3자가 그 사이 Vault Core 주소에 보낸 USDC도 잔액에 섞일 수 있으며, 최초 100의 창설자 귀속은 [ADR-019](#adr-019)의 정책을 따른다. 처음부터 Core 계정이 존재하거나 자금이 선입금된 주소는 생성 경로에서 거부하고, 예상 밖 초과 수령은 자동 발행·공개 입금 대신 격리/복구한다. 일반 입금의 `previewDeposit`을 이 bootstrap 발행량 산식으로 사용하지 않는다. 첫 지분 발행 직전 Core 자산이 `totalAssets`에 보이더라도 공급량이 0일 수 있기 때문이다.

초기 Core100을 지분으로 인식하는 정책과 ERC-4626 일반 `deposit/mint`가 아닌 별도 bootstrap 발행·이중 계상 방지는 [ADR-019](#adr-019)를 따른다. 같은 `createVaultAndFund` EVM 거래에서 payer가 창설자임은 `transferFrom`으로 확인되므로 제3자 Core 후원 귀속 가정은 이 기본 경로에 필요 없다. 생성자가 **이미 Core에만 USDC를 보유**한다면 Factory가 그 Core 자금을 EVM 거래에서 인출할 수 없으므로, 별도 Core 서명 송금의 비동기 경로 또는 먼저 자기 HyperEVM 주소로 옮기는 경로가 필요하다. 두 경로를 하나의 원자적 거래로 표시하지 않는다. Core 배정 후 실패는 EVM 생성 거래를 소급해서 되돌릴 수 없으므로, 재조회·Core→EVM 회수와 창설자 청구권 복구를 검증하기 전 실자금 생성은 열지 않는다. [공개 Factory 설계](vault-architecture.ko.md#9-공개-factory와-core-활성화), [FACTORY-001](BACKLOG.ko.md#factory-001), [USDC-001](BACKLOG.ko.md#usdc-001)

<a id="adr-021"></a>
## ADR-021 — EVM 입금으로 지분을 발행하고 Core는 내부 운용 계정으로 사용

**상태: ACCEPTED (새 USDC 상품 목표; 구현·통제 거래 미완료).** 지분 발행의 단일 입구는 Vault 함수가 실제로 받은 **HyperEVM Circle native USDC**다. Vault 주소로 ERC20을 단순 전송하거나 Circle `depositFor(vault, ...)`로 Vault Core 주소에 직접 credit한 자금은 자동 지분을 만들지 않는다. Circle의 Core→HyperEVM 출금은 같은 사용자 주소로만 도착하므로, Core 보유자는 자기 주소의 EVM USDC로 옮긴 뒤 `deposit` 또는 창설자 `createVaultAndFund`를 호출한다. UI는 Core 출금·EVM 도착 확인·Vault 입금을 연결하지만 서로 다른 단계임을 보여 준다. Core 계정에서 Vault Core 주소로 바로 보내는 입금은 첫 제품에서 지원하지 않는다. Core 잔액 조회는 어느 사용자에게 얼마의 지분을 발행해야 하는지 증명하지 못하며, 사용자별 Core 수신 계약은 새 계정 활성화 비용과 별도 회수 상태를 추가한다. [Circle 동일 주소 출금](https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-hyperevm), [Hyperliquid Core 활성화 비용](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee)

Factory `createVaultAndFund`는 창설자의 EVM USDC **자기자본 100**을 새 Vault로 정확히 `transferFrom`하고, 공급량 0인 Vault에서 초기 환율 1 USDC당 1 share(9자리 share 기준 `100e9`)로 **같은 EVM 거래에서 창설자에게 지분을 발행**한다. 별도 활성화 예산은 원금·share·성과 수수료 원가에 섞지 않는다. 기본 경로에서 같은 생성 거래에 Vault 자신의 Circle `deposit`을 호출할 수 있지만, EVM debit 뒤 Core credit이 확인되기 전에는 금액을 `pendingCoreAllocation`으로 분리하고 일반 사용자 입금·Core 거래를 닫는다. Core 확인은 `finalizeActivation`에서 `userExists`와 정확한 토큰/계정 모드의 잔액을 읽어 **운용 개시만 허용**하며 `_mint`를 다시 호출하지 않는다. 실패·99 실수령·초과·외부 송금은 자산 가치/손실·환불/회수로 처리하고 자동으로 지분을 추가 발행하지 않는다. 정확한 활성화 gross와 비용 부담은 [USDC-001](BACKLOG.ko.md#usdc-001)의 통제 실험 전 고정하지 않는다. 인플라이트 장부를 EVM 현금과 확인된 Core 잔액에 중복 합산하지 않고, 실패 시 주주 자산 가치가 보장된 것처럼 표시하지 않는다.

일반 사용자는 Vault의 `deposit/mint`가 실제 수령한 EVM USDC와 **검증된 발행 가격**에 따라 같은 EVM 거래에서 share를 받는다. 첫 배포는 전량 회수·실현 NAV가 확인된 Idle 입금 창만 열고, Core 포지션이 Active이거나 인플라이트·read 누락이 있으면 입금을 닫는다. 상시 입금은 완전한 다중 시장 NAV 또는 별도 ERC-7540 비동기 입금 설계가 검증된 뒤 확장한다. Vault가 예치금 일부를 Core로 이동하는 것은 지분 발행 후의 내부 운용이다. 후속 Core credit 확인은 주문 가능 조건이며 같은 입금에 대한 추가 share를 만들지 않는다. 이 결정은 [ADR-012](#adr-012)의 동기 입금·비동기 출금과 [ADR-013](#adr-013)의 비요청 송금 격리를 유지한다. [아키텍처](vault-architecture.ko.md#9-공개-factory와-core-활성화), [FACTORY-001](BACKLOG.ko.md#factory-001), [USDC-002](BACKLOG.ko.md#usdc-002)

첫 Core 수신은 Circle `deposit`으로 시도하며 **CoreWriter 액션으로 활성화하지 않는다**. 새 Core 계정의 첫 수신에는 공식 문서상 1 quote-token 비용이 붙는다. 생성 거래와 후속 `finalizeActivation`의 HyperEVM HYPE 가스는 각 거래의 외부 제출자(창설자 또는 keeper)가 낸다. 이후 Vault가 CoreWriter를 내부 호출해 거래할 때에도 외부 거래 제출자가 EVM HYPE 가스를 낸다. 단순히 내부 CoreWriter 호출을 하기 위해 Vault EVM 주소에 HYPE를 선입금할 필요는 없다. Core 자산을 EVM으로 회수할 때의 Core spot HYPE 요구량은 별도 비용 경계로 검증한다. Core 계정은 **EVM 블록 구성 전** 이미 존재해야 CoreWriter 액션을 보낼 수 있으므로 생성 거래와 같은 EVM 블록에서 CoreWriter를 호출하지 않는다. [Hyperliquid 활성화 비용](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee), [처리 순서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings), [HyperEVM HYPE 가스](https://hyperliquid.gitbook.io/hyperliquid-docs/support/faq/hyperevm-issues/gas-problem-on-evm)

설계상 `finalizeActivation`은 Vault의 **로컬 상태 확인 함수 가칭**이다. Core read precompile로 `userExists`와 USDC 수령을 확인해 운용 상태만 바꾸며 CoreWriter 액션을 제출하지 않는다. 공식 CoreWriter **action 8 `Finalize EVM Contract`**는 spot 토큰 배포자가 Core spot 토큰과 EVM ERC-20 컨트랙트의 연결을 확정하는 절차이므로, Vault 주소의 Core 계정 활성화나 Circle USDC 입금에 사용하지 않는다. [공식 토큰 연결 절차](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers), [CoreWriter 액션 표](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)

Circle `CoreDepositWallet`의 공개 구현은 EVM 호출 중 USDC `transferFrom`과 입력 검사를 수행하므로 이 단계의 실패는 EVM 거래 전체를 되돌린다. 그러나 Core credit은 EVM 블록 생성 뒤 처리된다. 따라서 이 설계의 창설자·일반 사용자 입금은 **EVM에서 동기 지분 발행**, **Core 배정은 후속 처리·확인**으로 구분한다. Vault 함수가 사용자 USDC를 실제 수령하고 이어서 Circle 호출까지 성공하면 같은 EVM 거래에서 share를 발행할 수 있다. Circle 호출의 EVM 성공은 Core 입금 확정이나 원금 100의 순수령 증거가 아니므로 `finalizeActivation`은 운용 개방 전 Core 계정·잔액을 별도로 확인하고 share를 재발행하지 않는다. Vault가 직접 Core spot으로 보내는 `destinationDex = type(uint32).max`가 기본 후보이며, Circle 구현의 perp DEX 경로는 Circle 계정으로 먼저 입금한 뒤 CoreWriter `sendAsset`으로 전달하는 추가 단계가 있으므로 동일한 완료 보장을 가정하지 않는다. Circle 공개 소스와 실제 배포 코드·수수료 설정의 일치는 통제 실험 전에 확인한다. [Circle 인터페이스](https://developers.circle.com/cctp/references/coredepositwallet-contract-interface), [Circle 공개 구현](https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CoreDepositWallet.sol), [Hyperliquid 처리 순서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings)

<a id="adr-022"></a>
## ADR-022 — 공개 Vault 운용자의 API wallet과 계정 설정 권한

**후속 결정:** [ADR-023](#adr-023)이 owner 고정·명시적 관리 함수·운용자 신뢰·owner 주도 회수를 확정한다. 아래의 자동 위험 통제/permissionless 회수 검토를 첫 USDC 상품의 강제 주문 제한이나 운용자 협조 없는 회수 보장으로 확대하지 않는다.

**상태: ACCEPTED (목표 권한 구조; 계약 계정의 메인넷 실거래·구현 미완료).** 창설자는 자기 장치에서 API wallet 키를 생성·보관하고, 활성화 확인 후 **Vault 계약 자신의 CoreWriter action 9**로 그 공개 주소를 Vault Core 계정에 등록한다. 창설자 EOA에 등록된 agent는 Vault의 agent가 아니다. 등록 주소·교체·해지는 Vault의 운용자 권한 및 비상 정책으로 통제한다. API wallet은 Vault 자산을 보관하는 주소가 아니라 Core API 액션의 서명자다. 계약 계정에서 등록한 키의 API 주문이 실제 Vault Core 계정에 귀속되는지는 통제 메인넷 거래로 검증한다. Hyperliquid 자체 vault/subaccount용 API `vaultAddress` 필드를 이 EVM Vault의 라우팅 수단으로 가정하지 않는다. [CoreWriter action 9](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), [API wallet](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)

Agent 서명 API 주문·취소는 낮은 지연의 거래 실행 후보지만, Core에 직접 제출되므로 Vault EVM 함수의 시장 allowlist·가격·노출 검사만으로 이를 막을 수 없다. 공식 `agentSendAsset`은 수령자를 **원천 주소와 같게** 제한하면서 계정/DEX 사이 자산을 옮길 수 있다. 다른 주소로의 직접 송금 방지와 별도로 잘못된 주문·담보 이동에 의한 손실 위험을 운용자 신뢰 경계로 명시한다. 서명 키 만료·새 키로 교체·주문 취소·비상 회수·한도 초과 감시를 설계한다. 자금 회수와 출금 지급은 Vault 소유 CoreWriter·ERC-7540 상태 머신에서만 실행한다. [Agent Send Asset](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)

계정 추상화의 공식 API에는 agent 서명 `agentSetAbstraction`이 있으나 공식 SDK 예시는 초기 default 모드 조건을 명시한다. 따라서 임의 모드 전환은 Vault가 권한을 확인한 **CoreWriter action 16**으로 제출한다. `Borrow lend operation`은 공식 CoreWriter **action 15**의 `Supply`/`Withdraw`이며 그 이름만으로 직접 차입 기능을 뜻하지 않는다. 공식 Exchange API 명세에는 동등한 agent 서명 `borrowLend` 액션이 확인되지 않아, 첫 구현은 Vault CoreWriter action 15로 공급·회수를 수행한다. 두 action 모두 EVM 제출과 Core 실행/잔액 변화를 분리해 확인한다. PM 전환·자동 공급과의 상호작용은 CORE-001의 조건을 따른다. [CoreWriter action 15/16](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), [Exchange API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint), [공식 SDK 예시](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/examples/user_abstraction.py)

<a id="adr-023"></a>
## ADR-023 — 창설자 고정 owner와 운용자 신뢰형 Vault 제어

**API wallet 귀속 명확화 (2026-10-04):** 등록하는 API wallet은 해당 Vault Core 계정의 전용 agent다. Vault가 CoreWriter action 9를 호출해 등록하고 그 키의 주문·포지션·손익은 Vault 계정에 귀속된다. owner는 등록·교체를 승인하고 키를 보관·사용하는 역할이며, owner 개인 Core 계정에 agent를 등록하는 설계가 아니다.

**상태: ACCEPTED (사용자 확정 아키텍처, 구현 전).** 예치자는 창설자의 매매·레버리지·담보 운용 판단을 신뢰해 입금한다. 누구나 Factory로 Vault를 만들 수 있으며 Factory가 호출자를 새 Vault의 변경 불가 owner로 설정한다. Factory와 플랫폼은 기존 Vault의 owner가 아니다. owner 주소 하나만 검사하므로 별도 EVM whitelist mapping을 만들지 않는다. API wallet은 Core 서명자이며 EVM `onlyOwner` 권한을 얻지 않는다. [상세 아키텍처](managed-usdc-vault-architecture.ko.md)

Vault는 owner가 호출하는 외부 관리 함수 `setApiWallet/revokeApiWallet`, `depositToCore/recallUsdcFromCore`, `transferWithinCore`, `supplyToLending/withdrawFromLending/withdrawAllFromLending`, `setAbstraction`, `approveBuilderFee`를 제공한다. Solidity의 external 진입점에 `onlyOwner`를 적용하고 내부에서 Vault 자신의 CoreWriter/Circle 호출을 수행한다. Borrow/Lend는 이 문맥의 BLP이며 action 15의 공급·회수다. abstraction은 action 16의 user를 Vault로 고정한다. Core→EVM은 같은 Vault로 USDC를 회수하고 별도 수령자를 지정하지 못한다. 실제 API 키는 오프체인에서 생성하며 계약에는 공개 주소만 등록한다.

직접 API 주문의 위험을 owner에게 위임하는 것은 채택된 상품 신뢰 모델이다. 모든 주문의 자산·가격·노출 상한을 EVM 함수에서 강제하는 시스템으로 설계하거나 표시하지 않는다. typed 관리 함수는 계정/수령지·자산 단위·준비금·상태 전이의 정확성을 지킨다. 비요청 송금 격리, 검증 가격에 따른 동기 share 발행, ERC-7540 출금 및 성과 수수료 10%의 80/20 배분은 유지한다. 상세 명세 밖의 임의 외부 call/raw CoreWriter payload는 제공하지 않는다.

출금은 예치자 요청 → owner의 포지션 정리·Core 회수 → 검증된 정산 → 사용자 claim 구조다. 예치자의 요청과 확정된 claim은 owner의 추가 승인 없이 가능하며, 미확정 포트폴리오를 owner 협조 없이 강제 청산하는 기능은 첫 USDC 구조의 완료 조건에서 제외한다. 이는 기존 WHYPE 자동 전략의 permissionless 회수를 변경하지 않는다. API 등록 해지·미체결/인플라이트 주문·NAV 정산의 기술적 연결은 여전히 구현 대상이고, 로컬 상태 변경만으로 Core의 키가 해지됐다고 판정하지 않는다. [구현 과제](BACKLOG.ko.md#market-002)

<a id="adr-024"></a>
## ADR-024 — Zcash 비공개 인텐트의 별도 연구 경계

**상태: PROPOSED (제품·수탁·출시 결정 아님).** 사용자 요청에 따라 shielded ZEC 입출금, 암호화된 거래 인텐트, 솔버의 USDC 유동성, 공동 HyperCore 계정, 사용자별 비공개 정산 원장을 별도 제품으로 연구한다. HyperCore의 공동 계정 주문은 공개이며 개인별 귀속만 제한적으로 숨길 수 있다. 솔버·운영자로부터의 프라이버시, 임계 서명 수탁, ZK 지급 능력 증명과 사용자 단독 탈출권은 아직 확정하지 않았다. [연구 명세](zcash-private-intents.ko.md)

현행 [USDC Vault 결정](#adr-023)은 운용자를 신뢰하는 ERC4626 지분 상품이고 Zcash 개인별 선물 청구권을 제공하지 않는다. 이 연구의 로컬 회계 모형이나 mock 영수증은 Vault 구현·HyperCore NAV·Zcash 입금 증명으로 승격하지 않는다. 실자금 경로를 채택하려면 [ZPI-002~005](BACKLOG.ko.md#zpi-002)의 신뢰·복구·프라이버시 조건을 먼저 검증하고 별도 결정을 기록한다.

## 결정하지 않은 항목

후속 설계 초안은 [기획 패키지](plans/README.md)에 있다. 과거 WHYPE protocol fee 0 제안, 미헤지 WHYPE buffer 상한, partial-exit의 단일 epoch 전체 fulfillment, dust 후원 매입 등은 현행 USDC의 [ADR-016](#adr-016)을 대체하지 않는다. 제품 정책의 남은 열린 선택은 기획 패키지의 OPEN 등록부에서 관리한다.

PM 자동 공급 전후 상태 전이, 실패 receipt 신뢰 모델, recall 순수령액, quote dust·가스 비용 귀속은 완료된 설계로 취급하지 않는다. 해당 조건은 [BACKLOG](BACKLOG.ko.md)의 CORE 항목에서 검증 후 결정한다. 현재 배포 스크립트의 31337 제한은 통합 준비 상태와 함께 [STATUS](STATUS.ko.md)에서 관리한다.


<a id="adr-025"></a>
## ADR-025 — Managed Vault 구현과 Core 검증 경계

**상태: IMPLEMENTED IN LOCAL MODEL; 생산 검증기·실자금 왕복 미완료.** 2026-10-04 요청으로 `ManagedUsdcVault/Factory`에 Vault 자신의 action 9/12/13/15/16, 동기 창설자 share, Idle 입금, 사용자별 원가·고유 요청·성과 수수료·출금 준비금을 구현했다. 기본 100 USDC 창설자 원금과 추가 활성화 예산은 분리한다. 직접 ERC20 송금은 장부 현금이 아니다. API wallet은 Vault 전용 unnamed 슬롯에 등록하며, 철회는 Vault별 hash-derived 비서명 주소로 슬롯을 교체하는 wire 경로다. 이 해지 효과는 메인넷에서 검증해야 하며 로컬 변수 삭제를 성공으로 취급하지 않는다.

`IManagedVaultVerifier`는 action 효과/금액 귀속과 전체 Core 종료 상태를 검증하는 명시적 경계다. owner가 운용을 결정한다는 합의가 잔액·가격의 임의 보고까지 허용하는 것으로 해석하지 않는다. 현재 mock만 있고 생산 구현은 없다. 주주 가격은 실현 현금이 확보된 Idle에서만 계산하며 Active NAV·상시 입금은 미구현이다. 검증된 결과 없이 자동 복구·정산을 진행하지 않는다. [현행 명세](managed-usdc-vault-implementation.ko.md)

<a id="adr-026"></a>
## ADR-026 — 커스텀 성과수수료·최소 입금과 기존 Vault 업그레이드

**상태: 사용자 요청 반영 구현. 세부 기본안: Vault owner 업그레이드·48시간 지연, 플랫폼 20% 유지.** 2026-10-04 사용자는 수익 share 커스텀, 약 10 USDC 최소 입금 조정, 업그레이드와 지속 가능한 테스트를 요구했다. ADR-016의 10% 고정은 **기본 10%, 생성자가 0~100% 선택**으로 대체한다. 플랫폼은 총 성과수수료의 20%라는 ADR-017을 유지한다. 새 설정은 Factory overload로 정하고 최소 입금은 기본 10 USDC, 이후 Idle에서 owner가 바꾼다. 수수료율 변경은 잔존 share·준비금이 모두 없는 경우에만 허용해 기존 투자자 누적 이익에 인상 요율이 소급되지 않게 한다. 요청은 자신의 적용 feeBps를 고정한다.

기존 Vault를 업그레이드하려면 Core 소유 주소가 유지돼야 한다. OZ TransparentUpgradeableProxy와 Vault별 ProxyAdmin/controller를 사용한다. 고정 owner가 새 implementation codehash·migration hash를 제안하고 48시간 뒤 검증된 Idle에서만 실행한다. 대기 중 신규 입금·새 운용을 닫고 출금 요청/확정 claim·Exiting 회수는 유지한다. Factory는 기존 Vault에 전역 upgrade 권한을 갖지 않는다. 이 버전은 immutable Config가 있는 **Vault별 implementation**이며, proxy bootstrap을 같은 Factory 생성 거래에서 초기화한다. 새 implementation은 원래 Config를 보존해야 한다.

업그레이드 권한은 코드 변경 권한이므로 owner 신뢰 범위가 넓어진다. 지연·configHash만으로 악성 새 코드를 배제할 수 없고 owner 협조 없는 모든 시장 강제 출금도 제공하지 않는다. 이 한계를 명시한다. 지속 검증은 local/fuzz·업그레이드 전후 장부·다음 입금·재귀 storage layout 검사와 [메인넷 시나리오](managed-mainnet-scenarios.ko.md)를 포함하며 실제 메인넷 거래는 별도로 기록한다.

<a id="adr-027"></a>
## ADR-027 — Vault 이름·FE·precompile 기반 운용 중 동기 입금

**상태: 사용자 방향 확정; 이름/FE/동기 입금 gate 로컬 구현, production NAV 미완료.** 사용자는 생성 시 이름과 기본 FE, 운용 중 입금을 요청했다. 비동기 입금 대신 **입금 직전 NAV에 따른 즉시 지분 발행**을 선택했고 외부 검증자 정족수 서명을 거절했다. 제공한 `L1Read.sol`의 precompile을 원천으로 사용한다. 외부 attestation, owner NAV 보고, 임의 complete=true 인증을 추가하지 않는다.

Vault는 Ready/Active에서 immutable verifier의 NAV 확장을 사용한다. 기존 action-only verifier 또는 source 실패이면 입금은 닫힌다. EVM 장부 현금과 검증된 Core 순자산을 합산하고 실제 입금 전 가격으로 mint한다. 직접 EVM 송금과 확정 claim 준비금은 제외한다. 출금은 기존 비동기 요청/회수/claim이다.

`HyperCorePrecompileSource`는 잔액·가격·metadata·lending·DEX equity·position2·outcomeStatus를 직접 읽지만, 등록 목록 밖 시장/부채·계정 모드·외부 자금 귀속·원천 가격 age의 완전 증명은 없다. 따라서 complete=false를 유지한다. 이 한계를 숨겨 즉시 입금 완료로 표시하지 않으며, mock의 완전 source와 production source를 구분한다. [세부 명세](managed-precompile-nav.ko.md)

**후속 설계:** Managed의 목록 완전성 신뢰와 원천 timestamp 필수 조건은 [ADR-028](#adr-028)로 구체화·변경했고, [ADR-029](#adr-029)에서 source를 등록 범위 평가기로 다시 구현했다. 위 complete=false 설명은 당시 코드 상태다.

이름은 proxy의 append-only 문자열 storage, 기본 이름 fallback, owner 변경으로 구현하며 금융 조건/configHash를 바꾸지 않는다. FE는 데모와 계약 모드를 구분하고 NAV 실패/조회 만료/지갑 변경을 처리한다. [FE 범위](../frontend/README.ko.md)


<a id="adr-028"></a>
## ADR-028 — Unified·PM의 운용자 등록 목록과 precompile NAV

**상태: ACCEPTED (구조·신뢰 범위 채택; 회계식 검증·구현 미완료).** 사용자는 Unified 또는 Portfolio Margin을 사용할 예정이며, 모드별 precompile 평가와 운용자 등록 목록 구조의 문서화를 요청했다. [상세 설계](managed-unified-pm-nav.ko.md)를 따른다.

운용자가 token·DEX·outcome·가격 경로를 사전 등록하고, 계약이 실제 수량·공급·부채·가격을 precompile에서 읽는다. 목록의 완전성은 운용자 신뢰이며 API wallet 직접 거래를 EVM whitelist로 강제 제한하지 않는다. 목록 밖 노출이 없다는 독립 온체인 증명이나 운용자 입력 NAV로 표시하지 않는다. 외부 NAV 서명자는 사용하지 않는다. 이는 ADR-027의 전체 scope 요구를 이 Managed 상품에서 운용자 등록 범위로 구체화한 결정이다.

Unified/PM 평가기를 분리하고 raw Spot·Lending·Perp 회계 항목을 중복 없이 토큰별 순자산으로 정규화한다. `accountValue` 또는 `accountValue - rawUsd`를 모든 모드의 확정 공식으로 채택하지 않는다. 등록/모드 변경, HIP-4 정산, Core 비요청 송금 귀속과 관리 액션 증거는 상세 설계의 검증 과제로 남는다. 기존 ADR-013의 자금 귀속 정책을 변경하지 않는다.

평가 시점은 같은 EVM 실행에서 읽은 현재 Core 상태로 정한다. 제공되지 않는 원천 가격 timestamp를 필수로 요구하는 기존 설계를 변경하되, 현재 코드의 `observedAt/maxAge` 의미·검증을 후속 구현에서 함께 수정한다. EVM 관측 시각을 원천 가격 갱신 시각으로 표시하거나 임의 complete=true로 입금을 여는 변경은 허용하지 않는다. 가격 조작·환산 정책과 Core 블록 일치 검증은 별개다.

입금 직전 NAV에 EVM의 사용 가능한 장부 USDC를 합산하고, 실제 USDC 수령과 같은 EVM 거래에서 지분을 발행한다. 채택 당시 source는 complete=false였고 이 결정은 문서 변경이었다.

**후속 구현:** [ADR-029](#adr-029)가 이 구조를 구현했다. 공개 계정 관측에 따라 모드별 평가기를 하나로 합쳤고 Core 비요청 자금·액션 최종성·종료 조건의 정책을 추가했다. 실자금 입금은 계속 닫혀 있다.

<a id="adr-029"></a>
## ADR-029 — 모드 무관 raw 장부 평가와 온체인 관측 검증기

**상태: 로컬 구현 반영; 아래 정책 7개와 미구현 결정 5개는 사용자 확정 대기. 통제 왕복·독립 감사 미완료.** 2026-10-04 사용자는 실시간 NAV와 지분 발행의 구현 방법을 요청했다. [ADR-028](#adr-028)의 구조(운용자 등록 목록, precompile 평가, 입금 직전 동기 발행, 외부 서명자 없음)는 그대로 구현했고, 그 문서가 검증 과제로 남긴 항목을 [공개 계정 관측](managed-precompile-evidence.ko.md#raw-ledger-identity)과 아래 결정으로 채웠다. 현행 동작은 [구현 명세](managed-precompile-nav.ko.md)가 관리한다.

**관측으로 정한 것 — 평가기는 하나다.** precompile은 Standard·Unified·PM 어디서나 spot·lending·DEX별 margin 계정을 겹치지 않는 raw 장부로 반환했고 API 통합 잔액은 그 합이었다. 그래서 ADR-028의 "Unified/PM 평가기 분리" 대신 `spot + lending 순액 + USDC DEX equity + HyperCore vault equity` 한 식을 쓰고 계정 모드를 조회하지 않는다. 모드 전환 인증이 평가의 전제에서 빠진다. 원천 가격 timestamp 요구를 없애는 ADR-028의 결정에 맞춰 `complete`·`observedAt`·`maxAge` 검사를 제거하고 같은 EVM 호출의 Core 블록을 반환한다.

**사용자가 선택한 것 (2026-10-04~05):**

- **미등록 보유로 인한 지분 희석은 현행 구조를 유지하면서 막는다.** 사용자는 "등록하지 않은 자산을 운용하면 지분이 잘못 발행되는 문제는 방지돼야 한다"고 지적했고, [구조 비교안](managed-scope-enforcement-options.ko.md)을 검토한 뒤 "A 먼저, B는 나중에"를 골랐다. A는 현행 구조(API 직접 매매, Vault 불변)에 신고 차단과 급락 대기를 추가하는 안이고, B(주문을 Vault 함수로만 제출)는 필요해질 때 별도 Vault 유형으로 검토한다. 아래 정책 6·7이 그 구현이다. 등록 범위의 완전성을 운용자 신뢰에만 맡기던 ADR-028의 가정을 이 범위에서 보강한다.

**사용자 확정이 필요한 정책 (구현됨):**

1. **Core 비요청 자금은 주주 순자산에 포함한다.** Core 계정으로 들어온 송금은 온체인에서 출처를 구분할 수 없다. 계정 순자산을 그대로 평가하면 기존 주주의 가치가 오르고 송금자에게는 지분이 생기지 않는다. EVM 직접 송금을 장부 밖에 격리하는 [ADR-013](#adr-013)은 유지한다. 이는 ADR-028이 미해결로 둔 Core 귀속 항목의 결정이다.
2. **관리 액션의 최종성은 처리 순서와 실제 도착 잔액으로 판정한다.** 외부 서명자를 쓰지 않으므로 Core 영수증을 증명할 수단이 없다. 제출보다 뒤의 Core 블록이면 EVM→Core 입금과 control 액션을 반영된 것으로 보고, 회수는 Vault가 실제 보유한 장부 밖 USDC만큼만 편입한다. **도착하지 않은 회수는 시간만으로 닫지 않는다.** owner가 그 액션의 포기를 선언하고, 그 선언에서 대기 기간(10,000~2,000,000 Core 블록, 배포 시 고정)이 지나야 닫히며 그때 도착해 있던 금액을 편입한다. 선언은 회수를 제출한 Core 블록에서는 할 수 없고 다시 선언해 시계를 옮길 수 없다. 누구나 기한 경과만으로 닫을 수 있거나 owner가 미리 선언해 둘 수 있으면, 전송 중인 USDC가 빠진 NAV로 입금이 열리거나 종료가 확정되기 때문이다. [VERIFIER-001](BACKLOG.ko.md#verifier-001)의 "귀속 증명" 요구를 "보유하지 않은 현금은 편입할 수 없다"로 바꾼다. Core 쪽 거절(agent·control)은 관측할 수 없다는 한계를 받아들인다.
3. **Core 쪽 결손은 상계하지 않고 발행을 닫는다.** Core 순자산이 음수이면 EVM 현금과 상계하지 않고, 등록 DEX의 계정 가치가 음수이면 spot이나 다른 DEX 잔액과 상계하지 않는다. 결손은 다른 장부에 소구할 수 없으므로 상계하면 NAV가 낮아져 신규 지분이 과다 발행된다. 이전 구현의 상계를 대체한다. 종료 평가에서는 음수를 그대로 합산하고 부채로 본다.
4. **종료는 부채가 없고, 아직 가져올 수 있는 가치가 dust 상한 이하일 때 확정한다.** 차입·perp 포지션·음의 DEX equity가 없어야 한다. 가져올 수 있는 가치는 USDC 장부와 token별 팔 수 있는 보유의 합이고, 상한은 배포 시 0 초과 10 USDC 미만으로 고정한다(10 USDC 이상은 신고가 성립하는 크기이므로 dust로 남길 수 없게 했다). token 보유는 온전한 lot만 세고 최우선 매수호가로 평가해 10 USDC(Core의 주문 최소 금액) 미만이면 0으로 본다. owner가 팔 수 없는 것이 종료를 막지 않게 하기 위해서이며, 종료 평가는 가격 가드를 쓰지 않는다. 남은 것은 정산 가격에서 빠져 다음 운용 기간의 주주에게 귀속된다. 같은 기준으로 팔 수 없는 잔량(1 lot 미만이거나 매수호가 기준 10 USDC 미만)은 등록 범위에서도 뺄 수 있다. 정산은 정책 7의 대기도 통과해야 한다. [ADR-028](#adr-028)의 "0일 때만 제거"와 [CORE-004](BACKLOG.ko.md#core-004)의 dust 귀속을 이 범위 안에서만 정한 것이다.
5. **등록 범위는 token 6개·DEX 8개·HyperCore vault 2개 이하다.** 공식 precompile 비용식의 로컬 모형에서 가장 비싼 입금 경로(`mint`, 평가 4회)가 소형 블록 3M 안에 들어가는 크기다. 2026-10-04 실측한 precompile 비용은 그 식의 절반쯤이었지만 상한은 더 비싼 문서 식으로 정했다.
6. **범위 밖 보유는 누구나 증명할 수 있고, 그 증명이 성립하는 동안 발행과 종료가 닫힌다.** 컨트랙트는 계정의 보유를 열거하지 못하지만 이름이 주어진 대상의 잔액은 읽을 수 있다. 등록되지 않은 token·perp DEX·HyperCore vault에 팔 수 있는 가치(주문 최소 금액 이상)나 차입·포지션이 있음을 누구나 신고할 수 있고, 평가는 매번 그 대상을 다시 읽어 **지금도 성립할 때만** 거부한다. owner가 등록하거나 정리하면 별도 해제 없이 다시 열린다. 한순간만 성립한 증명으로 Vault를 계속 닫아 둘 수 없게 하기 위해서다. 신고는 Vault당 한 건만 보관하고 **성립하는 신고는 자리를 지킨다.** 다른 증명이 밀어낼 수 있으면 제3자가 한 블록짜리 매수호가로 만든 token 신고로 진짜 신고를 걷어낼 수 있기 때문이다. 같은 대상의 재신고는 기한만 갱신하고 증명 경로는 유지한다. 신고는 1일 뒤 소멸한다. **owner가 신고된 대상을 등록해 신고가 더 성립하지 않게 되면 신고는 목록에서 빠지고 그때까지의 가격 기록은 이력으로 세지 않는다.** 자리가 하나라 owner가 자기 소액 보유를 먼저 신고해 두면 진짜 대상을 아무도 올릴 수 없는데, 그 소액 대상을 등록하는 것만으로 같은 블록에서 신고가 풀리기 때문이다. 그 대가로, 신고를 받고 정직하게 등록한 owner도 새 기록이 반 창을 채울 때까지 기다린다. **등록된 token도 등록 범위가 종료 평가에서 0으로 세는 동안에는 신고할 수 있다.** 등록된 token은 등록된 USDC pair의 매수호가로만 종료 평가에 들어간다. 등록됐다는 이유만으로 신고 대상에서 빼면, 매수호가 없는 pair로 등록한 token에 가치를 두는 것으로 신고와 종료 평가를 모두 벗어날 수 있다. 신고 대상에서 빠지는 것은 등록 범위가 그 보유를 책임질 때(차입이 있거나 등록된 pair에서 팔 수 있는 가치가 있을 때)뿐이고, 그런 신고는 owner가 그 token을 등록해도 풀리지 않는다. 등록된 token의 신고는 다른 pair에서 주문 최소 금액의 두 배 이상에 팔 수 있을 때 성립한다(등록된 pair가 최소 금액에 조금 못 미치게 치는 잔량이 pair 사이의 작은 가격 차이로 Vault를 닫지 않게). 이력의 재시작은 `configure`가 그 직전까지 성립하던 신고를 푼 경우에만 일어난다. 보관된 신고가 가리키지 않는 대상은 읽지 않으므로 감시자는 신고가 풀리거나 보유가 옮겨질 때마다 다시 신고해야 하고, 그 한 블록의 순서 경쟁은 닫히지 않는다(결정 대기 F). outcome과 sub-account는 대상이 아니다.
7. **지분 가격이 떨어진 직후에는 발행하지 않고 종료도 정산하지 않는다.** 범위 밖으로 옮긴 가치와 손실은 온체인에서 구분되지 않으므로, 누구나 기록할 수 있는 지분 가격 이력을 두고 현재 가격이 최근 창의 최고 기록보다 한도 넘게 낮으면 발행을 거부한다. 기록이 창의 절반을 채우지 못해도 거부한다. 종료 정산에도 지급될 현금 기준 가격으로 같은 두 조건을 적용한다. 범위 밖에 가치를 남긴 채 정산하면 상환자가 덜 받고, 기록이 없을 때 정산을 허용하면 기록을 끊는 것이 대기를 건너뛰는 수단이 되기 때문이다. 같은 이유로 기록은 owner의 입금 스위치, 신고, 확인을 기다리는 관리 액션과 무관하게 등록 범위의 가격으로 계속되고, Idle에서는 Vault가 발행에 쓰는 현금 기준 가격을 기록한다. 지분이 없는 Vault의 종료에는 두 조건을 적용하지 않는다(기록할 수 없고 지급 대상도 없다). 기록 간격 안에서는 더 높은 가격만 직전 기록을 대체할 수 있어, 가치를 잠깐 빼고 낮은 가격을 먼저 기록해도 누군가 다시 기록하면 그 표본을 독점하지 못한다. 창(10분~1일)과 한도(0.1%~20%)는 배포 시 고정한다. 이것은 신고할 시간을 버는 지연이며 증명이 아니다. 등록 범위 자체를 평가할 수 없게 만들면 owner는 여전히 기록을 끊을 수 있고, 그 경우 가치가 범위 밖에 있어야 하는 시간은 두 블록까지 줄어든다. 의도적인 owner를 상대로 보장하는 것은 길어야 한 창의 지연과 마지막 한 블록의 순서 경쟁이다. 실제 손실 직후에도 입금이 닫히고 정산이 한 창까지 늦어지며(팔 수 없는 잔량이 범위에 남은 작은 Vault에서는 owner가 그 token을 범위에서 뺄 때까지), keeper가 없으면 종료도 기록 뒤 반 창을 기다리고, 가격을 기록하고 표본을 되돌리는 keeper가 필요하다는 대가를 받아들인다.

**가격:** USDC는 1. 그 외 token은 owner가 등록 때 고른 경로를 따른다. `reservePrice`를 켠 token은 프로토콜 borrow oracle을 spot mark와 2% 이내로 일치할 때만, 그렇지 않은 token은 spot mark를 호가 안·spread 1% 이내에서만 쓴다. 두 가드는 가격의 수준을 보증하지 않는다.

**결정 대기 (구현하지 않음):**

- **A. 조회가 계속 실패하는 등록 항목의 복구.** 등록 token의 호가, 등록 DEX·vault의 조회가 프로토콜 변경으로 실패하게 되면 평가도 범위 변경도 할 수 없어 `settleEpoch`이 확정되지 않는다. 검증기는 immutable이고 Vault upgrade는 Idle에서만 가능해 현재 복구 경로가 없다. 시장이 죽었지만 조회는 되는 token과 팔 수 없는 잔량은 정책 4로 더 이상 종료 평가를 막지 않는다. 가격 기록은 막지만 owner가 그 token을 범위에서 빼서 풀 수 있으므로, 복구 경로가 없는 것은 조회 실패뿐이다. 선택지: (가) 두지 않는다(현행). (나) owner가 그 항목을 선언하고 긴 지연이 지난 뒤, 그 시점에도 조회가 실패하는 항목만 제외하고 종료를 허용한다. (다) Exiting에서도 가능한 upgrade 경로를 Vault에 둔다. 구현자 권고는 (나)다. 조회가 되는 항목은 제외할 수 없으므로 owner가 가치를 버리는 데 쓸 수 없고 영구 동결만 없앤다. 메인넷 배포 전에 정해야 한다.
- **B. 호가로만 평가되는 token.** 얇은 시장의 한 블록 가격 조작은 spread·일치 가드로 막을 수 없다. 정책 7이 하방 조작 직후의 발행을 막지만, 상방 조작과 매수호가가 없는 순간의 종료(정책 4)는 남는다. 선택지: (가) 현행 유지, owner의 등록·한도 관리에 맡긴다. (나) reserve가 있는 token만 등록을 허용한다. (다) 그런 token이 NAV에서 차지하는 비중에 상한을 둔다. 구현자 권고는 첫 배포에서 (나)다.
- **C. Factory 선제 활성화.** 이 변경과 무관하게 이전부터 있던 문제다. 예측 가능한 다음 Vault 주소를 누군가 Core에서 먼저 활성화하면 생성이 계속 revert한다. [FACTORY-001](BACKLOG.ko.md#factory-001)에서 다룬다.
- **E. 팔 수 없는데 성립하는 신고의 복구(미확인).** token 발행자가 특정 계정의 잔액을 동결할 수 있는 token이 있다. 동결된 잔액을 팔 수 없다면 그런 token과 자기 매수호가로 비용 없이 신고를 유지해 Vault를 닫아 둘 수 있다. 동결의 실제 동작은 확인하지 못했다. 선택지: (가) 테스트넷에서 확인한 뒤 정한다(현행). (나) A와 같은 형태로 owner가 대상을 선언하고 긴 지연 뒤 제외한다(owner가 그 대상에 가치를 숨길 수 있게 되는 대가가 있다). (다) token 신고를 owner가 미리 허용한 목록으로 제한한다. (D는 구조 비교였고 사용자의 선택으로 닫혔다.)
- **F. 신고 효력의 유지 시간.** 신고는 지금 성립할 때만 Vault를 닫는다. 그래서 owner가 신고된 대상을 Core에서 비우거나 숨긴 가치를 아직 신고되지 않은 대상으로 옮긴 뒤, 그것이 반영된 첫 블록에서 감시자의 다음 신고보다 먼저 입금·정산하면 통과한다. 등록 범위를 평가할 수 없는 상태로 두어 가격 기록을 끊을 수 있으면 그 전에 가치가 범위 밖에 있어야 하는 시간도 한두 블록으로 줄어든다. 3차 리뷰가 찾은 결정적 우회로(신고된 대상을 `configure`로 등록해 같은 블록에서 푸는 것, 제3자가 순간 증명으로 신고를 밀어내는 것, pending 액션으로 기록을 끊는 것)는 막았고, 남은 것이 이 순서 경쟁이다. 선택지: (가) 현행 유지. 한계로 문서화하고, 주문을 Vault 함수로만 내는 구조 B에서 닫는다. (나) 증명이 성공하면 일정 시간 발행과 정산을 닫는다. 순서 경쟁은 없어지지만, 제3자가 자기만 가진 token을 보내고 한 블록 동안만 매수호가를 세워 신고하는 것으로 그 시간만큼 Vault를 닫을 수 있고 비용 없이 반복할 수 있다. (다) (나)를 perp DEX·HyperCore vault 신고에만 적용한다. 이 두 신고는 10 USDC 이상의 실제 송금 없이는 만들 수 없다. owner가 숨긴 가치를 token으로 들고 있으면 닫히지 않는다. (라) 신고할 때마다 신고자가 비용을 내게 해 (나)의 방해에 값을 매긴다. 정직한 감시에도 같은 비용이 든다. 구현자 권고는 (가)다. owner의 거래 자체가 신뢰 대상인 구조에서, (나)가 여는 무비용 방해가 정직한 owner와 상환자에게 주는 피해가 더 크다고 본다. 3차 리뷰도 결정적 우회로를 막는 조건으로 (가)에 동의했다.

**유지되는 신뢰 범위:** owner의 거래는 신뢰 대상이다. owner가 자기 다른 계정과 불리한 가격에 거래해 가치를 빼는 것은 API 직접 매매를 허용하는 한 막을 수 없다([ADR-023](#adr-023)). 정책 6·7은 등록 누락과 발행 악용을 다루며, 신고는 누군가 해야 하고 급락 대기는 지연일 뿐이다. HIP-4 outcome, USDC 외 담보 DEX, staking, sub-account는 평가하지 않는다. 운용자가 범위를 끌 수 있는 입금 스위치를 둔다. 이 결정은 Vault 코드·ABI·storage를 바꾸지 않는다.

**검토 기록:** 별도 컨텍스트의 자동 코드 리뷰를 세 번 받았고, 세 번째 리뷰의 수정은 여섯 차례 재검증받았다(critical은 없었다). 1차(2026-10-04)는 포기 선언, DEX 결손, lending 공급 dust, dust 상한의 하한, oracle·mark 일치 가드, 장부 확인 gas 축소, 범위 상한을 반영했고 결정 대기 A·B·C를 제기했다. 2차(2026-10-04~05)는 종료 중 제3자가 보낸 등록 token 1 lot이 정산을 막는 문제(정책 4의 현재 형태로 해소), 포기를 미리 선언할 수 있어 시간 만료가 되살아나는 문제(정책 2의 "선언에서 센다"로 해소), spot과 미집계 공급을 따로 세던 lot 규칙, 이름이 말하는 것을 검증하지 못하던 시험들, 장부 확인이 20,000 gas 안에 끝난다는 가정이 측정되지 않았다는 점을 지적했다. 마지막 항목은 [mainnet 실측](managed-precompile-evidence.ko.md#precompile-gas)과 대조 조회로 닫았다. 정책 6·7은 2차 리뷰 이후에 추가됐다. 3차(2026-10-05)는 정책 6·7을 대상으로 했고 critical은 없었다. 반영한 것: 가격 기록 간격을 먼저 차지해 낮은 표본으로 급락 대기를 우회하는 문제(더 높은 가격의 대체 허용), 종료 정산에는 대기가 없어 범위 밖 가치를 남긴 채 상환자에게 덜 지급되는 문제(종료에도 한도 적용), 한순간만 성립한 신고가 계속 Vault를 닫는 문제(평가마다 재확인, Vault당 1건·1일), quote token을 거치는 token의 주문 최소 금액을 USDC로만 본 문제(두 단계 모두 확인), 팔 수 없는 잔량이 token을 범위에 묶는 문제(잔량 기준으로 제외 허용), 지분이 없을 때의 가격 기록, 대조 조회의 길이 확인, 통과하던 변이 10건에 대한 시험 추가. 반영하지 않고 한계로 남긴 것: 종료 방해 비용이 dust 상한이라는 점, 동결 가능한 token(결정 대기 E), lending precompile만 달라지는 경우의 장부 확인. 같은 리뷰의 수정 재검증(2026-10-05)은 그 수정이 새로 연 문제를 지적했다. 반영한 것: 신고가 한 건이고 성립하는 신고를 밀어낼 수 없어 owner의 10 USDC 미끼 신고가 다른 대상의 신고와 가격 기록을 모두 막던 문제(high. 최신 증명이 자리를 차지하게 하고, 기록이 신고·스위치와 무관하게 계속되게 함), 기록을 끊어 창을 비우면 종료가 대기 없이 정산되던 문제(종료에도 기록 길이 요건 적용), 지분이 한 단위만 남았을 때 Core dust로 가격이 튀던 문제(Idle은 현금 기준 가격을 기록). 그 재검증의 2회차는 "최신 증명이 자리를 차지"하게 한 수정이 새 우회로를 열었음을 보였다(high 3, medium 2, low 1). 반영한 것: 자기 소액 보유의 신고로 자리를 차지한 뒤 그 대상을 `configure`로 등록해 같은 블록에서 신고를 풀고 입금하는 경로(신고가 답해지면 그때까지의 기록을 이력에서 제외), 제3자가 한 블록짜리 token 증명으로 성립 중인 신고를 밀어내는 경로(성립하는 신고는 자리를 지키게 되돌리고, 같은 대상의 재신고는 증명 경로를 유지), Core가 처리할 수 없는 회수를 pending으로 두어 가격 기록을 끊는 경로(pending이어도 기록), 지분 없는 Vault가 Idle을 벗어나면 돌아오지 못하는 문제(지분이 없으면 종료에 가격 조건을 적용하지 않음), dust 상한이 신고 성립 크기를 넘을 수 있던 점(10 USDC 미만으로 제한). 반영하지 않고 근거와 함께 남긴 것: 범위 제외를 spot mark로 한 번 더 제한하는 안(호가가 죽은 token의 mark가 남아 있어 팔 수 없는 보유가 token을 범위에 묶고, 그러면 가격 기록과 종료까지 막힌다), 팔 수 없는 잔량이 작은 Vault의 정산을 미루는 문제(운용 절차로 처리), 가격이 거부된 등록 token이 가격 기록을 통해 종료를 붙잡는 문제(owner가 그 token을 범위에서 빼서 푼다), 평가할 수 없는 범위로 기록을 끊는 경로와 신고의 순서 경쟁(결정 대기 F). 재검증 3회차는 앞의 수정 네 건이 유지됨을 확인하고, 성립 중인 신고를 한 블록 안에서 이력 재시작 없이 푸는 방법을 찾지 못했다고 보고했다. 새로 지적한 것은 한 건이다(low. 그 시점의 mainnet 시장에는 전제를 만족하는 token이 없었다): 미끼 신고 뒤에서, 다른 pair로 사 둔 token을 USDC 매수호가가 없는 pair로 등록하면 답해진 신고가 없어 낮은 기록이 이력으로 남고, 그 token은 신고할 수 없으며 종료 평가에서 0으로 잡힌다. 처음에는 보유 중인 token의 등록에도 이력 재시작을 적용했으나, 재검증 4회차가 token을 빈 상태로 등록해 두고 다른 미등록 대상에 두었던 가치를 나중에 옮겨 넣으면 같은 결과가 된다는 것을 보였다(low, 같은 전제). 그래서 그 규칙을 빼고, 등록된 token도 등록 범위가 종료 평가에서 0으로 세는 동안에는 신고할 수 있게 했다(4회차의 권고). 두 보고의 문서 지적(누구나 쓸 수 있는 순서 경쟁, pending 중의 기록으로 낮은 표본에 범위 밖 가치가 필요 없다는 점)과 생존 변이의 시험을 반영했다. 재검증 5회차는 그 수정이 유지되고 "종료 평가에 잡히지도 않고 신고할 수도 없는 보유"를 찾지 못했다고 보고했으며, 그 수정의 부작용 두 건(둘 다 low)을 지적했다: 스스로 풀린 신고가 목록에 남아 있으면 나중의 무관한 `configure`가 이력을 다시 시작하던 것(그 `configure`가 실제로 푼 신고일 때만 재시작하게 함), 등록된 pair가 최소 금액 바로 아래로 치는 잔량을 다른 pair의 조금 높은 호가로 신고해 제값으로 평가되는 Vault를 닫을 수 있던 것(등록된 token은 다른 pair에서 최소 금액의 두 배를 요구). 둘 다 리뷰어가 시험한 형태로 반영했다. 재검증 6회차(마지막)는 그 두 수정이 유지되고 앞의 지적들이 다시 열리지 않았음을 확인했으며 코드 결함을 찾지 못했다. 한 블록 안에서 `stood`가 거짓으로 읽힌 채 성립 중인 신고가 풀리는 경로는 없었다(4,824개 상태의 전후 비교). 남긴 사항 두 가지는 문서화했다: 소멸하지 않은 신고의 대상을 읽을 수 없는 동안에는 범위 변경도 되지 않는다는 점, gas 모형이 가장 비싼 신고 형태(등록된 token에 대한 신고)를 쓰게 한 점. 이 리뷰들은 독립 보안 감사를 대신하지 않는다.

<a id="adr-030"></a>
## ADR-030 — builder fee의 절반을 Vault 배포자에게 오프체인으로 돌려준다

**상태: ACCEPTED (사용자 진술, 2026-10-05; 오프체인 정산 미구현).** 사용자는 다음과 같이 정했다: Vault 배포자(owner)는 API 주문에 플랫폼의 builder 주소를 넣을 수 있고, 플랫폼은 그 주소로 받은 builder fee의 50%를 배포자에게 돌려주며, 이 계산은 플랫폼이 오프체인에서 한다.

컨트랙트 변경은 없다. Vault는 이미 Factory template의 `builder` 주소와 `builderFeeCap`을 고정하고 owner의 `approveBuilderFee`를 그 안으로 제한한다([구현 명세](managed-usdc-vault-implementation.ko.md)). 페이백 금액·지급 주기·지급 수단은 온체인에 없고 이 저장소에 구현돼 있지 않다.

이 결정이 다른 결정에 주는 영향:

- builder 코드는 API 주문에만 실을 수 있고 CoreWriter 주문에는 builder 필드가 없다. 따라서 이 수익 모델은 API 직접 매매([ADR-023](#adr-023))를 전제로 하며, 주문을 Vault 함수로만 제출하는 구조([구조 비교안](managed-scope-enforcement-options.ko.md)의 B)와 양립하지 않는다.
- 성과 수수료([ADR-016](#adr-016)·[ADR-017](#adr-017))와 별개의 흐름이다.

아래는 사용자가 말한 내용이 아니라 구현자의 해석이다. builder fee는 주문을 낸 Vault의 Core 계정이 내므로 예치자 전체가 NAV로 부담하고, 그 절반이 owner 개인에게 돌아간다. owner에게 매매 횟수나 fee 요율을 높일 유인이 생기므로 `builderFeeCap` 값과 예치자 고지가 중요하다. 오프체인 정산은 온체인으로 검증할 수 없다. 상한 값, 고지 문구, 정산 기록의 공개 여부는 정해지지 않았다.

<a id="adr-031"></a>
## ADR-031 — 운용자 주문은 브라우저에 보관한 Vault 전용 agent 키로 서명한다

**상태: 사용자 요청(2026-10-05)에 따라 로컬 구현; 아래 세부 선택은 구현자 기본값이며 사용자 확정 대기.** 사용자는 "볼트를 만들고, 다른 유저의 볼트도 보고, 볼트 배포자가 주문도 넣을 수 있는 FE"를 요청했다. 이전 FE는 키를 다루지 않았고 주문은 별도 도구에 맡겼다([ADR-027](#adr-027) 당시의 범위). 이 결정으로 FE가 주문 서명 키를 생성·보관한다.

**왜 지갑으로 서명할 수 없는가.** 주문·취소는 Hyperliquid의 L1 action이고 그 EIP-712 domain은 chainId 1337로 고정돼 있어 브라우저 지갑이 서명하지 않는다. Vault는 컨트랙트 계정이라 master 서명도 없다. 주문을 낼 수 있는 것은 Vault가 action 9로 등록한 agent 키뿐이다([ADR-022](#adr-022)·[ADR-023](#adr-023)).

구현자 기본값:

1. **키는 브라우저에서 만들고 암호로 암호화해 그 브라우저에만 둔다.** PBKDF2-SHA256 600,000회와 AES-GCM 256을 쓰고, 복호화한 키는 잠금 해제한 동안 메모리에만 있다. 서버로 보내지 않는다. 암호를 잊거나 브라우저 저장소를 지우면 새 키를 만들어 다시 등록한다. Vault가 이미 쓴 agent 주소의 재등록을 거부하므로 키는 매번 새로 만든다.
2. **주문 화면은 등록 범위 안의 시장만 고르게 한다.** USDC 담보 DEX의 perp와, 등록 token의 등록된 USDC pair만 선택할 수 있다. 등록하지 않은 시장을 거래해 NAV에서 빠지는 실수를 화면에서 줄이기 위한 것이다([ADR-029](#adr-029) 정책 6·7). **보안 경계가 아니다.** 같은 키로 다른 도구에서 범위 밖 주문을 낼 수 있고 그 경우는 신고와 급락 대기가 다룬다.
3. **주문 전송은 빌드 설정으로 따로 켠다**(`VITE_ENABLE_TRADING`). 꺼져 있으면 서명·전송 없이 action을 미리보기로만 보여 준다. 모든 action에 60초 만료를 넣고, 전송 뒤 응답을 받지 못하면 결과 불명으로 표시하며 자동으로 다시 보내지 않는다.
4. **builder fee는 Vault에 고정된 builder와 Core에 승인된 한도 안에서만 붙인다**([ADR-030](#adr-030)).

5. **보안 리뷰(2026-10-05) 뒤에 더한 기본값.** 암호는 12자 이상이다. 잠금 해제한 키는 10분 동안 쓰지 않으면 다시 잠기고, 전송 직전에도 그 시간을 확인한다. mid에서 1% 넘게 불리한 쪽으로 벗어난 지정가는 벗어난 정도를 보여 주고 한 번 더 확인을 받는다. production build는 자기 origin의 스크립트·스타일·글꼴만 허용하는 Content-Security-Policy를 넣고 외부 글꼴을 쓰지 않는다. **화면은 Vault가 스스로 답하는 asset과 upgrade controller를 믿지 않는다.** Vault는 업그레이드할 수 있고 업그레이드 뒤에도 `isVault`가 참이므로, 승인 대상은 Factory의 asset으로 하고 코드 변경 여부는 deployer가 만든 controller에 묻는다. 코드가 바뀐 Vault에는 입금과 승인을 제공하지 않는다(출금 요청과 청구는 유지). 2차 리뷰 뒤에 더한 것: build가 Factory를 지정하면 화면에서 Factory를 바꿀 수 없다(Factory가 화면의 신뢰 기준이므로). 주문 확인 상자는 뜬 뒤 0.7초 동안 클릭을 받지 않고 30초 뒤 무효가 된다. 취소와 reduce-only 주문은 등록 범위를 읽지 못해도 보낼 수 있다(키가 이 브라우저에만 있어 다른 방법으로는 걸어 둔 주문을 거둘 수 없다). 승인은 입금액만큼만 하고 남은 승인은 보여 주고 취소할 수 있게 한다.

검토한 대안: 플랫폼 서버가 키를 보관(운용 키의 수탁이 되므로 제외), 하드웨어·지갑 서명(위 이유로 불가), 평문 저장(제외).

받아들이는 위험: agent 키는 출금은 못 하지만 거래는 할 수 있다. 페이지에 주입된 스크립트나 악성 확장이 잠금 해제된 키를 쓰면 불리한 거래로 Vault 가치를 뺄 수 있다. 이는 [ADR-023](#adr-023)의 운용자 신뢰 범위 안의 위험이지만 FE가 키를 다루면서 공격면이 넓어진다. 서명 구현은 공식 SDK의 벡터와 대조했고 **실제 주문 전송과 컨트랙트 계정 agent의 주문 귀속은 검증하지 않았다**([MARKET-002](BACKLOG.ko.md#market-002)).

<a id="adr-032"></a>
## ADR-032 — Vault별 대화는 지갑 서명으로 로그인하는 별도 서버에 둔다

**상태: 사용자 요청(2026-10-05)에 따라 로컬 구현; 아래 세부 선택은 구현자 기본값이며 사용자 확정 대기.** 사용자는 "볼트 배포자와 유저가 대화할 수 있는 장소"를 요청했다. 이 저장소에는 서버가 없었다.

구현자 기본값:

1. **오프체인 서버에 Vault 주소별 대화방을 둔다.** 메시지는 서버의 SQLite에 저장한다. 온체인 메시지는 글마다 gas가 들고 영구 공개되며 공개 RPC의 로그 조회 범위가 좁아 읽기도 어렵다. 외부 메시징 프로토콜은 의존성을 늘리므로 쓰지 않았다.
2. **지갑 서명 한 번으로 로그인한다.** EIP-712 서명을 서버가 검증하고 12시간짜리 토큰을 준다. 거래를 보내지 않으며 글마다 서명하지 않는다.
3. **역할은 체인에서 읽는다.** Vault의 `owner`이면 운용자, 지분이나 출금 요청이 있으면 예치자, 그 외는 방문자다. 서버가 역할을 저장하거나 주장하지 않는다.
4. **기본 정책: 누구나 읽고, 운용자와 예치자만 쓴다.** 설정으로 모든 지갑에 쓰기를 열 수 있다. 운용자는 자기 Vault의 메시지를 숨길 수 있다.
5. **볼트 목록에는 서버를 쓰지 않는다.** Factory의 `vaultCount`와 deployer의 CREATE nonce 규칙으로 주소를 계산하고 `isVault`로 확인한다. 서버나 indexer가 Vault의 존재·NAV·권한의 신뢰 원천이 되지 않는다.

받아들이는 한계: 메시지는 공개이고 종단간 암호화가 없다. 서버 운영자는 메시지를 지우거나 막을 수 있다. 운용자가 불리한 글을 숨길 수 있다(숨김 사실은 표시된다). 대화 내용은 투자 권유의 검증이나 플랫폼의 보증이 아니다. 신고·스팸 대응은 속도 제한과 숨김뿐이다. 서버 호스팅·백업·개인정보 처리 방침은 정해지지 않았다.

<a id="adr-033"></a>
## ADR-033 — 즉시 발행·별도 Core 배정과 자산별 USDC/HYPE/UBTC Vault

**상태: ACCEPTED (사용자 요청·선택, 2026-10-11); 신규 배포용 로컬 구현.** 사용자는 kHYPE의 수령 기반 동기 발행과 별도 Core 운용 배정 흐름을 채택하고 HYPE·UBTC 지원을 요청했다. 추가 질문에 "자산별 Vault: USDC / HYPE / UBTC 중 선택"으로 답했다.

- 하나의 Vault는 하나의 기준 자산으로 입금·출금하고, 지분·성과 수수료·원가도 그 자산 단위로 계산한다. HYPE UX는 native이며 내부 ERC-4626 asset은 WHYPE다.
- 생성 시 실제 EVM 수령한 창설자 원금을 즉시 지분으로 발행하고 EVM 현금으로 보관한다. Core 배정은 owner가 예약·실행한다. 별도 USDC 활성화 비용은 원금에 포함하지 않는다. 이미 활성화된 Core 주소는 비용 없이 재사용한다.
- 구현자 기본값: 창설자 원금은 precompile 가격으로 100 USDC 상당 이상, 활성화 예산은 배포 스크립트 기본 1 USDC, 초기 최소 입금은 배포 시점 10 USDC 상당의 고정 자산 수량. fee 기본 10%, 그중 platform 20%는 유지한다.
- Core 주소를 유지하는 stateless delegatecall bridge로 자산별 전송을 분리한다. kHYPE의 동적 7-facet registry와 외부 보상 보고 기반 NAV를 그대로 도입하는 결정은 아니다. 현재 precompile source의 등록 범위·가격 가드·신고·가격 이력을 유지하고 순가치를 기준 자산으로 변환한다.
- 배정·회수 pending 동안 Active 발행은 닫고 sync 후 실시간 평가로 연다. activation-only 대기는 EVM 현금만 사용하므로 입금·현금 출금 요청 정산이 가능하다. kHYPE와 유사한 자금 흐름을 채택해도 CoreWriter 성공 영수증이 생기는 것은 아니다.
- 기존 ManagedUsdcVault/Factory ABI와 배포 경로는 별도로 유지한다. 새 ManagedAssetVault는 이전 storage-compatible upgrade로 배포하지 않는다. 새 Vault의 향후 업그레이드는 owner·48시간·Idle 조건을 유지한다.

[현행 구현·수식·메인넷 시나리오](managed-asset-vault.ko.md), [구현 상태](STATUS.ko.md), [출시 전 작업](BACKLOG.ko.md#asset-001). 기존 ADR-029의 평가 범위 한계, owner API 매매 신뢰, HIP-4 미지원은 해소된 것으로 표시하지 않는다.


<a id="adr-034"></a>
## ADR-034 — 플랫폼 직접 배포 자산별 Vault

**채택 · 2026-10-11.** 사용자는 “볼트 수익률 비교” 세션과 대화해 공개 Factory 대신 직접 Vault로 바꾸라고 요청했다. 해당 세션에 메시지를 보내 답변을 확인했다. 자산별 독립 Vault·동일 Core 주소·즉시 지분 발행·배정 큐·precompile NAV·업그레이드·원자산 기준 출금 성과보수를 유지한다. 공개 생성 경로는 ADR-033의 해당 부분을 대체한다.

배포자는 Factory 없이 Controller/implementation/proxy를 직접 배포·bind한다. 지정 owner가 별도 bootstrap 거래로 초기 원금과 활성화 USDC를 납입한다. seed 수령/mint/활성화 요청은 원자적이지만 배포부터 포함한 전체 과정은 여러 거래다. 초기화 전 공개하지 않는다. legacy Config.factory는 owner를 bootstrap 권한으로 담으며 ABI/storage 변경을 만들지 않는다. 100 USD seed 하한은 운영 bootstrap script에서 검사한다.

FE는 검토한 배포 manifest를 신뢰 기준으로 사용한다. 기본 공개 Factory 메뉴와 임의 주소 입력을 제거한다. 구 Factory 코드는 이력 회귀로 남긴다. 상세·운영 절차는 [직접 Vault 명세](direct-vaults.ko.md), 오라클 차이는 [kHYPE 검토](khype-oracle.ko.md)를 따른다.

비교 세션의 HYPE/BTC PM 재귀 차입·추가 현물/동량 short·원자산 축적 방향을 상품 문서에 반영했다. 목표 APR·LTV·hurdle fee는 확정하지 않았다. 이번 변경이 자동매매 봇/실계정 위험 제어 완료를 뜻하지 않는다. USDC 계약을 유지하지만 새 USDC 전략은 미확정이다.

<a id="adr-035"></a>
## ADR-035 — HyperVault 해커톤 프로토타입: USDC Vault 1개 메인넷 통제 왕복과 운영 도구

**채택 · 2026-10-12.** 사용자는 Colosseum 제출을 위해 현재 Vault를 **HyperVault**로 소개하고 실제 Core↔EVM 왕복 증거를 요구했다. 테스트넷 계정이 잔액 0이어서 사용자는 **메인넷·owner 자기 소액 자금**을 선택했다. 활성화 비용(계정당 1 USDC)과 자금 한도 때문에 USDC Vault 1개만 배포했다. Vault 하나가 세 자산을 다루는 구조는 기준 자산·bridge·configHash가 고정되어 불가능하며 새 계약 설계가 필요하다(이번 범위 밖).

결정:

- seed는 사용자 승인으로 운영 스크립트 정책 100 USD의 예외인 11.78 USDC다(온체인 하한은 양수). Vault 상한 1,000 USDC. verifier는 데모용 가격 창 10분·하락 대기 300 bps·dust 2 USDC·회수 timeout 10,000 Core block. 출시 값이 아니다.
- 계약 코드는 바꾸지 않는다. 운영 도구(`scripts/hypervault/`)와 FE만 추가한다. 주문은 Vault agent 키로만, 자금 이동·agent 변경은 owner Vault 함수로만 한다.
- USDC 전략 v0를 확정했다([명세](hypervault.ko.md#usdc-전략-v0-정책-이번에-확정한-범위)). HYPE/BTC PM 추가 leg는 PM 자격 확인 전 dry-run으로만 둔다.
- AI는 규칙 엔진 결과의 요약만 한다. 도구·서명·한도 변경 권한이 없고 실패해도 규칙 결과는 게시된다.
- keeper(`recordPrice`)는 owner와 다른 전용 키를 쓴다. 같은 키는 nonce 경쟁으로 owner 거래를 거부시켰다(실측).
- 출금 정산 시 팔 수 없는 gas 예비 HYPE(최소 주문 10 USDC 미만)가 NAV의 3%를 넘으면 하락 대기에 걸린다. 이 프로토타입은 source 규칙대로 팔 수 없는 token을 범위에서 빼서 정산했다. 그 잔량은 범위 밖 Core 보유로 남고 다음 재등록 시 NAV에 다시 잡힌다. 출시 전 처리 방식(예비금 규모·별도 회계·verifier 파라미터)을 정해야 한다.

<a id="adr-036"></a>
## ADR-036 — 유동성 버퍼: 운영 정책 채택, 버퍼 기반 즉시 부분 출금은 제안

**운영 정책 채택 · 계약 기능 PROPOSED · 2026-10-12.** 사용자가 kHYPE의 입금 배분 구조(즉시 출금 풀 → 내부 버퍼 → Core)와 비교해 버퍼 구현 여부를 물었다. 현행 Vault는 배정하지 않은 EVM 현금(`availableCash`)이 사실상 버퍼일 뿐이고, 목표 버퍼·자동 보충·유효 버퍼 집계·버퍼에서의 즉시 지급이 없다. Active 출금은 owner의 exit·전체 청산·회수·정산 뒤에만 지급된다.

사용자 선택: **운영 정책 + 설계 문서.** 계약은 변경하지 않는다.

- 채택(운영): owner 배정은 `목표 버퍼 = max(1 USDC, NAV의 10%, 현재 회차에 요청된 지분 가치)`를 남기고 그 초과분만 Core로 보낸다(`roundtrip.py buffer`, `allocate auto`). 감시 규칙 `buffer`가 부족을 경고한다. 계약이 강제하지 않는다.
- 제안(계약, 새 Vault 필요): Active 중 버퍼 현금으로 일부 지분을 즉시 지급하는 경로. 필요 조건: 상방 가격 조작에 대비한 보수적 가격(예: 현재 NAV 가격과 창 안 최저 기록 중 작은 값), 1회·창별 지급 한도 ≤ 버퍼, 사용자별 원가 기반 성과 수수료 적용, 미도착 회수액을 즉시 지급 가능액에 넣지 않음, 계약 크기(현재 여유 474 bytes) 때문에 모듈 분리. kHYPE식 입금 시 자동 Core 전송은 매 입금마다 pending Core 액션을 만들어 입금을 닫으므로 채택하지 않는다.
- 이 기능 전까지 Active 출금은 owner 협조와 전체 청산이 필요하다는 신뢰 경계를 제출·FE에 명시한다.

<a id="adr-037"></a>
## ADR-037 — HyperVault v2: kHYPE식 분리(지분 토큰·매니저·어카운턴트), 양도 가능 지분, Vault 단위 high-water mark 수수료

**채택 · 2026-10-12 · 새 Vault 배포.** 사용자는 LST처럼 DeFi에서 쓸 수 있는 지분을 원했고 "새로운 vault배포를 목표로 진행하자. high water mark 로 진행하자", "1,2도 진행해줘"(항상 응답하는 환율, 보수적 가격), "khype 컨트랙 구조를 참고해서 우리것도 그 구조 사용해줘"라고 요청했다. 분리 범위 질문에 **"토큰+매니저+어카운턴트"**를 선택했다(즉시 출금 풀·diamond facet 제외).

- 구조: `HyperVaultShare`(독립 ERC-20, Vault만 mint/burn/escrow, 업그레이드 불가) · `HyperVault`(매니저 proxy = Core 계정, ERC-7575 `share()` 분리 + ERC-7540 비동기 출금, Core 관리는 v1 그대로) · `HyperVaultAccountant`(환율·high-water mark, Vault별 장부). v1의 source·bridge·verifier는 바꾸지 않고 재사용한다.
- 수수료: 사용자별 원가·손실 이월 대신 **Vault 단위 HWM**. 지분 가격이 이전 최고점(수수료 차감 후 가격)을 넘은 만큼의 10%를 새 지분으로 발행해 owner 80% / treasury 20%. 입금·mint 직전, epoch 정산 직전(EVM 현금 기준), 누구나 호출하는 `checkpoint()`에서 정산한다. 손실 회복 구간은 수수료가 없다. owner 지분도 같은 비율로 희석된다. 수수료율 상한 50%.
- 보수적 가격: Core 평가가 들어간 가격은 `min(현재 NAV 가격, verifier 가격 창 안 최저 기록)`으로 수수료와 공개 환율을 계산한다. 창보다 짧은 급등은 과금·공개되지 않는다. 입금 발행 가격은 기존대로 현재 검증 NAV다.
- 항상 응답: `convertToAssets/convertToShares/totalAssets`(Active)는 Accountant의 마지막 검증 환율로 답하고 revert하지 않는다(`marks(vault).updatedAt`으로 신선도 확인). 발행 판단은 revert하는 `liveNav()`가 맡는다. v1의 `totalAssets` revert 불일치를 해소한다.
- 출금: controller는 지분 소유자와 달라도 된다(allowance 또는 operator). controller당 미결 요청 1건, 같은 열린 epoch의 추가 요청은 합친다. epoch 내 모든 지분은 같은 가격을 받는다.
- 유지되는 한계: Active 출금은 여전히 owner exit·전체 청산이 필요하다(ADR-036 즉시 출금은 미구현). 감사 전이다. HYPE native router는 v2용으로 만들지 않았다.

[구조 문서](hypervault-architecture.md), [STATUS](STATUS.ko.md#hypervault), [BACKLOG HV-002](BACKLOG.ko.md#hv-002).

<a id="adr-038"></a>
## ADR-038 — HyperVault: owner 신뢰 전제, 범위 밖 신고와 급락 대기 제거 (v3 배포)

**채택 · 2026-10-12.** 신고 장치(`reportToken`/`OpenReport`)의 목적(owner가 평가 범위 밖에 가치를 숨겨 싸게 발행·싸게 정산하는 것 차단)과 그 대가(외부인이 범위 밖 토큰을 기부한 뒤 신고해 입금·정산을 멈출 수 있음)를 설명하자 사용자가 "무조건 오너를 신뢰하는거라서 이건 빼도 될거같은데 그리고 급락대기도 빼도될거같아"라고 결정했다.

- 새 모듈 `HyperVaultNavSource`(v1 `HyperCorePrecompileSource`에서 신고·`answeredAt`만 제거, 평가식·가격 가드·범위 해제 규칙 동일)와 `HyperVaultNavVerifier`(v1 `ManagedAssetNavVerifier`에서 급락 대기·가격 이력 필수 조건 제거). 가격 기록(`recordPrice`)은 남겨 어카운턴트의 보수적 수수료 가격에 쓴다. 기록이 없으면 현재 NAV로 계산한다.
- 기존 v1 모듈은 다른 Vault가 쓰고 있어 바꾸지 않았다. 모듈이 Vault에 immutable이므로 v2 계약에 새 모듈을 붙여 **v3**로 새로 배포했다. v2 Vault는 입금 화면에서 뺐다.
- 결과: Active 입금에 keeper 가격 이력이 필요 없고, 정산이 하락 대기에 걸리지 않으며, 팔 수 없는 gas 예비 HYPE 문제(ADR-035)도 정산을 막지 않는다. 기부+신고 방해 경로가 사라졌다.
- 받아들인 신뢰: owner·agent가 가치를 범위 밖으로 옮기면 NAV가 낮게 보이고 그 상태에서 입금·정산이 진행될 수 있다. 출금자는 덜 받고 남은 보유자(대개 owner)가 이득을 볼 수 있다. 제출·FE·구조 문서의 신뢰 경계에 명시한다. 유지되는 보호: 실패한 읽기는 0이 아니라 발행 중단, 음수 Core 자산 상계 금지, 정산 시 Core 평탄(부채·포지션 없음, dust 이하), 보수적 수수료 가격과 F2 입금 대기.

[구조 문서](hypervault-architecture.md), [STATUS](STATUS.ko.md#hypervault), [HV-002](BACKLOG.ko.md#hv-002).

<a id="adr-039"></a>
## ADR-039 — HyperVault: 운용 중 버퍼 즉시 출금(`redeemNow`)

**구현 · 2026-10-12 · 메인넷 미적용.** 사용자가 "왜 한사람만 출금하는데 전체 청산해야하는거야? 버퍼 있으면 되는거자나", "출금신청하고 버퍼에 있는 금액은 바로 가져갈 수 있게 해두면 될거같아"라고 요청했다. ADR-036에서 제안으로 남긴 계약 기능을 구현한다.

- `redeemNow(shares, receiver, shareOwner, minAssets, deadline)`: Active·Ready에서만. `liveNav()` → (미실현이면) 창 안 가격 기록이 없을 때 거부 → 성과 수수료 정산(`_crystallize`) → accountant의 수수료 후 보수적 가격(실시간 가격과 창 안 최저 기록 중 낮은 값)으로 `shares × rate`(내림) → **즉시 출금 수수료 0.1%(`INSTANT_EXIT_FEE_BPS`)를 Vault에 남김** → `assets ≤ availableCash()`(확정 claim 준비금 제외) → 지분 escrow·소각 → 같은 호출에서 지급. `Withdraw` 이벤트.
- 막는 경우: Idle(요청 경로가 이미 즉시 지급), Exiting(회차 정산 중), Core 액션 대기(NAV 없음), 창 안 가격 기록 없음, 전체 공급량 이상(마지막 보유자는 회차 경로), 수령액 0·`minAssets` 미달·마감 경과, 받는 주소 0/Vault. 다른 소유자의 지분은 ERC-7540 operator이거나 ERC-20 allowance가 있어야 한다(`requestRedeem`과 같음).
- 리뷰(code-reviewer, 1차 REQUEST CHANGES) 반영: 기록이 없으면 보수적 가격 상한이 실시간 시가로 풀리는 문제(HIGH) → 거부. 시가로 나가는 사람이 청산 비용(현물+perp taker 약 0.115%)을 남는 보유자에게 넘기고, 저평가 입금 직후 즉시 출금 차익·HWM 수수료 이전이 생기는 문제(MEDIUM 3건) → 0.1% 출금 수수료. operator 권한·마지막 보유자(LOW) 반영.
- 남긴 한계: 최신 기록 슬롯은 누구나 더 높은 값으로 덮을 수 있어 같은 거래 내 급등만 막는다. 기간당 지급 한도(ADR-036 조건)는 **두지 않는다**: 계약 여유 293 bytes, 버퍼 목표가 NAV의 약 10%, 보수적 가격·기록 필수·출금 수수료, 현행 전략의 NAV가 delta-neutral(현물 HYPE는 borrow oracle, short는 mark)이라 가격을 밀어도 두 다리가 함께 움직인다. 대신 버퍼는 **선착순**이며 owner가 배정으로 버퍼를 줄일 수 있다는 점을 신뢰 경계로 공개한다. 업그레이드 대기 중에는 버퍼 보충(회수)이 막혀 즉시 출금 한도가 줄기만 한다.
- 버퍼를 넘는 몫은 기존 `requestRedeem` 회차 경로. 이미 대기 중인 요청 지분은 건드리지 않고, 정산 때 같은 현금 기준 가격을 받는다(시험).
- 가격이 실시간보다 낮을 수 있으므로(창 최저) 나가는 사람이 남는 보유자 몫을 가져가지 않는다. 대신 먼저 온 사람이 버퍼를 쓴다(선착순). 버퍼 보충은 owner의 부분 회수(포지션 일부 축소)로 하며 전체 청산이 필요 없다.
- 리뷰 2차 APPROVE(코드). 한도 면제의 **전제 조건**: (1) keeper가 약 `priceWindow/8`마다 가격을 기록해 창 안에 더 오래된 최저값이 남아 있을 것(v3 verifier `priceWindow` = 600초). 사용자가 방금 기록한 값만 있으면 상한은 '별도 거래' 수준의 보호뿐이다. (2) 평가 범위가 delta-neutral이고 oracle 가격일 것. 범위에 raw spot 가격(`reservePrice=false`) 토큰이나 헤지되지 않은 포지션이 들어오면 이 면제를 다시 검토한다. 두 조건 모두 계약이 강제하지 않는 owner 운영 조건이다. 남은 여유가 293 bytes라 다음 기능 전에 모듈 분리가 필요하다.
- 계약 크기: 미리보기 view(`previewRedeemNow`·`maxRedeemNow`)를 넣으면 24,576 bytes를 넘어 뺐다. FE가 `liveNav`+`accountant.quote`+`windowLow`+`availableCash`로 같은 값을 계산한다(`frontend/src/instant.ts`, 수수료 포함). 런타임 24,283 bytes(여유 293). 저장소 변수 추가 없음(append-only 유지).
- 배포 제약: 현 v3 proxy 업그레이드는 제안 후 48시간 대기 동안 입금·Core 배정이 막히고(`upgradeController.pending()`), 실행은 Vault가 Idle이어야 한다(`upgradeReady`). 새 Vault 배포는 즉시 가능하나 기존 입금자의 이전이 필요하다. 선택은 사용자 결정으로 남긴다. **결정(2026-10-12): 새 Vault(v4) 배포.** 마감 전 시연과 48시간 입금 중단 회피가 이유다. v3는 청산·정산 후 출금 전용으로 은퇴했다(STATUS v4 절).
- 시험: `test/HyperVault.t.sol` 11개(가격·수수료 지급, 현금 한도, 창 최저 가격·남은 보유자 보호, 성과 수수료 선정산, 단계·NAV 조건, 슬리피지·마감·수령자, allowance·operator, 대기 요청 보존, 기록 없을 때 거부, 출금 수수료 귀속, 전체 공급량 거부). 실제 verifier 기록 동작과의 통합 시험은 아직 없다. FE: 셀렉터 감지·한도 계산(`instant.test.ts`), 구현에 셀렉터가 없으면 기존 경로만 보인다.

<a id="adr-040"></a>
## ADR-040 — HyperVault: 헤지된 현물과 숏을 perp 오라클 한 가격으로 평가, 즉시 출금의 가격 기록 요구 제거

**구현 · 2026-10-12 · 메인넷 적용 2026-10-13(v6 `0x6c4556b8068397AD2F3e69205b7C100CAf234883`).** 가격 기록이 왜 필요한지 묻는 사용자에게 "현물 호가가 순간 튀는 문제"라고 설명하자, 사용자가 "현물은 갯수만 사용하고 가격은 오라클을 활용하면 된다는거네"라고 정리하고 진행을 요청했다. 강제 출금 경로는 사용자가 "필요 없을거같아"라고 해 두지 않는다.

- 문제: v3/v4 source는 현물 HYPE를 borrow oracle(현물·perp mark·perp oracle의 중앙값, 현물과 2% 넘게 벌어지면 평가 거부)로, 숏은 DEX 0 `accountValue`(mark 기준)로 평가했다. 두 다리가 다른 가격이라 현물 호가나 mark가 움직이면 NAV가 움직였고, 그래서 즉시 출금은 10분 창 최저 기록을 상한으로 쓰고 기록이 없으면 거부해야 했다(ADR-039). keeper 의존과 "Record it now" 단계가 생겼다.
- 결정: `HyperVaultNavSource.Token`에 `perpOracle`·`perp`를 추가한다. 설정된 토큰은 `수량 × perp oraclePx`(0x0807, 소수 6−szDecimals)로 평가하고, 그 perp의 DEX 0 포지션은 `accountValue + szi × (oraclePx − markPx)`로 같은 오라클 가격에 다시 맞춘다. 헤지된 쌍(현물 수량 = 숏 수량)은 한 가격에서 정확히 상쇄되어 현물 호가·mark가 평가에 영향을 주지 못한다. 오라클은 validator들이 외부 거래소 가격의 가중 중앙값으로 약 3초마다 갱신하는 값이다.
- 설정 조건: 가격 모드는 토큰당 하나(`reservePrice`와 동시 불가), USDC 불가, 메인 DEX perp만(`perp < 10000`), perp당 한 번, DEX 0이 범위에 있어야 함(보정이 DEX 0 equity를 고치므로), `perpAssetInfo`(0x080a, CoreRead에 추가) 읽기 성공·szDecimals ≤ 6·oracle ≠ 0. 평가 중: 보정 단계에서 oracle 또는 mark가 0이면 `InvalidObservation`, 토큰 가격 단계에서 oracle 0이면 기존 규칙대로 가격 거부(`PriceGuard`, 1 lot 미만 먼지만 건너뜀). isolated 포지션이면 평가 거부(cross 요약만 보정 대상). perp와 토큰의 자산·단위 일치는 계약이 확인하지 않으므로 `roundtrip.py scope`(v5)가 사전 점검한다(perp 159 이름 = 토큰 이름 = HYPE, 오라클과 현물 mid 차이 < 2%).
- `HyperVault.redeemNow`: 창 안 기록이 없을 때의 거부는 **범위가 oracle-only일 때만** 면제한다. `HyperVaultNavSource.oracleOnly(vault)` = 설정상 비USDC 토큰이 모두 `perpOracle`, DEX는 0 하나, Core vault 없음 + 실행 시점 DEX 0 `ntlPos`가 등록 perp들의 `|szi|×mark` 합과 정확히 같음(등록되지 않은 mark 기준 포지션 없음). verifier가 그대로 전달한다. 아니면 v4처럼 거부한다(리뷰 1차 MEDIUM 반영). 지급 가격은 여전히 수수료 후 `min(실시간, 창 최저 기록)`이며, 기록이 없으면 실시간(오라클) NAV다. 기록은 성과 수수료 상한과 운용 중 입금 가드에 계속 쓰이므로 keeper 기록은 권장 사항으로 남는다(기록이 없으면 수수료가 실시간 오라클 NAV로 결정된다).
- 남는 차이와 공개: 오라클과 실제 현물 매도가의 차이(평시 약 0.1%)만큼 평가가 처분가와 다를 수 있다. 0.1% 즉시 출금 수수료가 대략 이를 덮는다. 정산(exit)은 여전히 실제 회수 현금으로 가격을 매긴다. 청산 위험은 mark 기준이므로 monitor의 청산가 감시는 그대로 둔다. "Hyperliquid perp 오라클 가격으로 평가"로 공개한다(오라클 미사용 주장 금지).
- 등식 실측(같은 블록, Multicall3 한 번에 0x080f·0x0813·0x0806·0x0807·0x0809): accountValue 5,358,921 = rawUsd 15,620,721 + szi(−12) × mark 855,150, 차이 0; ntlPos 10,261,800 = 12 × 855,150; cross(2배). 보정식이 기대는 `accountValue = rawUsd + Σ szi·markPx(0x0806)`가 성립한다.
- 이전 실측(서로 다른 블록, 참고용): DEX 0 accountValue 5.344641 = rawUsd 15.620721 − 숏 명목 10.276080(mark), szi −0.12, oracle 85.7515 / mark 85.6960, 현물 HYPE 0.11991601, Core 현물 USDC 3.718254, 기존 평가 Core 19.3378 + EVM 1.15 = NAV 20.49. 새 식으로는 Core ≈ 19.34(차이 수 cent: 평가 가격 85.704 → 85.7515, mark 보정 −0.0067).
- 시험: `test/HyperVaultNav.t.sol` 9개 추가(실제 source·verifier·HyperVault: 현물 가격 읽기 없이 mark ±10%에 NAV 불변, 오라클 +20%에 헤지 쌍 상쇄, 기록 없이 `redeemNow` 지급, oracle-only 판정과 등록 밖 포지션이면 거부, isolated 거부, 미헤지 델타는 오라클만 따름, 숏이 열린 채로는 정산 불가, 설정 거부 5종). `test/HyperVault.t.sol`: 기록 없을 때 oracle-only면 지급·아니면 거부 2개. 전체 forge 360·Python 106 통과. 크기: HyperVault 24,442 B(여유 134), NavSource 17,653 B, NavVerifier 8,084 B.
- 리뷰: 1차 APPROVE(코드) + MEDIUM 2(기록 면제가 모든 범위에 적용 → oracle-only 게이트, 시험 공백 → 보강), LOW(perp·토큰 불일치 → 배포 사전 점검, isolated → 거부, 주석·문서 불일치 → 수정). 남긴 것: 리밸런싱 중 두 다리 사이 잔여 델타는 오라클을 따른다(오라클은 외부 거래소보다 약 3초 늦을 수 있음; 두 다리를 가능한 한 같은 블록에 맞춘다), perp szDecimals는 설정 시 고정(바뀌면 재설정), 비USDC 기초자산 Vault에는 아직 쓰지 않는다(`_denominationScope`가 `reservePrice`를 요구, 실패 시 거부).
- 배포: 모듈이 Vault immutable이라 새 Vault(v5)로 배포한다(`HV_VERSION=v5`, `scope`는 `(perpOracle, perp)` 포함 형식). v4는 owner 자금만 있다.

<a id="adr-041"></a>
## ADR-041 — HyperVault 모듈 분리: Core 관리 external library와 읽기 전용 Lens (v6)

**구현 · 2026-10-12 · 메인넷 배포 2026-10-13(v6) · 리뷰 2차 APPROVE.** 1차 APPROVE + MEDIUM 2(Lens 이진 탐색이 매 단계 NAV 전체를 다시 읽어 가스 과다 → 한 번 읽고 메모리에서 최대값 계산, 라이브러리를 오래된 `out/`에서 배포할 수 있음 → 배포 전 빌드·owner=deployer 확인·즉시 기록·재사용) + LOW(직접 호출 차단 시험을 delegatecall 대조로 실효화, Lens 거부 사유, `account()` 무중단, 구현·Lens 코드 대조, `queueCoreAllocation` 재진입 가드, 저장소 레이아웃 고정 검사 `scripts/check_hypervault_storage.py`) 반영. 2차에서 남은 LOW: Lens `oracleOnly`는 NAV 읽기 실패 시 false로 표시(지급 판단과 무관), 빌드 비교는 같은 컴파일끼리라 빌드 생략 방지용. v5 코드의 HyperVault 런타임이 24,442 B(한도 24,576, 여유 134)라 다음 기능을 넣을 수 없었다. 사용자가 분리 방식을 묻고 "v6 개발부터 완료해보자"고 해 BACKLOG HV-005를 구현했다.

- `HyperVaultCoreOps`(external library): Core 관리 본문(배정 예약·실행, bootstrap 활성화, 대기 액션 확인 `sync`, API 지갑 승인·해지, 회수, `transferWithinCore`, 대출 공급·인출, 계정 모드, builder fee, `disabledAgent`)을 옮겼다. Solidity가 external 라이브러리 함수를 DELEGATECALL로 부르므로 Vault의 저장소·주소·잔고로 실행된다. 상태를 바꾸는 라이브러리 함수는 직접 CALL하면 거부된다(시험). owner 권한과 재진입 가드는 Vault의 진입 함수에 그대로 남기고, Vault의 immutable은 `Env` 구조체로 넘긴다. 오류·이벤트는 공용 `HyperVaultTypes`의 것을 써서 selector·topic이 바뀌지 않는다(이벤트는 Vault 주소에서 발생, 시험).
- 상태: Vault의 가변 상태 전체를 `HyperVaultTypes.Layout` 구조체 하나(`$`)로 묶어 저장소 참조로 라이브러리에 넘긴다. 멤버의 절대 슬롯·오프셋은 v5와 같다(slot 0 재진입 가드, 1~23 동일; `_operators` 이름만 `operators`). ERC-7201은 쓰지 않았다. 구조체가 마지막 상태 변수이므로 새 멤버는 끝에만 추가한다. 공개 getter 20개는 같은 이름·반환형으로 직접 작성해 ABI가 v5와 같다. 라이브러리 안에서 나는 인코더 오류 4개(`InvalidAbstraction`·`InvalidAddress`·`ZeroAmount`·`SafeCastOverflowedUintDowncast`)는 `HyperVaultTypes`에 선언해 Vault ABI로 해석된다.
- `HyperVaultLens`(view 전용, 상태·권한 없음, 교체해도 Vault 무관): `account(vault, user)` 한 번으로 단계·NAV·수수료 견적·창 최저 기록·oracle-only·여유 현금·입금 한도·보유 지분과 가치·즉시 출금 가능 지분/금액/거부 사유·출금 요청 상태를 준다. `previewRedeemNow`·`maxRedeemNow`는 `redeemNow`와 같은 순서·계산이다. `previewRedeemNow`가 실제 지급액과 같음은 fuzz로 확인했다.
- 돈이 오가는 경로(입금·출금 요청·수령·`redeemNow`·정산·수수료)는 본체에 남겼다. fallback 라우팅(diamond)과 출금 대기열 별도 계약은 채택하지 않았다.
- 배포: `roundtrip.py`(HV_VERSION=v6, v5와 같은 오라클 범위·100,000 USDC 한도)가 owner 키로 `HyperVaultCoreOps`를 먼저 만들고 `--libraries`로 배포 스크립트를 실행한다. Lens는 스크립트가 함께 배포한다. `verify`는 구현 런타임의 링크 위치(로컬 `forge inspect` 미링크 코드에서 찾은 15곳)가 모두 기록된 `coreOps`인지, `coreOps` 코드가 로컬 산출물과 같은지(immutable 제외), Lens 코드 존재를 확인한다. 드라이런: 라이브러리 약 1.70M + 스크립트 18.64M gas(약 0.0132 HYPE), 구현 단일 트랜잭션 약 6.24M이라 big block 필요.
- 크기: HyperVault 21,629 B(여유 2,947), HyperVaultCoreOps 7,557 B, HyperVaultLens 5,029 B. 시험: `bash scripts/test_managed.sh` exit 0 — forge 369 passed, Python 122 OK, HyperVault 저장소 검사 통과.
