import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ipcLink } from 'electron-trpc/renderer';
import React, { useMemo, useState } from 'react';
import { ThemeProvider } from 'styled-components';

import { GridState } from '../shared/constants';
import type { ProfileMap, Story, Task } from '../shared/types';

import { Layout } from './components/Layout';
import { ErrorBoundary, Spinner } from './components/common';
import { AbandonedGrid } from './grids/AbandonedGrid';
import { BlockedGrid } from './grids/BlockedGrid';
import { CompletedGrid } from './grids/CompletedGrid';
import { CopilotKickoffGrid } from './grids/CopilotKickoffGrid';
import { ErrorGrid } from './grids/ErrorGrid';
import { NonHitlGrid } from './grids/NonHitlGrid';
import { ProfileAssignmentGrid } from './grids/ProfileAssignmentGrid';
import { ReviewGrid } from './grids/ReviewGrid';
import { StoryPlanningGrid } from './grids/StoryPlanningGrid';
import { TaskExecutionGrid } from './grids/TaskExecutionGrid';
import { GlobalStyles } from './styles/global';
import { theme } from './styles/theme';
import { trpc } from './trpc/client';

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Disable automatic refetch on window focus — the app already uses
            // explicit refetchInterval polling for data freshness. The default
            // (true) causes all queries to refetch the moment the window regains
            // focus, which re-renders grids and closes any open native <select>
            // dropdowns mid-interaction.
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
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

  // Fetch unplanned stories for the Story Planning grid (exclude blocked)
  const storiesQuery = trpc.stories.useQuery({ planned: false, blocked: false }, { refetchInterval: 30_000 });

  // Fetch blocked stories for the Blocked grid
  const blockedStoriesQuery = trpc.stories.useQuery({ blocked: true }, { refetchInterval: 30_000 });

  const assignTaskProfileMutation = trpc.assignTaskProfile.useMutation({
    onSuccess: () => {
      utils.tasks.invalidate();
    },
  });

  const markNonHitlMutation = trpc.markNonHitl.useMutation({
    onSuccess: () => {
      utils.tasks.invalidate();
    },
  });

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const profiles = useMemo(() => profilesQuery.data ?? ({} as ProfileMap), [profilesQuery.data]);
  const stories = useMemo(() => (storiesQuery.data ?? []) as Story[], [storiesQuery.data]);
  const blockedStories = useMemo(() => (blockedStoriesQuery.data ?? []) as Story[], [blockedStoriesQuery.data]);
  const tasksByState = useMemo(() => {
    const grouped: Record<string, Task[]> = {
      [GridState.PROFILE_ASSIGNMENT]: [],
      [GridState.COPILOT_KICKOFF]: [],
      [GridState.TASK_EXECUTION]: [],
      [GridState.PR_REVIEW]: [],
      [GridState.COMPLETED]: [],
      [GridState.BLOCKED]: [],
      [GridState.ABANDONED]: [],
      [GridState.NON_HITL]: [],
      [GridState.ERROR]: [],
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

  const handleMarkNonHitl = (taskId: number) => {
    markNonHitlMutation.mutate({ taskId });
  };

  // Show loading spinner on initial load (after all hooks)
  if (tasksQuery.isLoading) {
    return <Spinner label="Loading work items..." />;
  }

  return (
    <>
      <StoryPlanningGrid stories={stories} profiles={profiles} />
      <ProfileAssignmentGrid
        tasks={tasksByState[GridState.PROFILE_ASSIGNMENT]}
        profiles={profiles}
        onAssignProfile={handleAssignProfile}
        onMarkNonHitl={handleMarkNonHitl}
      />
      <CopilotKickoffGrid tasks={tasksByState[GridState.COPILOT_KICKOFF]} />
      <TaskExecutionGrid tasks={tasksByState[GridState.TASK_EXECUTION]} profiles={profiles} />
      <ReviewGrid tasks={tasksByState[GridState.PR_REVIEW]} profiles={profiles} />
      <CompletedGrid tasks={tasksByState[GridState.COMPLETED]} />
      <ErrorGrid tasks={tasksByState[GridState.ERROR]} />
      <BlockedGrid tasks={tasksByState[GridState.BLOCKED]} blockedStories={blockedStories} />
      <AbandonedGrid tasks={tasksByState[GridState.ABANDONED]} />
      <NonHitlGrid tasks={tasksByState[GridState.NON_HITL]} />
    </>
  );
}
