# Core 액션 관측과 복구 기준

최초 작성: 2026-09-20 KST. 최종 갱신: 2026-09-23 KST. 액션 관측·pending 소비 동작의 관리 원본이다. 대상은 분리된 `HyperCoreStrategyAccount`이며 legacy `HyperCoreVault`에는 이 관측 모듈을 적용하지 않는다. 진행 상태·미해결 복구는 [CORE-002](BACKLOG.ko.md#core-002), 전체 검증 결과는 [STATUS](STATUS.ko.md)를 따른다.

## 증거의 한계

공식 CoreWriter 설명은 주문이 지연된 뒤 HyperCore에서 실행될 수 있음을 명시한다. Read precompile은 EVM 블록 구성 시점의 Core 계정 상태를 제공한다. 따라서 EVM transaction 성공, 다음 블록 도달, 잔액 변화, `cloid`의 존재는 서로 다른 정보다. [공식 Core 연동 문서](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)

공식 Info API의 `orderStatus`는 account와 oid/cloid로 주문 상태를 조회한다. `filled`, `canceled`, `rejected`, `iocCancelRejected` 등의 상태가 있지만 HTTP 응답은 이 컨트랙트가 검증할 수 있는 증명이 아니다. 취소 보고가 부분 체결이 전혀 없었다는 뜻도 아니다. [공식 Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid)

이번 검토 범위의 공식 문서와 저장된 L1Read ABI에서 **개별 CoreWriter action의 확정 성공/실패를 cloid/action hash에 묶어 검증하는 receipt precompile은 확인하지 못했다.** 새 precompile을 임의로 가정하지 않았다. HTTP 판정을 관리자 입력으로 받아 pending을 지우거나, 몇 초 후 자동 실패로 간주하는 기능도 추가하지 않았다.

`CoreActionObserver`는 **계정에 나타난 효과를 분류하는 모듈**이다. `ExpectedEffect`는 액션별 확정 receipt를 뜻하지 않는다. 기존의 “Strategy만 금융 action을 제출하고, 그 실행의 결과로 해당 효과가 발생했다”는 가정은 여전히 검증 대상이다. 청산·자동 정산·외부 전송이 관측을 혼동시킬 수 있으므로 아래 조건 강화만으로 production finality 문제가 해결됐다고 표시하지 않는다.

## 추가된 식별 정보

각 pending 금융 액션에 다음 값을 저장한다.

- `actionId`: Strategy 전체 수명 동안 증가하는 번호
- `cycleId`: 자금을 배정한 cycle 번호
- `cloid`: 주문에 실제 인코딩한 client order ID; lending/recall은 0
- `actionHash`: 실제 CoreWriter payload의 keccak256
- `submittedL1Block`, `submittedAt`: 제출 시 관측한 Core block과 EVM 시간
- 제출 직전 source/destination 기준값과 요청 수량

`CoreActionIdentified` 이벤트를 기존 `CoreActionSubmitted`와 함께 사용한다. 이 번호는 계약의 추적 정보이며 프로토콜이 발급한 execution receipt가 아니다. PM 전환은 별도의 `portfolioMarginActionSubmitted` / bootstrap 확인 경로를 유지한다.

## 초기 공급 제출 조건

첫 `SupplyCollateral` 제출 전에는 raw spot bridge target과 기존 PM 확인 조건 외에 HYPE lending supply/borrow가 모두 0이어야 한다. 비제로는 `ResidualExposure`로 거부하고 bridge target·phase·action ID를 보존한다. read 실패는 그대로 revert한다. 이 검사는 제출 전의 무노출 조건이며, 아래 표의 제출 후 paired effect 관측을 대신하지 않는다.

자동 공급 뒤 raw spot이 줄어드는 가정에서는 bridge target 때문에 진행·exit가 막힌다. `syncPendingAction()`은 금융 pending만 처리하므로 target을 지우지 않는다. 모델 입력과 현재 한계는 [PM 생명주기 재현](pm-lifecycle-model.ko.md)에 있다. 자동 공급 지원이나 PM 지연 적용의 최종성을 검증한 것으로 해석하지 않는다.

## 액션별 판정표

모든 금융 관측은 제출 당시보다 새로운 Core block을 요구한다. 시각은 운영 진단용이며 timeout이 액션을 소비하는 조건은 아니다. position은 `Context.riskOracle`의 `positionSize()`를 통해 raw size lots에서 CoreWriter 1e8로 변환한 뒤 `positionBefore`와 비교한다. raw szi와 주문량을 직접 비교하지 않는다. HYPE/USDC spot·lending의 1e8 단위는 [비제로 PM 표본](pm-nav-evidence.ko.md)에서 대조했지만, PM 자동 공급과 개별 액션 효과 귀속은 별도 통합 검증이 필요하다.

| 액션 | 인정하는 계정 효과 | 단독으로는 부족한 근거 | 현재 진행 조건 |
|---|---|---|---|
| SupplyCollateral | HYPE spot 감소 + HYPE supply 증가 | supply 증가만 또는 spot 감소만 | 양쪽 모두 요청량 이상 |
| OpenHedge | short 방향으로 증가, 증가량이 요청량 이내 | 반대 방향 변화, 요청량 초과, 변화 없음 | 양의 bounded IOC 효과; 잔량은 새 cloid로 후속 주문 |
| CloseHedge | 기존 방향을 뒤집지 않고 절대 포지션 감소 | 부호 반전, 포지션 증가, 변화 없음 | 양의 bounded IOC 효과; liquidation과의 구별은 미해결 |
| ReleaseCollateral | HYPE supply 감소 + HYPE spot 증가 | 출금 반영 없는 supply 감소 | 양쪽 모두 요청량 이상 |
| WithdrawCollateral | HYPE supply 감소 + HYPE spot 증가 | supply가 0이 된 것만 | 양쪽 모두 제출 시 회수 대상량 이상 |
| WithdrawQuote | quote supply 감소 + quote spot 증가 | supply가 줄어든 것만 | 양쪽 모두 제출 시 회수 대상량 이상 |
| RepayDebt | HYPE spot 감소 + quote borrow 감소 | 가스/토큰 감소만, 외부 quote로 부채가 줄어든 것만 | HYPE 감소량이 양수이며 주문 수량 이내인 IOC 효과 |
| ConvertQuote | quote spot 감소 + HYPE spot 증가 | 한쪽 변화만, HYPE 증가량이 주문량 초과 | 양의 bounded HYPE 증가인 IOC 효과 |
| Recall | Core HYPE 차감 + 인증된 system 누적 수신 + native 잔액 | 강제 송금, source만 감소, gross보다 적은 수신 | 요청 gross 전체 금액; net-fee 모델은 아직 미검증 |
| PM 전환 | bootstrap 역할이 별도 확인 | CoreWriter call 성공 자체 | 원래 확인 경로 유지; 미확인 시 신규 위험 금지 |
| 초기 bridge/recap bridge | 목표 Core spot 잔액 관측 | EVM 송금만 성공 | 기존 경로 유지; 전송 식별 receipt는 별도 과제 |

공식 주문 명세상 IOC의 미체결 잔량은 호가창에 남지 않고 취소된다. [공식 주문 TIF 설명](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#place-an-order)

IOC 부분 효과를 인정하는 것은 거절된 주문을 재전송하는 기능과 다르다. 프로토콜의 IOC 실행·잔량 취소 의미와 계정 효과 귀속이 맞다는 기존 가정 아래 남은 경제적 수량을 새 주문으로 제출한다. **부분 효과만으로도 해당 cloid가 확정됐다는 신뢰 없는 증명을 얻은 것은 아니다.** 이 가정을 제거하려면 order-specific finality 증거가 필요하다.

## 관측 결과와 keeper 동작

`pendingActionObservation()`은 새 읽기 전용 조회다. Strategy에 고정된 observer만 호출하며 caller는 account나 관측값을 입력할 수 없다. Core read가 실패하거나 ABI 길이가 잘못되면 `ReadUnavailable`과 revert data hash를 반환한다.

| Evidence | 의미 | pending 소비 |
|---|---|---|
| None | outstanding 금융 액션 없음 | 없음 |
| AwaitingBlock | 제출 block보다 새 관측이 아님 | 금지 |
| NoEffect | 필요한 계정 변화가 관측되지 않음 | 금지; 실패/zero-fill과 동일시하지 않음 |
| PartialEffect | 제한된 방향의 일부 효과 | IOC 주문만 기존 가정 아래 허용; lending은 금지 |
| ExpectedEffect | 액션별 양방향/수량 조건 충족 | 허용; 확정 receipt라는 뜻은 아님 |
| Uncorroborated | source 또는 destination 한쪽 근거만 있음 | 금지 |
| UnexpectedEffect | 방향·부호·수량이 조건과 충돌 | 금지 |
| ReadUnavailable | precompile/read/ABI 오류 | 금지; 0잔액으로 대체하지 않음 |

새 `syncPendingAction()`은 누구나 호출할 수 있다. 관측 이벤트를 기록하고, 인정된 효과만 pending에서 소비하며 bool을 반환한다. 새 order/lending/recall을 제출하지 않는다. `advance()`가 관측 직후 다음 주문 가격 조회에서 실패하면 한 트랜잭션 전체가 rollback될 수 있으므로, 관측 소비를 따로 commit할 수 있게 했다. pause나 opening deadline 후에도 관측 기록은 가능하지만 새로운 위험은 기존 guard가 차단한다.

### Recall 소비와 최종 정산 분리

`RecallPending → Recalling → ReturnReady`로 진행한다.

1. source 차감과 인증 수신을 확인한다.
2. 요청량을 한 번만 wrap하고 pending을 지운 뒤 Recalling으로 전환한다.
3. 다음 `advance()`에서 debt/position/supply/quote/gas 등 terminal 조건을 확인한다.
4. ReturnReady 후 Vault가 실제 반환 잔액을 검증하고 epoch를 정산한다.

3번이 잔여 quote로 실패해도 2번에서 받은 WHYPE와 소비 기록은 유지된다. 이때 keeper가 과거 recall을 다시 제출하거나 같은 금액을 다시 wrap할 수 없다. **quote dust를 처분하는 경로 자체는 이번 단계에 포함하지 않았으며, 잔여 quote는 여전히 정산을 막는다.**

## 읽기 전용 API 진단

`scripts/action_status.py`는 Strategy 주소와 16-byte hex cloid를 받아 공식 Info API만 조회한다. private key·서명·CoreWriter 호출이 없다. 실제 운용 주소가 제공되지 않았으므로 이번 작업에서는 실계정 주문을 조회하거나 거래하지 않았다.

```sh
python3 scripts/action_status.py --network mainnet \
  --account "$STRATEGY_ADDRESS" --cloid "$ORDER_CLOID" \
  --output /tmp/order-observation.json
python3 -m unittest discover -s test/python -v
```

`unknownOid`는 `NotFoundNotFailure`, HTTP 오류는 `ReadUnavailable`, 요청 cloid와 다른 결과는 `Uncorrelated`로 기록한다. 새로 등장한 미지의 status를 suffix만으로 실패 처리하지 않는다. 어떤 결과도 `onchainRetryAuthorized`를 true로 만들지 않는다. 네트워크와 UTC 시각, 원문 응답을 보존하며 HTTP 관측은 block-pinned가 아니라고 표시한다.

## 다음 구현을 위한 명시적 차단 조건

무체결/거절을 온체인에서 재시도하려면 최소한 Strategy 주소, cycle/action identity, 주문 cloid 또는 action hash, 성공/실패와 잔여 실행 불가능성, 관측 Core block을 묶는 **검증 가능한 프로토콜 증거**가 필요하다. 그런 근거가 없는 API attestation을 사용한다면 별도 신뢰 모델과 권한 설계 변경이다. 이번 변경은 그 신뢰 권한을 조용히 추가하지 않는다.

배포 구성에 `Config.actionObserver`가 추가됐다. Factory의 configHash에도 포함되어 배포 후 교체할 수 없다. 로컬 스크립트는 `CoreActionObserver`를 함께 배포한다. 기존 분리 버전과 constructor/PendingAction getter ABI가 달라 새 배포가 필요하다.

Strategy 생성 코드가 커지면서 deployer runtime이 한도에 가까워져, `StrategyDeployer`의 constructor가 생성 코드를 두 개의 불변 `CreationCodeChunk`로 나누어 배포하도록 변경했다. 각 보관 계약은 STOP으로 시작하여 실행 기능이 없고, deployer는 고정된 두 주소에서 코드를 복원한 뒤 Config를 붙여 CREATE한다. caller가 생성 코드를 전달하거나 바꾸는 경로는 없다. Factory 테스트는 두 조각을 복원한 해시가 컴파일된 Strategy 생성 코드와 동일한지 검사한다.
