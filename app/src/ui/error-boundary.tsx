// The last line of defence: a render crash becomes a screen, not a blank app.
//
// Without this, any exception thrown during render takes the whole tree down —
// in development that is the red screen, but in a Release build the user gets
// a white rectangle and no way forward, which is both the worst review a
// reviewer can write and the one failure mode a shipping app must not have.
//
// What it deliberately does NOT do: show the user the error. A message like
// "Cannot read properties of undefined" is not information to anyone who did
// not write the line, and stack traces are internal detail that has no place
// on screen. The user gets what they can act on — what broke, and a way to
// carry on — and the details go to the console, where a developer attaching a
// device log can read them.

import React from 'react';
import { View } from 'react-native';
import { getTheme } from '../theme';
import type { ColorScheme } from '../theme';
import { Button } from './button';
import { Txt } from './text';

export interface ErrorBoundaryProps {
  readonly children: React.ReactNode;
  /**
   * The scheme to paint the fallback in. Passed rather than hooked because a
   * boundary must be a class component, and because a crash may well have come
   * from the theme layer itself — this cannot depend on a working tree.
   */
  readonly scheme: ColorScheme;
  /** Called when the user asks to try again, before the boundary resets. */
  readonly onReset?: () => void;
}

interface ErrorBoundaryState {
  readonly crashed: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // The one console call the app makes on purpose. A crash is exactly the
    // case where a device log is worth more than a clean console, and it can
    // only happen once per mount.
    console.error('[belay] a screen failed to render', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ crashed: false });
  };

  override render(): React.ReactNode {
    if (!this.state.crashed) return this.props.children;

    const theme = getTheme(this.props.scheme);
    return (
      <View
        testID="error-boundary-fallback"
        style={{
          flex: 1,
          backgroundColor: theme.colors.bg,
          paddingHorizontal: theme.layout.margin,
          justifyContent: 'center',
          gap: theme.space.sm,
        }}
      >
        <Txt variant="title" heading>Something went wrong</Txt>
        <Txt variant="body" tone="dim">
          Belay hit a problem drawing this screen. Your computer and its pairing are untouched —
          try again, and if it keeps happening, restart the app.
        </Txt>
        <View style={{ marginTop: theme.space.md }}>
          <Button label="Try again" onPress={this.handleReset} fullWidth testID="error-boundary-retry" />
        </View>
      </View>
    );
  }
}
