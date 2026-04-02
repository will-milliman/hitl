/**
 * Configuration loader for cron job services.
 *
 * Reads environment variables for Azure DevOps and GitHub.
 * Returns null if required vars are missing (graceful degradation).
 */
import type { AzureConfig } from '../azure';

let cachedConfig: AzureConfig | null | undefined = undefined;

/**
 * Loads Azure DevOps config from environment variables.
 * Returns null if required variables are not set.
 *
 * Required env vars:
 * - AZURE_DEVOPS_ORG: The Azure DevOps organization name
 * - AZURE_DEVOPS_PROJECT: The project name
 * - AZURE_DEVOPS_PAT: Personal access token with read permissions
 *
 * Optional env vars:
 * - AZURE_DEVOPS_TEAM: Team name (for @CurrentIteration scope)
 */
export function getAzureConfig(): AzureConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const org = process.env.AZURE_DEVOPS_ORG;
  const project = process.env.AZURE_DEVOPS_PROJECT;
  const pat = process.env.AZURE_DEVOPS_PAT;
  const teamId = process.env.AZURE_DEVOPS_TEAM;

  if (!org || !project || !pat) {
    console.warn('[config] Azure DevOps not fully configured. Set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, and AZURE_DEVOPS_PAT.');
    cachedConfig = null;
    return null;
  }

  cachedConfig = { org, project, pat, teamId };
  return cachedConfig;
}

/**
 * Clears the cached config (useful for testing or reloading).
 */
export function clearConfigCache(): void {
  cachedConfig = undefined;
}
