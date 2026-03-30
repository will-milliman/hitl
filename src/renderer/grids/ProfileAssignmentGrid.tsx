import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ProfileSelect } from '../components/common'
import type { Task } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Task>()

interface ProfileAssignmentGridProps {
  tasks: Task[]
  profiles: string[]
  onAssignProfile: (taskId: number, profileKey: string) => void
}

export function ProfileAssignmentGrid({
  tasks,
  profiles,
  onAssignProfile,
}: ProfileAssignmentGridProps) {
  const columns = useMemo(
    () => [
      columnHelper.accessor('id', {
        header: 'Task Id',
        cell: (info) => (
          <ExternalLink href={info.row.original.azureUrl}>
            {info.getValue()}
          </ExternalLink>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.display({
        id: 'story',
        header: 'Story',
        cell: (info) => {
          const story = info.row.original.story
          if (!story) return null
          return (
            <ExternalLink href={story.azureUrl}>
              #{story.id}
            </ExternalLink>
          )
        },
      }),
      columnHelper.display({
        id: 'profile',
        header: 'Profile',
        cell: (info) => (
          <ProfileSelect
            profiles={profiles}
            value={info.row.original.profileKey}
            onChange={(value) => onAssignProfile(info.row.original.id, value)}
          />
        ),
      }),
    ],
    [profiles, onAssignProfile]
  )

  return (
    <Grid
      title="Profile Assignment"
      data={tasks}
      columns={columns}
      accentColor={theme.colors.mauve}
    />
  )
}
