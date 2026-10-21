/**
 * Stable machine-readable failure codes for the auth API. Additive contract:
 * append new values, never rename or repurpose a shipped one. Clients may key
 * behavior (and bug reports) off these without parsing human messages.
 */
export const ErrorCode = {
  AUTH_MISSING_FIELDS: 'AUTH_MISSING_FIELDS',
  AUTH_BAD_DEVICE_ID: 'AUTH_BAD_DEVICE_ID',
  AUTH_BAD_URL: 'AUTH_BAD_URL',
  AUTH_BAD_CREDENTIALS: 'AUTH_BAD_CREDENTIALS',
  AUTH_SERVER_NOT_FOUND: 'AUTH_SERVER_NOT_FOUND',
  UPSTREAM_BAD_GATEWAY: 'UPSTREAM_BAD_GATEWAY',
  UPSTREAM_BAD_RESPONSE: 'UPSTREAM_BAD_RESPONSE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_UNREACHABLE: 'UPSTREAM_UNREACHABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Error response shape shared by the auth routes, token guard and limiter. */
export interface ErrorResponse {
  error: string;
  code: ErrorCode;
}

export interface LoginRequest {
  serverUrl: string;
  username: string;
  password: string;
  deviceId: string;
}

export interface JellyfinAuthResponse {
  User: {
    Id: string;
    Name: string;
    [key: string]: unknown;
  };
  AccessToken: string;
  ServerId: string;
  [key: string]: unknown;
}

export interface LoginSuccessResponse {
  user: {
    id: string;
    name: string;
  };
  serverUrl: string;
}
