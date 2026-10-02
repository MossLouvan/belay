// The host window. Everything it shows comes from one state object the main
// process pushes (host.js → preload-host.cjs); this file only paints it.

const $ = (id) => document.getElementById(id);
const PHASE_TEXT = { starting: 'Starting…', stopped: 'Stopped', busy: 'Waiting for the port' };

let sawScreenDenied = false;

function paint(state) {
  const running = state.phase === 'running';
  $('status').textContent = running
    ? (state.paired ? `Running · ${state.devices} phone${state.devices === 1 ? '' : 's'} linked` : 'Running · not linked yet')
    : PHASE_TEXT[state.phase] ?? state.phase;

  const showQr = running && !state.paired && state.pairingSvg;
  $('qr').hidden = !showQr;
  $('code-line').hidden = !showQr;
  if (showQr) {
    // The SVG was built by src/host-status.js from the host's own module
    // matrix — a fixed shape of <svg><path/></svg> with no text content.
    $('qr').innerHTML = state.pairingSvg;
    $('code').textContent = state.pairingCode;
  }
  $('link-heading').textContent = running && state.paired ? 'Linked' : 'Link a phone';
  $('link-caption').hidden = running && state.paired;
  $('busy').hidden = state.phase !== 'busy';
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
  $('login-item').addEventListener('change', (e) => window.belayHost.setLoginItem(e.target.checked));
  $('viewer').addEventListener('click', () => window.belayHost.openViewer());
  $('logs').addEventListener('click', () => window.belayHost.openLogs());
  // Permissions change outside this window (System Settings); re-read while visible.
  setInterval(async () => { if (document.visibilityState === 'visible') paint(await window.belayHost.state()); }, 3000);
}

void init();
