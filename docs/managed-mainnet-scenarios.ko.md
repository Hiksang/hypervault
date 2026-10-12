# Managed USDC 메인넷 시험 시나리오

2026-10-04. **읽기 전용 사전 점검은 실행했다. 실자금 배포·입금·주문·회수·업그레이드는 미실행이다.** 로컬 모형, 실제 네트워크 실험, 생산용 증명을 구분한다. 실행 결과와 수치는 [STATUS](STATUS.ko.md)가 원본이다.

## 시험 코드

| 코드 | 용도와 실행 범위 |
| --- | --- |
| [ManagedUsdcVault.t.sol](../test/ManagedUsdcVault.t.sol) | 생성·비동기 결과·권한·공격·수수료·최소 금액·업그레이드 로컬 회귀. Core read/결과는 mock |
| [ManagedCoreMainnetProbe](../test/mainnet/ManagedCoreMainnetProbe.sol) | owner 자기 자금만 사용하는 실제 Core 액션 시험 계약. share/NAV/투자자 출금 없음 |
| [managed_mainnet.py](../scripts/managed_mainnet.py) | block-pinned RPC 코드·USDC·Core read, 계약 계정 HTTP 관측. 서명 없음 |
| [managed_agent_smoke.py](../scripts/managed_agent_smoke.py) | Vault 전용 agent의 Alo 주문/취소. 기본 무서명 dry-run; 명시 `--execute`에서만 제출 |
| [DeployManagedVault](../script/DeployManagedVault.s.sol) | 별도 생산 verifier와 검토한 codehash를 받는 Factory 배포 스크립트 |
| [test_managed.sh](../scripts/test_managed.sh) | 네트워크 없이 전체 회귀·크기·storage 호환성 반복 검사 |

실험용 probe에는 검증기를 붙이지 않는다. 직접 관측으로 Core 연동 근거를 모으는 도구이며 **사용자 자금을 모집하는 Vault가 아니다.** `recoverEvmUsdc`로 회수된 실험 자금을 고정 owner에게 돌려준다. probe 성공이 Vault의 준비금·NAV 검증기 구현을 대신하지 않는다.

## 1. 읽기 전용 사전 점검

```sh
python3 scripts/managed_mainnet.py --output /tmp/managed-preflight-NEW.json
python3 scripts/managed_mainnet.py --account "$PROBE" --dex "$HIP3_DEX" --output /tmp/managed-account-NEW.json
```

파일은 exclusive 생성하며 기존 원시 자료를 덮지 않는다. 실패는 오류 상태와 exit 2로 보존한다. RPC reads는 동일 블록과 hash 재검사를 사용한다. HTTP 조회는 시점이 다를 수 있고 fills가 잘릴 수 있으며, 지정하지 않은 DEX·lending·outcome·인플라이트를 포함한 전체 포트폴리오 증거가 아니다.

Factory/Vault 생성은 큰 배포 거래다. 제출 전 실제 estimateGas와 [HyperEVM dual-block 설정](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture)을 확인한다. 작은 블록 한도를 넘으면 창설자/배포 EOA의 Core 계정에서 `evmUserModify(usingBigBlocks=true)`를 먼저 적용하고 완료 후 필요하면 되돌린다. Vault의 Core activation과 **EOA의 big-block 설정**은 별개다. gas를 낮춰 실행시키거나 작은 블록 mempool의 미포함을 계약 실패로 해석하지 않는다. 이 설정 변경도 본 작업에서 실행하지 않았다.

현재 기록은 [읽기 전용 원시 자료](reference/managed-mainnet-preflight-2026-10-04.json)다. 기본 chain 999, USDC decimals 6, Circle/CoreWriter bytecode 존재, Core block read를 확인했다. 토큰/Circle proxy의 실제 implementation 소스·업그레이드 설정 대조나 메인넷 Core write 성공을 검증한 기록은 아니다. 재실행 시 최신 codehash뿐 아니라 proxy implementation도 비교한다.

