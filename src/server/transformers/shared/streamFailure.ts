export type TypedStreamFailure = {
  status: number;
  type?: string;
  code?: string;
  message: string;
  payload: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asHttpStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
    return value;
  }
  if (typeof value !== 'string' || !/^\d{3}$/.test(value.trim())) return undefined;
  const status = Number.parseInt(value.trim(), 10);
  return status >= 400 && status <= 599 ? status : undefined;
}

export function extractTypedStreamFailure(
  payload: unknown,
  fallbackMessage = 'upstream stream failed',
): TypedStreamFailure {
  const root = isRecord(payload) ? payload : null;
  const response = root && isRecord(root.response) ? root.response : null;
  const topLevelError = root && isRecord(root.error) ? root.error : null;
  const responseError = response && isRecord(response.error) ? response.error : null;
  const error = responseError ?? topLevelError;
  const statusCandidates = [
    error?.status,
    error?.statusCode,
    error?.http_status,
    error?.httpStatus,
    root?.status,
    root?.statusCode,
    root?.http_status,
    root?.httpStatus,
  ];
  let status = 502;
  for (const candidate of statusCandidates) {
    const parsed = asHttpStatus(candidate);
    if (parsed !== undefined) {
      status = parsed;
      break;
    }
  }
  const message = asTrimmedString(error?.message)
    || asTrimmedString(root?.message)
    || fallbackMessage;
  const type = asTrimmedString(error?.type) || asTrimmedString(root?.type) || undefined;
  const code = asTrimmedString(error?.code) || asTrimmedString(root?.code) || undefined;
  return {
    status,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    message,
    payload,
  };
}
