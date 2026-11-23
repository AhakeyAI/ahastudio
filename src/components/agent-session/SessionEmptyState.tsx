import { memo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { AgentSessionPolicy } from '../../types';

const EXAMPLES = [
  '说说这个项目的结构、入口和主要模块',
  '看看最近一次提交，找出可能有问题的地方',
  '给改动最多的模块补上单元测试',
];

const POLICY_NOTES: Record<AgentSessionPolicy, string> = {
  'read-only': '当前为只读：Codex 只阅读代码、运行不改文件的命令。',
  'workspace-write': 'Codex 可以在这个文件夹里读代码、跑命令、改文件；要越出文件夹时会先问你。',
  'full-auto': '自动模式：Codex 不会停下来询问，但仍只能在这个文件夹的沙盒里动手。',
};

/** First screen of a new direct session; an example only fills the composer, it never sends. */
export const SessionEmptyState = memo(function SessionEmptyState({ folder, policy, onPick }: {
  folder: string | null;
  policy: AgentSessionPolicy | undefined;
  onPick: (text: string) => void;
}) {
  return (
    <div className="asv-start">
      <h2 className="asv-start-title">{folder ? <>要在 <span className="asv-start-folder">{folder}</span> 里做点什么？</> : '要做点什么？'}</h2>
      {policy && <p className="asv-start-note">{POLICY_NOTES[policy]}</p>}
      <div className="asv-start-examples" aria-label="示例">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="asv-start-example" title="填入输入框，不会自动发送" onClick={() => onPick(example)}>
            <span>{example}</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
});
