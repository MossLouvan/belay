// Just enough of react-native for app/src/theme.ts to evaluate under node.
//
// The theme module reaches for four runtime values: Platform.select for the
// mono family, StyleSheet.hairlineWidth for the hairline, Easing.bezier for
// the two curves, and Appearance for the scheme store it never runs here.
// Everything returns the value the WEB build of the app would see — the
// desktop is a browser too — so the extracted tokens are the ones the app's
// own web bundle renders with.

export const Platform = Object.freeze({
  OS: 'web',
  select: (options) => (options.web !== undefined ? options.web : options.default),
});

export const StyleSheet = Object.freeze({ hairlineWidth: 1 });

export const Easing = Object.freeze({
  bezier: (x1, y1, x2, y2) => Object.freeze({ kind: 'bezier', points: Object.freeze([x1, y1, x2, y2]) }),
  linear: Object.freeze({ kind: 'linear', points: Object.freeze([0, 0, 1, 1]) }),
});

export const Appearance = Object.freeze({
  getColorScheme: () => 'dark',
  addChangeListener: () => Object.freeze({ remove: () => undefined }),
});
