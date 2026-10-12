# Changelog

## 2026-10-11 — 플랫폼 직접 Vault 경로

- 공개 Factory를 사용하지 않는 자산별 Vault 배포·owner bootstrap 스크립트를 추가했다. 기존 업그레이드·자산 회계 계약 bytecode/storage는 변경하지 않았다.
- 기본 FE를 고정 배포 목록 기반 Vault 선택·입출금으로 전환하고 생성 메뉴를 제거했다. 잘못된 manifest·구현 변경·주소 불일치 보호를 유지한다.
- 직접 초기화 권한·중복 금지·원금/활성화 실패 롤백, FE manifest 회귀를 추가했다.
- 사용자 승인으로 “볼트 수익률 비교” 세션과 메시지를 교환해 상품 방향/제안 수치를 구분했다. kHYPE 실제 oracle adapter·갱신 설정을 읽고 상세 문서로 기록했다.
- 실배포·자금 이동은 수행하지 않았다. 검증 수·크기는 STATUS를 따른다.


사용자·운영자·통합 코드에 영향을 주는 완료한 변경을 기록한다. 현재 상태는 [STATUS](docs/STATUS.ko.md), 다음 작업은 [BACKLOG](docs/BACKLOG.ko.md), 설계 이유는 [DECISIONS](docs/DECISIONS.ko.md)가 관리 원본이다.

아직 릴리스하지 않았다. 날짜는 KST 기준 기록일이며 원시 관측 파일의 UTC 수집일과 다를 수 있다. Git 이력이 없는 상태에서 기존 문서·코드·검증 기록을 이관했으므로 과거의 모든 변경 시각을 재구성한 로그는 아니다. 실제 릴리스 전까지 `Unreleased`에 기록하고 임의 버전·커밋·배포 주소를 붙이지 않는다.

## Unreleased

### 2026-10-13 — v6 Unified carry 확장(8x), 입금 탭 지갑 잔액, 공개 저장소 준비

- 운용: owner +20 USDC 입금·Core 16.37 배정 → 숏 3x로 1단계(차입 3.73, 현물 0.24, 숏 +0.23, 공급) → 사용자 결정으로 8x 2단계(차입 12.21, 현물 0.20, 숏 +0.19, 공급) → 청산 거리 확보용 USDC 5 추가 차입. 결과: 공급 HYPE 0.5696, 숏 0.55(8x cross, 청산가 99.75 = +20.2%), 차입 23.94, 차입 쪽 청산까지 −38.6%, NAV 39.23, 헤지/NAV 약 116%. Unified cross 증거금은 USDC만 인정(현물·공급 HYPE는 숏 증거금 아님). `mode_monitor`(unified-v6, 3분) 상시.
- FE: 입금 탭에 지갑 USDC 잔액과 Max(잔액과 Vault 남은 한도 중 작은 값), 잔액 초과 입력 차단. "Now (Unified, live)" 추정에 차입 이자 반영(`estAprNow` borrowedUsd·borrowApr, 시험 추가), "2x" 문구 제거. 거래 진행 표시를 탭 바로 아래로 옮김(실제 지갑 서명 2건으로 단계 확인), Lens 계정 카드(폴링 RPC 11 → 6), 사용자 입출금 내역(로그 조회는 hypurrscan), 공용 RPC의 단일 오류 응답을 묶음 요청 전체로 펼치는 `batchSafeFetch`. FE 197 통과, 배포.
- 공개 준비: BUSL-1.1 `LICENSE`(Licensor HypurrQuant, Change Date 2030-10-13, Change License GPL-2.0-or-later), `src/interfaces`는 MIT, 나머지 Solidity 헤더 BUSL-1.1. `.gitignore`로 모든 `.env`·키·broadcast·`.omc` 제외, 개인 키 11개로 공개 대상 413개 파일 검사(0건), 영어 README 재작성. git init만(커밋 없음).

### 2026-10-13 — Learn 재구성

- 순서: 이용 방법(2×2) → 수익 원리(USDC → 전략 → 지분 가치) → 수수료 → 출금(즉시/요청 카드 2개) → 주요 위험(접이식, 미감사 명시 유지) → FAQ → Advanced details(기술 구조·오라클 평가·PM 목표 구조와 계산·LTV 표·시장 스냅숏·권한·용어집). 수치는 Advanced에만, 코드 계산값 사용. 넓은 표 제거. 목차 이동 시 제목이 고정 헤더 16px 아래. 즉시 출금의 "10분 기록 필요" 문구는 v6(oracle-only)에서 맞지 않아 삭제. FE 187 통과, 배포.

### 2026-10-13 — v6 수동 차입 실측, 랜딩 마무리

- v6 수동 차입(Unified, API wallet `borrowLend`): HYPE 0.129909 공급 → USDC 3 차입(건전성 2.35). 범위 변경 전 NAV는 `ScopeIncomplete`로 거부(fail closed), `scope --blp` 뒤 같은 블록 Multicall3 대조에서 컨트랙트 NAV 19.486148 vs 재계산 19.486147(차이 1 raw). oracle-only 유지.
- FE: 헤더 불투명, 첫 화면 미리보기의 Deposit 버튼 제거(Explore USDC Carry 하나), APR 라벨 "PM strategy estimate"(라이브 값이 없으면 Now 줄 숨김), 랜딩·푸터에서 모니터링 수치·Owner console·"wallet writes on" 제거(문서·Vaults·컨트랙트 링크만, 운영·Owner 링크는 Vault 상세의 Contract and onchain details로), 랜딩·푸터·Learn 상단의 프로토타입/위험 문구 제거(사용자 요청). FE 187 통과, 배포.

### 2026-10-13 — Est. APR을 Portfolio Margin 기준으로

- 사용자 결정("pm 기준으로 넣어줘. 나중에 그렇게 할거니깐"): 카드·랜딩·Vault 목록의 Est. APR은 PM 목표 구조(USDC Carry LTV 60% ~11.1%, HYPE Plus 60% ~4.7%, BTC Plus 40% ~1.8%)로 표시하고 "Portfolio Margin" 표기를 붙인다. 현재 운용(Unified) 추정치는 바로 옆에 "Now, live (Unified)"로 따로 보인다. Vault 상세는 "Est. APR (Portfolio Margin)"과 "Now (Unified, live)" 두 칸. FE 187 통과, 배포.

### 2026-10-13 — v6 메인넷 배포, v4 은퇴, 랜딩 재구성

- v6 `0x6c4556b8068397AD2F3e69205b7C100CAf234883` 배포·검증(19항목), 오라클 범위, 헤지 0.13 HYPE, 가격 기록 없이 `redeemNow` 실측(Lens 미리보기 = 수령 499,128). FE manifest를 v6로, v4·v3는 출금 전용.
- v4 청산·정산·수령(owner 20.66 USDC 회수, 먼지 0.0098 HYPE).
- 운영 도구: `cast send --async` + 영수증 조회(일부 노드가 영수증을 주지 않아 매번 시간 초과하던 문제), `cast` 60초 제한, RPC를 빠른 4개(공용 포함)로, 검증의 코드 대조에서 CBOR 메타데이터 제외.
- FE: 랜딩을 사용자 가치 중심으로 재구성("Put your USDC to work.", 제품 미리보기는 이름·현재 Est. APR·Deposit만, Coming soon 축소, 3단계 흐름, Hyperliquid 통합 한 줄), 헤더 Launch app, 워드마크를 제목 폰트(Newsreader)로 통일.

### 2026-10-12 — 상품 카드 사용자 가치 중심

- 카드: 심볼·상품명·한 줄 가치("Earn yield on your USDC." / "Keep your HYPE. Earn extra yield." / "Keep your BTC. Earn extra yield.")·Est. APR·상태만. LTV·헤지 비율·버퍼는 Strategy details로.
- USDC Carry 카드의 Est. APR은 현재 운용 기준(현재 헤지 비율 × 90일 펀딩, 비용·수수료 후). PM 시나리오 11.1%는 상세 영역에만 "Est. APR, PM scenario"로. 출시 전 상품은 LTV 40% 시나리오(HYPE ~2.2%, BTC ~1.8%). Vault 상세의 Target scenario 지표 칸 제거. FE 187 통과, 배포.

### 2026-10-12 — v6 모듈 분리(미배포)·USDC Carry 운영 도구

- HyperVault v6(ADR-041): Core 관리를 external library `HyperVaultCoreOps`로, 읽기 전용 `HyperVaultLens` 추가. ABI·이벤트·저장소 슬롯은 v5와 같음. HyperVault 21,633 B(여유 2,943). `HV_VERSION=v6` 배포·검증(라이브러리 링크 확인). forge 367, Python 122 통과. 리뷰 2차 APPROVE.
- USDC Carry(HV-006): LTV 확장 계획 도구(dry-run), Unified·PM 모니터링 규칙, 로컬 모니터 2개(v4 Unified, 제3자 PM 관찰). 런북 `docs/hypervault-usdc-carry-runbook.md`.

### 2026-10-12 — FE 타이포그래피·목표 수익률·Core 실이율·RPC 묶음

- 타이포그래피: Newsreader(제목)·Geist(나머지) 2종, 16/24/32px 3종, 400/600 2종만 렌더링(전 페이지·모바일 getComputedStyle 검사 0건 위반). Geist Mono 제거.
- 수익률 표시: "Estimated net APR (90d funding)", "Current funding (annualized)", "Current net yield", 실현 수익을 분리. 목표 수치는 LTV 시나리오 최대값 "Up to"(USDC 11.1%·HYPE 4.7%·BTC 1.8%, LTV 60/60/40%)로 표시하고 LTV 표·가정·공식 LTV 계수·민감도를 펼침에 둔다(`yieldModel.ltvScenario`, 문서 표 전 값 시험 재현).
- Current net yield: Core precompile(0x0801·0x0813·0x0806·0x0807·0x080f·0x0812, NAV source `observeTokens`)로 펀딩·공급·차입 다리를 계산. 펀딩 비율만 Hyperliquid API. 0x0811 직접 호출은 대출 장부 없는 계정에서 오류가 나 멀티콜 전체 가스를 태우므로 쓰지 않는다.
- RPC: 모든 읽기를 Multicall3 aggregate3 한 번으로(Vault 페이지 폴링 3~4회 → 1회), 블록 번호·시각도 같은 묶음에서 읽음.
- 푸터 하단 고정, Vault 목록의 가정 문구를 펼침 안으로. Learn의 "1,000 USDC" 한도 문구는 계약 값 기준 표현으로.
- FE 186 통과, 빌드 통과, Vercel 배포.

### 2026-10-12 — v5 예치 한도 100,000 USDC

- 사용자 요청으로 다음 Vault(v5)의 `maximumAssets`를 100,000 USDC로 설정(`roundtrip.py` VAULT_PARAMS). 불변값이라 v4(1,000 USDC)는 바뀌지 않는다.

### 2026-10-12 — 오라클 평가 (ADR-040, 미배포)

- `HyperVaultNavSource`: 토큰별 `perpOracle` 모드. 헤지된 현물은 perp 오라클 가격, 해당 숏은 DEX 0 equity를 mark에서 같은 오라클로 보정해 한 가격으로 평가한다. 현물 호가·mark 움직임이 NAV에 영향을 주지 않는다. `CoreRead.perpAssetInfo`(0x080a) 추가.
- `HyperVault.redeemNow`: 창 안 가격 기록 요구 제거(기록이 있으면 여전히 최저값을 상한으로 사용).
- 운영 도구 `HV_VERSION=v5`(새 범위 형식). 메인넷 배포 전.

### 2026-10-12 — FE 금융 앱형 디자인 정리

- Vault 상세: 좌측 핵심 지표(Est. APR now·NAV·지분 가격·PM target APR, 갱신 시각/Stale), 우측 고정 카드 하나에 내 자산과 Deposit/Withdraw 탭(예상 지분·최소 입금·수수료·슬리피지, 비활성 사유, 즉시 출금·요청·claim), 거래 단계 표시(서명 대기→전송→확정→반영). 운영자 도구는 owner 지갑일 때만.
- 전략 도식 `StrategyFlow`(USDC → HYPE Spot ⇄ HYPE Short → APR, Hyperliquid 공식 코인 아이콘 로컬 제공, Now/PM target 전환, 자기자본·차입 막대, Strategy details 접기). 세 APR(현재 추정·PM 목표·실현)을 분리(`aprNow.ts`, 시험 3개).
- 구역별 스켈레톤·오류·재시도, 데이터 적을 때 차트 대신 안내, 홈 CTA `Open USDC Vault`, HYPE/BTC는 작은 Coming soon 행, Ops 요약 우선·AI 요약 상태 분리, Learn 수수료/출금 표를 즉시 출금 반영으로 수정, Owner 실행 순서 패널. 성공 알림은 4초 뒤 사라짐.
- FE 178 통과, `tsc`·빌드 통과, 1440/1920/390에서 미연결·연결(목 지갑)·실패(fetch 차단 스크립트)·은퇴 v3 확인. 실제 서명 거래와 다크 모드는 화면으로 확인하지 않았다.

