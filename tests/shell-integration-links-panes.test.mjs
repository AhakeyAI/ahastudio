import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ipcMain, shell } from 'electron';

import { applyShellIntegration } from '../dist-electron/shell-integration/index.js';
import { classifyLinkedFile } from '../dist-electron/ipc/launchable-file-type.js';
import { registerShellPtyIpc, resolveTerminalLinkPath, workspaceStateSetSchema } from '../dist-electron/ipc/shell-pty.js';
import { getPtyHost } from '../dist-electron/pty-host.js';

function decodeUtf16LeBase64(b64) {
  return Buffer.from(b64, 'base64').toString('utf16le');
}

// Transpile pure renderer TS files into flat temp .mjs files so shared graphs never nest base64 or loop.
const compiledCache = new Map();
const testModDir = mkdtempSync(join(tmpdir(), 'aha-phase2-tsmods-'));
let nextModSeq = 1;
test.after(() => {
  rmSync(testModDir, { recursive: true, force: true });
});

async function loadRendererTsModule(absPath, customOverrides = {}) {
  const normalized = resolve(absPath);
  if (compiledCache.has(normalized)) return compiledCache.get(normalized);

  const outFile = join(testModDir, `m${nextModSeq++}.mjs`);
  const outUrl = pathToFileURL(outFile).href;
  compiledCache.set(normalized, outUrl);

  const source = await readFile(normalized, 'utf8');
  let js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  const dir = dirname(normalized);
  const relImportRe = /(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g;
  const specs = [...new Set([...js.matchAll(relImportRe)].map((m) => m[3]))];
  const resolvedMap = new Map();

  for (const spec of specs) {
    if (spec in customOverrides) {
      resolvedMap.set(spec, customOverrides[spec]);
    } else {
      const candidate = resolve(dir, spec.endsWith('.ts') ? spec : `${spec}.ts`);
      resolvedMap.set(spec, await loadRendererTsModule(candidate, customOverrides));
    }
  }

  js = js.replace(relImportRe, (_, prefix, quote, spec) => `${prefix}${quote}${resolvedMap.get(spec)}${quote}`);
  writeFileSync(outFile, js, 'utf8');
  return outUrl;
}

const rootDir = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
const paneTree = await import(await loadRendererTsModule(join(rootDir, 'src/lib/terminal-pane-tree.ts')));
const oscTrackerMod = await import(await loadRendererTsModule(join(rootDir, 'src/lib/terminal-osc-tracker.ts')));
const httpUrlExtract = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/shared/terminal/links/terminal-http-url-extraction.ts'))
);
const terminalLinksMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/shared/terminal/links/terminal-links.ts'))
);
const hitTestingMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/shared/terminal/links/terminal-link-buffer-hit-testing.ts'))
);
const oscLinkTargetMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/shared/terminal/links/terminal-osc-link-target.ts'))
);
const linkSafetyMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/terminal-links/terminal-link-safety.ts'))
);
const searchOptsMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/terminal-search-options.ts'))
);
const safeFindMod = await import(
  await loadRendererTsModule(join(rootDir, 'src/lib/terminal-search-safe-find.ts'))
);

function createFakeBuffer(rowsSpec) {
  const lines = rowsSpec.map(([text, isWrapped]) => ({
    isWrapped,
    length: text.length,
    translateToString(trimRight = false, start = 0, end = text.length) {
      const slice = text.slice(start, end);
      return trimRight ? slice.replace(/\s+$/, '') : slice;
    },
  }));
  return {
    length: lines.length,
    getLine: (index) => lines[index] ?? null,
  };
}

