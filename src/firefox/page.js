// Starts PSA in the page's own world once bridge.js has passed in this site's settings. build.mjs places
// this after src/psa.js, which it wraps as startPsa(extension), all inside one function so nothing is
// left on the page's globals.
const listeners = [];
const send = (message) => document.dispatchEvent(new CustomEvent('psa:from-page', { detail: JSON.stringify(message) }));
let started = false;

// A frame whose parent is from the same site is looked after by the parent's PSA, which reaches into it as
// the bookmarklet does; a second copy here would only compete with it for the speed. So PSA doesn't start
// here, even when the settings bridge.js asked for on its own arrive.
let parentIsSameSite = false;
try {
  parentIsSameSite = window.parent !== window && !!window.parent.document;
} catch (err) {
  parentIsSameSite = false;
}

// Instead, this frame's document goes straight to that PSA (the nearest frame above that runs one), which
// would otherwise find it only on its next full look, or never inside a closed shadow root. If that PSA
// hasn't started yet, this tries again for a few seconds.
function handOver(triesLeft) {
  for (let win = window.parent; ; win = win.parent) {
    let psa = null;
    try {
      psa = win.__speedCtl;
    } catch (err) {
      return;
    }
    if (psa && typeof psa.adopt === 'function') {
      psa.adopt(document);
      return;
    }
    if (win === win.parent) break;
  }
  if (triesLeft > 0) setTimeout(() => handOver(triesLeft - 1), 1000);
}

if (parentIsSameSite) {
  handOver(10);
} else {
  document.addEventListener('psa:to-page', (event) => {
    let message = null;
    try {
      message = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    if (!message) return;
    if (message.type !== 'init') {
      listeners.forEach((listener) => listener(message));
      return;
    }
    if (started) return;
    started = true;
    startPsa({
      top: message.top === true,
      fresh: message.fresh === true,
      settings: message.settings || {},
      positions: message.positions || {},
      send,
      listen: (listener) => listeners.push(listener),
    });
  });
  send({ type: 'hello' });
}
