// Every error code the service can answer with, and its HTTP status.
// A response carries the code only, never the reason behind it.
export const statuses = {
  INVALID_JSON: 400,
  INVALID_REQUEST: 400,
  INVALID_ADDRESS: 400,
  INVALID_TEXT: 400,
  SIGNATURE_EXPIRED: 401,
  BAD_SIGNATURE: 401,
  UNAUTHORIZED: 401,
  POSTING_NOT_ALLOWED: 403,
  NOT_MODERATOR: 403,
  HIDDEN_BY_ADMIN: 403,
  NOT_A_VAULT: 404,
  MESSAGE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  BUSY: 429,
  INTERNAL: 500,
  CHAIN_BUSY: 503,
  CHAIN_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof statuses;
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;
  constructor(code: ErrorCode, headers: Record<string, string> = {}) {
    super(code);
    this.code = code;
    this.headers = headers;
  }
}