test('shell integration wraps pwsh/bash/zsh interactively without altering AI CLI launches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-shell-integ-test-'));
  try {
    const pwsh = applyShellIntegration({
      file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: [],
      env: { PATH: 'C:\\Windows' },
      wrapperBaseDir: dir,
    });
    assert.equal(pwsh.integrated, true);
    assert.deepEqual(pwsh.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
    const decoded = decodeUtf16LeBase64(pwsh.args[3]);
    assert.match(decoded, /FullLanguage/);
    assert.match(decoded, /133;D;\$exitCode/);
    assert.match(decoded, /\]7;\$uri/);
    assert.match(decoded, /133;C/);

    const gitBash = applyShellIntegration({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      env: {},
      wrapperBaseDir: dir,
    });
    assert.equal(gitBash.integrated, true);
    assert.equal(gitBash.args[0], '--rcfile');
    assert.equal(gitBash.args[2], '-i');

    const zsh = applyShellIntegration({
      file: '/bin/zsh',
      args: [],
      env: { ZDOTDIR: '/home/tester/.zsh' },
      wrapperBaseDir: dir,
    });
    assert.equal(zsh.integrated, true);
    assert.equal(zsh.env.AHA_ORIG_ZDOTDIR, '/home/tester/.zsh');
    assert.ok(zsh.env.ZDOTDIR.endsWith('zsh'));

    // Explicit AI CLI launches and -c scripts must never be altered.
    for (const cliId of ['claude', 'codex', 'antigravity', 'grok']) {
      const untouched = applyShellIntegration({
        file: 'pwsh.exe',
        args: ['--flag'],
        env: { FOO: '1' },
        cliId,
        wrapperBaseDir: dir,
      });
      assert.equal(untouched.integrated, false);
      assert.deepEqual(untouched.args, ['--flag']);
    }

    const scripted = applyShellIntegration({
      file: 'bash',
      args: ['-c', 'echo hi'],
      env: {},
      wrapperBaseDir: dir,
    });
    assert.equal(scripted.integrated, false);
    assert.deepEqual(scripted.args, ['-c', 'echo hi']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell integration without a private wrapper dir never falls back to the temp dir on Windows', () => {
  const result = applyShellIntegration({
    file: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: ['--login', '-i'],
    env: {},
  });
  if (process.platform === 'win32') {
    assert.equal(result.integrated, false);
    assert.deepEqual(result.args, ['--login', '-i']);
  }
});

test('terminal-osc-tracker decodes split OSC 7 URIs and OSC 133 C/D command durations', () => {
  let clock = 1000;
  const tracker = oscTrackerMod.createTerminalOscTracker({
    isWindows: true,
    now: () => clock,
  });

  // Split OSC 7 across chunks with percent-encoded spaces.
  tracker.feed('\x1b]7;file:///C:/Users/Dev%20Team');
  assert.equal(tracker.getState().cwd, undefined);
  tracker.feed('/repo/\x07');
  assert.equal(tracker.getState().cwd, 'C:\\Users\\Dev Team\\repo');

  // MSYS Git Bash path normalization on Windows.
  tracker.feed('\x1b]7;file:///d/projects/aha\x1b\\');
  assert.equal(tracker.getState().cwd, 'D:\\projects\\aha');

  // Split OSC 133 command start/end timing + OMP adjacent BC D;0 suppression.
  tracker.feed('\x1b]133;C\x07ls');
  assert.equal(tracker.getState().commandRunning, true);
  clock = 2450;
  tracker.feed('\x1b]133;D');
  assert.equal(tracker.getState().commandRunning, true);
  tracker.feed(';2\x07');
  assert.equal(tracker.getState().commandRunning, false);
  assert.equal(tracker.getState().lastExitCode, 2);
  assert.equal(tracker.getState().lastDurationMs, 1450);

  // Adjacent B C D;0 (OMP prompt closure without user command) preserves prior exit code 2.
  tracker.feed('\x1b]133;A\x07prompt\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07');
  assert.equal(tracker.getState().lastExitCode, 2);
});

