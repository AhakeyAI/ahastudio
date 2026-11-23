import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, RefreshCw, Search } from 'lucide-react';
import type { CodexPluginOption, CodexSkillOption } from '../../types';
import { ComposerPopover } from './ComposerPopover';

const SCOPE_LABELS: Record<string, string> = { repo: '项目', user: '个人', system: '内置', admin: '管理员' };

/**
 * Installed Codex plugins (read-only: installing changes the person's Codex setup) and skills,
 * which can be switched on or off in Codex's own config.
 */
export function ComposerCatalogPanel({ sessionId, onNotify, onUseSkill }: {
  sessionId: string;
  onNotify?: (message: string) => void;
  onUseSkill: (skill: CodexSkillOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  const [plugins, setPlugins] = useState<CodexPluginOption[] | null>(null);
  const [skills, setSkills] = useState<CodexSkillOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const api = typeof window !== 'undefined' ? window.vibeMeet?.agentSessions : undefined;

  const load = useCallback(async (reload = false) => {
    if (!api) return;
    setError(null);
    const [pluginRes, skillRes] = await Promise.all([api.plugins({ id: sessionId }), api.skills({ id: sessionId, reload })]);
    if (pluginRes.ok) setPlugins(pluginRes.plugins);
    if (skillRes.ok) setSkills(skillRes.skills);
    const failed = [pluginRes, skillRes].find((res) => !res.ok);
    if (failed && !failed.ok) setError(failed.error);
  }, [api, sessionId]);

  useEffect(() => {
    if (open && (!plugins || !skills)) void load();
  }, [open, plugins, skills, load]);

  const q = query.trim().toLowerCase();
  const shownPlugins = useMemo(() => (plugins ?? []).filter((plugin) =>
    !q || `${plugin.displayName} ${plugin.description} ${plugin.developer ?? ''}`.toLowerCase().includes(q)), [plugins, q]);
  const shownSkills = useMemo(() => (skills ?? []).filter((skill) =>
    !q || `${skill.name} ${skill.description}`.toLowerCase().includes(q)), [skills, q]);

  const toggleSkill = async (skill: CodexSkillOption) => {
    if (!api) return;
    setBusyPath(skill.path);
    try {
      const res = await api.setSkillEnabled({ id: sessionId, path: skill.path, enabled: !skill.enabled });
      if (!res.ok) {
        onNotify?.(res.error);
        return;
      }
      setSkills((list) => list?.map((item) => (item.path === skill.path ? { ...item, enabled: !skill.enabled } : item)) ?? list);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <ComposerPopover
      open={open}
      onClose={close}
      className="asv-catalog-pop"
      trigger={(
        <button
          type="button"
          className={`asv-tool-btn is-icon${open ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="插件与技能"
          title="插件与技能"
          onClick={() => setOpen((value) => !value)}
        >
          <Blocks size={14} />
        </button>
      )}
    >
      <div className="asv-catalog-head">
        <div className="asv-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'plugins'} className={tab === 'plugins' ? 'is-on' : ''} onClick={() => setTab('plugins')}>
            插件{plugins ? ` ${plugins.length}` : ''}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'is-on' : ''} onClick={() => setTab('skills')}>
            技能{skills ? ` ${skills.length}` : ''}
          </button>
        </div>
        <button type="button" className="asv-icon-btn" aria-label="刷新" title="重新读取" onClick={() => void load(true)}>
          <RefreshCw size={13} />
        </button>
      </div>
      <label className="asv-catalog-search">
        <Search size={13} aria-hidden="true" />
        <input value={query} placeholder={tab === 'plugins' ? '搜索插件' : '搜索技能'} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {error && <div className="asv-pop-note is-bad">{error}</div>}
      <div className="asv-catalog-list">
        {tab === 'plugins' ? (
          !plugins ? <div className="asv-pop-note">正在读取…</div>
            : shownPlugins.length === 0 ? <div className="asv-pop-note">{q ? '没有匹配的插件' : '还没有安装插件'}</div>
              : shownPlugins.map((plugin) => (
                <div key={plugin.id} className="asv-catalog-item">
                  <div className="asv-catalog-item-head">
                    <span className="asv-pop-row-title">{plugin.displayName}</span>
                    <span className={`asv-pop-badge${plugin.enabled ? ' is-ok' : ''}`}>{plugin.enabled ? '已启用' : '已停用'}</span>
                  </div>
                  {plugin.description && <div className="asv-pop-row-desc">{plugin.description}</div>}
                  <div className="asv-catalog-meta">
                    {[plugin.developer, plugin.category, ...plugin.capabilities].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))
        ) : (
          !skills ? <div className="asv-pop-note">正在读取…</div>
            : shownSkills.length === 0 ? <div className="asv-pop-note">{q ? '没有匹配的技能' : '没有可用的技能'}</div>
              : shownSkills.map((skill) => (
                <div key={skill.path} className={`asv-catalog-item${skill.enabled ? '' : ' is-off'}`}>
                  <div className="asv-catalog-item-head">
                    <button type="button" className="asv-skill-name" disabled={!skill.enabled} title="插入到消息里"
                      onClick={() => {
                        onUseSkill(skill);
                        close();
                      }}>
                      ${skill.name}
                    </button>
                    <span className="asv-pop-badge">{SCOPE_LABELS[skill.scope] ?? skill.scope}</span>
                    <span className="asv-strip-spacer" />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
                      title="修改 Codex 的技能配置，对所有 Codex 会话生效"
                      className={`asv-switch${skill.enabled ? ' is-on' : ''}`}
                      disabled={busyPath === skill.path}
                      onClick={() => void toggleSkill(skill)}
                    >
                      <i />
                    </button>
                  </div>
                  {skill.description && <div className="asv-pop-row-desc">{skill.description}</div>}
                </div>
              ))
        )}
      </div>
      <div className="asv-pop-foot">
        {tab === 'plugins' ? '插件在 Codex 中安装和管理' : '在输入框里输入 $ 也可以选技能'}
      </div>
    </ComposerPopover>
  );
}
