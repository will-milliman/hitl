import React, { useState, useEffect } from 'react'
import styled from 'styled-components'
import { trpc } from '../../trpc/client'

// ─── Styled Components ─────────────────────────────────

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
`

const Panel = styled.div`
  background: ${({ theme }) => theme.colors.base};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
  border-radius: ${({ theme }) => theme.radii.lg};
  width: 680px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
`

const PanelTitle = styled.h2`
  font-size: 16px;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`

const CloseButton = styled.button`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.overlay1};
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: ${({ theme }) => theme.radii.sm};

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`

const TabBar = styled.div`
  display: flex;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surface0};
  padding: 0 20px;
`

const Tab = styled.button<{ $active: boolean }>`
  background: none;
  border: none;
  border-bottom: 2px solid ${({ theme, $active }) =>
    $active ? theme.colors.mauve : 'transparent'};
  color: ${({ theme, $active }) =>
    $active ? theme.colors.text : theme.colors.overlay1};
  font-family: ${({ theme }) => theme.fonts.sans};
  font-size: 13px;
  font-weight: 500;
  padding: 10px 16px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`

const TabContent = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 20px;
`

const Section = styled.div`
  margin-bottom: 24px;

  &:last-child {
    margin-bottom: 0;
  }
`

const SectionTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.subtext0};
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 0 0 12px 0;
`

const FieldGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const FieldRow = styled.label`
  display: flex;
  align-items: center;
  gap: 10px;
`

const FieldLabel = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.subtext0};
  font-weight: 500;
`

const Input = styled.input`
  background: ${({ theme }) => theme.colors.surface0};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
  border-radius: ${({ theme }) => theme.radii.sm};
  padding: 8px 10px;
  font-size: 13px;
  font-family: ${({ theme }) => theme.fonts.mono};
  width: 100%;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.mauve};
  }

  &::placeholder {
    color: ${({ theme }) => theme.colors.overlay0};
  }
`

const Select = styled.select`
  background: ${({ theme }) => theme.colors.surface0};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
  border-radius: ${({ theme }) => theme.radii.sm};
  padding: 8px 10px;
  font-size: 13px;
  font-family: ${({ theme }) => theme.fonts.mono};
  width: 100%;
  cursor: pointer;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.mauve};
  }

  option {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`

const Toggle = styled.input`
  accent-color: ${({ theme }) => theme.colors.mauve};
  width: 16px;
  height: 16px;
  cursor: pointer;
`

const ToggleLabel = styled.span`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  cursor: pointer;
`

const Footer = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid ${({ theme }) => theme.colors.surface0};
`

const Button = styled.button<{ $primary?: boolean }>`
  background: ${({ theme, $primary }) =>
    $primary ? theme.colors.mauve : theme.colors.surface0};
  color: ${({ theme, $primary }) =>
    $primary ? theme.colors.crust : theme.colors.text};
  border: 1px solid ${({ theme, $primary }) =>
    $primary ? theme.colors.mauve : theme.colors.surface1};
  border-radius: ${({ theme }) => theme.radii.sm};
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.sans};
  cursor: pointer;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const ProfileCard = styled.div`
  background: ${({ theme }) => theme.colors.mantle};
  border: 1px solid ${({ theme }) => theme.colors.surface0};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 12px;
  margin-bottom: 8px;
`

const ProfileHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
`

const ProfileName = styled.span`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.lavender};
`

const RemoveButton = styled.button`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.red};
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: ${({ theme }) => theme.radii.sm};

  &:hover {
    background: ${({ theme }) => theme.colors.surface0};
  }
`

const SmallInput = styled(Input)`
  font-size: 12px;
  padding: 6px 8px;
`

const StatusText = styled.span<{ $color?: string }>`
  font-size: 12px;
  color: ${({ $color, theme }) => $color || theme.colors.overlay1};
