#!/usr/bin/env node
// Validates release tag and package.json version alignment and emits release metadata
// (optionally to GITHUB_OUTPUT for GitHub Actions).

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function normalizeTag(rawRefOrTag) {
  if (!rawRefOrTag) return '';
  return String(rawRefOrTag).trim().replace(/^refs\/tags\//, '');
}

export function isPrereleaseVersion(version) {
  const withoutBuild = String(version).split('+')[0];
  return withoutBuild.includes('-');
}

export function resolveReleasePlan({
  packageVersion,
  eventName,
  githubRef,
  inputPublish = false,
  inputTagName = '',
  inputPrerelease = false,
  inputDraft = true,
}) {
  if (!packageVersion || !SEMVER_RE.test(packageVersion)) {
    throw new Error(`Invalid package.json version: "${packageVersion ?? ''}"`);
  }

  const expectedTag = `v${packageVersion}`;
  const refTag = githubRef?.startsWith('refs/tags/') ? normalizeTag(githubRef) : '';

  if (refTag) {
    if (refTag !== expectedTag) {
      throw new Error(
        `Release tag "${refTag}" does not match package.json version "${packageVersion}" (expected "${expectedTag}"). ` +
          `Update package.json before tagging.`,
      );
    }
    return {
      version: packageVersion,
      tag: refTag,
      isPrerelease: isPrereleaseVersion(packageVersion),
      isDraft: false,
      shouldPublish: true,
    };
  }

  const shouldPublish = eventName === 'workflow_dispatch' && Boolean(inputPublish);
  const manualTag = normalizeTag(inputTagName) || expectedTag;
  if (shouldPublish && manualTag !== expectedTag) {
    throw new Error(
      `Manual release tag "${manualTag}" does not match package.json version "${packageVersion}" (expected "${expectedTag}").`,
    );
  }

  return {
    version: packageVersion,
    tag: manualTag,
    isPrerelease: Boolean(inputPrerelease) || isPrereleaseVersion(packageVersion),
    isDraft: Boolean(inputDraft),
    shouldPublish,
  };
}

function parseBool(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  const plan = resolveReleasePlan({
    packageVersion: pkg.version,
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    githubRef: process.env.GITHUB_REF ?? '',
    inputPublish: parseBool(process.env.RELEASE_INPUT_PUBLISH),
    inputTagName: process.env.RELEASE_INPUT_TAG_NAME ?? '',
    inputPrerelease: parseBool(process.env.RELEASE_INPUT_PRERELEASE),
    inputDraft: process.env.RELEASE_INPUT_DRAFT === undefined ? true : parseBool(process.env.RELEASE_INPUT_DRAFT),
  });

  const outputs = {
    version: plan.version,
    tag: plan.tag,
    is_prerelease: String(plan.isPrerelease),
    is_draft: String(plan.isDraft),
    should_publish: String(plan.shouldPublish),
  };

  if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    appendFileSync(process.env.GITHUB_OUTPUT, lines, 'utf8');
  }

  console.log(`[release-version] ${JSON.stringify(outputs)}`);
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[release-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
