// Minimal Markdown parser for agent messages. It produces a plain tree that the view renders
// as React elements, so raw HTML in model output is shown as text and never interpreted.

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; text: string; href: string };

export type MdBlock =
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; children: MdInline[] }
  | { type: 'rule' };

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/;

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE_RE.exec(rest);
    if (!match) {
      out.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) out.push({ type: 'text', text: rest.slice(0, match.index) });
    const token = match[0];
    if (match[1]) out.push({ type: 'code', text: token.slice(1, -1) });
    else if (match[2]) out.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    else if (match[3]) out.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
    else if (match[4]) {
      const label = token.slice(1, token.indexOf(']('));
      out.push({ type: 'link', text: label, href: match[5]! });
    }
    rest = rest.slice(match.index + token.length);
  }
  return out;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const ordered = /\d/.test(bullet[1]!);
      const items: MdInline[][] = [parseInline(bullet[2]!)];
      while (i + 1 < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!next || /\d/.test(next[1]!) !== ordered) break;
        items.push(parseInline(next[2]!));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ type: 'quote', children: parseInline(quote[1]!) });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
