import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';
import {
  buildTerminalSearchOptions,
  extractTerminalSearchSeed,
  TERMINAL_SEARCH_MAX_QUERY_LENGTH,
} from '../lib/terminal-search-options';
import { safeFindMatch } from '../lib/terminal-search-safe-find';

interface TerminalSearchProps {
  isOpen: boolean;
  searchAddon: SearchAddon | null;
  getSelection: () => string;
  isDark: boolean;
  onClose: () => void;
}

export function TerminalSearch({
  isOpen,
  searchAddon,
  getSelection,
  isDark,
  onClose,
}: TerminalSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [matchState, setMatchState] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });

  // Subscribe to search result counter changes from xterm SearchAddon.
  useEffect(() => {
    if (!searchAddon) return;
    const sub = searchAddon.onDidChangeResults((e) => {
      setMatchState({ index: e.resultIndex, count: e.resultCount });
    });
    return () => sub.dispose();
  }, [searchAddon]);

  // Pre-seed query from active single-line terminal selection & focus input on open.
  useEffect(() => {
    if (!isOpen) {
      searchAddon?.clearDecorations();
      setMatchState({ index: -1, count: 0 });
      setRegexError(null);
      return;
    }
    const seed = extractTerminalSearchSeed(getSelection());
    if (seed) {
      setQuery(seed);
    }
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, searchAddon, getSelection]);

  const runSearch = useCallback(
    (direction: 'next' | 'previous', incremental = false) => {
      if (!searchAddon || !isOpen) return;
      if (!query) {
        searchAddon.clearDecorations();
        setMatchState({ index: -1, count: 0 });
        setRegexError(null);
        return;
      }
      const res = safeFindMatch(
        searchAddon,
        direction,
        query,
        buildTerminalSearchOptions({ caseSensitive, regex, incremental, isDark }),
      );
      setRegexError(res.regexError);
      if (res.regexError) {
        setMatchState({ index: -1, count: 0 });
      }
    },
    [searchAddon, isOpen, query, caseSensitive, regex, isDark],
  );

  // Live incremental search whenever query or toggle changes while bar is open.
  useEffect(() => {
    if (!isOpen) return;
    runSearch('next', true);
  }, [isOpen, query, caseSensitive, regex, isDark, runSearch]);

  if (!isOpen) return null;

  const counterText = regexError
    ? '正则错误'
    : !query
      ? ''
      : matchState.count === 0
        ? '无匹配'
        : matchState.index >= 0
          ? `${matchState.index + 1}/${matchState.count}`
          : `${matchState.count}+`;

  return (
    <div
      className="terminal-search-bar"
      role="search"
      aria-label="终端内容搜索"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        className={`terminal-search-input ${regexError ? 'has-error' : ''}`}
        value={query}
        maxLength={TERMINAL_SEARCH_MAX_QUERY_LENGTH}
        placeholder="搜索终端输出..."
        title={regexError ?? undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            runSearch(e.shiftKey ? 'previous' : 'next', false);
          }
        }}
      />
      {counterText && (
        <span
          className={`terminal-search-count ${
            regexError || (query && matchState.count === 0) ? 'is-empty' : ''
          }`}
          title={regexError ?? undefined}
        >
          {counterText}
        </span>
      )}
      <button
        type="button"
        className={`terminal-search-toggle ${caseSensitive ? 'active' : ''}`}
        title="区分大小写"
        aria-pressed={caseSensitive}
        onClick={() => setCaseSensitive((prev) => !prev)}
      >
        Aa
      </button>
      <button
        type="button"
        className={`terminal-search-toggle ${regex ? 'active' : ''}`}
        title="使用正则表达式"
        aria-pressed={regex}
        onClick={() => setRegex((prev) => !prev)}
      >
        .*
      </button>
      <button
        type="button"
        className="terminal-search-nav"
        title="上一个匹配 (Shift+Enter)"
        disabled={!query || Boolean(regexError)}
        onClick={() => runSearch('previous', false)}
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-search-nav"
        title="下一个匹配 (Enter)"
        disabled={!query || Boolean(regexError)}
        onClick={() => runSearch('next', false)}
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-search-close"
        title="关闭搜索 (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
