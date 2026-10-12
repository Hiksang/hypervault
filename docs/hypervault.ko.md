# HyperVault — 해커톤 프로토타입 명세 (Colosseum Hyperliquid)

2026-10-12 · [ADR-035](DECISIONS.ko.md#adr-035). 계약·회계·NAV·출금은 [직접 배포](direct-vaults.ko.md)와 [자산별 명세](managed-asset-vault.ko.md)를 그대로 사용한다. 이 문서는 그 위의 **전략 runner·감시·AI 요약·통제 왕복 도구**와 제출 범위를 정의한다. 실행 결과·판정은 [STATUS](STATUS.ko.md#hypervault), 남은 작업은 [HV-001](BACKLOG.ko.md#hv-001)을 따른다.

## 1. 세 Vault와 전략 v0

| Vault | 기준 자산(지분·NAV·수수료 단위) | 전략 | 필요 조건 |
| --- | --- | --- | --- |
| HYPE | HYPE (WHYPE) | 예치 HYPE 노출 유지. PM에서 USDC 차입 → HYPE 추가 매수 → **추가분만** HYPE perp short | Portfolio Margin 자격·cap, 펀딩 > 차입 금리 |
| BTC | UBTC (Core token 197) | 예치 UBTC 노출 유지. PM 차입 → UBTC 추가 매수 → 추가분만 BTC perp short | 위와 같음, BTC LTV 0.5 |
| USDC | USDC | 델타 뉴트럴 carry: HYPE 현물 매수 + 같은 수량 HYPE perp short | Unified로 실행 가능, PM이면 자본 효율 개선 |

HYPE/BTC Vault는 원자산 전체를 헤지하지 않는다. 자산 가격 상승은 운용 성과가 아니며 성과 수수료는 출금 시 기준 자산 단위 이익에만 부과된다. HYPE perp 최대 레버리지 10x·BTC 40x는 거래소 상한이며 기본값이 아니다. runner의 hedge leg 레버리지 기본값은 2x이고 Vault 전체 레버리지·LTV와 다르다.

### USDC 전략 v0 정책 (이번에 확정한 범위)

| 항목 | v0 값 | 근거 |
| --- | --- | --- |
| 시장 | HYPE/USDC spot(pair 107) + HYPE perp | 가장 깊은 HYPE 호가, Core token 150 reserve 가격으로 NAV 평가 가능 |
| 배분 | 현물 수량 = 숏 수량. 숏은 **현물 체결 수량**으로 낸다 | 요청 수량이 아니라 체결 수량으로 헤지 |
| 차입 | Unified: 차입 없음. PM: 진입 시 차입 없음, 가격 상승 시 perp 손실만 자동 차입 | PM 자격 미달 계정에서 차입 경로가 없다 |
| 규모 | Unified: (USDC − 예비금) / (1 + 1/레버리지), 상한 25 USD(프로토타입) | 현물 매수와 숏 증거금이 모두 USDC에서 나온다 |
| 예비금 | Core USDC 3. 청산 시 현물 HYPE 0.02를 남김(기본값, Core→EVM 전송 gas, dust 한도 2 USDC 이내). run 2는 lot 단위(0.01) 때문에 `--gas-reserve 0.005`로 0.16 전량을 팔고 0.0096을 남겼다 | Core→EVM 전송은 Core에서 HYPE 200k gas를 낸다 |
| 목표 델타 | \|현물 − 숏\| × mark ≤ 2 USD | 초과 시 감시 경보·runner 재조정 |
| 진입 금지 | 펀딩 < 0, 호가 잔량 < 주문의 5배, 최소 주문 11 USD 미만 | 펀딩 역전·유동성·최소 주문 |
| 슬리피지 | IOC, 최우선 호가 ± 30 bps | 무체결은 재전송하지 않고 보고 |

HYPE/BTC 추가 leg는 PM이 아니면 열지 않는다(`blocked`). 추가 leg 상한은 기준 자산 가치 × 프로토콜 LTV × 30%와 25 USD 중 작은 값이다. USDC 차입 금리가 12%를 넘거나 펀딩 APR이 차입 APR 이하이면 확대를 멈춘다. 재귀 확대(차입 → 매수 → 담보 → 재차입)는 구현하지 않았다.

## 2. 운영 도구 (`scripts/hypervault/`)

| 도구 | 권한 | 역할 |
| --- | --- | --- |
| `roundtrip.py` | owner·demo-user 키, 기본 시뮬레이션 | 모듈/Vault 배포, 검증, bootstrap, 활성화, 범위 등록, 입금, 배정, 모드, agent, 출금 요청, exit, 회수, 정산, claim. 각 단계 전후 EVM·Core 스냅샷을 원장(`.omc/hypervault/ledger.jsonl`)에 남기고 `evidence`로 FE용 JSON을 만든다 |
| `strategy.py` | agent 키(주문만), 기본 dry-run | 위 정책의 계획 산출. `--execute`만 IOC 주문을 보낸다. 체결 수량 기반 헤지, 상태 분류(filled/partial/resting/unfilled/rejected/unknown), timeout 시 cloid 조회 후 중단 |
| `monitor.py` | 읽기 전용, `--keeper`일 때만 `recordPrice` | 12개 규칙, 단일 인스턴스 lock, 상태 파일, JSONL 로그, 중복 억제 경보, 마지막 성공 시각, AI 요약 |
| `pm_compare.py` | 읽기 전용 | 같은 명목의 분리 증거금 대 PM 비교표 |

키는 저장소 밖 `~/.config/hypervault/*.key`(600)에 있고 문서·로그·FE에 들어가지 않는다. runner는 EVM↔Core 자금 이동·agent 변경·위험 한도 변경을 하지 않는다.

### 감시 규칙 (13개)

| id | 대상 | 단위 | 임계값 | 행동 |
| --- | --- | --- | --- | --- |
| nav-ledger | verifier NAV 대 EVM 현금 + API Core 평가 | USDC | \|차이\| ≤ max(0.5, 0.5%) | 입금 중단·범위 점검 |
| evm-ledger | ERC-20 잔액 ≥ accountedCash | USDC | 미달 시 alert | owner 작업 중지 |
| unregistered | 등록 범위 밖 Core 보유 | USD | >1 warn, ≥10 alert | 범위 등록 또는 회수 |
| abstraction | 계정 모드 | mode | 기대값과 일치 | 확대 중단·CoreWriter 결과 확인 |
| borrow | 차입·USDC 차입 APR | USDC/APR | PM 외 차입 금지, APR ≤ 12% | 확대 중단 |
| funding | hedge perp 펀딩 | APR | short 중 ≥ 0 | 진입 중단·청산 검토 |
| delta | \|현물 − 숏\| × mark | USD | ≤ 2 | runner 재조정 |
| pending | Core 액션 대기 | 초 | >300 warn, >1800 alert | sync, 회수는 abandon+timeout |
| gas | owner EVM HYPE, Vault Core HYPE | HYPE | 0.02 / 0.002 | 충전 |
| margin | 유지 증거금 ÷ 담보(Unified: USDC 잔액 + uPnL) | 비율 | >0.5 warn, >0.8 alert | 축소·증거금 |
| price-history | 마지막 가격 기록 경과 | 초 | ≤ window/2 (keeper는 window/8마다 기록) | keeper 실행 |
| withdrawals | 청구 준비금 ≤ EVM 잔액 | USDC | 미달 alert | 회수 |
| buffer | 자유 EVM 현금 대 목표 버퍼 | USDC | ≥ max(1, NAV 10%, 요청 지분 가치) | 배정 축소·회수 ([ADR-036](DECISIONS.ko.md#adr-036)) |

읽기 실패는 해당 규칙을 `unobservable`로 둔다. 실행에 오류가 하나라도 있으면 `lastSuccessAt`을 갱신하지 않는다.

### AI 요약의 범위

규칙 엔진의 결과 표와 오류만 입력으로 받아 원인·영향·대응 후보를 JSON으로 요약한다. 입력 digest(sha256)·모델·생성 시각을 함께 저장한다. 모델에는 도구가 없고(`claude -p --tools ""`) 주문·한도 변경·자금 이동 권한이 없다. 상태가 바뀔 때만 다시 호출하며, 실패하면 `ai.status=failed`로 남고 규칙 결과는 그대로 게시된다. 수치와 위험 판정은 규칙 엔진만 한다.

## 3. 통제 왕복 (USDC Vault 1개, 메인넷, owner 자기 자금) — 실행 결과

사용자가 2026-10-12 메인넷 소액 자기 자금 실험을 선택했다(테스트넷 계정 잔액 0). 같은 Vault로 두 번 왕복했다. 결과와 tx는 [STATUS](STATUS.ko.md#hypervault)와 [원시 원장](reference/hypervault-mainnet-2026-10-12/)에 있다.

- run 1 (owner seed 11.78): `deploy-modules → deploy-vault → verify → bootstrap(+활성화 1) → finalize-activation → scope → allocate 11.7 → sync → abstraction pm(미적용 관측) → abstraction unified → set-agent → agent 현물 매수 0.13 → NAV 대조(차이 0) → 매도 0.12 → scope에서 HYPE 제외 → request-redeem(owner) → revoke-agent → sync → begin-exit(첫 시도는 keeper nonce 충돌로 거부, 재전송) → recall → settle → claim`
- run 3 (NAV 발행·출금 의미): `owner Idle 입금 15 → allocate 14.9 → 가격 기록 → demo-user Active 입금 10(NAV 기준 발행 확인) → request-redeem(pending) → begin-exit → recall → settle(claimable) → claim → owner Idle request-redeem(동일 거래 정산) → claim`
- run 2 (별도 예치자 25): `user-deposit → scope(HYPE 재등록) → allocate 24.9 → set-agent(agent2) → strategy --execute(현물 0.16 → 숏 0.16) → NAV 대조(Unified, 숏 보유) → 펀딩 수령 → request-redeem → begin-exit → strategy --unwind --execute → revoke-agent → scope에서 HYPE 제외 → recall → settle → claim(수수료 0, lossCarry 기록)`

seed는 사용자 승인에 따라 운영 스크립트 정책 100 USD의 **예외로 11.78 USDC**다(온체인 하한은 양수). 일반 최소 입금은 10 USDC다. Vault 상한은 1,000 USDC, verifier 가격 창 10분·하락 대기 300 bps·dust 2 USDC·회수 timeout 10,000 Core block이다. 짧은 창은 데모용이며 출시 값이 아니다. PM 자격(계정 가치 > $10k 또는 가중 거래량 > $5M)을 이 규모로는 충족할 수 없어 차입·상환은 하지 않았다.

운영 주의(실측에서 나온 것):

- keeper는 owner와 다른 키를 쓴다. 같은 키는 nonce 충돌로 owner 거래를 거부시켰다.
- 출금 정산 전 Core에 남는 팔 수 없는 HYPE(최소 주문 10 USDC 미만)가 NAV의 3%를 넘으면 하락 대기가 정산을 막는다. 범위에서 HYPE를 빼면(source가 허용) 기존 높은 기록이 10분 창을 벗어난 뒤 정산된다.
- 회수 직후 가격 기록은 이동 중인 USDC가 빠져 낮게 찍힌다. 낮은 기록은 기준선을 낮추지 않으므로 영향이 없다.
- 한 번 해제한 agent 키는 다시 등록할 수 없다(`AgentAlreadyUsed`). 새 키를 `HV_AGENT`로 지정한다.
- SDK 0.21은 spot token 번호에 빈칸이 있으면 초기화에 실패한다. `core.sdk_spot_meta()`로 재색인한 메타를 넘긴다.

## 4. 제출 시 표현 규칙

- 실제 실행한 범위(USDC Vault 1개, 실행한 단계)만 "작동"으로 쓴다. HYPE/UBTC Vault는 로컬 구현·dry-run이다.
- PM 비교는 같은 명목의 자기자본 차이로 설명하며 "수익 2배"로 쓰지 않는다. 특정 경쟁 Vault와의 비교는 하지 않는다.
- NAV는 HyperCore read precompile과 Hyperliquid 자체 가격·reserve oracle을 쓴다. "오라클이 없다"고 쓰지 않는다.