test('wrapped HTTP links and local file links parse accurately and validate safely', () => {
  const cols = 40;
  const buffer = createFakeBuffer([
    ['See https://example.com/very/long/path/', false],
    ['segment?a=1&b=2#sec done.', true],
  ]);
  const hit = hitTestingMod.findTerminalHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, cols);
  assert.equal(hit, 'https://example.com/very/long/path/segment?a=1&b=2#sec');

  // Hard-wrapped 80-col URL continuation.
  const hardWrap = createFakeBuffer([
    ['https://docs.python.org/3/library/stdtypes', false],
    ['.html#str.split', false],
  ]);
  const hitHard = hitTestingMod.findTerminalHttpLinkAtBufferPosition(hardWrap, { x: 5, y: 2 }, 42);
  assert.equal(hitHard, 'https://docs.python.org/3/library/stdtypes.html#str.split');

  assert.deepEqual(
    httpUrlExtract.extractTerminalHttpLinks('Check (https://openai.com/api?v=1), ok?').map((l) => l.url),
    ['https://openai.com/api?v=1'],
  );

  const fileReadings = terminalLinksMod.extractTerminalFileLinkReadings(
    'Error at src/lib/terminal-pane-tree.ts:42:5 and C:\\work\\notes.md:7.'
  );
  assert.equal(fileReadings.links[0].pathText, 'src/lib/terminal-pane-tree.ts');
  assert.equal(fileReadings.links[0].line, 42);
  assert.equal(fileReadings.links[0].column, 5);
  assert.equal(fileReadings.links[1].pathText, 'C:\\work\\notes.md');
  assert.equal(fileReadings.links[1].line, 7);

  // Reject unsafe scripts like javascript:; allow https/file/local paths.
  assert.equal(
    oscLinkTargetMod.classifyTerminalOscLinkTarget('javascript:alert(1)', { windowsPathsFirst: false, allowUncHost: false }),
    null
  );
  assert.equal(
    oscLinkTargetMod.classifyTerminalOscLinkTarget('https://github.com/test', { windowsPathsFirst: false, allowUncHost: false })?.kind,
    'url'
  );

  // Reject UNC paths, Windows device namespaces (\\?\ / \\.\ / \??\), and non-localhost file:// URIs everywhere.
  const unsafeTargets = [
    '\\\\attacker.example\\share\\a.txt',
    '//attacker.example/share/a.txt',
    '/\\attacker.example\\share\\a.txt',
    '\\\\?\\UNC\\attacker.example\\share\\a.txt',
    '\\\\?\\C:\\Windows\\win.ini',
    '\\\\.\\pipe\\aha-test',
    '\\??\\C:\\Windows\\win.ini',
    'file://attacker.example/share/a.txt',
    'file://127.0.0.1/c$/Windows/win.ini',
    'file://localhost//attacker.example/share/a.txt',
    'file:///%5C%5Cattacker.example%5Cshare%5Ca.txt',
  ];
  for (const unsafe of unsafeTargets) {
    assert.equal(resolveTerminalLinkPath(unsafe, 'C:\\Users\\JHJ'), null, `resolveTerminalLinkPath must reject ${unsafe}`);
    assert.equal(linkSafetyMod.isSafeTerminalLinkCandidate(unsafe, 'C:\\Users\\JHJ', true), false, `renderer filter must reject ${unsafe}`);
    assert.equal(linkSafetyMod.resolveSafeOscLinkTarget(unsafe, 'C:\\Users\\JHJ', true), null, `OSC 8 guard must reject ${unsafe}`);
  }
  assert.equal(resolveTerminalLinkPath('README.md', '\\\\attacker.example\\share'), null);
  assert.equal(linkSafetyMod.isSafeTerminalLinkCandidate('README.md', '\\\\attacker.example\\share', true), false);

  // Extracting candidates from terminal output containing UNC + local file must strip UNC before checkPaths.
  const mixedReadings = terminalLinksMod.extractTerminalFileLinkReadings(
    'remote \\\\attacker.example\\share\\a.txt vs local src/lib/terminal-pane-tree.ts:42'
  );
  const safeExtracted = [...mixedReadings.links, ...mixedReadings.guesses]
    .filter((item) => linkSafetyMod.isSafeTerminalLinkCandidate(item.pathText, 'C:\\repo', true))
    .map((item) => item.pathText);
  assert.deepEqual(safeExtracted, ['src/lib/terminal-pane-tree.ts']);

  // Spoofed UNC OSC 7 URI must never set cwd.
  const spoofTracker = oscTrackerMod.createTerminalOscTracker({ isWindows: true });
  spoofTracker.feed('\x1b]7;file:///\\\\attacker.example/share\x07');
  assert.equal(spoofTracker.getState().cwd, undefined);

  // Path link resolution and allowlist-based launchable file security classification.
  assert.equal(
    classifyLinkedFile(
      { names: ['C:\\tmp\\evil.exe'], isFile: true, isDirectory: false, mode: 0o644, head: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) },
      'win32',
      '.COM;.EXE;.BAT'
    ),
    'reveal'
  );
  assert.equal(
    classifyLinkedFile(
      { names: ['C:\\tmp\\evil.bat'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('@echo off') },
      'win32',
      '.COM;.EXE;.BAT'
    ),
    'view-as-text'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\script.ps1'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('Write-Host hi') }, 'win32', '.BAT;.PS1'),
    'view-as-text'
  );
  for (const riskyName of [
    'C:\\tmp\\remote.rdp',
    'C:\\tmp\\app.jnlp',
    'C:\\tmp\\pkg.appinstaller',
    'C:\\tmp\\addin.vsto',
    'C:\\tmp\\query.iqy',
    'C:\\tmp\\access.ade',
    'C:\\tmp\\macro.docm',
    'C:\\tmp\\sheet.xlsm',
    'C:\\tmp\\macro.ahk',
    'C:\\tmp\\page.html',
    'C:\\tmp\\image.svg',
    'C:\\tmp\\unknown.xyz',
  ]) {
    assert.notEqual(
      classifyLinkedFile({ names: [riskyName], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('data') }, 'win32', '.EXE;.BAT'),
      'open',
      `${riskyName} must never be handed to shell.openPath`
    );
  }
  // Safe allowlisted formats open cleanly unless disguised with binary/executable bytes or unsafe symlinks.
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\notes.md'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('# readme') }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\data.json'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('{"ok":true}') }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\report.pdf'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('%PDF-1.7') }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\fake.pdf'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('just some text') }, 'win32', '.EXE;.BAT'),
    'reveal'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\offset.pdf'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.concat([Buffer.from('\r\n  '), Buffer.from('%PDF-1.4')]) }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\late.pdf'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1.4')]) }, 'win32', '.EXE;.BAT'),
    'reveal'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\shot.png'], isFile: true, isDirectory: false, mode: 0o644, head: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\disguised.png'], isFile: true, isDirectory: false, mode: 0o644, head: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) }, 'win32', '.EXE;.BAT'),
    'reveal'
  );
  assert.notEqual(
    classifyLinkedFile({ names: ['C:\\tmp\\safe.md', 'C:\\tmp\\target.rdp'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('safe') }, 'win32', '.EXE;.BAT'),
    'open'
  );
  assert.equal(
    classifyLinkedFile({ names: ['C:\\tmp\\safe.md', 'C:\\tmp\\target.xyz'], isFile: true, isDirectory: false, mode: 0o644, head: Buffer.from('safe') }, 'win32', '.EXE;.BAT'),
    'reveal'
  );
  if (process.platform === 'win32') {
    assert.equal(resolveTerminalLinkPath('CON', 'C:\\Users\\JHJ'), null);
    assert.equal(resolveTerminalLinkPath('notes.md:evil.exe', 'C:\\Users\\JHJ'), null);
    assert.equal(resolveTerminalLinkPath('src/app.ts', 'C:\\Users\\JHJ'), 'C:\\Users\\JHJ\\src\\app.ts');
    assert.equal(resolveTerminalLinkPath('file:///C:/Users/JHJ/notes.md'), 'C:\\Users\\JHJ\\notes.md');
    assert.equal(resolveTerminalLinkPath('file://localhost/C:/Users/JHJ/notes.md'), 'C:\\Users\\JHJ\\notes.md');
  }
});

