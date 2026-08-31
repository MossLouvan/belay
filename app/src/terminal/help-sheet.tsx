// The Terminal tab's help sheet, opened from the header's ⋯. The key bar's
// keys are self-labelled, but what TAB does — and why arrows sometimes recall
// local history instead of reaching the shell — is behaviour, and behaviour
// that isn't written down anywhere is a feature nobody can find
// (docs/DESIGN.md §11).

import React from 'react';
import { ScrollView } from 'react-native';
import { useTheme } from '../theme';
import { Caption, Sheet, Txt } from '../ui';

export interface TerminalHelpSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function TerminalHelpSheet({ visible, onClose }: TerminalHelpSheetProps) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="Terminal help" testID="term-help-sheet">
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: theme.space.sm }}>
        <Txt variant="bodyStrong">Type and Run</Txt>
        <Caption>
          Type (also the keyboard&apos;s return key) sends exactly what is in the box, without pressing return — a
          half-typed command lands at the shell&apos;s prompt where tab can finish it, and text reaches vim or an
          interactive prompt as plain keystrokes. Run sends the box and then presses return; with the box empty it just
          presses return, which runs whatever line is already sitting at the prompt. The ⏎ key on the bar does the
          same.
        </Caption>
        <Txt variant="bodyStrong">Tab completion</Txt>
        <Caption>
          With text in the box and nothing at the shell&apos;s prompt, tab asks the shell on your computer to complete
          it — file names, paths, commands — exactly as it would at its own keyboard. One match fills the line in.
          Several matches appear as a row above the keys: tap one to use it, or keep typing to narrow them down. Once
          something is at the prompt (after a Type, or a history recall), tab joins the box onto it and goes straight
          through, so the shell&apos;s own completion answers in the transcript. With the box empty, tab is a plain tab
          keystroke to whatever is running.
        </Caption>
        <Txt variant="bodyStrong">History</Txt>
        <Caption>
          The ↑ and ↓ keys move through the shell&apos;s own history when there is a real terminal on the other end,
          and through this phone&apos;s recent Run commands when there is not.
        </Caption>
        <Txt variant="bodyStrong">The key bar</Txt>
        <Caption>
          Esc, tab, return, arrows, ^C and ^D go straight to the shell — enough to drive vim, less, or an interactive
          CLI. The bottom row holds the symbols a phone keyboard buries. Clear wipes this screen&apos;s scrollback;
          ⌄ hide puts the keyboard away.
        </Caption>
        <Txt variant="bodyStrong">Ctrl and Alt</Txt>
        <Caption>
          Tap ctrl or alt to arm it for the next key press — the bottom row swaps to letters so Ctrl+R or Alt+F is two
          taps. The modifier always clears itself after one key.
        </Caption>
        <Txt variant="bodyStrong">claude keys</Txt>
        <Caption>
          The claude and claude -c keys launch the raw Claude Code CLI in this shell — the Agent tab is the guided way
          in, this is the direct one.
        </Caption>
        <Txt variant="bodyStrong">If the header says “shell” instead of “pty”</Txt>
        <Caption>
          The computer is running without a real terminal, so there is no tab completion, cursor drawing or job
          control. Install node-pty next to the host agent and restart it to get the full terminal back.
        </Caption>
      </ScrollView>
    </Sheet>
  );
}
