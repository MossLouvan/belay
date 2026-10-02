// The host window. Everything it shows comes from one state object the main
// process pushes (host.js → preload-host.cjs); this file only paints it.

const $ = (id) => document.getElementById(id);
const PHASE_TEXT = { starting: 'Starting…', stopped: 'Stopped', busy: 'Belay is already running' };

let sawScreenDenied = false;
let paintedPhoneQr = false;

function paint(state) {
  const running = state.phase === 'running';
  $('status').textContent = running
    ? (state.paired ? `Running · ${state.devices} phone${state.devices === 1 ? '' : 's'} linked` : 'Running · not linked yet')
    : PHASE_TEXT[state.phase] ?? state.phase;

  if (!paintedPhoneQr && state.phoneAppSvg) {
    // Same fixed <svg><path/></svg> shape as the pairing QR, built in the main process.
    $('phone-qr').innerHTML = state.phoneAppSvg;
    $('phone-link').href = state.phoneAppUrl;
    paintedPhoneQr = true;
  }
  $('phone-qr').hidden = !state.phoneAppSvg;

  // A code shows whenever the host has a live one — first run, or a phone
  // asked / "Pair another phone" while others are already paired (#150).
  const showQr = running && Boolean(state.pairingSvg);
  $('qr').hidden = !showQr;
  $('code-line').hidden = !showQr;
  if (showQr) {
    // The SVG was built by src/host-status.js from the host's own module
    // matrix — a fixed shape of <svg><path/></svg> with no text content.
    $('qr').innerHTML = state.pairingSvg;
    $('code').textContent = state.pairingCode;
  }
  const linked = running && state.paired && !showQr;
  const busy = state.phase === 'busy';
  // Unlinked: the account claim QR. Linked to the account but not yet paired
  // with a phone: the 6-digit code the phone asks for next.
  // Unlinked: signing in here links this computer with no QR; the claim QR
  // below stays as the other way in.
  const signIn = running && Boolean(state.claim);
  $('signin').hidden = !signIn;
  $('signin-apple').hidden = !state.signInProviders?.apple;
  $('signin-google').hidden = !state.signInProviders?.google;
  $('linked-to').hidden = !state.linkedTo;
  $('linked-to').textContent = state.linkedTo ? `Linked to ${state.linkedTo}` : '';
  $('link-heading').lastChild.textContent = linked ? 'Linked' : state.claim ? 'Or scan this code in Belay' : !showQr ? 'Scan this code in Belay' : 'Type this code in Belay';
  $('pair-another').hidden = !linked;
  // A code for one more phone needs no account-link instructions under it.
  $('link-caption').hidden = linked || busy || (state.paired && showQr && !state.claim);
  $('get-app').hidden = linked;
  $('busy').hidden = !busy;
  $('busy-agent').hidden = !busy || !state.launchAgent;
  $('take-over').hidden = !busy || !state.launchAgent;
  $('busy-other').hidden = !busy || state.launchAgent;
  $('error').hidden = !state.error;
  $('error').textContent = state.error ?? '';

  const perms = state.perms;
  $('perms').hidden = !perms.supported;
  for (const row of document.querySelectorAll('.perm')) {
    const granted = perms[row.dataset.kind] === true;
    row.dataset.granted = String(granted);
    row.querySelector('[data-role="badge"]').textContent = granted ? 'granted' : 'not yet';
  }
  if (perms.supported && !perms.screen) sawScreenDenied = true;
  // Granted after being denied in this run: the helper only learns at launch.
  $('relaunch').hidden = !(perms.supported && perms.screen && sawScreenDenied);

  $('login-item').checked = state.openAtLogin;
  paintTrust(state, running);
}

// ── account trust: Allow/Deny for a phone that asked, and the paired list ──
// Names arrive from the network: textContent only, never innerHTML.
function row(name, detail, buttons) {
  const li = document.createElement('li');
  li.className = 'device-row';
  const text = document.createElement('div');
  text.className = 'device-text';
  const n = document.createElement('div');
  n.className = 'name';
  n.textContent = name;
  const c = document.createElement('div');
  c.className = 'caption';
  c.textContent = detail;
  text.append(n, c);
  li.append(text);
  for (const [label, primary, onClick] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'button sm primary' : 'button sm';
    b.textContent = label;
    b.addEventListener('click', () => { b.disabled = true; onClick(); });
    li.append(b);
  }
  return li;
}

