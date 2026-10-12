# 외부 근거와 검증해야 할 가정

검토일: 2026-10-03 KST (다중 시장 범위 추가). 이번 작업은 공식 문서 재확인과 설계이며 새 RPC 실측·배포·거래 실험은 수행하지 않았다. 과거 원시 스냅샷은 [출처 기록](../reference/README.md)을 유지한다.

| 출처 | 재확인한 내용 | 설계에 주는 제약 |
| --- | --- | --- |
| [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540) | 동기/비동기 흐름 조합, 요청과 claim 분리, 같은 requestId 처리 조건 | 제안한 epoch·권한·preview를 표준 대조 대상으로 둠 |
| [OZ stable ERC4626](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC4626), [OZ Community ERC7540](https://docs.openzeppelin.com/community-contracts/erc7540), [Community 보안 고지](https://github.com/OpenZeppelin/openzeppelin-community-contracts#security) | stable 패키지는 ERC4626 기반; Community 패키지는 ERC7540 전략 모듈을 제공하지만 미감사·호환성 보장 부재 | 첫 USDC 쌍은 stable 기반 + 별도 검증한 async epoch 구현을 기본으로 두고 Community 채택은 별도 평가 |
| [ERC-7575](https://eips.ethereum.org/EIPS/eip-7575) | share 조회, share-to-vault lookup, ERC165 | 독립 Strategy를 만든다고 share 토큰까지 분리할 필요는 없음 |
| [Core 연동](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore) | EVM 구성 시점의 Core read, 지연 write, action 13/15/16 인코딩 표 | 인코딩 명세와 실제 계정의 실행 성공을 별도로 검증 |
| [기본 HyperCore Vault leader](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-leaders-legacy) | 기본 Vault는 validator 운영 perp만 거래하고 spot·HIP-3는 거래하지 않음 | 별도 HyperEVM USDC Vault/일반 Strategy Core 계정으로 시장 범위를 설계 |
| [Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids), [HIP-3](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals) | 기본 perp·HIP-3·spot·outcome별 asset ID, HIP-3 DEX별 상태와 담보 | 시장별 ID/quote/metadata를 허용 목록과 NAV source에 묶음 |
| [HIP-4 mainnet 공지](https://t.me/s/hyperliquid_announcements/550), [Outcome asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids) | HIP-4 outcome 시장의 제한된 mainnet 출시, spot 유사 토큰·만기 정산 | 미결제 outcome을 확정 USDC로 계산하지 않고 시장별 이용 가능성과 payout를 검증 |
| [CoreWriter action 9/12/1](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore), [Builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes) | agent 등록·builder fee 승인 액션은 있으나 CoreWriter order action 1에는 builder 필드가 없음 | API agent 주문 경로·키 권한과 주문별 fee 부착은 별도 설계·실험 |
| [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin) | 미사용 borrowable 자산의 자동 수익, cap에 따른 fallback, 포트폴리오 청산 조건 | PM 진입 후에도 운용 조건 지속 관측 필요 |
| [Circle native USDC](https://www.circle.com/multi-chain-usdc/hyperevm), [Hyperliquid 연결 공지](https://t.me/s/hyperliquid_announcements/495) | HyperEVM native USDC와 HyperCore 연결 | USDC 토큰·Core credit 경로를 현행 WHYPE bridge와 구분 |
| [Circle CoreDepositWallet 인터페이스](https://developers.circle.com/cctp/references/coredepositwallet-contract-interface), [입금 절차](https://developers.circle.com/cctp/howtos/transfer-usdc-from-hyperevm-to-hypercore) | `depositFor`는 caller의 USDC를 가져가 지정 recipient의 Core 잔액을 credit; 단순 ERC20 전송은 입금이 아니며 묶임 | Vault→Strategy Core 배정에 정확한 allowance와 `depositFor` 사용, EVM tx와 Core 관측 분리 |
| [Core/EVM 전이 타이밍](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interaction-timings), [Circle 출금 절차](https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-hyperevm) | Core credit 시점·신규 계정의 같은 블록 CoreWriter 제한; USDC 출금의 계정/DEX/source 제약 | 계약 발신 `SendAsset`와 EVM 실수령을 통제 실험으로 검증 |
| [HyperCore spot metadata](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot), [Core/EVM 단위 링크](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers) | 문서 예시의 Core USDC는 8자리, Circle native EVM USDC는 6자리; 링크 설정은 두 단위의 차이를 명시 | 실제 대상 chain metadata와 EVM token `decimals()`를 함께 확인한 뒤 정수 변환 |
| [로컬 OZ 패키지](../../package.json), [ERC4626](../../node_modules/@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol) | 설치된 stable 5.4.0 기반 동기 전송/발행 경로 | 새 Active 입금이 기존 상위 함수를 자동으로 안전하게 만드는 것은 아님 |

PM 문서는 CoreWriter supply를 향후 기능으로 표현하는 문장을 유지하지만 Core 연동 표에는 action 15가 있다. 문서만으로 어느 네트워크·계정에서 해당 write가 성공한다고 결론 내리지 않는다. 이 차이는 [실험 EX-03](validation.ko.md#ex-03)의 확인 대상이다. 공식 PM 설명의 자동 수익도 raw spot에서 lending으로 이동하는 정확한 시점·효과량을 증명하지 않는다.

개별 CoreWriter receipt를 현재 검토 자료에서 확인하지 못했다는 기존 결론은 “그런 기능이 영원히 없다”는 뜻이 아니다. 새로운 수단을 찾으면 ABI·authenticity·대상 action 범위와 늦은 실행 배제를 별도 검증한다.

## 가정 등록부

| 가정 ID | 확인되지 않은 내용 | 잘못되면 생기는 문제 | 해소 절차 |
| --- | --- | --- | --- |
| AS-01 | 신규 contract 계정의 lending 상태 생성/부재 의미 | clean-account 검사 실패 또는 부채 누락 | 초기 계정과 실패 raw 비교, EX-01 |
| AS-02 | PM 적용 시 bridge 잔액 자동 공급 순서 | 중복 supply/bridge 영구 대기 | EX-02/03, CORE-001 |
| AS-03 | 계정 효과가 제출 action에서만 발생 | 중복 주문·잘못된 ack | EX-04, 청산/외부 변화 모델 |
| AS-04 | recall 실제 sender·gross/net·분할 수신 | 실제 수신 미인정 또는 타 자금 귀속 | EX-06 |
| AS-05 | 허용 시장 조회만으로 계정 전체 가치 포괄 | NAV 누락·중복 | EX-05, 불청객 자산·다른 DEX 시험 |
| AS-06 | 가격의 마지막 갱신 시각을 검증 가능 | 오래된 가격으로 mint | 가격 provenance 조사, NAV source 계약 |
| AS-07 | 공급 인출 가능량과 PM health 조회의 충분성 | 필요한 출금이 실행 불가 | cap/유동성/health 경계 실험 |
| AS-08 | 계약 Vault의 `depositFor`가 Strategy Core 계정에 정확히 credit되고 재시도에서 중복 귀속되지 않음 | 원금 누락·이중 인식·잘못된 계정 credit | USDC-001 전후 블록·잔액·intent 대조 |
| AS-09 | 계약 Strategy의 CoreWriter `SendAsset`가 USDC를 자기 EVM 주소로 회수하고 비용/계정 모드를 판별 가능 | 회수·정산 정체, 순수령 오인 | USDC-001 testnet 계약 계정의 full roundtrip |
| AS-10 | 일반 Strategy 계약 Core 계정에서 spot·HIP-3·HIP-4 시장별 주문/취소/청산·만기 정산을 통제 가능 | 제품 핵심 시장 미지원, 열린 포지션 회수 실패 | MARKET-001 각 시장 통제 거래·정산 원장 |
| AS-11 | 각 DEX·spot token·outcome 전체 노출을 같은 시점의 USDC NAV로 누락/중복 없이 읽고 회수 가능 | share 오발행, 출금액 과대 계산 | NAV-001과 MARKET-001의 completeness·exit 검증 |
| AS-12 | Strategy 계약이 agent 등록·builder fee 승인 후 선택한 주문 경로에서 수수료와 권한을 안전하게 제어 가능 | 오프체인 키가 계약 제한 우회, fee 미수취/과금 | MARKET-002 권한·nonce·fee 통제 실험 |

이 문서의 AS ID는 외부 사실 검증용이다. 제품 정책 선택은 [OPEN 결정](README.md), 구현 상태는 STATUS/BACKLOG가 관리한다. 다른 문서에서 새로운 숫자를 적을 때는 코드 상수·원시 실측·정책 제안 중 어디에 속하는지 표시한다.
