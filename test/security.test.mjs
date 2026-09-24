import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfForSession, issueSignedValue, parseCookies, readSignedValue } from '../src/security.mjs';

test('signed sessions round-trip and reject tampering', () => {
  const secret = 'a'.repeat(64);
  const token = issueSignedValue({ login: 'widmonstertony', nonce: 'abc' }, secret, 60);
  assert.equal(readSignedValue(token, secret).login, 'widmonstertony');
  assert.equal(readSignedValue(`${token}x`, secret), null);
});

test('CSRF is stable for a session and cookies parse safely', () => {
  const session = { login: 'widmonstertony', nonce: 'abc' };
  assert.equal(csrfForSession(session, 'secret'), csrfForSession(session, 'secret'));
  assert.deepEqual(parseCookies('one=1; session=abc%201'), { one: '1', session: 'abc 1' });
});
