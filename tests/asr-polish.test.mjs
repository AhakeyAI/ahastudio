import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { polishAsrText } from '../dist-electron/asr-polish.js';
import { updateSettings } from '../dist-electron/store.js';

test('voice polish uses its dedicated settings and returns the polished response', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: '整理后的文本' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  updateSettings({
    voicePolishEnabled: true,
    voicePolishApiKey: 'local-test-key',
    voicePolishBaseUrl: `http://127.0.0.1:${address.port}`,
    voicePolishModel: 'local-test-model',
  });

  const result = await polishAsrText('嗯 今天 测试');
  assert.equal(result, '整理后的文本');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/messages');
  assert.equal(requests[0].body.model, 'local-test-model');
  assert.equal(requests[0].body.messages[0].content, '嗯 今天 测试');
});
