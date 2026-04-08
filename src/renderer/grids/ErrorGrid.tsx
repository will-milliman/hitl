import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ExternalLink, OverflowMenu, StatusIndicator, WorkItemTypeIcon } from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Task>();

interface ErrorGridProps {
  tasks: Task[];
}

export function ErrorGrid({ tasks }: ErrorGridProps) {
  const utils = trpc.useContext();
  const retryTask = trpc.retryTask.useMutation({ onSuccess: () => utils.tasks.invalidate() });
  const resetTask = trpc.resetTask.useMutation({ onSuccess: () => utils.tasks.invalidate() });

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: (info) => <StatusIndicator errorMessage={info.row.original.errorMessage} />,
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
      columnHelper.accessor('errorMessage', {
        header: 'Error',
        meta: { shrink: true, minWidth: 200 },
        cell: (info) => {
          const msg = info.getValue();
          if (!msg) return null;
          // Show first 120 chars with full message on hover
          const display = msg.length > 120 ? msg.slice(0, 120) + '...' : msg;
          return <span title={msg}>{display}</span>;
        },
      }),
      columnHelper.accessor('errorAt', {
        header: 'Error At',
        meta: { fixedWidth: 160 },
        cell: (info) => {
          const date = info.getValue();
          if (!date) return null;
          return new Date(date).toLocaleString();
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
                  label: 'Retry',
                  tooltip: 'Clear the error and move this task back so the pipeline can retry',
                  onClick: () => retryTask.mutate({ taskId: row.id }),
                },
                {
                  label: 'Reset',
                  tooltip: 'Clean up and move this task back to Profile Assignment',
                  onClick: () => resetTask.mutate({ taskId: row.id }),
                },
              ]}
            />
          );
        },
      }),
    ],
    [retryTask, resetTask],
  );

  return <Grid title="Error" data={tasks} columns={columns} accentColor={theme.colors.flamingo} />;
}
