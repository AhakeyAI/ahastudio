import { useEffect, useId, useState } from 'react';
import type { BundledLanguage } from 'shiki/langs';
import {
  requestCodeHighlight,
  type CodeHighlightSource,
  type CodeHighlightTokens,
} from '../lib/code-syntax-highlight-client';
import type { CodeHighlightAppearance, DiffHighlightRow } from '../lib/code-syntax-highlight';

interface CodeHighlightResult {
  kind: 'code' | 'diff';
  content: readonly string[] | readonly DiffHighlightRow[];
  lang: BundledLanguage;
  appearance: CodeHighlightAppearance;
  tokens: CodeHighlightTokens;
}

/** Tokenizes in the shared Shiki worker; returns null until tokens for exactly this input arrive. */
export function useCodeHighlight(
  kind: 'code' | 'diff',
  content: readonly string[] | readonly DiffHighlightRow[],
  lang: BundledLanguage | null,
  appearance: CodeHighlightAppearance,
): CodeHighlightTokens {
  const consumer = useId();
  const [result, setResult] = useState<CodeHighlightResult | null>(null);

  useEffect(() => {
    if (!lang || content.length === 0) return;
    let cancelled = false;
    const source: CodeHighlightSource = kind === 'code'
      ? { kind, lines: content as readonly string[] }
      : { kind, rows: content as readonly DiffHighlightRow[] };
    void requestCodeHighlight(consumer, source, lang, appearance).then((tokens) => {
      if (!cancelled) setResult({ kind, content, lang, appearance, tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [consumer, kind, content, lang, appearance]);

  if (
    !lang ||
    result?.kind !== kind ||
    result.content !== content ||
    result.lang !== lang ||
    result.appearance !== appearance
  ) {
    return null;
  }
  return result.tokens;
}
