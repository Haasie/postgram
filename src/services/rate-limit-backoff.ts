/**
 * Backoff after an upstream HTTP 429, shared by the worker loop (account-wide
 * pause) and the per-entity cooldown.
 *
 * Exponential in the number of consecutive 429s, capped at
 * RATE_LIMIT_BACKOFF_MAX_FACTOR x base, plus up to 25% upward jitter so
 * several workers (or entities) do not retry in lockstep. The jitter only
 * ever lengthens the pause: an operator who configures 60s gets at least 60s.
 * A base of 0 disables the pause entirely.
 */
export const RATE_LIMIT_BACKOFF_MAX_FACTOR = 16;

/**
 * Consecutive 429s on one entity before it is treated as a real failure
 * (one counted attempt), so a deterministic misclassification or a
 * permanently throttled entity cannot be retried forever.
 */
export const MAX_CONSECUTIVE_RATE_LIMITS = 20;

export function rateLimitBackoffMs(
  baseMs: number,
  consecutive: number,
  random: () => number = Math.random
): number {
  if (baseMs <= 0) {
    return 0;
  }
  const exponent = Math.max(0, Math.min(consecutive, 30));
  const delay = Math.min(
    baseMs * 2 ** exponent,
    baseMs * RATE_LIMIT_BACKOFF_MAX_FACTOR
  );
  return Math.round(delay + random() * delay * 0.25);
}
