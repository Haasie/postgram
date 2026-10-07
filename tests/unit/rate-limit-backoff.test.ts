import { describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_BACKOFF_MAX_FACTOR,
  rateLimitBackoffMs
} from '../../src/services/rate-limit-backoff.js';

describe('rateLimitBackoffMs', () => {
  const noJitter = () => 0;
  const maxJitter = () => 1;

  it('starts at the configured base and doubles per consecutive 429', () => {
    expect(rateLimitBackoffMs(2000, 0, noJitter)).toBe(2000);
    expect(rateLimitBackoffMs(2000, 1, noJitter)).toBe(4000);
    expect(rateLimitBackoffMs(2000, 3, noJitter)).toBe(16000);
  });

  it('caps the growth at RATE_LIMIT_BACKOFF_MAX_FACTOR x base', () => {
    const cap = 2000 * RATE_LIMIT_BACKOFF_MAX_FACTOR;
    expect(rateLimitBackoffMs(2000, 10, noJitter)).toBe(cap);
    expect(rateLimitBackoffMs(2000, 10_000, noJitter)).toBe(cap);
  });

  it('only ever lengthens the pause, by at most 25%', () => {
    expect(rateLimitBackoffMs(60_000, 0, maxJitter)).toBe(75_000);
    for (let i = 0; i < 100; i += 1) {
      const value = rateLimitBackoffMs(60_000, 0);
      expect(value).toBeGreaterThanOrEqual(60_000);
      expect(value).toBeLessThanOrEqual(75_000);
    }
  });

  it('treats a base of 0 as no pause', () => {
    expect(rateLimitBackoffMs(0, 5, maxJitter)).toBe(0);
  });
});
