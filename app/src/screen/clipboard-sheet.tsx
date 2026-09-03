// The clipboard sheet — the whole UI of two-way clipboard sync.
//
// Two actions, symmetric: PULL reads the computer's clipboard and copies it
// onto this phone; SEND pushes whatever is on this phone's clipboard onto the
// computer. Every outcome lands as one line under the buttons (a §11.4 status
// line, not a toast that vanishes before it is read), and a pull also shows a
// one-line preview so the user can see what actually arrived.
//
// All the words and size checks live in clipboard-model.ts, which is pure and
// tested; this file is only wiring and layout.

import React, { useCallback, useState } from 'react';
import { api } from '../api';
import { copyText, pasteText } from '../files/clipboard';
import { useTheme } from '../theme';
import { Button, Column, Micro, Row, Sheet, Txt } from '../ui';
import type { TextTone } from '../ui';
import {
  checkPush,
  failureNotice,
  previewOf,
  pulledNotice,
  pushedNotice,
} from './clipboard-model';
import type { ClipboardNotice } from './clipboard-model';

export interface ClipboardSheetProps {
  visible: boolean;
  onClose: () => void;
}

/** The model speaks in outcome tones; the theme speaks in ink names. */
const NOTICE_TONE: Record<ClipboardNotice['tone'], TextTone> = {
  ok: 'good',
  bad: 'bad',
  dim: 'dim',
};

export function ClipboardSheet({ visible, onClose }: ClipboardSheetProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null);
  const [notice, setNotice] = useState<ClipboardNotice | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const pull = useCallback(async () => {
    setBusy('pull');
    setNotice(null);
    setPreview(null);
    try {
      const readout = await api.clipboardGet();
      const copied = readout.text.length > 0 ? await copyText(readout.text) : false;
      setNotice(pulledNotice(readout.text, readout.truncated === true, copied));
      if (readout.text.length > 0) setPreview(previewOf(readout.text));
    } catch (e) {
      setNotice(failureNotice(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const push = useCallback(async () => {
    setBusy('push');
    setNotice(null);
    setPreview(null);
    try {
      const check = checkPush(await pasteText());
      if (!check.ok) {
        setNotice(check.notice);
        return;
      }
      await api.clipboardSet(check.text);
      setNotice(pushedNotice(check.text.length));
      setPreview(previewOf(check.text));
    } catch (e) {
      setNotice(failureNotice(e));
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <Sheet visible={visible} onClose={onClose} title="Clipboard" testID="clipboard-sheet">
      <Column gap="sm">
        <Micro>Move text between this phone’s clipboard and the computer’s.</Micro>
        <Row gap="sm">
          <Button
            testID="clipboard-pull"
            label={busy === 'pull' ? 'Pulling…' : 'Pull from PC'}
            accessibilityLabel="Copy the computer's clipboard onto this phone"
            onPress={() => void pull()}
            disabled={busy !== null}
            style={{ flex: 1 }}
          />
          <Button
            testID="clipboard-push"
            label={busy === 'push' ? 'Sending…' : 'Send to PC'}
            accessibilityLabel="Put this phone's clipboard onto the computer"
            variant="secondary"
            onPress={() => void push()}
            disabled={busy !== null}
            style={{ flex: 1 }}
          />
        </Row>
        {notice ? (
          <Txt testID="clipboard-notice" variant="label" tone={NOTICE_TONE[notice.tone]}>
            {notice.text}
          </Txt>
        ) : null}
        {preview ? (
          <Micro testID="clipboard-preview" numberOfLines={2} style={{ marginTop: theme.space.xxs }}>
            {preview}
          </Micro>
        ) : null}
      </Column>
    </Sheet>
  );
}
