// Paint the chosen appearance — Harbour, Night, Current or Fieldwork — and
// keep this window in step when it changes anywhere (src/look.js, main.js).
//
// A classic script in <head>, ahead of the stylesheets, so the attributes are
// on <html> before the first paint. tokens.css does the rest: data-theme picks
// Harbour's day or night, data-look swaps in a flat look's palette and faces.
// A machine page (<html data-machine>, the stream windows) is dark in every
// look: Harbour's night, or Fieldwork under both flat looks, as the phone's
// HUD resolves getTheme('dark').
//
// Any element with data-look-picker gets the four-way picker, in the phone's
// words and order (app/src/settings/theme-toggle.tsx).

(() => {
  const api = window.belayLook;
  const root = document.documentElement;
  const machine = root.hasAttribute('data-machine');
  const CHOICES = [['harbour', 'Harbour'], ['night', 'Night'], ['current', 'Current'], ['fieldwork', 'Fieldwork']];
  let shown = { mode: 'system', name: 'harbour', look: 'harbour', scheme: 'light' };

  function paintPickers() {
    for (const button of document.querySelectorAll('[data-look-picker] [data-mode]')) {
      button.setAttribute('aria-checked', String(button.dataset.mode === shown.name));
    }
  }

  function apply(look) {
    if (!look || typeof look.look !== 'string') return;
    shown = look;
    root.dataset.look = machine && look.look === 'current' ? 'fieldwork' : look.look;
    root.dataset.theme = machine ? 'dark' : look.scheme;
    paintPickers();
  }

  function buildPicker(host) {
    host.setAttribute('role', 'radiogroup');
    host.setAttribute('aria-label', 'Appearance');
    host.replaceChildren(...CHOICES.map(([mode, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'segment';
      button.setAttribute('role', 'radio');
      button.dataset.mode = mode;
      button.textContent = label;
      button.addEventListener('click', async () => apply(await api.set(mode)));
      return button;
    }));
  }

  try {
    apply(api?.current());
  } catch (e) {
    // No bridge (or main has not answered): Harbour, which is the :root default.
    console.error(`[look] ${e?.message ?? e}`);
  }
  api?.onChange(apply);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-look-picker]').forEach(buildPicker);
    paintPickers();
  });
})();
