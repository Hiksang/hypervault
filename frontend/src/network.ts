/** The chains this page can be built for. */
export const CHAIN_IDS: readonly number[] = [999, 998, 31337];

/**
 * The chain a build is for: what `VITE_CHAIN_ID` says, mainnet when it says nothing, and null
 * when it names no chain this page knows. The setting is taken as plain digits, here and nowhere
 * else: the page and its Content-Security-Policy must not read it differently.
 */
export function chainIdOf(configured?: string): number | null {
  if (!configured) return 999;
  if (!/^[1-9][0-9]*$/.test(configured)) return null;
  const id = Number(configured);
  return CHAIN_IDS.includes(id) ? id : null;
}

/**
 * The EVM RPC the page reads: the configured one, or the chain's public one. One place decides
 * it, because the built page's Content-Security-Policy must name the very same origin.
 */
export function rpcUrl(chainId: number, configured?: string): string {
  return (
    configured ||
    (chainId === 999
      ? "https://rpc.hyperliquid.xyz/evm"
      : chainId === 998
        ? "https://rpc.hyperliquid-testnet.xyz/evm"
        : "http://127.0.0.1:8545")
  );
}

type Request = (args: {
  method: string;
  params?: unknown[];
}) => Promise<unknown>;

/** EIP-3085 parameters to add the chain to a wallet that does not know it yet. */
export function addChainParams(chainId: number, configuredRpc?: string) {
  // A wallet keeps this RPC for good: give it the public endpoint, not a build-time proxy.
  const rpc =
    chainId === 31337 ? rpcUrl(chainId, configuredRpc) : rpcUrl(chainId);
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName:
      chainId === 999
        ? "HyperEVM"
        : chainId === 998
          ? "HyperEVM Testnet"
          : "Local Anvil",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: [rpc],
    ...(chainId === 999
      ? { blockExplorerUrls: ["https://hyperevmscan.io"] }
      : {}),
  };
}

/** Whether a wallet refused a switch because it does not know the chain (EIP-3326 code 4902). */
export function isUnknownChain(e: unknown): boolean {
  const err = e as {
    code?: number;
    data?: { originalError?: { code?: number } };
    cause?: { code?: number };
  } | null;
  return (
    err?.code === 4902 ||
    err?.data?.originalError?.code === 4902 ||
    err?.cause?.code === 4902
  );
}

/**
 * Put the wallet on `chainId`: switch to it, and if the wallet does not know it, add it first
 * (some wallets switch on add, others need the switch again). Returns whether it had to change.
 */
export async function ensureChain(
  request: Request,
  chainId: number,
  configuredRpc?: string,
): Promise<boolean> {
  const hex = `0x${chainId.toString(16)}`;
  const current = async () => Number(await request({ method: "eth_chainId" }));
  if ((await current()) === chainId) return false;
  try {
    await request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (e) {
    if (!isUnknownChain(e)) throw e;
    await request({
      method: "wallet_addEthereumChain",
      params: [addChainParams(chainId, configuredRpc)],
    });
    if ((await current()) !== chainId)
      await request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      });
  }
  if ((await current()) !== chainId)
    throw new Error("The wallet is still on another network.");
  return true;
}