`

// ─── Types ──────────────────────────────────────────────

type TabId = 'azure' | 'cron' | 'profiles' | 'notifications' | 'terminal' | 'about'

interface SettingsData {
  azure: { org: string; project: string; pat: string; team: string }
  cron: { intervalSeconds: number; idleThresholdSeconds: number }
  profiles: Record<string, { repoPath: string; defaultBranch: string; description?: string }>
  notifications: { enabled: boolean; prReviewNeeded: boolean; taskCompleted: boolean; cronErrors: boolean }
  terminal: { shell: 'pwsh' | 'powershell' | 'cmd' }
}

// ─── Component ──────────────────────────────────────────

interface SettingsPageProps {
  onClose: () => void
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('azure')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const settingsQuery = trpc.getSettings.useQuery()
  const cronStateQuery = trpc.cronState.useQuery()
  const updateStatusQuery = trpc.updateStatus.useQuery(undefined, { refetchInterval: 30_000 })
  const saveMutation = trpc.saveSettings.useMutation()
  const updateCronMutation = trpc.updateCronState.useMutation()
  const checkUpdatesMutation = trpc.checkForUpdates.useMutation()
  const installUpdateMutation = trpc.installUpdate.useMutation()

  const [formData, setFormData] = useState<SettingsData | null>(null)
  const [cronFlags, setCronFlags] = useState<{
    syncEnabled: boolean
    taskExecutionEnabled: boolean
    prCheckEnabled: boolean
  } | null>(null)

  // New profile form state
  const [newProfileKey, setNewProfileKey] = useState('')

  // Initialize form data when settings load
  useEffect(() => {
    if (settingsQuery.data && !formData) {
      setFormData(settingsQuery.data as SettingsData)
    }
  }, [settingsQuery.data, formData])

  useEffect(() => {
    if (cronStateQuery.data && !cronFlags) {
      setCronFlags({
        syncEnabled: cronStateQuery.data.syncEnabled,
        taskExecutionEnabled: cronStateQuery.data.taskExecutionEnabled,
        prCheckEnabled: cronStateQuery.data.prCheckEnabled,
      })
    }
  }, [cronStateQuery.data, cronFlags])

  const updateField = <K extends keyof SettingsData>(
    section: K,
    key: keyof SettingsData[K],
    value: SettingsData[K][keyof SettingsData[K]]
  ) => {
    if (!formData) return
    setFormData({
      ...formData,
      [section]: { ...formData[section], [key]: value },
    })
    setDirty(true)
    setSaveMessage(null)
  }

  const handleSave = async () => {
    if (!formData) return
    setSaving(true)
    setSaveMessage(null)
    try {
      await saveMutation.mutateAsync(formData)

      // Save cron flags separately (they're in the DB, not settings.json)
      if (cronFlags) {
        await updateCronMutation.mutateAsync(cronFlags)
      }

      setDirty(false)
      setSaveMessage('Settings saved')
    } catch (err) {
      setSaveMessage(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  // Handle click outside to close
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  if (!formData) {
    return (
      <Overlay onClick={handleOverlayClick}>
        <Panel>
          <PanelHeader>
            <PanelTitle>Settings</PanelTitle>
            <CloseButton onClick={onClose}>x</CloseButton>
          </PanelHeader>
          <TabContent>
            <StatusText>Loading...</StatusText>
          </TabContent>
        </Panel>
      </Overlay>
    )
  }

  const updateStatus = updateStatusQuery.data

  return (
    <Overlay onClick={handleOverlayClick}>
      <Panel>
        <PanelHeader>
          <PanelTitle>Settings</PanelTitle>
          <CloseButton onClick={onClose}>x</CloseButton>
        </PanelHeader>

        <TabBar>
          {([
            ['azure', 'Azure DevOps'],
            ['cron', 'Cron Jobs'],
            ['profiles', 'Profiles'],
            ['notifications', 'Notifications'],
            ['terminal', 'Terminal'],
            ['about', 'About'],
          ] as [TabId, string][]).map(([id, label]) => (
            <Tab
              key={id}
              $active={activeTab === id}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </Tab>
          ))}
        </TabBar>

        <TabContent>
          {/* ─── Azure DevOps Tab ─── */}
          {activeTab === 'azure' && (
            <Section>
              <SectionTitle>Azure DevOps Connection</SectionTitle>
              <FieldGroup>
                <Field>
                  <FieldLabel>Organization</FieldLabel>
                  <Input
                    value={formData.azure.org}
                    onChange={(e) => updateField('azure', 'org', e.target.value)}
                    placeholder="e.g. mgalfadev"
                  />
                </Field>
                <Field>
                  <FieldLabel>Project</FieldLabel>
                  <Input
                    value={formData.azure.project}
                    onChange={(e) => updateField('azure', 'project', e.target.value)}
                    placeholder="e.g. Rainier"
                  />
                </Field>
                <Field>
                  <FieldLabel>Team</FieldLabel>
                  <Input
                    value={formData.azure.team}
                    onChange={(e) => updateField('azure', 'team', e.target.value)}
                    placeholder="e.g. UI Champions League Team"
                  />
                </Field>
                <Field>
                  <FieldLabel>Personal Access Token (PAT)</FieldLabel>
                  <Input
                    type="password"
                    value={formData.azure.pat}
                    onChange={(e) => updateField('azure', 'pat', e.target.value)}
                    placeholder="Paste PAT here"
                  />
                </Field>
              </FieldGroup>
            </Section>
          )}

          {/* ─── Cron Jobs Tab ─── */}
          {activeTab === 'cron' && (
            <>
              <Section>
                <SectionTitle>Cron Configuration</SectionTitle>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Interval (seconds)</FieldLabel>
                    <Input
                      type="number"
                      min={10}
                      max={3600}
                      value={formData.cron.intervalSeconds}
                      onChange={(e) =>
                        updateField('cron', 'intervalSeconds', parseInt(e.target.value) || 60)
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Idle threshold (seconds)</FieldLabel>
                    <Input
                      type="number"
                      min={60}
                      max={7200}
                      value={formData.cron.idleThresholdSeconds}
                      onChange={(e) =>
                        updateField('cron', 'idleThresholdSeconds', parseInt(e.target.value) || 900)
                      }
                    />
                  </Field>
                </FieldGroup>
              </Section>
              <Section>
                <SectionTitle>Cron Step Flags</SectionTitle>
                <FieldGroup>
                  {cronFlags && ([
                    ['syncEnabled', 'Azure DevOps Sync'],
                    ['taskExecutionEnabled', 'Task Execution (worktree setup + copilot)'],
                    ['prCheckEnabled', 'PR Check'],
                  ] as const).map(([key, label]) => (
                    <FieldRow key={key}>
                      <Toggle
                        type="checkbox"
                        checked={cronFlags[key]}
                        onChange={(e) => {
                          setCronFlags({ ...cronFlags, [key]: e.target.checked })
                          setDirty(true)
                          setSaveMessage(null)
                        }}
                      />
                      <ToggleLabel>{label}</ToggleLabel>
                    </FieldRow>
                  ))}
                </FieldGroup>
              </Section>
            </>
          )}

          {/* ─── Profiles Tab ─── */}
          {activeTab === 'profiles' && (
            <Section>
              <SectionTitle>Repository Profiles</SectionTitle>
              {Object.entries(formData.profiles).map(([key, profile]) => (
                <ProfileCard key={key}>
                  <ProfileHeader>
                    <ProfileName>{key}</ProfileName>
                    <RemoveButton
                      onClick={() => {
                        const next = { ...formData.profiles }
                        delete next[key]
                        setFormData({ ...formData, profiles: next })
                        setDirty(true)
                        setSaveMessage(null)
                      }}
                    >
                      Remove
                    </RemoveButton>
                  </ProfileHeader>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Repository Path</FieldLabel>
                      <SmallInput
                        value={profile.repoPath}
                        onChange={(e) => {
                          const next = {
                            ...formData.profiles,
                            [key]: { ...profile, repoPath: e.target.value },
                          }
                          setFormData({ ...formData, profiles: next })
                          setDirty(true)
                          setSaveMessage(null)
                        }}
                        placeholder="C:\path\to\repo"
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Default Branch</FieldLabel>
                      <SmallInput
                        value={profile.defaultBranch}
                        onChange={(e) => {
                          const next = {
                            ...formData.profiles,
                            [key]: { ...profile, defaultBranch: e.target.value },
                          }
                          setFormData({ ...formData, profiles: next })
                          setDirty(true)
                          setSaveMessage(null)
                        }}
                        placeholder="main"
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Description (optional)</FieldLabel>
                      <SmallInput
                        value={profile.description || ''}
                        onChange={(e) => {
                          const next = {
                            ...formData.profiles,
                            [key]: { ...profile, description: e.target.value || undefined },
                          }
                          setFormData({ ...formData, profiles: next })
                          setDirty(true)
                          setSaveMessage(null)
                        }}
                        placeholder="Frontend app, backend service, etc."
                      />
                    </Field>
                  </FieldGroup>
                </ProfileCard>
              ))}

              {/* Add new profile */}
              <ProfileCard>
                <FieldGroup>
                  <FieldRow>
                    <SmallInput
                      value={newProfileKey}
                      onChange={(e) => setNewProfileKey(e.target.value)}
                      placeholder="New profile key (e.g. web-app)"
                      style={{ flex: 1 }}
                    />
                    <Button
                      disabled={!newProfileKey.trim() || newProfileKey in formData.profiles}
                      onClick={() => {
                        const key = newProfileKey.trim()
                        if (!key || key in formData.profiles) return
                        setFormData({
                          ...formData,
                          profiles: {
                            ...formData.profiles,
                            [key]: { repoPath: '', defaultBranch: 'main' },
                          },
                        })
                        setNewProfileKey('')
                        setDirty(true)
                        setSaveMessage(null)
                      }}
                    >
                      Add
                    </Button>
                  </FieldRow>
                </FieldGroup>
              </ProfileCard>
            </Section>
          )}

          {/* ─── Notifications Tab ─── */}
          {activeTab === 'notifications' && (
            <Section>
              <SectionTitle>Notification Preferences</SectionTitle>
              <FieldGroup>
                <FieldRow>
                  <Toggle
                    type="checkbox"
                    checked={formData.notifications.enabled}
                    onChange={(e) => updateField('notifications', 'enabled', e.target.checked)}
                  />
                  <ToggleLabel>Enable notifications</ToggleLabel>
                </FieldRow>
                <FieldRow>
                  <Toggle
                    type="checkbox"
                    checked={formData.notifications.taskCompleted}
                    disabled={!formData.notifications.enabled}
                    onChange={(e) => updateField('notifications', 'taskCompleted', e.target.checked)}
                  />
                  <ToggleLabel>Task completed</ToggleLabel>
                </FieldRow>
                <FieldRow>
                  <Toggle
                    type="checkbox"
                    checked={formData.notifications.prReviewNeeded}
                    disabled={!formData.notifications.enabled}
                    onChange={(e) => updateField('notifications', 'prReviewNeeded', e.target.checked)}
                  />
                  <ToggleLabel>PR review needed</ToggleLabel>
                </FieldRow>
                <FieldRow>
                  <Toggle
                    type="checkbox"
                    checked={formData.notifications.cronErrors}
                    disabled={!formData.notifications.enabled}
                    onChange={(e) => updateField('notifications', 'cronErrors', e.target.checked)}
                  />
                  <ToggleLabel>Cron errors</ToggleLabel>
                </FieldRow>
              </FieldGroup>
            </Section>
          )}

          {/* ─── Terminal Tab ─── */}
          {activeTab === 'terminal' && (
            <Section>
              <SectionTitle>Terminal Configuration</SectionTitle>
              <FieldGroup>
                <Field>
                  <FieldLabel>Shell</FieldLabel>
                  <Select
                    value={formData.terminal.shell}
                    onChange={(e) =>
                      updateField('terminal', 'shell', e.target.value as 'pwsh' | 'powershell' | 'cmd')
                    }
                  >
                    <option value="pwsh">pwsh (PowerShell 7)</option>
                    <option value="powershell">powershell (Windows PowerShell 5.1)</option>
                    <option value="cmd">cmd (Command Prompt)</option>
                  </Select>
                </Field>
                <StatusText>
                  Used when opening Copilot sessions in Windows Terminal.
                  Choose the shell that matches your default terminal profile.
                </StatusText>
              </FieldGroup>
            </Section>
          )}

          {/* ─── About Tab ─── */}
          {activeTab === 'about' && (
            <>
              <Section>
                <SectionTitle>HITL Orchestrator</SectionTitle>
                <FieldGroup>
                  <StatusText>
                    Human-in-the-Loop Agentic Development Orchestrator
                  </StatusText>
                  <StatusText>Version: 0.1.0</StatusText>
                </FieldGroup>
              </Section>
              <Section>
                <SectionTitle>Auto-Update</SectionTitle>
                <FieldGroup>
                  {updateStatus ? (
                    <>
                      <StatusText>
                        Status:{' '}
                        {updateStatus.checking
                          ? 'Checking...'
                          : updateStatus.downloaded
                            ? `v${updateStatus.version} ready to install`
                            : updateStatus.available
                              ? `v${updateStatus.version} downloading...`
                              : 'Up to date'}
                      </StatusText>
                      {updateStatus.error && (
                        <StatusText $color="#f38ba8">
                          Error: {updateStatus.error}
                        </StatusText>
                      )}
                      <FieldRow>
                        <Button
                          onClick={() => checkUpdatesMutation.mutate()}
                          disabled={updateStatus.checking}
                        >
                          Check for Updates
                        </Button>
                        {updateStatus.downloaded && (
                          <Button
                            $primary
                            onClick={() => installUpdateMutation.mutate()}
                          >
                            Install & Restart
                          </Button>
                        )}
                      </FieldRow>
                    </>
                  ) : (
                    <StatusText>
                      Auto-update is only available in packaged builds.
                    </StatusText>
                  )}
                </FieldGroup>
              </Section>
            </>
          )}
        </TabContent>

        <Footer>
          {saveMessage && (
            <StatusText
              $color={saveMessage.startsWith('Error') ? '#f38ba8' : '#a6e3a1'}
            >
              {saveMessage}
            </StatusText>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            $primary
            disabled={!dirty || saving}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </Footer>
      </Panel>
    </Overlay>
  )
}
