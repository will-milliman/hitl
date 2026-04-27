import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import { GridState } from '../../shared/constants';
import type { ProfileMap, Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import {
  ActionLink,
  ActivityIndicator,
  ExternalLink,
  OverflowMenu,
  Placeholder,
  StatusIndicator,
  WorkItemTypeIcon,
} from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

interface ReviewGridProps {
  tasks: Task[];
  profiles: ProfileMap;
}

export function ReviewGrid({ tasks, profiles }: ReviewGridProps) {
  const utils = trpc.useContext();
  const openVSCode = trpc.openInVSCode.useMutation();
  const openExternal = trpc.openExternal.useMutation();
  const openExternalBatch = trpc.openExternalBatch.useMutation();
  const openSession = trpc.openSession.useMutation({ onSuccess: () => utils.tasks.invalidate() });
  const createVirtualDesktop = trpc.createVirtualDesktop.useMutation();
  const closeVirtualDesktop = trpc.closeVirtualDesktop.useMutation();
  const startFixSession = trpc.startFixSession.useMutation();
  const resetTask = trpc.resetTask.useMutation({ onSuccess: () => utils.tasks.invalidate() });

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: (info) => <StatusIndicator errorMessage={info.row.original.errorMessage} disabled={info.row.original.disabled} />,
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
      columnHelper.accessor('sessionId', {
        header: 'Copilot Session',
        meta: { shrink: true },
        cell: (info) => {
          const sessionId = info.getValue();
          const worktreePath = info.row.original.worktreePath;
          const disabled = info.row.original.disabled;
          const state = info.row.original.state;
          const taskId = info.row.original.id;
          // In PR_REVIEW, disabled means the PR is not ready to merge —
          // it does NOT mean a copilot session is active. Only treat
          // disabled as "session active" in TASK_EXECUTION state.
          const sessionActive = disabled && state !== GridState.PR_REVIEW;
          if (!sessionId && sessionActive) {
            return <ActivityIndicator tooltip="Starting session..." />;
          }
          if (!sessionId) return <Placeholder />;
          if (sessionActive) {
            return (
              <ActionLink
                onClick={() => {
                  if (worktreePath) {
                    openSession.mutate({ sessionId, cwd: worktreePath, taskId });
                  }
                }}
                title={`Session ${sessionId} is active — click to open in terminal`}
              >
                <ActivityIndicator tooltip={`Active session: ${sessionId}`} />
              </ActionLink>
            );
          }
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath, taskId });
                }
              }}
              title={`Open session ${sessionId} in terminal`}
            >
              {sessionId}
            </ActionLink>
          );
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
              title="Open VS Code, Azure work item, and PR on a new virtual desktop"
            >
              Open
            </ActionLink>
          );
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Open PR',
        meta: { shrink: true, minWidth: 80 },
        cell: (info) => {
          const prUrl = info.getValue();
          if (!prUrl) return <Placeholder />;
          return <ExternalLink href={prUrl}>{prUrl.split('/').pop()}</ExternalLink>;
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        meta: { fixedWidth: 50, overflowVisible: true },
        cell: (info) => {
          const row = info.row.original;
          const canFix = row.disabled && !row.sessionId && !!row.worktreePath && !!row.prUrl;
          const options = [
            ...(canFix ? [{ label: 'Fix', onClick: () => startFixSession.mutate({ taskId: row.id }) }] : []),
            {
              label: 'Reset',
              tooltip: 'Clean up the current session, worktree, and PR, then move this task back to Profile Assignment',
              onClick: () => resetTask.mutate({ taskId: row.id }),
            },
          ];
          return <OverflowMenu options={options} />;
        },
      }),
    ],
    [
      openVSCode,
      openExternal,
      openExternalBatch,
      openSession,
      createVirtualDesktop,
      closeVirtualDesktop,
      startFixSession,
      resetTask,
      utils,
      profiles,
    ],
  );

  return (
    <Grid
      title="PR Review"
      data={tasks}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.peach}
    />
  );
}
