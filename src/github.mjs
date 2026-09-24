import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const API = 'https://api.github.com';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function githubRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tonytan-web-companion',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function exchangeOAuthCode({ clientId, clientSecret, code }) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) throw new Error(payload?.error_description || 'OAuth exchange failed');
  return payload.access_token;
}

export async function authenticatedUser(token) {
  return githubRequest('/user', { token });
}

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

export class GitHubPublisher {
  constructor({ appId, installationId, privateKeyFile, owner, repository, branch = 'media' }) {
    this.appId = appId;
    this.installationId = installationId;
    this.privateKeyFile = privateKeyFile;
    this.owner = owner;
    this.repository = repository;
    this.branch = branch;
    this.cachedToken = null;
  }

  async installationToken() {
    if (this.cachedToken?.expiresAt > Date.now() + 60_000) return this.cachedToken.value;
    const privateKey = await readFile(this.privateKeyFile, 'utf8');
    const jwt = appJwt(this.appId, privateKey);
    const payload = await githubRequest(`/app/installations/${this.installationId}/access_tokens`, {
      method: 'POST',
      token: jwt,
    });
    this.cachedToken = { value: payload.token, expiresAt: Date.parse(payload.expires_at) };
    return payload.token;
  }

  async publish({ packPath, packBytes, manifest }) {
    const token = await this.installationToken();
    const prefix = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}`;
    const ref = await githubRequest(`${prefix}/git/ref/heads/${encodeURIComponent(this.branch)}`, { token });
    const parentSha = ref.object.sha;
    const parent = await githubRequest(`${prefix}/git/commits/${parentSha}`, { token });
    const [packBlob, manifestBlob] = await Promise.all([
      githubRequest(`${prefix}/git/blobs`, {
        method: 'POST', token,
        body: { content: Buffer.from(packBytes).toString('base64'), encoding: 'base64' },
      }),
      githubRequest(`${prefix}/git/blobs`, {
        method: 'POST', token,
        body: { content: `${JSON.stringify(manifest, null, 2)}\n`, encoding: 'utf-8' },
      }),
    ]);
    const tree = await githubRequest(`${prefix}/git/trees`, {
      method: 'POST', token,
      body: {
        base_tree: parent.tree.sha,
        tree: [
          { path: packPath, mode: '100644', type: 'blob', sha: packBlob.sha },
          { path: 'manifest.json', mode: '100644', type: 'blob', sha: manifestBlob.sha },
        ],
      },
    });
    const commit = await githubRequest(`${prefix}/git/commits`, {
      method: 'POST', token,
      body: {
        message: `Publish companion ${manifest.active.id}@${manifest.active.version}`,
        tree: tree.sha,
        parents: [parentSha],
      },
    });
    await githubRequest(`${prefix}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH', token,
      body: { sha: commit.sha, force: false },
    });
    return { commitSha: commit.sha };
  }
}
