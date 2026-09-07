// Advanced stream settings sheet: FPS, bitrate, audio, and performance controls.
//
// Only controls that reach the active BWP/JPEG transport are offered.
// Closing discards the draft; reopening starts from the applied settings.

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, Row, Rule, Sheet, Txt } from '../ui';
import { SegmentedControl } from '../ui/controls';

import type { StreamSettings } from './performance';
export type { StreamSettings } from './performance';

interface StreamSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  settings: StreamSettings;
  onApply: (settings: StreamSettings) => void;
  webrtcAvailable: boolean;
}

const FPS_OPTIONS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 120, label: '120' },
];

const BITRATE_OPTIONS = [
  { value: 0, label: 'Auto' },
  { value: 1.5, label: '1.5' },
  { value: 4, label: '4' },
  { value: 10, label: '10' },
  { value: 20, label: '20' },
];

const CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },

];

export function StreamSettingsSheet({
  visible,
  onClose,
  settings,
  onApply,
  webrtcAvailable,
}: StreamSettingsSheetProps) {
  const theme = useTheme();
  const [fps, setFps] = useState(settings.fps);
  const [bitrateMbps, setBitrateMbps] = useState(settings.bitrateMbps);
  const [audioEnabled, setAudioEnabled] = useState(settings.audioEnabled);
  const [codec, setCodec] = useState(settings.codec);

  useEffect(() => {
    if (!visible) return;
    setFps(webrtcAvailable ? settings.fps : 30);
    setBitrateMbps(settings.bitrateMbps);
    setAudioEnabled(settings.audioEnabled);
    setCodec('h264');
  }, [visible, settings.fps, settings.bitrateMbps, settings.audioEnabled, webrtcAvailable]);

  const handleApply = useCallback(() => {
    onApply({ fps, bitrateMbps, audioEnabled, codec });
    onClose();
  }, [fps, bitrateMbps, audioEnabled, codec, onApply, onClose]);

  const handleReset = useCallback(() => {
    setFps(webrtcAvailable ? 60 : 30);
    setBitrateMbps(0); // Auto
    setAudioEnabled(true);
    setCodec('h264');
  }, [webrtcAvailable]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Stream Settings">
      <ScrollView
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.lg,
        }}
      >
        {!webrtcAvailable && (
          <View
            style={{
              padding: theme.space.md,
              backgroundColor: theme.colors.warnSoft,
              borderRadius: theme.radius.xs,
            }}
          >
            <Txt variant="body" tone="warn">
              This session uses JPEG, limited to 30 fps. H.264 requires a native client and a host with the video streamer installed.
            </Txt>
          </View>
        )}

        <View style={{ gap: theme.space.sm }}>
          <Txt variant="subheading">Frame Rate</Txt>
          <Caption>
            {webrtcAvailable
              ? 'Target FPS. Host will match display refresh up to this ceiling. 60 Hz suits most displays; 120+ for high-refresh gaming.'
              : 'JPEG path limited to 30 fps. Use the native H.264 client for higher frame rates.'}
          </Caption>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
            {FPS_OPTIONS.map((option) => (
              <Button
                key={option.value}
                testID={`fps-${option.value}`}
                label={`${option.label} Hz`}
                variant={fps === option.value ? 'primary' : 'secondary'}
                onPress={() => setFps(option.value)}
                disabled={!webrtcAvailable && option.value > 30}
                style={{ minWidth: 72 }}
              />
            ))}
          </View>
        </View>

        <Rule />

        <View style={{ gap: theme.space.sm }}>
          <Txt variant="subheading">Bitrate Ceiling</Txt>
          <Caption>
            Maximum video bandwidth. The H.264 stream adapts below this ceiling when the connection is congested. Auto allows up to 20 Mbps.
          </Caption>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
            {BITRATE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                testID={`bitrate-${option.value}`}
                label={option.value === 0 ? 'Auto' : `${option.label} Mbps`}
                variant={bitrateMbps === option.value ? 'primary' : 'secondary'}
                onPress={() => setBitrateMbps(option.value)}
                disabled={!webrtcAvailable}
                style={{ minWidth: 72 }}
              />
            ))}
          </View>
        </View>

        <Rule />

        <View style={{ gap: theme.space.sm }}>
          <Txt variant="subheading">Codec</Txt>
          <Caption>
            H.264 is the supported video codec.
          </Caption>
          <SegmentedControl
            testID="codec-control"
            options={CODEC_OPTIONS}
            value={codec}
            onChange={(value) => setCodec(value as 'h264')}
            disabled={!webrtcAvailable}
          />
        </View>

        <Rule />

        <View style={{ gap: theme.space.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Txt variant="subheading">System Audio</Txt>
              <Caption>
                Hear the host's audio output on this device.
              </Caption>
            </View>
            <Button
              testID="audio-toggle"
              label={audioEnabled ? 'On' : 'Off'}
              variant={audioEnabled ? 'primary' : 'secondary'}
              onPress={() => setAudioEnabled(!audioEnabled)}
              style={{ minWidth: 80 }}
            />
          </Row>
        </View>

        <View style={{ marginTop: theme.space.md, gap: theme.space.sm }}>
          <Button
            testID="apply-settings"
            label="Apply"
            variant="primary"
            onPress={handleApply}
            fullWidth
          />
          <Button
            testID="reset-settings"
            label="Reset to Defaults"
            variant="ghost"
            onPress={handleReset}
            fullWidth
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
