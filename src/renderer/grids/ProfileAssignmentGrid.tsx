import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';

import { COPILOT_MODELS, DEFAULT_COPILOT_MODEL } from '../../shared/constants';
import type { ProfileMap, Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import {
  ExternalLink,
  ModelSelect,
  OverflowMenu,
  ProfileSelect,
  StatusIndicator,
  StyledCheckbox,
  WorkItemTypeIcon,
} from '../components/common';
import { theme } from '../styles/theme';

const columnHelper = createColumnHelper<Task>();

interface ProfileAssignmentGridProps {
  tasks: Task[];
  profiles: ProfileMap;
  onAssignProfile: (taskId: number, profileKey: string, skipCopilot: boolean, model: string) => void;
  onMarkNonHitl: (taskId: number) => void;
}

export function ProfileAssignmentGrid({ tasks, profiles, onAssignProfile, onMarkNonHitl }: ProfileAssignmentGridProps) {
  const [skipCopilotMap, setSkipCopilotMap] = React.useState<Record<number, boolean>>({});

  // Local state for selected profiles (not yet executed)
  const [selectedProfileMap, setSelectedProfileMap] = React.useState<Record<number, string>>({});

  // Local state for selected models (not yet executed)
  const [selectedModelMap, setSelectedModelMap] = React.useState<Record<number, string>>({});

  const profileKeys = useMemo(() => Object.keys(profiles), [profiles]);

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
      columnHelper.display({
        id: 'skipCopilot',
        header: 'Manual Execution',
        meta: { fixedWidth: 140 },
        cell: (info) => {
          const taskId = info.row.original.id;
          const checked = skipCopilotMap[taskId] ?? false;
          return (
            <StyledCheckbox
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                setSkipCopilotMap((prev) => ({
                  ...prev,
                  [taskId]: e.target.checked,
                }));
              }}
              title="Skip automatic copilot execution (manual mode)"
            />
          );
        },
      }),
      columnHelper.display({
        id: 'profile',
        header: 'Profile',
        meta: { fixedWidth: 176 },
        cell: (info) => {
          const taskId = info.row.original.id;
          const selected = selectedProfileMap[taskId] ?? info.row.original.profileKey ?? '';
          return (
            <ProfileSelect
              profiles={profileKeys}
              value={selected}
              onChange={(value) => {
                setSelectedProfileMap((prev) => ({
                  ...prev,
                  [taskId]: value,
                }));
              }}
            />
          );
        },
      }),
      columnHelper.display({
        id: 'model',
        header: 'Model',
        meta: { fixedWidth: 182 },
        cell: (info) => {
          const taskId = info.row.original.id;
          const selected = selectedModelMap[taskId] ?? info.row.original.model ?? DEFAULT_COPILOT_MODEL;
          return (
            <ModelSelect
              models={COPILOT_MODELS}
              value={selected}
              onChange={(value) => {
                setSelectedModelMap((prev) => ({
                  ...prev,
                  [taskId]: value,
                }));
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
          const taskId = info.row.original.id;
          const profileKey = selectedProfileMap[taskId] ?? info.row.original.profileKey ?? '';
          const hasProfile = profileKey !== '';
          const model = selectedModelMap[taskId] ?? info.row.original.model ?? DEFAULT_COPILOT_MODEL;
          return (
            <OverflowMenu
              options={[
                {
                  label: 'Execute',
                  tooltip: hasProfile ? 'Move task to Task Execution' : 'Select a profile first',
                  onClick: () => {
                    if (hasProfile) {
                      onAssignProfile(taskId, profileKey, skipCopilotMap[taskId] ?? false, model);
                    }
                  },
                },
                {
                  label: 'Exit HITL Flow',
                  tooltip: 'Mark as Non-HITL (no task execution or PR needed)',
                  onClick: () => onMarkNonHitl(taskId),
                },
              ]}
            />
          );
        },
      }),
    ],
    [profiles, profileKeys, onAssignProfile, onMarkNonHitl, skipCopilotMap, selectedProfileMap, selectedModelMap],
  );

  return <Grid title="Profile Assignment" data={tasks} columns={columns} accentColor={theme.colors.mauve} />;
}
