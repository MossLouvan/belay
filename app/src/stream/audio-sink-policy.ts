// Keep the native audio sink's view hierarchy stable while a host is paired.
// Enabling audio should start playback, not mount a new WKWebView into the
// desktop and give native layout/inset handling a chance to move the UI.
export function shouldMountAudioSink(platform: string, connected: boolean): boolean {
  return platform !== 'web' && connected;
}
