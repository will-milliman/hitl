import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ActionLink, Placeholder, ErrorIndicator } from '../components/common'
import { trpc } from '../trpc/client'
import type { Story } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Story>()

interface StoryPRReviewGridProps {
  stories: Story[]
}

export function StoryPRReviewGrid({ stories }: StoryPRReviewGridProps) {
  const openVSCode = trpc.openInVSCode.useMutation()
  const openTerminal = trpc.openInTerminal.useMutation()
  const openExternal = trpc.openExternal.useMutation()
  const openSession = trpc.openSession.useMutation()

  const columns = useMemo(
    () => [
      columnHelper.accessor('id', {
        header: 'Story Id',
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Story Title',
      }),
      columnHelper.accessor('worktreePath', {
        header: 'Worktree',
        cell: (info) => {
          const path = info.getValue()
          if (!path) return <Placeholder />
          return (
            <ActionLink
              onClick={() => openVSCode.mutate({ path })}
              title={`Open ${path} in VS Code`}
            >
              Open in VS Code
            </ActionLink>
          )
        },
      }),
      columnHelper.accessor('sessionId', {
        header: 'Session',
        cell: (info) => {
          const sessionId = info.getValue()
          const worktreePath = info.row.original.worktreePath
          if (!sessionId) return <Placeholder />
          return (
            <ActionLink
              onClick={() => {
                if (worktreePath) {
                  openSession.mutate({ sessionId, cwd: worktreePath })
                }
              }}
              title={`Open session ${sessionId} in terminal`}
            >
              {sessionId.substring(0, 8)}...
            </ActionLink>
          )
        },
      }),
      columnHelper.display({
        id: 'workspace',
        header: 'Workspace',
        cell: (info) => {
          const row = info.row.original
          if (!row.worktreePath) return <Placeholder />
          return (
            <ActionLink
              onClick={() => {
                openVSCode.mutate({ path: row.worktreePath! })
                openTerminal.mutate({ path: row.worktreePath! })
                openExternal.mutate({ url: row.azureUrl })
                if (row.prUrl) {
                  openExternal.mutate({ url: row.prUrl })
                }
                if (row.sessionId) {
                  openSession.mutate({
                    sessionId: row.sessionId,
                    cwd: row.worktreePath!,
                  })
                }
              }}
              title="Open VS Code, Terminal, Azure work item, PR, and Session"
            >
              Open All
            </ActionLink>
          )
        },
      }),
      columnHelper.accessor('prUrl', {
        header: 'Pull Request',
        cell: (info) => {
          const prUrl = info.getValue()
          if (!prUrl) return <Placeholder />
          return (
            <ExternalLink href={prUrl}>
              {prUrl.split('/').pop()}
            </ExternalLink>
          )
        },
      }),
      columnHelper.accessor('errorMessage', {
        header: 'Status',
        cell: (info) => {
          const error = info.getValue()
          return <ErrorIndicator errorMessage={error} />
        },
      }),
    ],
    [openVSCode, openTerminal, openExternal, openSession]
  )

  return (
    <Grid
      title="Story PR Review"
      data={stories}
      columns={columns}
      getRowDisabled={(row) => row.disabled}
      accentColor={theme.colors.yellow}
    />
  )
}
