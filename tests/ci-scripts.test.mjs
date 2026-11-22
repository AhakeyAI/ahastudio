import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LONG_E2E_TESTS,
  parseRunnerArgs,
  resolveConcurrency,
  selectTestFiles,
} from '../scripts/run-tests.mjs';
import {
  isPrereleaseVersion,
  normalizeTag,
  resolveReleasePlan,
} from '../scripts/verify-release-version.mjs';
import { stageReleaseArtifacts } from '../scripts/stage-release-artifacts.mjs';
import ghTestReporter from '../scripts/gh-test-reporter.mjs';

test('run-tests splits fast suite from long real-Git E2E and applies Windows concurrency default', () => {
  const files = [
    'a.test.mjs',
    'orchestration-adversarial-review.test.mjs',
    'z.test.mjs',
  ];

  assert.equal(LONG_E2E_TESTS.has('orchestration-adversarial-review.test.mjs'), true);
  assert.deepEqual(selectTestFiles(files, 'fast'), ['a.test.mjs', 'z.test.mjs']);
  assert.deepEqual(selectTestFiles(files, 'e2e'), ['orchestration-adversarial-review.test.mjs']);
  assert.deepEqual(selectTestFiles(files, 'all'), files);

  assert.deepEqual(parseRunnerArgs(['--fast', '--concurrency=4', '--test-name-pattern=foo']), {
    mode: 'fast',
    concurrency: '4',
    extraNodeArgs: ['--test-name-pattern=foo'],
    explicitFiles: [],
  });

  assert.equal(
    resolveConcurrency({ explicitConcurrency: null, envConcurrency: undefined, platform: 'win32', fileCount: 10 }),
    2,
  );
  assert.equal(
    resolveConcurrency({ explicitConcurrency: null, envConcurrency: undefined, platform: 'linux', fileCount: 10 }),
    null,
  );
  assert.equal(
    resolveConcurrency({ explicitConcurrency: null, envConcurrency: '3', platform: 'linux', fileCount: 10 }),
    3,
  );
  assert.equal(
    resolveConcurrency({ explicitConcurrency: null, envConcurrency: undefined, platform: 'win32', fileCount: 1 }),
    null,
  );
  assert.throws(
    () => resolveConcurrency({ explicitConcurrency: '0', envConcurrency: undefined, platform: 'linux', fileCount: 2 }),
    /Invalid test concurrency/,
  );
});

test('verify-release-version enforces tag/package version parity and detects prereleases', () => {
  assert.equal(normalizeTag('refs/tags/v1.2.3'), 'v1.2.3');
  assert.equal(isPrereleaseVersion('1.2.3'), false);
  assert.equal(isPrereleaseVersion('1.2.3-beta.1'), true);
  assert.equal(isPrereleaseVersion('1.2.3+build.4'), false);

  assert.deepEqual(
    resolveReleasePlan({
      packageVersion: '0.2.0',
      eventName: 'push',
      githubRef: 'refs/tags/v0.2.0',
    }),
    {
      version: '0.2.0',
      tag: 'v0.2.0',
      isPrerelease: false,
      isDraft: false,
      shouldPublish: true,
    },
  );

  assert.deepEqual(
    resolveReleasePlan({
      packageVersion: '0.2.0-rc.1',
      eventName: 'push',
      githubRef: 'refs/tags/v0.2.0-rc.1',
    }),
    {
      version: '0.2.0-rc.1',
      tag: 'v0.2.0-rc.1',
      isPrerelease: true,
      isDraft: false,
      shouldPublish: true,
    },
  );

  assert.throws(
    () =>
      resolveReleasePlan({
        packageVersion: '0.1.0',
        eventName: 'push',
        githubRef: 'refs/tags/v0.2.0',
      }),
    /does not match package\.json version/,
  );

  assert.deepEqual(
    resolveReleasePlan({
      packageVersion: '0.1.0',
      eventName: 'workflow_dispatch',
      githubRef: 'refs/heads/main',
      inputPublish: false,
    }),
    {
      version: '0.1.0',
      tag: 'v0.1.0',
      isPrerelease: false,
      isDraft: true,
      shouldPublish: false,
    },
  );
});

test('stage-release-artifacts copies installers with spaces and ignores unpacked directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aha-stage-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const releaseDir = join(root, 'release');
  const outputDir = join(root, 'release-artifacts');
  mkdirSync(join(releaseDir, 'win-unpacked'), { recursive: true });
  writeFileSync(join(releaseDir, 'win-unpacked', 'AhaStation.exe'), 'unpacked');
  writeFileSync(join(releaseDir, 'builder-debug.yml'), 'debug: true\n');
  writeFileSync(join(releaseDir, 'AhaStation Local CLI Setup 0.1.0.exe'), 'installer-binary');
  writeFileSync(join(releaseDir, 'AhaStation Local CLI Setup 0.1.0.exe.blockmap'), 'blockmap-data');

  const staged = stageReleaseArtifacts({ releaseDir, outputDir });
  assert.deepEqual(
    staged.map((f) => f.name),
    [
      'AhaStation Local CLI Setup 0.1.0.exe',
      'AhaStation Local CLI Setup 0.1.0.exe.blockmap',
    ],
  );
  assert.equal(existsSync(join(outputDir, 'builder-debug.yml')), false);
  assert.equal(existsSync(join(outputDir, 'win-unpacked')), false);
  assert.equal(
    readFileSync(join(outputDir, 'AhaStation Local CLI Setup 0.1.0.exe'), 'utf8'),
    'installer-binary',
  );

  const emptyReleaseDir = join(root, 'empty-release');
  mkdirSync(emptyReleaseDir, { recursive: true });
  writeFileSync(join(emptyReleaseDir, 'builder-effective-config.yaml'), 'foo: bar\n');
  assert.throws(
    () => stageReleaseArtifacts({ releaseDir: emptyReleaseDir, outputDir }),
    /No distributable installer/,
  );
});

test('gh-test-reporter emits GitHub Actions annotations for leaf failures and skips aggregate wrappers', async () => {
  async function* events() {
    yield { type: 'test:pass', data: { name: 'ok' } };
    yield {
      type: 'test:fail',
      data: {
        name: 'parent suite',
        file: join(process.cwd(), 'tests', 'example.test.mjs'),
        line: 1,
        details: { error: { failureType: 'subtestsFailed', message: '1 subtest failed' } },
      },
    };
    yield {
      type: 'test:fail',
      data: {
        name: 'checks a, b: c',
        file: join(process.cwd(), 'tests', 'example.test.mjs'),
        line: 42,
        details: { error: { code: 'ERR_TEST_FAILURE', message: 'boom\nline2' } },
      },
    };
  }

  const lines = [];
  for await (const chunk of ghTestReporter(events())) {
    lines.push(chunk);
  }
  assert.deepEqual(lines, [
    '::error file=tests/example.test.mjs,line=42,title=checks a%2C b%3A c::[ERR_TEST_FAILURE] boom%0Aline2\n',
  ]);
});
