// Advanced stream settings sheet: FPS, bitrate, audio, and performance controls.
//
// Parsec-class performance settings exposed: frame rate up to 240 Hz (when the
// host display and hardware support it), bitrate ceiling for ABR control, and
// audio on/off. These settings require the WebRTC hardware path (BELAY_WEBRTC);
// the JPEG fallback remains capped at 30 fps for CPU safety.

import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, Row, Rule, Sheet, Txt } from '../ui';
import { SegmentedControl } from '../ui/controls';

export interface StreamSettings {
  readonly fps: number;
  readonly bitrateMbps: number;
  readonly audioEnabled: boolean;
  readonly codec: 'h264' | 'hevc';
}

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
  { value: 144, label: '144' },
  { value: 165, label: '165' },
  { value: 240, label: '240' },
];

const BITRATE_OPTIONS = [
  { value: 5, label: '5' },
  { value: 10, label: '10' },
  { value: 15, label: '15' },
  { value: 20, label: '20' },
  { value: 30, label: '30' },
  { value: 50, label: '50' },
];

const CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'HEVC' },
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

  const handleApply = useCallback(() => {
    onApply({ fps, bitrateMbps, audioEnabled, codec });
    onClose();
  }, [fps, bitrateMbps, audioEnabled, codec, onApply, onClose]);

  const handleReset = useCallback(() => {
    setFps(60);
    setBitrateMbps(20);
    setAudioEnabled(true);
    setCodec('h264');
  }, []);

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
              High-performance features require WebRTC hardware encoding (BELAY_WEBRTC=1 on host).
            </Txt>
          </View>
        )}

        <View style={{ gap: theme.space.sm }}>
          <Txt variant="subheading">Frame Rate</Txt>
          <Caption>
            {webrtcAvailable
              ? 'Target FPS. Host will match display refresh up to this ceiling. 60 Hz suits most displays; 120+ for high-refresh gaming.'
              : 'JPEG path limited to 30 fps. Enable WebRTC for high refresh rates.'}
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
            Maximum Mbps for adaptive bitrate control. Higher = sharper on fast links. Host adapts down under loss.
          </Caption>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
            {BITRATE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                testID={`bitrate-${option.value}`}
                label={`${option.label} Mbps`}
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
            H.264 for maximum compatibility; HEVC for better compression on text/UI (Apple silicon only).
          </Caption>
          <SegmentedControl
            testID="codec-control"
            options={CODEC_OPTIONS}
            value={codec}
            onChange={(value) => setCodec(value as 'h264' | 'hevc')}
            disabled={!webrtcAvailable}
          />
        </View>

        <Rule />

        <View style={{ gap: theme.space.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Txt variant="subheading">System Audio</Txt>
              <Caption>
                Hear the host's audio output on this device. Requires WebRTC (no third-party drivers).
              </Caption>
            </View>
            <Button
              testID="audio-toggle"
              label={audioEnabled ? 'On' : 'Off'}
              variant={audioEnabled ? 'primary' : 'secondary'}
              onPress={() => setAudioEnabled(!audioEnabled)}
              disabled={!webrtcAvailable}
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
