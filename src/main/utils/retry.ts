/**
 * Retry utility for API calls and other flaky operations.
 *
 * Provides exponential backoff with configurable attempts and delays.
 */
import { createLogger } from '../logger';

const logger = createLogger('retry');

export interface RetryOptions {
  /** Maximum number of attempts (including the first try) */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier?: number;
  /** Optional label for logging */
  label?: string;
  /** Whether to retry on this specific error (return false to skip retry) */
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'label' | 'shouldRetry'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
};

/**
 * Executes a function with retry logic and exponential backoff.
 *
 * @param fn The async function to execute
 * @param options Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const label = opts.label ?? 'operation';

  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Check if we should retry this error
      if (opts.shouldRetry && !opts.shouldRetry(err)) {
        logger.warn(`${label}: not retryable, failing immediately`, {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (attempt < opts.maxAttempts) {
        logger.warn(`${label}: attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
      } else {
        logger.error(`${label}: all ${opts.maxAttempts} attempts failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  throw lastError;
}

/**
 * Determines if an HTTP error is retryable based on status code.
 * Retries on 429 (rate limit), 500, 502, 503, 504 (server errors).
 */
export function isRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;

  const message = error.message;

  // Rate limiting
  if (message.includes('429') || message.includes('rate limit')) return true;

  // Server errors
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) return true;

  // Network errors
  if (
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('fetch failed')
  )
    return true;

  // Don't retry client errors (400, 401, 403, 404, 409, 422)
  if (message.includes('401') || message.includes('403') || message.includes('404') || message.includes('422')) return false;

  // Default: retry unknown errors
  return true;
}
