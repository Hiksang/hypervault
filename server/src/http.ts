import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { HttpError } from "./errors.ts";
export const bodyLimit = 16 * 1024;
const drainLimit = 16 * bodyLimit;
export type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};
// A body over the limit is still read to its end, without being kept, so the
// client receives the 413 rather than a connection reset. Past drainLimit the
// connection is dropped: leaving the loop alone would keep the socket open
// with the rest of the body unread, stuck until a timeout.
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > drainLimit) {
        req.socket.destroy();
        break;
      }
      if (size <= bodyLimit) chunks.push(chunk);
    }
  } catch {
    // The client went away mid-body; nobody is left to read the answer.
    throw new HttpError("INVALID_REQUEST");
  }
  if (size > bodyLimit) throw new HttpError("BODY_TOO_LARGE");
  return Buffer.concat(chunks);
}
export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
  const body = await readBody(req);
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Malformed UTF-8 and malformed JSON get the same answer below.
  }
  throw new HttpError("INVALID_JSON");
}
// Only an allowlisted origin is echoed. No credentials are allowed because the
// service never uses cookies; the token travels in the Authorization header.
export function corsHeaders(
  req: IncomingMessage,
  allowed: readonly string[],
): Record<string, string> {
  const { origin } = req.headers;
  if (origin === undefined || !allowed.includes(origin))
    return { Vary: "Origin" };
  return {
    Vary: "Origin",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Retry-After",
    ...(req.method === "OPTIONS" && {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    }),
  };
}
export function send(
  res: ServerResponse,
  reply: Reply,
  cors: Record<string, string>,
): void {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...cors,
    ...reply.headers,
  };
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers).end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  res
    .writeHead(reply.status, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    })
    .end(payload);
}
export function listen(
  app: RequestListener,
  host: string,
  port: number,
): Promise<Server> {
  const server = createServer(app);
  // Bound how long a slow or endless request may hold a socket.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
