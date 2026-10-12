import { useState } from "react";
import {
  address,
  approve,
  createdVault,
  factoryAbi,
  read,
  type FactoryConfig,
} from "../chain";
import { send } from "../chain";
import { demoCreate } from "../demo";
import { feeBps, units, validName } from "../domain";
import { Banner, go, type Shell } from "../ui";

export function Create({ app }: { app: Shell }) {
  const { demo, busy, factory } = app;
  const [name, setName] = useState("나의 USDC 볼트"),
    [fee, setFee] = useState("10"),
    [minimum, setMinimum] = useState("10"),
    [activation, setActivation] = useState("1");
  async function create() {
    await app.run(async () => {
      const title = validName(name),
        rate = feeBps(fee),
        min = units(minimum),
        maxCost = /^0(?:\.0{1,6})?$/.test(activation) ? 0n : units(activation);
      if (demo) {
        const made = demoCreate(
          app.world,
          { name: title, fee: BigInt(rate), minimum: min },
          Date.now(),
        );
        app.setWorld(made.world);
        go({ page: "vault", vault: made.vault, tab: "manage" });
        // The confirmation belongs to the new vault's page, which opens next.
        app.demoNotice(
          "창설자 지분 100개를 발행했습니다. Core 활성화 확인은 별도 단계입니다.",
          made.vault,
        );
        return;
      }
      const { p, a } = app.wallet();
      const f = address(factory);
      const config = await read<FactoryConfig>(
        f,
        "templateConfig",
        [],
        factoryAbi,
      );
      if (config.activationCost > maxCost || min > config.maximumAssets)
        throw new Error("활성화 비용 상한 또는 최소 입금 설정을 확인하세요.");
      app.say("창설자 100 USDC + 설정된 활성화 예산을 승인합니다.", "create");
      await approve(p, a, config.asset, f, 100_000000n + config.activationCost);
      const receipt = await send(
        p,
        a,
        f,
        "createVaultAndFund",
        [title, maxCost, rate, min],
        factoryAbi,
      );
      const created = createdVault(receipt.logs);
      go({ page: "vault", vault: created, tab: "manage" });
      app.say(`Vault 생성 확정 · ${receipt.transactionHash}`, created);
    }, "create");
  }
  return (
    <>
      <div className="eyebrow">
        MANAGED USDC VAULTS <span>/</span> CREATE
      </div>
      <div className="title-row">
        <div>
          <h1>나의 볼트 만들기</h1>
          <p>연결된 지갑이 변경 불가 운용자가 됩니다.</p>
        </div>
      </div>
      <Banner app={app} />
      <div className="workspace create">
        <section className="transaction">
          <div className="form">
            <h2>볼트 조건</h2>
            <p>이름과 조건을 정하고 창설자 자기자본 100 USDC를 납입합니다.</p>
            <label>
              볼트 이름
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="two">
              <label>
                성과수수료 (%)
                <input
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                최소 입금 (USDC)
                <input
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
            <label>
              활성화 비용 상한 (USDC)
              <input
                value={activation}
                onChange={(e) => setActivation(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <div className="detail">
              <span>창설자 자기자본</span>
              <b>100.00 USDC</b>
            </div>
            <small>
              실제 결제는 100 USDC + Factory의 활성화 예산입니다. 창설자
              원가·지분은 100 USDC 기준이며 Core 도착 확인은 후속 단계입니다.
            </small>
            <button
              className="primary"
              disabled={busy || !app.canWrite || (!demo && !factory)}
              onClick={create}
            >
              {busy ? "처리 중…" : "USDC 승인 후 생성"} <span>↗</span>
            </button>
          </div>
        </section>
        <section className="portfolio">
          <div className="section-head">
            <h2>생성 후 진행 순서</h2>
            <span>OPERATOR GUIDE</span>
          </div>
          <ol className="steps">
            <li>
              <b>Core 활성화 확인</b>
              생성 다음 블록부터 운용 탭의 “Core 결과 확인”으로 Vault의
              HyperCore 계정 활성화를 확정합니다.
            </li>
            <li>
              <b>평가 범위 등록</b>
              거래할 토큰과 perp DEX를 평가 범위에 먼저 등록하고 스위치를
              켭니다. 범위 밖 보유는 NAV에 보이지 않습니다.
            </li>
            <li>
              <b>가격 기록</b>
              지분 가격을 기록하고 가격 창의 절반이 지나면 다른 사용자의 입금이
              열립니다. 출금 정산에도 같은 기록이 필요하므로, 누구나 누를 수
              있는 가격 기록을 끊기지 않게 이어 갑니다.
            </li>
            <li>
              <b>주문 서명 키 등록</b>
              거래 탭에서 이 브라우저 전용 서명 키를 만들어 Vault에 등록한 뒤
              주문을 냅니다. 이 키는 출금할 수 없습니다.
            </li>
            <li>
              <b>대화</b>
              예치자와 방문자에게 운용 방침을 알리고 질문에 답합니다.
            </li>
          </ol>
        </section>
      </div>
    </>
  );
}
