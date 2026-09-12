// The React half of ./look.ts, kept separate so the table stays importable by
// `node --test` without pulling react-native into the process.

import { lookFor, type Look } from './look';
import { useColorScheme } from '../theme';

/** The appearance in effect: Current under the light scheme, Fieldwork dark. */
export function useLook(): Look {
  return lookFor(useColorScheme());
}

export type { Look, LookName } from './look';
