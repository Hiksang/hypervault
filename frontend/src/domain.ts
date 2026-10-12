export function units(value: string, decimals = 6): bigint {
  if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(value))
    throw new Error(`소수점 ${decimals}자리까지 정확한 양수를 입력하세요.`);
  const [whole, fraction = ""] = value.split(".");
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (result <= 0n) throw new Error("0보다 큰 금액을 입력하세요.");
  return result;
}
export function format(
  value: bigint | null | undefined,
  decimals = 6,
  digits = 2,
): string {
  if (value === undefined || value === null) return "—";
  const negative = value < 0n;
  const n = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  return `${negative ? "-" : ""}${(n / scale).toLocaleString("en-US")}${digits ? "." + (n % scale).toString().padStart(decimals, "0").slice(0, digits).padEnd(digits, "0") : ""}`;
}
/** The longest Vault name, in UTF-8 bytes. */
export const NAME_BYTES = 96;
/** The rule the Vault's own code keeps for its name: one a Vault breaks was not set by that code. */
export function nameAllowed(value: string): boolean {
  return (
    !!value &&
    new TextEncoder().encode(value).length <= NAME_BYTES &&
    !value.startsWith(" ") &&
    !value.endsWith(" ") &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
export function validName(value: string) {
  if (!nameAllowed(value))
    throw new Error(
      "이름은 앞뒤 공백·제어문자 없이 UTF-8 1~96바이트여야 합니다.",
    );
  return value;
}
/**
 * A name as the page shows and stores it: what a contract answered, cut to the bytes a name may
 * have, never in the middle of a character.
 */
export function boundedName(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= NAME_BYTES) return value;
  let end = NAME_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
export function feeBps(value: string) {
  const n = /^0(?:\.0{1,2})?$/.test(value) ? 0n : units(value, 2);
  if (n > 10000n) throw new Error("성과수수료는 0~100%입니다.");
  return Number(n);
}
export function minShares(quote: bigint, bps = 50n) {
  if (bps < 0n || bps > 10000n) throw new Error("잘못된 슬리피지");
  return (quote * (10000n - bps)) / 10000n;
}
export const phases = [
  "초기화 전",
  "Core 활성화 확인 중",
  "운용 준비",
  "현금 보유",
  "운용 중",
  "출금 정산 중",
];
/**
 * Whether this page offers a deposit. Never to a Vault whose code changed since it was created:
 * what such a Vault reports as its phase and capacity is not relied on.
 */
export function depositOpen(
  phase: number,
  capacity: bigint,
  pending: bigint,
  fresh: boolean,
  codeChanged = false,
) {
  return (
    !codeChanged &&
    [2, 3, 4].includes(phase) &&
    capacity > 0n &&
    pending === 0n &&
    fresh
  );
}
/**
 * USDC (6 decimals) per whole share (9 decimals), cut not rounded. A display ratio: a deposit is
 * priced by the Vault's own preview, which rounds against the depositor.
 */
export function sharePrice(
  nav: bigint | null | undefined,
  supply: bigint | undefined,
): bigint | null {
  if (nav === null || nav === undefined || !supply) return null;
  return (nav * 10n ** 9n) / supply;
}
/** A length of time in the two largest units that are not zero, e.g. "3시간 5분". */
export function duration(seconds: bigint | number): string {
  const total = Number(seconds) > 0 ? Math.floor(Number(seconds)) : 0;
  const parts = [
    [Math.floor(total / 86400), "일"],
    [Math.floor((total % 86400) / 3600), "시간"],
    [Math.floor((total % 3600) / 60), "분"],
    [total % 60, "초"],
  ] as const;
  const first = parts.findIndex(([value]) => value > 0);
  if (first < 0) return "0초";
  return parts
    .slice(first, first + 2)
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
}
/** A whole number in raw units that fits `bits`: a number up to 32 bits, a bigint above. */
export function uint(value: string, bits: number) {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("원시 단위의 정수를 입력하세요.");
  const n = BigInt(value);
  if (n >= 2n ** BigInt(bits)) throw new Error("정수 범위 초과");
  return bits <= 32 ? Number(n) : n;
}
