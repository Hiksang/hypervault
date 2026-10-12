# kHYPE 오라클과 지분 교환비율

2026-10-11 검토. 공식 주소 목록과 각 주소의 explorer 검증 소스를 읽었다. 외부 프로토콜 코드를 우리 MIT 계약으로 복사하지 않았다.

## 데이터 경로

1. **DefaultOracle:** OPERATOR_ROLE이 validator별 balance, performance score, 누적 reward, 누적 slashing, endBlock을 입력한다. 업데이트 간격 하한은 코드상 1시간이다. 이 계약은 입력값을 저장하며 자체 precompile 호출로 값을 증명하지 않는다.
2. **OracleAdapter:** DefaultOracle의 getValidatorMetrics를 그대로 OracleManager에 전달한다. endBlock은 해당 반환값에 없으며 여기서 블록 일치 증명으로 사용되지 않는다.
3. **OracleManager.generatePerformance:** 권한 있는 operator가 실행한다. 활성화된 adapter 중 stale/실패 응답을 제외하고 최소 유효 개수, score 상한을 검사한다. 유효 응답들의 balance/score/누적 reward/slashing을 산술 평균한다. 별도 sanityChecker가 설정되면 통과해야 적용된다. 중앙값이나 개별 보상 증명 검증이라고 설명하면 안 된다.
4. 이전 누적값과의 증가분만 ValidatorManager에 반영한다. RewardShareTracker가 설정돼 있으면 calculateRewardShare 결과에 따라 보상 몫을 분리하고, 순보상을 totalRewards에 더한다. 분리 몫은 StakingManager의 reward distribution 큐로 보낸다. 오라클 비교 시 이전에 분리한 누적 보상을 다시 더해 중복 집계를 막는다. 소스 주석의 10%를 현재 설정값의 실측으로 대신하지 않는다.
5. **StakingAccountant:** 다음 장부 기반 교환비율을 사용한다.

```text
1 kHYPE당 HYPE =
(누적 stake + 반영된 순보상 - 누적 claim - 누적 slashing) / kHYPE 총공급량
```

신규 stake 시 먼저 기존 장부/공급량으로 발행량을 계산하고 mint한 뒤 새 stake를 기록한다. 보상 보고가 새로 들어오면 교환비율이 갱신된다. 매 입금마다 Core 위임·모든 보상을 실시간 조회한 값은 아니다.

## 무엇을 보장하는가

오라클 stale 검사는 **새 보고 반영 시** 적용된다. Accountant가 기존 장부로 변환할 때 별도로 OracleManager의 최신성을 검사하는 코드가 있다는 뜻은 아니다. 업데이트 중단 시 최신 미보고 보상까지 포함한 실시간 NAV라고 부를 수 없다. 권한 있는 보고자·adapter 관리·upgrade·sanity checker의 신뢰가 있다.

`kHYPE/HYPE` 교환비율은 토큰 장부상 상환가치다. USD 표시에는 별도 HYPE/USD 가격이 필요하다. `교환비율 × HYPE/USD`만으로 DEX 시장가격·디페그·상환 지연까지 반영하는 담보 오라클이 완성되지는 않는다.

우리 Vault는 거래·부채·미실현 손익을 포함하므로 이 장부만 복사할 수 없다. 입금 즉시 mint와 운용 큐 분리는 채택하되, 현재 사용자 선택인 **precompile 기반 등록 범위 NAV**는 유지한다. 외부 보상 보고자로 NAV를 대체하는 변경은 하지 않았다.

## 출처

- [공식 컨트랙트·감사 주소](https://kinetiq.xyz/docs/contracts-and-audits)
- [DefaultOracle 검증 코드](https://hyperevmscan.io/address/0xefbcCc6E33DA1C1ef638cBc0F044968D0f590fED#code)
- [현재 등록된 adapter 검증 코드](https://hyperevmscan.io/address/0x26fE3019B55F65f454c6b5f8BAEeA1Ed405544c9#code)
- [OracleManager 검증 코드](https://hyperevmscan.io/address/0x192826e470bd65FDC2CB472eDd834D096233049b#code)
- [ValidatorManager 검증 코드](https://hyperevmscan.io/address/0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f#code)
- [StakingAccountant 검증 코드](https://hyperevmscan.io/address/0x9209648Ec9D448EF57116B73A2f081835643dc7A#code)

mainnet 읽기에서 등록 adapter 배열은 `0x26fE…44c9` 한 개였다. 등록됐다는 사실과 현재 활성화 여부·보고 freshness는 구분한다. 설정 조회가 실패하면 0이나 안전한 기본값으로 해석하지 않는다.

## 고정 블록 설정 관측

[원시 eth_call 결과](reference/khype-oracle-config-2026-10-11.json), mainnet block **48,237,883**. 해당 블록의 구성만 확인했으며 validator별 실제 보고 최신성이나 offchain 데이터 수집 정확성을 검증한 것은 아니다.

| 항목 | 관측값 |
| --- | --- |
| authorized / active adapter | 1개 / 해당 adapter true |
| MIN_VALID_ORACLES | 1 |
| OracleManager MIN_UPDATE_INTERVAL | 86,400초 (validator별 최소 24시간) |
| MAX_ORACLE_STALENESS | 3,600초 (받아들이는 보고 최대 1시간) |
| sanityChecker | 0x8B641D61f1e8811038bC99ADA1685b261DA2797D |
| RewardShareTracker | 0xE5FbA07C7b3CfbC29633f3D3Ab38b36007F35983 |
| adapter.defaultOracle | 공식 DefaultOracle 주소와 일치 |

DefaultOracle 자체 갱신 간격 1시간과 OracleManager 반영 간격 24시간은 서로 다른 단계다. 여러 adapter를 수용하는 코드가 있어도 이 관측을 다중 독립 오라클 정족수라고 표현하지 않는다. sanityChecker와 reward split의 내부 정책은 이번 조회에서 추가 검증하지 않았다.

## 입금 자금 배분

지분 발행 뒤 즉시 출금 풀·내부 버퍼·Core로 배분하는 함수는 [입금·버퍼 상세](khype-deposit-buffer.ko.md)를 참고한다.
