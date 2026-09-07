// Desktop-first chrome: the tool drawer (Agent/Terminal/Files/System) and
// the one-time hint that points a brand-new user at the control bar. The
// waiting count is the old Agent tab badge, now on the TOOLS key and the
// drawer's Agent row.

import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { waitingSessions } from '../agent/attention';
import { useAgentAttention } from '../agent/attention-store';
import { loadHintSeen, persistHintSeen } from '../home/hint-store';

export interface ToolsHint {
  readonly showTools: boolean;
  readonly closeTools: () => void;
  /** null while the stored flag loads — the hint never flashes on first paint. */
  readonly hintSeen: boolean | null;
  readonly dismissHint: () => void;
  readonly openTools: () => void;
  /** The dock's Agent key: the drawer's Agent entry, one tap sooner. */
  readonly openAgent: () => void;
  readonly waitingCount: number;
}

export function useToolsHint(): ToolsHint {
  const [showTools, setShowTools] = useState(false);
  const { sessions } = useAgentAttention();
  const waitingCount = waitingSessions(sessions ?? []).length;
  /** null while the stored flag loads — the hint never flashes on first paint. */
  const [hintSeen, setHintSeen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void loadHintSeen().then((seen) => {
      if (live) setHintSeen(seen);
    });
    return () => {
      live = false;
    };
  }, []);
  const dismissHint = useCallback(() => {
    setHintSeen((seen) => {
      if (seen !== true) void persistHintSeen();
      return true;
    });
  }, []);
  const openTools = useCallback(() => {
    dismissHint();
    setShowTools(true);
  }, [dismissHint]);
  const closeTools = useCallback(() => setShowTools(false), []);
  // The dock's Agent key goes where the drawer's Agent entry goes — the same
  // navigate, one tap sooner.
  const openAgent = useCallback(() => {
    dismissHint();
    router.navigate('/agent');
  }, [dismissHint]);

  return { showTools, closeTools, hintSeen, dismissHint, openTools, openAgent, waitingCount };
}
