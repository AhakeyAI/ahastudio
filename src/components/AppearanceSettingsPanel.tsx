import { Monitor, Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useHandheldMode } from '../lib/handheld-mode';
import { terminalSessionStore } from '../lib/terminal-session-store';
import type { TerminalAppearancePreference } from '../lib/terminal-appearance';

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: TerminalAppearancePreference;
  label: string;
  Icon: typeof Monitor;
}> = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
];

export function AppearanceSettingsPanel() {
  const preference = useSyncExternalStore(
    terminalSessionStore.subscribe,
    terminalSessionStore.getAppearancePreference,
  );
  const appearance = useSyncExternalStore(
    terminalSessionStore.subscribe,
    terminalSessionStore.getAppearance,
  );
  const handheld = useHandheldMode();

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <h2>外观</h2>
        <p>控制应用界面和不同屏幕下的布局方式。</p>
      </div>

      <section className="settings-card">
        <div className="settings-row">
          <div>
            <h3>界面与终端主题</h3>
            <p>当前生效：{appearance === 'dark' ? '深色' : '浅色'}</p>
          </div>
          <div className="settings-segmented" role="group" aria-label="界面与终端主题">
            {APPEARANCE_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={preference === value}
                className={preference === value ? 'is-active' : undefined}
                onClick={() => terminalSessionStore.setAppearance(value)}
              >
                <Icon size={14} aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-row">
          <div>
            <h3>布局模式</h3>
            <p>自动模式会在触屏且屏幕宽度不超过 1300px 时使用掌机布局。</p>
          </div>
          <div className="settings-segmented" role="group" aria-label="布局模式">
            {([
              ['auto', '自动'],
              ['handheld', '掌机'],
              ['desktop', '桌面'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={handheld.override === value}
                className={handheld.override === value ? 'is-active' : undefined}
                onClick={() => handheld.setOverride(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