test('IPC check-paths and open-link enforce UNC blocklist, safe-open allowlist, and userData shell-integration', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'aha-phase2-ipc-link-'));
  const userData = mkdtempSync(join(tmpdir(), 'aha-phase2-userdata-'));
  try {
    const safeTxt = join(workDir, 'notes.txt');
    const riskyRdp = join(workDir, 'server.rdp');
    writeFileSync(safeTxt, 'hello\n', 'utf8');
    writeFileSync(riskyRdp, 'full address:s:attacker.example\n', 'utf8');

    const handlers = new Map();
    t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
    const openedPaths = [];
    const revealedPaths = [];
    t.mock.method(shell, 'openPath', async (p) => { openedPaths.push(p); return ''; });
    t.mock.method(shell, 'showItemInFolder', (p) => { revealedPaths.push(p); });

    const host = getPtyHost();
    let capturedOpts = null;
    t.mock.method(host, 'spawn', (_id, opts) => { capturedOpts = opts; return 456; });
    t.mock.method(host, 'onData', () => () => {});
    t.mock.method(host, 'onExit', () => () => {});
    t.mock.method(host, 'replayBuffer', () => Buffer.alloc(0));
    t.mock.method(host, 'kill', () => true);

    const contents = Object.assign(new EventEmitter(), { id: 19, send() {} });
    registerShellPtyIpc({
      liveWindow: () => ({ webContents: contents }),
      getCurrentCwd: () => workDir,
      userDataDir: () => userData,
    });
    const call = (name, payload) => handlers.get(`shell-pty:${name}`)({ sender: { id: 19 } }, payload);

    // check-paths skips UNC/device/remote file:// without touching the filesystem and returns only local notes.txt.
    const checked = await call('check-paths', {
      cwd: workDir,
      paths: [
        '\\\\attacker.example\\share\\a.txt',
        '\\\\.\\pipe\\aha-test',
        'file://attacker.example/share/a.txt',
        'notes.txt',
      ],
    });
    assert.equal(checked.ok, true);
    assert.deepEqual(Object.keys(checked.existing), ['notes.txt']);

    // open-link refuses UNC target, reveals .rdp in folder, and opens allowlisted .txt.
    const uncOpen = await call('open-link', { target: '\\\\attacker.example\\share\\a.txt', cwd: workDir });
    assert.equal(uncOpen.ok, false);
    const rdpOpen = await call('open-link', { target: riskyRdp, cwd: workDir });
    assert.deepEqual(rdpOpen, { ok: true, action: 'revealed', path: riskyRdp });
    assert.deepEqual(revealedPaths, [riskyRdp]);
    assert.deepEqual(openedPaths, []);

    const txtOpen = await call('open-link', { target: safeTxt, cwd: workDir });
    assert.deepEqual(txtOpen, { ok: true, action: 'opened', path: safeTxt });
    assert.deepEqual(openedPaths, [safeTxt]);

    // Verify userDataDir-backed shell integration writes bash wrapper under userDataDir (never shared /tmp).
    const shellList = await call('list-shells', {});
    const bashEntry = shellList.shells?.find((s) => s.id === 'git-bash' || /bash(\.exe)?$/i.test(s.binaryPath));
    if (bashEntry) {
      const bashShell = await call('create', { terminalId: 'bash-udata', cwd: workDir, shellId: bashEntry.id });
      assert.equal(bashShell.ok, true);
      assert.equal(capturedOpts?.args?.[0], '--rcfile');
      assert.ok(
        capturedOpts.args[1].startsWith(join(userData, 'shell-integration')),
        `expected rcfile inside userDataDir, got ${capturedOpts.args[1]}`,
      );
      assert.ok(existsSync(capturedOpts.args[1]));
    }
    contents.emit('destroyed');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});

