'use strict';

/*
  Shared focus-trap primitive for the app's overlay panels (docs/PERF-UX.md
  U3). Before this, the document had exactly one `role="dialog"` and one
  `aria-modal` across thirteen different panels, each toggling `.hidden`
  directly with its own bespoke open()/close(): Tab could walk out of an open
  panel into the page behind it, dismissing one dropped focus onto `<body>`
  instead of back where the user was, and Escape worked on some panels and
  not others.

  Deliberately NOT a rewrite of every panel's own open()/close() — those keep
  doing their own thing (refreshing lists, resetting inputs, writing
  localStorage). `registerPanel` below wires each panel up by watching its
  `hidden` attribute, so every existing open/close path gets a trap for free
  without being individually touched. See onboarding-cards.js for the actual
  registration list — it loads last (index.html), so every element and
  close() function referenced there already exists.
*/

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const openerOf = new WeakMap();    // panel -> element to refocus on close
const trapKeydown = new WeakMap(); // panel -> its own keydown listener
const registeredPanels = new Set();

/** Elements that are actually reachable right now, not just present in the DOM. */
function visibleFocusables(panel) {
  return Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}

/*
  The last element to receive focus that was NOT inside one of our own
  panels — i.e. the real trigger (a chip, usually) rather than whatever a
  panel's own open() function focuses internally afterward.

  This can't be `document.activeElement` read inside trapFocus(): that runs
  from a MutationObserver callback, which is microtask-queued and therefore
  strictly LATER than the synchronous click handler that opened the panel.
  Several open() functions (openLibrary() among them) focus something of
  their own — e.g. a search box — as their last step, in that same
  synchronous handler. By the time trapFocus() finally runs, activeElement
  is already that search box, not the chip that was clicked — recording it
  as the "opener" would restore focus INTO the panel on close instead of
  back to the chip. Tracking every focus event as it happens sidesteps the
  ordering problem entirely: a panel's own internal focus() calls target
  something already inside the panel, so they never overwrite this.
*/
let lastExternalFocus = null;
document.addEventListener('focusin', (e) => {
  const target = e.target;
  if (!target) return;
  for (const panel of registeredPanels) {
    if (panel.contains(target)) return;
  }
  lastExternalFocus = target;
}, true);

/**
 * Move focus into a panel and trap Tab inside it. Idempotent — calling this
 * on a panel that is already trapped (a few open() paths can run twice) does
 * not stack listeners or clobber the recorded opener with the panel itself.
 * @param {HTMLElement} panel
 * @param {{onEscape?: () => void}} [opts]
 */
function trapFocus(panel, opts = {}) {
  if (!panel || trapKeydown.has(panel)) return;
  openerOf.set(panel, lastExternalFocus || document.activeElement);

  const items = visibleFocusables(panel);
  if (items[0]) {
    items[0].focus();
  } else {
    // Nothing focusable inside (e.g. a panel that is briefly just text) —
    // the panel itself becomes the Tab anchor rather than leaving focus
    // wherever it happened to be, which is what let Tab walk straight
    // through panels like this one in the first place.
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus();
  }

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      if (opts.onEscape) {
        e.stopPropagation();
        opts.onEscape();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = visibleFocusables(panel);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  panel.addEventListener('keydown', onKeydown);
  trapKeydown.set(panel, onKeydown);
}

/**
 * Release a panel's trap and restore focus to whatever had it before the
 * panel opened. Safe to call on a panel that was never trapped.
 * @param {HTMLElement} panel
 */
function releaseFocus(panel) {
  if (!panel) return;
  const handler = trapKeydown.get(panel);
  if (handler) {
    panel.removeEventListener('keydown', handler);
    trapKeydown.delete(panel);
  }
  const opener = openerOf.get(panel);
  openerOf.delete(panel);
  if (opener && typeof opener.focus === 'function' && document.body.contains(opener)) {
    opener.focus();
  }
}

/**
 * Wire a panel up to trapFocus/releaseFocus automatically, driven by its
 * `hidden` attribute, so its many existing open()/close() call sites need no
 * changes at all.
 * @param {HTMLElement|null} panel
 * @param {() => void} [onEscape]
 */
function registerPanel(panel, onEscape) {
  if (!panel) return;
  registeredPanels.add(panel);
  if (!panel.hidden) trapFocus(panel, { onEscape }); // already open at registration time
  const observer = new MutationObserver(() => {
    if (panel.hidden) releaseFocus(panel);
    else trapFocus(panel, { onEscape });
  });
  observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
}

window.PanelFocus = { trapFocus, releaseFocus, registerPanel };
