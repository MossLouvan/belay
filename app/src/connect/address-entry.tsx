// The address field — the front door of the app.
//
// The owner's own habit is the design: open Tailscale, copy the computer's
// 100.x address, paste it here, tap Connect. So the field is the hero of the
// screen (the one `lg` input in the app), the keyboard opens on numbers and
// punctuation, the example under it is the shape to copy, and the live line
// beneath says at once whether what is typed looks right. The QR scanner is
// still here — as one quiet tracked label, not a rival button — and a
// computer the app has already found on the tailnet is offered above the
// field as a one-tap shortcut, never in place of it.
//
// One component for both places an address is entered: the connect screen
// and the "add a computer" path from the computer list.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme';
import { Button, IconButton, Input, Label, Row, Rule, TrackLabel, Txt, haptic } from '../ui';
import {
  EXAMPLE_TAILSCALE_ADDRESS,
  TAILSCALE_PREFIX,
  addressFeedback,
  normalizePastedAddress,
} from './address-input';
import type { FeedbackTone } from './address-input';
import { TailscaleIpExample } from './tailscale-ip-example';

/** A computer already answering over the tailnet — connect without typing. */
export interface DiscoveredShortcut {
  readonly name: string;
  readonly url: string;
  readonly onConnect: () => void;
}

export interface AddressEntryProps {
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /** Focus the field the moment the screen shows — the first-run default. */
  autoFocus?: boolean;
  /** Offered above the field when the app already knows a reachable computer. */
  discovered?: DiscoveredShortcut | null;
  /** Opens the QR scanner — the quieter second way in. */
  onScan?: () => void;
  testID?: string;
}

/** The tone words the feedback module speaks, as Txt tones. */
const FEEDBACK_TONE: Readonly<Record<FeedbackTone, 'good' | 'dim' | 'warn' | 'bad'>> = {
  good: 'good',
  dim: 'dim',
  warn: 'warn',
  bad: 'bad',
};

