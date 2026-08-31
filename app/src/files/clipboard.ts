// Clipboard access that never throws at a call site. expo-clipboard covers iOS
// and web, but the web side rides on navigator.clipboard, which browsers gate
// behind permissions and a secure context — reading in particular can be
// refused outright. A file browser must not crash because a copy button was
// pressed in Firefox over plain http, so both directions collapse failure into
// a value the UI can speak about.

import * as Clipboard from 'expo-clipboard';

/** Returns whether the text actually made it to the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
}

/** Returns the clipboard's text, or null when reading is refused or empty. */
export async function pasteText(): Promise<string | null> {
  try {
    const text = await Clipboard.getStringAsync();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}
