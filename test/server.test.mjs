import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanionHandler } from '../src/server.mjs';

async function invoke(method, url, headers = {}) {
  const result = { headers: {}, status: 0, body: Buffer.alloc(0) };
  const response = {
    setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
    writeHead(status, outgoing = {}) {
      result.status = status;
      for (const [name, value] of Object.entries(outgoing)) result.headers[name.toLowerCase()] = value;
    },
    end(body = '') { result.body = Buffer.from(body); },
  };
  await createCompanionHandler()({ method, url, headers }, response);
  return {
    ...result,
    json: () => JSON.parse(result.body.toString('utf8')),
    text: () => result.body.toString('utf8'),
  };
}

test('serves health, embed, and anonymous session without secrets in responses', async () => {
  process.env.SESSION_SECRET = 's'.repeat(64);
  const health = await invoke('GET', '/companion/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true });

  const embed = await invoke('GET', '/companion/embed');
  assert.equal(embed.status, 200);
  assert.match(embed.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(embed.headers['content-security-policy'], /media-src blob:/);
  assert.match(embed.text(), /Web Companion/);

  const importer = await invoke('GET', '/companion/shijima-import.js');
  assert.equal(importer.status, 200);
  assert.match(importer.text(), /convertShijimaArchive/);

  const manager = await invoke('GET', '/companion/manage');
  assert.match(manager.text(), /permission to publish every included image and sound/);

  const session = await invoke('GET', '/companion/api/session');
  assert.deepEqual(session.json(), { authenticated: false });
});

test('rejects unauthenticated publication', async () => {
  process.env.SESSION_SECRET = 's'.repeat(64);
  const response = await invoke('POST', '/companion/api/publish', { 'content-type': 'application/zip' });
  assert.equal(response.status, 401);
  assert.deepEqual(response.json(), { error: 'AUTH_REQUIRED' });
});
