// The 0rqestra account screens: welcome, create account, sign in, and the email code. The main
// process does every step (main/teams); this page never sees a token. "Sign in" never creates an
// account. The same forms are used on the Teams page.
import React, { useEffect, useState } from 'react';
import { USERNAME_RULE, cleanError, cleanUsername, secondsLeft } from './account-ui.mjs';

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// Create account / sign in / code. `step` starts at 'register' or 'sign_in'; when a code has been
// sent (view.status 'code_sent') it shows the code step. The email stays filled in after errors.
export function AccountForms({ api, view, onView, initialStep = 'sign_in', onBack }) {
  const [step, setStep] = useState(initialStep);
  const [email, setEmail] = useState(view?.pendingEmail || '');
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const codeStep = view?.status === 'code_sent';
  const now = useNow(codeStep);
  const wait = secondsLeft(view?.resendAt, now);
  const run = async (fn) => {
    setPending(true);
    setError('');
    try { const v = await fn(); if (v && v.status) onView(v); } catch (e) { setError(cleanError(e)); } finally { setPending(false); }
  };
  useEffect(() => { if (view?.pendingEmail) setEmail(view.pendingEmail); }, [view?.pendingEmail]);
  if (codeStep) {
    const register = view.pendingMode === 'register';
    return (
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); run(async () => { const v = await api.verifyCode(code); setCode(''); return v; }); }}>
        <h2>Check your email</h2>
        <p className="account-lead">We sent a one-time code to <strong>{view.pendingEmail}</strong>. It can take a minute to arrive; check spam too.</p>
        <label className="account-field">Code<input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={12} required/></label>
        {error && <p className="account-error" role="alert">{error}</p>}
        <div className="account-actions">
          <button className="button primary-button" type="submit" disabled={pending || !code.trim()}>{register ? 'Create account' : 'Sign in'}</button>
          <button className="button" type="button" disabled={pending || wait > 0} onClick={() => run(() => api.sendCode(view.pendingEmail, { mode: view.pendingMode, username }))}>{wait > 0 ? `Send a new code (${wait} s)` : 'Send a new code'}</button>
          <button className="button" type="button" disabled={pending} onClick={() => run(async () => { const v = await api.cancelCode(); setStep(register ? 'register' : 'sign_in'); return v; })}>Use another email</button>
        </div>
      </form>
    );
  }
  if (step === 'register') {
    return (
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); run(() => api.sendCode(email, { mode: 'register', username: cleanUsername(username) })); }}>
        <h2>Create your 0rqestra account</h2>
        <p className="account-lead">We email you a one-time code; there is no password. Your account is separate from Claude Code and Codex.</p>
        <label className="account-field">Email<input autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} required/></label>
        <label className="account-field">Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. alex_k" maxLength={25} spellCheck={false} required/></label>
        <p className="account-hint">Friends find you by this exact name. 3 to 24 lower-case letters, digits or _. Your email stays private.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
        <div className="account-actions">
          <button className="button primary-button" type="submit" disabled={pending || !email.trim() || !USERNAME_RULE.test(cleanUsername(username))}>Send code</button>
          <button className="button" type="button" onClick={() => { setError(''); setStep('sign_in'); }}>I already have an account</button>
          {onBack && <button className="button" type="button" onClick={onBack}>Back</button>}
        </div>
      </form>
    );
  }
  return (
    <form className="account-form" onSubmit={(e) => { e.preventDefault(); run(() => api.sendCode(email, { mode: 'sign_in' })); }}>
      <h2>Sign in to 0rqestra</h2>
      <p className="account-lead">Enter your account's email and we send you a one-time code.</p>
      <label className="account-field">Email<input autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} required/></label>
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="account-actions">
        <button className="button primary-button" type="submit" disabled={pending || !email.trim()}>Send code</button>
        <button className="button" type="button" onClick={() => { setError(''); setStep('register'); }}>Create an account instead</button>
        {onBack && <button className="button" type="button" onClick={onBack}>Back</button>}
      </div>
    </form>
  );
}

