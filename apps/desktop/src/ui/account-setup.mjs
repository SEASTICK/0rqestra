// What each AI accounts card says and offers, from the state the main process reports
// (main/accounts/accounts-service.ts). Kept free of React so it is unit-tested.

export const STATES = {
  missing: { badge: 'CLI missing', tone: 'is-off' },
  signed_out: { badge: 'Installed · signed out', tone: 'is-off' },
  api_key: { badge: 'Signed in with an API key', tone: 'is-warn' },
  signed_in: { badge: 'Signed in', tone: 'is-ready' },
  failed: { badge: 'Connection failed', tone: 'is-bad' },
};

const VENDOR = { claude: 'Anthropic', codex: 'OpenAI' };
const PLAN = { claude: 'Claude', codex: 'ChatGPT' };

export function badgeFor(account) {
  const state = STATES[account.setup] || STATES.missing;
  if (account.setup === 'signed_in' && account.lastTest?.ok) return { badge: 'Connected', tone: 'is-ready' };
  return state;
}

// The three steps of the guide and how far the tool is.
export function steps(account) {
  const installed = account.setup !== 'missing';
  const signedIn = ['signed_in', 'failed'].includes(account.setup) && account.subscription;
  const tested = account.setup === 'signed_in' && Boolean(account.lastTest?.ok);
  return [
    { id: 'install', label: 'Install', done: installed, current: !installed },
    { id: 'signIn', label: 'Sign in', done: signedIn, current: installed && !signedIn },
    { id: 'test', label: 'Test', done: tested, current: signedIn && !tested },
  ];
}

// The one main button of a card. While something runs, it stops that instead.
export function mainAction(account) {
  const activity = account.activity;
  if (activity) {
    if (activity.kind === 'testing') return { kind: 'busy', label: 'Testing…' };
    if (activity.kind === 'installing') return { kind: 'cancel', label: 'Stop installing' };
    return { kind: 'cancel', label: 'Stop waiting' };
  }
  switch (account.setup) {
    case 'missing': return { kind: 'install', label: `Install ${account.name}` };
    case 'signed_out': return { kind: 'signIn', label: 'Sign in' };
    case 'api_key': return { kind: 'signIn', label: `Sign in with your ${PLAN[account.provider] || ''} plan`.replace('  ', ' ') };
    case 'failed':
      if (account.checkFailed) return { kind: 'refresh', label: 'Check again' };
      return { kind: 'test', label: 'Test again' };
    default: return { kind: 'test', label: 'Test connection' };
  }
}

export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function activityText(account) {
  const activity = account.activity;
  if (!activity) return '';
  const vendor = VENDOR[account.provider] || 'the provider';
  switch (activity.kind) {
    case 'installing': return `Installing ${account.name} with ${vendor}'s official installer. The download can take a minute and shows little progress.`;
    case 'waiting_install': return 'Waiting for the installer in the terminal window. This card checks again every few seconds.';
    case 'waiting_sign_in': return 'Waiting for you to finish signing in, in the terminal window and the browser. This card updates by itself.';
    case 'testing': return `Sending one short test request through ${account.name}…`;
    default: return '';
  }
}

export function sourceLabel(source) {
  return {
    native: 'official installer', winget: 'WinGet', npm: 'npm', homebrew: 'Homebrew', path: 'on PATH', override: 'custom path',
  }[source] || null;
}

export function subtitle(account) {
  if (!account.installed) return `Official tool from ${VENDOR[account.provider] || 'the provider'}`;
  return [account.name, account.version ? `version ${account.version}` : null, sourceLabel(account.source)].filter(Boolean).join(' · ');
}

// The sentence under the title that says where the tool stands.
export function stateLine(account) {
  const plan = PLAN[account.provider] || '';
  switch (account.setup) {
    case 'missing':
      return `${account.name} is not installed. 0rqestra installs it with ${VENDOR[account.provider]}'s official installer, and then you sign in with your ${plan} subscription.`;
    case 'signed_out':
      return `${account.name} is installed but not signed in. Sign in opens ${account.name}'s own sign-in in a terminal window; your password and tokens stay with ${VENDOR[account.provider]}.`;
    case 'api_key':
      return account.authMethod === 'api_key'
        ? `${account.name} is signed in with an API key, which is billed per use. 0rqestra never uses API keys, so this tool stays off until you sign in with your ${plan} subscription.`
        : `${account.name} is signed in through another provider, not a ${plan} subscription. 0rqestra only uses subscriptions, so this tool stays off until you sign in with one.`;
    case 'signed_in':
      return account.lastTest?.ok
        ? `Connected. Replies use your ${account.plan ? `${account.plan} ` : ''}${plan} subscription, never pay-per-use.`
        : `Signed in with your ${account.plan ? `${account.plan} ` : ''}${plan} subscription. Send a short test request to make sure it answers.`;
    case 'failed':
      if (account.checkFailed) return account.problem || `${account.name} is installed, but 0rqestra could not read its state.`;
      return account.lastTest?.message ? `The test request failed: ${account.lastTest.message}` : 'The test request failed.';
    default:
      return '';
  }
}

export const canUse = (account) => account.setup === 'signed_in';

// The agents a tool can be chosen for, Manager first.
export function agentChoices(nodes) {
  return (nodes || []).filter((n) => n && n.role !== 'Manager').map((n) => ({ id: n.id, label: `${n.name} (${n.role})` }));
}
