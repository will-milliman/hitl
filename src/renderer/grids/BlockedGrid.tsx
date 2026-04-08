import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { Story, Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ExternalLink, StatusIndicator, WorkItemTypeIcon } from '../components/common';
import { theme } from '../styles/theme';

const taskColumnHelper = createColumnHelper<Task>();
const storyColumnHelper = createColumnHelper<Story>();

interface BlockedGridProps {
  tasks: Task[];
  blockedStories: Story[];
}

export function BlockedGrid({ tasks, blockedStories }: BlockedGridProps) {
  const taskColumns = useMemo(
    () => [
      taskColumnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: (info) => <StatusIndicator errorMessage={info.row.original.errorMessage} disabled={info.row.original.disabled} />,
      }),
      taskColumnHelper.accessor('id', {
        header: 'Task Id',
        meta: { fixedWidth: 90 },
        cell: (info) => (
          <>
            <WorkItemTypeIcon type={info.row.original.workItemType} />{' '}
            <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>
          </>
        ),
      }),
      taskColumnHelper.accessor('title', {
        header: 'Task Title',
      }),
    ],
    [],
  );

  const storyColumns = useMemo(
    () => [
      storyColumnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: () => <StatusIndicator />,
      }),
      storyColumnHelper.accessor('id', {
        header: 'Story Id',
        meta: { fixedWidth: 90 },
        cell: (info) => (
          <>
            <span title="User Story">📖</span> <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>
          </>
        ),
      }),
      storyColumnHelper.accessor('title', {
        header: 'Story Title',
      }),
    ],
    [],
  );

  const allData = [...tasks, ...blockedStories];

  return (
    <>
      {tasks.length > 0 && (
        <Grid
          title="Blocked"
          data={tasks}
          columns={taskColumns}
          defaultExpanded={false}
          getRowDisabled={() => true}
          accentColor={theme.colors.red}
        />
      )}
      {blockedStories.length > 0 && (
        <Grid
          title={tasks.length > 0 ? 'Blocked Stories' : 'Blocked'}
          data={blockedStories}
          columns={storyColumns}
          defaultExpanded={false}
          getRowDisabled={() => true}
          accentColor={theme.colors.red}
        />
      )}
      {allData.length === 0 && (
        <Grid
          title="Blocked"
          data={[] as Task[]}
          columns={taskColumns}
          defaultExpanded={false}
          getRowDisabled={() => true}
          accentColor={theme.colors.red}
        />
      )}
    </>
  );
}
