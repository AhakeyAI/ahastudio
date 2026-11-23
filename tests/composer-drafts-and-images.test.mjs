import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-composer-drafts-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let emitted = 0;
const load = async (name) => {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const file = join(dir, `${name}-${emitted++}.mjs`);
  writeFileSync(file, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  return import(pathToFileURL(file).href);
};

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('a draft survives leaving the view, and its text survives a restart', async (t) => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  t.after(() => delete globalThis.localStorage);
  const { composerDrafts } = await load('composer-drafts');

  const image = { key: 'k', kind: 'image', name: 'a.png', previewUrl: 'blob:1', attachment: { type: 'localImage', path: '/a.png' } };
  composerDrafts.set('session-1', { text: 'half written', attachments: [image] });
  assert.deepEqual(composerDrafts.get('session-1'), { text: 'half written', attachments: [image] });
  assert.equal(storage.map.get('aha.composer-draft:session-1'), 'half written');

  // A fresh module stands in for a restarted app: only the text comes back.
  const restarted = await load('composer-drafts');
  assert.deepEqual(restarted.composerDrafts.get('session-1'), { text: 'half written', attachments: [] });
  assert.deepEqual(restarted.composerDrafts.get('session-2'), { text: '', attachments: [] });

  composerDrafts.set('session-1', { text: '', attachments: [] });
  assert.equal(storage.map.has('aha.composer-draft:session-1'), false, 'a sent or cleared draft leaves nothing behind');
});

test('only images longer than the max edge are scaled, keeping their aspect ratio', async () => {
  const { fitToMaxEdge, IMAGE_MAX_EDGE } = await load('image-compression');
  assert.equal(IMAGE_MAX_EDGE, 2000);
  assert.equal(fitToMaxEdge({ width: 1920, height: 1080 }), null);
  assert.equal(fitToMaxEdge({ width: 2000, height: 2000 }), null);
  assert.deepEqual(fitToMaxEdge({ width: 4000, height: 3000 }), { width: 2000, height: 1500 });
  assert.deepEqual(fitToMaxEdge({ width: 1170, height: 9000 }), { width: 260, height: 2000 });
  assert.deepEqual(fitToMaxEdge({ width: 3000, height: 1 }), { width: 2000, height: 1 }, 'a side never rounds to zero');
});

test('an image that cannot be re-encoded here is sent as is when small and refused when too large', async () => {
  const { prepareImageForAttachment } = await load('image-compression');
  // Node has no canvas, so this is the path a renderer without one takes; GIFs always take it.
  const small = new File([new Uint8Array(10)], 'a.gif', { type: 'image/gif' });
  assert.deepEqual(await prepareImageForAttachment(small, 100), { ok: true, file: small, recompressed: false });
  const big = new File([new Uint8Array(200)], 'b.png', { type: 'image/png' });
  assert.deepEqual(await prepareImageForAttachment(big, 100), { ok: false, reason: 'too-large' });
});