공식 고정 주소의 출처: [Circle CoreDepositWallet 주소](https://developers.circle.com/cctp/references/hypercore-contract-addresses), [USDC 주소](https://developers.circle.com/stablecoins/usdc-contract-addresses), [CoreWriter](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore). Circle spot 경로의 gross→net은 [공개 구현](https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CoreDepositWallet.sol)의 perp 전달 비용 로직과 구분해 측정한다.

## 2. owner 자금만 사용하는 Core 연동 실험

아래 명령은 **실자금 거래를 발생시킨다**. 이 문서 작성 중 실행하지 않았다. `OWNER`, Foundry keystore `OWNER_ACCOUNT`, `RPC_URL`, `PROBE`, 새 `AGENT` 주소를 실제 통제 계정으로 채운다. 공개 관측 계정 주소를 서명 계정으로 사용하지 않는다. HYPE 가스는 EVM 거래 제출자에게 준비한다.

```sh
forge create test/mainnet/ManagedCoreMainnetProbe.sol:ManagedCoreMainnetProbe \
  --constructor-args "$OWNER" --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT" --broadcast

cast send 0xb88339CB7199b77E23DB6E890353E22632Ba630f \
  'approve(address,uint256)' "$PROBE" 101000000 --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
cast send "$PROBE" 'fundCore(uint256)' 101000000 --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
```

`fundCore` 전후 동일 owner/probe의 USDC, Core USDC, userExists, EVM receipt·Circle event와 Core 처리 블록을 저장한다. 101→100을 기대값으로 **검사**하며 미리 성공 판정하지 않는다. 99/101/초과·실패가 관측되면 비용·격리/재시도 정책을 먼저 수정한다. 한 번 실패한 불명확한 제출은 자동 재전송하지 않는다.

Core 활성화를 후속 블록에서 관측한 뒤 순서대로 실행한다. 매 단계 전후에 snapshot을 새 파일로 저장하고 EVM status와 실제 Core 효과를 따로 판정한다.

```sh
cast send "$PROBE" 'setApiWallet(address)' "$AGENT" --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
cast send "$PROBE" 'setAbstraction(uint8)' 3 --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
cast send "$PROBE" 'supplyToLending(uint64,uint64)' 0 100000000 --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
cast send "$PROBE" 'withdrawAllFromLending(uint64)' 0 --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
```

예시 공급액은 Core USDC 1이며 최소값·시장 지원·자동 공급 여부를 실제 설정에서 확인한다. PM 자동 공급으로 잔액이 이미 lending에 있으면 명시 supply를 반복하지 않는다. mode 전환 조건 미충족은 지원 완료로 기록하지 않는다. 명시적 Supply/Withdraw만 action 15로 제출하며 차입이 별도 action에 있다고 가정하지 않는다.

### Agent 주문·취소

시장별 manifest에 `network`, `kind`(perp/spot/hip3/hip4), `asset`, `symbol`, `priceDecimals`, `sizeDecimals`, `maxNotional`, `metadataEvidence`를 넣는다. **실제 실행 시점의 공식 metadata로 asset ID·담보·quote·활성 시장을 대조해야 한다.** HIP-4가 거래 불가/만기/해당 계정 미지원이면 해당 실험을 BLOCKED로 기록하고 다른 시장 성공으로 대체하지 않는다. runner는 입력 한도·정밀도를 검사하지만 시장 metadata의 진위를 증명하지 않는다. maxNotional은 해당 시장 quote 단위이며 자동 USDC 환산을 하지 않는다.

```sh
python3 scripts/managed_agent_smoke.py --vault "$PROBE" --market /tmp/reviewed-market.json \
  --cloid "$FRESH_CLOID" --side buy --price "$PRICE" --size "$SIZE" --output /tmp/order-dry-NEW.json
```

위 dry-run은 키/SDK/네트워크 없이 payload를 만든다. 실제 서명에는 별도 venv의 검토한 공식 `hyperliquid-python-sdk`와 `eth-account`, 암호화 keystore가 필요하다. 버전·commit과 설치 lock을 실험 manifest에 기록한다. `--execute --keystore /path/to/agent-keystore.json --nonce-file /path/to/dedicated-agent-nonce.json`을 명시할 때만 password를 입력받고 주문을 전송한다. 키·password·signature는 결과 파일에 남기지 않는다.

`extraAgents(user=PROBE)`에서 해당 키의 유효 등록을 확인하고 `vaultAddress=None`으로 서명한다. 각 key는 이 프로세스 전용이며 nonce 파일을 공유·삭제하지 않는다. Alo도 이후 체결될 수 있다. API 응답의 중첩 error를 확인하고, `--cancel`로 같은 asset/cloid를 취소한 후 실제 `orderStatus`·`userFills`·잔여 자산/포지션을 확인한다. 응답 실패/타임아웃은 unknown이며 cloid 조회 전 재주문하지 않는다. [공식 SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk), [API wallet 규칙](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)

등록/교체 → 네 시장의 소액 주문·취소/잔여 포지션 정리 → lending 회수 → agent 교체 철회 → Core USDC 회수 순서로 진행한다. 철회 주소는 `disabledAgent()` 조회값이다. 기존 키가 등록 목록에서 사라지고 더는 새 주문을 제출하지 못하는지 확인한다. 과거 열린 주문과 인플라이트는 별도로 제거한다.

```sh
cast send "$PROBE" 'revokeApiWallet()' --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
cast send "$PROBE" 'recallUsdcFromCore(uint32,uint256)' 4294967295 "$RETURN_USDC_6" \
  --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
# 실제 동일 주소 EVM USDC 수령을 확인한 뒤:
cast send "$PROBE" 'recoverEvmUsdc(uint256)' "$RECEIVED_USDC_6" --rpc-url "$RPC_URL" --account "$OWNER_ACCOUNT"
```

## 3. 실제 Vault 종단 시험 — verifier 통제 검증 후

`DeployManagedVault`는 검토된 `MANAGED_VERIFIER`, `MANAGED_VERIFIER_CODEHASH`, `MANAGED_USDC_CODEHASH`, `MANAGED_CIRCLE_CODEHASH`, `MANAGED_WRITER_CODEHASH`, `MANAGED_TREASURY`, `MANAGED_BUILDER`, `MANAGED_BUILDER_FEE_CAP`, `MANAGED_ACTIVATION_COST`, `MANAGED_MAX_ASSETS`를 요구한다. builder 미사용은 zero address/cap 0이다. hash 일치만으로 verifier가 올바르다는 의미는 아니다. **`MockManagedVerifier`를 배포해 이 조건을 대신 채우면 안 된다.** 후보는 [precompile 검증기](managed-precompile-nav.ko.md)이며 아래 N 시나리오의 통제 실측과 독립 검토 뒤에 사용한다.

| ID | 단계 | 판정 기준 |
| --- | --- | --- |
| M01 | 서로 다른 창설자 2명이 기본/커스텀 Vault 생성 | proxy 주소·owner·API account 분리, 실제 gross 차감, 100 share 한 번, fee/minimum 선택값 |
| M02 | Core 활성화·재확인 | 후속 효과 귀속 증거, 지분 재발행 없음; unknown/중복 proof 거부 |
| M03 | 회수·빈 Core 증명 후 Idle | 장부 귀속 금액과 실제 EVM 현금 일치; 등록 키·열린 주문·부채·인플라이트 없음 |
| M04 | 기본 10 USDC 최소 입금 | 9.999999 거부, 10 성공; mint 실제 USDC 기준; 변경 후 새 한도 적용 |
| M05 | Vault API key로 주문 | query user=Vault, owner/agent 개인 계정 자산과 분리; 시장별 cancel/fill/정산 근거 |
| M06 | owner 전용 action 9/12/13/15/16 | 투자자·agent EVM 호출 거부, typed 필드/단위/동일 주소 회수; Core 결과 별도 확인 |
| M07 | 외부 EVM/Core 송금 | share 미발행, EVM donation NAV 제외; Core 제3자 입금이 회수/이익 증명에 섞이지 않음 |
| M08 | 두 예치자 다른 원가·동일 epoch 출금 | 고유 request ID, gross 준비금, 원가/손실 이월별 net. 실제 거래 PnL로 계산 |
| M09 | 수수료/부분 claim | 선택한 이익 수수료율·그 중 플랫폼 20%; 분할 횟수와 최종 합계 일치 |
| M10 | 재운용과 과거 claim | 준비금 재투자 불가, 확정 claim은 다음 운용 중에도 지급 |
| M11 | 업그레이드 대기·실행 | owner만 제안/실행, 48시간 전/Active 거부, proposal 중 입금 닫힘·claim 유지 |
| M12 | 새 버전 이후 두 번째 cycle | 같은 proxy/Core, share·원가·loss/fee carry·요청·준비금·operator 유지, 재입금→운용→출금 |

이익 20 USDC/손실 20 USDC 같은 정확한 수치, 블랙리스트/부분 지급 실패, 임의 잘못된 Core 증거는 **mock에서 결정적으로 테스트**한다. 메인넷에서 이익을 보장하거나 손실/공격을 강제로 만들지 않는다. 각 실거래의 수수료·funding·부분 체결을 반영해 기대치를 계산한다.

## 4. 반복 검증과 업그레이드 인계

```sh
bash scripts/test_managed.sh
```

기준 storage JSON과 현행 layout, 현행과 V2 fixture의 prefix를 재귀 비교한다. 새 버전에는 같은 원래 Config와 고유 추가 storage를 사용하고 마이그레이션 후 기존 claim과 다음 입금을 회귀한다. prototype의 V2 fixture는 실제 production 릴리스가 아니다. 메인넷에서는 review한 implementation codehash·원래 Config·migration calldata·48시간 제안 거래·실행 거래·전후 자산과 권리 snapshot을 같은 실험 기록에 연결한다. 테스트 완료를 실측 완료로 표시하지 않는다.

## Precompile NAV와 이름·FE 추가 시나리오

[precompile 명세](managed-precompile-nav.ko.md)와 [FE 실행](../frontend/README.ko.md)을 따른다. 이름 overload로 생성 후 name/owner/configHash를 확인하고 owner rename 전후 지분·원가·요율이 유지되는지 대조한다. 이전 overload는 기본 이름을 사용한다.

**검증기 배포와 범위 등록(미실행):** Factory보다 먼저 source와 verifier를 배포하고 그 주소·codehash를 `MANAGED_VERIFIER`·`MANAGED_VERIFIER_CODEHASH`에 넣는다. 배포는 gas가 드는 거래이며 아직 실행하지 않았다.

```sh
forge create src/nav/HyperCorePrecompileSource.sol:HyperCorePrecompileSource \
  --constructor-args <USDC ERC20> <Circle CoreDepositWallet> 0
forge create src/managed/ManagedPortfolioNavVerifier.sol:ManagedPortfolioNavVerifier \
  --constructor-args <USDC ERC20> <source> <recallTimeoutBlocks> <idleDustLimit USDC6> <priceWindow 초> <maxDrawdownBps>
# Vault 활성화 뒤 owner가 범위를 등록한다. 예: USDC + 기본 DEX(0)와 HIP-3 DEX(1), 입금 스위치 on
cast send <source> 'configure(address,(uint32,uint32,bool,bool)[],uint32[],address[],bool)' \
  <vault> '[(0,0,false,false)]' '[0,1]' '[]' true
```

`recallTimeoutBlocks`(10,000~2,000,000 **Core 블록**)와 `idleDustLimit`(USDC 6자리, 1~9,999,999)은 아래 실측으로 정한 뒤 고정한다. 값은 배포 후 바꿀 수 없다. Core 블록은 2026-10-04 공개 관측에서 초당 약 14개였으므로 10,000은 약 12분이지만 이 속도는 프로토콜 상수가 아니다. `priceWindow`(600~86,400초)와 `maxDrawdownBps`(10~2,000)는 급락 대기의 창과 한도이며, 대상 전략의 실제 변동성에서 입금이 얼마나 자주 닫히는지 본 뒤 정한다. 범위는 token 6·DEX 8·HyperCore vault 2 이하이고 USDC 담보 DEX만 등록한다. 범위 등록 뒤 `recordPrice(vault)`를 호출하고 `priceWindow / 2`가 지나야 입금이 열린다. [ADR-029](DECISIONS.ko.md#adr-029)의 결정 대기 가운데 코드가 바뀌는 선택지(A, B, F, E의 (다))를 고르면 이 배포 명령의 대상도 바뀐다. 검증기와 source는 immutable이므로 그 결정 전에 배포하지 않는다.

| ID | 단계 | 판정 기준 |
| --- | --- | --- |
| N01 | 활성화 | 생성 다음 블록의 `finalizeActivation("")`이 Core USDC 100 확인 뒤 Ready. 같은 블록 호출은 `ActionNotFinal` |
| N02 | 범위 등록 전후 | 등록 전 `totalAssets` revert·`maxDeposit` 0. 등록 뒤 NAV = Core 100 + EVM 현금 |
| N03 | 항등식 | 같은 블록의 `source.evaluate`와 `equity_probe.py`의 raw 합, API 통합 잔액을 거래 전후로 대조. Unified와 PM 각각 |
| N04 | EVM→Core 배정 | 제출 블록에는 sync 불가, 다음 블록에 Core 잔액 증가와 NAV 불변을 확인 |
| N05 | Core→EVM 회수 | Core 차감 블록과 EVM 도착 블록, 시스템 전송의 블록 내 순서, 회수 전후 NAV 불변. 거절 사례(잔액·가스 부족)는 API로 거절을 확인한 뒤 `abandonRecall` → 대기 기간 → `syncCoreAction`으로 닫히고 NAV가 변하지 않는지 확인. 포기 없이는 기한이 지나도 닫히지 않아야 한다 |
| N06 | 운용 중 입금 | 손익이 있는 상태에서 제3자 입금의 share와 기존 주주 가치 보존. `deposit`·`mint`의 실제 gas를 [모형 값](managed-precompile-nav.ko.md#gas)과 비교 |
| N07 | lending·PM 전환 | `lending` 플래그를 먼저 켠 뒤 공급/전환. 장부 생성 전 평가 실패, 생성 뒤 NAV 연속성. PM에서 수신 잔액이 자동 공급되는지와 그때 `lending=false` token이 `ScopeIncomplete`로 닫히는지 |
| N08 | 범위 변경 | 잔액이 있는 항목 제거 거부, 1 lot 미만 뒤 제거, 미등록 DEX 거래 시 NAV 누락이 실제로 생기는지 |
| N09 | 종료 | 포지션·차입·음의 DEX equity가 남으면 `settleEpoch` 거부, dust 상한 안에서 확정, 청구 금액 대조. 주문 최소 금액 미만 잔량의 정리 절차 |
| N10 | 가격 | reserve oracle과 spot mark의 실제 괴리 분포(2% 가드가 평시에 걸리지 않는지), spot spread 1% 가드의 평시 통과율 |
| N11 | 미등록 보유 신고 | API wallet으로 등록하지 않은 token을 10 USDC 이상 매수 → NAV가 그만큼 낮게 나오는지, `reportToken`이 성립해 입금·종료가 닫히는지, 매도하면 별도 호출 없이 다시 열리는지, 등록으로 풀면 새 가격 기록이 반 창을 채운 뒤에 열리는지(`clearReport`는 목록 정리다). 미등록 DEX·HyperCore vault도 같은 순서. 신고가 성립하는 동안 두 번째 미등록 대상의 신고가 거부되는지(`NotReportable`), 첫 신고가 풀린 뒤에는 받아들여지는지, 등록된 token을 매수호가 없는 pair로 등록했을 때 다른 pair를 통한 신고(20 USDC 이상)가 성립하는지, 보유를 다른 미등록 대상으로 옮긴 뒤 감시 스크립트가 다시 신고할 때까지 걸리는 시간. API wallet이 실제로 `vaultTransfer`·`agentSendAsset`을 할 수 있는지 |
| N12 | 급락 대기 | `recordPrice` 간격과 창, 손실 직후 입금이 닫히는 시간, 기록이 끊겼을 때의 동작(입금과 종료 정산 모두 기록 뒤 반 창을 기다리는지). 범위를 끈 상태와 신고가 성립한 상태에서도 기록되는지, Idle의 기록이 현금 기준인지. 평시 변동에서 입금이 닫히는 빈도 |
| N13 | precompile gas | [gas 실측](managed-precompile-evidence.ko.md#precompile-gas)을 프로젝트 Vault 계정으로 다시 실행. 실제 `deposit`·`mint` 거래의 gas와 대조 |
| N14 | 빈 호가 | 매수호가가 없는 token을 보유한 상태에서 `bbo`가 0을 반환하는지([공개 표본](managed-precompile-evidence.ko.md#empty-book)의 재확인), 그때 신고가 성립하지 않고 종료 평가가 그 보유를 0으로 세는지, 그 token을 범위에서 뺄 수 있는지 |

mock으로는 [종단 시험](../test/ManagedLiveNav.t.sol)이 N01~N09·N11·N12와 같은 순서를 실행한다. 메인넷 실측 전에는 통과로 기록하지 않는다. 얇은 spot 시장의 가격 조작, Circle 일시정지, HIP-4·USDC 외 담보 DEX는 이 시나리오 범위 밖이며 [명세의 한계](managed-precompile-nav.ko.md#검증-범위와-한계)를 따른다.

추가 로컬 gate:

```sh
bash scripts/test_managed.sh
bash scripts/test_frontend.sh
```

브라우저 데모와 실제 서명·EVM 성공·Core 효과를 별도로 기록한다.

2026-10-04 새 읽기 전용 공개 관측은 [실측 명세](managed-precompile-evidence.ko.md)에 있다. precompile 반환 호환성과 일부 단위/만기 상태만 입증하며 위 실자금 시나리오 실행으로 표시하지 않는다.
