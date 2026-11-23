// Pure helpers for the Agent session header: title edits and the folder chip.

export const MAX_SESSION_TITLE = 80;

export type TitleEdit = { action: 'commit'; title: string } | { action: 'reject'; error: string } | { action: 'noop' };

/**
 * What a rename should do with the text the person typed: line breaks and runs of whitespace
 * become one space, an empty title is refused, and an unchanged one does nothing.
 */
export function resolveTitleEdit(input: string, current: string): TitleEdit {
  const title = input.replace(/\s+/gu, ' ').trim();
  if (!title) return { action: 'reject', error: '标题不能为空' };
  if ([...title].length > MAX_SESSION_TITLE) return { action: 'reject', error: `标题最多 ${MAX_SESSION_TITLE} 个字` };
  if (title === current.trim()) return { action: 'noop' };
  return { action: 'commit', title };
}

/** Last folder of a path, for the header's working-directory chip. */
export const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
