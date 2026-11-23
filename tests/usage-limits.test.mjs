import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-usage-limits-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(new URL('../src/lib/usage-limits.ts', import.meta.url), 'utf8');
const file = join(dir, 'usage-limits.mjs');
writeFileSync(file, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const lib = await import(pathToFileURL(file).href);

const now = Date.UTC(2025, 0, 1, 12, 0, 0);
const min = 60_000;
const limits = (primary, secondary = null, extra = {}) => ({ name: null, primary, secondary, planType: 'pro', reached: false, ...extra });

test('window lengths read as the names Codex uses', () => {
  assert.deepEqual([300, 10_080, 1_440, 4_320, 90, null, 0].map(lib.usageWindowLabel), ['5 小时', '每周', '每天', '3 天', '90 分钟', '额度', '额度']);
});

test('reset times count down in minutes, hours, then days, never showing zero', () => {
  assert.equal(lib.formatResetIn(null, now), null);
  assert.equal(lib.formatResetIn(now - 1, now), '即将重置');
  assert.equal(lib.formatResetIn(now + 10_000, now), '1 分钟后重置');
  assert.equal(lib.formatResetIn(now + 59 * min, now), '59 分钟后重置');
  assert.equal(lib.formatResetIn(now + 120 * min, now), '2 小时后重置');
  assert.equal(lib.formatResetIn(now + 135 * min, now), '2 小时 15 分后重置');
  assert.equal(lib.formatResetIn(now + (4 * 24 + 3) * 60 * min, now), '4 天 3 小时后重置');
  assert.equal(lib.formatResetIn(now + 2 * 24 * 60 * min, now), '2 天后重置');
});

test('the chip shows the main window and takes its colour from the fullest one', () => {
  const quiet = lib.summarizeUsage(limits({ usedPercent: 37.4, windowMinutes: 300, resetsAt: now + 135 * min }), now);
  assert.deepEqual(quiet, {
    text: '额度 37%', level: 'ok', planType: 'pro',
    windows: [{ label: '5 小时', percent: 37.4, level: 'ok', used: '已用 37%', reset: '2 小时 15 分后重置' }],
  });
  const weekly = lib.summarizeUsage(limits({ usedPercent: 20, windowMinutes: 300, resetsAt: null },
    { usedPercent: 92, windowMinutes: 10_080, resetsAt: now + 3 * 24 * 60 * min }), now);
  assert.equal(weekly.text, '每周额度 92%', 'a nearly spent weekly limit is not hidden');
  assert.equal(weekly.level, 'bad');
  const calmWeek = lib.summarizeUsage(limits({ usedPercent: 20, windowMinutes: 300, resetsAt: null },
    { usedPercent: 60, windowMinutes: 10_080, resetsAt: null }), now);
  assert.deepEqual([calmWeek.text, calmWeek.level], ['额度 20%', 'ok'], 'a fuller window below the warning stays in the popover');
  assert.deepEqual(weekly.windows.map((w) => [w.label, w.level]), [['5 小时', 'ok'], ['每周', 'bad']], 'each bar has its own colour');
  assert.equal(lib.summarizeUsage(limits({ usedPercent: 75, windowMinutes: 300, resetsAt: null }), now).level, 'warn');
});

test('a reached limit says so, and nothing is shown without data', () => {
  const reached = lib.summarizeUsage(limits({ usedPercent: 100, windowMinutes: 300, resetsAt: now + 30 * min }, null, { reached: true }), now);
  assert.deepEqual([reached.text, reached.level], ['额度已用尽', 'bad']);
  assert.deepEqual(lib.summarizeUsage(limits(null, null, { reached: true }), now).windows, []);
  assert.equal(lib.summarizeUsage(limits(null), now), null);
  assert.equal(lib.summarizeUsage(null, now), null);
});
