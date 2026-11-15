import type { BundledLanguage } from 'shiki/langs';
import type {
  CodeHighlightAppearance,
  DiffHighlightRow,
  SyntaxToken,
} from './code-syntax-highlight';

export type CodeHighlightTokens = Array<SyntaxToken[] | null> | null;

export type CodeHighlightSource =
  | { kind: 'code'; lines: readonly string[] }
  | { kind: 'diff'; rows: readonly DiffHighlightRow[] };

export interface CodeHighlightWorkerRequest {
  id: number;
  consumer: string;
  lang: BundledLanguage;
  appearance: CodeHighlightAppearance;
  source: CodeHighlightSource;
}

interface CodeHighlightWorkerResponse {
  id: number;
  tokens: CodeHighlightTokens;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, (tokens: CodeHighlightTokens) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(new URL('./code-syntax-highlight.worker.ts', import.meta.url), {
    type: 'module',
  });
  next.onmessage = (event: MessageEvent<CodeHighlightWorkerResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data.tokens);
  };
  next.onerror = () => {
    if (worker !== next) return;
    next.terminate();
    worker = null;
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  worker = next;
  return next;
}

export function requestCodeHighlight(
  consumer: string,
  source: CodeHighlightSource,
  lang: BundledLanguage,
  appearance: CodeHighlightAppearance,
): Promise<CodeHighlightTokens> {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    try {
      getWorker().postMessage({ id, consumer, source, lang, appearance });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}
