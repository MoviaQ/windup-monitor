/** Canonical API error: always rendered as JSON `{ code, message }`. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function invalidBody(message = 'Invalid request body'): ApiError {
  return new ApiError(400, 'INVALID_BODY', message);
}
