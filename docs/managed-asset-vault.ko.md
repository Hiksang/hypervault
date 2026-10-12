# 자산별 Managed Vault — USDC / HYPE / UBTC

> **생성·FE 경로 변경:** ADR-034에 따라 현재 제품은 [플랫폼 직접 배포 Vault](direct-vaults.ko.md)를 사용한다. 아래 Factory 생성·목록 설명은 ADR-033의 이전 구현 기록이다. 자산 회계·NAV·큐·출금 명세는 계속 적용한다.

2026-10-11. [ADR-033](DECISIONS.ko.md#adr-033)의 **신규 배포용 구현 명세**다. 기존 ManagedUsdcVault의 저장소 호환 업그레이드가 아니다. 기존 USDC Factory와 FE는 유지된다. 테스트·크기는 [STATUS](STATUS.ko.md), 출시 전 작업은 [ASSET-001](BACKLOG.ko.md#asset-001)을 따른다.

## 1. 사용자 선택과 구성

Vault 하나는 기준 자산 하나를 가진다. USDC, HYPE, UBTC 중 선택하고 같은 자산으로 입출금·원가·성과 수수료를 계산한다. HYPE의 ERC-4626 내부 asset은 WHYPE이며 Factory와 전용 Router가 native UX를 제공한다. UBTC는 Core token 197에 실제 연결된 ERC-20만 사용한다.

```text
ManagedAssetVaultFactory (자산별 고정 template, 누구나 생성)
  ├─ ManagedAssetDeployer
  └─ 각 Vault의 TransparentUpgradeableProxy = Core 계정 주소
       ├─ ManagedAssetVault: 지분, 현금, 출금 epoch, 권한
       ├─ delegatecall → ManagedAssetBridge: 자산별 전송 로직
       ├─ CoreWriter: agent / BLP / abstraction / 회수
       ├─ ManagedAssetNavVerifier → HyperCorePrecompileSource
       └─ ManagedHypeRouter (HYPE Vault만): native 입출금
```

kHYPE에서 채택한 것은 EVM 수령 기반 동기 발행, 운용 배정 분리, 단일 proxy/Core 주소 유지, 별도 회계·전송 모듈이다. 이 구현은 동적 selector registry를 가진 7-facet Diamond를 복제하지 않는다. stateless bridge의 delegatecall을 사용하며 CoreWriter와 전송의 실제 발신자는 Vault다. 기존 ERC-7540 정산과 precompile 평가를 재사용한다. kHYPE의 외부 보상 보고 기반 Accountant는 도입하지 않는다.

Vault의 owner는 Factory 호출자이며 immutable이다. bridge·verifier·자산·수수료 초기값 등 Config가 configHash에 묶인다. bridge에는 상태 변경용 storage가 없고 임의 대상 호출 기능도 없다. 구현 교체는 per-Vault ManagedUpgradeController의 48시간 대기·Idle·agent 해제 조건을 유지한다. bridge 교체 entrypoint는 없다.

## 2. 생성·활성화·입금

`createVaultAndFund(asset, name, founderAssets, maxActivationCost, feeBps, minimumDeposit)`:

1. allowlist template의 기준 자산을 선택한다. founderAssets는 호출자가 명시한 원시 단위이며 100 USDC 상당 이상이어야 한다. HYPE/UBTC 환산에는 precompile reserve 가격과 spot mark 2% 가드를 사용하고 Core 단위로 올림한다. 견적 이후 가격이 바뀌어 하한 미달이면 revert한다.
2. 선택한 자산을 Factory가 받고, Vault가 정확한 수령량을 다시 확인한다. HYPE는 msg.value를 WHYPE로 감싼다. ERC-20 WHYPE로 생성하는 경로도 가능하다.
3. 원금 전액을 accountedCash와 창설자 원가에 기록하고 `founderAssets × 1000` 지분을 즉시 발행한다. 지분 decimals는 기준 자산 decimals + 3이다.
4. Core가 아직 없다면 **별도 USDC 활성화 예산**을 받아 Vault 문맥에서 Circle deposit을 호출한다. 원금을 배정하지 않는다. 배포 스크립트 기본 예산은 1 USDC다. 이미 활성화된 주소는 이 비용을 받지 않고 Idle로 시작한다. 선제 활성화만으로 생성을 막지 않는다.
5. 신규 계정이면 AwaitingActivation이다. 이때 원금은 전부 EVM 현금이므로 일반 입금과 현금 기반 즉시 출금 요청 정산이 가능하다. Core 관리 함수는 잠겨 있다. 이후 `syncCoreAction` 또는 `finalizeActivation`은 후속 Core 블록과 `userExists`를 확인하고 Idle로 전환한다.

생성 트랜잭션의 EVM 호출·수령량 확인이 실패하면 배포·mint·전송이 모두 롤백된다. Core 활성화 후속 처리가 실패했다고 앞선 EVM 트랜잭션이 나중에 되돌려지는 것은 아니다. 후속 활성화가 완료되지 않아도 EVM 현금 출금 경로는 남는다.

기준 자산이 HYPE·UBTC이면 활성화 USDC는 해당 지분의 원금·수익에 포함하지 않는다. USDC Vault도 창설자 원금과 활성화 예산을 나눠 기록한다. 승인 예산 중 사용하지 않은 allowance는 사용자가 취소할 수 있다.

## 3. 배정 큐·버퍼·회수

- `queueCoreAllocation(amount)`: onlyOwner. 현재 availableCash 이하의 **목표 배정액**으로 큐 한 칸을 설정한다. 누적 덧셈이 아니다. 0은 취소다. 현금·NAV는 변하지 않는다.
- `executeCoreAllocation()`: onlyOwner. 실행 시 잔고·phase·pending·upgrade를 재확인한다. 준비금은 availableCash에서 이미 제외되어 있다. 예약 뒤 출금 청구가 확정되면 실행은 한도 초과로 revert한다.
- 잔여 현금은 유동성 버퍼다. 고정 비율이나 자동 전액 배정은 없다. owner가 Core 배정량을 정한다. 기존형 직접 `depositToCore(amount)` 관리 함수도 같은 회계·전송 경로를 사용한다.
- USDC: Circle `deposit(amount, SPOT)` 및 실제 EVM 차감 확인.
- HYPE: Vault 문맥에서 WHYPE unwrap → `0x2222…2222`로 native 전송. staking 위임은 하지 않는다.
- UBTC: 연결 ERC-20을 `0x2000…00c5`로 전송. Core token 197 메타데이터·연결 주소·decimals를 모듈 생성 시 검증한다.
- `recallFromCore(sourceDex, amount)`: 기준 자산을 시스템 주소로 sendAsset한다. HYPE 수령은 native이며 sync 시 실제 native 잔액을 wrap한 뒤 회수액을 장부에 반영한다.
- Bridge.toCore는 EVM/Core 소수점을 변환하고 정밀도 잔량·0·uint64 overflow를 거부한다. HYPE 18→8은 1e10 wei 단위여야 한다. UBTC 실측은 EVM 8→Core 10이다.

이체 중에는 pendingAction이 있어 Active 입금을 닫는다. 원금만 더해서 임시 NAV를 만들지 않는다. 후속 블록에서 동기화한 뒤 실시간 NAV로 다시 연다. activation-only 대기는 모든 원금이 EVM에 있으므로 예외다.

현재 action verifier는 기존처럼 후속 Core 블록을 기준으로 비회수 action 처리 성공을 추정한다. CoreWriter의 agent/control 거절을 독립 증명하지 않는다. 회수는 실제 도착 자산만 기록하고 부족하면 owner 포기 선언·대기 규칙을 유지한다. 이는 네트워크 통제 왕복으로 검증해야 한다.

## 4. NAV·성과 수수료

기존 source는 등록된 Core 장부의 순가치를 USDC18로 반환한다. 새 verifier는 다음처럼 변환한다.

```text
Core 기준 자산 수량 = floor(Core 순가치 USDC18 × 10^자산decimals / 기준 자산의 USDC18 가격)
shareholderAssets = availableCash(기준 자산) + Core 기준 자산 수량
```

USDC 분모는 1e18이다. HYPE/UBTC 분모는 reserve oracle이며 spot mark와 2% 이내여야 한다. 등록 범위의 기준 자산도 **동일 pair·reserve 평가**를 사용하도록 검사한다. 분자·분모가 서로 다른 가격으로 평가되는 것을 거부한다. USDC는 source 요구대로 항상 등록한다.

따라서 UBTC 수량이 동일한 상태에서 BTC 달러 가격만 상승하면 UBTC NAV 수량은 증가하지 않는다. 성과 수수료는 UBTC 단위의 실현 수익에 부과된다. HYPE도 같다. 사용자가 선택한 기준 자산에 대한 운용 성과이며 달러 수익률 상품이 아니다.

기존 가격 이력·급락 대기·미등록 보유 신고·음의 Core 순자산 거부를 유지한다. 등록 목록의 완전성은 여전히 owner 신뢰다. HIP-4, non-USDC 담보 DEX, staking, subaccount는 이번 변경으로 지원되지 않는다. 종료 dust 한도는 **USDC6 가치** 단위 그대로다.

`ManagedRedeem`의 `basisUsdc`, `unaccountedUsdc`는 ABI 재사용을 위한 legacy 이름이다. 신규 Vault에서는 기준 자산 원시 단위이며 USDC로 환산된 값이 아니다. 출금 이익 수수료·loss carry·platform 20%도 기준 자산 단위다. HYPE 예치자의 native 청구는 Router가 unwrap하지만 운용자·플랫폼 수수료는 WHYPE로 지급된다. 창설자 자신의 지분은 기존처럼 성과 수수료 면제다.

## 5. 출금과 API wallet

출금은 ERC-7540 요청 → owner 포지션 정리·기준 자산 확보·Core 회수 → agent 해제 → epoch 정산 → 사용자 claim이다. 현금만 보유한 Idle/AwaitingActivation의 요청은 현금 장부로 즉시 정산한다. 기존 owner 협조 신뢰를 바꾸지 않는다.

HYPE Router: `depositHype(receiver,minShares,deadline)`, `requestRedeem(shares)`, `redeemHype(shares,receiver,minAssets,deadline)`. 청구는 호출자 자신의 controller만 사용하며 Vault의 operator 승인이 필요하다. Factory가 HYPE Vault마다 Router를 배포하고 주소를 기록한다.

API wallet은 Vault가 CoreWriter action 9로 자기 계정에 등록한다. Borrow/Lend, abstraction, builder cap, agent 재사용 금지·해제·exit 관리 함수는 유지된다. API 직접 매매에 등록 범위 강제는 없다.

## 6. FE와 배포 도구

- `#/assets`에 별도 화면을 추가했다. `VITE_ASSET_FACTORY_ADDRESS`가 있으면 주소를 고정한다. 없으면 직접 입력한 Factory가 신뢰 기준임을 표시한다. 기존 `VITE_FACTORY_ADDRESS` USDC 화면과 섞지 않는다.
- 세 기준 자산·이름·창설자 금액·최소 입금·수수료 선택, native HYPE 생성·입출금, Vault 주소 조회, 전액 요청·청구, 큐 설정/취소/실행, Spot 회수, 활성화/action sync, agent 등록/해제, 정산 시작/확정, 기본 범위 등록과 가격 기록을 제공한다.
- 기본 범위 버튼은 USDC+기준 자산+기본 perp DEX 0이다. 다른 token·HIP-3·Core vault는 source.configure를 별도로 설정해야 한다. BLP 포함 여부를 선택한다. HIP-4는 지원하지 않는다.
- Factory의 `vaultAsset`, `vaultController`, `initialImplementation`, `nativeRouter` 기록을 사용해 승인 대상·코드 변경 여부를 확인한다. 변경된 구현에는 신규 입금을 제공하지 않으며 직접 토큰 청구는 유지한다.
- 창설자 하한은 현재 환산값, 최소 입금은 고정 자산 수량이다. 배포 스크립트는 배포 시점 10 USDC 상당을 초기 최소 입금으로 제안한다. 매 입금마다 $10을 재계산하지 않는다.
- `script/DeployManagedAssetFactory.s.sol`: 검토·배포된 자산별 bridge/verifier의 주소·codehash를 받아 새 Factory를 배포하는 스크립트다. 실제 실행·배포는 하지 않았다. 기존 Vault의 migration 스크립트가 아니다.

모듈 배포 순서: 기존 HyperCorePrecompileSource → 자산별 ManagedAssetBridge → 자산별 ManagedAssetNavVerifier → Factory script. bridge constructor는 `(asset, activationUSDC, Circle, kind, coreToken, USDCspotPair)`다. mainnet 기준 kind는 0/1/2, token은 0/150/197, HYPE/UBTC pair는 107/142이며 실제 배포 시 다시 읽어 확인한다. WHYPE는 canonical wrapper를 사용한다.

## 7. 검증과 메인넷 시나리오

```sh
bash scripts/test_managed.sh
bash scripts/test_frontend.sh
python3 scripts/managed_asset_preflight.py --output /tmp/asset-preflight-new.json
```

마지막 명령은 mainnet metadata·ERC20 decimals·reserve만 같은 블록에서 읽고 block hash를 재확인한다. 파일이 있으면 덮어쓰지 않는다. 초기 관측에서 HYPE의 일반 ERC20 decimals 공식을 적용한 오류는 실패로 보존했고, native 예외를 반영한 재관측을 별도 보존했다. [원시 자료](reference/managed-asset-preflight-2026-10-11.json). 거래·서명·실제 왕복 증거는 아니다.

실자금 전 필요한 통제 시나리오:

1. USDC/HYPE/UBTC 각각 신규 주소 생성: 원금 전액 지분, 별도 활성화 예산, 후속 userExists 확인.
2. 선제 활성화된 예측 주소: 생성 성공, 비용 미청구, 기존 Core 보유와 이후 NAV의 관계 확인.
3. HYPE/UBTC 작은 비제로 배정: EVM 차감, 실제 같은 Vault Core 주소 수령, 단위 대조, pending 동안 입금 제한.
4. API wallet 등록·실제 작은 주문·반대 거래·agent 해제, Standard/Unified/PM 각각 raw 장부 대조.
5. Active 추가 입금: 기준 자산 단위 NAV 및 기존 투자자 지분 보존, USDC 손익을 기준 자산으로 환산.
6. Core→EVM 회수: 실제 시스템 재고·native 수령 gas·wrap 확인. 부족 도착과 실패는 성공으로 표시하지 않는다.
7. 청구 준비금이 있는 상태에서 큐 실행 거부; 자산별 실현 수수료 및 80/20 배분, 가격 이력·정산 확인.
8. owner upgrade 제안·48시간·Idle 제한·codehash 변경·FE 입금 차단. 신규 storage baseline 회귀와 독립 감사.

현재 로컬 테스트는 Core 응답·효과를 주입한 모형이다. 등록 scope의 완전성이나 실제 거래 귀속을 자동 증명하지 않는다.
