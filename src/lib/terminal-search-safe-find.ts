import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';

export interface SafeFindResult {
  found: boolean;
  regexError: string | null;
}

export function safeFindMatch(
  addon: SearchAddon,
  direction: 'next' | 'previous',
  query: string,
  options: ISearchOptions,
): SafeFindResult {
  if (!query) {
    addon.clearDecorations();
    return { found: false, regexError: null };
  }
  if (options.regex) {
    try {
      new RegExp(query, options.caseSensitive ? 'u' : 'iu');
    } catch (error) {
      addon.clearDecorations();
      return {
        found: false,
        regexError: error instanceof Error ? error.message : '正则表达式语法错误',
      };
    }
  }
  try {
    const found =
      direction === 'previous'
        ? addon.findPrevious(query, options)
        : addon.findNext(query, options);
    return { found, regexError: null };
  } catch (error) {
    addon.clearDecorations();
    return {
      found: false,
      regexError: error instanceof Error ? error.message : String(error),
    };
  }
}
