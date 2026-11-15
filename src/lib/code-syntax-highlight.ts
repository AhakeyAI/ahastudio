import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages, type BundledLanguage } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

export type CodeHighlightAppearance = 'light' | 'dark';

export const CODE_HIGHLIGHT_THEMES: Record<CodeHighlightAppearance, 'light-plus' | 'dark-plus'> = {
  light: 'light-plus',
  dark: 'dark-plus',
};
export const CODE_HIGHLIGHT_THEME = CODE_HIGHLIGHT_THEMES.light;
export const CODE_HIGHLIGHT_MAX_LINE_LENGTH = 1500;
export const CODE_HIGHLIGHT_MAX_CHARS = 350_000;

export interface SyntaxToken {
  text: string;
  color?: string;
  italic?: boolean;
}

export interface DiffHighlightRow {
  kind: 'file' | 'hunk' | 'context' | 'add' | 'del' | 'meta' | 'note';
  text: string;
}

export { detectCodeLanguage } from './code-language.ts';

let highlighterInstance: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore | null> | null = null;
const loadedLangs = new Set<string>();
const langLoadPromises = new Map<string, Promise<boolean>>();

async function getHighlighter(): Promise<HighlighterCore | null> {
  if (highlighterInstance) return highlighterInstance;
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const [lightTheme, darkTheme] = await Promise.all([
          bundledThemes[CODE_HIGHLIGHT_THEMES.light](),
          bundledThemes[CODE_HIGHLIGHT_THEMES.dark](),
        ]);
        const instance = await createHighlighterCore({
          themes: [lightTheme.default, darkTheme.default],
          langs: [],
          engine: createOnigurumaEngine(() => import('shiki/wasm')),
        });
        highlighterInstance = instance;
        return instance;
      } catch {
        highlighterPromise = null;
        return null;
      }
    })();
  }
  return highlighterPromise;
}

export function isCodeLanguageReady(lang: BundledLanguage): boolean {
  return highlighterInstance !== null && loadedLangs.has(lang);
}

export async function ensureCodeLanguageLoaded(lang: BundledLanguage): Promise<boolean> {
  if (isCodeLanguageReady(lang)) return true;
  const inflight = langLoadPromises.get(lang);
  if (inflight) return inflight;

  const promise = (async () => {
    const highlighter = await getHighlighter();
    if (!highlighter) return false;
    if (loadedLangs.has(lang)) return true;
    try {
      const loader = bundledLanguages[lang];
      if (!loader) return false;
      await highlighter.loadLanguage(loader);
      loadedLangs.add(lang);
      return true;
    } catch {
      return false;
    } finally {
      langLoadPromises.delete(lang);
    }
  })();

  langLoadPromises.set(lang, promise);
  return promise;
}

function normalizeHexBase(hex: string): string {
  const lower = hex.toLowerCase();
  if (lower.length === 9 && lower.endsWith('ff')) return lower.slice(0, 7);
  return lower;
}

// Inherit base CSS text color for theme-default/empty tokens to reduce DOM span count.
function isDefaultForeground(color: string | undefined, themeFg: string | undefined): boolean {
  if (!color) return true;
  const lower = normalizeHexBase(color);
  if (themeFg && lower === normalizeHexBase(themeFg)) return true;
  return lower === '#000000' || lower === '#000';
}

function normalizeLineTokens(
  rawLine: ThemedToken[] | undefined,
  rawText: string,
  themeFg: string | undefined
): SyntaxToken[] {
  if (!rawLine || rawLine.length === 0) {
    return rawText ? [{ text: rawText }] : [];
  }
  const merged: SyntaxToken[] = [];
  for (const token of rawLine) {
    if (!token.content) continue;
    const blank = token.content.trim().length === 0;
    const color = blank || isDefaultForeground(token.color, themeFg) ? undefined : token.color;
    const italic = !blank && Boolean(token.fontStyle && (token.fontStyle & 1) !== 0);
    const prev = merged.at(-1);
    if (prev && prev.color === color && Boolean(prev.italic) === italic) {
      prev.text += token.content;
    } else {
      merged.push({
        text: token.content,
        ...(color ? { color } : {}),
        ...(italic ? { italic: true } : {}),
      });
    }
  }
  return merged;
}

