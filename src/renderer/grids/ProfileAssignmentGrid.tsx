import { createColumnHelper } from '@tanstack/react-table';
import React, { useMemo } from 'react';
import styled from 'styled-components';

import { COPILOT_MODELS, DEFAULT_COPILOT_MODEL } from '../../shared/constants';
import type { Task } from '../../shared/types';
import { Grid } from '../components/Grid';
import { ExternalLink, ModelSelect, ProfileSelect, StatusIndicator, StyledCheckbox } from '../components/common';
import { theme } from '../styles/theme';

const columnHelper = createColumnHelper<Task>();

const ExecuteButton = styled.button`
  background: ${({ theme }) => theme.colors.green};
  color: ${({ theme }) => theme.colors.base};
  border: none;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.sans};
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
`;

interface ProfileAssignmentGridProps {
  tasks: Task[];
  profiles: string[];
  onAssignProfile: (taskId: number, profileKey: string, skipCopilot: boolean, model: string) => void;
}

export function ProfileAssignmentGrid({ tasks, profiles, onAssignProfile }: ProfileAssignmentGridProps) {
  const [skipCopilotMap, setSkipCopilotMap] = React.useState<Record<number, boolean>>({});

  // Local state for selected profiles (not yet executed)
  const [selectedProfileMap, setSelectedProfileMap] = React.useState<Record<number, string>>({});

  // Local state for selected models (not yet executed)
  const [selectedModelMap, setSelectedModelMap] = React.useState<Record<number, string>>({});

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
        meta: { fixedWidth: 70 },
        cell: (info) => <ExternalLink href={info.row.original.azureUrl}>{info.getValue()}</ExternalLink>,
      }),
      columnHelper.accessor('title', {
        header: 'Task Title',
      }),
      columnHelper.display({
        id: 'skipCopilot',
        header: 'Manual',
        meta: { fixedWidth: 70 },
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
              profiles={profiles}
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
        meta: { fixedWidth: 190 },
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
        id: 'execute',
        meta: { fixedWidth: 96 },
        cell: (info) => {
          const taskId = info.row.original.id;
          const profileKey = selectedProfileMap[taskId] ?? info.row.original.profileKey ?? '';
          const hasProfile = profileKey !== '';
          const model = selectedModelMap[taskId] ?? info.row.original.model ?? DEFAULT_COPILOT_MODEL;
          return (
            <ExecuteButton
              disabled={!hasProfile}
              onClick={() => {
                if (hasProfile) {
                  onAssignProfile(taskId, profileKey, skipCopilotMap[taskId] ?? false, model);
                }
              }}
              title={hasProfile ? 'Move task to Task Execution' : 'Select a profile first'}
            >
              Execute
            </ExecuteButton>
          );
        },
      }),
    ],
    [profiles, onAssignProfile, skipCopilotMap, selectedProfileMap, selectedModelMap],
  );

  return <Grid title="Profile Assignment" data={tasks} columns={columns} accentColor={theme.colors.mauve} />;
}
