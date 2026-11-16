import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SettingsSection } from '../types';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { CliAgentSettingsPanel } from './CliAgentSettingsPanel';
import { TerminalSettingsPanel } from './TerminalSettingsPanel';
import { VoiceInputSettingsPanel } from './VoiceInputSettingsPanel';
import './settings-window.css';

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'appearance', label: '外观' },
  { id: 'terminal', label: '终端' },
  { id: 'voice-input', label: '语音输入' },
  { id: 'cli-agents', label: 'CLI 与 Agent' },
];

function initialSection(): SettingsSection {
  const focus = new URLSearchParams(window.location.search).get('focus');
  return SECTIONS.some((section) => section.id === focus) ? focus as SettingsSection : 'appearance';
}

export function SettingsWindow() {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);

  useEffect(() => window.vibeMeet.settingsWindow.onFocusSection(setActiveSection), []);

  return (
    <div className="settings-window">
      <header className="settings-window-header">
        <h1>设置</h1>
        <button type="button" className="settings-icon-button" onClick={() => void window.vibeMeet.settingsWindow.close()} aria-label="关闭设置">
          <X size={17} />
        </button>
      </header>
      <div className="settings-window-body">
        <nav className="settings-nav" aria-label="设置分区">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? 'is-active' : undefined}
              aria-current={activeSection === section.id ? 'page' : undefined}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <main className="settings-content">
          {activeSection === 'appearance' && <AppearanceSettingsPanel />}
          {activeSection === 'terminal' && <TerminalSettingsPanel />}
          {activeSection === 'voice-input' && <VoiceInputSettingsPanel />}
          {activeSection === 'cli-agents' && <CliAgentSettingsPanel />}
        </main>
      </div>
    </div>
  );
}
