# Core Vault 대화 서버

Vault마다 하나의 대화방을 제공하는 작은 HTTP 서비스다. Vault 운용자(`owner`)와 예치자가 대화한다. 방의 키는 Vault 주소이고, Factory가 `isVault(address) == true`로 보고하는 주소에만 방이 있다.

Node 22 내장 모듈(`node:http`, `node:sqlite`, `node:crypto`)과 `viem`만 쓴다. 빌드 단계 없이 TypeScript를 그대로 실행한다. 브라우저 클라이언트는 [`frontend/src/chat.ts`](../frontend/src/chat.ts)다.

## 실행

Node 22.13 이상(검증 환경 22.23.1).

```sh
cd server
npm ci --ignore-scripts
cp .env.example .env   # FACTORY_ADDRESS, SESSION_SECRET, CHAT_AUDIENCE를 채운다
npm start

npm test               # node:test, stub 체인 + loopback 가짜 노드 + 메모리 DB
npm run typecheck
npm run format:check
bash ../scripts/test_server.sh   # 위 세 가지를 차례로 실행
```

`npm start`는 `.env`가 있으면 읽는다. 시작할 때 `node:sqlite`의 `ExperimentalWarning`이 한 번 출력된다. 테스트는 같은 기기의 가짜 노드에만 접속하고 실제 RPC·체인·지갑은 쓰지 않는다. 호출 제한 시간을 재는 테스트 하나가 4초 걸린다.

## 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8787` | 수신 포트 |
| `HOST` | `127.0.0.1` | 수신 주소 |
| `CHAIN_ID` | 필수 | `999`, `998`, `31337` 중 하나. FE의 `VITE_CHAIN_ID`와 같아야 한다 |
| `RPC_URL` | 필수 | 역할 조회용 EVM RPC. 응답의 chain ID가 `CHAIN_ID`와 다르면 조회를 거부한다. 호출마다 응답 전체가 4초 안에 와야 하고 8 KB까지만 읽는다. 응답을 받기 전에 연결이 실패했을 때만 한 번 다시 보내고 `Retry-After`는 따르지 않는다. 계약이 지정한 URL(CCIP-read)은 따라가지 않는다. URL에 사용자 이름·비밀번호가 있으면 Basic 인증 헤더로 옮겨 보낸다 |
| `FACTORY_ADDRESS` | 필수 | `ManagedUsdcVaultFactory` 주소 |
| `CHAT_AUDIENCE` | 필수 | 이 서버의 공개 URL. FE의 `VITE_CHAT_URL`(절대 URL)과 글자 그대로 같아야 한다(끝의 `/` 제외). 예: `https://chat.example.com`. 없거나, 끝에 `/`·query·fragment·기본 포트·대문자 호스트가 있으면 시작하지 않는다 |
| `DATABASE_PATH` | `./chat.sqlite` | SQLite 파일 |
| `SESSION_SECRET` | 필수 | 32자 이상. 없거나 짧으면 시작하지 않는다 |
| `CORS_ORIGIN` | `http://127.0.0.1:5173` | 쉼표로 구분한 허용 origin. 경로 없는 정확한 origin만 받는다 |
| `CHAT_POSTING` | `members` | `members`: 운용자·예치자만 작성. `open`: 로그인한 지갑은 누구나 작성 |
| `CHAT_ADMIN` | 없음 | 모든 방에서 메시지를 숨길 수 있는 주소 |

`.env`와 `*.sqlite*`는 커밋하지 않는다. `SESSION_SECRET`을 바꾸면 발급한 토큰이 모두 무효가 된다.

## 엔드포인트

JSON만 주고받는다. 오류는 `{ "error": "<CODE>" }`이고 내부 오류 문구는 응답에 넣지 않는다.

| 요청 | 인증 | 응답 |
| --- | --- | --- |
| `GET /health` | — | `{ ok: true, chainId }` |
| `POST /session` `{ address, issuedAt, signature }` | — | `{ token, address, expiresAt }` |
| `GET /vaults/:vault/role?address=0x…` | — | `{ role, canPost }` |
| `GET /vaults/:vault/messages?after=&before=&limit=` | — | `{ messages }` (id 오름차순) |
| `POST /vaults/:vault/messages` `{ text }` | Bearer | `201 { message }` |
| `POST /vaults/:vault/messages/:id/hide` `{ hidden }` | Bearer | `{ message }` |

