// The cartoon beluga: Belay's hero illustration for welcome screens, empty
// states, the lock screen. Flat cream body, Harbour-slate outline, the blue
// rope collar and carabiner. Same drawing as assets/beluga-cartoon.svg (the
// master; desktop/renderer/beluga-cartoon.svg is a copy). Explicit colours,
// so it reads on both Harbour and Night grounds. Small marks and icons stay
// on BelugaAvatar's silhouette.

import React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

// ponytail: inlined copy of assets/beluga-cartoon.svg; edit both together.
const BELUGA_CARTOON_XML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 280">
  <title>Belay beluga</title>
  <g stroke="#1E3A4C" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round">
    <ellipse cx="165" cy="262" rx="112" ry="10" fill="#1E3A4C" fill-opacity="0.14" stroke="none"/>
    <path d="M262 206C276 190 290 176 306 168C308 184 302 196 292 204C304 206 313 214 316 228C298 230 280 222 266 216Z" fill="#DCE4E8"/>
    <path d="M78 200C62 214 48 232 40 252C58 252 80 238 96 218Z" fill="#DCE4E8"/>
    <path d="M58 148C44 96 82 32 146 30C210 28 246 78 242 124C246 152 262 178 278 200C262 226 222 246 172 248C112 252 70 222 58 148Z" fill="#F7F3EA"/>
    <path d="M276 203C258 228 220 246 172 248C120 251 84 230 68 190C96 222 150 236 196 226C236 218 262 206 276 203Z" fill="#DCE4E8" stroke="none"/>
    <path d="M150 36C190 34 222 58 230 92C212 64 186 48 150 42Z" fill="#FFFFFF" stroke="none" opacity="0.9"/>
    <path d="M74 134C100 122 140 122 164 132" fill="none" stroke="#A9BAC4" stroke-width="3"/>
    <path d="M76 154C96 176 140 178 168 158" fill="none"/>
    <circle cx="86" cy="104" r="7.5" fill="#1E3A4C" stroke="none"/>
    <circle cx="164" cy="100" r="8.5" fill="#1E3A4C" stroke="none"/>
    <circle cx="88.5" cy="101.5" r="2.4" fill="#FFFFFF" stroke="none"/>
    <circle cx="167" cy="97" r="2.7" fill="#FFFFFF" stroke="none"/>
    <path d="M60 172C92 206 186 206 240 150" fill="none" stroke="#1E3A4C" stroke-width="12"/>
    <path d="M60 172C92 206 186 206 240 150" fill="none" stroke="#2F7DE1" stroke-width="7"/>
    <path d="M60 172C92 206 186 206 240 150" fill="none" stroke="#8CC0F7" stroke-width="2.5" stroke-dasharray="3 7"/>
    <path d="M118 196C110 200 108 214 110 224C112 234 126 234 128 224L130 204C131 196 124 193 118 196Z" fill="none" stroke="#1E3A4C" stroke-width="8"/>
    <path d="M118 196C110 200 108 214 110 224C112 234 126 234 128 224L130 204C131 196 124 193 118 196Z" fill="none" stroke="#B7C3CB" stroke-width="4"/>
    <path d="M184 196C204 200 222 216 232 238C210 240 190 228 178 210Z" fill="#DCE4E8"/>
  </g>
</svg>`;

const ASPECT = 280 / 320;

export interface BelugaIllustrationProps {
  /** Drawn width in points; height follows the 320×280 artwork. */
  readonly size?: number;
  readonly accessibilityLabel?: string;
}

export function BelugaIllustration({ size = 160, accessibilityLabel = 'Belay beluga' }: BelugaIllustrationProps) {
  // The a11y props sit on a View: on web SvgXml forwards them to the DOM as
  // invalid attributes.
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <SvgXml xml={BELUGA_CARTOON_XML} width={size} height={size * ASPECT} />
    </View>
  );
}
