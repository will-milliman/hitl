import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { ProfileMap, Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import {
  ActionLink,
  ExternalLink,
  OverflowMenu,
  Placeholder,
  StatusIndicator,
  WorkItemTypeIcon,
  formatRelativeTime,
} from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

interface TaskExecutionGridProps {
  tasks: Task[];
  profiles: ProfileMap;
}

export function TaskExecutionGrid({ tasks, profiles }: TaskExecutionGridProps) {
  const utils = trpc.useContext();
  const openVSCode = trpc.openInVSCode.useMutation();
  const openExternalBatch = trpc.openExternalBatch.useMutation();
  const createVirtualDesktop = trpc.createVirtualDesktop.useMutation();
  const closeVirtualDesktop = trpc.closeVirtualDesktop.useMutation();
  const resetTask = trpc.resetTask.useMutation({ onSuccess: () => utils.tasks.invalidate() });

  // Sort by lastAgentResponse ascending — oldest (needs attention longest) at top.
  // Tasks without a lastAgentResponse go to the bottom.
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aTime = a.lastAgentResponse ? new Date(a.lastAgentResponse).getTime() : Infinity;
      const bTime = b.lastAgentResponse ? new Date(b.lastAgentResponse).getTime() : Infinity;
      return aTime - bTime;
    });
  }, [tasks]);

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: (info) => (
          <StatusIndicator errorMessage={info.row.original.errorMessage} disabled={info.row.original.desktopOpen} />
        ),
      }),
      columnHelper.accessor('id', {
        header: 'Task Id',
        meta: { fixedWidth: 90 },
        cell: (info) => (
          <>
            <WorkItemTypeIcon type={info.row.original.workItemType} />{' '}
            <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>
          </>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.accessor('lastAgentResponse', {
        header: 'Last Agent Response',
        meta: { shrink: true, minWidth: 120 },
        cell: (info) => {
          const value = info.getValue();
          if (!value) return <Placeholder />;
          return <span title={new Date(value).toLocaleString()}>{formatRelativeTime(value)}</span>;
        },
      }),
      columnHelper.accessor('worktreePath', {
        header: 'IDE',
        meta: { fixedWidth: 200 },
        cell: (info) => {
          const path = info.getValue();
          const profileKey = info.row.original.profileKey;
          const profile = profileKey ? profiles[profileKey] : undefined;
          const workspace = profile?.workspace;
          if (!path) return <Placeholder />;

          // If a workspace file is configured, show just the filename (e.g. "foo.code-workspace").
          // Otherwise, show the repo name derived from the profile's repoPath.
          const label = workspace
            ? workspace.split(/[\\/]/).pop()
            : profile?.repoPath
              ? profile.repoPath.split(/[\\/]/).pop()
              : path.split(/[\\/]/).pop();

          return (
            <ActionLink onClick={() => openVSCode.mutate({ path, workspace })} title={`Open ${workspace ?? path} in VS Code`}>
              {label}
            </ActionLink>
          );
        },
      }),
      columnHelper.display({
        id: 'workspace',
        header: 'Virtual Desktop',
        meta: { shrink: true },
        cell: (info) => {
          const row = info.row.original;
          if (!row.worktreePath) return <Placeholder />;
          const workspace = row.profileKey ? profiles[row.profileKey]?.workspace : undefined;
          const isOpen = row.desktopOpen;

          if (isOpen) {
            const isClosing = closeVirtualDesktop.isPending && closeVirtualDesktop.variables?.taskId === row.id;
            return (
              <ActionLink
                onClick={() => {
                  if (isClosing) return;
                  closeVirtualDesktop
                    .mutateAsync({ taskId: row.id })
                    .then(() => utils.tasks.invalidate())
                    .catch((e) => console.error('[grid] closeVirtualDesktop failed:', e));
                }}
                title="Close all windows and remove this virtual desktop"
              >
                {isClosing ? 'Closing...' : 'Close'}
              </ActionLink>
            );
          }

          return (
            <ActionLink
              onClick={async () => {
                try {
                  await createVirtualDesktop.mutateAsync({
                    taskId: row.id,
                    worktreePath: row.worktreePath!,
                  });
                } catch (e) {
                  console.error('[grid] createVirtualDesktop failed:', e);
                }
                utils.tasks.invalidate();
                const opens: Promise<unknown>[] = [
                  openVSCode
                    .mutateAsync({ path: row.worktreePath!, workspace })
                    .catch((e) => console.error('[grid] openVSCode failed:', e)),
                ];
                // Batch Azure URL and PR URL into a single browser window with tabs
                const urls = [row.azureUrl];
                if (row.prUrl) urls.push(row.prUrl);
                opens.push(
                  openExternalBatch.mutateAsync({ urls }).catch((e) => console.error('[grid] openExternalBatch failed:', e)),
                );
                await Promise.all(opens);
              }}
              title="Open VS Code and Azure work item on a new virtual desktop"
            >
              Open
            </ActionLink>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        meta: { fixedWidth: 50, overflowVisible: true },
        cell: (info) => {
          const row = info.row.original;
          return (
            <OverflowMenu
              options={[
                {
                  label: 'Reset',
                  tooltip: 'Clean up the current session, worktree, and PR, then move this task back to Profile Assignment',
                  onClick: () => resetTask.mutate({ taskId: row.id }),
                },
              ]}
            />
          );
        },
      }),
    ],
    [openVSCode, openExternalBatch, createVirtualDesktop, closeVirtualDesktop, resetTask, utils, profiles],
  );

  return (
    <Grid
      title="Task Execution"
      data={sortedTasks}
      columns={columns}
      getRowDisabled={(row) => row.desktopOpen}
      accentColor={theme.colors.blue}
    />
  );
}
