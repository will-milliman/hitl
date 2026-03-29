/**
 * GitHub integration via the `gh` CLI.
 *
 * Uses the GitHub CLI (`gh`) for all GitHub operations. The CLI handles
 * authentication automatically via `gh auth login` — no GITHUB_TOKEN
 * env var is needed.
 *
 * Commands used:
 * - `gh auth status` — check if authenticated
 * - `gh pr create` — create pull requests
 * - `gh pr view --json` — get PR details (state, merge status, author)
 * - `gh pr list --json` — find PRs by head/base branch
 * - `gh api` — fetch review comments via REST API
 *
 * All gh CLI calls use retry logic for transient failures.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { withRetry } from '../utils/retry'
import { createLogger } from '../logger'

const execFileAsync = promisify(execFile)
const logger = createLogger('github')

/** Max buffer for gh output (5 MB) */
const MAX_BUFFER = 5 * 1024 * 1024

// ─── Types ───────────────────────────────────────────────

export interface RepoInfo {
  owner: string
  repo: string
}

export interface PullRequest {
  number: number
  url: string         // html URL
  state: string       // OPEN, CLOSED, MERGED
  title: string
  headRefName: string
  baseRefName: string
  author: { login: string }
}

export interface CreatePRParams {
  title: string
  body: string
  head: string  // source branch
  base: string  // target branch
}

export interface ReviewComment {
  id: number
  body: string
  path: string
  line: number | null
  position: number | null
  user: { login: string }
  created_at: string
  updated_at: string
  html_url: string
  /** GitHub thread id for grouping */
  in_reply_to_id?: number
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Determines if a gh CLI error is retryable.
 */
function isRetryableGhError(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  const msg = error.message
  // Don't retry auth failures or "not found" type errors
  if (msg.includes('authentication') || msg.includes('auth')) return false
  if (msg.includes('not found') || msg.includes('404')) return false
  if (msg.includes('already exists')) return false
  // Retry network/timeout/server errors
  return true
}

/**
 * Runs a `gh` CLI command and returns the stdout.
 * Retries on transient failures.
 *
 * @param args Arguments to pass to `gh`
 * @param cwd Working directory (determines which repo context gh uses)
 */
async function gh(
  args: string[],
  cwd: string
): Promise<string> {
  return withRetry(
    async () => {
      const { stdout } = await execFileAsync('gh', args, {
        cwd,
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      })
      return stdout.trim()
    },
    {
      label: `gh ${args.slice(0, 3).join(' ')}`,
      maxAttempts: 3,
      initialDelayMs: 2000,
      shouldRetry: isRetryableGhError,
    }
  )
}

/**
 * Runs a `gh` CLI command and parses the JSON output.
 */
async function ghJson<T>(
  args: string[],
  cwd: string
): Promise<T> {
  const output = await gh(args, cwd)
  return JSON.parse(output) as T
}

// ─── Auth ────────────────────────────────────────────────

/**
 * Checks if the gh CLI is authenticated.
 * Returns true if `gh auth status` succeeds.
 */
export async function isGhAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      timeout: 10_000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

// ─── Repository Info ─────────────────────────────────────

/**
 * Extracts the GitHub owner and repo from a git remote URL.
 *
 * Supports:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo
 *
 * @param repoPath Path to the git repo (or worktree)
 * @returns { owner, repo }
 */
export async function getRepoInfo(repoPath: string): Promise<RepoInfo> {
  const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoPath,
    timeout: 10_000,
    windowsHide: true,
  })

  const remoteUrl = stdout.trim()
  return parseRemoteUrl(remoteUrl)
}

/**
 * Parses a GitHub remote URL into owner/repo.
 */
export function parseRemoteUrl(remoteUrl: string): RepoInfo {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /github\.com\/([^/]+)\/([^/.\s]+?)(?:\.git)?$/
  )
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(
    /github\.com:([^/]+)\/([^/.\s]+?)(?:\.git)?$/
  )
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }

  throw new Error(`[github] Cannot parse GitHub remote URL: ${remoteUrl}`)
}

// ─── Pull Requests ───────────────────────────────────────

/**
 * Creates a pull request using `gh pr create`.
 *
 * Must be run from within the repo/worktree directory so `gh` knows
 * the repo context.
 */
export async function createPullRequest(
  cwd: string,
  params: CreatePRParams
): Promise<PullRequest> {
  console.log(
    `[github] Creating PR: ${params.head} → ${params.base} in ${cwd}`
  )

  const output = await gh([
    'pr', 'create',
    '--title', params.title,
    '--body', params.body,
    '--head', params.head,
    '--base', params.base,
    '--json', 'number,url,state,title,headRefName,baseRefName,author',
  ], cwd)

  // gh pr create with --json returns JSON
  return JSON.parse(output) as PullRequest
}

/**
 * Gets a pull request by number using `gh pr view`.
 */
