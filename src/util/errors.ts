import type { ErrorResponse } from '../types/api.js';

export enum ErrorCode {
  VALIDATION = 'VALIDATION',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  EMBEDDING_FAILED = 'EMBEDDING_FAILED',
  INTERNAL = 'INTERNAL'
}

export class AppError extends Error {
  code: ErrorCode;
  details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/**
 * An upstream provider (LLM or embedding API) answered HTTP 429. Transient by
 * definition: callers must not count it as a failed attempt.
 */
export class RateLimitError extends Error {
  readonly status = 429;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RateLimitError';
  }
}

/**
 * True only when the error carries an HTTP 429 status: a RateLimitError, an
 * SDK error exposing `status`, an AppError whose details carry `status`, or
 * any of those behind `cause`. Never inspects the message text: substrings
 * such as "1429" or "timed out after 4290ms" are not throttling.
 */
export function isRateLimitError(error: unknown, depth = 0): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (typeof error !== 'object' || error === null || depth > 3) {
    return false;
  }
  if ((error as { status?: unknown }).status === 429) {
    return true;
  }
  if (error instanceof AppError && error.details.status === 429) {
    return true;
  }
  return isRateLimitError((error as { cause?: unknown }).cause, depth + 1);
}

export function toHttpStatus(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.VALIDATION:
      return 400;
    case ErrorCode.UNAUTHORIZED:
      return 401;
    case ErrorCode.FORBIDDEN:
      return 403;
    case ErrorCode.RATE_LIMITED:
      return 429;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
      return 409;
    case ErrorCode.EMBEDDING_FAILED:
      return 502;
    case ErrorCode.INTERNAL:
      return 500;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(ErrorCode.INTERNAL, error.message);
  }

  return new AppError(ErrorCode.INTERNAL, 'Unexpected server error');
}

export function toErrorResponse(error: AppError): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    }
  };
}
