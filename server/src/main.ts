import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { rpcChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { listen } from "./http.ts";
import { jsonRpc } from "./rpc.ts";
import { openStore } from "./store.ts";
try {
  const config = loadConfig(process.env);
  const db = openStore(config.databasePath);
  const chain = rpcChain({
    chainId: config.chainId,
    factory: config.factory,
    rpc: jsonRpc(config.rpcUrl),
  });
  const app = createApp({ db, chain, config, now: Date.now });
  const server = await listen(app, config.host, config.port);
  const { port } = server.address() as AddressInfo;
  console.log(
    `Core Vault chat on http://${config.host}:${port} (chain ${config.chainId}, audience ${config.audience}, posting ${config.posting})`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close(() => db.close());
      server.closeIdleConnections();
    });
} catch (error) {
  // Configuration mistakes are the usual cause; the message says which.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
