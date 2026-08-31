// Send phone photos into the open Claude session, from the composer row.
//
// The flow is deliberately the recording flow with the direction reversed:
// pick (or take) photos, they upload to the host, land inside this session's
// project folder, and a prompt referencing them — carrying whatever was
// already typed in the composer as the note — is queued on the session. The
// receipt is the feed itself: the prompt appears there the moment it lands,
// so no extra "it worked" chrome is needed.
//
// Uploads are staged one at a time (`/images/add`) and committed with one
// `/images/send`; on any failure the staged batch is discarded so a retry
// starts clean instead of doubling up.

import React, { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api, uploadImageBase64 } from '../api';
import { useTheme } from '../theme';
import { Column, Dot, ListItem, Sheet, haptic } from '../ui';
import { CAMERA_DENIED_MESSAGE, parseImagesSent, planUpload, uploadFailureMessage } from './photos';

export type PhotoSource = 'library' | 'camera';

export interface PhotoSend {
  readonly busy: boolean;
  /** The last failure was a camera permission denial — offer the Settings door. */
  readonly needsSettings: boolean;
  /** Pick photos from `source` and send them with `note`. Resolves true when they went. */
  readonly send: (source: PhotoSource, note: string) => Promise<boolean>;
}

/** The one route iOS offers out of a denied permission. */
export function openPhotoSettings(): void {
  void Linking.openSettings();
}

/** Compressed enough to move fast on cellular, sharp enough for UI text. */
const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.7,
  base64: true,
  exif: false,
};

export function usePhotoSend(
  sessionId: string,
  onError: (message: string) => void,
  onSent?: (files: number) => void,
): PhotoSend {
  const [busy, setBusy] = useState(false);
  const [needsSettings, setNeedsSettings] = useState(false);
  // A double-tap on the chooser must not start two overlapping batches.
  const inFlight = useRef(false);

  const send = useCallback(
    async (source: PhotoSource, note: string): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      try {
        // The library goes through the system picker (no permission needed);
        // only the camera has a grant to be denied, and once denied iOS only
        // re-asks via the Settings app.
        if (source === 'camera') {
          const grant = await ImagePicker.requestCameraPermissionsAsync();
          if (!grant.granted) {
            setNeedsSettings(true);
            onError(CAMERA_DENIED_MESSAGE);
            return false;
          }
        }
        setNeedsSettings(false);
        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
            : await ImagePicker.launchImageLibraryAsync({
                ...PICKER_OPTIONS,
                allowsMultipleSelection: true,
                selectionLimit: 4,
                orderedSelection: true,
              });
        if (result.canceled) return false;
        const plan = planUpload(result.assets);
        if (plan.problem) {
          onError(plan.problem);
          return false;
        }

        setBusy(true);
        try {
          // Clear any batch a failed earlier attempt left staged, so old
          // photos never ride along inside this send.
          await api.imagesDiscard();
          for (const b64 of plan.uploads) await uploadImageBase64(b64);
          const reply = parseImagesSent(await api.imagesSend(sessionId, note));
          haptic('success');
          onSent?.(reply.files);
          return true;
        } catch (e: unknown) {
          void api.imagesDiscard().catch(() => undefined);
          onError(uploadFailureMessage(e instanceof Error ? e.message : String(e)));
          return false;
        } finally {
          setBusy(false);
        }
      } catch (e: unknown) {
        onError(uploadFailureMessage(e instanceof Error ? e.message : String(e)));
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [sessionId, onError, onSent],
  );

  return { busy, needsSettings, send };
}

export interface PhotoButtonProps {
  onPick: (source: PhotoSource) => void;
  busy: boolean;
  disabled?: boolean;
  size?: number;
  testID?: string;
}

/**
 * The composer-row control: a square, labelled key beside the mic — a camera
 * is not one of the universal five glyphs allowed to stand bare (docs/
 * DESIGN.md §11.1), so the glyph carries its mono label. Tapping opens the
 * two-way chooser; the actual picking is the system's own UI.
 */
export function PhotoButton({ onPick, busy, disabled, size = 48, testID }: PhotoButtonProps) {
  const theme = useTheme();
  const [chooser, setChooser] = useState(false);
  const pick = useCallback(
    (source: PhotoSource) => {
      setChooser(false);
      onPick(source);
    },
    [onPick],
  );
  const ink = theme.colors.textDim;
  const glyph = size * 0.7;
  return (
    <>
      <Pressable
        testID={testID}
        onPress={() => setChooser(true)}
        disabled={disabled || busy}
        accessibilityRole="button"
        accessibilityLabel="Send photos to Claude"
        accessibilityHint="Pick photos or take one; they upload into this session's project for Claude to read"
        accessibilityState={{ disabled: Boolean(disabled), busy }}
        hitSlop={theme.layout.hitSlop}
        style={({ pressed }) => ({
          width: size,
          height: size,
          borderRadius: theme.radius.xs,
          borderWidth: theme.layout.hairline,
          borderColor: pressed ? theme.colors.focus : theme.colors.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          opacity: disabled ? 0.45 : busy ? 0.6 : 1,
        })}
      >
        {/* A camera glyph drawn from views — this app carries no icon font. */}
        <View accessibilityElementsHidden style={{ alignItems: 'center', justifyContent: 'center' }}>
          <View
            style={{
              width: glyph * 0.62,
              height: glyph * 0.42,
              borderRadius: glyph * 0.08,
              borderWidth: 2,
              borderColor: ink,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ width: glyph * 0.2, height: glyph * 0.2, borderRadius: glyph * 0.1, borderWidth: 2, borderColor: ink }} />
          </View>
        </View>
        <Text allowFontScaling={false} accessibilityElementsHidden style={{ ...theme.type.micro, color: ink }}>
          photo
        </Text>
        {busy ? (
          <View style={{ position: 'absolute', bottom: 2, right: 2 }}>
            <Dot status="accent" size={5} pulse />
          </View>
        ) : null}
      </Pressable>

      <Sheet visible={chooser} onClose={() => setChooser(false)} title="Send photos to Claude" testID="photo-chooser">
        <Column gap="xxs">
          <ListItem
            testID="photo-library"
            title="Photo library"
            subtitle="Screenshots and photos — up to 4 at once"
            onPress={() => pick('library')}
          />
          <ListItem
            testID="photo-camera"
            title="Take a photo"
            subtitle="Opens the camera"
            onPress={() => pick('camera')}
          />
        </Column>
      </Sheet>
    </>
  );
}
