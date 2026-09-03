// Paired devices, with revoke wired to the host at last. The section used to
// end with "go use the computer" — which is exactly backwards for the one
// scenario revocation exists for: a phone that is lost is not the phone you
// are holding, and the computer may be a train ride away.
//
// Sweep form: a flush bordered card of hairline-divided rows, like the
// reference's "Latest Sessions" table. The row button is a quiet ghost (the
// devices screen's Forget follows the same shape); the danger lives in the
// confirmation sheet, where the consequence is spelled out *before* the red
// button — and revoking the very phone in your hand is its own, distinctly
// worded event, because it ends with this phone logged out.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { api, UnauthorizedError } from '../api';
import { Button, Caption, Card, Column, Row, Sheet, Txt } from '../ui';
import { fmtAgo } from './format';
import { CardRow } from './card-row';
import { canRevoke, isSelfDevice, revocationCopy } from './devices-model';
import type { PairedDevice } from './devices-model';

export interface DevicesSectionProps {
  readonly devices: readonly PairedDevice[];
  readonly now: number;
  /** The full token this phone authenticates with — identifies "this phone" among the rows. */
  readonly ownToken?: string;
  /** Reload the list after a successful revoke of some *other* device. */
  readonly onChanged: () => void;
  /** This phone just revoked itself: the caller forgets the computer and leaves. */
  readonly onSelfRevoked: () => void;
}

export function DevicesSection({ devices, now, ownToken, onChanged, onSelfRevoked }: DevicesSectionProps) {
  const theme = useTheme();
  const [pending, setPending] = useState<PairedDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingSelf = pending ? isSelfDevice(pending, ownToken) : false;
  const copy = pending ? revocationCopy(pending, pendingSelf) : null;

  const onConfirm = useCallback(async () => {
    if (!pending) return;
    const self = isSelfDevice(pending, ownToken);
    setBusy(true);
    setError(null);
    try {
      await api.revokeDevice(pending.tokenPrefix);
      setPending(null);
      if (self) onSelfRevoked();
      else onChanged();
    } catch (e: unknown) {
      // A 401 on a self-revoke means the token is already dead — which is the
      // outcome the user asked for, so finish the logout instead of erroring.
      if (self && e instanceof UnauthorizedError) {
        setPending(null);
        onSelfRevoked();
        return;
      }
      setPending(null);
      setError(e instanceof Error ? e.message : 'The computer did not confirm the revoke.');
    } finally {
      setBusy(false);
    }
  }, [pending, ownToken, onChanged, onSelfRevoked]);

  if (devices.length === 0) return null;

  return (
    <Card testID="devices-card" flush title="Paired devices">
      {devices.map((device, index) => {
        const self = isSelfDevice(device, ownToken);
        return (
          <CardRow
            key={`${device.tokenPrefix}-${device.createdAt}-${index}`}
            label={self ? `${device.name} · this phone` : device.name}
            divider={index < devices.length - 1}
          >
            <Row gap="sm" style={{ flexShrink: 1 }}>
              <Txt variant="mono" tone="dim" numberOfLines={1} style={{ flexShrink: 1 }}>
                {device.lastSeen > 0 ? `seen ${fmtAgo(now - device.lastSeen)}` : 'never used'}
              </Txt>
              {canRevoke(device) ? (
                <Button
                  testID={`revoke-${device.tokenPrefix}`}
                  variant="ghost"
                  size="sm"
                  label="Revoke"
                  accessibilityLabel={self ? 'Revoke this phone' : `Revoke ${device.name}`}
                  accessibilityHint={self ? 'Logs this phone out of this computer' : `Cuts ${device.name}'s access to this computer`}
                  onPress={() => { setError(null); setPending(device); }}
                />
              ) : null}
            </Row>
          </CardRow>
        );
      })}
      {error ? (
        <Caption
          style={{
            paddingHorizontal: theme.space.md,
            paddingBottom: theme.space.sm,
            color: theme.colors.bad,
          }}
        >
          {`Couldn’t revoke: ${error}`}
        </Caption>
      ) : null}

      <Sheet
        visible={pending !== null}
        onClose={() => setPending(null)}
        title={copy?.title ?? 'Revoke device?'}
      >
        <Column gap="md">
          <Txt>{copy?.body ?? ''}</Txt>
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" fullWidth disabled={busy} onPress={() => setPending(null)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                testID="revoke-confirm"
                label={copy?.confirmLabel ?? 'Revoke'}
                variant="danger"
                fullWidth
                loading={busy}
                onPress={() => void onConfirm()}
              />
            </View>
          </Row>
        </Column>
      </Sheet>
    </Card>
  );
}
