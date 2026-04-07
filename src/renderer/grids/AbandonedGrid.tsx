import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ActionLink, ExternalLink, Placeholder, StatusIndicator, WorkItemTypeIcon } from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

interface AbandonedGridProps {
  tasks: Task[];
}

export function AbandonedGrid({ tasks }: AbandonedGridProps) {
  const utils = trpc.useUtils();
  const openSession = trpc.openSession.useMutation({
    onSuccess: () => utils.tasks.invalidate(),
  });

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
        meta: { fixedWidth: 120 },
        cell: (info) => {
          const sessionId = info.getValue();
          const worktreePath = info.row.original.worktreePath;
          const taskId = info.row.original.id;
          if (!sessionId) return <Placeholder />;
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath, taskId });
                }
              }}
              title={`Open session ${sessionId} in terminal`}
            >
              Open
            </ActionLink>
          );
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Pull Request',
        cell: (info) => {
          const prUrl = info.getValue();
          if (!prUrl) return <Placeholder />;
          return <ExternalLink href={prUrl}>{prUrl.split('/').pop()}</ExternalLink>;
        },
      }),
    ],
    [openSession],
  );

  return (
    <Grid
      title="Abandoned"
      data={tasks}
      columns={columns}
      defaultExpanded={false}
      getRowDisabled={() => true}
      accentColor={theme.colors.maroon}
    />
  );
}