/** "Code K7PQ · iPhone · on your account since 2 Oct 2026" */
function describePending(p) {
  const kind = p.platform === 'ios' ? 'iPhone' : p.platform === 'android' ? 'Android phone' : 'Phone';
  const since = p.addedAt ? ` · on your account since ${new Date(p.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  return `${p.matchCode ? `Code ${p.matchCode} · ` : ''}${kind}${since}. Check the phone shows the same code.`;
}

function paintTrust(state, running) {
  const pending = running ? state.pendingPhones ?? [] : [];
  $('pending').hidden = pending.length === 0;
  $('pending-list').replaceChildren(...pending.map((p) => row(`Allow ${p.name}?`, describePending(p), [
    ['Allow', true, () => window.belayHost.decidePhone(p.id, true)],
    ['Deny', false, () => window.belayHost.decidePhone(p.id, false)],
  ])));
  $('first-phone').hidden = !(running && state.firstPhone === 'open');
  $('first-phone-closed').hidden = !(running && state.firstPhone === 'closed');
  // Nothing to scan or type for a linked computer waiting on its first phone.
  $('link-section').hidden = running && (state.firstPhone === 'open' || state.firstPhone === 'closed') && state.phase !== 'busy';
  const phones = running ? state.phones ?? [] : [];
  $('phones').hidden = phones.length === 0;
  $('phone-list').replaceChildren(...phones.map((p) => row(p.name, p.lastSeen ? `Last seen ${new Date(p.lastSeen).toLocaleString()}` : 'Paired', [
    ['Remove', false, () => window.belayHost.removePhone(p.tokenPrefix)],
  ])));
}

// ── sign in to link this computer ──────────────────────────────────────────
// The main process does the sign-in and hands the session to the host; this
// page only ever sees {ok, error, maskedEmail}.
function wireSignIn() {
  const msg = (text) => { $('signin-msg').textContent = text; };
  const buttons = ['signin-apple', 'signin-google', 'signin-email-send', 'signin-code-send'];
  const busy = async (text, work) => {
    msg(text);
    for (const id of buttons) $(id).disabled = true;
    try { return await work(); } finally { for (const id of buttons) $(id).disabled = false; }
  };
  const showCodeStep = (on) => {
    $('signin-email-form').hidden = on;
    $('signin-code-form').hidden = !on;
    $('signin-back').hidden = !on;
    if (on) $('signin-code').focus();
  };
  const done = (result) => {
    // Linked: the host's state push swaps this section for "Linked to …".
    msg(result.ok ? '' : result.error);
    if (result.ok) { $('signin-code').value = ''; showCodeStep(false); }
  };
  $('signin-email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await busy('Sending a code…', () => window.belayHost.emailStart($('signin-email').value));
    msg(result.ok ? `We emailed a 6-digit code to ${$('signin-email').value.trim()}.` : result.error);
    if (result.ok) showCodeStep(true);
  });
  $('signin-code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    done(await busy('Linking this computer…', () => window.belayHost.emailVerify($('signin-email').value, $('signin-code').value)));
  });
  $('signin-back').addEventListener('click', () => { msg(''); showCodeStep(false); });
  for (const name of ['apple', 'google']) {
    $(`signin-${name}`).addEventListener('click', async () => {
      done(await busy('Finish signing in in your browser…', () => window.belayHost.signInWith(name)));
    });
  }
}

async function init() {
  paint(await window.belayHost.state());
  window.belayHost.onChange(paint);

  for (const row of document.querySelectorAll('.perm')) {
    for (const action of ['request', 'open']) {
      row.querySelector(`[data-role="${action}"]`).addEventListener('click', async () => {
        const perms = await window.belayHost.permission(row.dataset.kind, action);
        paint({ ...(await window.belayHost.state()), perms });
      });
    }
  }
  $('relaunch-button').addEventListener('click', () => window.belayHost.relaunch());
  $('take-over').addEventListener('click', async () => {
    $('take-over').disabled = true;
    await window.belayHost.takeOver();
    $('take-over').disabled = false;
  });
  $('login-item').addEventListener('change', (e) => window.belayHost.setLoginItem(e.target.checked));
  $('viewer').addEventListener('click', () => window.belayHost.openViewer());
  $('pair-another').addEventListener('click', () => window.belayHost.pairAnother());
  $('open-first-phone').addEventListener('click', () => window.belayHost.openFirstPhone());
  $('logs').addEventListener('click', () => window.belayHost.openLogs());
  wireSignIn();
  // Permissions change outside this window (System Settings); re-read while visible.
  setInterval(async () => { if (document.visibilityState === 'visible') paint(await window.belayHost.state()); }, 3000);
}

void init();
