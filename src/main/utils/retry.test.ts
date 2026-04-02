import { describe, expect, it, vi } from 'vitest';

import { isRetryableHttpError, withRetry } from './retry';

// Mock the logger before importing retry
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 1,
      label: 'test-op',
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 5,
        label: 'exhaust-test',
      }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when shouldRetry returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not retryable'));

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        shouldRetry: () => false,
        label: 'no-retry',
      }),
    ).rejects.toThrow('not retryable');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff with capped delay', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        initialDelayMs: 1,
        maxDelayMs: 5,
        backoffMultiplier: 3,
        label: 'backoff-test',
      }),
    ).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('uses default options when none provided', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = withRetry(fn, {
      maxAttempts: 2,
      initialDelayMs: 1,
    });

    await expect(promise).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        initialDelayMs: 1,
        label: 'non-error',
      }),
    ).rejects.toBe('string error');

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('isRetryableHttpError', () => {
  it('returns true for rate limit errors (429)', () => {
    expect(isRetryableHttpError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true for rate limit text', () => {
    expect(isRetryableHttpError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('returns true for server errors (500, 502, 503, 504)', () => {
    expect(isRetryableHttpError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
    expect(isRetryableHttpError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isRetryableHttpError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isRetryableHttpError(new Error('HTTP 504 Gateway Timeout'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isRetryableHttpError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableHttpError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableHttpError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableHttpError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableHttpError(new Error('fetch failed'))).toBe(true);
  });

  it('returns false for client errors (401, 403, 404, 422)', () => {
    expect(isRetryableHttpError(new Error('HTTP 401 Unauthorized'))).toBe(false);
    expect(isRetryableHttpError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isRetryableHttpError(new Error('HTTP 404 Not Found'))).toBe(false);
    expect(isRetryableHttpError(new Error('HTTP 422 Unprocessable Entity'))).toBe(false);
  });

  it('returns true for non-Error values', () => {
    expect(isRetryableHttpError('some string')).toBe(true);
    expect(isRetryableHttpError(42)).toBe(true);
    expect(isRetryableHttpError(null)).toBe(true);
    expect(isRetryableHttpError(undefined)).toBe(true);
  });

  it('returns true for unknown error messages', () => {
    expect(isRetryableHttpError(new Error('something weird happened'))).toBe(true);
  });
});