test('terminal search helpers guard invalid regex and prefill single-line selections only', () => {
  let cleared = 0;
  let called = 0;
  const fakeAddon = {
    clearDecorations() { cleared += 1; },
    findNext() { called += 1; return true; },
    findPrevious() { called += 1; return true; },
  };
  const badRegex = safeFindMod.safeFindMatch(fakeAddon, 'next', '[unclosed', {
    regex: true,
    caseSensitive: false,
  });
  assert.equal(badRegex.found, false);
  assert.ok(badRegex.regexError);
  assert.equal(called, 0);
  assert.equal(cleared, 1);

  const okSearch = safeFindMod.safeFindMatch(
    fakeAddon,
    'next',
    'error',
    searchOptsMod.buildTerminalSearchOptions({ caseSensitive: true, regex: false, isDark: true })
  );
  assert.equal(okSearch.found, true);
  assert.equal(okSearch.regexError, null);
  assert.equal(called, 1);

  assert.equal(searchOptsMod.extractTerminalSearchSeed('  hello world  '), 'hello world');
  assert.equal(searchOptsMod.extractTerminalSearchSeed('line1\nline2'), '');

  // Windows/Linux use Ctrl+Shift+F so Ctrl+F reaches readline/vim/less; macOS keeps Cmd+F.
  assert.equal(
    searchOptsMod.isTerminalSearchShortcut({ key: 'f', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, false),
    false,
  );
  assert.equal(
    searchOptsMod.isTerminalSearchShortcut({ key: 'F', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false),
    true,
  );
  assert.equal(
    searchOptsMod.isTerminalSearchShortcut({ key: 'f', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }, true),
    true,
  );
  assert.equal(
    searchOptsMod.isTerminalSearchShortcut({ key: 'f', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, true),
    false,
  );
  assert.equal(searchOptsMod.getTerminalSearchShortcutLabel(false), 'Ctrl+Shift+F');
  assert.equal(searchOptsMod.getTerminalSearchShortcutLabel(true), 'Cmd+F');

  // Close confirmation is required only while a foreground command is running in an active pane.
  assert.equal(searchOptsMod.shouldConfirmPaneClose({ commandRunning: true, phase: 'running' }), true);
  assert.equal(searchOptsMod.shouldConfirmPaneClose({ commandRunning: false, phase: 'running' }), false);
  assert.equal(searchOptsMod.shouldConfirmPaneClose({ commandRunning: true, phase: 'exited' }), false);
});

test('terminal-pane-tree supports splits, ratio clamping, equalizing, closing, and neighbor focus', () => {
  let tree = { type: 'leaf', id: 'a' };
  const s1 = paneTree.splitLeafInLayout(tree, 'a', 'b', 'horizontal', 0.6);
  assert.equal(s1.inserted, true);
  tree = s1.layout;
  const s2 = paneTree.splitLeafInLayout(tree, 'b', 'c', 'vertical', 0.5);
  assert.equal(s2.inserted, true);
  tree = s2.layout;

  assert.deepEqual(paneTree.collectLayoutLeafIdsInOrder(tree), ['a', 'b', 'c']);
  assert.equal(paneTree.findNeighborLeafId(tree, 'a', 'right'), 'b');
  assert.equal(paneTree.findNeighborLeafId(tree, 'b', 'down'), 'c');
  assert.equal(paneTree.findNeighborLeafId(tree, 'c', 'up'), 'b');
  assert.equal(paneTree.findNeighborLeafId(tree, 'c', 'left'), 'a');
  assert.equal(paneTree.findNeighborLeafId(tree, 'a', 'prev'), 'c');
  assert.equal(paneTree.findNeighborLeafId(tree, 'c', 'next'), 'a');

  tree = paneTree.setSplitRatioAtPath(tree, [], 0.99);
  assert.equal(tree.ratio, paneTree.MAX_SPLIT_RATIO);
  tree = paneTree.setSplitRatioAtPath(tree, ['second'], Number.NaN);
  assert.equal(tree.second.ratio, paneTree.DEFAULT_SPLIT_RATIO);

  tree = paneTree.equalizePaneTree(tree);
  assert.equal(tree.ratio, 0.5);
  assert.equal(tree.second.ratio, 0.5);

  const removed = paneTree.removeLeafFromLayout(tree, 'b');
  assert.equal(removed.removed, true);
  assert.equal(removed.fallbackFocusId, 'c');
  assert.deepEqual(paneTree.collectLayoutLeafIdsInOrder(removed.layout), ['a', 'c']);
});

test('workspaceStateSetSchema validates both Phase 1 flat windows and Phase 2 split trees', () => {
  const validPhase2 = workspaceStateSetSchema.safeParse({
    version: 1,
    activeWindowId: 'win-1',
    windows: [
      {
        id: 'win-1',
        type: 'terminal',
        title: '终端',
        localCliId: 'shell',
        shellId: 'pwsh',
        cwd: 'C:\\repo',
        activeLeafId: 'pane-2',
        splitTree: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', id: 'win-1' },
          second: { type: 'leaf', id: 'pane-2' },
        },
        panes: {
          'win-1': { id: 'win-1', cwd: 'C:\\repo', shellId: 'pwsh' },
          'pane-2': { id: 'pane-2', cwd: 'C:\\repo\\sub', shellId: 'pwsh' },
        },
      },
    ],
  });
  assert.equal(validPhase2.success, true);

  const invalidRatio = workspaceStateSetSchema.safeParse({
    version: 1,
    activeWindowId: 'win-1',
    windows: [
      {
        id: 'win-1',
        type: 'terminal',
        title: '终端',
        splitTree: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.02,
          first: { type: 'leaf', id: 'win-1' },
          second: { type: 'leaf', id: 'pane-2' },
        },
      },
    ],
  });
  assert.equal(invalidRatio.success, false);
});

test('StageWindowStore splitPane inherits live OSC 7 CWD and closePane closes only target pane', async () => {
  // Reuse the same DOM stub pattern as tests/terminal-session.test.mjs for isolated store verification.
  class FakeTerm {
    options = {};
    unicode = {};
    rows = 24;
    cols = 80;
    loadAddon() {}
    open() {}
    focus() {}
    blur() {}
    refresh() {}
    onData() { return { dispose() {} }; }
    onTitleChange() { return { dispose() {} }; }
    write() {}
    dispose() {}
  }
  globalThis.__phase2Test = {
    Terminal: FakeTerm,
    FitAddon: class { fit() {} },
    Unicode11Addon: class {},
  };
  globalThis.document = { createElement: () => ({ remove() {} }) };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.localStorage = { getItem: () => null, setItem() {} };

  const oscUrl = await loadRendererTsModule(join(rootDir, 'src/lib/terminal-osc-tracker.ts'));
  const paneTreeUrl = await loadRendererTsModule(join(rootDir, 'src/lib/terminal-pane-tree.ts'));
  const tsModUrl = ts.transpileModule(
    `const { Terminal, FitAddon, Unicode11Addon } = globalThis.__phase2Test;\n` +
      `import { createTerminalOscTracker } from ${JSON.stringify(oscUrl)};\n` +
      (await readFile(join(rootDir, 'src/lib/terminal-session.ts'), 'utf8')).replace(/^import .*;\r?\n/gm, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText;
  const sessionUrl = `data:text/javascript;base64,${Buffer.from(tsModUrl).toString('base64')}`;
  const appearanceUrl = await loadRendererTsModule(join(rootDir, 'src/lib/terminal-appearance.ts'));
  const storeSource = (await readFile(join(rootDir, 'src/lib/terminal-session-store.ts'), 'utf8'))
    .replace("'./terminal-session'", JSON.stringify(sessionUrl))
    .replace("'./terminal-appearance'", JSON.stringify(appearanceUrl));
  const storeUrl = `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(storeSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
  ).toString('base64')}`;

  const stageSource = (await readFile(join(rootDir, 'src/lib/stage-window-store.ts'), 'utf8'))
    .replace("import { browserStore } from './browser-store';", 'const browserStore = { setVisible: async () => {} };')
    .replace("'./terminal-session-store'", JSON.stringify(storeUrl))
    .replace("'./terminal-pane-tree'", JSON.stringify(paneTreeUrl));
  const stageUrl = `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(stageSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
  ).toString('base64')}`;

  const { terminalSessionStore } = await import(storeUrl);
  const { stageWindowStore } = await import(stageUrl);

  await stageWindowStore.createWindow('terminal', {
    localCliId: 'shell',
    shellId: 'pwsh',
    cwd: 'C:\\initial',
    title: 'PowerShell',
  });
  const win = stageWindowStore.getSnapshot().windows.at(-1);
  assert.ok(win);

  const dataListeners = new Set();
  const disposedIds = [];
  const sessionA = terminalSessionStore.acquire(win.id, {
    expectedPtyId: `local-${win.id}`,
    attach: async () => ({
      ok: true,
      ptyId: `local-${win.id}`,
      replay: Buffer.from('\x1b]7;file:///C:/live/subdir\x07').toString('base64'),
    }),
    input() {},
    resize() {},
    onData: (cb) => { dataListeners.add(cb); return () => dataListeners.delete(cb); },
    onExit: () => () => {},
    dispose: async (id) => { disposedIds.push(id); },
  });
  const fakeHost = { appendChild() {}, isConnected: true, clientWidth: 800, clientHeight: 600 };
  sessionA.mount(fakeHost);
  await sessionA.connection;

  // Splitting pane A must inherit its live OSC 7 cwd (`C:\live\subdir`) instead of stale `C:\initial`.
  const paneB = stageWindowStore.splitPane(win.id, win.id, 'horizontal');
  assert.ok(paneB);
  const afterSplit = stageWindowStore.getSnapshot().windows.find((w) => w.id === win.id);
  assert.equal(afterSplit.activeLeafId, paneB);
  assert.equal(afterSplit.panes[paneB].cwd, 'C:\\live\\subdir');

  const sessionB = terminalSessionStore.acquire(paneB, {
    expectedPtyId: `local-${paneB}`,
    attach: async () => ({ ok: true, ptyId: `local-${paneB}`, replay: '' }),
    input() {},
    resize() {},
    onData: () => () => {},
    onExit: () => () => {},
    dispose: async (id) => { disposedIds.push(id); },
  });
  sessionB.mount(fakeHost, { focus: true });
  await sessionB.connection;

  // Closing pane B leaves pane A untouched and falls back focus to pane A.
  await stageWindowStore.closePane(win.id, paneB);
  assert.deepEqual(disposedIds, [`local-${paneB}`]);
  const afterCloseB = stageWindowStore.getSnapshot().windows.find((w) => w.id === win.id);
  assert.equal(afterCloseB.activeLeafId, win.id);
  assert.deepEqual(stageWindowStore.getWindowLeafIds(win.id), [win.id]);

  // Split again, make close fail on pane C, and verify closePane fails closed without removing pane C.
  const paneC = stageWindowStore.splitPane(win.id, win.id, 'vertical');
  assert.ok(paneC);
  let failCloseC = true;
  const sessionC = terminalSessionStore.acquire(paneC, {
    expectedPtyId: `local-${paneC}`,
    attach: async () => ({ ok: true, ptyId: `local-${paneC}`, replay: '' }),
    input() {},
    resize() {},
    onData: () => () => {},
    onExit: () => () => {},
    dispose: async (id) => {
      if (failCloseC) throw new Error('busy pane');
      disposedIds.push(id);
    },
  });
  sessionC.mount(fakeHost, { focus: true });
  await sessionC.connection;

  await stageWindowStore.closePane(win.id, paneC);
  assert.deepEqual(stageWindowStore.getWindowLeafIds(win.id), [win.id, paneC]);
  assert.match(terminalSessionStore.getState(paneC).error, /关闭失败/);

  // Once dispose succeeds, closing the entire window terminates all remaining leaves cleanly.
  failCloseC = false;
  await stageWindowStore.closeWindow(win.id);
  assert.deepEqual(disposedIds, [`local-${paneB}`, `local-${win.id}`, `local-${paneC}`]);
  assert.equal(stageWindowStore.getSnapshot().windows.some((w) => w.id === win.id), false);
});

test('PowerShell shell integration emits native exit code 23 in OSC 133;D without clobbering on clean prompts', async (t) => {
  if (process.platform !== 'win32') return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const pwshBin = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  if (!existsSync(pwshBin)) return;

  const dir = mkdtempSync(join(tmpdir(), 'aha-ps-exit23-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const wrapped = applyShellIntegration({
    file: pwshBin,
    args: [],
    env: { ...process.env },
    wrapperBaseDir: dir,
  });
  const bootstrap = decodeUtf16LeBase64(wrapped.args[3]);
  const probeScript = [
    bootstrap,
    '$null = prompt',
    'cmd /c "exit /b 23"',
    '$afterNative = prompt',
    'Write-Output ("AFTER_NATIVE=" + $afterNative)',
  ].join('\r\n');
  const encoded = Buffer.from(probeScript, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    pwshBin,
    ['-NoLogo', '-NonInteractive', '-NoProfile', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 10_000 },
  );
  assert.ok(stdout.includes('\x1b]133;D;23\x07'), `Expected OSC 133;D;23 in output, got: ${JSON.stringify(stdout)}`);
});