`Message`는 `{ id, vault, author, role, text, createdAt, hidden }`이다. 주소는 소문자, `createdAt`은 unix 초, `role`은 작성 시점의 역할이다.

- **로그인**: EIP-712 서명. domain `{ name: "Core Vault Chat", version: "1", chainId }`, `Session(address wallet,uint256 issuedAt,string audience,string statement)`. 복원한 서명자가 `address`와 같아야 하고, `issuedAt`은 서버 시각보다 5분 전부터 30초 뒤까지만 받는다. 클라이언트는 브라우저 시각에서 30초를 뺀 값을 넣으므로 브라우저 시계가 1분 빠르거나 4분 30초 느려도 통과한다. `audience`는 요청으로 받지 않는다. 서버는 항상 자신의 `CHAT_AUDIENCE`로 검증하므로 다른 사이트나 다른 배포를 대상으로 받은 서명은 `401 BAD_SIGNATURE`가 된다. 클라이언트는 `VITE_CHAT_URL`에서 끝의 `/`를 뗀 값을 서명에 넣는다. EOA만 지원한다.
- **토큰**: 서버에 저장하지 않는 HMAC-SHA256 토큰이다. 만료는 교환 시각이 아니라 서명 시각 기준(`issuedAt` + 12시간)이라 같은 서명을 늦게 다시 교환해도 늘어나지 않는다. MAC에 `SESSION_SECRET`, chain ID, `CHAT_AUDIENCE`가 들어가므로 비밀값을 공유한 다른 배포의 토큰은 통하지 않는다.
- **서명 검증 한도**: 서명 검증은 인증 전에 CPU를 쓰므로(건당 약 1.5ms) 서버 전체에서 초당 200건까지만 한다. 넘으면 `429 BUSY`와 `Retry-After`를 준다. 같은 서명은 잠시 뒤 그대로 다시 낼 수 있어, 클라이언트는 지갑에 다시 묻지 않고 두 번까지 재시도한다.
- **역할**: `owner()`와 같으면 `owner`, `balanceOf > 0` 또는 `controllerRequest != 0` 또는 `maxRedeem > 0`이면 `depositor`, 아니면 `visitor`. `owner()` 결과와 예치자 결과는 각각 조회를 시작한 때부터 최대 30초, 방문자 결과는 5초 동안 재사용한다. 운용자인지는 호출마다 그 `owner()` 결과와 비교하므로 어떤 역할도 30초를 넘겨 남지 않는다. 체인 조회가 실패하면 역할을 추측하지 않고 `503`을 준다. 캐시와 속도 제한은 벽시계가 아닌 단조 시계로 잰다.
- **실패하는 Vault**: 노드가 "이 호출은 계약 안에서 실패했다"고 알려 준 조회만 그 Vault의 실패로 본다. 노드가 revert에 쓰는 오류 코드 3이 그렇고, 문구나 함께 온 데이터는 보지 않는다. 비었거나(`0x`, 코드가 없는 주소) 해석할 수 없는 반환값, 8 KB를 넘는 반환값·revert도 Vault의 실패다. 이런 실패가 나면 그 Vault를 5초 동안 조회하지 않고 `503`만 준다. 그 뒤 첫 조회 한 건이 Vault를 시험한다. 그 사이에 온 요청은 그 한 건이 끝나기를 기다렸다가(길어야 4초), 다시 Vault에서 실패하면 조회 없이 함께 `503`을 받고 휴지가 다시 시작되며, 그렇지 않으면 평소처럼 조회한다. 그래서 계속 실패하는 Vault에는 요청이 몰려도 5초에 조회 한 번, 로그 한 줄만 든다. 캐시에 남아 있는 답은 각자의 유효 시간 동안 계속 쓴다. 보안 리뷰가 2026-10-05에 공개 HyperEVM RPC를 읽기 전용으로 호출해 관측한 바로는, revert는 `{"code":3,"message":"execution reverted"}`(데이터가 있으면 `data` 포함)이고, 코드가 없는 주소는 `0x`를 돌려준다. 실행 중단(없는 opcode, 스택 부족, 잘못된 jump, 가스 소진)은 모두 코드 `-32003`에 `EVM error: …`나 `out of gas: …` 문구로 44~67ms 안에 돌아오고, 호출의 가스 한도가 30,000,000이라 호출이 끝나지 않고 매달릴 수는 없다. 그래서 대상 체인에서 revert하는 Vault는 휴지에 들어가고, 중단하는 Vault는 휴지 없이 아래의 동시 조회 한도와 로그 한도로만 묶인다. 이 관측은 전달받은 것이며, 이 저장소의 테스트는 그 RPC에 접속하지 않는다.
- **RPC 실패**: 그 밖의 실패는 모두 RPC의 실패로 보고 Vault 탓으로 기억하지 않는다. 연결 불가, 4초 안에 끝나지 않은 응답, HTTP 오류, 코드 3이 아닌 모든 JSON-RPC 오류(한도 초과, 내부 오류, 가스 소진처럼 문구로만 알 수 있는 실행 실패, 다른 코드로 보고된 revert), JSON-RPC가 아니거나 결과가 없는 응답, 8 KB를 넘는데 반환값도 코드 3도 아닌 응답(오류 페이지 등)이 여기에 든다. 기억하면 RPC가 느려지거나 한도에 걸릴 때마다 멀쩡한 방이 닫히고, 외부인이 그렇게 만들 수 있기 때문이다. 대신 코드 3 없이 실패하거나 답하지 않고 시간만 끄는 Vault에는 휴지가 걸리지 않는다.
- **동시 조회 한도**: 그런 Vault나 한꺼번에 몰린 요청 때문에 노드에 호출이 쌓이지 않도록, 체인에 나가 있는 조회를 Vault 하나에 8건, Factory 조회에 8건, 전체 32건까지만 둔다. 조회 한 건은 `eth_call` 1~3회이고 그 호출이 모두 끝나야 조회가 끝난 것으로 세므로, 노드에 열려 있는 호출은 많아야 96개다. 넘는 요청은 기다리게 하지 않고 바로 `503 CHAIN_BUSY`와 `Retry-After: 1`을 준다. 토큰 없이 보낼 수 있는 요청(역할 조회, 방 조회)은 각 한도의 4분의 3(Vault 하나에 6건, Factory 조회에 6건, 전체 24건)까지만 쓰고, 나머지는 로그인한 지갑의 글쓰기와 숨김이 쓴다. 한 방에 몰린 요청은 전체의 4분의 1까지만 쓴다. 그러나 네 방 이상에 한꺼번에 몰리면 토큰 없는 요청의 몫 24건이 모두 차서 다른 방의 역할 조회도 `CHAIN_BUSY`를 받고, 여러 지갑으로 로그인한 요청은 남은 몫도 채울 수 있다. 한도는 요청자를 가리지 않으므로, 한 클라이언트가 한도를 채우지 못하게 하는 것은 아래 reverse proxy의 IP별 제한이다.
- **작성**: 앞뒤 공백을 제거한 뒤 1~1000 코드포인트, 줄바꿈은 20개까지. 줄바꿈 외 제어문자, 폭 없는 문자와 방향·서식 제어 문자(U+061C, U+200B~200F, U+2028~202E, U+2060~206F, U+FEFF)는 받지 않는다. 예외로 U+200D는 두 그림 문자를 잇는 자리(이모지 조합)에서만 받는다. 채움 문자·결합 부호·서식 문자·빈 점자처럼 그려지지 않는 문자만으로 된 메시지도 받지 않는다. 한 글자 뒤에 연달아 쌓이는 결합 부호(비간격·둘러싸는 부호, 일반 범주 `Mn`·`Me`)는 4개까지다. 더 쌓으면 위아래 줄의 다른 메시지를 덮기 때문이며, Unicode 보안 권고(UTS #39 5.4)가 드는 값과 같다. 글자 옆에 놓이는 부호(`Mc`)는 세지 않는다. 그려지지 않는 문자(서식 문자, 채움 문자, 이형 선택자 등)는 빼고 센다. 그런 문자를 부호 사이에 끼워도 부호는 같은 글자 위에 쌓이기 때문이다. 베트남어·태국어·티베트어·미얀마어의 보통 표기와 이모지는 3개를 넘지 않지만, 성서 히브리어의 낭송 부호처럼 5개 이상을 쌓는 드문 표기는 쓸 수 없다. 폭 없는 문자를 막으므로 페르시아어의 ZWNJ나 인도계 문자의 ZWJ처럼 그 문자가 필요한 표기는 쓸 수 없다. 작성자·Vault별로 3초에 1건, 10분에 30건.
- **조회**: `limit`은 1~100(기본 50). 커서가 없으면 최신 쪽, `before`는 그보다 오래된 쪽, `after`는 그 뒤부터 순서대로 준다.
- **숨김**: Vault의 현재 운용자와 `CHAT_ADMIN`만 가능하다. 숨긴 메시지는 `hidden: true`, `text: null`로 내려가고 본문은 DB에 남아 다시 표시할 수 있다. `CHAT_ADMIN`이 숨긴 메시지는 운용자가 되돌릴 수 없다.
- **로그**: 실패한 체인 조회와 내부 오류만 stderr에 남긴다. 오류 문구는 출력 가능한 ASCII 한 줄로 바꿔 따옴표로 감싸고 200자(내부 오류 400자)에서 자른다. 체인 조회 실패와 내부 오류를 따로 세어 각각 순간 20줄, 이후 초당 1줄까지만 쓴다. 그 안에서 한 Vault의 실패한 조회는 5초에 한 줄만 남기고(Factory 조회는 모두 합쳐 5초에 한 줄), 그래서 휴지 없이 실패하는 Vault 하나에 요청이 몰려도 다른 Vault의 실패가 로그에서 밀려나지 않는다. 생략이 시작되면 그 사실을 한 줄로 알리고, 다음에 쓰는 줄 맨 앞에 생략한 건수를 적는다. Vault가 정한 revert 문구나 요청 수로 로그를 꾸미거나 채울 수 없게 하기 위해서다. 연결 실패에는 원인의 코드나 이름(`ECONNREFUSED`, `ENOTFOUND`, TLS 오류 코드 등)을 대괄호로 덧붙인다. 원인의 문구, RPC URL과 그 안의 키·비밀번호는 로그에 남기지 않는다. 한도에 걸려 `CHAIN_BUSY`로 답한 요청과 휴지 중이라 조회하지 않은 요청은 로그에 남기지 않는다.

| 상태 | 코드 |
| --- | --- |
| 400 | `INVALID_JSON` `INVALID_REQUEST` `INVALID_ADDRESS` `INVALID_TEXT` |
| 401 | `SIGNATURE_EXPIRED` `BAD_SIGNATURE` `UNAUTHORIZED` |
| 403 | `POSTING_NOT_ALLOWED` `NOT_MODERATOR` `HIDDEN_BY_ADMIN` |
| 404 | `NOT_A_VAULT` `MESSAGE_NOT_FOUND` `NOT_FOUND` |
| 405 / 413 / 415 | `METHOD_NOT_ALLOWED` / `BODY_TOO_LARGE`(16 KB 초과) / `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` `BUSY` (둘 다 `Retry-After` 초) |
| 500 | `INTERNAL` |
| 503 | `CHAIN_BUSY`(`Retry-After` 초) `CHAIN_UNAVAILABLE` |

## 하지 않는 것

- **숨김 외의 moderation이 없다.** 삭제·수정·차단·신고·금칙어 필터가 없다. `open` 모드에는 다중 지갑 스팸을 막는 장치가 없다.
- **종단간 암호화가 없다.** 메시지는 평문으로 SQLite에 저장된다.
- **읽기는 누구에게나 공개다.** 메시지 목록과 역할 조회에는 인증이 없다. 숨긴 본문만 내려가지 않는다.
- **온체인 값의 기준이 아니다.** 역할은 요청 시점에 체인에서 읽은 값을 짧게 재사용한 것이고, 메시지에 남는 `role`은 작성 당시의 기록이다. 잔고·지분·운용자 확인은 항상 계약에서 한다.
- **예치 규모를 보지 않는다.** 지분이 조금이라도 있거나 청구하지 않은 출금 요청이 있으면 예치자다. share 1단위만 남겨 두어도 글쓰기 권한이 계속 유지된다.
- **업그레이드된 Vault는 자기 방의 역할을 스스로 정한다.** Vault의 운용자는 지연 기간 뒤 Vault 코드를 바꿀 수 있고 Factory의 `isVault`는 그대로 참이다. 그런 Vault는 `owner()`와 잔고 응답을 마음대로 낼 수 있으므로 그 방에서 누가 운용자·예치자인지는 그 Vault가 정한다. 역할에 미치는 영향은 그 방에 한정된다. 그런 Vault가 일으킬 수 있는 조회 비용은 응답 시간·크기 제한, 위의 휴지와 시험 조회, 동시 조회 한도로 묶어 둔다. 다만 처음 한 번 몰리는 요청과, 노드가 코드 3으로 알려 주지 않는 실패(시간 초과, 가스 소진 등)에는 요청마다 조회가 나가 다른 Vault와 같은 비용이 든다. `owner()`에는 답하고 잔고 조회만 실패시키는 Vault는 시험 조회가 `owner()`가 되는 때(30초에 한 번)에 그 직후 몰린 요청이 한도 안에서 각자 조회된다.
- **토큰을 개별로 폐기할 수 없다.** 서버 쪽 로그아웃이 없다. 발급한 토큰은 만료될 때까지 유효하며, 그 전에 무효로 하려면 `SESSION_SECRET`을 바꿔 모든 토큰을 한꺼번에 버려야 한다.
- 컨트랙트 지갑(ERC-1271) 로그인, 실시간 push(클라이언트가 `after`로 폴링한다), 메시지 내용 검증을 하지 않는다. 운용자를 사칭하는 내용인지는 `role` 표시로만 구분된다.
- **인증 없는 요청이 RPC 호출과 CPU를 쓴다.** 방 조회(`GET …/messages`)는 아직 Vault로 확인되지 않은 주소에 요청마다 `isVault` 1회(Vault가 아니라는 답은 기억하지 않는다), 역할 조회(`GET …/role`)는 캐시에 없는 (Vault, 주소) 쌍마다 최대 4회의 `eth_call`을 보낸다. `POST /session`은 서명 한 건을 검증하는 데 약 1.5ms의 CPU를 쓴다. 서버에는 IP 단위 요청 제한이 없으므로 누구나 RPC 한도를 소진시켜 글쓰기(역할 확인)를 막거나, 토큰 없는 요청의 동시 조회 몫을 채워 다른 사람의 역할 조회를 막거나, 초당 200건이 넘는 요청으로 서명 검증 한도를 채워 다른 사람의 로그인을 막을 수 있다. 여러 지갑으로 로그인하면 글쓰기에 남겨 둔 조회 몫도 채울 수 있다. 외부에 공개할 때는 **`/session`, `…/role`, `…/messages`의 요청 수를 IP별로 제한하는 reverse proxy를 반드시 앞에 두고**, 호출 한도가 넉넉한 RPC를 쓴다.
- **로그인 서명의 재사용을 5분 안에서는 막지 않는다.** nonce가 없으므로 가로챈 `POST /session` 본문은 `issuedAt` 기준 5분 동안 다시 쓸 수 있다. 다시 써도 만료 시각은 같다. 서명은 `CHAT_AUDIENCE`에 묶여 다른 사이트용 서명을 여기서 쓸 수 없지만, 이 서버의 URL을 넣은 문구에 서명하도록 속이는 사이트까지 막지는 못한다. 지갑 화면의 `audience`가 이 서버의 주소다.
- TLS를 직접 하지 않는다. HTTPS reverse proxy 뒤에 둔다. 쿠키는 쓰지 않는다.
