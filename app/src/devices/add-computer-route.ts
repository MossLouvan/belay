// Where the computer list sends "add a computer".
//
// Pure, so node can test it: the list's field hands its text to the connect
// screen in the URL, and the connect screen checks it on arrival. Kept apart
// from the component so the two screens cannot drift on parameter names.

export interface AddComputerRoute {
  readonly pathname: '/';
  readonly params: Readonly<Record<string, string>>;
}

/**
 * A typed address goes to the connect screen already filled in and checked;
 * `null` asks for the scanner instead. Blank text goes nowhere — Connect on
 * an empty field is a no-op, not a trip to another screen.
 */
export function addComputerRoute(address: string | null): AddComputerRoute | null {
  if (address === null) {
    return { pathname: '/', params: { add: '1', scan: '1' } };
  }
  const trimmed = address.trim();
  if (!trimmed) return null;
  return { pathname: '/', params: { add: '1', address: trimmed } };
}
