/**
 * Screenshot utilities for FE validation.
 *
 * Handles discovering and committing validation screenshots so they can
 * be embedded in pull request bodies via raw.githubusercontent.com URLs.
 *
 * Flow:
 * 1. Copilot saves screenshots to HITL's data directory for the worktree
 * 2. Before PR creation, HITL discovers screenshots in that directory
 * 3. Screenshots are committed to `.validation/` in the worktree and pushed
 * 4. Raw GitHub URLs are formatted as markdown for the PR body
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { promisify } from 'util';

import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('screenshots');

/** Subdirectory name for validation screenshots (inside worktree data dir) */
export const SCREENSHOTS_SUBDIR = 'screenshots';

/** Supported image file extensions */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Gets the screenshots directory path for a worktree data dir.
 */
export function getScreenshotDir(worktreeDataDir: string): string {
  return join(worktreeDataDir, SCREENSHOTS_SUBDIR);
}

/**
 * Discovers screenshot files in the screenshots directory.
 *
 * @returns Array of absolute file paths to screenshot images
 */
export function discoverScreenshots(screenshotDir: string): string[] {
  if (!existsSync(screenshotDir)) return [];

  try {
    return readdirSync(screenshotDir)
      .filter((file) => {
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        return IMAGE_EXTENSIONS.has(ext);
      })
      .map((file) => join(screenshotDir, file))
      .slice(0, 10); // Cap at 10 screenshots to avoid bloating the PR
  } catch (err) {
    logger.error(`Failed to read screenshots directory: ${err}`);
    return [];
  }
}

/**
 * Reads a validation error file if it exists.
 *
 * Copilot writes validation-error.txt when the app fails to start
 * or screenshots cannot be captured.
 */
export function readValidationError(screenshotDir: string): string | null {
  const errorFile = join(screenshotDir, 'validation-error.txt');
  if (!existsSync(errorFile)) return null;

  try {
    return readFileSync(errorFile, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Uploads screenshots by committing them to the task branch.
 *
 * This is the most reliable approach: screenshots are committed to a
 * `.validation/` directory in the worktree, pushed with the branch,
 * and referenced via raw GitHub URLs in the PR body.
 *
 * @param screenshotPaths Array of absolute paths to screenshot files
 * @param worktreePath Path to the git worktree
 * @returns Array of { fileName, relativePath } for each committed screenshot
 */
export async function commitScreenshots(
  screenshotPaths: string[],
  worktreePath: string,
): Promise<Array<{ fileName: string; relativePath: string }>> {
  if (screenshotPaths.length === 0) return [];

  const { copyFileSync, mkdirSync } = require('fs');
  const validationDir = join(worktreePath, '.validation');

  try {
    // Create .validation directory in the worktree
    mkdirSync(validationDir, { recursive: true });

    const results: Array<{ fileName: string; relativePath: string }> = [];

    // Copy each screenshot to the .validation directory
    for (const srcPath of screenshotPaths) {
      const fileName = basename(srcPath);
      const destPath = join(validationDir, fileName);
      copyFileSync(srcPath, destPath);
      results.push({ fileName, relativePath: `.validation/${fileName}` });
    }

    // Stage and commit the screenshots
    await execFileAsync('git', ['add', '.validation/'], {
      cwd: worktreePath,
      timeout: 15_000,
      windowsHide: true,
    });

    await execFileAsync('git', ['commit', '-m', 'chore: add FE validation screenshots'], {
      cwd: worktreePath,
      timeout: 15_000,
      windowsHide: true,
    });

    logger.info(`Committed ${results.length} validation screenshots to .validation/`);
    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to commit screenshots: ${message}`);
    return [];
  }
}

/**
 * Builds markdown image references for screenshots committed to the branch.
 *
 * Uses raw.githubusercontent.com URLs to display the images in the PR body.
 *
 * @param screenshots Array of { fileName, relativePath } from commitScreenshots
 * @param owner GitHub repo owner
 * @param repo GitHub repo name
 * @param branch Branch name the screenshots are committed to
 */
export function buildScreenshotMarkdown(
  screenshots: Array<{ fileName: string; relativePath: string }>,
  owner: string,
  repo: string,
  branch: string,
): string {
  if (screenshots.length === 0) return '';

  const lines = ['## Frontend Validation', ''];

  for (const { fileName, relativePath } of screenshots) {
    const label = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${relativePath}`;
    lines.push(`### ${label}`);
    lines.push(`![${label}](${rawUrl})`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Builds markdown for a validation error (when screenshots could not be captured).
 */
export function buildValidationErrorMarkdown(errorText: string): string {
  return [
    '## Frontend Validation',
    '',
    '> **Validation could not be completed.** The following error was reported:',
    '',
    '```',
    errorText,
    '```',
    '',
  ].join('\n');
}
