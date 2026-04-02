import { describe, expect, it } from 'vitest';

import { extractPrNumber, extractRepoFromPrUrl, findUnresolvedThreads, formatCommentsForPrompt, parseRemoteUrl } from './client';
import type { ReviewComment } from './client';

describe('extractPrNumber', () => {
  it('extracts PR number from a standard GitHub PR URL', () => {
    expect(extractPrNumber('https://github.com/owner/repo/pull/123')).toBe(123);
  });

  it('extracts PR number from a URL with additional path segments', () => {
    expect(extractPrNumber('https://github.com/owner/repo/pull/456/files')).toBe(456);
  });

  it('returns null for a URL without a PR number', () => {
    expect(extractPrNumber('https://github.com/owner/repo')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractPrNumber('')).toBeNull();
  });

  it('returns null for a non-GitHub URL', () => {
    expect(extractPrNumber('https://example.com/pull/123')).toBe(123); // regex is not host-specific
  });

  it('handles large PR numbers', () => {
    expect(extractPrNumber('https://github.com/org/repo/pull/99999')).toBe(99999);
  });
});

describe('extractRepoFromPrUrl', () => {
  it('extracts owner and repo from a GitHub PR URL', () => {
    const result = extractRepoFromPrUrl('https://github.com/myorg/myrepo/pull/42');
    expect(result).toEqual({ owner: 'myorg', repo: 'myrepo' });
  });

  it('handles repos with hyphens and underscores', () => {
    const result = extractRepoFromPrUrl('https://github.com/my-org/my_repo/pull/1');
    expect(result).toEqual({ owner: 'my-org', repo: 'my_repo' });
  });

  it('returns null for non-PR URLs', () => {
    expect(extractRepoFromPrUrl('https://github.com/owner/repo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractRepoFromPrUrl('')).toBeNull();
  });

  it('returns null for non-GitHub URLs', () => {
    expect(extractRepoFromPrUrl('https://gitlab.com/owner/repo/pull/1')).toBeNull();
  });
});

describe('parseRemoteUrl', () => {
  it('parses HTTPS URL with .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL with .git suffix', () => {
    const result = parseRemoteUrl('git@github.com:owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL without .git suffix', () => {
    const result = parseRemoteUrl('git@github.com:owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('handles orgs with hyphens', () => {
    const result = parseRemoteUrl('https://github.com/my-org/my-repo.git');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
  });

  it('throws for unsupported URL formats', () => {
    expect(() => parseRemoteUrl('https://gitlab.com/foo/bar')).toThrow('Cannot parse GitHub remote URL');
  });
});

describe('findUnresolvedThreads', () => {
  function makeComment(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      id: 1,
      body: 'comment',
      path: 'file.ts',
      line: 1,
      position: 1,
      user: { login: 'reviewer' },
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      html_url: 'https://github.com/o/r/pull/1#comment-1',
      ...overrides,
    };
  }

  it('returns comments where the last reply is not from the PR author', () => {
    const comments: ReviewComment[] = [makeComment({ id: 1, user: { login: 'reviewer1' }, created_at: '2025-01-01T00:00:00Z' })];

    const result = findUnresolvedThreads(comments, 'bot-author');
    expect(result).toHaveLength(1);
    expect(result[0].user.login).toBe('reviewer1');
  });

  it('returns empty when the PR author has replied to all threads', () => {
    const comments: ReviewComment[] = [
      makeComment({ id: 1, user: { login: 'reviewer1' }, created_at: '2025-01-01T00:00:00Z' }),
      makeComment({ id: 2, in_reply_to_id: 1, user: { login: 'bot-author' }, created_at: '2025-01-01T01:00:00Z' }),
    ];

    const result = findUnresolvedThreads(comments, 'bot-author');
    expect(result).toHaveLength(0);
  });

  it('identifies threads where reviewer replied after the author', () => {
    const comments: ReviewComment[] = [
      makeComment({ id: 1, user: { login: 'reviewer1' }, created_at: '2025-01-01T00:00:00Z' }),
      makeComment({ id: 2, in_reply_to_id: 1, user: { login: 'bot-author' }, created_at: '2025-01-01T01:00:00Z' }),
      makeComment({ id: 3, in_reply_to_id: 1, user: { login: 'reviewer1' }, created_at: '2025-01-01T02:00:00Z' }),
    ];

    const result = findUnresolvedThreads(comments, 'bot-author');
    expect(result).toHaveLength(1);
    expect(result[0].user.login).toBe('reviewer1');
  });

  it('handles multiple independent threads', () => {
    const comments: ReviewComment[] = [
      // Thread 1: unresolved
      makeComment({ id: 1, user: { login: 'reviewer1' }, created_at: '2025-01-01T00:00:00Z' }),
      // Thread 2: resolved
      makeComment({ id: 10, user: { login: 'reviewer2' }, created_at: '2025-01-01T00:00:00Z' }),
      makeComment({ id: 11, in_reply_to_id: 10, user: { login: 'bot-author' }, created_at: '2025-01-01T01:00:00Z' }),
    ];

    const result = findUnresolvedThreads(comments, 'bot-author');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('returns empty for no comments', () => {
    expect(findUnresolvedThreads([], 'bot')).toHaveLength(0);
  });
});

describe('formatCommentsForPrompt', () => {
  function makeComment(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      id: 1,
      body: 'Please fix this',
      path: 'src/index.ts',
      line: 42,
      position: 1,
      user: { login: 'reviewer1' },
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      html_url: 'https://github.com/o/r/pull/1#comment-1',
      ...overrides,
    };
  }

  it('returns empty string for no comments', () => {
    expect(formatCommentsForPrompt([])).toBe('');
  });

  it('formats a single comment with all fields', () => {
    const result = formatCommentsForPrompt([makeComment({})]);
    expect(result).toContain('1 unresolved review comment');
    expect(result).toContain('**Reviewer**: reviewer1');
    expect(result).toContain('**File**: src/index.ts:42');
    expect(result).toContain('**Comment**: Please fix this');
    expect(result).toContain('**URL**:');
    expect(result).toContain('Please address each comment');
  });

  it('formats multiple comments', () => {
    const comments = [
      makeComment({ id: 1, body: 'Fix A' }),
      makeComment({ id: 2, body: 'Fix B', path: 'src/other.ts', line: 10 }),
    ];
    const result = formatCommentsForPrompt(comments);
    expect(result).toContain('2 unresolved review comment');
    expect(result).toContain('Fix A');
    expect(result).toContain('Fix B');
  });

  it('handles comment without line number', () => {
    const result = formatCommentsForPrompt([makeComment({ line: null })]);
    expect(result).toContain('**File**: src/index.ts');
    expect(result).not.toContain(':null');
  });
});
