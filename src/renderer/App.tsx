import React, { useState, useMemo } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'styled-components'
import { ipcLink } from 'electron-trpc/renderer'
import { trpc } from './trpc/client'
import { theme } from './styles/theme'
import { GlobalStyles } from './styles/global'
import { Layout } from './components/Layout'
import { ErrorBoundary, Spinner } from './components/common'
import { ProfileAssignmentGrid } from './grids/ProfileAssignmentGrid'
import { PlanApprovalGrid } from './grids/PlanApprovalGrid'
import { TaskPRReviewGrid } from './grids/TaskPRReviewGrid'
import { StoryPRReviewGrid } from './grids/StoryPRReviewGrid'
import { CompletedGrid } from './grids/CompletedGrid'
import { BlockedGrid } from './grids/BlockedGrid'
import { GridState } from '../shared/constants'
import type { Story } from '../shared/types'

export function App() {
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [ipcLink()],
    })
  )

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
  )
}

function AppShell() {
  // Poll cron status every 10 seconds for live updates
  const cronStatusQuery = trpc.cronStatus.useQuery(undefined, {
    refetchInterval: 10_000,
  })

  return (
    <Layout connected cronStatus={cronStatusQuery.data ?? null}>
      <AppContent />
    </Layout>
  )
}

function AppContent() {
  const utils = trpc.useContext()

  const storiesQuery = trpc.stories.useQuery(undefined, {
    refetchInterval: 30_000, // Refresh stories every 30s to pick up sync changes
  })
  const tasksQuery = trpc.tasks.useQuery(undefined, {
    refetchInterval: 30_000,
  })
  const profilesQuery = trpc.profiles.useQuery()

  const assignProfileMutation = trpc.assignProfile.useMutation({
    onSuccess: () => {
      // Invalidate stories query to refetch from DB
      utils.stories.invalidate()
    },
  })

  const stories = storiesQuery.data ?? []
  const tasks = tasksQuery.data ?? []
  const profileKeys = useMemo(
    () => Object.keys(profilesQuery.data ?? {}),
    [profilesQuery.data]
  )

  const storiesByState = useMemo(() => {
    const grouped: Record<string, Story[]> = {
      [GridState.PROFILE_ASSIGNMENT]: [],
      [GridState.PLAN_APPROVAL]: [],
      [GridState.TASK_PR_REVIEW]: [],
      [GridState.STORY_PR_REVIEW]: [],
      [GridState.COMPLETED]: [],
      [GridState.BLOCKED]: [],
    }
    for (const story of stories) {
      if (grouped[story.state]) {
        grouped[story.state].push(story)
      }
    }
    return grouped
  }, [stories])

  const handleAssignProfile = (storyId: number, profileKey: string) => {
    assignProfileMutation.mutate({ storyId, profileKey })
  }

  // Filter tasks for completed stories
  const completedStoryIds = useMemo(
    () => new Set(storiesByState[GridState.COMPLETED].map((s) => s.id)),
    [storiesByState]
  )
  const completedTasks = useMemo(
    () => tasks.filter((t) => completedStoryIds.has(t.storyId)),
    [tasks, completedStoryIds]
  )

  // Show loading spinner on initial load (after all hooks)
  if (storiesQuery.isLoading || tasksQuery.isLoading) {
    return <Spinner label="Loading work items..." />
  }

  return (
    <>
      <ProfileAssignmentGrid
        stories={storiesByState[GridState.PROFILE_ASSIGNMENT]}
        profiles={profileKeys}
        onAssignProfile={handleAssignProfile}
      />
      <PlanApprovalGrid
        stories={storiesByState[GridState.PLAN_APPROVAL]}
      />
      <TaskPRReviewGrid tasks={tasks} />
      <StoryPRReviewGrid
        stories={storiesByState[GridState.STORY_PR_REVIEW]}
      />
      <CompletedGrid
        stories={storiesByState[GridState.COMPLETED]}
        tasks={completedTasks}
      />
      <BlockedGrid
        stories={storiesByState[GridState.BLOCKED]}
      />
    </>
  )
}
