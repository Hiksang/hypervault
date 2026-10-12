# 플랫폼 직접 배포 Vault

2026-10-11 · [ADR-034](DECISIONS.ko.md#adr-034). 자산별 회계·bridge·NAV·출금은 [기존 자산 명세](managed-asset-vault.ko.md)를 사용하고, 생성·발견 경로는 이 문서가 우선한다.

## 상품과 운영

사용자 요청으로 `볼트 수익률 비교` 세션에 연락해 답변을 확인했다. HYPE와 UBTC는 각각 원자산 노출을 유지하며 PM에서 USDC 차입 → 같은 자산 현물 추가 매수 → 추가 매수 수량의 perp short → 비용 차감 후 원자산 축적을 목표로 한다. 기존 예치 원자산 전체를 헤지하는 상품으로 바꾸지 않는다. 비교 세션의 HYPE 10x/BTC 40x는 숏 설정에 관한 요구이며 Vault 전체 레버리지·허용 LTV를 뜻하지 않는다. 현재 Core 시장 제약과 PM 위험 한도 검증 전 자동 실행 상수로 적용하지 않는다.

USDC 계약 지원은 유지하며 USDC 운용 전략은 별도 미확정이다. 가정한 목표 APR, LTV 55%/40%, hurdle fee는 출시 파라미터로 채택하지 않는다. 성과보수는 기존 기본 10%, 수수료 중 플랫폼 20%이며 **출금 시 원자산 단위 이익에 부과**한다. 비교 세션의 재투자 흐름 설명을 매 펀딩 정산마다 수수료를 걷는 변경으로 해석하지 않는다.

API wallet으로 운용자가 거래하는 기반 계약을 유지한다. PM 재귀 매수·헤지·리밸런싱을 자동 실행하는 새 봇을 이번 변경에서 배포하거나 검증하지 않았다.

```text
플랫폼 배포 서명자 → 자산별 Controller + implementation + Vault proxy
지정 owner → Vault.bootstrap(이름, 원금)
사용자 → USDC Vault / HYPE Vault / UBTC Vault
Vault proxy (= Core 계정) → 배정 큐 / API wallet / precompile NAV / 출금 정산
HYPE Router → native HYPE 입출금
```

## Factory 없는 배포

[DeployManagedAssetVault](../script/DeployManagedAssetVault.s.sol)는 한 번 실행할 때 한 Vault를 직접 배포한다. Factory·등록소·중간 자금 수탁 계약을 배포하지 않는다. `DIRECT_DEPLOYER`는 배포 서명자이고 `DIRECT_OWNER`는 실제 운용자다. 둘은 달라도 된다. Controller는 배포자가 bind하고, 초기 원금은 owner만 납입한다. 업그레이드는 기존 48시간 지연과 Idle/agent 해제 조건을 따른다.

1. 검토한 source/bridge/verifier를 준비한다. `DIRECT_BRIDGE`, `DIRECT_VERIFIER` 및 각각 `_CODEHASH`, `DIRECT_TOKEN_CODEHASH`를 고정한다.
2. `DIRECT_OWNER`, `DIRECT_DEPLOYER`, `MANAGED_TREASURY`, `MANAGED_BUILDER`, `MANAGED_BUILDER_FEE_CAP`, `DIRECT_PERFORMANCE_FEE_BPS`(기본 정책 1000), `DIRECT_MINIMUM_DEPOSIT`, `DIRECT_MAXIMUM_ASSETS`를 설정한다. 수량은 기준 자산 원시 단위다. 최소 입금 약 $10은 설정 시 환산한 고정 자산 수량이다.
3. 서명 전 `forge script script/DeployManagedAssetVault.s.sol --rpc-url "$RPC_URL" --sender "$DIRECT_DEPLOYER"`로 시뮬레이션한다. 스크립트는 chain 999만 허용한다. 이 명령에는 broadcast가 없다.
4. 배포된 proxy/controller/implementation/router 주소와 codehash·Config·소유권·bind를 검증한다. Config의 legacy `factory`/`deploymentFactory` 이름에는 **owner 주소**가 들어간다. 이는 bootstrap 권한이며 Factory 의존성이 아니다. 초기화 전 입금 한도는 0이다.
5. [BootstrapManagedAssetVault](../script/BootstrapManagedAssetVault.s.sol): `DIRECT_VAULT`, `DIRECT_CONFIG_HASH`, `DIRECT_IMPLEMENTATION_CODEHASH`, `DIRECT_SEED_ASSETS`, `DIRECT_MAX_ACTIVATION_COST`, `DIRECT_VAULT_NAME`을 설정하고 owner 서명으로 실행한다. 먼저 시뮬레이션한다. 100 USDC 상당 이상 seed·Core 수량 정밀도를 확인한다. **100 USD 하한은 이 운영 스크립트의 정책이며 Vault.bootstrap 자체의 온체인 하한은 양수다.**
6. seed는 USDC/WHYPE/UBTC로 proxy에 정확히 승인한다. 활성화 USDC는 별도 승인한다. **단일 bootstrap 호출 안에서** 원금 수령·주식 발행·활성화 요청이 처리되며 하나라도 EVM 실패하면 모두 롤백된다. 배포, 승인, bootstrap은 별도 거래여서 배포 전체가 원자적이라고 설명하지 않는다. bootstrap 재실행은 금지되고 제3자의 선점도 차단된다. 승인 거래 후 실패하면 남은 승인을 취소하거나 owner가 다시 시도한다.
7. HYPE 최초 seed는 WHYPE다. 일반 사용자는 검증된 Router를 통해 native HYPE로 입출금한다. 후속 Core 블록에서 활성화 확인, 평가 범위·가격 기록·실제 왕복 검증 이후에만 배포 목록을 공개한다.

실제 배포·실자금 시험은 이번 작업에서 실행하지 않았다. 새 주소를 공개하기 전 이전 [통제 시나리오](managed-asset-vault.ko.md#7-검증과-메인넷-시나리오)를 직접 배포 경로로 수행한다.

## 화면과 신뢰 기준

기본 페이지와 `#/assets`는 직접 배포 Vault 화면이다. Factory 주소 입력·공개 생성 버튼을 제거했다. `VITE_DIRECT_VAULTS`에 JSON 배열을 빌드 시 제공한다. 각 항목 필드:

| 필드 | 의미 |
| --- | --- |
| name | 화면 이름 |
| vault | 검증한 proxy 주소 |
| asset, bridge, verifier | 검증한 기준 자산·모듈 주소 |
| controller, implementation | 실제 bind된 Controller와 검토한 구현 주소 |
| router | HYPE Router 주소. 다른 자산은 zero address |

실제 주소가 없으면 `[]`로 두며 가짜 배포 주소를 넣지 않는다. 중복·잘못된 주소·필수 zero address는 오류로 처리한다. 목록 밖의 임의 Vault를 입력해 승인하지 않는다. Controller의 bind·현재 구현, proxy의 자산/모듈 일치를 조회하며 구현 변경 시 신규 작업을 차단한다. 배포 목록은 운영자가 검토한 신뢰 기준이며 자기 보고 getter만으로 코드 안전성을 증명하지 않는다.

기존 Factory 파일·테스트·페이지는 이력 회귀용으로 남긴다. `VITE_LEGACY_FACTORY_UI=true`일 때만 이전 화면을 켠다. 기본 제품은 Factory를 사용하지 않는다. 새 화면은 기본 입출금·관리 기능을 제공하며 기존 주문·채팅 페이지의 직접 Vault 연동은 미완료다.
