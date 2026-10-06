import { describe, expect, it } from 'vitest';

import {
  AppError,
  ErrorCode,
  RateLimitError,
  isRateLimitError,
  toHttpStatus
} from '../../src/util/errors.js';

describe('toHttpStatus', () => {
  it('maps common application errors to HTTP status codes', () => {
    expect(toHttpStatus(ErrorCode.VALIDATION)).toBe(400);
    expect(toHttpStatus(ErrorCode.UNAUTHORIZED)).toBe(401);
    expect(toHttpStatus(ErrorCode.FORBIDDEN)).toBe(403);
    expect(toHttpStatus(ErrorCode.RATE_LIMITED)).toBe(429);
    expect(toHttpStatus(ErrorCode.NOT_FOUND)).toBe(404);
    expect(toHttpStatus(ErrorCode.CONFLICT)).toBe(409);
    expect(toHttpStatus(ErrorCode.EMBEDDING_FAILED)).toBe(502);
    expect(toHttpStatus(ErrorCode.INTERNAL)).toBe(500);
  });
});

describe('AppError', () => {
  it('captures code, message, and optional details', () => {
    const error = new AppError(ErrorCode.VALIDATION, 'Invalid request', {
      field: 'content'
    });

    expect(error.code).toBe(ErrorCode.VALIDATION);
    expect(error.message).toBe('Invalid request');
    expect(error.details).toEqual({ field: 'content' });
  });

  it('defaults details to an empty object', () => {
    const error = new AppError(ErrorCode.INTERNAL, 'Unexpected failure');

    expect(error.details).toEqual({});
  });
});

describe('isRateLimitError', () => {
  it('matches only real HTTP 429 signals', () => {
    expect(isRateLimitError(new RateLimitError('slow down'))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(
      isRateLimitError(new AppError(ErrorCode.EMBEDDING_FAILED, 'x', { status: 429 }))
    ).toBe(true);
    expect(
      isRateLimitError(new Error('wrapped', { cause: Object.assign(new Error('x'), { status: 429 }) }))
    ).toBe(true);
  });

  it.each([
    'Embedding API returned an unexpected number of vectors: expected 1, actual 1429',
    'insert or update on table "edges" violates foreign key (target_id)=(550e8400-e29b-41d4-a716-446655440429) does not exist',
    'LLM request timed out after 4290ms',
    'context length exceeded: 142900 tokens',
    'permission denied for table entities',
    'rate limit' // wording alone is not a status
  ])('does not treat message text as throttling: %s', (message) => {
    expect(isRateLimitError(new Error(message))).toBe(false);
  });

  it('ignores other statuses and non-errors', () => {
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isRateLimitError(new AppError(ErrorCode.EMBEDDING_FAILED, 'x', { status: 400 }))).toBe(false);
    expect(isRateLimitError('429')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
