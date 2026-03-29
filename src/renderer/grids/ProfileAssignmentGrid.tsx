import React, { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Grid } from '../components/Grid'
import { ExternalLink, ProfileSelect } from '../components/common'
import type { Story } from '../../shared/types'
import { theme } from '../styles/theme'

const columnHelper = createColumnHelper<Story>()

interface ProfileAssignmentGridProps {
  stories: Story[]
  profiles: string[]
  onAssignProfile: (storyId: number, profileKey: string) => void
}

export function ProfileAssignmentGrid({
  stories,
  profiles,
  onAssignProfile,
}: ProfileAssignmentGridProps) {
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
      data={stories}
      columns={columns}
      accentColor={theme.colors.mauve}
    />
  )
}
