// The type-to-PC row: its draft, the send, and the keyboard it rides.
//
// The row floats over the layout and rides the keyboard's own animation,
// instead of a root KeyboardAvoidingView shrinking the page. Padding the
// root squished the flex video stage by the keyboard's height (a violent
// refit of the live picture) and, in fullscreen, yanked the
// absolutely-positioned dock up mid-video — the "Type breaks the UI" bug.
// The lift is measured against the route's root view, so it lands exactly on
// the keyboard's top edge whether the tab bar is there (non-fullscreen) or not.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Animated, Keyboard, View } from 'react-native';
import { api } from '../api';
import { haptic, useKeyboardLift } from '../ui';
import { messageOf } from './model';

export interface TypeRowState {
  /** Attach to the route's root view: the keyboard lift is measured against it. */
  readonly rootRef: RefObject<View | null>;
  readonly text: string;
  readonly setText: Dispatch<SetStateAction<string>>;
  readonly sendText: () => void;
  readonly typeOpen: boolean;
  readonly toggleType: () => void;
  /** The visible way out of the keyboard: dismiss it and fold the row. */
  readonly closeType: () => void;
  /** Negative keyboard intrusion, for the floating row's translateY. */
  readonly typeBarLift: Animated.AnimatedMultiplication<number>;
}

export function useTypeRow(reportError: (message: string) => void): TypeRowState {
  const [typeOpen, setTypeOpen] = useState(false);
  const [text, setText] = useState('');

  const sendText = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    haptic('light');
    setText('');
    api.typeText(value).catch((e: unknown) => reportError(`Sending text failed — ${messageOf(e)}`));
  }, [reportError, text]);

  // The visible way out of the keyboard (docs/DESIGN.md §11.2). This surface
  // has no scrollable to drag and no safe "outside" to tap — every stage touch
  // is a remote mouse click — so without this × the only exits were sending
  // unwanted text or knowing to re-press the unmarked TYPE toggle.
  const closeType = useCallback(() => {
    Keyboard.dismiss();
    setTypeOpen(false);
  }, []);

  const toggleType = useCallback(() => setTypeOpen((v) => !v), []);

  const rootRef = useRef<View>(null);
  const keyboard = useKeyboardLift(rootRef);
  const typeBarLift = useMemo(() => Animated.multiply(keyboard.lift, -1), [keyboard.lift]);

  // Once the keyboard the field summoned has actually gone (the ×, an app
  // switch, a hardware keyboard), the floating row has nothing to sit above —
  // left open it would park on top of the dock. Close it; the draft survives
  // in `text` for the next open. The ref gates on "a keyboard was seen" so
  // the row is not closed in the gap between mounting and the show event.
  const sawKeyboardRef = useRef(false);
  useEffect(() => {
    if (keyboard.shown) {
      sawKeyboardRef.current = true;
      return;
    }
    if (sawKeyboardRef.current) {
      sawKeyboardRef.current = false;
      setTypeOpen(false);
    }
  }, [keyboard.shown]);

  return { rootRef, text, setText, sendText, typeOpen, toggleType, closeType, typeBarLift };
}
