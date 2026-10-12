import { formatUnits, parseUnits } from "viem";
export function assetUnits(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 21 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) ||
    (value.split(".")[1]?.length ?? 0) > decimals
  )
    throw new Error(`소수점 ${decimals}자리 이내의 양수를 입력하세요.`);
  const result = parseUnits(value, decimals);
  if (result <= 0n || result >= 2n ** 128n)
    throw new Error("금액 범위를 확인하세요.");
  return result;
}
export const assetAmount = (value: bigint, decimals: number) =>
  formatUnits(value, decimals);