function DiscoveredRow({ shortcut }: { shortcut: DiscoveredShortcut }) {
  const theme = useTheme();
  const address = shortcut.url.replace(/^https?:\/\//, '').replace(/:8787$/, '');
  return (
    <View testID="discovered-shortcut">
      <Row justify="space-between" gap="sm">
        <View style={{ flex: 1, gap: theme.space.xxs }}>
          <Txt variant="label" tone="good" numberOfLines={1}>
            {`● Found ${shortcut.name} on your tailnet`}
          </Txt>
          <Txt variant="mono" tone="dim" numberOfLines={1}>{address}</Txt>
        </View>
        <TrackLabel
          label="Connect"
          active
          onPress={shortcut.onConnect}
          accessibilityLabel={`Connect to ${shortcut.name}`}
          testID="discovered-connect"
        />
      </Row>
      <Rule bleed={theme.layout.margin} style={{ marginTop: theme.space.sm }} />
    </View>
  );
}

/**
 * The live line under the field. Nothing typed yet shows the example, and
 * tapping it starts the address with the `100.` every Tailscale address
 * shares — the shape is taught by the field itself.
 */
function FeedbackLine({
  value,
  onStartWithPrefix,
}: {
  value: string;
  onStartWithPrefix: () => void;
}) {
  const feedback = addressFeedback(value);
  if (!feedback) {
    return (
      <TrackLabel
        label={`e.g. ${EXAMPLE_TAILSCALE_ADDRESS}`}
        onPress={onStartWithPrefix}
        accessibilityLabel={`Example address ${EXAMPLE_TAILSCALE_ADDRESS}`}
        accessibilityHint={`Starts the address with ${TAILSCALE_PREFIX}`}
        testID="address-example"
        style={{ alignSelf: 'flex-start' }}
      />
    );
  }
  return (
    <View accessibilityLiveRegion="polite">
      <Txt variant="label" tone={FEEDBACK_TONE[feedback.tone]} testID="address-feedback">
        {feedback.text}
      </Txt>
    </View>
  );
}

export function AddressEntry({
  value,
  onChangeText,
  onSubmit,
  busy,
  autoFocus,
  discovered,
  onScan,
  testID = 'address-entry',
}: AddressEntryProps) {
  const theme = useTheme();
  const [showWhere, setShowWhere] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  /** Any edit clears a stale paste failure — the slot is the feedback line. */
  const onType = useCallback(
    (next: string) => {
      setPasteError(null);
      onChangeText(next);
    },
    [onChangeText]
  );

  const startWithPrefix = useCallback(() => {
    haptic('light');
    onType(TAILSCALE_PREFIX);
  }, [onType]);

  /**
   * Paste, the way the owner actually gets here: copy in Tailscale, tap this.
   *
   * It used to `await import('expo-clipboard')` and destructure a `default`
   * export off it. That module has none — it is a namespace of named exports —
   * so `Clipboard` was `undefined`, every tap threw
   * `undefined.getStringAsync` into an empty catch, and the button did
   * nothing at all, silently, on every platform. The namespace import here is
   * the same shape src/files/clipboard.ts has always used and which works.
   *
   * Whatever comes back is then normalised (a full URL, a trailing newline, a
   * quoted line, a `:8787` already on it), and a genuine failure — an empty
   * clipboard, a denied browser or iOS paste prompt — says so in the field's
   * own feedback slot instead of vanishing.
   */
  const handlePaste = useCallback(async () => {
    setPasteError(null);
    try {
      const text = await Clipboard.getStringAsync();
      const next = normalizePastedAddress(text ?? '');
      if (!next) {
        setPasteError('Nothing to paste — copy the address in Tailscale first.');
        return;
      }
      haptic('light');
      onChangeText(next);
    } catch {
      // The clipboard module is missing from this build, or the OS refused
      // the read. Either way the field's own long-press paste still works,
      // and saying so beats a button that looks broken.
      setPasteError('Could not read the clipboard. Long-press the field and choose Paste.');
    }
  }, [onChangeText]);

  return (
    <View testID={testID} style={{ gap: theme.space.lg }}>
      {discovered ? <DiscoveredRow shortcut={discovered} /> : null}

      <View style={{ gap: theme.space.xs }}>
        <Txt variant="subheading">Type the address from your Tailscale app</Txt>
        <Txt variant="caption" tone="dim">
          Open Tailscale, find your computer, and copy the address that starts with 100.
        </Txt>
      </View>

      <View style={{ gap: theme.space.sm }}>
        <Input
          testID="host-input"
          label="Computer address"
          size="lg"
          value={value}
          onChangeText={onType}
          placeholder={EXAMPLE_TAILSCALE_ADDRESS}
          mono
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect={false}
          // Digits, dots and colons on the first page; letters one tap away
          // for the rare MagicDNS name. `decimal-pad` has no dot on some
          // locales and no colon anywhere, so it cannot take a port.
          keyboardType="numbers-and-punctuation"
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          editable={!busy}
          accessibilityLabel="Computer address"
          accessibilityHint="The 100.x address from the Tailscale app. Port 8787 is added for you."
          trailing={
            <IconButton
              testID="paste-address"
              accessibilityLabel="Paste address from clipboard"
              variant="plain"
              onPress={() => void handlePaste()}
            >
              <Txt variant="label" tone="dim">Paste</Txt>
            </IconButton>
          }
        />
        {pasteError ? (
          <View accessibilityLiveRegion="polite">
            <Txt variant="label" tone="bad" testID="paste-error">{pasteError}</Txt>
          </View>
        ) : (
          <FeedbackLine value={value} onStartWithPrefix={startWithPrefix} />
        )}
      </View>

      <Button
        label="Connect"
        onPress={onSubmit}
        loading={busy}
        testID="check-host"
        fullWidth
        size="lg"
      />

      {/* The two side doors, as quiet tracked labels: where the address is,
          and the scanner for anyone standing at the computer. */}
      <Row justify="space-between" gap="md">
        <TrackLabel
          label="Where do I find it?"
          active={showWhere}
          onPress={() => setShowWhere((open) => !open)}
          accessibilityHint={showWhere ? 'Hides the example' : 'Shows where the address is in the Tailscale app'}
          testID="address-where"
        />
        {onScan ? (
          <TrackLabel
            label="Scan a code instead"
            onPress={onScan}
            accessibilityHint="Scans the QR code the host agent prints"
            testID="scan-btn"
          />
        ) : null}
      </Row>

      {showWhere ? (
        <View style={{ gap: theme.space.sm }}>
          <Label>In the Tailscale app</Label>
          <TailscaleIpExample />
        </View>
      ) : null}
    </View>
  );
}
