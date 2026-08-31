// The Files tab's toolbar: back/forward/up arrows, the breadcrumb trail, and
// the copy-path control — Finder's toolbar and path bar folded into one row,
// because two rows of chrome on a phone would eat the list they serve.
//
// The crumbs scroll horizontally and pin to the end on change, so the folder
// you are IN is always visible and it is the distant ancestors that get cut
// off — the same trade-off Finder's path bar makes when the window is narrow.
// The trail is machine voice: mono, ink for where you are, dim for the way
// back — never bold, colour is the only hierarchy (docs/DESIGN.md §12).

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { useTheme } from '../theme';
import { Caption, IconButton, Row, TrackLabel, Txt } from '../ui';
import type { Crumb } from '../files-format';
import { copyText } from './clipboard';

/** How long the copy control shows its "done" tick before reverting. */
const COPIED_FLASH_MS = 1600;

interface ArrowProps {
  glyph: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}

function Arrow({ glyph, label, disabled, onPress, testID }: ArrowProps) {
  const theme = useTheme();
  return (
    <IconButton testID={testID} accessibilityLabel={label} disabled={disabled} onPress={onPress} variant="plain">
      <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 16, fontFamily: theme.font.mono }}>
        {glyph}
      </Text>
    </IconButton>
  );
}

export interface PathBarProps {
  path: string;
  crumbs: readonly Crumb[];
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigate: (path: string) => void;
}

export function PathBar({
  path,
  crumbs,
  canBack,
  canForward,
  canUp,
  onBack,
  onForward,
  onUp,
  onNavigate,
}: PathBarProps) {
  const theme = useTheme();
  const scroll = useRef<ScrollView>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // The flash must not outlive the component — a timer firing into an
  // unmounted setState is exactly the warning React nags about.
  useEffect(() => {
    if (!copied && !copyFailed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, COPIED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [copied, copyFailed]);

  const copyPath = async () => {
    const ok = await copyText(path);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  return (
    <Row gap="xs" style={{ paddingHorizontal: theme.space.sm, paddingVertical: theme.space.xxs }}>
      <Arrow testID="files-back" glyph="‹" label="Go back" disabled={!canBack} onPress={onBack} />
      <Arrow testID="files-forward" glyph="›" label="Go forward" disabled={!canForward} onPress={onForward} />
      <Arrow testID="files-up" glyph="↑" label="Go to the parent folder" disabled={!canUp} onPress={onUp} />
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        contentContainerStyle={{ alignItems: 'center', gap: 2, paddingRight: theme.space.sm }}
        style={{ flex: 1 }}
      >
        {crumbs.length === 0 ? <Caption>—</Caption> : null}
        {crumbs.map((crumb, index) => (
          <Row key={crumb.path} gap="none">
            {index > 0 ? (
              <Text allowFontScaling={false} style={{ color: theme.colors.textFaint, fontSize: 13, fontFamily: theme.font.mono }}>
                /
              </Text>
            ) : null}
            <Pressable
              testID={`crumb-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${crumb.label}`}
              onPress={() => onNavigate(crumb.path)}
              hitSlop={theme.layout.hitSlop}
              style={({ pressed }) => ({
                paddingHorizontal: theme.space.xxs + 2,
                paddingVertical: theme.space.xs,
                opacity: pressed ? theme.motion.pressOpacity : 1,
              })}
            >
              <Txt
                variant="monoSmall"
                tone={index === crumbs.length - 1 ? 'default' : 'dim'}
              >
                {crumb.label}
              </Txt>
            </Pressable>
          </Row>
        ))}
      </ScrollView>
      {/* A verb amid mono breadcrumbs and inert markers: only its resting
          track says it can be tapped (docs/DESIGN.md §11.1). During the ✓/✗
          flash the track takes the status colour with the label, so the
          feedback lands in the same mark that announced the control. */}
      <TrackLabel
        testID="files-copy-path"
        label={copied ? '✓ Copied' : copyFailed ? '✗ Failed' : 'Copy'}
        accessibilityLabel={copied ? 'Path copied' : 'Copy this folder path'}
        disabled={!path}
        onPress={() => void copyPath()}
        hitSlop={theme.layout.hitSlop}
        labelColor={copied ? theme.colors.good : copyFailed ? theme.colors.bad : undefined}
        trackColor={copied ? theme.colors.good : copyFailed ? theme.colors.bad : undefined}
      />
    </Row>
  );
}
