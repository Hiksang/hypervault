// MessagePack for the value shapes Hyperliquid actions use: nil, bool, integer, string, array and
// string-keyed map. The exchange hashes these exact bytes, so key order is the insertion order
// and every integer takes its smallest encoding, as the official Python SDK's msgpack does.
const utf8 = new TextEncoder();

export function pack(value: unknown): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

function write(value: unknown, out: number[]): void {
  if (value === null) out.push(0xc0);
  else if (typeof value === "boolean") out.push(value ? 0xc3 : 0xc2);
  else if (typeof value === "bigint") integer(value, out);
  else if (typeof value === "number") {
    // Prices and sizes travel as strings: a float here would be hashed differently by the node.
    if (!Number.isSafeInteger(value))
      throw new Error("msgpack: not an integer");
    integer(BigInt(value), out);
  } else if (typeof value === "string") {
    const bytes = utf8.encode(value);
    header(bytes.length, [0xa0, 32], [0xd9, 0xda, 0xdb], out);
    out.push(...bytes);
  } else if (Array.isArray(value)) {
    header(value.length, [0x90, 16], [undefined, 0xdc, 0xdd], out);
    for (const item of value) write(item, out);
  } else if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    header(entries.length, [0x80, 16], [undefined, 0xde, 0xdf], out);
    for (const [key, item] of entries) {
      write(key, out);
      write(item, out);
    }
  } else throw new Error("msgpack: unsupported value");
}

function header(
  length: number,
  [fix, limit]: [number, number],
  [one, two, four]: [number | undefined, number, number],
  out: number[],
): void {
  if (length < limit) out.push(fix | length);
  else if (one !== undefined && length < 0x100) out.push(one, length);
  else if (length < 0x10000) out.push(two, ...bytes(BigInt(length), 2));
  else out.push(four, ...bytes(BigInt(length), 4));
}

function integer(n: bigint, out: number[]): void {
  if (n >= 0n) {
    if (n < 0x80n) out.push(Number(n));
    else if (n < 0x100n) out.push(0xcc, Number(n));
    else if (n < 0x10000n) out.push(0xcd, ...bytes(n, 2));
    else if (n < 0x100000000n) out.push(0xce, ...bytes(n, 4));
    else if (n < 2n ** 64n) out.push(0xcf, ...bytes(n, 8));
    else throw new Error("msgpack: integer out of range");
  } else if (n >= -32n) out.push(Number(BigInt.asUintN(8, n)));
  else if (n >= -0x80n) out.push(0xd0, ...bytes(BigInt.asUintN(8, n), 1));
  else if (n >= -0x8000n) out.push(0xd1, ...bytes(BigInt.asUintN(16, n), 2));
  else if (n >= -0x80000000n)
    out.push(0xd2, ...bytes(BigInt.asUintN(32, n), 4));
  else if (n >= -(2n ** 63n))
    out.push(0xd3, ...bytes(BigInt.asUintN(64, n), 8));
  else throw new Error("msgpack: integer out of range");
}

function bytes(n: bigint, size: number): number[] {
  const out = new Array<number>(size);
  for (let i = size - 1; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}
