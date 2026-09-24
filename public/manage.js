const authCard = document.querySelector('.auth-card');
const status = authCard.querySelector('.status');
const login = authCard.querySelector('.login');
const form = document.querySelector('.publish-card');
const input = form.querySelector('input');
const progress = form.querySelector('progress');
const output = form.querySelector('output');
let csrfToken = '';

async function loadSession() {
  try {
    const response = await fetch('/companion/api/session', { credentials: 'same-origin' });
    const session = await response.json();
    if (!session.authenticated) {
      status.textContent = 'Sign in with the site owner GitHub account to publish.';
      login.hidden = false;
      authCard.dataset.authState = 'anonymous';
      return;
    }
    csrfToken = session.csrfToken;
    status.textContent = `Signed in as ${session.login}.`;
    form.hidden = false;
    authCard.dataset.authState = 'authenticated';
  } catch {
    status.textContent = 'The publisher is temporarily unavailable.';
    authCard.dataset.authState = 'error';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = input.files?.[0];
  if (!file) return;
  output.textContent = '';
  progress.hidden = false;
  progress.removeAttribute('value');
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch('/companion/api/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/zip',
        'X-CSRF-Token': csrfToken,
      },
      body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `HTTP_${response.status}`);
    progress.value = 100;
    output.textContent = `${payload.name} is now live for every visitor.`;
    input.value = '';
  } catch (error) {
    progress.hidden = true;
    output.textContent = `Publish failed: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`;
  } finally {
    form.querySelector('button').disabled = false;
  }
});

loadSession();
