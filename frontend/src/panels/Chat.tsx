import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  chatUrl,
  fetchMessages,
  fetchRole,
  postMessage,
  setHidden,
  signIn,
  validText,
  type ChatMessage,
  type ChatRole,
  type ChatSession,
} from "../chat";
import {
  PAGE,
  ROLES,
  composerState,
  liveSession,
  loadSession,
  mergeMessages,
  refreshMessages,
  roleOf,
  saveSession,
} from "../chatView";
import { demoViewer } from "../demo";
import { failureText, same, short, webStore, type VaultView } from "../ui";

const seconds = () => Math.floor(Date.now() / 1000);
const when = (createdAt: number) =>
  new Date(createdAt * 1000).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function Chat({ view }: { view: VaultView }) {
  const { app, vault, state, viewer, own } = view;
  const { demo, account, busy } = app;
  const [fetched, setFetched] = useState<ChatMessage[]>([]),
    [older, setOlder] = useState(false),
    [failure, setFailure] = useState(""),
    [session, setSession] = useState<ChatSession | null>(null),
    [joined, setJoined] = useState(false),
    [text, setText] = useState("");
  const [answer, setAnswer] = useState<{
    role: ChatRole;
    canPost: boolean;
  } | null>(null);
  const box = useRef<HTMLDivElement>(null),
    inner = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    seen = useRef({ first: 0, height: 0 }),
    last = useRef(0);
  const sample = demo
    ? app.world.vaults.find((row) => same(row.address, vault))
    : undefined;
  const rows = demo ? (sample?.messages ?? []) : fetched;
  const mine = demo ? roleOf(state, viewer) : answer?.role;
  // Null until the server has answered: a post is then left for the server to decide.
  const allowed = demo ? { canPost: mine !== "visitor" } : answer;
  const signed = demo ? joined : !!session;
  const composer = composerState(!!viewer, allowed, signed);
  const off = !demo && !chatUrl;
  const { shares } = state;
  useEffect(() => {
    if (demo) return;
    const store = webStore("session");
    setSession(store ? loadSession(store, account, seconds()) : null);
  }, [demo, account]);
  useEffect(() => {
    setAnswer(null);
    if (demo || off || !account) return;
    let active = true,
      known = false;
    const ask = () =>
      fetchRole(vault, account).then(
        (value) => {
          if (!active) return;
          known = true;
          setAnswer(value);
        },
        (e) => active && setFailure(failureText(e)),
      );
    void ask();
    // Asked again until the server answers: a failed read must not leave the role unknown.
    const timer = setInterval(() => !known && void ask(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // A deposit or a redeem changes the role the server answers.
  }, [demo, off, vault, account, shares]);
  useEffect(() => {
    if (demo || off) return;
    let active = true,
      round = 0;
    last.current = 0;
    setFetched([]);
    const poll = async () => {
      const turn = round++;
      if (turn && document.hidden) return;
      try {
        const page = await fetchMessages(
          vault,
          last.current ? { after: last.current, limit: PAGE } : { limit: PAGE },
        );
        if (!active) return;
        if (!last.current) setOlder(page.length === PAGE);
        if (page.length)
          last.current = Math.max(last.current, page[page.length - 1].id);
        setFetched((current) => mergeMessages(current, page));
        // Every sixth round the newest page is read again, so that a message hidden or restored
        // by the operator changes for those who already have it on screen.
        if (turn && turn % 6 === 0) {
          const newest = await fetchMessages(vault, { limit: PAGE });
          if (!active) return;
          setFetched((current) => refreshMessages(current, newest));
        }
        setFailure("");
      } catch (e) {
        if (active) setFailure(failureText(e));
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [demo, off, vault]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = rows[0]?.id ?? 0;
    // Older messages were added above: the view stays on what was being read.
    if (seen.current.first && first < seen.current.first)
      el.scrollTop += el.scrollHeight - seen.current.height;
    else if (pinned.current) el.scrollTop = el.scrollHeight;
    seen.current = { first, height: el.scrollHeight };
  }, [rows]);
  useEffect(() => {
    const el = box.current;
    if (!el || !inner.current) return;
    // Text that reflows (a font arriving, a narrower window) must not push the newest message
    // out of view while the reader is at the end.
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner.current);
    return () => observer.disconnect();
  }, [off]);
  function drop() {
    const store = webStore("session");
    if (store) saveSession(store, null);
    setSession(null);
  }
  function live() {
    const current = liveSession(session, account, seconds());
    if (!current) {
      drop();
      throw new Error(
        "대화 세션이 만료되었습니다. 지갑 서명으로 다시 참여하세요.",
      );
    }
    return current;
  }
  // The server answers UNAUTHORIZED for a session it no longer accepts: ask for a new one.
  async function authorized<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: unknown }).code === "UNAUTHORIZED") drop();
      throw e;
    }
  }
  async function join() {
    await app.run(async () => {
      if (demo) {
        setJoined(true);
        app.demoNotice("지갑 서명으로 대화에 참여하는 과정을 모의했습니다.");
        return;
      }
      const { p, a } = app.wallet();
      const opened = await signIn(p, a);
      const store = webStore("session");
      if (store) saveSession(store, opened);
      setSession(opened);
      app.say("대화에 참여했습니다. 이 서명은 거래를 보내지 않습니다.");
    });
  }
  async function post() {
    await app.run(async () => {
      const clean = validText(text);
      if (allowed && !allowed.canPost)
        throw new Error("이 볼트의 운용자와 예치자만 글을 쓸 수 있습니다.");
      pinned.current = true;
      if (demo) {
        const id =
          Math.max(
            0,
            ...app.world.vaults.flatMap((row) =>
              row.messages.map((message) => message.id),
            ),
          ) + 1;
        view.demoApply((row) => ({
          ...row,
          messages: [
            ...row.messages,
            {
              id,
              vault,
              author: demoViewer,
              role: roleOf(state, demoViewer),
              text: clean,
              createdAt: seconds(),
              hidden: false,
            },
          ],
        }));
        setText("");
        app.demoNotice("메시지를 이 브라우저의 예시 대화에만 추가했습니다.");
        return;
      }
      const current = live();
      const sent = await authorized(() => postMessage(current, vault, clean));
      // The forward cursor is left alone: messages others posted in between are still to come.
      setFetched((messages) => mergeMessages(messages, [sent]));
      setText("");
    });
  }
  async function hide(message: ChatMessage, hidden: boolean) {
    await app.run(async () => {
      if (demo) {
        view.demoApply((row) => ({
          ...row,
          messages: row.messages.map((entry) =>
            entry.id === message.id ? { ...entry, hidden } : entry,
          ),
        }));
        app.demoNotice(
          hidden ? "메시지를 숨겼습니다." : "메시지를 다시 표시했습니다.",
        );
        return;
      }
      const current = live();
      const changed = await authorized(() =>
        setHidden(current, vault, message.id, hidden),
      );
      setFetched((messages) => mergeMessages(messages, [changed]));
    });
  }
  async function history() {
    const first = fetched[0];
    if (!first) return;
    try {
      const page = await fetchMessages(vault, {
        before: first.id,
        limit: PAGE,
      });
      setOlder(page.length === PAGE);
      setFetched((current) => mergeMessages(current, page));
      setFailure("");
    } catch (e) {
      setFailure(failureText(e));
    }
  }
  return (
    <div className="form chat">
      <h2>대화</h2>
      <p>운용자와 예치자가 이 볼트에 대해 이야기하는 곳입니다.</p>
      <p className="note">
        대화는 누구나 볼 수 있는 공개 기록입니다. 글은 각 작성자의 의견이며
        플랫폼의 투자 조언이 아닙니다. 개인키·시드 문구·서명 키 암호를 묻는
        글에는 답하지 마세요.
      </p>
      {off ? (
        <p className="inline-warning">
          대화 서버가 설정되지 않았습니다. 빌드 설정의 VITE_CHAT_URL에 대화 서버
          주소를 넣으면 이 볼트의 대화를 볼 수 있습니다.
        </p>
      ) : (
        <>
          <div
            className="chat-list"
            ref={box}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            <div className="chat-rows" ref={inner}>
              {older && (
                <button className="quiet" onClick={history}>
                  이전 메시지
                </button>
              )}
              {!rows.length && <p className="empty">아직 메시지가 없습니다.</p>}
              {rows.map((message) => (
                <article
                  key={message.id}
                  className={
                    "message" +
                    (viewer && same(viewer, message.author) ? " mine" : "")
                  }
                >
                  <header>
                    <code title={message.author}>{short(message.author)}</code>
                    <span className={"tag " + message.role}>
                      {ROLES[message.role]}
                    </span>
                    <time
                      dateTime={new Date(
                        message.createdAt * 1000,
                      ).toISOString()}
                    >
                      {when(message.createdAt)}
                    </time>
                    {own && signed && (
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() => hide(message, !message.hidden)}
                      >
                        {message.hidden ? "다시 보이기" : "숨기기"}
                      </button>
                    )}
                  </header>
                  {message.hidden || message.text === null ? (
                    <p className="hidden">숨긴 메시지입니다</p>
                  ) : (
                    <p>{message.text}</p>
                  )}
                </article>
              ))}
            </div>
          </div>
          {failure && <p className="inline-warning">{failure}</p>}
          {composer === "connect" ? (
            <p className="note">
              지갑을 연결하면 글을 쓸 수 있습니다. 읽기는 누구나 가능합니다.
            </p>
          ) : composer === "checking" ? (
            <p className="note">글쓰기 권한을 확인하는 중…</p>
          ) : (
            <>
              {mine ? (
                <div className="detail">
                  <span>내 역할</span>
                  <b>
                    <span className={"tag " + mine}>{ROLES[mine]}</span>
                  </b>
                </div>
              ) : (
                <p className="note">
                  내 역할은 아직 확인하지 못했습니다. 글을 보내면 대화 서버가 그
                  요청에서 운용자·예치자인지 확인하고, 아니면 받지 않습니다.
                </p>
              )}
              {composer === "refused" ? (
                <p className="inline-warning">
                  이 볼트의 운용자와 예치자만 글을 쓸 수 있습니다
                </p>
              ) : composer === "join" ? (
                <>
                  <button className="primary" disabled={busy} onClick={join}>
                    지갑 서명으로 참여 <span>↗</span>
                  </button>
                  <small>
                    거래를 보내지 않는 서명 한 번으로 참여합니다. 세션은 이
                    브라우저 탭에만 보관되며 만료되거나 지갑 계정이 바뀌면 다시
                    서명합니다.
                  </small>
                </>
              ) : (
                <div className="composer">
                  <textarea
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void post();
                      }
                    }}
                    placeholder="메시지 입력 · Enter로 보내기, Shift+Enter로 줄바꿈"
                  />
                  <button disabled={busy || !text.trim()} onClick={post}>
                    보내기
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
