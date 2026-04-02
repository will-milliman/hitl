/**
 * Azure DevOps REST API client.
 *
 * Uses the Azure DevOps Services REST API v7.x:
 * - WIQL for querying work items
 * - Work Items batch API for fetching details
 *
 * Authentication: Basic auth with PAT (personal access token).
 * The PAT is sent as the password with an empty username.
 *
 * All API calls use retry logic with exponential backoff for
 * transient failures (network errors, 429/5xx responses).
 */
import { createLogger } from '../logger';
import { isRetryableHttpError, withRetry } from '../utils/retry';

const logger = createLogger('azure');

export interface AzureConfig {
  org: string;
  project: string;
  pat: string;
  teamId?: string; // optional, used for @CurrentIteration team scope
}

export interface WiqlResult {
  workItems: Array<{ id: number; url: string }>;
}

export interface WorkItemFields {
  'System.Id': number;
  'System.Title': string;
  'System.WorkItemType': string;
  'System.State': string;
  'System.AssignedTo'?: {
    displayName: string;
    uniqueName: string;
  };
  'System.IterationPath'?: string;
  'System.Parent'?: number;
  [key: string]: unknown;
}

export interface WorkItem {
  id: number;
  fields: WorkItemFields;
  url: string;
}

export interface WorkItemBatchResult {
  count: number;
  value: WorkItem[];
}

/**
 * Creates the Authorization header for Azure DevOps REST API.
 * PAT auth uses Basic with empty username.
 */
function authHeader(pat: string): string {
  const encoded = Buffer.from(`:${pat}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Base URL for Azure DevOps REST API.
 * When a team is provided, the team is inserted before `_apis` in the path.
 * Azure DevOps REST API format:
 *   Without team: https://dev.azure.com/{org}/{project}/_apis/...
 *   With team:    https://dev.azure.com/{org}/{project}/{team}/_apis/...
 */
function baseUrl(org: string, project: string, team?: string): string {
  const teamSegment = team ? `/${encodeURIComponent(team)}` : '';
  return `https://dev.azure.com/${org}/${project}${teamSegment}/_apis`;
}

/**
 * Execute a WIQL (Work Item Query Language) query.
 * Returns a flat list of work item IDs and URLs.
 * Retries on transient failures.
 */
export async function queryWiql(config: AzureConfig, wiql: string): Promise<WiqlResult> {
  return withRetry(
    async () => {
      const url = `${baseUrl(config.org, config.project, config.teamId)}/wit/wiql?api-version=7.1`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader(config.pat),
        },
        body: JSON.stringify({ query: wiql }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`[azure] WIQL query failed (${response.status}): ${text}`);
      }

      return response.json() as Promise<WiqlResult>;
    },
    {
      label: 'azure:queryWiql',
      maxAttempts: 3,
      shouldRetry: isRetryableHttpError,
    },
  );
}

/**
 * Fetch work item details by IDs (batch endpoint, max 200 per request).
 * Returns full work item objects with fields.
 * Retries each batch on transient failures.
 */
export async function getWorkItems(config: AzureConfig, ids: number[], fields?: string[]): Promise<WorkItem[]> {
  if (ids.length === 0) return [];

  const allItems: WorkItem[] = [];

  // Batch in chunks of 200 (API limit)
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);

    const items = await withRetry(
      async () => {
        const params = new URLSearchParams({
          ids: chunk.join(','),
          'api-version': '7.1',
        });

        if (fields?.length) {
          params.set('fields', fields.join(','));
        }

        const url = `${baseUrl(config.org, config.project)}/wit/workitems?${params}`;

        const response = await fetch(url, {
          headers: {
            Authorization: authHeader(config.pat),
          },
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`[azure] Work items fetch failed (${response.status}): ${text}`);
        }

        const result = (await response.json()) as WorkItemBatchResult;
        return result.value;
      },
      {
        label: `azure:getWorkItems(batch ${i / 200 + 1})`,
        maxAttempts: 3,
        shouldRetry: isRetryableHttpError,
      },
    );

    allItems.push(...items);
  }

  return allItems;
}

/**
 * Build the Azure DevOps work item URL for a given ID.
 */
export function workItemUrl(org: string, project: string, id: number): string {
  return `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`;
}

/**
 * WIQL query to find stories in the current sprint assigned to the current user
 * that have active or new tasks, even if the story itself is closed.
 *
 * This uses a flat query that finds tasks first (since tasks have the state filter),
 * then we look up their parent stories.
 */
export function buildSprintTasksQuery(): string {
  return `
    SELECT [System.Id]
    FROM WorkItems
    WHERE
      [System.WorkItemType] = 'Task'
      AND [System.IterationPath] = @CurrentIteration
      AND [System.State] IN ('New', 'Active')
      AND [System.AssignedTo] = @Me
    ORDER BY [System.Id]
  `.trim();
}

/**
 * WIQL query to find user stories in the current sprint assigned to the current user.
 * We fetch stories directly as well, to catch stories without tasks yet.
 */
export function buildSprintStoriesQuery(): string {
  return `
    SELECT [System.Id]
    FROM WorkItems
    WHERE
      [System.WorkItemType] = 'User Story'
      AND [System.IterationPath] = @CurrentIteration
      AND [System.AssignedTo] = @Me
    ORDER BY [System.Id]
  `.trim();
}
