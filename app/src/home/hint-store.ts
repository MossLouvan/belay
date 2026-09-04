// Whether the first-run control-bar hint has been shown and put away.
//
// The hint is one line over the dock — "Keys, and all your tools, live down
// here" — pointing a brand-new user at the two things the desktop-first
// rebuild moved: the KEYS toggle and the TOOLS drawer. It shows until it is
// dismissed (the ×, or actually using Keys/Tools — proof the pointing
// worked), then never again. Same never-throw AsyncStorage pattern as
// files/hidden-store.ts: a broken store just means the hint shows again,
// which is harmless.

import AsyncStorage from '@react-native-async-storage/async-storage';

const HINT_SEEN_KEY = 'belay.home.hintSeen.v1';

/** True once the hint has been dismissed on this phone. */
export async function loadHintSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(HINT_SEEN_KEY)) === 'yes';
  } catch {
    return false;
  }
}

export async function persistHintSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(HINT_SEEN_KEY, 'yes');
  } catch {
    // It will show once more next launch. Harmless.
  }
}
