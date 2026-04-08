import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import type { ProfileMap, Story } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ExternalLink, OverflowMenu, ProfileSelect, StatusIndicator } from '../components/common';
import { theme } from '../styles/theme';
import { trpc } from '../trpc/client';

const columnHelper = createColumnHelper<Story>();

interface StoryPlanningGridProps {
  stories: Story[];
  profiles: ProfileMap;
}

export function StoryPlanningGrid({ stories, profiles }: StoryPlanningGridProps) {
  const utils = trpc.useContext();
  const openVSCode = trpc.openInVSCode.useMutation();
  const completeStoryPlanning = trpc.completeStoryPlanning.useMutation({
    onSuccess: () => {
      utils.stories.invalidate();
    },
  });

  const [selectedProfileMap, setSelectedProfileMap] = React.useState<Record<number, string>>({});
  const profileKeys = useMemo(() => Object.keys(profiles), [profiles]);

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'status',
        header: '',
        meta: { fixedWidth: 20 },
        cell: () => <StatusIndicator />,
      }),
      columnHelper.accessor('id', {
        header: 'Story Id',
        meta: { fixedWidth: 90 },
        cell: (info) => (
          <>
            <span title="User Story">📖</span> <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>
          </>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Story Title',
      }),
      columnHelper.display({
        id: 'ide',
        header: 'IDE',
        meta: { fixedWidth: 176 },
        cell: (info) => {
          const storyId = info.row.original.id;
          const selectedProfile = selectedProfileMap[storyId] ?? '';

          return (
            <ProfileSelect
              profiles={profileKeys}
              value={selectedProfile}
              onChange={(value) => {
                setSelectedProfileMap((prev) => ({ ...prev, [storyId]: value }));
                const profile = value ? profiles[value] : undefined;
                if (profile) {
                  openVSCode.mutate({ path: profile.repoPath, workspace: profile.workspace });
                }
              }}
            />
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        meta: { fixedWidth: 50, overflowVisible: true },
        cell: (info) => {
          const storyId = info.row.original.id;
          return (
            <OverflowMenu
              options={[
                {
                  label: 'Done',
                  tooltip: 'Validate child tasks exist, then mark planning as complete',
                  onClick: () => completeStoryPlanning.mutate({ storyId }),
                },
              ]}
            />
          );
        },
      }),
    ],
    [profiles, profileKeys, openVSCode, completeStoryPlanning, selectedProfileMap],
  );

  return <Grid title="Story Planning" data={stories} columns={columns} accentColor={theme.colors.yellow} />;
}
