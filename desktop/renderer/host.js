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
  $('link-heading').lastChild.textContent = linked ? 'Linked' : state.claim || !showQr ? 'Scan this code in Belay' : 'Type this code in Belay';
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
  $('logs').addEventListener('click', () => window.belayHost.openLogs());
  // Permissions change outside this window (System Settings); re-read while visible.
  setInterval(async () => { if (document.visibilityState === 'visible') paint(await window.belayHost.state()); }, 3000);
}

void init();
