/**
 * Shared query-error describer. The server normalizes failures to
 * `{error, code}`, but untagged bodies (older servers, Electron bridge
 * synthetics, network failures) still occur — describe those with status
 * context instead of degrading to a bare generic toast.
 */

export interface DescribedQueryError {
  message: string;
  status?: number;
  code?: string;
}

export function describeQueryErrorDetail(error: unknown): DescribedQueryError {
  const err = error as {
    response?: { status?: number; data?: { error?: string; code?: string } | string };
    code?: string;
    message?: string;
  };
  const response = err?.response;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const data = response?.data;
  const code =
    data && typeof data === 'object' && typeof data.code === 'string'
      ? data.code
      : undefined;
  const serverMessage =
    data && typeof data === 'object' && typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : undefined;

  if (serverMessage) {
    return { message: serverMessage, status, code };
  }
  // No response at all — network failure, timeout, or CORS-style block.
  if (status === undefined) {
    if (err?.code === 'ECONNABORTED' || err?.code === 'ERR_CANCELED') {
      return { message: 'Jellyfin server timed out — please try again', code: err.code };
    }
    if (typeof err?.message === 'string' && /network/i.test(err.message)) {
      return { message: 'Server unreachable — check the connection and try again' };
    }
    return { message: 'Something went wrong — please try again' };
  }
  return {
    message: `Request failed (HTTP ${status}) — please try again`,
    status,
    code,
  };
}

export function describeQueryError(error: unknown): string {
  return describeQueryErrorDetail(error).message;
}
