# 보안 검토와 표준 적합성 기획

상태: PROPOSED · 2026-09-21. 연결: STD-001, SEC-001, REQ-15. 감사 결과나 표준 적합성 인증서가 아니라 검토 범위와 수용 기준이다.

## 신뢰 경계

| 경계 | 공격/실패 가능성 | 확인할 방어 |
| --- | --- | --- |
| 사용자→Vault | 재진입, donation, 승인 혼동, rounding, controller 탈취 | 정확 전송·reentrancy·권한·escrow/준비금 불변조건 |
| Vault→Strategy | 거짓 반환액, 잘못된 계정/설정, cycle replay | immutable 연결·config hash·실제 잔액 증가 대조 |
| Strategy→CoreWriter | 잘못된 payload, 중복 실행, overflow/단위 오류 | typed encoding·checked cast·고유 action ID·허용 시장 |
| Core→Observer | 지연·실패·청산·외부 송금으로 귀속 혼동 | 상태/시점/paired effect·모르는 결과 보존 |
| raw→NAV→mint | 자산 누락·부채 누락·PnL 중복·stale 가격 | 완전성·단위·provenance·fresh quote |
| keeper/indexer→사용자 | reorg·DB 오염·잘못된 화면·nonce 충돌 | 온체인 재검사·출처 표시·재구성 가능한 원장 |
| 역할 키 | 오용·유출·서비스 중단 | 최소 역할, pause/회수 범위, claim 불간섭 |
| Factory/deployer | 코드 조각 변조·잘못된 바인딩·크기 초과 | 불변 코드·hash 복원·atomic 생성·주소 검증 |

## 권한 검토

default admin은 roles 관리 능력이 있으므로 “관리자가 경제적으로 아무 영향도 줄 수 없다”고 설명하지 않는다. manager는 신규 cycle 시작, guardian은 pause/shutdown/조기 exit, bootstrap은 PM 확인에 영향을 준다. generic arbitrary-call, 수령자 setter, source 교체, Strategy 교체를 추가하면 별도 신뢰 결정이 필요하다.

guardian이 신규 위험을 막아도 확정 claim 지급을 검열할 수 없어야 한다. permissionless 실행자는 주문 가격·시장·수령자를 임의 지정할 수 없어야 한다. keeper의 프런트런과 griefing은 자금 탈취뿐 아니라 불필요한 비용·epoch 지연으로도 평가한다.

## 표준 대조 항목

[ERC-7540](https://eips.ethereum.org/EIPS/eip-7540)의 동기 입금/비동기 출금 조합을 대상으로 다음을 독립 검토한다. 이 목록은 조문 전체를 대체하지 않는다.

| 영역 | 대조할 동작 | 로컬 출발점 |
| --- | --- | --- |
| 요청/청구 | request와 claim 분리, escrow/소각, pending/claimable 분리 | EpochRedeem, AsyncHypeVault tests |
| 권한 | owner allowance/operator, claim controller/operator 구분 | operator/allowance 회귀 |
| epoch | 동일 requestId의 환율·처리 시점, 부분 처리 시 동일 비율 | 동일 epoch·부분 claim fuzz |
| view | 비동기 출금 preview revert, max는 실제 entitlement | interface/preview tests |
| 입금 overload | controller 권한, 자금 출처, Deposit 이벤트 | controller overload test |
| 이벤트/인터페이스 | ERC165 ID, 이벤트 인자, unsupported ID | ABI 단위 검사 |

[ERC-7575](https://eips.ethereum.org/EIPS/eip-7575)의 share/lookup/interface와 현재 self-share 모델도 대조한다. EIP-20/4626의 나머지 필수 동작은 해당 표준과 구현을 조문 단위로 별도 검토한다. **OZ 상속과 selector 존재만으로 적합성을 판정하지 않는다.** 각 조문에 적용 여부·코드·시험·편차를 기록한 검토표가 STD-001 산출물이다.

## 불변조건과 공격 시나리오

1. Vault WHYPE가 준비금보다 작아지지 않고, outstanding entitlement와 rounding reserve가 예약액을 설명한다.
2. 미정산 요청 지분의 escrow와 정산 소각이 일치하며 claim에서 재소각하지 않는다.
3. controller별 누적 지급은 자기 entitlement를 넘지 않는다. 부분 redeem/withdraw 순서가 다른 사람 몫을 바꾸지 않는다.
4. cycle/action/bridge/receipt가 한 번만 소비되고 읽기 실패나 시간 경과만으로 실행 권한이 생기지 않는다.
5. 모든 부채는 순자산을 줄이고, 수익/비용·gas/claim이 한 번만 반영된다.
6. pause·shutdown·NAV 장애·후속 cycle이 기존 확정 claim을 잠그거나 투자에 사용하지 않는다.

추가 공격: unsolicited 자산으로 complete/clean check DoS, 한 계정의 공개 송금으로 pending 오인식, oracle와 BBO 동시 왜곡, 경제적 순자산 음수에서 신규 입금, reserve dust stealing, minimal amount spam, 악성 receiver·ERC20 callback, wrong chain, deployer chunk 길이/바이트 변형, stale enum 숫자 비교.

## 검토 산출물과 우선순위

위협별 재현·영향·수정·회귀·남은 가정을 기록한다. 회계/권한/중복 실행/단위 오류와 최종 출금 불가를 우선 검토한다. lint와 컴파일 경고는 원인 확인 자료이며 보안 감사 대체가 아니다.

후기 Active 입금과 partial-exit에는 현재 전체 종료 경로와 다른 경제적 공격이 생긴다. 각 기능 변경 후 수식·OZ override·가격·bytecode size·ABI 통합을 다시 검토한다. 독립 감사에는 코드/설정/명세/실측/가정/미해결 항목을 함께 제공하며 검토되지 않은 정책을 운영상 관행으로 숨기지 않는다.
