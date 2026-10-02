// The React half of ./look.ts, kept separate so the table stays importable by
// `node --test` without pulling react-native into the process.

import { looks, type Look } from './look';
import { useAppearance } from '../theme';

/** The appearance in effect: Harbour (default), Current or Fieldwork. */
export function useLook(): Look {
  return looks[useAppearance().look];
}

export type { Look, LookName } from './look';
