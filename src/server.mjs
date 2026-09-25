import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedUser, exchangeOAuthCode, GitHubPublisher } from './github.mjs';
import { PACK_LIMITS, PackValidationError, validateAndSanitizePack } from './pack.mjs';
import {
  csrfForSession, issueSignedValue, newOpaqueToken, parseCookies, readSignedValue, secureEqual,
} from './security.mjs';

const modulePath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const publicDirectory = join(root, 'public');
const vendorFile = join(root, 'node_modules/fflate/esm/browser.js');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4040);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? 'https://tonytan.me';
const adminLogin = (process.env.ADMIN_LOGIN ?? 'widmonstertony').toLowerCase();
const owner = process.env.GITHUB_OWNER ?? 'widmonstertony';
const repository = process.env.GITHUB_ASSET_REPOSITORY ?? 'Web-Companion-Assets';
const branch = process.env.GITHUB_ASSET_BRANCH ?? 'media';
const sessionCookie = 'tonytan_companion_session';
const stateCookie = 'tonytan_companion_oauth_state';
let cachedConfiguration;

const staticRoutes = new Map([
  ['/companion/embed', ['embed.html', 'text/html; charset=utf-8']],
  ['/companion/embed/', ['embed.html', 'text/html; charset=utf-8']],
  ['/companion/embed.js', ['embed.js', 'text/javascript; charset=utf-8']],
  ['/companion/companion.css', ['companion.css', 'text/css; charset=utf-8']],
  ['/companion/manage', ['manage.html', 'text/html; charset=utf-8']],
  ['/companion/manage/', ['manage.html', 'text/html; charset=utf-8']],
  ['/companion/manage.js', ['manage.js', 'text/javascript; charset=utf-8']],
  ['/companion/manage.css', ['manage.css', 'text/css; charset=utf-8']],
]);

async function optionalSecret(path, fallbackName) {
  if (path) return (await readFile(path, 'utf8')).trim();
  const direct = process.env[fallbackName];
  return direct?.trim() || '';
}

async function configuration() {
  if (cachedConfiguration) return cachedConfiguration;
  let sessionSecret = await optionalSecret(process.env.SESSION_SECRET_FILE, 'SESSION_SECRET');
  if (!sessionSecret && process.env.NODE_ENV !== 'production') sessionSecret = newOpaqueToken(48);
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('A strong session secret is required.');
  const clientSecret = await optionalSecret(process.env.GITHUB_APP_CLIENT_SECRET_FILE, 'GITHUB_APP_CLIENT_SECRET');
  const github = process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY_FILE
    ? new GitHubPublisher({
        appId: process.env.GITHUB_APP_ID,
        installationId: process.env.GITHUB_APP_INSTALLATION_ID,
        privateKeyFile: process.env.GITHUB_APP_PRIVATE_KEY_FILE,
        owner,
        repository,
        branch,
      })
    : null;
  cachedConfiguration = {
    sessionSecret,
    clientId: process.env.GITHUB_APP_CLIENT_ID ?? '',
    clientSecret,
    github,
  };
  return cachedConfiguration;
}

