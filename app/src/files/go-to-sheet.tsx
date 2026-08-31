// "Go to Folder" — Finder's ⇧⌘G as a bottom sheet. Type or paste an absolute
// path and jump straight there, without tapping through six levels of crumbs.
//
// Validation happens in two stages on purpose. The phone-side check (paths.ts)
// answers instantly and names the fix — missing slash, outside the roots —
// while the host stays the authority on whether the folder actually exists and
// is readable, so its refusal is shown verbatim rather than second-guessed.

import React, { useCallback, useState } from 'react';
import { useTheme } from '../theme';
import { Button, Caption, Input, Row, Sheet, haptic } from '../ui';
import { messageOf } from '../files-format';
import { parseGoTo } from './paths';
import type { RootLike } from './paths';
import { pasteText } from './clipboard';

export interface GoToSheetProps {
  visible: boolean;
  roots: readonly RootLike[];
  onClose: () => void;
  /** Navigates and resolves on success; a rejection keeps the sheet open. */
  onNavigate: (path: string) => Promise<void>;
}

export function GoToSheet({ visible, roots, onClose, onNavigate }: GoToSheetProps) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const verdict = parseGoTo(value, roots);
    if (!verdict.ok) {
      setError(verdict.reason);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onNavigate(verdict.path);
      setValue('');
      onClose();
    } catch (e: unknown) {
      // "path does not exist" / "outside the allowed roots" straight from the
      // host — it knows the disk, the phone only knows the root list.
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [onClose, onNavigate, roots, value]);

  const paste = useCallback(async () => {
    const text = await pasteText();
    if (text === null) {
      setError('Nothing readable on the clipboard. Paste into the field instead.');
      return;
    }
    haptic('light');
    setError('');
    setValue(text);
  }, []);

  return (
    <Sheet visible={visible} onClose={onClose} title="Go to folder" testID="files-goto-sheet">
      <Input
        testID="files-goto-input"
        value={value}
        onChangeText={(next) => {
          setValue(next);
          if (error) setError('');
        }}
        placeholder="/Users/you/Documents"
        accessibilityLabel="Folder path"
        error={error || undefined}
        helper={roots.length > 0 ? `Allowed: ${roots.map((r) => r.name).join(', ')}` : undefined}
        mono
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Row gap="sm" style={{ marginTop: theme.space.sm }}>
        <Button testID="files-goto-paste" label="Paste" variant="secondary" onPress={paste} style={{ flex: 1 }} />
        <Button
          testID="files-goto-go"
          label="Go"
          onPress={submit}
          loading={busy}
          disabled={value.trim().length === 0}
          style={{ flex: 2 }}
        />
      </Row>
      <Caption style={{ marginTop: theme.space.sm }}>
        Tip: ~ stands for the computer's home folder.
      </Caption>
    </Sheet>
  );
}