### 2026-10-12 — HyperVault v4 (즉시 출금) 배포, v3 은퇴

- 새 Vault v4 `0xf9c05bf416F6E45bf3658A92C94fE4f8f03a6b4F`를 배포했다(v3 구조 + `redeemNow`, ADR-039). 운용 중에도 EVM 버퍼 범위 안의 출금은 같은 트랜잭션에서 지급된다(0.1% 수수료, 창 안 가격 기록 필수). 메인넷에서 1 USDC 실측.
- v3는 헤지 해제·정산 후 은퇴했다. FE manifest는 v4를 기본 Vault로, v3를 `retired`(입금 차단, 출금만)로 둔다. `DirectVault.retired` 필드 추가.
- 운영 도구: HyperEVM RPC를 서드파티 5개로 순환(공개 RPC는 FE 전용, sentio는 precompile 호출에 잘못된 응답을 줘 제외), urllib User-Agent 지정(일부 WAF 403), 쓰기 재시도는 nonce 고정. `HV_VERSION=v4` 지원, monitor 기본값 v4, v4의 `price-history` 규칙은 실제 기록 나이로 판정. `strategy.py --reserve-usdc` 추가.
- 새 API wallet agent5(키는 `~/.config/hypervault`, mode 600). keeper에 가스 0.04 HYPE 보충.

### 2026-10-12 — FE 제품형 재디자인

- 홈을 랜딩으로 재작성(히어로·온체인 실시간 카드·상품 3종·수익 시나리오·증거·위험), 상단 메뉴를 Vaults/Learn/Evidence/Operations로 정리하고 Strategy·Owner console은 footer로 옮겼다.
- 상품 카드: USDC Carry(라이브, 추정 ~5.3%), HYPE Plus(~1.3%)·BTC Plus(~0.7%)는 **Coming soon**(미배포, 입금 불가). 추정치는 `frontend/src/products.ts`가 2026-10-12 시장 스냅샷(`marketSnapshot.ts`)과 `yieldModel.ts`로 계산하며 약속이 아니다. HYPE/BTC는 Portfolio Margin 가정.
- Vault 상세: 핵심 지표 띠, 우측 고정 카드에 **Your position**(보유 지분·가치·Vault 내 비율·정산 대기·claim 가능)과 입출금. 계약 세부는 접기 안으로.
- 디자인 토큰(다크/라이트), Geist·Geist Mono 자체 호스팅(`font-src 'self'` 유지), Phosphor 아이콘. 모바일 375에서 가로 스크롤 없음. Docs의 시장 수치를 공용 스냅샷으로 통일(30일 펀딩 9.61%, 공급 3.49%).
- 사용자 피드백("글씨가 너무 많아")으로 문구 축소: 상품 카드는 이름·한 줄·추정 APR·버튼만(근거는 APR hover), 홈 사실·증거·위험은 제목만, Vault 상세의 도식·금리·수익 설명 단축. 자세한 설명은 Learn에 남김.
- 사용자 요청으로 Evidence 화면(`#/evidence`)을 제거했다(메뉴·footer·라우트·홈 카드). 홈 증거 칸은 HyperEVMScan 계약 링크로 바꿨다. 원시 `public/hypervault/evidence*.json`과 문서의 증거 기록은 유지한다.
- USDC Carry 추정 APR을 Portfolio Margin 전제로 변경: 버퍼 10%·현물 90%가 short 담보, ~5.3% → **~8.0%**(90일 펀딩 10.05%, 비용·수수료 후 7.95%). `yieldModel.usdcCarry`에 `portfolioMargin` 추가(FE 159 통과). PM은 Core 계정 $10k 이상 조건이라 현재 상한 1,000 USDC에서는 적용되지 않는다(Learn·가이드에 명시).
- minimalist-ui 적용: 웜 모노크롬(라이트 기본·다크 시스템 설정), 제목 Newsreader 세리프(`@fontsource-variable/newsreader@5.3.0` 자체 호스팅), 잉크색 버튼, 파스텔 상태 태그, 그라디언트·큰 그림자 제거, 상품 bento(라이브 카드 크게·준비 중 2개 세로), IntersectionObserver 스크롤 등장(`src/reveal.ts`, 감소 모션 시 비활성).
- 추정 APR을 Portfolio Margin 차입 루프 모델(`yieldModel.pmLoop`, 공식 문서 기준 LTV·청산선·금리식)로 교체: USDC Carry ~8.7%(헤지 135%·차입 72%·HYPE +167%에서 청산), HYPE Plus ~2.4%(추가 70%·HYPE −80%), BTC Plus ~1.0%(추가 50%·BTC −84%). perp 개시 증거금 차입 이자를 반영해 이전 ~8.0%(무차입) 추정은 7.1%로 정정됐다. 펀딩 0%에서 −3.9%, −10%에서 −17.4%로 손실도 커진다(Learn·가이드 명시). FE 161 통과.
- 모션: 히어로 단어 순차 등장, APR 카운트업(`src/motion.tsx`, DOM 직접 갱신), Live 점멸, 온체인 값 갱신 반짝임, 버튼 화살표, Vault 상세 순차 등장. 감소 모션 시 전부 정지.
- **v3 run 3 (메인넷 운용 시딩):** owner 22 USDC 입금 → Core 19.784 배정(EVM 버퍼 2.216) → Unified 전환 → 새 API wallet agent4 승인 → 전략 실행: 현물 0.12 HYPE @87.514 매수, 체결 수량 0.12 perp short @87.576(2배). verifier NAV 22.147331 ≈ API 22.145, monitor 15규칙 ok, short 청산가 157. PM 아님(계정 <$10k). 이전 실행 잔여 0.155 USDC 상당이 첫 입금 뒤 이익으로 잡혀 수수료 지분 약 0.0146 USDC가 발행됐다. Vault 화면 APR은 'Target APR(At $10k+ with Portfolio Margin)'로 표기.
- 'Capacity left'를 홈 Live 카드와 Vault 지표에서 제거.
- 전략 runner 헤지 수량: short를 주문 체결량이 아니라 체결 뒤 실제 현물 잔고(HYPE로 낸 수수료·기존 잔고 포함) − 의도적 비헤지분을 0.01 HYPE 단위로 반올림해 맞춘다(`strategy.hedge_size`, `MATCH_SPOT_BALANCE`). Python 106 OK. Vault 화면에 현물/short/차이를 HYPE 수량으로 표시. run 3 현재 차이 +0.00168847 HYPE(기존 잔고 0.00177246 − 매수 수수료 0.00008399)는 최소 주문 단위 0.01 HYPE와 perp 최소 10 USDC보다 작아 조정 불가.
- 브랜드 로고 적용: `public/brand/hypervault-logo.png`에서 워드마크(`logo-wordmark.png`)·마크·favicon·apple-touch-icon 생성, 다크 모드는 밝게 반전.
- 지갑 체인 전환: 연결 시 다른 체인이면 `wallet_switchEthereumChain`, 지갑에 HyperEVM이 없으면(4902) `wallet_addEthereumChain`(공개 RPC·hyperevmscan) 후 다시 전환(`network.ensureChain`, 시험 6개). Vault 화면 Switch network도 같은 경로. 체인 변경 이벤트는 같은 체인·계정이면 연결 유지, HyperEVM을 떠나면 영어 안내와 함께 연결 해제. 이전에는 다른 체인에서 Connect 시 오류만 표시되고 전환 경로가 없었다. 모의 EIP-1193 지갑으로 배포본에서 추가→전환→연결, 이탈→해제, 재연결 확인. FE 167.
- 입금 슬리피지: FE `depositWithLimit`/`depositHype`의 최소 지분을 견적과 정확히 같게 두던 것을 견적 × 0.99로 변경(`src/slippage.ts`, 시험 3개, 사용자 결정). Active Vault는 NAV가 블록마다 미세하게 움직여 승인~입금 사이에 대부분 되돌려질 수 있었다. 계약의 급등 방어(_room)와 5분 마감은 그대로다. FE 170.
- FE 읽기를 Multicall3(`0xcA11…CA11`, HyperEVM 메인넷·테스트넷 배포 확인)로 묶음: 같은 시점·같은 블록의 `readContract`가 aggregate3(allowFailure) 한 번으로 나간다(Anvil은 개별 요청 유지). Vault 화면 첫 로드 RPC POST 30 → 3. 무거운 NAV 읽기 20개(~4.3M gas)도 한 eth_call에서 성공함을 확인. 홈·Vault·Operations·지갑 연결 후 Your position 값 동일.
- run 3 추가: 두 번째 입금자 0xabf2…37d3가 FE로 10 USDC 입금(9.9377 hvUSDC). 새 헤지 쌍은 최소 주문 10 USDC 때문에 약 15.8 USDC가 필요해 열지 않고, 버퍼 10%를 남긴 9 USDC를 Core 증거금으로 배정(사용자 결정). short 청산가 157 → 228.
- Vault 화면 밀도 개선(디자인 리뷰 반영): 제목 영역 압축·보기 탭을 제목 줄로, 지표 띠를 왼쪽 열로 옮겨 첫 화면에 내 포지션·입금 표시. Your position과 입출금을 하나의 고정 카드로 합치고 Deposit/Withdraw 탭, 운영 버튼(Read status·Confirm pending·Record price·Revoke approval·Owner actions)은 'Operator tools'로 접음. 금액은 2자리·지분 4자리, 정확한 값은 툴팁. 숫자는 산세리프 tabular(제목만 세리프). APR은 실제 헤지 비중 기반 'Est. APR now'(현재 ~2.9%, NAV의 33% 헤지)와 점선 'Target ~8.7% with Portfolio Margin'으로 분리, How it works·목표 배분 막대에 Target 표시.
- FE: 미연결 계정 카드에 Connect wallet 버튼, 보조 글씨 대비 강화(--muted 진하게), 포지션·표 숫자 자릿수 정리(수량 4자리·가격 2자리, 정확한 값은 툴팁).
- **계약(미배포): `HyperVault.redeemNow`** — 운용 중 버퍼 현금으로 즉시 출금, 보수적 가격·창 안 기록 필수·0.1% 출금 수수료(Vault 귀속)·operator 권한·마지막 보유자는 회차 경로(ADR-039). 리뷰 1차 REQUEST CHANGES → 수정 → 2차 APPROVE(코드). forge 350 passed, Python 106 OK, 크기 24,283 bytes(여유 293), 저장소 레이아웃 보존. FE Withdraw 탭: 구현에 셀렉터가 있으면 '즉시 출금'(한도·수수료 표시, 기록 없으면 '가격 기록' 버튼), 없으면 기존 요청 경로. 현 v3 메인넷에는 아직 적용되지 않아 화면은 기존과 같다. FE 175.
- 계약·ABI 변경 없음. Vercel 재배포(`vault.hypurrquant.com`).

### 2026-10-12 — 운영 갭 보강·사용자 문서·수익/위험 분석

- **Deploy:** `https://vault.hypurrquant.com` 연결(Vercel 프로젝트 도메인을 API로 추가, 사용자가 Cloudflare에 `_vercel` TXT와 DNS-only CNAME 설정, 인증서 발급·6개 화면·보안 헤더 확인). 사용자 가이드 `docs/hypervault-user-guide.ko.md`.

- **Analysis:** 다른 Vault 플랫폼(Veda, Lagoon, Morpho, Yearn v3, HL vaults/HLP, kHYPE, Ethena) 기능과 비교한 [운영 갭 분석](docs/hypervault-operations-gap.md). HYPE 펀딩 90일 평균 10.05%·음수 시간 8.9%·최악 7일 4.33%, 기본 수수료로 USDC Vault 예시 순 APR 5.30%(90일 평균) ~ 2.21%(최악 7일) ~ 음수(펀딩 음수).
- **Monitor (15규칙):** `funding`을 현재·24시간·7일 평균으로(헤지 중 24h 음수 경고, 7d 음수 경보), `redeem-sla`(Active 출금 요청 대기 24h 경고·72h 경보), NAV·지분 가격 이력 `nav-history.json` 게시와 원장 스냅샷 백필(`--backfill-ledger`), 경보 웹훅 `HV_ALERT_WEBHOOK`(Slack/Discord). Python 시험 3 추가.
- **FE:** Vault 화면에 "How the position is built" 도식(입금 → HyperEVM 현금 버퍼 → Core 현물 HYPE ⇄ 같은 크기 perp short → 펀딩 → NAV)과 목표 배분(버퍼 10%·현물 60%·증거금 30%) 대 현재 배분 막대, 미헤지 HYPE 노출 표시. FE 시험 1 추가.
- **FE:** `#/docs`(Learn) 사용자 문서 — 동작 방식, 수익원과 계산 예시(`yieldModel.ts`), 수수료, 출금 시점, 위험 표, 역할, 용어, FAQ. Vault 화면에 지분 가격 차트와 실현 수익(30일 이상일 때만 연환산). FE 시험 6 추가.