function cookie(name, value, { maxAge = 43_200, sameSite = 'Lax' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/companion; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function securityHeaders(pathname) {
  const embed = pathname.startsWith('/companion/embed') || pathname === '/companion/companion.css';
  const frameAncestors = process.env.NODE_ENV === 'production'
    ? "'self'"
    : "'self' http://127.0.0.1:5173 http://localhost:5173";
  return {
    'Content-Security-Policy': embed
      ? `default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self' https://raw.githubusercontent.com; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'none'`
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(embed ? {} : { 'X-Frame-Options': 'DENY' }),
  };
}

function send(response, status, body = '', headers = {}) {
  const payload = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  response.writeHead(status, {
    ...(typeof body === 'object' && !(body instanceof Uint8Array)
      ? { 'Content-Type': 'application/json; charset=utf-8' }
      : {}),
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function sessionFor(request, secret) {
  const value = parseCookies(request.headers.cookie)[sessionCookie];
  const session = readSignedValue(value, secret);
  return session?.login?.toLowerCase() === adminLogin ? session : null;
}

async function readRequestBytes(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error('Request too large');
      error.code = 'ARCHIVE_SIZE';
      throw error;
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function serveStatic(pathname, response) {
  if (pathname === '/companion/vendor/fflate.js') {
    const bytes = await readFile(vendorFile);
    send(response, 200, bytes, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return true;
  }
  const entry = staticRoutes.get(pathname);
  if (!entry) return false;
  const [filename, contentType] = entry;
  const bytes = await readFile(join(publicDirectory, filename));
  send(response, 200, bytes, {
    'Content-Type': contentType,
    'Cache-Control': extname(filename) === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  return true;
}

export function createCompanionHandler() {
  return async (request, response) => {
    const url = new URL(request.url, publicOrigin);
    const headers = securityHeaders(url.pathname);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);

    try {
      if (request.method === 'GET' && url.pathname === '/companion/healthz') {
        send(response, 200, { ok: true }, { 'Cache-Control': 'no-store' });
        return;
      }
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;

      const config = await configuration();
      if (request.method === 'GET' && url.pathname === '/companion/api/session') {
        const session = sessionFor(request, config.sessionSecret);
        send(response, 200, session
          ? { authenticated: true, login: session.login, csrfToken: csrfForSession(session, config.sessionSecret) }
          : { authenticated: false }, { 'Cache-Control': 'no-store' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/companion/auth/start') {
        if (!config.clientId || !config.clientSecret) {
          send(response, 503, { error: 'OAUTH_NOT_CONFIGURED' });
          return;
        }
        const state = newOpaqueToken();
        const signedState = issueSignedValue({ state }, config.sessionSecret, 600);
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.searchParams.set('client_id', config.clientId);
        authorize.searchParams.set('redirect_uri', `${publicOrigin}/companion/auth/callback`);
        authorize.searchParams.set('state', state);
        response.setHeader('Set-Cookie', cookie(stateCookie, signedState, { maxAge: 600, sameSite: 'Lax' }));
        send(response, 303, '', { Location: authorize.toString() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/companion/auth/callback') {
        const saved = readSignedValue(parseCookies(request.headers.cookie)[stateCookie], config.sessionSecret);
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (!saved?.state || !state || !secureEqual(saved.state, state) || !code) {
          send(response, 400, { error: 'INVALID_OAUTH_STATE' });
          return;
        }
        const accessToken = await exchangeOAuthCode({ clientId: config.clientId, clientSecret: config.clientSecret, code });
        const user = await authenticatedUser(accessToken);
        if (user.login?.toLowerCase() !== adminLogin) {
          send(response, 403, { error: 'NOT_AUTHORIZED' });
          return;
        }
        const signedSession = issueSignedValue({ login: user.login, nonce: newOpaqueToken() }, config.sessionSecret, 43_200);
        response.setHeader('Set-Cookie', [
          cookie(sessionCookie, signedSession),
          cookie(stateCookie, '', { maxAge: 0 }),
        ]);
        send(response, 303, '', { Location: '/companion/manage' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/companion/api/publish') {
        const session = sessionFor(request, config.sessionSecret);
        if (!session) {
          send(response, 401, { error: 'AUTH_REQUIRED' });
          return;
        }
        const expectedCsrf = csrfForSession(session, config.sessionSecret);
        if (!secureEqual(request.headers['x-csrf-token'] ?? '', expectedCsrf)) {
          send(response, 403, { error: 'INVALID_CSRF' });
          return;
        }
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/zip')) {
          send(response, 415, { error: 'ZIP_REQUIRED' });
          return;
        }
        if (!config.github) {
          send(response, 503, { error: 'PUBLISHER_NOT_CONFIGURED' });
          return;
        }
        const input = await readRequestBytes(request, PACK_LIMITS.archiveBytes);
        const pack = validateAndSanitizePack(input);
        const packPath = `packs/${pack.manifest.id}/${pack.version}.zip`;
        const packUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(branch)}/${packPath}`;
        const publishedAt = new Date().toISOString();
        const publicManifest = {
          schemaVersion: 1,
          active: {
            id: pack.manifest.id,
            name: pack.manifest.name,
            version: pack.version,
            sha256: pack.sha256,
            packUrl,
            publishedAt,
          },
        };
        const result = await config.github.publish({ packPath, packBytes: pack.bytes, manifest: publicManifest });
        send(response, 201, {
          ok: true,
          id: pack.manifest.id,
          name: pack.manifest.name.en,
          version: pack.version,
          frameCount: pack.frameCount,
          commitSha: result.commitSha,
        }, { 'Cache-Control': 'no-store' });
        return;
      }

      send(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof PackValidationError || error?.code === 'ARCHIVE_SIZE') {
        send(response, 400, { error: error.code });
        return;
      }
      console.error(error);
      send(response, 500, { error: 'INTERNAL_ERROR' });
    }
  };
}

export function createCompanionServer() {
  return http.createServer(createCompanionHandler());
}

if (process.argv[1] === modulePath) {
  const server = createCompanionServer();
  server.listen(port, host, () => {
    console.log(`Web Companion listening on http://${host}:${port}`);
  });
}
