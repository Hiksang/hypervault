# 위험 정책과 파라미터 명세

2026-10-02 범위 주의: 아래 WHYPE cap·buffer·recap·수량 설정은 현행 프로토타입의 입력/제안이다. 후속 [USDC 다중 시장 쌍](../DECISIONS.ko.md#adr-011)은 USDC 단위 cap과 Core credit/회수·spot·HIP-3 DEX별 담보/health·HIP-4 만기/정산 위험을 새 profile로 보정한다. 로컬 WHYPE 값을 USDC 생산 설정으로 이월하지 않는다.

상태: PROPOSED · 2026-09-21. 연결: CORE-006, RISK-001, REQ-12. 운영값 결정은 OPEN-06이다. 아래 로컬 script 값은 재현 기준이며 출시 권장값이 아니다.

## 위험 모델

| 위험 | 관측 입력 | 제안 정책 | 입력이 없을 때 |
| --- | --- | --- | --- |
| 단위·시장 오류 | token/perp/spot metadata, chain/config hash | 배포와 실행 전 지원 범위 확인 | 배정/신규 주문 거부 |
| 가격·유동성 | oracle/mark/BBO, spread, lot, 가능한 실행량 | 편차·slippage·주문 크기 제한 | 가격 guard 완화 없이 대기 |
| hedge 불균형 | Core base 경제수량, perp signed size, EVM 주주 WHYPE | 전체 delta 및 Core 담보별 hedge 범위 검사 | 신규 위험 차단 |
| PM health | 검증된 포트폴리오 건강도·cap·차입·담보 | 사전 경보→추가 위험 금지→축소 | PM 성공 attestation으로 health를 대체하지 않음 |
| 차입/자금조달 | 부채·이자·funding·basis·가용 유동성 | 지속 손실과 비용 민감도 모니터링, 정책상 축소 | 수익률 모름으로 표시 |
| 실행 지연 | action age·Core block·receipt 상태 | 경보와 신규 위험 차단 | timeout 성공/실패 판정 금지 |
| 현금·예비금 | claim reserve, freeCash, gas, recap cap | 준비금 보존·부족 경보 | 기존 claim은 지급 가능 범위에서 유지 |

가용 collateral만으로 계산한 hedge 비율과 전체 주주 자산의 delta는 다르다. 예를 들어 Core 90 HYPE와 short 90에 Vault 10 WHYPE가 있으면 전체는 약 10 HYPE long이다. 그 10까지 short로 늘리면 Core 계정 담보 대비 위험이 변하므로 별도 health 검증이 필요하다. cap fallback과 청산 순서도 고정 가정하지 않는다. [외부 근거](sources.ko.md)

## 경보와 실행 권한

정상 → 주의 → 신규 위험 중단 → 위험 축소 → 전량 종료의 정책 단계를 제안한다. 이는 현재 Strategy enum과 별개다. 각 단계는 관측값·threshold·근거 block·expiry를 명시하며 keeper가 숫자를 임의 입력해 올리거나 내리지 않는다.

초기 구현의 health feed가 불완전하면 `health-based permissionless early exit`가 있다고 표시하지 않는다. 현 guardian/마감/pause exit만 유지한다. 새로운 자동 축소는 검증 가능한 입력과 call predicate를 갖춘 후 구현한다. 종료 중에도 읽기·유동성 실패로 멈출 수 있음을 기록한다.

## 기존 파라미터 등록부

원본: [Vault Config](../../src/AsyncHypeVault.sol), [Strategy Config](../../src/HyperCoreStrategyAccount.sol), [RiskOracle](../../src/HyperCoreRiskOracle.sol), [DeployPair](../../script/DeployPair.s.sol). 값 변경 시 manifest 및 config hash 영향을 확인한다.

| 설정 | 단위/의미 | 현재 로컬 입력 | 운영 결정 방법 |
| --- | --- | --- | --- |
| asset / wrappedHype, writer, system, oracle, observer, reader | 주소·코드 identity | env 또는 script 생성 | 실제 chain code·상호 연결·ABI 확인 |
| admin/manager/guardian/bootstrap/dustRecipient | 역할 주소 | env | 권한 모델과 운영자 분리, beneficiary 확인 |
| expectedChainId | chain identifier | 현재 block.chainid | 명시적 대상 chain과 manifest 대조 |
| hypeToken/quoteToken/perp/spotAsset/spotIndex | 서로 다른 식별자 | env | 같은 시점 metadata에서 추출, 서로 대체 금지 |
| maxAssets | WHYPE wei, 주주 자산 cap | env | testnet 왕복·유동성·health/비용 스트레스 |
| recapCap | cycle별 WHYPE wei | env | 예상 극단 deficit, 준비금 제외 현금 |
| coreGasReserve | Core HYPE 단위 | env | 실제 비용/소모 실험과 귀속 원장 |
| openingTimeout / cycleDuration | 초 | 1시간 / 1일 | 실측 지연 분포와 전략 정책; cycle>opening |
| adminDelay | 초, default admin 전환 | 1일 | 역할 운영 정책; 모든 role 변경 timelock 아님 |
| repayBufferBps | 10,000 기준 multiplier | 10,100 | 가격·이자·최소 lot 시나리오 |
| minHedgeBps / maxHedgeBps | 담보 기준 hedge 범위 | 9,900 / 10,100 | 전체 delta/health와 함께 재설계 |
| maxSlippageBps / maxBboDeviationBps | bps | 100 / 200 | 시장 depth·가격 오류/조작·비용 실험 |
| perp readToOrderMultiplier / maxPriceDecimals / orderSizeLot | raw→order, 가격 자릿수, size step | 10^4 / 4 / 10^6 | 해당 시장의 실제 metadata·비제로 관측 |
| spot readToOrderMultiplier / maxPriceDecimals / orderSizeLot | 위와 별도 시장 | 10^2 / 6 / 10^6 | base decimals·spot index와 독립 대조 |
| NAV maxAge | 초 | Vault 상한 5분, 선택 reader는 0초 초과~5분 | 실제 입력 freshness·가격 갱신 보장과 함께 결정 |

생성자의 최소 검사를 만족해도 경제적으로 안전한 값이라는 뜻은 아니다. zero-as-max lending, signed 범위, wei/Core 변환의 나머지, tick/lot를 각각 검증한다.

## 새 정책 파라미터 제안

| 제안 이름 | 단위 | 보정에 필요한 실험 |
| --- | --- | --- |
| minDepositAssets / minRequestShares | asset wei / shares | 왕복 고정비·dust·소액 DoS |
| targetBufferBps / maxBufferAssets | NAV 비율 / asset wei | 출금 수요·unhedged risk |
| maxUnhedgedExposure | HYPE 단위 또는 quote 위험량 중 하나로 명시 | 가격 급변·입금 집중 |
| maxOrderNotional / executionCostCap | 같은 quote 단위 | depth/slippage/거래비 |
| healthWarn / healthReduce / healthStop | 선택 health 지표의 명시 단위 | liquidation 이전 여유·gap 시나리오 |
| maxLiquidityRounds / epochWindow | 횟수 / 초 | 부분 회수 수렴·대기·비용 |
| gasTopupCap / dustBuyoutCap | 각각 명시한 단위 | 비용 소모·가격 조작·후원 부재 |

production 값은 아직 없다. 임의 수치를 기획서에 넣어 배포 기본값으로 만드는 대신 실험 입력/출력·채택 근거를 붙여 고정한다. 보정은 상승/하락·funding 음전환·금리 상승·유동성 고갈·가격 갱신 지연·cap 도달 조합을 포함한다.

[parameter profile 템플릿](templates/parameter-profile.example.json)은 값·단위·결정·근거를 묶는 예시다. 모든 실제 constructor 인자를 완성한 배포 입력은 아니며 null 값을 0으로 대체해 사용하지 않는다.

산출물: 단위가 포함된 파라미터 profile, 경계값 회귀, 스트레스 결과, 변경 시 재배포 범위. 이 기획은 실제 risk monitor 구현을 완료하지 않는다.
