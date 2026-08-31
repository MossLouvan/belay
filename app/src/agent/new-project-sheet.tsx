// The "New project" sheet: name the project, pick where it lives, see the
// exact path before it exists. Lives in its own file so the picker screen
// stays readable; all decisions (validation, suggestions, preview, error
// wording) are in `new-project.ts` where the tests can reach them.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { api } from '../api';
import type { AgentProject } from '../api';
import { useTheme } from '../theme';
import { Banner, Button, Caption, Column, Input, ListItem, Sheet, Txt, haptic } from '../ui';
import { mapCreateError, previewPath, suggestParents, validateProjectName } from './new-project';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

export function NewProjectSheet({
  visible,
  projects,
  onClose,
  onCreated,
}: {
  visible: boolean;
  /** The picker's already-loaded list, mined for parent-folder suggestions. */
  projects: readonly AgentProject[];
  onClose: () => void;
  onCreated: (project: AgentProject) => void;
}) {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [customParent, setCustomParent] = useState('');
  const [typingParent, setTypingParent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const live = useRef(true);

  React.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const suggestions = useMemo(() => suggestParents(projects), [projects]);
  const chosenParent = typingParent ? customParent.trim() : (parent ?? suggestions[0]);
  const check = validateProjectName(name);
  // The rule only appears once there is something to judge — flashing "type a
  // name" at an empty field the user just opened is nagging, not validation.
  const nameError = name.trim() && !check.ok ? check.reason : undefined;
  const ready = check.ok && Boolean(chosenParent) && !busy;

  const create = useCallback(async () => {
    if (!check.ok || !chosenParent || busy) return;
    setBusy(true);
    setServerError('');
    try {
      const { project } = await api.agentCreateProject(check.name, chosenParent);
      if (!live.current) return;
      haptic('success');
      onCreated(project);
    } catch (e: unknown) {
      if (live.current) {
        haptic('error');
        setServerError(mapCreateError(messageOf(e, 'could not create the folder')));
        setBusy(false);
      }
    }
  }, [check, chosenParent, busy, onCreated]);

  return (
    <Sheet visible={visible} onClose={onClose} title="New project" testID="agent-new-project">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: theme.space.sm }}>
        {serverError ? <Banner testID="agent-new-project-error" status="bad" message={serverError} /> : null}

        <Input
          testID="agent-new-project-name"
          label="Name"
          value={name}
          onChangeText={(next) => {
            setName(next);
            // A stale server complaint ("already exists") under a name the
            // user is actively fixing reads as the fix not working.
            if (serverError) setServerError('');
          }}
          placeholder="my-project"
          error={nameError}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void create()}
          accessibilityLabel="New project name"
        />

        <Column gap="xs">
          <Txt variant="caption" tone="dim" style={{ fontWeight: '700' }}>Create inside</Txt>
          {suggestions.map((s) => (
            <ListItem
              key={s}
              testID={`agent-new-project-parent-${s}`}
              title={s === '~' ? 'Home folder (~)' : s}
              mono={s !== '~'}
              selected={!typingParent && chosenParent === s}
              onPress={() => {
                setTypingParent(false);
                setParent(s);
              }}
            />
          ))}
          {typingParent ? (
            <Input
              testID="agent-new-project-custom-parent"
              value={customParent}
              onChangeText={setCustomParent}
              placeholder={'C:\\Users\\you\\code or ~/code'}
              mono
              autoFocus
              accessibilityLabel="Custom parent folder path"
            />
          ) : (
            <ListItem
              testID="agent-new-project-other"
              title="Somewhere else…"
              onPress={() => setTypingParent(true)}
            />
          )}
        </Column>

        {check.ok && chosenParent ? (
          <Caption testID="agent-new-project-preview">
            Will create{'  '}
            <Txt variant="monoSmall" tone="dim">{previewPath(chosenParent, check.name)}</Txt>
          </Caption>
        ) : (
          <Caption>The full path appears here before anything is created.</Caption>
        )}

        <Button
          testID="agent-new-project-create"
          label="Create project"
          onPress={() => void create()}
          loading={busy}
          disabled={!ready}
        />
      </ScrollView>
    </Sheet>
  );
}
