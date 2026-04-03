/**
 * GitHub integration module.
 *
 * Re-exports all GitHub-related functionality via the `gh` CLI:
 * - PR creation, viewing, and listing
 * - Review comment fetching and thread analysis
 * - Auth status checking
 * - Repo info extraction
 * - Screenshot upload for FE validation
 */

export {
  isGhAuthenticated,
  getRepoInfo,
  parseRemoteUrl,
  createPullRequest,
  getPullRequest,
  getPullRequestByUrl,
  findPullRequest,
  isPrMerged,
  isPrReadyToMerge,
  extractPrNumber,
  extractRepoFromPrUrl,
  getPrReviewComments,
  getPrIssueComments,
  findUnresolvedThreads,
  formatCommentsForPrompt,
  type RepoInfo,
  type PullRequest,
  type CreatePRParams,
  type ReviewComment,
} from './client';

export {
  SCREENSHOTS_SUBDIR,
  getScreenshotDir,
  discoverScreenshots,
  readValidationError,
  commitScreenshots,
  buildScreenshotMarkdown,
  buildValidationErrorMarkdown,
} from './screenshots';
