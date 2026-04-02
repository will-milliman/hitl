import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ipcLink } from 'electron-trpc/renderer';
import React, { useMemo, useState } from 'react';
import { ThemeProvider } from 'styled-components';

import { GridState } from '../shared/constants';
import type { ProfileMap, Task } from '../shared/types';

import { Layout } from './components/Layout';
import { ErrorBoundary, Spinner } from './components/common';
import { AbandonedGrid } from './grids/AbandonedGrid';
import { BlockedGrid } from './grids/BlockedGrid';
import { CompletedGrid } from './grids/CompletedGrid';
import { ProfileAssignmentGrid } from './grids/ProfileAssignmentGrid';
import { ReviewGrid } from './grids/ReviewGrid';
import { TaskExecutionGrid } from './grids/TaskExecutionGrid';
import { GlobalStyles } from './styles/global';
import { theme } from './styles/theme';
import { trpc } from './trpc/client';

export function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [ipcLink()],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider theme={theme}>
          <GlobalStyles />
          <ErrorBoundary>
            <AppShell />
          </ErrorBoundary>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function AppShell() {
  // Poll cron status every 10 seconds for live updates
  const cronStatusQuery = trpc.cronStatus.useQuery(undefined, {
    refetchInterval: 10_000,
  });

  return (
    <Layout connected cronStatus={cronStatusQuery.data ?? null}>
      <AppContent />
    </Layout>
  );
}

function AppContent() {
  const utils = trpc.useContext();

  const tasksQuery = trpc.tasks.useQuery(undefined, {
    refetchInterval: 30_000, // Refresh tasks every 30s to pick up sync changes
  });
  const profilesQuery = trpc.profiles.useQuery();

  const assignTaskProfileMutation = trpc.assignTaskProfile.useMutation({
    onSuccess: () => {
      utils.tasks.invalidate();
    },
  });

  const tasks = tasksQuery.data ?? [];
  const profiles = profilesQuery.data ?? ({} as ProfileMap);
  const profileKeys = useMemo(() => Object.keys(profiles), [profiles]);

  const tasksByState = useMemo(() => {
    const grouped: Record<string, Task[]> = {
      [GridState.PROFILE_ASSIGNMENT]: [],
      [GridState.TASK_EXECUTION]: [],
      [GridState.PR_REVIEW]: [],
      [GridState.COMPLETED]: [],
      [GridState.BLOCKED]: [],
      [GridState.ABANDONED]: [],
    };
    for (const task of tasks) {
      if (grouped[task.state]) {
        grouped[task.state].push(task);
      }
    }
    return grouped;
  }, [tasks]);

  const handleAssignProfile = (taskId: number, profileKey: string, skipCopilot: boolean, model: string) => {
    assignTaskProfileMutation.mutate({ taskId, profileKey, skipCopilot, model });
  };

  // Show loading spinner on initial load (after all hooks)
  if (tasksQuery.isLoading) {
    return <Spinner label="Loading work items..." />;
  }

  return (
    <>
      <ProfileAssignmentGrid
        tasks={tasksByState[GridState.PROFILE_ASSIGNMENT]}
        profiles={profileKeys}
        onAssignProfile={handleAssignProfile}
      />
      <TaskExecutionGrid tasks={tasksByState[GridState.TASK_EXECUTION]} profiles={profiles} />
      <ReviewGrid tasks={tasksByState[GridState.PR_REVIEW]} profiles={profiles} />
      <CompletedGrid tasks={tasksByState[GridState.COMPLETED]} />
      <BlockedGrid tasks={tasksByState[GridState.BLOCKED]} />
      <AbandonedGrid tasks={tasksByState[GridState.ABANDONED]} />
    </>
  );
}
