// The one-time offer after a first pairing: "start Belay when this computer
// logs in?". Shown once per computer, on the first connection after it was
// added, and only when the host can autostart and does not yet. Either answer
// puts it away for good — the switch in the computer's sheet remains.
//
// Same never-throw AsyncStorage pattern as home/hint-store.ts: a broken store
// means the offer shows again, which is harmless.

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useConnection } from '../connection';
import { useTheme } from '../theme';
import { Button, Caption, Row, Sheet, Txt } from '../ui';
import { AUTOSTART_TITLE, useAutostart } from './autostart-toggle';

const PROMPTED_KEY = 'belay.autostart.prompted.v1:';
/** A computer added longer ago than this was paired in an earlier session — no offer. */
const FRESH_PAIR_MS = 10 * 60 * 1000;

async function wasPrompted(hostId: string): Promise<boolean> {
  try { return (await AsyncStorage.getItem(PROMPTED_KEY + hostId)) === 'yes'; }
  catch { return false; }
}

async function markPrompted(hostId: string): Promise<void> {
  try { await AsyncStorage.setItem(PROMPTED_KEY + hostId, 'yes'); }
  catch { /* shows once more next time; harmless */ }
}

export function AutostartPrompt() {
  const { active, phase } = useConnection();
  const fresh = phase === 'connected' && active !== undefined && Date.now() - active.addedAt < FRESH_PAIR_MS;
  const [candidate, setCandidate] = useState<string | null>(null);

  useEffect(() => {
    if (!fresh || !active) return;
    let live = true;
    void wasPrompted(active.id).then((seen) => { if (live && !seen) setCandidate(active.id); });
    return () => { live = false; };
  }, [fresh, active]);

  if (!candidate || !active || candidate !== active.id) return null;
  return <AutostartOffer label={active.label} hostId={candidate} onDone={() => setCandidate(null)} />;
}

function AutostartOffer({ label, hostId, onDone }: { label: string; hostId: string; onDone: () => void }) {
  const theme = useTheme();
  const { status, busy, error, setEnabled } = useAutostart();
  const [decided, setDecided] = useState(false);
  const visible = !decided && status?.supported === true && !status.installed;

  const close = () => { setDecided(true); void markPrompted(hostId); onDone(); };

  // A success closes on its own; a failure stays on screen until "Not now".
  useEffect(() => {
    if (status?.installed && !error) { setDecided(true); void markPrompted(hostId); onDone(); }
  }, [status, error, hostId, onDone]);

  return (
    <Sheet visible={visible || (Boolean(error) && !decided)} onClose={close} title={`${AUTOSTART_TITLE}?`} testID="autostart-prompt">
      <View style={{ gap: theme.space.md }}>
        <Txt>
          {label} can start Belay by itself whenever it logs in, so you never have to run it by hand. You can change this later from the computer&apos;s settings.
        </Txt>
        {error ? <Caption>{error}</Caption> : null}
        <Row gap="sm">
          <View style={{ flex: 1 }}>
            <Button label="Not now" variant="secondary" fullWidth disabled={busy} onPress={close} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Start at login" fullWidth loading={busy} onPress={() => { void setEnabled(true); }} />
          </View>
        </Row>
      </View>
    </Sheet>
  );
}
