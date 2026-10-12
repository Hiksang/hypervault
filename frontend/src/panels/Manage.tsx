import { useState } from "react";
import { zeroAddress } from "viem";
import { address, send, type Address, type Guards } from "../chain";
import { demoBeginExit, demoSettle, demoSubmit, demoSync } from "../demo";
import { duration, uint, units, validName } from "../domain";
import type { Loaded, VaultView } from "../ui";
import { Records } from "./Records";

export function Manage({
  view,
  guards,
}: {
  view: VaultView;
  guards: Loaded<Guards | null> | undefined;
}) {
  const { app, vault, state, own, fresh, blockWrite, act } = view;
  const { demo } = app;
  const [name, setName] = useState(state.name),
    [agent, setAgent] = useState(""),
    [coreAmount, setCoreAmount] = useState("10"),
    [dex, setDex] = useState("4294967295"),
    [mode, setMode] = useState("3"),
    [token, setToken] = useState("0"),
    [proof, setProof] = useState("0x");
  // The address a registration was asked for, shown whole before anything is sent.
  const [granting, setGranting] = useState<Address | null>(null);
  async function manage(fn: string, args: readonly unknown[]) {
    await act(async () => {
      if (!own) throw new Error("Vault 운용자만 사용할 수 있습니다.");
      if (demo) {
        app.demoNotice(
          `${fn} 요청을 모의했습니다. Core 효과는 별도 확인이 필요합니다.`,
        );
        return;
      }
      const { p, a } = app.wallet();
      await view.current();
      const receipt = await send(p, a, vault, fn, args);
      app.say(
        `EVM 요청 확정 · ${receipt.transactionHash} · Core 효과는 별도 확인 필요`,
      );
    });
  }
  async function ownerSend(fn: string, args: readonly unknown[]) {
    if (demo) {
      app.demoNotice(`${fn}을 모의했습니다.`);
      return;
    }
    await view.ownerSend(fn, args);
    app.say("EVM 요청 확정 · Core 효과는 별도 확인 필요");
  }
  function hex() {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(proof))
      throw new Error("유효한 hex bytes가 필요합니다.");
    return proof;
  }
  return (
    <div className="form">
      <h2>운용자 콘솔</h2>
      <p>지갑의 HYPE 가스가 필요합니다. API 개인키는 입력하지 않습니다.</p>
      {!own && (
        <p className="inline-warning">이 Vault의 owner만 관리할 수 있습니다.</p>
      )}
      <fieldset disabled={blockWrite || !own || !fresh}>
        <label>
          볼트 이름
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          onClick={() =>
            void act(async () => {
              validName(name);
              if (demo) {
                view.demoApply((row) => ({
                  ...row,
                  state: { ...row.state, name },
                }));
                app.demoNotice("이름을 변경했습니다.");
              } else {
                const { p, a } = app.wallet();
                await send(p, a, vault, "setVaultName", [name]);
                app.say("이름 변경 확정");
              }
            })
          }
        >
          이름 저장
        </button>
        <label>
          Vault 전용 API wallet 주소
          <input
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              setGranting(null);
            }}
            placeholder="0x… (공개 주소만)"
            spellCheck={false}
          />
        </label>
        <small>
          다른 도구에서 만든 agent의 주소를 등록할 때 씁니다. 등록한 주소의 키를
          가진 사람은 이 Vault의 Core 계정 전체로 주문할 수 있습니다(출금은 할
          수 없습니다). 이 브라우저에서 주문하려면 거래 탭에서 서명 키를
          만드세요.
        </small>
        {granting && (
          <div className="inline-warning action grant">
            <span>
              <b>이 주소를 API wallet으로 등록합니다.</b>{" "}
              <code className="address">{granting}</code> 이 주소의 키를 가진
              사람은 Vault의 Core 계정에 있는 자금 전체로 거래할 수 있습니다.
              키를 직접 관리하는 주소가 맞는지 한 글자씩 확인하세요.
            </span>
            <span className="pair">
              <button
                onClick={() =>
                  void act(async () => {
                    setGranting(null);
                    if (demo) {
                      view.demoApply((row) =>
                        demoSubmit(row, { kind: "agent", agent: granting }),
                      );
                      app.demoNotice("API wallet 등록을 모의했습니다.");
                      return;
                    }
                    const w = app.wallet();
                    await send(w.p, w.a, vault, "setApiWallet", [granting]);
                    app.say("등록 요청 제출 · Core 확인 필요");
                  })
                }
              >
                등록 확정
              </button>
              <button className="quiet" onClick={() => setGranting(null)}>
                취소
              </button>
            </span>
          </div>
        )}
        <div className="two">
          <button
            disabled={!!granting}
            onClick={() => {
              // Nothing is sent yet: the address is shown whole first, with what it grants.
              try {
                setGranting(address(agent.trim()));
              } catch (e) {
                app.fail(e);
              }
            }}
          >
            API wallet 등록
          </button>
          <button
            disabled={state.agent === zeroAddress}
            onClick={() =>
              demo
                ? void act(async () => {
                    view.demoApply((row) =>
                      demoSubmit(row, { kind: "revoke" }),
                    );
                    app.demoNotice("API wallet 등록 해지를 모의했습니다.");
                  })
                : manage("revokeApiWallet", [])
            }
          >
            등록 해지
          </button>
        </div>
        <details>
          <summary>Core 자금 · Borrow / Lend · 계정 모드</summary>
          <label>
            USDC 금액 / lending Core 원시 수량
            <input
              value={coreAmount}
              onChange={(e) => setCoreAmount(e.target.value)}
            />
          </label>
          <label>
            출발 DEX (spot = 4294967295)
            <input value={dex} onChange={(e) => setDex(e.target.value)} />
          </label>
          <div className="two">
            <button
              onClick={() =>
                void act(async () => {
                  await ownerSend("depositToCore", [units(coreAmount)]);
                })
              }
            >
              USDC → Core
            </button>
            <button
              onClick={() =>
                void act(async () => {
                  await ownerSend("recallUsdcFromCore", [
                    uint(dex, 32),
                    units(coreAmount),
                  ]);
                })
              }
            >
              Core → EVM
            </button>
          </div>
          <label>
            Lending token index
            <input value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <small>
            Lending 수량은 토큰별 Core 원시 단위입니다. USDC 소수 표기와
            다릅니다.
          </small>
          <div className="two">
            <button
              onClick={() =>
                void act(async () => {
                  await ownerSend("supplyToLending", [
                    uint(token, 64),
                    uint(coreAmount, 64),
                  ]);
                })
              }
            >
              Lending 공급
            </button>
            <button
              onClick={() =>
                void act(async () => {
                  await ownerSend("withdrawAllFromLending", [uint(token, 64)]);
                })
              }
            >
              Lending 전액 회수
            </button>
          </div>
          <label>
            계정 모드
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="1">Standard</option>
              <option value="2">Unified</option>
              <option value="3">Portfolio Margin</option>
            </select>
          </label>
          <button onClick={() => manage("setAbstraction", [Number(mode)])}>
            계정 모드 요청
          </button>
        </details>
        <details open={state.pending !== 0n || state.phase === 5}>
          <summary>출금 정리와 온체인 증거 제출</summary>
          <button
            onClick={() =>
              demo
                ? void act(async () => {
                    view.demoApply(demoBeginExit);
                    app.demoNotice(
                      "출금 정리 시작을 모의했습니다. 입금은 닫히고 정산만 남습니다.",
                    );
                  })
                : manage("beginExit", [state.epoch])
            }
          >
            현재 출금 epoch 정리 시작
          </button>
          <ul className="notes">
            <li>
              <b>정산 조건</b> 확인을 기다리는 관리 액션이 없고 API wallet
              등록이 해지되어 있어야 합니다. 성립하는 범위 밖 보유 신고가 없어야
              하고, Core의 포지션과 차입을 정리해 자금을 모두 회수해야 합니다.
            </li>
            <li>
              <b>가격 기록</b> 입금과 같은 기록이 필요합니다. 가격 창 안에 창의
              절반
              {guards?.value &&
                `(${duration(guards.value.priceWindow / 2n)})`}{" "}
              이상 지난 기록이 없으면 정산이 거부되므로, 정리하는 동안에도
              기록이 끊기지 않게 하세요. 관리 액션의 확인을 기다리는 중에도
              기록할 수 있습니다. 신고된 대상을 범위에 등록해 신고에 답했다면 그
              뒤의 기록만 셉니다. 회수한 현금 기준의 지분 가격이 창 안 최고
              기록보다 한도 넘게 낮으면 그 기록이 창을 벗어날 때까지 미뤄집니다.
              지분이 남아 있지 않은 Vault의 정산에는 기록이 필요하지 않습니다.
            </li>
          </ul>
          <Records view={view} guards={guards} />
          {demo && (
            <small>
              데모는 Core 자금 회수를 모의하지 않습니다. 정산이 확정되는 흐름은
              이미 회수를 마친 예시 볼트 Genesis Exit에서 볼 수 있습니다.
            </small>
          )}
          <label>
            검증기 규격의 증거 bytes
            <input
              value={proof}
              onChange={(e) => setProof(e.target.value)}
              placeholder="0x…"
            />
          </label>
          <small>
            이 화면은 증거를 생성하지 않습니다. EVM 영수증만으로 Core 성공을
            확정할 수 없습니다.
          </small>
          <div className="two">
            <button
              onClick={() =>
                void act(async () => {
                  const bytes = hex();
                  if (demo) {
                    view.demoApply(demoSync);
                    app.demoNotice("Core 결과 확인을 모의했습니다.");
                    return;
                  }
                  await ownerSend(
                    state.phase === 1 ? "finalizeActivation" : "syncCoreAction",
                    state.phase === 1 ? [bytes] : [state.pending, bytes],
                  );
                })
              }
            >
              Core 결과 확인
            </button>
            <button
              onClick={() =>
                void act(async () => {
                  const bytes = hex();
                  if (demo) {
                    view.demoApply((row) => demoSettle(row, Date.now()));
                    app.demoNotice(
                      "출금 정산을 모의했습니다. 볼트는 현금 보유 단계로 돌아갑니다.",
                    );
                    return;
                  }
                  await ownerSend("settleEpoch", [state.epoch, bytes]);
                })
              }
            >
              출금 정산
            </button>
          </div>
        </details>
      </fieldset>
    </div>
  );
}