### 2026-10-12 — HyperVault v3: owner 신뢰 NAV 모듈

- **Decision / ADR-038:** 사용자 결정으로 범위 밖 신고(`reportToken`/`OpenReport`)와 급락 대기·가격 이력 필수 조건을 제거. 새 `HyperVaultNavSource`·`HyperVaultNavVerifier`(v1 모듈은 변경 없음). 가격 기록은 수수료의 보수적 가격용으로 선택 사항.
- **Mainnet:** v2 계약 + 새 모듈로 v3 USDC Vault 배포·검증, 왕복 1회(이력 없는 Active 입금, 즉시 정산). 원시 자료 `docs/reference/hypervault-v3-mainnet-2026-10-12/`.
- **Deploy/Tools:** `DeployHyperVault.s.sol`이 source/verifier도 배포(`HV_RECALL_TIMEOUT`·`HV_IDLE_DUST`·`HV_PRICE_WINDOW`). `roundtrip.py`의 `HV_VERSION=v3`.
- **Tests:** `test/HyperVaultNav.t.sol` 5(실 모듈 통합).
- **FE:** manifest를 v3로 교체, 증거 화면 v3/v2/v1, 홈 문구. Vercel 재배포.
- **Monitor:** 14규칙. `blp-health`(수동 차입 health factor·청산 사용률, 문서 공식, 경고 ≥0.70·경보 ≥0.85 또는 HF<1.05), `borrow`는 PM 밖 차입을 이상으로 보지 않음, `nav-ledger`의 API 자산에 BLP 공급·차입 포함, 기본 감시 대상 v3, v3에서 가격 기록 없음은 정상. Python 시험 3 추가.
- **FE:** Vault 화면에 HyperCore 실시간 포지션(현물·perp·대출, health), 거래 내역(체결 50건·펀딩·전송/대출 30일, 탐색기 링크), 시장 금리(HYPE 펀딩·USDC 차입/공급 APR·LTV, Vault 수익 아님)와 Vault 누적 지분 가격 변화(APR은 30일 미만이라 미표시) 추가. 지분 0일 때 지분 가격을 표시하지 않음(가상 offset 왜곡). FE 시험 4 추가.
- **BLP:** `roundtrip.py blp`(API wallet 서명 `borrowLend` supply/borrow/repay/withdraw), `scope --blp`. v3 run 2에서 수동 차입 왕복과 NAV 대조 성공. 버퍼 계획이 Idle 상태의 지난 epoch 요청을 대기 출금으로 세던 오류 수정.

### 2026-10-12 — HyperVault v2 (kHYPE식 분리, 양도 가능 지분, high-water mark 수수료)

- **Decision / ADR-037:** 지분 토큰(`HyperVaultShare`)·매니저(`HyperVault`, Core 계정)·어카운턴트(`HyperVaultAccountant`) 분리. Vault 단위 HWM 성과 수수료(새 지분 발행, owner 80%/treasury 20%), 창 최저 기록으로 제한한 보수적 가격, 무revert `convertTo*`/`totalAssets`, controller/operator 출금 요청과 같은 epoch 합침. v1 계약은 변경하지 않았다.
- **Contracts:** `src/hypervault/*`, `script/DeployHyperVault.s.sol`, 시험 `test/HyperVault.t.sol` 20(기부·인플레이션 방어 포함). 리뷰 F1(타인 controller dust 요청)·F2(지연 수수료를 입금자가 부담) 수정.
- **Mainnet:** v2 USDC Vault 배포·검증, 왕복 1회(합성 이익으로 수수료 과금 시연, 명시). 원시 자료 `docs/reference/hypervault-v2-mainnet-2026-10-12/`.
- **Tools:** `roundtrip.py`의 `HV_VERSION=v2`, `checkpoint`, `share-transfer`, `scope --usdc-only`; cast 다중 JSON 출력 파싱과 RPC rate limit 재시도 수정.
- **FE:** v2 manifest(share·accountant), HWM·rate·share 표시와 수수료 문구, 증거 화면 v2/v1, v1 Vault 입금 화면 제외. Vercel 재배포.
- **Docs:** 구조 문서 v2 기준 재작성, 표준 대조 v2 절.

### 2026-10-12 — HyperVault 메인넷 통제 왕복과 운영 도구

