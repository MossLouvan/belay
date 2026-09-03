// A slim, always-honest status row: THE one status dot every tab header
// carries. A hollow ring while transitioning, a filled disc when steady
// (REVAMP-SPEC §3.5), one word from the closed vocabulary, and an optional
// dim detail — with room for a trailing affordance (the switch-computer
// link). One source of truth so no two tabs word the same state differently
// (docs/FRONTEND-REVAMP.md §4.1).

import React from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Dot } from './feedback';
import { Label } from './text';
import { Row } from './layout';
import { describeSurface } from './connection-view';
import type { ConnectionPhase, SurfacePhase } from './connection-view';

export interface ConnectionStatusProps {
  readonly phase: ConnectionPhase;
  /** The tab's own surface state, merged under the link (link-down wins). */
  readonly surface?: SurfacePhase;
  /** A short trailing fact ("42 fps"); shown dim, only while steady. */
  readonly detail?: string;
  /** `false` when no computer is paired at all — outranks every phase. */
  readonly paired?: boolean;
  /** @deprecated The machine is the switch link's fact now; ignored. */
  readonly machine?: string;
  /** A trailing affordance on the same line, e.g. the switch-computer link. */
  readonly trailing?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function ConnectionStatus({
  phase,
  surface,
  detail,
  paired,
  trailing,
  style,
  testID,
}: ConnectionStatusProps) {
  const view = describeSurface(phase, surface, { paired, detail });
  return (
    <Row justify="space-between" gap="sm" style={style} testID={testID}>
      <Row gap="xs" style={{ flexShrink: 1, minWidth: 0 }}>
        {/* The visible word already speaks the state; a label on the Dot
            would make a screen reader announce it twice. */}
        <Dot status={view.status} ring={view.ring} size={7} />
        {/* The state word is the load-bearing fact — never let it truncate. */}
        <Label style={{ marginBottom: 0, flexShrink: 0 }} numberOfLines={1}>{view.word}</Label>
        {view.detail ? (
          // Detail is the first thing to give way on a narrow row.
          <Label tone="faint" style={{ marginBottom: 0, flexShrink: 1, minWidth: 0 }} numberOfLines={1}>
            {view.detail}
          </Label>
        ) : null}
      </Row>
      {/* The machine link (a place, not a status) yields the row to the status
          and truncates its own name rather than pushing the word off screen. */}
      {trailing ? <View style={{ flexShrink: 1, minWidth: 0, maxWidth: '50%' }}>{trailing}</View> : null}
    </Row>
  );
}
