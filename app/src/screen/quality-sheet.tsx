// The Stream quality sheet: the encoding presets this host can honour, the
// live readout under them, and — only when the host advertises the virtual
// display driver — the true-resolution picker. Presentational.

import React from 'react';
import { Caption, Column, ListItem, Rule, SegmentedControl, Sheet, Txt } from '../ui';
import { nowLine, qualityDescription } from './hud';
import type { QualityPreset, ResolutionOption } from './model';
import type { HostFacts, StreamState } from './stream';
import type { StreamPresets } from './use-stream-presets';

export interface QualitySheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly presets: StreamPresets;
  readonly qualityChoices: readonly QualityPreset[];
  readonly stream: StreamState;
  readonly pingMs: HostFacts['pingMs'];
  readonly zoom: number;
}

export function QualitySheet({ visible, onClose, presets, qualityChoices, stream, pingMs, zoom }: QualitySheetProps) {
  const { qualityId, setQualityId, quality, resolutions, resolution, setResolutionId, vdAvailable } = presets;
  return (
    <Sheet visible={visible} onClose={onClose} title="Stream quality" testID="quality-sheet">
      <Column gap="sm">
        <SegmentedControl
          testID="quality-options"
          accessibilityLabel="Stream quality"
          value={qualityId}
          onChange={setQualityId}
          options={qualityChoices.map((preset) => ({ value: preset.id, label: preset.label }))}
        />
        <Caption>{quality.hint}</Caption>
        <Caption>{qualityDescription(quality, stream.bwpPath !== null)}</Caption>
        <Caption>
          {nowLine({
            stats: stream.stats,
            bwp: stream.bwpStats,
            bwpSize: null,
            bwpPath: stream.bwpPath,
            quality,
            pingMs,
            zoom,
          })}
        </Caption>

        {/* True-resolution picker — only when the host advertises the virtual
            display driver. On every other host the physical-downscale path
            above is the whole story, so the section simply does not appear. */}
        {vdAvailable ? (
          <ResolutionSection resolutions={resolutions} resolution={resolution} onSelect={setResolutionId} />
        ) : null}
      </Column>
    </Sheet>
  );
}

interface ResolutionSectionProps {
  readonly resolutions: readonly ResolutionOption[];
  readonly resolution: ResolutionOption;
  readonly onSelect: (id: string) => void;
}

function ResolutionSection({ resolutions, resolution, onSelect }: ResolutionSectionProps) {
  return (
    <Column gap="xxs" testID="resolution-section">
      <Rule />
      <Txt variant="bodyStrong">Host resolution</Txt>
      {resolutions.map((option) => (
        <ListItem
          key={option.id}
          testID={`resolution-${option.id}`}
          title={option.label}
          subtitle={option.hint}
          selected={option.id === resolution.id}
          onPress={() => onSelect(option.id)}
        />
      ))}
      <Caption>
        {resolution.size
          ? 'The host renders a virtual display at this size and streams it — aspect-matched, no letterbox. Removed when you disconnect or switch back.'
          : 'Mirroring the real monitor. Pick a size above to have the host render a display shaped to your phone.'}
      </Caption>
    </Column>
  );
}