- **Decision / ADR-035:** HyperVault 해커톤 범위. USDC Vault 1개를 owner 자기 소액 자금으로 메인넷 배포(seed 100 USD 정책 예외, 사용자 승인). 계약 코드는 변경하지 않았다.
- **Tools:** `scripts/hypervault/` — 단계별 왕복 runner(전후 스냅샷 원장, evidence JSON), USDC 전략 v0 runner(dry-run 기본, 체결 수량 헤지, 주문 상태 분류), 12규칙 monitor·전용 키 keeper·advisory AI 요약, PM 비교표. SDK 0.21의 spot meta 인덱스 가정 우회.
- **Mainnet:** 배포 7건과 왕복 2회(활성화·배정·agent 주문·헤지·펀딩·청산·회수·정산·claim). PM 전환 미적용 관측. 원시 자료 `docs/reference/hypervault-mainnet-2026-10-12/`.
- **FE:** HyperVault 영문 화면(`#/`, `#/vaults`, `#/evidence`, `#/ops`, `#/strategy`), 직접 Vault 주문 화면 연결, 실 Vault manifest(`.env.production`), Vercel 설정(배포 안 함). 기존 Factory 화면은 `VITE_LEGACY_FACTORY_UI`일 때만.
- **Run 3:** Active 중 NAV 기준 지분 발행, ERC-7540 pending→claimable, Idle 동일 거래 출금을 메인넷에서 확인. ManagedAssetVault의 ERC-7540/4626/7575 대조를 [표준 검토](docs/standards-review.ko.md#managed-asset-vault)에 추가.
- **Docs / ADR-036:** 영문 [구조 문서](docs/hypervault-architecture.md). 유동성 버퍼는 운영 정책(`roundtrip.py buffer`, `allocate auto`, 감시 규칙 `buffer`)으로 채택하고 버퍼 기반 즉시 부분 출금은 제안으로 둠. 계약 변경 없음.
- **FE:** Vercel 배포 `https://hypervault-plum.vercel.app`, 입금 경고, 지갑·RPC 오류 영문화.
- **Tests:** Python HyperVault 단위 시험 11, FE 시험 추가. 수치는 [STATUS](docs/STATUS.ko.md#hypervault).


### 2026-10-11 — 자산별 Vault와 즉시 발행·별도 Core 배정

- **Decision / ADR-033:** 사용자 선택에 따라 USDC/HYPE/UBTC 중 하나를 기준 자산으로 생성하는 새 Vault를 구현했다. 선택 자산 수령 시 원금 지분을 즉시 발행하고, 별도 USDC 활성화와 owner 배정 큐를 분리한다. 이미 활성화된 Core 주소를 허용한다.
- **Contracts:** 신규 ManagedAssetVault/Factory, stateless delegatecall ManagedAssetBridge, 기준 자산 환산 ManagedAssetNavVerifier, Factory가 배포하는 native ManagedHypeRouter. 같은 proxy/Core 주소, 고정 owner, ERC-7540 출금·원가·성과수수료·platform 20%와 48시간 upgrade 정책을 유지한다. 기존 ManagedUsdcVault의 storage-compatible migration은 아니다. 기존 ManagedRedeem의 symbol getter만 view/virtual로 확장했고 기존 저장소는 바꾸지 않았다.
- **Accounting:** USDC는 Circle, HYPE는 unwrap/native system, UBTC는 linked ERC20 system으로 전송한다. 실제 EVM 수령/차감과 자산별 decimals를 확인하고 Core 변환 잔량은 거부한다. raw Core USDC18 순가치를 같은 reserve 가격으로 기준 자산 단위 환산하며 등록 범위의 기준 자산 가격 방식도 일치시킨다. 출금 준비금은 큐 실행에서 제외한다.
- **FE:** 새 `#/assets`, 별도 Factory 설정, 기준 자산 선택·생성·기본 입출금·배정/회수/agent/정산·기본 scope·가격 기록. HYPE native 거래 value 지원, Factory에 기록된 자산·controller·원래 구현·Router로 승인 대상 확인. 기존 USDC 주문·채팅 화면을 새 Factory에 연결한 것은 아니다.
- **Tools / evidence:** 새 Factory 배포 script와 읽기 전용 metadata preflight. 초기 HYPE 일반 ERC20 decimals 판정 실패와 native 예외를 반영한 재관측을 별도 원시 파일로 보존했다. 실제 계정 활성화·송금·주문·배포는 수행하지 않았다.
- **Verification:** 자산별 입출금·활성화 비용·회수·준비금·수수료·업그레이드, 실제 source/verifier에 mock raw read를 연결한 NAV 회귀, FE의 단위 입력과 브라우저 가짜 응답 확인. 실행 결과·크기는 [STATUS](docs/STATUS.ko.md), 남은 네트워크/출시 조건은 [ASSET-001](docs/BACKLOG.ko.md#asset-001), 세부 동작은 [신규 명세](docs/managed-asset-vault.ko.md)에 기록한다.


### 2026-10-06 — 현행 구조 대조와 로컬 gate 재검증

- **Review:** 공용 precompile source/verifier와 Vault의 연결, 단일 raw 장부 평가식, 신고·급락 대기, FE의 agent 주문과 별도 대화 서버를 코드에서 확인했다. 등록 범위 신뢰·Core 성공 추정·HIP-4 미지원·감시 봇 미운영 경계를 유지한다.
- **Verification:** Managed/FE/server의 로컬 gate, 빌드 크기·storage 검사를 재실행했다. 결과와 환경 재시도는 [STATUS](docs/STATUS.ko.md#마지막-코드-검증)에 기록했다. 제품 코드·ABI·배포 설정·원시 관측 자료는 변경하지 않았다. 실제 네트워크 거래·독립 감사는 아니다.

### 2026-10-05 — 볼트 탐색·운용자 주문·대화 화면과 대화 서버

- **Decision / ADR-031·032:** 사용자 요청("볼트를 만들고, 다른 유저의 볼트도 보고, 볼트 배포자가 주문도 넣을 수 있는 FE"와 "볼트 배포자와 유저가 대화할 수 있는 장소")으로 추가했다. 운용자 주문은 브라우저에 암호화해 둔 Vault 전용 agent 키로 서명하고([ADR-031](docs/DECISIONS.ko.md#adr-031)), 대화는 지갑 서명으로 로그인하는 별도 서버에 둔다([ADR-032](docs/DECISIONS.ko.md#adr-032)). 키 보관 방식과 대화 정책의 세부 값은 구현자 기본값이며 사용자 확정 대기다.
- **FE:** 화면을 볼트 탐색, 볼트 만들기, 볼트별 화면(입금·출금·대화·운용·거래·평가 범위·기록)으로 다시 구성했다. 볼트 목록은 indexer 없이 Factory의 `vaultCount`와 deployer의 CREATE nonce 규칙으로 계산해 `isVault`로 확인한다. 평가 범위 화면에서 운용자가 범위와 입금 스위치를 편집하고 누구나 가격을 기록하며 신고 목록을 본다. 입금이 닫혀 있으면 계약이 되돌린 오류를 사유로 보여 준다. 데모 모드는 지갑·네트워크 없이 예시 볼트로 같은 흐름을 보여 주는 손으로 옮긴 모형이다.
- **Trading:** Hyperliquid L1 action 서명(msgpack + EIP-712 Agent)을 직접 구현해 공식 Python SDK의 벡터와 대조했다. 운용자는 브라우저에서 agent 키를 만들고(PBKDF2-SHA256 600,000회 + AES-GCM-256, 암호 12자 이상) `setApiWallet`으로 등록한 뒤, 등록 범위 안의 perp·spot 시장에 지정가·Post-only·즉시 체결 주문과 취소를 낸다. 주문 전송은 `VITE_ENABLE_TRADING`으로 따로 켜며 기본은 서명 없는 미리보기다. 모든 action은 서명 시각에서 60초 뒤 만료되고, 응답을 받지 못한 요청은 결과 불명으로 표시하며 다시 보내지 않는다.
- **Chat server:** `server/`에 Vault 주소별 대화방 서버를 추가했다(Node 22 내장 모듈 + viem, SQLite). EIP-712 서명 한 번으로 로그인하고(서버의 `CHAT_AUDIENCE`에 묶임) 서명 시각부터 12시간인 토큰을 받는다. 역할(운용자·예치자·방문자)은 서버가 체인에서 읽고, 기본 정책은 누구나 읽고 운용자·예치자만 쓴다. 운용자와 관리자 주소가 글을 숨길 수 있다.
- **Upgraded vaults:** Vault는 업그레이드할 수 있는 proxy이고 업그레이드 뒤에도 `isVault`가 참이므로, FE는 Vault가 스스로 답하는 asset·controller를 믿지 않는다. 승인 대상 token은 Factory의 asset이고, 코드가 생성 당시와 같은지는 deployer가 그 Vault를 위해 만든 controller의 `implementation()`으로 판단한다. 코드가 바뀐 Vault에는 경고를 띄우고 입금과 승인을 막으며(출금 요청과 청구는 유지), 제안된 업그레이드는 실행 가능 시각과 함께 알린다.
- **Security review:** 별도 컨텍스트의 보안 리뷰를 FE의 서명·체인 읽기 코드와 대화 서버에 받아 반영했다. FE: 위 업그레이드 대응, 교체·취소된 거래를 성공으로 보지 않음, 조회 실패를 "평가 없음"으로 바꾸지 않음, 한 Vault의 조회 실패가 목록 전체를 막지 않음, 주문 만료를 nonce가 아닌 시계 기준으로, 요청 20초 timeout, slippage 가격을 입력한 한도 안쪽으로 절삭, 저장된 키 기록의 형식 검증, 잠금 해제된 키의 10분 무동작 자동 잠금, mid에서 1% 넘게 벗어난 지정가의 추가 확인, production build의 Content-Security-Policy. 2차 리뷰(화면 코드)에서 나온 것도 반영했다: 주문 확인 버튼을 두 번 누르면 확인 상자의 전송 버튼이 눌리던 문제(high. 상자가 뜬 뒤 0.7초 동안 클릭을 받지 않고 버튼 위치도 겹치지 않게 함), 범위 조회가 낡으면 취소조차 못 하던 문제(취소와 reduce-only는 열린 키만 있으면 가능), 실패한 입금이 남긴 USDC 승인이 보이지 않던 문제(잔여 승인 표시와 취소, 정확한 금액만 승인), 코드가 바뀐 Vault가 revert 문구로 경고를 지우고 자기 문장을 화면에 올리던 문제(controller를 따로 먼저 읽고, 그런 Vault의 문구는 표시하지 않음), 확인 상자의 30초 수명과 늦게 끝난 검토의 무효화, 조회 실패한 정상 Vault를 "읽을 수 없는 볼트"로 표시하던 것, 이름 길이 제한, 정책이 잘못되거나 빠진 채 build될 수 있던 것과 다른 origin의 frame 안 실행, 목록 카드의 전체 주소 표시, API wallet 등록의 확인 단계, build가 Factory를 지정하면 화면에서 바꿀 수 없게 한 것, RPC 요청 수 축소. 서버: revert 문구로 로그를 꾸미거나 채우지 못하게 한 줄·길이 제한과 실패 캐시, 로그인 시각 허용 범위 축소, 토큰 MAC에 audience 포함, 단조 시계, 운용자 역할을 호출마다 재확인, 폭 없는 문자·방향 제어 문자·과도한 줄바꿈 거부, 서명 검증 속도 제한. 서버의 RPC client는 viem의 transport 대신 자체 구현으로 바꿨다(응답 전체에 4초 제한, `Retry-After`를 기다리지 않음, 8 KB 초과 응답을 읽지 않음, 자격 증명을 URL이 아닌 header로). Vault의 실패로 기억하는 것은 노드가 revert로 알려 준 경우(error code 3)와 답이 아닌 반환값뿐이고, RPC의 실패는 기억하지 않는다. 동시에 나가 있는 조회는 Vault당 8건·전체 32건으로 제한하고 일부를 로그인한 요청 몫으로 남긴다(초과분은 `503 CHAIN_BUSY`). 결합 부호는 연속 4개까지만 받는다.
- **Testing:** FE와 서버의 단위 시험, 서명 벡터 대조, 데모 모드와 주입한 RPC 응답에 대한 브라우저 확인. 수치는 [STATUS](docs/STATUS.ko.md)에 있다. Managed Vault 시험에 FE가 쓰는 주소 규칙(controller·첫 구현·proxy가 deployer nonce `3i`·`3i+1`·`3i+2`)을 고정하는 검사를 넣었다.
- **ABI 영향:** 없음. 컨트랙트는 바꾸지 않았다. FE가 source·verifier·upgrade controller의 ABI를 추가로 내보낸다.
- **Known limits:** 실제 지갑 서명, 실제 체인 쓰기, 실제 주문 전송은 한 번도 하지 않았고 서버는 배포하지 않았다. 컨트랙트 계정의 agent로 낸 주문이 Vault에 귀속되는지, 거래소 응답·오류 형식, builder 필드가 붙은 주문의 fee는 확인하지 못했다([MARKET-002](docs/BACKLOG.ko.md#market-002)). agent 키는 출금은 못 하지만 거래는 할 수 있어, 페이지에 주입된 스크립트가 잠금 해제된 키를 쓰면 불리한 거래로 Vault 가치를 뺄 수 있다. controller가 업그레이드 횟수를 기록하지 않아, 다른 구현으로 바꿨다가 처음 구현으로 되돌린 Vault는 FE에 변경 없음으로 보인다([UPGRADE-001](docs/BACKLOG.ko.md#upgrade-001)). 대화 서버의 호스팅·백업·개인정보 고지·스팸 대응은 정해지지 않았다([CHAT-001](docs/BACKLOG.ko.md#chat-001)).

### 2026-10-05 — 미등록 보유 신고·급락 대기와 감시 스크립트

- **Decision / ADR-029·030:** 사용자가 [구조 비교안](docs/managed-scope-enforcement-options.ko.md)에서 "A 먼저, B는 나중에"를 선택했다. 현행 구조(API 직접 매매, Vault 불변)에 신고 차단과 급락 대기를 추가하고, 주문을 Vault 함수로만 제출하는 구조는 나중에 별도 Vault 유형으로 검토한다. builder fee의 절반을 Vault 배포자에게 오프체인으로 돌려준다는 사용자 결정을 [ADR-030](docs/DECISIONS.ko.md#adr-030)에 기록했다(컨트랙트 변경 없음, 정산 미구현).
- **Reports:** `HyperCorePrecompileSource`에 `reportToken`·`reportDex`·`reportCoreVault`·`clearReport`·`reports`를 추가했다. 누구나 범위 밖 대상을 지목하면 계약이 직접 읽어, 차입·포지션이 있거나 팔 수 있는 보유(온전한 lot을 최우선 매수호가로 평가해 주문 최소 금액 이상, quote token을 거치면 두 단계 모두)가 있을 때 신고가 성립한다. `evaluate`와 `exposure`는 평가마다 신고된 대상을 다시 읽어 **지금도 성립하는 동안에만** `OpenReport`로 거부하므로, 그동안 발행과 종료 정산이 닫히고 owner가 그 보유를 정리하면 바로 열린다(등록으로 풀면 새 가격 기록이 반 창을 채운 뒤 열린다). Vault당 1건만 보관하며 **성립하는 신고는 자리를 지킨다.** 그동안 다른 대상의 신고는 `NotReportable`로 거부되고, 같은 대상의 재신고는 기한만 늘리며 보관된 증명 경로를 바꾸지 않는다. 소멸했거나 더는 성립하지 않는 신고는 새 증명에 자리를 내준다. 1일 뒤 소멸하므로 같은 대상을 다시 신고해 갱신한다. owner가 신고된 대상을 `configure`로 등록해 그 신고가 더 성립하지 않게 되면 신고는 목록에서 빠지고, 그 `configure` 직전까지 성립하던 신고였다면 그 시각이 `reportAnsweredAt`에 남는다. 등록된 token도 차입이 없고 등록된 USDC pair가 그 보유를 주문 최소 금액 이상으로 사 주지 않는 동안에는 신고할 수 있으며(다른 pair에서 최소 금액의 두 배 이상에 팔 수 있을 때), 그런 신고는 owner가 그 token을 등록해도 목록에 남는다. `reportAnsweredAt`은 `configure`가 그 직전까지 성립하던 신고를 풀었을 때만 기록된다. 등록된 DEX·HyperCore vault와 USDC는 신고할 수 없다.
- **Drawdown cooldown:** `ManagedPortfolioNavVerifier`에 `recordPrice`·`priceRecords`·`nav`와 생성자 인자 `priceWindow`(10분~1일)·`maxDrawdownBps`(10~2,000)를 추가했다. `verifyNav`는 창 안의 기록이 창의 절반 이상을 덮지 못하면 `PriceHistoryTooShort`, 현재 지분 가격이 창 안 최고 기록보다 한도 넘게 낮으면 `PriceDropCooldown`으로 거부한다. `verifyIdle`도 정산으로 지급될 현금 기준 가격에 같은 두 조건을 적용한다(지분이 없는 Vault의 종료는 예외). 기록 간격 안에서는 더 높은 가격만 직전 기록을 대체하고, 지분이 없으면 기록하지 않는다(`NoShares`). 기록은 새 조회 `scopeValue`(입금 스위치와 신고를 보지 않는 등록 범위 평가)로 읽으므로 스위치나 신고로 멈추지 않고, 관리 액션이 pending이어도 계속된다. Idle에서는 Vault가 발행에 쓰는 현금 기준 가격을 기록한다. 신고가 등록으로 답해진 뒤에는 `reportAnsweredAt`보다 뒤에 만든 기록만 이력(반 창 요건)으로 세고, 그 전의 기록은 최고 가격의 기준으로만 남는다.
- **Exit valuation:** 종료 평가(`exposure`)가 등록 token을 아직 팔 수 있는 가치(온전한 lot, 최우선 매수호가, 10 USDC 이상)로만 세고 가격 가드를 쓰지 않는다. 종료 중 제3자가 보낸 등록 token 1 lot이나 호가 상태가 종료 평가를 막던 문제를 해소한다(정산에 필요한 가격 기록은 여전히 호가 상태에 묶인다). 같은 기준으로 팔 수 없는 잔량만 남은 token은 범위에서 뺄 수 있다. 발행 평가에서는 차입이 없고 1 lot 미만인 보유의 가격이 거부돼도 0으로 넘어간다.
- **Idle dust:** `idleDustLimit`의 상한을 20 USDC 이하에서 10 USDC 미만(`MAX_IDLE_DUST` 9.999999 USDC)으로 낮췄다. 10 USDC는 신고가 성립하는 크기이므로 종료가 등록 대상에 남기는 잔량이 그 크기가 되지 않게 했다.
- **Recall:** `abandonRecall`이 선언한 Core 블록을 저장하고 대기 기간을 그 선언부터 센다. 회수를 제출한 Core 블록에서는 선언할 수 없고 같은 액션을 다시 선언할 수 없다. 미리 선언해 두면 시간 만료만으로 회수가 닫히던 문제를 해소한다.
- **Ledger probe:** lending 장부 확인의 실패를 "장부 없음"으로 받아들이기 전에 남은 gas(`20,000 / 63` 초과)와, 그 평가에서 응답한 장부 확인이 없었다면 같은 형태 대조 조회의 128바이트 응답을 확인한다. 집계하지 않는 공급 dust는 spot 보유에 더해 lot 규칙을 한 번만 적용한다. USDC는 lot 1 wei(`szDecimals == weiDecimals`)를 요구한다.
- **ABI 영향:** `ManagedPortfolioNavVerifier` 생성자가 인자 6개로 바뀌었고 `abandonedRecall`이 `(actionId, coreBlock)`을 반환한다. 검증기가 Vault의 `totalSupply()`와 `phase()`를 읽는다. `IManagedCoreNavSource`와 source에 `scopeValue(address)`와 `reportAnsweredAt(address)`를 추가했다. 검증기의 `MAX_IDLE_DUST`가 20e6에서 9,999,999로 바뀌었다. 검증기에 오류 `PriceHistoryTooShort`·`PriceDropCooldown`·`PriceRecordTooSoon`·`NoShares`와 이벤트 `PriceRecorded`·`RecallAbandoned`를, source에 오류 `OpenReport`·`NotReportable`·`ReportStands`와 이벤트 `ScopeReported`·`ReportCleared`를 추가했다. `ManagedUsdcVault`·Factory·upgrade controller의 ABI·storage·bytecode는 바뀌지 않았다.
- **Watcher:** `scripts/scope_watch.py`를 추가했다. 공개 API로 Vault Core 계정의 보유를 열거해 등록 범위와 비교하고, 신고·갱신·정리 호출과 가격 기록(정해진 간격, 그리고 직전 기록이 현재 가격보다 한도의 절반 넘게 낮을 때)을 판단하며, 배포된 source·verifier가 있으면 각 호출을 고정 블록의 `eth_call`로 시뮬레이션해 계약이 받아들이는 것만 보낼 목록에 넣는다. token은 USDC로 팔 수 있는 경로마다 후보를 내고, 등록된 token의 보유도 다른 pair를 거치는 후보로 낸다. 가격 기록은 `reportAnsweredAt`보다 뒤의 기록만 이력으로 본다. 계약이 보관하는 신고가 한 건이고 성립하는 동안 자리를 지키므로 보낼 신고도 많아야 한 건이다. 자리가 비어 있으면 받아들여지는 대상 중 API 수치로 가장 커 보이는 곳, 보관된 신고가 성립 중이면 소멸이 가까울 때의 갱신뿐이다. 서명·전송·주기 실행은 구현하지 않았다([OPS-001](docs/BACKLOG.ko.md#ops-001)).
- **Evidence:** `scripts/precompile_gas_probe.py`와 배포하지 않는 `test/mainnet/PrecompileGasProbe.sol`로 mainnet precompile 호출 비용을 읽기 전용으로 측정하고 원시 자료 두 개를 추가했다. 여섯 조회 모두 `1000 + 33 × (입력 + 출력)` gas에서 성공하기 시작했고 오류는 전달된 gas를 전부 소모했다. [관측](docs/managed-precompile-evidence.ko.md#precompile-gas). 범위 상한은 계속 더 비싼 문서 식으로 정한다. 감시 스크립트를 공개 계정 1개에 가정한 범위로 읽기 전용 실행한 자료 두 개([첫 판](docs/reference/managed-scope-watch-2026-10-04.json), [현재 판](docs/reference/managed-scope-watch-2026-10-05.json))도 추가했다. `scripts/book_probe.py`로 한쪽 호가가 빈 spot 시장 일곱 곳에서 `bbo`가 되돌리지 않고 빈 쪽을 0으로 반환하며 `spotPx`는 값을 유지한다는 것을 한 블록에서 관측했다([관측](docs/managed-precompile-evidence.ko.md#empty-book)).
- **Testing:** 신고·가격 기록·급락 한도·종료 평가·포기 선언의 단위·종단 시험, 실측 비용식의 gas 모형, gas 조임 탐색의 경계 구간 검사, 이벤트 내용 검사, gas probe와 감시 스크립트의 Python 회귀를 추가했다. 수치와 변이 검사 결과는 [STATUS](docs/STATUS.ko.md)에 있다.
- **Review:** 별도 컨텍스트의 자동 코드 리뷰 2차·3차를 반영했다(둘 다 critical 0). 2차는 종료 평가·포기 선언·장부 확인의 gas 가정을, 3차는 신고와 급락 대기를 대상으로 했다. 3차의 지적으로 가격 기록의 대체 규칙, 종료 정산의 대기, 신고의 평가별 재확인(Vault당 1건·1일), quote 경유 token의 두 단계 최소 금액, 팔 수 없는 잔량의 범위 제외, 지분 없는 기록 거부, 대조 조회의 길이 확인과 누락 시험을 추가했다. 같은 리뷰의 수정 재검증이 지적한 세 가지도 반영했다: 성립하는 신고를 밀어낼 수 없어 10 USDC 미끼 신고로 다른 신고와 가격 기록을 모두 막을 수 있던 문제(최신 증명이 자리를 차지, 기록은 신고·스위치와 무관), 기록이 끊긴 뒤에는 종료가 대기 없이 정산되던 문제(종료에도 기록 길이 요건), 지분이 한 단위만 남았을 때의 가격 기록(Idle은 현금 기준 가격). 재검증 2회차는 "최신 증명이 자리를 차지"하게 한 수정이 연 우회로를 지적했고(high 3, medium 2, low 1), 성립하는 신고가 자리를 지키게 되돌리면서 다음을 반영했다: 신고가 등록으로 답해지면 가격 이력을 다시 시작, 같은 대상의 재신고는 증명 경로 유지, pending 중에도 가격 기록, 지분 없는 Vault의 종료는 가격 조건 생략, dust 상한 10 USDC 미만. 재검증 3·4회차는 그 수정들이 유지됨을 확인했고, 남은 한 가지 경로(low: 매수호가 없는 pair로 등록한 token에 가치를 두어 신고와 종료 평가를 모두 벗어남)는 등록된 token도 종료 평가에 잡히지 않는 동안에는 신고할 수 있게 해 반영했다. 5회차가 지적한 그 수정의 부작용 두 건(low)도 반영했다: 이력 재시작을 `configure`가 실제로 푼 신고로 한정하고, 등록된 token의 신고에는 다른 pair에서 최소 금액의 두 배를 요구한다. 6회차(마지막)는 이 수정들이 유지되고 앞의 지적들이 다시 열리지 않았음을 확인했으며 코드 결함을 찾지 못했다. 반영 내역과 반영하지 않은 제안의 근거는 [ADR-029](docs/DECISIONS.ko.md#adr-029)에 있다. 독립 보안 감사가 아니다.
- **Known limits:** 신고·갱신·가격 기록은 누군가 해야 하고 거래를 보내는 봇은 아직 없다. 급락 대기는 발행과 종료 모두에서 지연이지 증명이 아니며 한도 이하의 하락은 걸리지 않는다. **보관되는 신고는 한 건이고 지금 성립할 때만 Vault를 닫으므로, 악의적인 owner가 신고된 대상을 Core에서 비우거나 숨긴 가치를 다른 미등록 대상으로 옮긴 뒤 그것이 반영된 첫 블록에 감시자의 다음 신고보다 먼저 입금하면 싸게 발행할 수 있다**(이 구조에서 닫지 못한 순서 경쟁, 결정 대기 F). 급락 대기는 그 전에 반 창에서 한 창의 지연을 만들지만, owner가 등록 범위를 평가할 수 없는 상태로 두어 가격 기록을 끊으면 가치가 범위 밖에 있어야 하는 시간은 한두 블록으로 줄어든다. 등록 token의 가격이 가드에 걸려 있으면 가격 기록이 되지 않아 종료 정산이 owner의 조치(매도 또는 범위 제외)를 기다린다. keeper가 없으면 종료 정산도 기록 뒤 반 창을 기다린다. 팔 수 없는 잔량이 등록 범위에 남은 작은 Vault의 종료는 owner가 그 token을 범위에서 뺄 때까지 미뤄진다. 매수호가가 없는 순간에는 보유 규모와 무관하게 token을 범위에서 뺄 수 있다. HIP-4 outcome·sub-account는 신고 대상이 아니다. 발행자가 잔액을 동결할 수 있는 token으로 신고를 유지할 수 있는지는 확인하지 못했다. 종료를 방해하는 비용은 dust 상한이다. owner가 자기 다른 계정과 불리한 가격에 거래해 가치를 빼는 것은 막지 못한다.
- **Remaining:** ADR-029 정책 7개와 결정 대기 A·B·C·E·F, `priceWindow`·`maxDrawdownBps` 배포 값의 사용자 확정, 감시·기록의 전송과 운영, 통제 왕복, 독립 감사. 메인넷 배포·서명·자금 이동은 하지 않았고 실자금 입금은 열지 않았다.

### 2026-10-04 — 미등록 보유 방지 구조 비교안 (문서)

- **Docs:** 등록하지 않은 자산을 운용하면 NAV에서 빠져 지분이 싸게 발행되는 문제에 대해, 현행 구조에 보호 장치를 더하는 안(신고 차단·급락 대기), 주문을 Vault 함수로만 제출하는 안, 운용 중 발행을 닫는 안을 [비교](docs/managed-scope-enforcement-options.ko.md)했다. [ADR-029](docs/DECISIONS.ko.md#adr-029)에 결정 대기 D로 등록했다.
- **Status:** 채택 전 비교안이며 선택·구현하지 않았다. 문서만 변경했고 코드·ABI·테스트 수·빌드 크기는 바뀌지 않았다.

### 2026-10-04 — precompile 실시간 NAV와 온체인 관측 검증기

- **NAV / ADR-029:** `HyperCorePrecompileSource`를 Vault별 owner 등록 범위(token 6·USDC perp DEX 8·HyperCore vault 2 이하), 버전, 입금 스위치를 가진 평가기로 다시 구현했다. Standard·Unified·PM에 같은 식(`spot + lending 순액 + DEX equity + vault equity`)을 쓴다. 가격은 USDC 1, spot mark와 2% 이내로 일치하는 reserve oracle, 또는 호가 안·spread 1% 이내의 spot mark다. 음의 DEX equity와 집계하지 않는 lending 장부는 발행을 닫는다. 등록 항목은 보유가 1 lot 미만이고 차입이 없을 때만 뺄 수 있다.
- **Verifier:** `ManagedPortfolioNavVerifier`가 NAV(Core 순자산 + `availableCash`), 액션 최종성(뒤의 Core 블록, 회수는 실제 도착한 장부 밖 USDC만 편입), 종료(등록 범위 flat·dust 상한 0 초과 20 USDC 이하)를 외부 증명 없이 판정한다. 도착하지 않은 회수는 시간만으로 닫히지 않고 owner의 `abandonRecall`과 대기 기간(10,000~2,000,000 Core 블록) 뒤에 닫히며 그때 도착분을 편입한다. Core 순자산이 음수이면 현금과 상계하지 않고 발행을 닫는다.
- **ABI 영향:** `HyperCorePrecompileSource` 생성자·`snapshot`·`scope`와 `ManagedPortfolioNavVerifier` 생성자가 바뀌었고 `IStrategyBalanceSheet` 구현·`complete`·`observedAt`·`maxAge`·외부 `actionVerifier`를 제거했다. `IManagedCoreNavSource`, `abandonRecall`·`abandonedRecall`, `CoreRead.userVaultEquity`를 추가했다. `ManagedUsdcVault`·Factory·upgrade controller의 ABI·storage·bytecode와 FE ABI는 바뀌지 않았다. legacy `PortfolioNavReader` 경로는 그대로다.
- **Evidence:** `scripts/equity_probe.py`와 공개 mainnet 계정의 블록 고정 원시 자료를 추가했다. API 통합 잔액이 raw 장부의 합과 일치했고 DEX 사이 중복은 없었다. [관측](docs/managed-precompile-evidence.ko.md#raw-ledger-identity).
- **Testing:** precompile 응답 주입 단위 시험, 실제 Factory·Vault에 검증기를 연결한 종단 시험, 공식 비용식을 따르는 stub의 gas 모형 시험(`test/ManagedNavGas.t.sol`, `test/helpers/MeteredReadPrecompile.sol`), 저장된 관측에 대한 Python 회귀를 추가했다. 수치는 [STATUS](docs/STATUS.ko.md)에 있다.
- **Review:** 별도 컨텍스트의 자동 코드 리뷰 1회(critical 0)를 반영했다: 회수 포기 절차와 대기 기간 범위, DEX 결손의 발행 차단, lending 공급 dust, dust 상한의 하한, reserve oracle과 spot mark의 일치 가드, 장부 확인 gas 20,000, 범위 상한 축소. 독립 보안 감사가 아니다.
- **Known issues:** 등록 token의 시장이 사라지면 종료가 확정되지 않고 복구 경로가 없다. 호가로만 평가되는 토큰은 얇은 시장의 한 블록 조작에 취약하다. Factory는 예측 주소의 선제 Core 활성화로 생성이 막힐 수 있다(이 변경 이전부터 있던 문제, 코드 미변경). 세 항목은 [ADR-029](docs/DECISIONS.ko.md#adr-029)의 결정 대기 A·B·C다.
- **Remaining:** ADR-029 정책과 결정 대기 항목의 사용자 확정, 프로젝트 계정의 통제 왕복·모드 전환·gas 실측, 독립 감사, verifier 배포 설정, FE의 범위 등록 화면. 메인넷 배포·서명·자금 이동은 하지 않았고 실자금 입금은 열지 않았다. [BACKLOG](docs/BACKLOG.ko.md#nav-001).

### 2026-10-04 — Unified·PM의 precompile NAV 설계 문서

- **Docs / ADR-028:** 운용자 등록 목록의 완전성 신뢰, Unified/PM별 평가기, 현재 Core 상태 가격 정책, 입금 전 NAV 기반 동기 발행 구조를 채택했다. [상세 설계](docs/managed-unified-pm-nav.ko.md)에 회계 후보식·모드/목록 변경·HIP-4·자금 귀속·검증 시나리오를 기록했다.
- **Clarified:** accountMarginSummary의 모드별 중복 관계는 미검증이며 raw Spot과 API 통합 잔액을 구분한다. 원천 timestamp 요구 변경은 후속 코드 작업으로 남긴다. 독립 전체 계정 증명과 운용자 목록 신뢰를 구분한다.
- **Status:** 관련 SSOT/현행 명세/핸드오버를 연결했다. 문서만 변경했고 코드·ABI·FE·테스트 수·빌드 크기·raw 자료·실자금 입금 상태는 변경하지 않았다.

### 2026-10-04 — 이름·기본 FE·precompile 관측과 Active 입금 gate

- **Metadata:** 이름을 받는 Factory 생성 overload, proxy append-only name storage·기본 fallback·owner rename. 기존 생성/초기화 selector와 upgrade storage prefix를 유지했다.
- **NAV:** `CoreRead` metadata/outcome read, `HyperCorePrecompileSource` token/lending/DEX/position2/outcome 관측과 Standard 후보 장부, `ManagedPortfolioNavVerifier`의 complete/scope/nonce/block/freshness 검사. 외부 서명 NAV는 도입하지 않았다.
- **Deposits:** Ready/Active에서 검증 source가 있을 때 입금 전 NAV로 동기 mint. 실패·pending·exit·upgrade·0/음수 NAV에서 입금 gate를 닫고 EVM 장부 현금/기부/준비금을 분리한다. 실제 shipping source는 complete=false이므로 production Active 입금은 아직 닫힌다.
- **FE:** React/TypeScript/viem의 이름·조건 생성, 입금·출금 요청·청구·owner 관리, demo/계약 모드. BigInt, 정확한 승인, chain/account·stale 상태 검사와 반응형 화면을 추가했다. 실제 지갑 서명/메인넷 write는 하지 않았다.
- **Observed fixes:** 새 mainnet 공개 자료에서 Core USDC metadata가 Circle bridge를 가리키는 점을 확인해 ERC20 비교를 수정했다. HIP-4 만기 후 balance/price 조회 실패에 대응해 상태 먼저 조회·balanceQueried 표시를 추가했다. 원시 실패를 보존하는 outcome probe와 회귀를 추가했다.
- **Verification:** source 응답 주입·미완료 source 차단·손익/기부/슬리피지·이름/upgrade 회귀와 FE 입력/state 시험, 데모 브라우저 확인. 최신 수치/크기는 [STATUS](docs/STATUS.ko.md), source 한계는 [명세](docs/managed-precompile-nav.ko.md)에 기록한다.

### 2026-10-04 — Managed USDC Vault 구현·커스텀 조건·업그레이드·메인넷 시험 코드

- **Added:** 공개 `ManagedUsdcVaultFactory`, Vault proxy 자체의 Core 계정과 owner 관리 action 9/12/13/15/16, 100 USDC 창설자 지분과 추가 활성화 비용 분리, 비동기 결과 확인 인터페이스. Vault 전용 agent 등록/교체·hash-derived 슬롯 교체 철회, 고정 수령지 recall·builder 상한을 구현했다.
- **Accounting:** 고유 ERC7540 요청·실현 cash·준비금·원가·손실 이월·부분 순수령 claim, 성과수수료의 운용자80/플랫폼20 분할. 이전 AsyncUsdcVault에서 문서/회귀가 기대하던 `accountedCash`·직접 송금 격리 구현 누락을 복구했다.
- **Settings / ADR-026:** 생성 시 성과수수료 커스텀(기본10%)·최소 입금 선택(기본10 USDC), Idle에서 최소 입금 조정, 기존 share/준비금 없는 경우만 요율 변경. OZ Transparent proxy·Vault별 immutable Config implementation·owner upgrade controller·48시간 지연·Idle 실행을 추가했다.
- **Testing:** 생성/권한/기부/수수료·최소 금액·업그레이드 전후 claim/다음 입금 회귀, recursive storage baseline 검사와 반복 gate를 추가했다. Foundry artifact에 storageLayout을 항상 출력해 캐시 재빌드 뒤에도 검사되게 했다. 코드 수치/실행 결과는 [STATUS](docs/STATUS.ko.md)에 있다.
- **Mainnet tools:** owner-funded Core probe, 읽기 전용 snapshot, Vault agent Alo 주문/취소 dry-run 및 명시 실행 runner, Factory 배포 script와 단계별 시나리오. 메인넷 preflight 원시 자료를 새 파일로 추가했다. 배포·서명·입금·주문·회수 거래는 실행하지 않았다.
- **Remaining:** 생산 verifier, 완전 Active NAV·운용 중 신규 입금, 네 시장의 실제 거래/회수, independent security review. mock 결과와 proxy/configHash 검사를 경제적 안전성 증명으로 표시하지 않는다.

### 2026-10-04 — ZPI 테스트넷 지갑과 읽기 전용 연결

- **Environment / ZPI-002:** 저장소 밖 사용자 전용 경로에 Zcash testnet 지갑과 Hyperliquid testnet EVM 키를 생성했다. Zcash age identity·지갑 및 EVM 키 파일은 사용자 전용 권한으로 보관한다. 주소와 비밀값은 저장소에 기록하지 않았다.
- **Observation:** Zcash testnet 지갑을 체인 tip까지 동기화했고 무료 1 TAZ faucet 요청은 확정됐다. 지갑은 같은 txid를 Ironwood 수신 note 1 TAZ로 인식했고, 추가 블록 동기화 후 1 TAZ의 표준 지출 가능액을 확인했다. Hyperliquid testnet Core 계정은 API에서 자산·포지션 0으로 조회됐다. 공식 mock USDC faucet의 mainnet 입금 조건은 미충족이다. 실주문·환전·지급은 없다.
- **Validation:** 지갑 파일 권한과 네트워크 이름을 확인했다. 저장소 코드·ABI는 변경하지 않았고 이번 환경 설정에서 코드 테스트나 Solidity 빌드는 재실행하지 않았다.

### 2026-10-04 — Vault 전용 API wallet의 계정 귀속 명확화

- **Docs:** API wallet을 Vault Core 계정에 등록하는 전용 agent로 명시했다. owner는 등록·교체/키 운용 역할이고 자산·주문·포지션·손익은 Vault에 귀속된다. 다이어그램과 Vault별 계정 귀속 검증 조건을 수정했다. 코드·ABI·실거래 변경은 없다.

### 2026-10-04 — Zcash 비공개 인텐트 오프라인 연구 모형

- **Added / ZPI-001:** 현행 Vault와 분리된 프라이버시·신뢰 경계 명세, ZEC 입금→환전→Core credit→선물 체결→개인별 정산→공동 잔액 대조→shielded ZEC 지급의 Python 모형. 같은 시장·방향의 공동 진입 주문을 정수 lot로 배분해 사용자별 장부에 반영했다. 두 사용자 손익, 부분 체결 최종성, 영수증 중복, 손실·출금 잠금, 무거래 환급·epoch 동결, lot·거래비 배분 회귀를 추가했다.
- **Limits:** 모든 외부 영수증은 mock 가정이다. Zcash 지갑/서명·솔버·Hyperliquid 연동, 실제 공동 계정 증명, 수탁·무허가 회수는 구현하지 않았다. Solidity 계약·ABI·배포는 변경하지 않았다.
- **Validation:** `python3 -m unittest discover -s test/python -v`에서 36 tests passed (신규 14). 500개 오프라인 배분 추적에서 최종 수량·단조 배분을 추가 확인했다. Solidity 테스트·빌드 크기 검사와 네트워크 거래는 이번 Python/문서 변경에서 실행하지 않았다. 현황과 후속 조건은 [STATUS](docs/STATUS.ko.md), [BACKLOG](docs/BACKLOG.ko.md#zpi-002)를 따른다.

### 2026-10-04 — 고정 owner와 운용자 신뢰형 USDC 관리 아키텍처

- **Decision / ADR-023:** Factory 호출자를 변경 불가 owner로 지정하고 Vault의 API wallet·USDC 왕복·계정 내 이동·Borrow/Lend·계정 모드·builder fee 관리 함수를 onlyOwner로 제공하는 목표를 확정했다. 운용 판단은 owner에게 맡기고 API 주문마다 EVM 위험 검사를 강제한다는 가정을 제거했다.
- **Docs:** 함수/권한·계약 구성·생성/등록/회수 흐름을 별도 상세 명세에 작성했다. owner의 Core 회수와 예치자 요청/확정 claim을 구분하고 기존 자동 WHYPE 전략의 permissionless 회수 조건과 분리했다. 키 철회를 로컬 상태 삭제로 완료 처리하지 않도록 명시했다.
- **Validation:** 공식 CoreWriter·API wallet·Circle 출금 문서를 확인했다. 설계 문서 변경으로 코드 테스트·빌드 크기 검사·메인넷 거래는 실행하지 않았다.

### 2026-10-03 — 창설자 API wallet과 Core 설정 액션 경계

- **Decision / ADR-022:** 창설자가 만든 API wallet을 Vault 자신의 Core 계정에 등록해 직접 주문하는 목표와, Vault CoreWriter action 15 공급·회수 및 action 16 계정 추상화 전환을 구분했다. API 주문의 EVM 사전 검사 우회와 키 교체·철회·비상 정책을 명시했다.
- **Validation:** Hyperliquid 공식 CoreWriter·Exchange API·SDK 예시를 대조했다. 계약 계정의 agent 등록/주문, 실제 Core 액션, Solidity/Python 테스트·빌드 크기 검사는 실행하지 않았다.

### 2026-10-03 — Circle 입금의 EVM revert와 Core 수령 경계 확인

- **Docs:** Circle `deposit`의 EVM 단계 실패는 같은 거래의 share 발행을 되돌릴 수 있지만, EVM 성공은 이후 처리되는 Core credit을 확정하지 않는다고 명시했다. EVM 수령 기준 동기 지분 발행과 후속 `finalizeActivation`의 운용 확인을 분리했다. Core spot 직행과 Circle CoreWriter를 경유하는 perp 목적지를 구분했다.
- **Validation:** Circle 공식 인터페이스·공개 계약 구현과 Hyperliquid 처리 순서를 검토했다. 실제 배포 코드 대조·통제 입금·코드 테스트는 수행하지 않았다.

### 2026-10-03 — Core 계정 활성화와 토큰 연결 액션 구분

- **Docs:** Vault의 `finalizeActivation`은 Core 계정·USDC 수령을 읽어 운용 상태를 확인하는 가칭 함수이며, CoreWriter action 8 `Finalize EVM Contract`는 spot 토큰의 Core/EVM 계약 연결용임을 명시했다.
- **Validation:** Hyperliquid의 활성화 비용·CoreWriter 액션 표·토큰 연결 절차를 확인했다. 코드·ABI·배포·통제 네트워크 거래 변경은 없다.

### 2026-10-03 — Core 활성화와 HYPE 가스 부담 구분

- **Docs:** 첫 Core USDC 수신으로 계정을 활성화하고, CoreWriter는 계정 확인 뒤 후속 EVM 블록에서 호출하도록 명시했다. 첫 수신의 1 quote-token 비용과 생성자·keeper·운용자가 제출하는 HyperEVM 거래의 HYPE 가스를 구분했다. Vault EVM 주소의 HYPE 선입금은 내부 CoreWriter 호출 조건이 아니다.
- **Validation:** 공식 Hyperliquid 활성화·처리 순서·가스 문서를 확인했다. 코드·ABI·배포 변경과 통제 네트워크 거래는 없다. 실제 gross→net과 Core→EVM 회수 비용은 백로그에 남겼다.

### 2026-10-03 — USDC Vault 입금 위치와 지분 발행 기준 정리

- **Decision / ADR-021:** HyperEVM USDC를 Vault 함수로 실제 수령한 거래에서 창설자/일반 사용자 지분을 발행한다. Core 확인은 내부 자금 배정·운용 개시 조건이다. Core 보유자는 자기 동일 주소 EVM으로 먼저 출금한 뒤 Vault에 입금한다. Vault Core 직접 송금과 Circle `depositFor(vault)`는 지분을 만들지 않는다.
- **Docs:** `createVaultAndFund`의 초기 100 share, 별도 활성화 예산, 인플라이트 장부·실패 복구, Idle 입금 가격 조건, Core 보유자 UX와 기존 ADR-019/020의 대체 관계를 명시했다.
- **ABI / Validation:** 문서 설계 변경. 새 Factory·단일 주소 Vault 코드는 없고 Solidity/Python 테스트·Core 자금 이동은 실행하지 않았다.

### 2026-10-03 — Vault 생성과 첫 Core 배정 통합 설계

- **Decision / ADR-020:** 당시 생성 후 창설자가 Core USDC를 다시 보내야 했던 첫 경로를 수정했다. 지분 발행 시점은 후속 ADR-021로 대체됐다. Factory `createVaultAndFund`가 새 Vault을 배포·창설자 HyperEVM USDC를 이체하고, Vault가 같은 EVM 거래에서 Circle `deposit`으로 자기 Core 주소에 배정한다. 실제 Core100 확인 뒤 지분을 발행한다.
- **Docs:** 후속 EVM 블록의 permissionless `finalizeFounderFunding()`이 Vault 내부 Core read를 검증해 고정 창설자에게 100 share를 한 번 `_mint`하는 절차를 구체화했다. 101 EVM gross→100 Core net은 통제 실험 전 가정으로 두고, EVM 성공/비동기 Core 결과·실패 복구를 구분했다. Core-only 자금은 별도 송금 또는 EVM 경유 대체 경로로 남겼다.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 문서 링크와 일관성만 점검; 새 Solidity 테스트·Core 통제 거래는 미실행.

### 2026-10-03 — 최초 Core USDC 100의 창설자 지분 인정

- **Decision / ADR-019:** ADR-018의 EVM USDC 100 선납·별도 Core seed를 대체했다. 새 Vault Core 주소에 도착한 최초 USDC 100을 창설자 자기자본으로 사용하고 share를 1회 발행한다. 당시 첫 경로였던 배포 후 Core 송금은 후속 ADR-020에서 대체 경로가 됐다.
- **Docs:** 공개 Factory 흐름, 초과·비요청 Core 자산 격리, 비동기 실패 복구, ERC-4626 일반 입금과 구분되는 bootstrap, FACTORY-001/USDC-001 검증 조건을 수정했다.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 문서 일관성 검사만 수행; 새 Solidity 테스트·통제 Core 송금은 미실행.

### 2026-10-03 — 창설자 활성화 비용과 지분 출금 정책 정리

- **Docs:** 당시 EVM 자기자본 100 USDC와 별도 Core seed를 구분했다. 이 이중 납입 경로는 후속 ADR-019로 대체됐다. 1 quote-token 비용은 주주 원금에서 자동 차감하지 않는다. 창설자 출금 제한은 OPEN-09 제안으로 남겼다.
- **Evidence:** OpenZeppelin의 공개 연동 감사에서 Core 활성화 송금의 수수료가 송금인 Core 잔액에서 전송액과 별도 차감됨을 확인했다. 우리 경로의 전후 잔액 실측은 미완료다.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. Hyperliquid 공식 문서와 로컬 문서 일관성을 확인했으며 Core 전송·Solidity 테스트는 실행하지 않았다.

### 2026-10-03 — 창설자 100 USDC 자기자본 생성 조건

- **Decision / ADR-018:** 당시 창설자 HyperEVM USDC 100 선납 목표를 채택했다. 해당 납입 경로는 후속 ADR-019의 최초 Core100 지분 인정으로 대체됐고, 플랫폼 생성 수수료가 아니라는 정책은 유지된다.
- **Docs:** Factory 거래의 정확한 USDC 수신·share 발행, Core 보유 자금의 창설자 EVM 주소 경유, 직접 Core 송금의 출처 증명 한계와 미활성 Vault의 원금 반환 조건을 아키텍처·FACTORY-001에 반영.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 공식 Circle/Hyperliquid 문서 확인과 Markdown 일관성 검사만 수행; Core→EVM/Factory 통제 거래와 새 코드 테스트는 미실행.

### 2026-10-03 — 성과 수수료의 플랫폼 20% 배분

- **Decision / ADR-017:** 다른 예치자 출금 이익에 매기는 총 10% 수수료 중 80%를 창설자/운용자, 20%를 플랫폼에 배분. 사용자에게 추가 fee를 부과하지 않는다.
- **Docs:** Claim의 사용자·운용자·플랫폼 USDC 원자적 분할, 준비금·누적 반올림, Treasury 권한과 FEE-001 검증 조건을 갱신.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 문서 일관성 검증만 수행하며 실거래·새 Solidity 테스트는 미실행.

### 2026-10-03 — 새 USDC 운용자 Vault의 출금 이익 10% 수수료

- **Decision / ADR-016:** 창설자/운용자가 다른 예치자의 실제 USDC 출금 이익에서 10%를 받는 목표를 채택. 원금과 손실에는 매기지 않고, 사용자별 손실 이월 후 Claim에서 사용자 순수령과 운용자 fee를 분리한다.
- **Docs:** 원가·반올림·준비금·고유 ERC-7540 요청 ID·순수령 view와 검증 조건을 [수수료 명세](docs/performance-fee-architecture.ko.md), 아키텍처와 FEE-001에 기록. 기존 WHYPE의 0 fee 기획과 구분.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. ERC-4626/7540 공식 조항과 문서 링크/내용을 대조했으며, 수수료 회귀와 네트워크 거래는 미실행.

### 2026-10-03 — 창설자 운용 및 Core USDC 활성화 설계 정정

- **Decision / ADR-015:** Vault 창설자가 해당 Vault를 운용하고 다른 사용자가 HyperEVM USDC를 예치한다. 창설자는 자기 Core USDC를 Vault Core 주소로 직접 보내 활성화한다. ADR-014의 Factory `depositFor(newVault)` 활성화 후보를 대체한다.
- **Docs:** Factory/CoreWriter 자금 원천, 별도 창설자 서명, 1 quote-token 비용, 활성화 잔여금의 주주 NAV 격리와 후속 확인을 아키텍처·백로그·핸드오버에 반영했다.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 공식 문서 확인과 로컬 Markdown 일관성 검사만 수행; EOA CoreWriter나 Core 송금 통제 실험은 미실행.

### 2026-10-03 — 공개 USDC Factory와 단일 Vault/Core 주소 목표

- **Decision / ADR-014:** 새 USDC 상품은 Vault 주소를 Core 계정으로 사용하고 누구나 동일 템플릿으로 Vault를 생성할 수 있게 설계. 현행 WHYPE Vault/Strategy 쌍의 결정은 WHYPE 코드에 유지한다.
- **Docs:** 당시 Factory의 사용자 부담 운영 seed 후보, `AwaitingActivation → Ready` 후속 확인, share/NAV와 분리한 활성화 비용, Core 입금·회수 주소와 공개 생성의 권한 경계를 아키텍처·백로그·상태·USDC 현행 명세에 반영. 활성화 자금 출처는 후속 ADR-015로 정정.
- **ABI / Validation:** 코드·ABI·storage·배포 변경 없음. `AsyncUsdcVault`의 별도 Strategy 계정과 기존 mock 결과를 새 단일 주소/공개 Factory 구현 증거로 취급하지 않는다. 문서 링크·내용 일관성 검증만 수행.

### 2026-10-03 — USDC Vault 직접 송금 격리

- **Decision / ADR-013:** Vault에 비요청으로 들어온 USDC를 주주 현금에서 격리한다. Core/Strategy 주소에 들어온 외부 자산의 출처 검증은 USDC-001/002의 미완료 조건으로 유지한다.
- **Changed:** `AsyncUsdcVault.accountedCash` 장부를 입금·Core 배정·Strategy 반환·claim·rounding dust 지급에 연결했다. `availableCash`, 지분 가격, cap, epoch 정산은 장부를 사용하고 직접 송금분은 새 `unaccountedUsdc()`로 관측한다. 잔액 결손은 `AccountedCashDeficit`로 중단한다. 공유 `EpochRedeem`에 지급 전 내부 hook을 추가했으며 기존 WHYPE 동작은 유지한다.
- **ABI / storage:** 새 USDC Vault에 `accountedCash()`·`unaccountedUsdc()`와 새 오류가 추가되고 저장 장부가 늘었다. 기존 WHYPE 외부 ABI·저장 변수는 변경하지 않는다. 실배포 USDC 인스턴스는 없으며 새 배포 시 최신 생성 코드를 사용해야 한다. 비요청 USDC 회수 함수는 아직 없다.
- **Validation:** Vault 직접 송금, 배정 한도, 정산·claim, 장부 결손과 rounding dust의 로컬 mock 회귀를 추가했다. 전체 결과와 크기는 [STATUS](docs/STATUS.ko.md); Core/Strategy 수신의 안전성을 증명한 테스트는 아니다.

### 2026-10-03 — USDC ERC7540 Vault 로컬 구현

- **Added / USDC-002 일부:** 별도 `AsyncUsdcVault`와 `IUsdcCycleStrategy`. 6자리 USDC/9자리 hcUSDC 지분, Idle 동기 입금, ERC7540 요청·epoch 정산·claim, 확정 준비금 격리, `depositWithLimit`/`mintWithLimit`의 가격·기한 조건을 구현.
- **Added:** Vault의 `CoreDepositWallet.depositFor(Strategy, amount, destinationDex)` 정확한 allowance·EVM 차감 확인, Strategy의 반환 준비 확인과 실제 Vault USDC 수령액 대조. mock에서만 자금 왕복을 재현했고 Core credit·시장 거래·CoreWriter 회수 실측은 아님.
- **Changed:** 공유 `EpochRedeem`의 이름/심볼 생성자를 일반화하고 기존 WHYPE Vault가 기존 값을 전달. WHYPE 지분 ABI·이름과 기존 배포 경로는 유지. 새 USDC Vault/Strategy 경계 ABI를 추가했으며 새 Factory/생산용 Strategy는 미구현.
- **Validation:** [STATUS](docs/STATUS.ko.md)에 로컬 회귀·빌드 크기 결과 기록. spot·HIP-3·HIP-4 시장별 구현/실험 및 실자금 배포는 [USDC-001/002](docs/BACKLOG.ko.md#usdc-001)·[MARKET-001](docs/BACKLOG.ko.md#market-001)에 남음.

### 2026-10-03 — USDC Vault 표준과 초기 출금 유동성

- **Decision / ADR-012:** stable OpenZeppelin ERC4626 기반, ERC7540 동기 USDC 입금·비동기 epoch 출금을 새 상품의 표준 경로로 선택. ERC7575 다중 입금 진입점과 Community ERC7540 의존성은 기본 범위에서 제외.
- **Docs:** 첫 배포 후보는 목표 운용 USDC buffer 0과 전량 회수 후 claim을 허용하고, 확정 claim 준비금은 별도로 잠그도록 표준 검토·아키텍처·유동성 기획·백로그를 정리.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. 공식 표준/라이브러리 조사와 문서 일관성 확인만 수행했으며 Solidity/Python 테스트·네트워크 거래는 실행하지 않음.

### 2026-10-03 — USDC Vault의 다중 시장 제품 범위

- **Decision / ADR-011:** 새 USDC Vault의 핵심 거래 범위를 HyperCore spot·HIP-3·HIP-4와 기본 perp로 확정. HYPE 현물+perp carry는 현행 WHYPE 구현/예시이며 새 상품의 고정 전략이 아님.
- **Docs:** Vault 아키텍처, 상품·NAV·외부 전략 구분, MARKET-001/002 백로그와 공식 시장/권한 근거를 갱신. Agent wallet 발급·builder fee 승인은 현재 구현에 없고 권한·주문 경로 검증 과제로 남음.
- **ABI / Validation:** 코드·ABI·배포 변경 없음. Solidity/Python 테스트와 새 네트워크 거래를 실행한 기록이 아님.

### 2026-10-03 — USDC 입금 단계 설명 정정

- **Docs / ADR-010:** Vault가 받은 USDC를 `depositFor`로 바로 이동하는 흐름을 명확히 함. Core 잔액 관측은 입금 전 수동 검증이 아니라 후속 Core 거래 전 자동 확인 조건으로 설명. 코드·ABI 변경이나 새 네트워크 실험 없음.

### 2026-10-02 — Vault 아키텍처 기준선

- **Docs / ARCH-001:** [Vault 아키텍처](docs/vault-architecture.ko.md)에 불변 배포 쌍, 신뢰 경계, 회계·권리 불변조건, 실패 정책과 단계별 기능 범위를 연결. ZEC 프로젝트는 범위에서 분리.
- **Status:** 문서 설계만 완료. CORE-001~006, NAV-001, STD-001, REL-001의 구현·실측·감사 조건은 그대로 남음.
- **ABI / Validation:** 코드·ABI·설정 변경 없음. Solidity/Python 테스트를 새로 실행한 기록이 아님. 문서 링크와 참조 상태만 점검.
- **Decision / ADR-010:** 사용자 제안에 따라 후속 상품의 HyperEVM USDC 입금·USDC 지분·USDC 출금을 새 불변 쌍의 목표로 설정. 현행 WHYPE 코드는 그대로 두고 `CoreDepositWallet.depositFor(Strategy, ...)`를 채택 경로로 문서화. 계약 발신 Core `SendAsset` 역방향과 전체 왕복은 USDC-001/002에 남김.
- **Docs:** 아키텍처·NAV/상품 기획·BACKLOG·STATUS·HANDOVER에 현행 WHYPE와 후속 USDC 목표의 경계를 반영. Circle/Hyperliquid 공식 문서 재확인만 수행했고 새 RPC·CoreWriter 거래는 실행하지 않음.

### 2026-09-23 — PM 생명주기 모형과 초기 공급 검사

- **Fixed / CORE-001 일부:** 초기 explicit supply 직전 HYPE lending supply/borrow를 다시 확인. 기존 노출이 생겼는데 외부 raw spot 보충으로 target만 충족하면 전액 공급을 추가 제출하던 경로를 `ResidualExposure`로 차단. bridge target은 검사 통과 후에만 삭제하며 read 실패는 그대로 전파.
- **Added:** [PM 생명주기 모형](test/PmLifecycleModel.t.sol)과 [공급 진입 회귀](test/CollateralAdmission.t.sol). 자동 공급·gas 이동·마감/pause·다음 cycle의 정체, 초기 lending read 실패의 EVM 원자성, 공급/차입 비제로 차단 및 정상 explicit supply 경로를 검사.
- **Decision / ADR-009:** 비제로 lending을 새 공급의 정상 baseline으로 자동 수용하지 않음. 자동 공급 원금 인정·부분 공급 계산·회수 우회는 도입하지 않음.
- **Docs:** [재현 보고서](docs/pm-lifecycle-model.ko.md), 현행 명세·상태·백로그·결정·핸드오버 갱신. 공식 설명, 공개 계정 관측, mock 가정을 구분.
- **ABI:** 함수·event·error·storage·enum 변경 없음. 해당 입력에서 기존 공급 제출 대신 기존 `ResidualExposure` 발생. 기존 배포를 업그레이드하는 기능은 없으며 새 빌드에 적용.
- **Validation:** 수정 전 추가 공급 제출 조건 및 guard 회귀 실패 확인. 수정 후 결과와 크기는 [STATUS](docs/STATUS.ko.md)에 기록. Python·실네트워크 write는 실행하지 않음. 자동 공급 이후 진행·회수는 아직 해결되지 않아 CORE-001 전체는 진행 중.

### 2026-09-22 — Vault의 0 share 전송 호환성 수정

- **Fixed / STD-003:** `EpochRedeem._update`의 custody guard를 양수 전송에만 적용. Vault가 포함된 0 share `transfer/transferFrom`을 OZ ERC20 경로로 처리하고 `Transfer` 이벤트 발생. 양수 직접 전송 차단·request escrow·정산 burn 유지.
- **Decision / ADR-008:** 비양도 Vault 예외를 현재 양도 가능한 share의 0 전송 거부 근거로 사용하지 않음. 0 전송은 요청/claim 권한을 만들지 않으며 zero-address 검증은 유지.
- **Changed:** 0 전송 거부를 기대하던 테스트를 정상 이벤트·회계 보존 회귀로 전환. 수정 전 실패 확인, allowance fuzz·양수 우회 차단·escrow→정산→claim·pause/shutdown·주소 검증 추가.
- **ABI:** 함수·storage layout 변경 없음. 유효한 주소의 0 전송은 기존 `DirectShareTransferForbidden` revert 대신 true와 `Transfer` 이벤트 반환.
- **Validation:** 검증 명령·결과·빌드 크기는 [STATUS](docs/STATUS.ko.md)에 기록. Python·실네트워크 write는 이번 작업에서 실행하지 않음. 남은 양수 전송 제약과 검토 범위는 [표준 검토](docs/standards-review.ko.md)에 명시.

### 2026-09-21 — ERC4626 maxDeposit 한도 수정

- **Fixed / STD-002:** 남은 cap 전체를 넣어도 0 shares가 되는 경우 `maxDeposit`을 0으로 반환. 실제로 수용할 수 없는 입금량을 광고하던 STD-F01을 해소하고 기존 zero-share 발행 방어 유지.
- **Changed:** 결함 존재를 기대하던 테스트를 수정 완료 회귀로 전환. 수정 전 실패/수정 후 통과 확인. 한 share 경계의 deposit/mint, 기존 claim 준비금, cap·초기 입금·기부금 조합의 최대량 실행과 초과 거부 검증 추가.
- **ABI:** 함수·storage layout 변경 없음. 입금 한도가 0으로 바뀐 반례에서 `deposit(1)`의 오류는 `InvalidAmount`에서 `CapitalClosed`로 변경. cap이 충분한 상태의 zero-share 입금은 기존 오류 유지.
- **Validation:** Solidity 전체 회귀·포맷·배포 계약 크기 검사 통과. Python은 재실행하지 않음. 최신 결과는 [STATUS](docs/STATUS.ko.md), 재검토 내용은 [표준 검토](docs/standards-review.ko.md)에 기록.

### 2026-09-21 — 표준 적합성 대조와 반례 재현

- **Added / STD-001:** [표준 검토 보고서](docs/standards-review.ko.md)와 [StandardsReview 테스트](test/StandardsReview.t.sol). ERC20/165/4626/7540/7575의 인터페이스·이벤트·권한·preview·epoch·경계 동작을 대조.
- **Found / STD-002:** donation/cap 경계에서 `maxDeposit`이 실제 입금 가능한 양을 초과하는 반례. 아직 수정하지 않았으며 재현 테스트는 결함의 존재를 기대하고 통과.
- **Reviewed / STD-003:** Vault로의 0 share 직접 전송 제한을 재현하고 ERC20/4626 호환성 정책 검토로 분리.
- **Changed:** SSOT 문서에 검토 범위·남은 항목·재현 결과를 연결. production 계약·ABI·배포 설정은 변경하지 않음.
- **Validation:** Solidity 전체 회귀, 포맷, 빌드 크기 검사 통과. Python은 이번 작업에서 재실행하지 않음. 실행 수치와 한계는 [STATUS](docs/STATUS.ko.md)에서 관리.

### 2026-09-21 — 전체 기획 패키지

- **Added / DOC-002:** [기획 패키지](docs/plans/README.md)에 분야별 기획 14개, 외부 근거·가정 등록부, 요구사항 18개와 정책 선택 8개를 연결. 제안과 현행 구현을 구분.
- **Added:** 배포 manifest, 실험 기록, 파라미터 profile의 미실행 JSON 예시. 실제 주소·비밀·운영 기본값 없음.
- **Planned:** PM 자동 공급 분기, 증거 기반 복구, source 완전성, 입금 가격, gas/dust 귀속, buffer 노출, 동일 epoch 부분 전략 회수, keeper/UI/검증/운영 범위를 구체화. 기능 구현 완료를 뜻하지 않음.
- **Reviewed:** 공식 표준 및 PM/Core 연동 문서 재확인. 공급 write에 대한 문서 표현 차이는 [외부 근거](docs/plans/sources.ko.md)에 기록하고 실험 조건으로 유지.
- **Changed:** SSOT 안내·핸드오버·상태·백로그에서 새 기획을 연결. 계약·테스트·배포 스크립트는 변경하지 않음.
- **Validation:** 문서 링크/앵커, 요구사항→시험, 실험/작업 ID, draft 표시, JSON 파싱 검증 통과. Solidity/Python 실행 결과는 이전 코드 검증 기록을 유지.

### 2026-09-21 — 문서 관리와 핸드오버

- **Added:** [HANDOVER](HANDOVER.ko.md), 문서별 [SSOT 안내](docs/README.md), STATUS, DECISIONS, BACKLOG와 고정 작업/결정 ID.
- **Added:** 후속 세션이 같은 문서 기준을 사용하도록 [AGENTS.md](AGENTS.md)에 진입·갱신 규칙 기록.
- **Changed:** README는 소개/탐색, HANDOVER는 재개 절차, 상세 명세는 동작과 수식으로 역할을 나눔. 최신 테스트 수·계약 크기는 STATUS에서 관리.
- **Changed:** 기존 설계·legacy 가이드를 이력 문서로 구분하고 현행 문서 링크 추가.
- **Validation:** 문서 경로·내부 앵커를 점검. 계약·테스트·배포 설정은 변경하지 않았고 코드 테스트는 재실행하지 않음.

### 2026-09-21 — PM 관측과 포지션 수량 수정

- **Fixed / FIX-001:** raw position `szi`를 CoreWriter 1e8 수량으로 오인하던 경로 수정. `RiskOracle.positionSize()`가 `orderSizeLot`로 정규화하고 int64 범위 초과를 거부. Strategy, observer, legacy에도 같은 단위 적용.
- **Changed:** mock position을 raw size-lot ABI로 정정. 완료 hedge에서 중복 주문이 없는지, 전체 close 및 부분 체결 효과량을 회귀 검증.
- **Added / OBS-001:** raw `HyperCoreAccountReader`, 동일 EVM 블록·header 재확인·오류 보존을 갖춘 `nav_probe.py`, Decimal 기반 `nav_reconcile.py`, 공개 PM 스냅샷과 대조 자료.
- **Observed:** PM API 통합 spot과 raw spot precompile의 차이, lending 상태 부재 시 read 실패, 단일 carry 표본의 잔액 후보식 일치. 관측 범위와 한계는 [실측 문서](docs/pm-nav-evidence.ko.md)에 보존.
- **ABI:** `IHyperCoreRiskOracle.positionSize` 추가, `ICoreActionObserver.Context` 끝에 `riskOracle` 추가. 관련 계약을 함께 재빌드해야 함. 기존 배포 업그레이드 기능 없음.
- **Validation:** 마지막 테스트와 빌드 결과는 [STATUS](docs/STATUS.ko.md)에 기록. 실제 PM 전환·공급 왕복 검증은 [CORE-001](docs/BACKLOG.ko.md#core-001)로 남김.

### 기존 구현 기준선 — 2026-09-20 문서에서 이관

이 절은 당시 문서와 현재 코드로 확인한 기능 묶음이다. 개별 변경의 정확한 완료 시각이나 릴리스 순서를 주장하지 않는다.

- **Added:** `AsyncHypeVault` / `EpochRedeem` / `HyperCoreStrategyAccount` 분리. OZ ERC20/ERC4626 지분, Idle 입금, ERC7540 비동기 출금·operator·epoch·부분 claim·전손·dust 준비금 회계.
- **Added:** native HYPE router, 고정 수령자 controller, atomic Factory, 배포 크기 제한을 위한 deployer 분리와 두 불변 생성 코드 조각. `DeployPair`는 31337 리허설용.
- **Changed:** 확정 claim 준비금과 주주 운용 자금을 분리하고 실제 반환 WHYPE로 정산. legacy 단일 Vault는 회귀 비교용으로 보존.
- **Added:** Core 액션 cycle/action/cloid/hash 추적, `CoreActionObserver`, `syncPendingAction()`, 읽기 전용 주문 진단. timeout·HTTP status를 자동 재시도 권한으로 사용하지 않음.
- **Changed:** recall 수신 기록·wrap·pending 소비와 최종 terminal 검사를 분리해 다음 검사 실패가 수신 기록까지 되돌리지 않도록 함.
- **Added:** `IStrategyBalanceSheet`, 선택형 `PortfolioNavReader` / `PortfolioNavMath`, NAV의 scope/cycle/freshness 검증. 기본 배포는 원금 추정 reader 유지.
- **ABI:** `Strategy.Config.actionObserver`와 pending 추적 정보, NAV `Observation.cycleId`, `Quality.MarkToMarket=3` 추가. 구버전 구성/reader를 혼합하지 않음.
- **Remaining:** 생산용 source, Active 입금, buffer·부분 회수는 미구현. [BACKLOG](docs/BACKLOG.ko.md)에서 추적.

## 다음 변경 기록 방법

Unreleased의 해당 날짜 아래 완료한 동작·수정 이유·ABI/이전 영향·검증 근거와 작업 ID를 기록한다. TODO나 예정 기능을 Added/Fixed로 쓰지 않는다. 릴리스가 실제로 이루어지면 해당 묶음을 실제 버전·날짜 아래 옮기고 배포 manifest를 연결한다. 과거 항목에 오류가 있으면 정정 사실과 근거를 명시한다.

## 2026-10-12 — kHYPE 입금 버퍼 참고 문서

- StakingFacet의 즉시 출금 풀 → 내부 버퍼 → Core 배분 순서, 유효 버퍼·정밀도 잔량·위임 큐를 문서화했다.
- 우리 수동 배정 큐와의 차이, 예시/소스 검토/미실측 범위를 구분했다. 계약·설계 정책 변경과 신규 테스트 실행은 없다.