function tokenizeJoinedLines(
  highlighter: HighlighterCore,
  lines: readonly string[],
  lang: BundledLanguage,
  appearance: CodeHighlightAppearance
): SyntaxToken[][] | null {
  if (lines.length === 0) return [];
  try {
    const result = highlighter.codeToTokens(lines.join('\n'), {
      lang,
      theme: CODE_HIGHLIGHT_THEMES[appearance],
      tokenizeMaxLineLength: CODE_HIGHLIGHT_MAX_LINE_LENGTH,
      tokenizeTimeLimit: 200,
    });
    if (result.tokens.length !== lines.length) return null;
    return lines.map((line, i) => normalizeLineTokens(result.tokens[i], line, result.fg));
  } catch {
    return null;
  }
}

function countLinesWithinBudget(lines: readonly string[], budget: number): number {
  let used = 0;
  let count = 0;
  while (count < lines.length) {
    const cost = lines[count].length + (count > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    count += 1;
  }
  return count;
}

export function tokenizeCodeLinesSync(
  lines: readonly string[],
  lang: BundledLanguage,
  appearance: CodeHighlightAppearance = 'light'
): SyntaxToken[][] | null {
  if (lines.length === 0) return [];
  if (!highlighterInstance || !loadedLangs.has(lang)) return null;

  const limit = countLinesWithinBudget(lines, CODE_HIGHLIGHT_MAX_CHARS);
  if (limit === 0) {
    return lines.map((line) => (line ? [{ text: line }] : []));
  }
  const tokenized = tokenizeJoinedLines(highlighterInstance, lines.slice(0, limit), lang, appearance);
  if (!tokenized) return null;
  if (limit === lines.length) return tokenized;

  for (let i = limit; i < lines.length; i++) {
    const line = lines[i];
    tokenized.push(line ? [{ text: line }] : []);
  }
  return tokenized;
}

export function tokenizeDiffRowsSync(
  rows: readonly DiffHighlightRow[],
  lang: BundledLanguage,
  appearance: CodeHighlightAppearance = 'light'
): Array<SyntaxToken[] | null> | null {
  if (rows.length === 0) return [];
  if (!highlighterInstance || !loadedLangs.has(lang)) return null;

  const out: Array<SyntaxToken[] | null> = new Array(rows.length).fill(null);
  let remainingChars = CODE_HIGHLIGHT_MAX_CHARS;

  let index = 0;
  while (index < rows.length && remainingChars > 0) {
    const row = rows[index];
    if (row.kind === 'file' || row.kind === 'hunk' || row.kind === 'meta' || row.kind === 'note') {
      index += 1;
      continue;
    }

    const newIndices: number[] = [];
    const oldIndices: number[] = [];
    let hasDel = false;
    while (index < rows.length) {
      const curr = rows[index];
      if (curr.kind === 'file' || curr.kind === 'hunk' || curr.kind === 'meta' || curr.kind === 'note') {
        break;
      }
      if (curr.kind === 'context' || curr.kind === 'add') newIndices.push(index);
      if (curr.kind === 'context' || curr.kind === 'del') {
        oldIndices.push(index);
        if (curr.kind === 'del') hasDel = true;
      }
      index += 1;
    }

    // Tokenize old and new hunk code separately so deleted lines cannot bleed grammar state into added lines.
    if (newIndices.length > 0 && remainingChars > 0) {
      const newLines = newIndices.map((idx) => rows[idx].text);
      const limit = countLinesWithinBudget(newLines, remainingChars);
      if (limit > 0) {
        const sliced = newLines.slice(0, limit);
        const tokens = tokenizeJoinedLines(highlighterInstance, sliced, lang, appearance);
        if (tokens) {
          for (let k = 0; k < limit; k++) {
            out[newIndices[k]] = tokens[k];
            remainingChars -= sliced[k].length + 1;
          }
        }
      }
    }

    if (hasDel && oldIndices.length > 0 && remainingChars > 0) {
      const oldLines = oldIndices.map((idx) => rows[idx].text);
      const limit = countLinesWithinBudget(oldLines, remainingChars);
      if (limit > 0) {
        const sliced = oldLines.slice(0, limit);
        const tokens = tokenizeJoinedLines(highlighterInstance, sliced, lang, appearance);
        if (tokens) {
          for (let k = 0; k < limit; k++) {
            const rowIdx = oldIndices[k];
            if (rows[rowIdx].kind === 'del') {
              out[rowIdx] = tokens[k];
            }
            remainingChars -= sliced[k].length + 1;
          }
        }
      }
    }
  }

  return out;
}
