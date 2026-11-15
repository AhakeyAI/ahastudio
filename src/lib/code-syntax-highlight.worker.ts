import {
  ensureCodeLanguageLoaded,
  tokenizeCodeLinesSync,
  tokenizeDiffRowsSync,
} from './code-syntax-highlight';
import type { CodeHighlightTokens, CodeHighlightWorkerRequest } from './code-syntax-highlight-client';

const latestRequests = new Map<string, number>();
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<CodeHighlightWorkerRequest>) => void) | null;
  postMessage: (message: { id: number; tokens: CodeHighlightTokens }) => void;
};

workerScope.onmessage = async (event) => {
  const { id, consumer, source, lang, appearance } = event.data;
  latestRequests.set(consumer, id);
  const loaded = await ensureCodeLanguageLoaded(lang);
  let tokens: CodeHighlightTokens = null;
  if (loaded && latestRequests.get(consumer) === id) {
    tokens = source.kind === 'code'
      ? tokenizeCodeLinesSync(source.lines, lang, appearance)
      : tokenizeDiffRowsSync(source.rows, lang, appearance);
  }
  workerScope.postMessage({ id, tokens });
};