export async function getPullRequest(
  cwd: string,
  prNumber: number
): Promise<PullRequest> {
  return ghJson<PullRequest>([
    'pr', 'view', String(prNumber),
    '--json', 'number,url,state,title,headRefName,baseRefName,author',
  ], cwd)
}

/**
 * Gets a pull request by its URL using `gh pr view`.
 */
export async function getPullRequestByUrl(
  prUrl: string,
  cwd: string
): Promise<PullRequest> {
  return ghJson<PullRequest>([
    'pr', 'view', prUrl,
    '--json', 'number,url,state,title,headRefName,baseRefName,author',
  ], cwd)
}

/**
 * Finds a PR for a given head branch targeting a base branch.
 * Returns null if no matching PR is found.
 *
 * Searches all states (open, closed, merged).
 */
export async function findPullRequest(
  cwd: string,
  head: string,
  base: string
): Promise<PullRequest | null> {
  try {
    const prs = await ghJson<PullRequest[]>([
      'pr', 'list',
      '--state', 'all',
      '--head', head,
      '--base', base,
      '--limit', '1',
      '--json', 'number,url,state,title,headRefName,baseRefName,author',
    ], cwd)

    return prs.length > 0 ? prs[0] : null
  } catch {
    return null
  }
}

/**
 * Checks if a PR has been merged.
 * Uses `gh pr view` to get the state.
 */
export async function isPrMerged(
  cwd: string,
  prNumber: number
): Promise<boolean> {
  try {
    const pr = await getPullRequest(cwd, prNumber)
    return pr.state === 'MERGED'
  } catch {
    return false
  }
}

/**
 * Extracts PR number from a GitHub PR URL.
 * e.g. https://github.com/owner/repo/pull/123 → 123
 */
export function extractPrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Extracts owner/repo from a GitHub PR URL.
 * e.g. https://github.com/owner/repo/pull/123 → { owner, repo }
 */
export function extractRepoFromPrUrl(prUrl: string): RepoInfo | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

// ─── Review Comments ─────────────────────────────────────

/**
 * Gets all review comments on a pull request using `gh api`.
 * These are the "inline" comments left as part of code reviews.
 */
export async function getPrReviewComments(
  cwd: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewComment[]> {
  try {
    return await ghJson<ReviewComment[]>([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--paginate',
      '-q', '.',
    ], cwd)
  } catch (err) {
    console.error(`[github] Failed to fetch review comments:`, err)
    return []
  }
}

/**
 * Gets issue comments on a pull request (general conversation comments).
 */
export async function getPrIssueComments(
  cwd: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewComment[]> {
  try {
    return await ghJson<ReviewComment[]>([
      'api',
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      '--paginate',
      '-q', '.',
    ], cwd)
  } catch (err) {
    console.error(`[github] Failed to fetch issue comments:`, err)
    return []
  }
}

/**
 * Groups review comments into threads and identifies unresolved ones.
 *
 * A thread is considered "unresolved" if:
 * - It has no reply from the PR author (our bot/agent)
 * - Or the last comment is from a reviewer (not the agent)
 *
 * Since GitHub REST API doesn't expose resolved/unresolved state directly
 * for review threads, we approximate by checking if the latest comment
 * in a thread is NOT from the PR author.
 */
export function findUnresolvedThreads(
  comments: ReviewComment[],
  prAuthorLogin: string
): ReviewComment[] {
  // Group by thread: root comments don't have in_reply_to_id
  const threads = new Map<number, ReviewComment[]>()

  for (const comment of comments) {
    const threadId = comment.in_reply_to_id ?? comment.id
    const thread = threads.get(threadId) ?? []
    thread.push(comment)
    threads.set(threadId, thread)
  }

  // Find threads where the latest comment is NOT from the PR author
  const unresolved: ReviewComment[] = []
  for (const [, thread] of threads) {
    // Sort by created_at ascending
    thread.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    const lastComment = thread[thread.length - 1]
    if (lastComment.user.login !== prAuthorLogin) {
      // This thread has an unanswered reviewer comment
      unresolved.push(lastComment)
    }
  }

  return unresolved
}

/**
 * Formats unresolved review comments into a prompt string
 * for the copilot agent to address.
 */
export function formatCommentsForPrompt(comments: ReviewComment[]): string {
  if (comments.length === 0) return ''

  const lines = [
    `There are ${comments.length} unresolved review comment(s) on your pull request that need to be addressed:\n`,
  ]

  for (const comment of comments) {
    lines.push(`---`)
    lines.push(`**Reviewer**: ${comment.user.login}`)
    if (comment.path) {
      lines.push(`**File**: ${comment.path}${comment.line ? `:${comment.line}` : ''}`)
    }
    lines.push(`**Comment**: ${comment.body}`)
    if (comment.html_url) {
      lines.push(`**URL**: ${comment.html_url}`)
    }
    lines.push('')
  }

  lines.push(
    `Please address each comment by making the necessary code changes. After making changes, commit and push them.`
  )

  return lines.join('\n')
}
