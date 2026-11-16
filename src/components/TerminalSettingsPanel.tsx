import { useSyncExternalStore } from 'react';
import { terminalSessionStore } from '../lib/terminal-session-store';

export function TerminalSettingsPanel() {
  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const fontSize = terminalSessionStore.getFontSize();
  const appearance = terminalSessionStore.getAppearance();

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <h2>终端</h2>
        <p>调整所有本地 CLI 和 Shell 终端的显示效果。</p>
      </div>

      <section className="settings-card">
        <label className="settings-row" htmlFor="terminal-font-size">
          <div>
            <h3>终端字号</h3>
            <p>立即应用到已打开的终端，底部快捷控制与此设置保持同步。</p>
          </div>
          <select
            id="terminal-font-size"
            className="settings-select"
            value={fontSize}
            onChange={(event) => terminalSessionStore.setFontSize(Number(event.target.value))}
          >
            {Array.from({ length: 15 }, (_, index) => index + 10).map((size) => (
              <option key={size} value={size}>{size}px</option>
            ))}
          </select>
        </label>
        <div className={`settings-terminal-preview is-${appearance}`} style={{ fontSize }}>
          <div><span className="is-green">➜</span> workspace <span className="is-blue">git:(master)</span></div>
          <div>$ qodercli</div>
          <div className="is-muted">AhaStation Local CLI ready.</div>
        </div>
      </section>
    </div>
  );
}
