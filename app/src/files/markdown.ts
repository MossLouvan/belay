// A small markdown parser for the Files viewer's rendered mode.
//
// Hand-rolled rather than a dependency on purpose: the popular parsers emit
// HTML, which React Native cannot render without dragging in a webview or an
// HTML-to-native bridge — a heavy, native-module-shaped answer to a README.
// This produces a flat list of typed blocks that map one-to-one onto <Text>
// and <View>, covers what real READMEs actually use (headings, fences, lists,
// quotes, rules, emphasis, inline code, links), and degrades to visible plain
// text on anything it does not understand — never to swallowed content.
//
// Kept pure and JSX-free so the node test runner can exercise it directly;
// rendering lives in markdown-view.tsx.

export interface InlineSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
  readonly link?: string;
}

export type MdBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly spans: readonly InlineSpan[] }
  | { readonly kind: 'paragraph'; readonly spans: readonly InlineSpan[] }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'quote'; readonly spans: readonly InlineSpan[] }
  | {
      readonly kind: 'item';
      readonly ordered: boolean;
      readonly marker: string;
      readonly depth: number;
      readonly spans: readonly InlineSpan[];
    }
  | { readonly kind: 'rule' };

// ---- inline ----------------------------------------------------------------

interface InlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/**
 * The emphasis patterns require a non-space, non-marker character at both
 * edges of the content, which is what keeps `2 * 3 = 6` and `a ** b` reading
 * as arithmetic instead of half-opened emphasis that eats the line. The
 * `(?!\*)` on bold's closer makes `**bold *and italic***` close on the LAST
 * pair of the trailing run, so the nested italic stays inside.
 */
const INLINE_PATTERNS: readonly { readonly regex: RegExp; readonly apply: 'code' | 'link' | 'bold' | 'italic' }[] = [
  { regex: /`([^`]+)`/, apply: 'code' },
  { regex: /\[([^\]]+)\]\(([^()\s]+)\)/, apply: 'link' },
  { regex: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/, apply: 'bold' },
  { regex: /__(?=\S)([\s\S]*?\S)__(?!_)/, apply: 'bold' },
  { regex: /\*([^\s*](?:[^*]*[^\s*])?)\*/, apply: 'italic' },
  { regex: /_([^\s_](?:[^_]*[^\s_])?)_/, apply: 'italic' },
];

const styledSpan = (text: string, style: InlineStyle, extra: Partial<InlineSpan> = {}): InlineSpan => ({
  text,
  ...(style.bold ? { bold: true } : {}),
  ...(style.italic ? { italic: true } : {}),
  ...extra,
});

function parseInlineStyled(text: string, style: InlineStyle): readonly InlineSpan[] {
  if (text.length === 0) return [];

  // Earliest match wins; on a tie the pattern order above is the priority
  // (code is literal and must beat emphasis that happens to start inside it).
  let best: { index: number; match: RegExpExecArray; apply: string } | null = null;
  for (const { regex, apply } of INLINE_PATTERNS) {
    const match = regex.exec(text);
    if (match && (best === null || match.index < best.index)) {
      best = { index: match.index, match, apply };
    }
  }
  if (best === null) return [styledSpan(text, style)];

  const { match, apply } = best;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const head = before.length > 0 ? [styledSpan(before, style)] : [];

  const middle: readonly InlineSpan[] =
    apply === 'code' ? [styledSpan(match[1], style, { code: true })]
    : apply === 'link' ? [styledSpan(match[1], style, { link: match[2] })]
    : apply === 'bold' ? parseInlineStyled(match[1], { ...style, bold: true })
    : parseInlineStyled(match[1], { ...style, italic: true });

  return [...head, ...middle, ...parseInlineStyled(after, style)];
}

export const parseInline = (text: string): readonly InlineSpan[] => parseInlineStyled(text, {});

// ---- blocks ----------------------------------------------------------------

const FENCE_OPEN = /^\s{0,3}```\s*(\S*)\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))\s+(.*)$/;

/** Two spaces of indent per nesting level, the convention READMEs follow. */
const INDENT_PER_DEPTH = 2;

export function parseMarkdown(source: string): readonly MdBlock[] {
  const lines = source.split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    // Soft-wrapped source lines are one paragraph — README authors wrap at 80
    // columns, and rendering each line as its own paragraph shreds the prose.
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      // An unclosed fence runs to the end of the file — showing the rest of
      // the document as code beats silently dropping it.
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }

    if (line.trim().length === 0) { flush(); continue; }

    if (RULE.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: 'quote', spans: parseInline(quote[1]) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[3] !== undefined;
      blocks.push({
        kind: 'item',
        ordered,
        marker: ordered ? item[3] + item[4] : item[2],
        depth: Math.floor(item[1].length / INDENT_PER_DEPTH),
        spans: parseInline(item[5]),
      });
      continue;
    }

    paragraph = [...paragraph, line.trim()];
  }

  flush();
  return blocks;
}
