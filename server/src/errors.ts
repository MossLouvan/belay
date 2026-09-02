// The one Error-narrowing helper. It was hand-defined four times (index.ts and
// each route module); one export keeps the message shape identical everywhere.
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
