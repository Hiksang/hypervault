# 배포·운영·장애 대응 기획

2026-10-02 범위 주의: 후속 배포 목표는 [ADR-010](../DECISIONS.ko.md#adr-010)·[ADR-011](../DECISIONS.ko.md#adr-011)의 다중 시장 USDC 쌍이다. 아래 manifest/장애 표의 WHYPE 항목은 현행 프로토타입 기준이며 USDC token·CoreDepositWallet·Strategy 계정 모드·6↔8자리 단위·양방향 회수와 spot·HIP-3·HIP-4 시장별 NAV/exit 검증을 [USDC-001/002](../BACKLOG.ko.md#usdc-001)·[MARKET-001/002](../BACKLOG.ko.md#market-001)에서 추가해야 한다.

상태: PROPOSED · 2026-09-21. 연결: REL-001, REQ-13/16/17/18. 현재 31337 제한을 해제하거나 실제 배포를 실행하는 지시가 아니다.

## 출시 단계와 결과물

| 단계 | 진입 근거 | 결과물 |
| --- | --- | --- |
| 로컬 재현 | 의존성·명세·정상/오류 fixture | 재현 가능한 build/test, 크기·ABI 목록 |
| 통제된 testnet | ENV-001, 검증된 설정과 실행 범위 | 최초 전체 왕복, 실패/회수 실험 원장 |
| 배포 후보 검토 | 필요한 Core/NAV/표준/보안 항목 해소 | immutable config, 독립 검토, release candidate artifacts |
| 제한된 운영 | 실제 네트워크 조건·역할·예산·모니터링 준비 | 제한값 내 배포/입금/회수 기록과 manifest |
| 기능 확장 | 후기 feature의 별도 검증 | 새 배포 또는 명시적으로 설계한 이전 경로 |

core 기능 지원이 network마다 같다고 가정하지 않는다. “testnet 통과”만으로 mainnet parameter profile을 복사하지 않는다. 개발 과정에서 자동 승인 절차를 새로 만드는 것이 아니라 결과물을 무엇으로 증명할지 정하는 계획이다.

## 배포 manifest

[manifest 템플릿](templates/deployment-manifest.example.json)의 필수 값을 실제 사실로 채운다. chainId, contract addresses, deployment tx/block hash, runtime/creation code hash, compiler/OZ/config/ABI, module/chunk identity, roles, 시장 metadata 근거, gas/TVL/recap/시간값, 검증 보고서와 미해결 항목을 포함한다.

서명 비밀은 넣지 않는다. null/예시 주소/미검증 profile이면 배포 가능 manifest가 아니다. 현재 Git 저장소가 없다면 commit을 만들지 않고 build 입력 파일 hash와 tool versions로 식별한다. 향후 Git이 생기면 실제 commit과 dirty 상태도 기록한다.

## 구성 검증과 초기화 순서

1. 실제 chain/address/시장·단위·토큰 decimals·코드 존재·code hash를 확인한다.
2. source/observer/oracle가 같은 Strategy ABI와 설정을 사용하는지 확인한다. chunk 복원 hash와 deployer/Factory 크기도 검증한다.
3. atomic pair 생성 결과의 vault↔strategy↔configHash를 대조한다. 역할 및 dustRecipient가 의도한 주체인지 확인한다.
4. 계정 활성화·초기 후원·PM 전환은 [생명주기](core-lifecycle.ko.md)에서 실증한 순서로 진행한다.
5. 제한된 자금의 full roundtrip과 실제 claim을 확인하고 관측/API/keeper 상태를 연결한다.

표준 인터페이스를 지원한다는 응답만으로 경제적 준비 상태를 판정하지 않는다. 사용자가 보낸 별도 자금을 bootstrap 보조금으로 임의 분류하지 않는다.

## 장애 대응 표

| 상황 | 첫 확인 | 가능한 대응 | 하면 안 되는 처리 |
| --- | --- | --- | --- |
| pending 장기화 | action identity, 최신 raw, HTTP provenance | 신규 위험 중단·재관측·근거 수집 | timeout으로 pending 삭제 |
| NAV 실패 | source 오류/범위/시점, 기존 준비금 | 가격 거래 닫기, 기존 claim 유지 | 원금 추정치로 mint |
| health 악화 | 검증 신호·담보·부채·inflight | guardian/설계된 조건부 축소 | 가격 guard 임의 완화·준비금 recap |
| 가스 부족 | 후원 원장·현재 잔고·소모 | 설계된 top-up 경로 | 주주 잔액을 후원금으로 변경 |
| recall 차이 | sender/gross/net/귀속/receipt | 대조·수신 보존·추가 증거 | 강제 native 송금으로 부족분을 성공 처리 |
| reserve 불일치 | WHYPE와 outstanding entitlement | 즉시 진단·신규 위험 중단 | claim 채무 삭감 또는 관리자 sweep |
| keeper 장애 | nonce/RPC/indexer 상태 | 다른 공개 caller로 진행, 재구성 | 관리자 키를 일반 keeper로 공유 |
| 역할 키 사고 | 역할 범위·미결 admin 변경 | 현재 AccessControl 절차로 권한 정리 | 존재하지 않는 upgrade/rollback 가정 |

사고 기록에는 시간·블록·범위·사용자 권리 영향·실행한 tx·남은 제약·복구 근거를 남긴다. 사건 종료는 화면이 정상이라는 사실이 아니라 원장/권리와 실제 지급 가능성으로 판정한다.

## 새 버전 이전

현재 pair는 upgradeable이 아니다. 수정 버전은 새 주소·새 manifest·새 config로 배포하고 기존 자금은 기존 회수/claim 경로를 통해 사용자가 직접 이전한다. 오래된 pending/claim을 새 Vault에 일괄 복사하거나 underlying을 바꾸지 않는다.

이전 도우미를 만들면 기존 controller 권한, min output, 한 tx 실패 복구, beneficiary와 새 share receiver를 검증한다. old Vault를 UI에서 숨겨 청구 권리를 잃게 하지 않는다. 새 버전 배포는 예전 버전의 실패 Core action을 취소하지 않는다.

## 인계 묶음

manifest/profile, ABI/주소, 운영 함수표, raw evidence, 최종 테스트/보안 검토, 권한 복구 연락 경로(실제 정해진 경우), 알려진 장애와 제약, CHANGELOG, 새 HANDOVER 링크를 포함한다. 공개 운영 문서에 비밀키·RPC credential을 포함하지 않는다.
