// The translation layer between Claude Code's stream-json output and the
// small flat events the phone renders. Pure functions only — agent.ts owns
// processes and state, this file owns shapes — so both the live stdout loop
// and the transcript history loader (transcript.ts) speak through the same
// code and the tests can feed it raw lines without spawning anything.

// What the phone renders. Kept deliberately flat and small.
export interface AgentEvent {
  t: number;
  kind: 'user' | 'text' | 'tool' | 'tool-result' | 'result' | 'info' | 'error';
  text?: string;
  tool?: string;
  detail?: string;
  ok?: boolean;
  costUsd?: number;
  durationMs?: number;
  /** Pairs a tool call with its result: the CLI's tool_use id rides on both. */
  callId?: string;
  /** Full output length before truncation, so the phone can say what it cut. */
  chars?: number;
}

// A tool result is capped before it becomes an event: a `cat` of a big file
// or a long test run would otherwise ride the websocket, sit in the phone's
// feed, and be appended to the transcript on disk in full. 2KB keeps the
// interesting part — heads of files, tails are what the summary line is for —
// while `chars` preserves the honest total.
export const RESULT_CAP = 2000;

// One-line summary of a tool call, for the phone's activity feed and the
// approval prompt. Falls back to the first string field of the input.
export function toolDetail(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    name === 'Bash' ? input.command
    : name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit' ? input.file_path
    : name === 'Glob' || name === 'Grep' ? input.pattern
    : name === 'WebFetch' ? input.url
    : name === 'WebSearch' ? input.query
    : name === 'Task' ? input.description
    : Object.values(input).find((v) => typeof v === 'string');
  const s = typeof pick === 'string' ? pick : '';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// A tool_result's content varies by tool and CLI version: a plain string, or
// an array of blocks where only the text ones matter (images are skipped —
// the phone renders a feed, not a gallery).
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

/** Assistant content blocks → text/tool events. Shared with transcript.ts. */
export function eventsFromAssistantContent(content: unknown, t: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!Array.isArray(content)) return events;
  for (const block of content as any[]) {
    if (block?.type === 'text' && block.text?.trim()) {
      events.push({ t, kind: 'text', text: block.text });
    } else if (block?.type === 'tool_use') {
      events.push({
        t, kind: 'tool', tool: block.name,
        detail: toolDetail(block.name, block.input),
        callId: typeof block.id === 'string' ? block.id : undefined,
      });
    }
  }
  return events;
}

/**
 * tool_result blocks inside a user message → tool-result events. An empty
 * result still becomes an event: "it ran and printed nothing" is an answer,
 * and a failure with no output doubly so.
 */
export function eventsFromToolResults(content: unknown, t: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!Array.isArray(content)) return events;
  for (const block of content as any[]) {
    if (block?.type !== 'tool_result') continue;
    const full = resultText(block.content);
    events.push({
      t, kind: 'tool-result',
      ok: block.is_error !== true,
      text: full.length > RESULT_CAP ? full.slice(0, RESULT_CAP) + '…' : full,
      chars: full.length,
      callId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
    });
  }
  return events;
}

// Translate one stream-json line from the claude CLI into phone events.
// Unknown/noise types (thinking, partials, stream deltas) map to [].
export function parseClaudeLine(line: string): { events: AgentEvent[]; sessionId?: string; done?: boolean } {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { events: [] }; }
  const now = Date.now();

  if (msg.type === 'system' && msg.subtype === 'init') {
    return { events: [], sessionId: msg.session_id };
  }
  if (msg.type === 'assistant') {
    return { events: eventsFromAssistantContent(msg.message?.content, now) };
  }
  if (msg.type === 'user') {
    // The CLI hands tool results back as user messages. The user's own prompt
    // never appears here — it went in on stdin and the feed already has it —
    // so only tool_result blocks are worth anything.
    return { events: eventsFromToolResults(msg.message?.content, now) };
  }
  if (msg.type === 'result') {
    return {
      events: [{
        t: now, kind: 'result', ok: !msg.is_error,
        text: msg.is_error ? String(msg.result || msg.error || 'failed').slice(0, 500) : undefined,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      }],
      done: true,
    };
  }
  return { events: [] };
}