// A signed-in account without a username (made before usernames existed, or whose name was taken
// while it was being created) chooses one here.
export function UsernameForm({ api, view, onView, onSignOut }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setPending(true);
    setError('');
    try { const v = await api.setUsername(cleanUsername(username)); if (v?.status) onView(v); } catch (err) { setError(cleanError(err)); } finally { setPending(false); }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <h2>Choose your username</h2>
      <p className="account-lead">Signed in as <strong>{view?.email}</strong>. Friends find you by your username; your email address stays private.</p>
      <label className="account-field">Username<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. alex_k" maxLength={25} spellCheck={false} required/></label>
      <p className="account-hint">3 to 24 lower-case letters, digits or _.</p>
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="account-actions">
        <button className="button primary-button" type="submit" disabled={pending || !USERNAME_RULE.test(cleanUsername(username))}>Save username</button>
        {onSignOut && <button className="button" type="button" disabled={pending} onClick={onSignOut}>Sign out</button>}
      </div>
    </form>
  );
}

// The full-window first-launch screen.
export function AccountWelcome({ api, view, onView, onContinueLocal, onDismissEnded, onSignOut }) {
  if (view?.status === 'signed_in' && view.needsUsername) {
    return (
      <div className="account-screen" role="dialog" aria-modal="true" aria-label="Choose your username">
        <div className="account-card">
          <div className="account-brand"><img src="logo.png" alt="" width="56" height="56"/><span>0rqestra</span></div>
          <UsernameForm api={api} view={view} onView={onView} onSignOut={onSignOut}/>
        </div>
      </div>
    );
  }
  return <WelcomeCard api={api} view={view} onView={onView} onContinueLocal={onContinueLocal} onDismissEnded={onDismissEnded}/>;
}

function WelcomeCard({ api, view, onView, onContinueLocal, onDismissEnded }) {
  const [step, setStep] = useState(view?.sessionEnded ? 'sign_in' : view?.status === 'code_sent' ? 'code' : 'welcome');
  const showForms = step !== 'welcome' || view?.status === 'code_sent';
  return (
    <div className="account-screen" role="dialog" aria-modal="true" aria-label="Your 0rqestra account">
      <div className="account-card">
        <div className="account-brand"><img src="logo.png" alt="" width="56" height="56"/><span>0rqestra</span></div>
        {view?.sessionEnded && <p className="account-notice" role="status">{view.sessionEnded}</p>}
        {view?.serverProblem && <p className="account-error" role="alert">{view.serverProblem}</p>}
        {!showForms ? (
          <>
            <h1>One conversation. A whole team.</h1>
            <p className="account-lead">Create an account to work with teammates in Teams, or sign in if you already have one.</p>
            <div className="account-choices">
              <button className="button primary-button" type="button" onClick={() => setStep('register')}>Create account</button>
              <button className="button" type="button" onClick={() => setStep('sign_in')}>Sign in</button>
            </div>
          </>
        ) : (
          <AccountForms api={api} view={view} onView={onView} initialStep={step === 'register' ? 'register' : 'sign_in'} onBack={view?.status === 'code_sent' ? null : () => setStep('welcome')}/>
        )}
        <button className="account-local" type="button" onClick={() => { if (view?.sessionEnded) onDismissEnded(); onContinueLocal(); }}>Continue without an account</button>
        <p className="account-footnote">Local projects work without an account. Teams needs one. Claude Code and Codex keep their own sign-in in AI accounts.</p>
      </div>
    </div>
  );
}

export function AccountLoading() {
  return (
    <div className="account-screen account-loading" role="status" aria-live="polite">
      <div className="account-card account-card-small"><img src="logo.png" alt="" width="44" height="44"/><span>Checking your account…</span></div>
    </div>
  );
}
