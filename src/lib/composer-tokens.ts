import type { CodexModelOption, CodexSkillOption } from '../types';

/** A `$skill` or `@file` token the caret is in, with the text range it covers. */
export interface ComposerTrigger {
  kind: 'skill' | 'file';
  query: string;
  start: number;
  end: number;
}

const SKILL_QUERY = /^[\w:.\-]*$/u;

/** The trigger token around `caret`; it must start the text or follow whitespace. */
export function detectTrigger(text: string, caret: number): ComposerTrigger | null {
  let start = caret;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start--;
  const sigil = text[start];
  if (sigil !== '$' && sigil !== '@') return null;
  let end = caret;
  while (end < text.length && !/\s/u.test(text[end]!)) end++;
  const query = text.slice(start + 1, caret);
  if (sigil === '$' && !SKILL_QUERY.test(query)) return null;
  return { kind: sigil === '$' ? 'skill' : 'file', query, start, end };
}

/** Replaces the trigger token with `insertion` and a trailing space; returns the new caret. */
export function applyCompletion(text: string, trigger: ComposerTrigger, insertion: string): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const spaced = after.startsWith(' ') ? insertion : `${insertion} `;
  return { text: text.slice(0, trigger.start) + spaced + after, caret: trigger.start + spaced.length + (after.startsWith(' ') ? 1 : 0) };
}

export const fileMention = (path: string) => (/\s/u.test(path) ? `@"${path}"` : `@${path}`);
export const skillMention = (name: string) => `$${name}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Skills still named in the text as `$name`; deleting the token drops the skill from the message. */
export function skillsInText<T extends Pick<CodexSkillOption, 'name'>>(text: string, skills: readonly T[]): T[] {
  return skills.filter((skill) => new RegExp(`(^|\\s)${escapeRegExp(skillMention(skill.name))}(?=$|\\s|[,.;!?，。；！？])`, 'u').test(text));
}

/** Enabled skills matching `query`: name prefix first, then name, then description. */
export function filterSkills(skills: readonly CodexSkillOption[], query: string, limit = 20): CodexSkillOption[] {
  const q = query.toLowerCase();
  const rank = (skill: CodexSkillOption) => {
    const name = skill.name.toLowerCase();
    if (!q || name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return skill.description.toLowerCase().includes(q) ? 2 : 3;
  };
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill);
}

export const EFFORT_LABELS: Record<string, string> = {
  minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '极高', ultra: '极限',
};
export const effortLabel = (value: string | null | undefined) => (value ? EFFORT_LABELS[value] ?? value : '默认');

/**
 * The model and effort a message would use: the chosen ones when the catalog supports them,
 * otherwise the model's default effort. With no model chosen it is Codex's default model; a model
 * the catalog does not list (e.g. a hidden one from the person's config) stays as it is.
 */
export function resolveModelChoice(
  models: readonly CodexModelOption[], modelId: string | null, effort: string | null,
): { model: CodexModelOption | null; effort: string | null } {
  const model = modelId
    ? models.find((entry) => entry.id === modelId || entry.model === modelId) ?? null
    : models.find((entry) => entry.isDefault) ?? models[0] ?? null;
  if (!model) return { model: null, effort };
  const supported = model.efforts.some((option) => option.value === effort);
  return { model, effort: supported ? effort : model.defaultEffort ?? model.efforts[0]?.value ?? null };
}
