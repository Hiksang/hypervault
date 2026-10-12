import { send, verifierAbi, writesEnabled, type Guards } from "../chain";
import { demoRecord } from "../demo";
import { duration, format } from "../domain";
import { PRICE_RECORDS, priceHistory } from "../scope";
import { Detail, type Loaded, type VaultView } from "../ui";

/**
 * The Vault's recorded share prices, and the button that records one. `recordPrice` is open to
 * anyone, so this is shown to every visitor: a deposit is priced and an exit settles only with
 * half a window of this history behind them, counted from the owner's last answer to a report.
 * Nothing is shown for a verifier without records.
 */
export function Records({
  view,
  guards,
  full = false,
}: {
  view: VaultView;
  guards: Loaded<Guards | null> | undefined;
  full?: boolean;
}) {
  const { app, vault, state, blockWrite, act } = view;
  const g = guards?.value;
  if (!g) return null;
  const { verifier } = g;
  const history = priceHistory(
    g.records,
    g.priceWindow,
    g.blockTime,
    g.answeredAt,
  );
  const half = g.priceWindow / 2n;
  const none = history.uncounted
    ? "신고에 답한 뒤의 기록이 없어"
    : "창 안에 기록이 없어";
  const when = history.aged
    ? "지금은 충족합니다."
    : history.agedIn !== null
      ? `${duration(history.agedIn)} 뒤에 충족됩니다.`
      : history.recordIn > 0n
        ? `${none}, 다음 표본이 추가된 때부터 ${duration(half)} 뒤에 충족됩니다.`
        : `${none}, 지금 기록하면 ${duration(half)} 뒤에 충족됩니다.`;
  async function record() {
    await act(async () => {
      // The verifier address comes from the Vault: an upgraded one could name any contract.
      const refuse = () => {
        throw new Error("코드가 바뀐 볼트에는 가격 기록을 보내지 않습니다.");
      };
      if (state.codeChanged) refuse();
      if (app.demo) {
        view.demoApply((row) => demoRecord(row, Date.now()));
        app.demoNotice("지분 가격 기록을 모의했습니다.");
        return;
      }
      const { p, a } = app.wallet();
      if ((await view.current()).codeChanged) refuse();
      const receipt = await send(
        p,
        a,
        verifier,
        "recordPrice",
        [vault],
        verifierAbi,
      );
      app.say(`가격 기록 확정 · ${receipt.transactionHash}`);
    });
  }
  return (
    <section className="block records">
      <div className="block-head">
        <h3>가격 기록</h3>
        <span className={"tag " + (history.aged ? "ok" : "warn")}>
          {history.aged ? "기록 기간 충족" : "기록 기간 부족"}
        </span>
      </div>
      {full && (
        <Detail label="보관된 기록">{`${history.count} / ${PRICE_RECORDS}`}</Detail>
      )}
      <Detail label="가장 최근 기록">
        {history.newestAge === null
          ? "없음"
          : `${duration(history.newestAge)} 전`}
      </Detail>
      <Detail
        label={
          history.uncounted
            ? "신고에 답한 뒤의 가장 오래된 기록"
            : "창 안의 가장 오래된 기록"
        }
      >
        {history.oldestAge === null
          ? "없음"
          : `${duration(history.oldestAge)} 전`}
      </Detail>
      {history.uncounted > 0 && (
        <Detail label="이력으로 세지 않는 기록">
          {`${history.uncounted}건 · 신고에 답한 ${duration(g.blockTime - g.answeredAt)} 전까지`}
        </Detail>
      )}
      {full && (
        <>
          <Detail label="가격 창">{duration(g.priceWindow)}</Detail>
          <Detail label="급락 한도">{format(g.maxDrawdownBps, 2, 2)}%</Detail>
        </>
      )}
      <button disabled={blockWrite || state.codeChanged} onClick={record}>
        가격 기록
      </button>
      <small>
        {state.phase === 3 &&
          "현금만 보유한 단계에서는 기록 없이 현금으로 입금 가격을 냅니다. 다음 조건은 운용을 시작한 뒤부터 적용됩니다. "}
        입금 가격과 출금 정산에는 가격 창({duration(g.priceWindow)}) 안에 창의
        절반({duration(half)}) 이상 지난 기록이 있어야 합니다.{" "}
        {history.uncounted > 0 &&
          "운용자가 신고된 대상을 범위에 등록해 신고에 답하면, 그때까지의 기록은 이 이력으로 세지 않고 최고 가격의 기준으로만 남습니다. "}
        {when} 기록은 누구나 할 수 있습니다.{" "}
        {history.recordIn > 0n
          ? `다음 표본은 ${duration(history.recordIn)} 뒤에 추가되고, 그 전에는 지분 가격이 직전 기록보다 높을 때만 그 기록을 올립니다.`
          : "지금 기록하면 새 표본이 추가됩니다."}
      </small>
      {state.codeChanged && (
        <small>
          코드가 바뀐 볼트는 검증기 주소도 스스로 답한 값이어서, 이 화면은
          그곳으로 가격 기록을 보내지 않습니다.
        </small>
      )}
      {!app.demo && (!writesEnabled || !app.account) && (
        <small>
          {writesEnabled
            ? "지갑을 연결하면 기록할 수 있습니다."
            : "읽기 전용 설정에서는 기록을 보낼 수 없습니다."}
        </small>
      )}
    </section>
  );
}
