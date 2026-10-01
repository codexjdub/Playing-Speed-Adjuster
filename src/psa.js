/*
 * Playing Speed Adjuster (PSA) — a site-independent bookmarklet for HTML5 <audio> and <video>.
 *
 * This file is the readable source. `node build.mjs` turns it into dist/bookmarklet.txt and
 * dist/install.html. Running the bookmarklet while the panel is open closes the panel.
 *
 * The UI is built with DOM calls only (no innerHTML) so it works on Trusted Types pages such as YouTube.
 */
(() => {
  'use strict';

  const NS = '__speedCtl';
  const previous = window[NS];
  if (previous && typeof previous.destroy === 'function') {
    previous.destroy();
    return;
  }

  // ---- Settings ---------------------------------------------------------------------------------

  // Shown in the panel and on the install page (build.mjs reads it from here). Bump it on every release.
  const VERSION = '1.2.2';
  const MIN_RATE = 0.25;
  const MAX_RATE = 4;
  const STEP = 0.05;
  const KEY_STEP = 0.1;
  // Keyboard shortcuts while the panel is open: a speed change, or a fixed speed.
  const KEYS = { '[': { by: -KEY_STEP }, ']': { by: KEY_STEP }, '\\': { to: 1.5 } };
  const PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const SKIP_BACK = 10;
  const SKIP_AHEAD = 20;
  const TICK_MS = 500;
  // Shadow roots and same-origin iframes are rediscovered every Nth tick, because that walk visits every element.
  const DEEP_SCAN_EVERY = 4;
  // A site that resets the speed more often than this gets playbackRate locked on that element.
  const FIGHT_LIMIT = 8;
  const FIGHT_WINDOW_MS = 2000;
  const TITLE_TTL_MS = 2000;
  const STORE_KEY = 'speedCtl.v1';
  const MEDIA_EVENTS = [
    'play',
    'playing',
    'pause',
    'ended',
    'ratechange',
    'loadstart',
    'loadedmetadata',
    'durationchange',
    'emptied',
  ];

  // ---- Per-site storage -------------------------------------------------------------------------
  // localStorage is already scoped to the site's origin. Blocked storage falls back to memory.

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch (err) {
    saved = {};
  }
  if (typeof saved !== 'object') saved = {};

  function save(key, value) {
    saved[key] = value;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (err) {
      // Storage is blocked or full: the value lasts for this visit only.
    }
  }

  const clampRate = (r) => Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(r * 100) / 100));
  const sameRate = (a, b) => Math.abs(a - b) < 0.005;

  let rate = clampRate(Number(saved.rate) || 1);
  let minimized = saved.min === true;

  // ---- State ------------------------------------------------------------------------------------

  const known = new Set(); // media seen so far, including off-page ones such as `new Audio()`
  const roots = new Map(); // Document | ShadowRoot -> undo
  const watched = new Map(); // off-page element -> undo (it has its own listeners)
  const locked = new Map(); // element whose playbackRate setter we replaced -> undo
  const touched = new WeakSet(); // elements whose speed we changed
  const growth = new WeakMap(); // element -> { duration, increases }, for spotting live streams
  const fights = new WeakMap();
  const titles = new WeakMap();

  let mediaList = [];
  let target = null;
  let lastStarted = null;
  let lastStartedAt = 0;
  let picked = null;
  let pickedAt = 0;
  let alive = true;
  let tickCount = 0;
  let timer = 0;
  let noteTimer = 0;
  let refreshQueued = false;
  let glowUntil = 0;
  let glowFrame = 0;

  // ---- Small helpers ----------------------------------------------------------------------------

  const isMedia = (node) => !!node && node.nodeType === 1 && /^(audio|video)$/i.test(node.localName || '');
  const clean = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  function safely(fn) {
    try {
      fn();
    } catch (err) {
      // Page objects can disappear underneath us (navigated iframes, removed nodes).
    }
  }

  function hasSource(el) {
    return !!(el.currentSrc || el.getAttribute('src') || el.srcObject || el.querySelector('source[src]'));
  }

  // ---- Speed enforcement ------------------------------------------------------------------------

  // A live stream (live radio, a MediaStream) has no end. It can't run ahead of the broadcast,
  // so speeding it up only causes buffering. A MediaStream source is live by definition, even before
  // it has loaded. Others report an Infinity duration, or, in players that stream in chunks
  // (hls.js and similar, e.g. RTHK live radio), a duration that keeps growing.
  const isStream = (el) => !!el.srcObject && typeof el.srcObject.getTracks === 'function';
  const isLive = (el) =>
    isStream(el) || el.duration === Infinity || (growth.get(el) || { increases: 0 }).increases >= 2;

  function noteDuration(el) {
    const duration = el.duration;
    if (!isFinite(duration)) return;
    const seen = growth.get(el);
    if (!seen) {
      growth.set(el, { duration, increases: 0 });
      return;
    }
    if (duration > seen.duration + 0.5) seen.increases += 1;
    seen.duration = duration;
  }

  function applyRate(el) {
    if (isLive(el)) {
      restoreLive(el);
      return;
    }
    try {
      // defaultPlaybackRate is what load() resets playbackRate to, so new sources start at our speed too.
      if (!sameRate(el.defaultPlaybackRate, rate)) {
        el.defaultPlaybackRate = rate;
        touched.add(el);
      }
      if (!sameRate(el.playbackRate, rate)) {
        el.playbackRate = rate;
        touched.add(el);
      }
    } catch (err) {
      // Some browsers throw for rates they can't play; the clamp keeps us inside the usual range.
    }
  }

  // A stream's duration is only known after it starts loading, so it may already have our speed.
  function restoreLive(el) {
    const unlock = locked.get(el);
    if (unlock) {
      safely(unlock);
      locked.delete(el);
    }
    if (!touched.has(el)) return;
    touched.delete(el);
    safely(() => {
      el.defaultPlaybackRate = 1;
      el.playbackRate = 1;
    });
  }

  function nativeRateDescriptor(el) {
    for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
      if (desc) return desc;
    }
    return null;
  }

  // Last resort for pages that undo every change: page writes to this element's playbackRate
  // are replaced with the chosen speed until the panel closes.
  function lockRate(el) {
    if (locked.has(el)) return;
    const native = nativeRateDescriptor(el);
    if (!native || !native.get || !native.set) return;
    try {
      Object.defineProperty(el, 'playbackRate', {
        configurable: true,
        enumerable: true,
        get() {
          return native.get.call(this);
        },
        set() {
          if (!sameRate(native.get.call(this), rate)) native.set.call(this, rate);
        },
      });
      locked.set(el, () => {
        delete el.playbackRate;
      });
    } catch (err) {
      // Non-configurable on this element: the periodic re-apply still runs.
    }
  }

  function enforce(el) {
    if (isLive(el)) return;
    if (sameRate(el.playbackRate, rate) && sameRate(el.defaultPlaybackRate, rate)) return;
    const now = Date.now();
    let fight = fights.get(el);
    if (!fight || now - fight.since > FIGHT_WINDOW_MS) {
      fight = { since: now, count: 0 };
      fights.set(el, fight);
    }
    fight.count += 1;
    if (fight.count > FIGHT_LIMIT) lockRate(el);
    applyRate(el);
  }

  function setRate(value) {
    if (!isFinite(value)) return;
    rate = clampRate(value);
    save('rate', rate);
    mediaList.forEach(applyRate);
    render();
  }

  // ---- Media discovery --------------------------------------------------------------------------

  function markStarted(el) {
    lastStarted = el;
    lastStartedAt = Date.now();
  }

  function onMediaEvent(event) {
    const el = event.target;
    if (!alive || !isMedia(el)) return;
    known.add(el);
    if (event.type === 'ratechange') {
      enforce(el);
    } else if (event.type === 'play') {
      markStarted(el);
      applyRate(el);
    } else if (event.type === 'loadstart' || event.type === 'emptied') {
      // A new source: its duration history no longer applies.
      growth.delete(el);
      applyRate(el);
    } else if (event.type === 'durationchange') {
      noteDuration(el);
      applyRate(el);
    } else if (event.type === 'playing' || event.type === 'loadedmetadata') {
      applyRate(el);
    }
    scheduleRefresh();
  }

  function noteMedia(el) {
    if (!isMedia(el)) return;
    known.add(el);
    if (!watched.has(el) && !roots.has(el.getRootNode())) {
      // Off-page elements never dispatch events through a document we listen on.
      MEDIA_EVENTS.forEach((type) => el.addEventListener(type, onMediaEvent));
      watched.set(el, () => MEDIA_EVENTS.forEach((type) => el.removeEventListener(type, onMediaEvent)));
    }
  }

  function forget(el) {
    known.delete(el);
    const undo = watched.get(el);
    if (undo) {
      safely(undo);
      watched.delete(el);
    }
  }

  // Wrapping play() is the only way to find media that is never inserted into the page.
  function hookPlay(win) {
    let proto = null;
    try {
      proto = win.HTMLMediaElement.prototype;
    } catch (err) {
      return null;
    }
    const original = proto && proto.play;
    if (typeof original !== 'function') return null;
    let active = true;
    const play = function play() {
      if (active && alive && isMedia(this)) {
        safely(() => {
          noteMedia(this);
          applyRate(this);
        });
      }
      return original.apply(this, arguments);
    };
    proto.play = play;
    return () => {
      // If another script wrapped play() after us, our wrapper stays in its chain as a pass-through.
      active = false;
      if (proto.play === play) proto.play = original;
    };
  }

  function attachRoot(root) {
    if (roots.has(root)) return;
    MEDIA_EVENTS.forEach((type) => root.addEventListener(type, onMediaEvent, true));
    const win = root.nodeType === 9 ? root.defaultView : null;
    const unhook = win ? hookPlay(win) : null;
    // Capture on the window runs before the page's own key handlers, so a handled key doesn't reach them.
    if (win) win.addEventListener('keydown', onKey, true);
    roots.set(root, () => {
      MEDIA_EVENTS.forEach((type) => root.removeEventListener(type, onMediaEvent, true));
      if (unhook) unhook();
      if (win) win.removeEventListener('keydown', onKey, true);
    });
  }

  // Typing into a text field (the page's or the panel's own) never triggers a shortcut.
  function isTyping(event) {
    const node = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    if (!node || node.nodeType !== 1) return false;
    return !!node.isContentEditable || /^(input|textarea|select)$/i.test(node.localName);
  }

  function onKey(event) {
    const key = KEYS[event.key];
    // ⌘ and Ctrl belong to the browser (⌘[ is Back); AltGr, which reports Ctrl+Alt, still types [ ] \ on some layouts.
    if (!alive || !key || event.defaultPrevented || event.metaKey || (event.ctrlKey && !event.altKey)) return;
    if (isTyping(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setRate(key.to !== undefined ? key.to : rate + key.by);
  }

  function discoverRoots() {
    const found = new Set([document]);
    const walk = (root) => {
      const doc = root.ownerDocument || root;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node === host) continue;
        if (node.shadowRoot && !found.has(node.shadowRoot)) {
          found.add(node.shadowRoot);
          walk(node.shadowRoot);
        }
        if (node.localName === 'iframe' || node.localName === 'frame') {
          let inner = null;
          try {
            inner = node.contentDocument;
          } catch (err) {
            inner = null;
          }
          if (inner && !found.has(inner)) {
            found.add(inner);
            walk(inner);
          }
        }
      }
    };
    try {
      walk(document);
    } catch (err) {
      // Keep whatever was found before the failure.
    }
    found.forEach(attachRoot);
    roots.forEach((undo, root) => {
      if (!found.has(root)) {
        safely(undo);
        roots.delete(root);
      }
    });
  }

  function collectMedia() {
    const list = [];
    const inList = new Set();
    const add = (el) => {
      if (!inList.has(el)) {
        inList.add(el);
        list.push(el);
      }
    };
    roots.forEach((undo, root) => {
      try {
        root.querySelectorAll('audio, video').forEach(add);
      } catch (err) {
        // A root from a navigated-away iframe; the next deep scan drops it.
      }
    });
    Array.from(known).forEach((el) => {
      if (inList.has(el)) return;
      if (el.isConnected || !el.paused) add(el);
      else forget(el);
    });
    list.forEach((el) => known.add(el));
    watched.forEach((undo, el) => {
      if (roots.has(el.getRootNode())) {
        safely(undo);
        watched.delete(el);
      }
    });
    return list;
  }

  // ---- Which media item the panel follows -------------------------------------------------------

  function visibleArea(el) {
    if (!el.isConnected) return 0;
    const r = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView || window;
    const w = Math.max(0, Math.min(r.right, view.innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, view.innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  function chooseTarget(list) {
    const has = (el) => !!el && list.indexOf(el) !== -1;
    // Whichever happened last wins: the user picking an item with ‹ ›, or an item starting to play.
    if (has(picked) && (pickedAt >= lastStartedAt || !has(lastStarted))) return picked;
    if (has(lastStarted)) return lastStarted;
    const playing = list.filter((el) => !el.paused);
    let pool = playing.length ? playing : list.filter(hasSource);
    if (!pool.length) pool = list;
    if (has(target) && pool.indexOf(target) !== -1) return target;
    let best = pool[0] || null;
    let bestArea = -1;
    pool.forEach((el) => {
      const area = visibleArea(el);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    });
    return best;
  }

  // ---- Best-effort titles -----------------------------------------------------------------------

  const UI_WORDS = new RegExp(
    '^(play|pause|stop|mute|unmute|volume|settings|full ?screen|exit full ?screen|share|download|copy link|live|' +
      'loading|buffering|next|previous|replay|close|more|menu|captions?|subtitles?|speed|playback speed|quality|' +
      'auto|skip|skip ads?|ad|ads|advertisement|sponsored|watch later|up next|autoplay|picture[- ]in[- ]picture|' +
      'video|audio|media|player|video player|audio player|media player)$',
    'i'
  );
  const GENERIC_FILES = /^(index|playlist|master|manifest|chunklist.*|stream|media|video|audio|file|default)$/i;
  const PREFERRED = 'h1, h2, h3, h4, h5, h6, [role="heading"], figcaption, caption, legend, label, [itemprop="name"]';
  const NOT_TEXT =
    'script, style, noscript, template, button, select, option, textarea, input, svg, audio, video, ' +
    '[role="button"], [role="slider"], [role="menu"], [role="menuitem"], [role="tooltip"], [role="dialog"], ' +
    '[aria-hidden="true"], [hidden]';

  function isTitleLike(text) {
    if (!text || text.length < 2 || text.length > 200) return false;
    if (!/\p{L}/u.test(text)) return false; // timecodes, counters, punctuation
    if (/^[\d\s.,:/×x%-]+$/i.test(text)) return false; // "1.5x", "0:00 / 3:21"
    if (/^[\x20-\x7e]{1,3}$/.test(text)) return false; // "CC", "HD", "4K"
    return !UI_WORDS.test(text);
  }

  // Screen-reader-only text (e.g. "0 seconds of 1 hour") is clipped away or squeezed into a 1px box
  // by an ancestor, so the element's own size and visibility look normal. The walk stops below <body>:
  // its overflow applies to the viewport, so a 0px-tall scrolling body (YouTube) hides nothing.
  function visuallyHidden(node) {
    const doc = node.ownerDocument;
    const view = doc.defaultView || window;
    for (let el = node; el && el.nodeType === 1 && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
      const style = view.getComputedStyle(el);
      if (style.clip && style.clip !== 'auto') return true;
      if (/inset\(\s*50%|circle\(\s*0/.test(style.clipPath)) return true;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const r = el.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) return true;
      }
    }
    return false;
  }

  function isShown(node, box) {
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (
      typeof node.checkVisibility === 'function' &&
      !node.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false;
    }
    // Text drawn on top of the media (controls, captions, tooltips) belongs to the player, not the title.
    const overlaid =
      box.width > 0 &&
      box.height > 0 &&
      r.left >= box.left - 1 &&
      r.right <= box.right + 1 &&
      r.top >= box.top - 1 &&
      r.bottom <= box.bottom + 1;
    if (overlaid) return false;
    // Pushed off the page (left: -9999px and similar).
    const view = node.ownerDocument.defaultView || window;
    if (r.right + view.scrollX < 0 || r.bottom + view.scrollY < 0) return false;
    return !visuallyHidden(node);
  }

  function textIn(container, skip, box, headingsOnly) {
    const headings = container.querySelectorAll(PREFERRED);
    for (let i = 0; i < headings.length; i++) {
      const node = headings[i];
      if (skip.contains(node) || node.contains(skip)) continue;
      const text = clean(node.textContent);
      if (isTitleLike(text) && isShown(node, box)) return text;
    }
    if (headingsOnly) return '';
    const doc = container.ownerDocument || container;
    let budget = 2000;
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        budget -= 1;
        if (budget < 0 || node === skip) return NodeFilter.FILTER_REJECT;
        if (node.nodeType === 1) return node.matches(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!clean(node.data)) continue;
      const holder = node.parentElement;
      if (!holder) continue;
      // Use the whole element's text so "<b>Ep. 4:</b> Title" reads as one title.
      const whole = holder !== container && !holder.contains(skip);
      const text = clean(whole ? holder.textContent : node.data);
      if (isTitleLike(text) && isShown(holder, box)) return text;
    }
    return '';
  }

  // Walk outwards from the media element one container at a time and take the first
  // heading or text found. Stop before a container that also holds another player,
  // because its text is shared and can't tell the players apart.
  function nearbyText(el) {
    const doc = el.ownerDocument;
    const others = mediaList.filter((m) => m !== el && m.isConnected);
    const box = el.getBoundingClientRect();
    let inner = el;
    for (let depth = 0; depth < 12; depth++) {
      const outer = inner.parentNode;
      if (!outer || outer.nodeType === 9) return '';
      if (outer.nodeType === 11 && !outer.host) return '';
      if (others.some((m) => outer.contains(m))) return '';
      const atTop = outer === doc.body || outer === doc.documentElement;
      const text = textIn(outer, inner, box, atTop);
      if (text || atTop) return text;
      inner = outer.nodeType === 11 ? outer.host : outer;
    }
    return '';
  }

  function ownLabel(el) {
    const root = el.getRootNode();
    const ids = clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    const labelledBy =
      typeof root.getElementById === 'function'
        ? ids
            .map((id) => {
              const node = root.getElementById(id);
              return node ? node.textContent : '';
            })
            .join(' ')
        : '';
    return [el.getAttribute('aria-label'), labelledBy, el.getAttribute('title')].map(clean).find(isTitleLike) || '';
  }

  // The page publishes a single "now playing" entry, so only trust it for the item that owns it.
  function sessionTitle(el) {
    let meta = null;
    try {
      meta = el.ownerDocument.defaultView.navigator.mediaSession.metadata;
    } catch (err) {
      meta = null;
    }
    const title = meta ? clean(meta.title) : '';
    if (!title) return '';
    const othersPlaying = mediaList.some((m) => m !== el && !m.paused);
    const owns = mediaList.length <= 1 || el === lastStarted || !el.paused;
    if (!owns || othersPlaying) return '';
    const artist = clean(meta.artist);
    return artist && title.indexOf(artist) === -1 ? title + ' — ' + artist : title;
  }

  function fileName(el) {
    const src = el.currentSrc || el.getAttribute('src') || '';
    if (!src || /^(blob|data|mediastream|mediasource):/i.test(src)) return '';
    try {
      const url = new URL(src, el.baseURI);
      const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
      const name = clean(last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' '));
      if (GENERIC_FILES.test(name) || /^[0-9a-f-]{16,}$/i.test(name)) return '';
      return isTitleLike(name) ? name : '';
    } catch (err) {
      return '';
    }
  }

  function pageTitle(el) {
    return clean(el.ownerDocument.title) || clean(document.title) || location.hostname;
  }

  function computeTitle(el) {
    // With several players, text next to each one tells them apart better than page-wide metadata.
    const steps =
      mediaList.length > 1
        ? [ownLabel, nearbyText, sessionTitle, fileName, pageTitle]
        : [ownLabel, sessionTitle, nearbyText, fileName, pageTitle];
    for (let i = 0; i < steps.length; i++) {
      let text = '';
      try {
        text = steps[i](el);
      } catch (err) {
        text = '';
      }
      if (text) return text.length > 200 ? text.slice(0, 199) + '…' : text;
    }
    return '';
  }

  function titleOf(el) {
    const now = Date.now();
    const cached = titles.get(el);
    if (cached && now - cached.at < TITLE_TTL_MS) return cached.text;
    const text = computeTitle(el) || 'Untitled media';
    titles.set(el, { text, at: now });
    return text;
  }

  // ---- UI ---------------------------------------------------------------------------------------

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  width: 272px; max-width: calc(100vw - 16px); padding: 4px 10px 10px;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #f5f5f7; background: rgba(28, 28, 30, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  -webkit-user-select: none; user-select: none; text-align: left; direction: ltr;
}
.bar { display: flex; align-items: center; gap: 6px; height: 30px; cursor: grab; touch-action: none; }
.bar:active { cursor: grabbing; }
.grip { width: 12px; height: 12px; fill: currentColor; opacity: 0.4; flex: none; }
.brand { flex: 1; font-size: 12px; font-weight: 600; opacity: 0.7; letter-spacing: 0.02em; }
.version { margin-left: 6px; font-size: 11px; font-weight: 400; }
.nav { display: flex; align-items: center; gap: 2px; font-size: 12px; font-variant-numeric: tabular-nums; }
.nav[hidden] { display: none; }
.count { min-width: 30px; text-align: center; opacity: 0.8; }
button {
  font: inherit; color: inherit; margin: 0; border: 0; border-radius: 7px; cursor: pointer;
  background: rgba(255, 255, 255, 0.09);
}
button:hover { background: rgba(255, 255, 255, 0.17); }
button:active { background: rgba(255, 255, 255, 0.25); }
button:disabled { opacity: 0.4; cursor: default; background: rgba(255, 255, 255, 0.09); }
button:focus-visible, input:focus-visible { outline: 2px solid #5ea8ff; outline-offset: 1px; }
.icon { width: 24px; height: 24px; padding: 0; font-size: 17px; line-height: 24px; background: transparent; }
.icon svg { width: 14px; height: 14px; fill: currentColor; vertical-align: middle; }
.meta { margin: 2px 0 10px; min-width: 0; }
.transport { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 10px; }
.skip { flex: none; width: 58px; height: 34px; padding: 0; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.play {
  flex: none; width: 40px; height: 40px; padding: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; background: #f5f5f7; color: #1c1c1e;
}
.play:hover { background: #ffffff; }
.play:disabled { background: #f5f5f7; }
.play svg { width: 16px; height: 16px; fill: currentColor; }
.title {
  font-weight: 600; overflow: hidden; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.sub {
  margin-top: 2px; font-size: 11px; opacity: 0.65; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.speed { display: flex; gap: 6px; margin-bottom: 8px; }
.step { flex: none; width: 40px; height: 34px; padding: 0; font-size: 19px; }
.readout, .entry {
  flex: 1; min-width: 0; height: 34px; padding: 0 8px; text-align: center;
  font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.entry {
  font-family: inherit; border: 0; border-radius: 7px; outline: none;
  background: #f5f5f7; color: #1c1c1e; -webkit-user-select: text; user-select: text;
}
.readout[hidden], .entry[hidden] { display: none; }
.presets { display: flex; gap: 4px; }
.presets button { flex: 1; min-width: 0; height: 26px; padding: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.presets button[aria-pressed="true"] { background: #5ea8ff; color: #0b1b2e; font-weight: 600; }
.note { margin-top: 8px; font-size: 11px; color: #ffd28a; }
.note[hidden] { display: none; }
.panel[hidden] { display: none; }
.pill {
  display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 999px;
  font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #f5f5f7; background: rgba(28, 28, 30, 0.96); border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3); cursor: grab; touch-action: none;
  -webkit-user-select: none; user-select: none; white-space: nowrap;
}
.pill:active { cursor: grabbing; }
.pill:focus-visible { outline: 2px solid #5ea8ff; outline-offset: 2px; }
.pill[hidden] { display: none; }
.pill-name { opacity: 0.7; font-size: 12px; }
.pill-rate { font-variant-numeric: tabular-nums; }
.glow {
  position: fixed; pointer-events: none; border: 3px solid #5ea8ff; border-radius: 8px;
  box-shadow: 0 0 0 4px rgba(94, 168, 255, 0.35), 0 0 24px rgba(94, 168, 255, 0.5);
  animation: glow-in 0.15s ease-out;
}
.glow[hidden] { display: none; }
@keyframes glow-in { from { opacity: 0; } to { opacity: 1; } }
`;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PLAY_PATH = 'M4.5 2.3v11.4c0 .6.6.9 1.1.6l8.6-5.7c.4-.3.4-.9 0-1.2L5.6 1.7c-.5-.3-1.1 0-1.1.6z';
  const PAUSE_PATH = 'M3.5 2h3v12h-3zM9.5 2h3v12h-3z';
  const MINIMIZE_PATH = 'M3 11.5h10V13H3z';
  const GRIP_PATH = 'M4 1h3v3H4zM9 1h3v3H9zM4 6.5h3v3H4zM9 6.5h3v3H9zM4 12h3v3H4zM9 12h3v3H9z';

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeIcon(d, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return { svg, path };
  }

  function button(className, text, label, onClick) {
    const node = make('button', className, text);
    node.type = 'button';
    if (label) {
      node.setAttribute('aria-label', label);
      node.title = label;
    }
    node.addEventListener('click', onClick);
    return node;
  }

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  const host = document.createElement('speed-ctl');
  // Inline !important beats the page's stylesheets; the popover UA styles are overridden too.
  host.style.cssText = [
    'all: initial',
    'display: block',
    'position: fixed',
    'z-index: 2147483647',
    'left: 0',
    'top: 0',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'background: transparent',
    'overflow: visible',
  ]
    .map((rule) => rule + ' !important')
    .join('; ');
  // A manual popover sits in the browser's top layer: above every z-index, and above
  // a fullscreen element once it is shown again after fullscreen starts.
  const canPopover = typeof host.showPopover === 'function';
  if (canPopover) host.setAttribute('popover', 'manual');

  const shadow = host.attachShadow({ mode: 'open' });
  try {
    // Constructed stylesheets aren't blocked by a page's style-src CSP; <style> is the fallback.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (err) {
    shadow.append(make('style', null, CSS));
  }

  const ui = {};
  ui.panel = make('div', 'panel');
  ui.panel.setAttribute('role', 'region');
  ui.panel.setAttribute('aria-label', 'Playing Speed Adjuster');

  ui.bar = make('div', 'bar');
  ui.bar.title = 'Drag to move';
  ui.nav = make('span', 'nav');
  ui.count = make('span', 'count');
  ui.nav.append(
    button('icon', '‹', 'Previous media on this page', () => cycle(-1)),
    ui.count,
    button('icon', '›', 'Next media on this page', () => cycle(1))
  );
  const minimizeButton = button('icon', null, 'Minimize', () => setMinimized(true));
  minimizeButton.append(makeIcon(MINIMIZE_PATH).svg);
  const brand = make('span', 'brand', 'PSA');
  brand.append(make('span', 'version', VERSION));
  ui.bar.append(
    makeIcon(GRIP_PATH, 'grip').svg,
    brand,
    ui.nav,
    minimizeButton,
    button('icon', '×', 'Close (click the bookmarklet again to reopen)', () => destroy())
  );

  ui.title = make('div', 'title');
  ui.sub = make('div', 'sub');
  const meta = make('div', 'meta');
  meta.append(ui.title, ui.sub);

  const playIcon = makeIcon(PLAY_PATH);
  ui.play = button('play', null, 'Play', () => togglePlay());
  ui.play.append(playIcon.svg);
  ui.back = button('skip', '−' + SKIP_BACK + 's', 'Back ' + SKIP_BACK + ' seconds', () => skip(-SKIP_BACK));
  ui.ahead = button('skip', '+' + SKIP_AHEAD + 's', 'Forward ' + SKIP_AHEAD + ' seconds', () => skip(SKIP_AHEAD));
  const transport = make('div', 'transport');
  transport.append(ui.back, ui.play, ui.ahead);

  ui.readout = button('readout', '', 'Click to type a speed. Keys: [ slower, ] faster, \\ 1.5×', () => openEntry());
  ui.entry = make('input', 'entry');
  ui.entry.type = 'text';
  ui.entry.inputMode = 'decimal';
  ui.entry.hidden = true;
  ui.entry.setAttribute('aria-label', 'Speed, from ' + MIN_RATE + ' to ' + MAX_RATE);
  const speed = make('div', 'speed');
  speed.append(
    button('step', '−', 'Slower', () => setRate(rate - STEP)),
    ui.readout,
    ui.entry,
    button('step', '+', 'Faster', () => setRate(rate + STEP))
  );

  const presetRow = make('div', 'presets');
  ui.presets = PRESETS.map((value) => {
    const node = button('', String(value), value + '× speed', () => setRate(value));
    presetRow.append(node);
    return { node, value };
  });

  ui.note = make('div', 'note');
  ui.note.hidden = true;
  ui.note.setAttribute('role', 'status');

  ui.panel.append(ui.bar, meta, transport, speed, presetRow, ui.note);

  // The minimized panel: click to expand, drag to move.
  ui.pill = make('div', 'pill');
  ui.pill.tabIndex = 0;
  ui.pill.setAttribute('role', 'button');
  ui.pill.setAttribute('aria-label', 'Expand the PSA panel');
  ui.pill.title = 'Click to expand, drag to move';
  ui.pillRate = make('span', 'pill-rate');
  ui.pill.append(make('span', 'pill-name', 'PSA'), ui.pillRate);
  ui.pill.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setMinimized(false);
    }
  });

  // Outline drawn over the page around the player chosen with ‹ ›.
  ui.glow = make('div', 'glow');
  ui.glow.hidden = true;

  ui.panel.hidden = minimized;
  ui.pill.hidden = !minimized;
  shadow.append(ui.panel, ui.pill, ui.glow);

  // Keep the panel's keystrokes and clicks away from page shortcuts (YouTube's "k", digits, etc.).
  ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(
    (type) => shadow.addEventListener(type, (event) => event.stopPropagation())
  );
  // Clicking a button shouldn't move keyboard focus off the page, so page shortcuts keep working.
  ui.panel.addEventListener('mousedown', (event) => {
    if (event.target.closest && event.target.closest('button')) event.preventDefault();
  });

  function showNote(text) {
    setText(ui.note, text);
    ui.note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      ui.note.hidden = true;
    }, 4000);
  }

  function formatRate(value) {
    return value.toFixed(2) + '×';
  }

  function parseRate(text) {
    const match = clean(text).replace(',', '.').match(/^(\d*\.?\d+)\s*(%|x|×)?$/i);
    if (!match) return NaN;
    const value = parseFloat(match[1]);
    return match[2] === '%' ? value / 100 : value;
  }

  function openEntry() {
    ui.entry.value = String(rate);
    ui.readout.hidden = true;
    ui.entry.hidden = false;
    ui.entry.focus();
    ui.entry.select();
  }

  function closeEntry(commit) {
    if (ui.entry.hidden) return;
    const value = parseRate(ui.entry.value);
    ui.entry.hidden = true;
    ui.readout.hidden = false;
    if (!commit) return;
    if (isFinite(value) && value > 0) setRate(value);
    else showNote('Type a speed from ' + MIN_RATE + ' to ' + MAX_RATE + ', e.g. 1.6');
  }

  ui.entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') closeEntry(true);
    else if (event.key === 'Escape') closeEntry(false);
  });
  ui.entry.addEventListener('blur', () => closeEntry(true));

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s % 60);
  }

  function statusOf(el) {
    const parts = [];
    if (!el.isConnected) parts.push('Off-page');
    const loaded = hasSource(el);
    if (!loaded) parts.push('Not loaded');
    else if (el.ended) parts.push('Ended');
    else parts.push(el.paused ? 'Paused' : 'Playing');
    if (loaded && isLive(el)) {
      parts.push('Live · normal speed');
    } else if (loaded) {
      const at = clock(el.currentTime);
      const total = clock(el.duration);
      if (at) parts.push(total ? at + ' / ' + total : at);
    }
    if (locked.has(el)) parts.push('speed locked');
    return parts.join(' · ');
  }

  function render() {
    if (!alive) return;
    const list = mediaList;
    const el = chooseTarget(list);
    target = el;
    ui.nav.hidden = list.length < 2;
    setText(ui.count, el ? list.indexOf(el) + 1 + '/' + list.length : '');
    if (el) {
      const title = titleOf(el);
      setText(ui.title, title);
      if (ui.title.title !== title) ui.title.title = title;
      setText(ui.sub, statusOf(el));
    } else {
      setText(ui.title, 'No audio or video found yet');
      ui.title.title = '';
      setText(ui.sub, 'Waiting for the page to add a player…');
    }
    const playing = !!el && !el.paused && !el.ended;
    ui.play.disabled = !el || (el.paused && !hasSource(el));
    const cannotSkip = !el || !seekRange(el);
    ui.back.disabled = cannotSkip;
    ui.ahead.disabled = cannotSkip;
    const label = playing ? 'Pause' : 'Play';
    if (ui.play.getAttribute('aria-label') !== label) {
      ui.play.setAttribute('aria-label', label);
      ui.play.title = label;
      playIcon.path.setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH);
    }
    setText(ui.readout, formatRate(rate));
    setText(ui.pillRate, formatRate(rate));
    ui.presets.forEach(({ node, value }) => {
      const pressed = String(sameRate(value, rate));
      if (node.getAttribute('aria-pressed') !== pressed) node.setAttribute('aria-pressed', pressed);
    });
  }

  // ---- Actions ----------------------------------------------------------------------------------

  function togglePlay() {
    const el = target;
    if (!el) return;
    if (el.paused || el.ended) {
      markStarted(el);
      applyRate(el);
      let result = null;
      try {
        result = el.play();
      } catch (err) {
        showNote('Could not start playback.');
      }
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          if (err && err.name === 'AbortError') return;
          showNote(
            err && err.name === 'NotAllowedError'
              ? 'The browser blocked playback. Start it once with the page’s own button.'
              : 'Could not start playback.'
          );
        });
      }
    } else {
      el.pause();
    }
    scheduleRefresh();
  }

  // The part of the media that can be jumped to: all of it for a normal file, or the
  // buffered window of a live stream that allows rewinding. Null until it has loaded.
  function seekRange(el) {
    if (isFinite(el.duration) && el.duration > 0) return { start: 0, end: el.duration };
    const ranges = el.seekable;
    if (ranges && ranges.length) return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
    return null;
  }

  function skip(seconds) {
    const el = target;
    const range = el && seekRange(el);
    if (!range) return;
    try {
      el.currentTime = Math.min(range.end, Math.max(range.start, el.currentTime + seconds));
    } catch (err) {
      showNote('This player doesn’t allow skipping.');
    }
    scheduleRefresh();
  }

  function cycle(delta) {
    const list = mediaList;
    if (list.length < 2) return;
    const index = Math.max(0, list.indexOf(target));
    picked = list[(index + delta + list.length) % list.length];
    pickedAt = Date.now();
    render();
    highlight(picked);
  }

  function setMinimized(value) {
    minimized = value;
    save('min', value);
    ui.panel.hidden = value;
    ui.pill.hidden = !value;
    if (value) ui.glow.hidden = true;
    // The same top-left corner is kept; clamping keeps the larger panel on screen when it expands.
    if (desired) placeAt(desired.x, desired.y);
    if (!value) render();
  }

  // ---- Highlighting the chosen player -----------------------------------------------------------

  // The media element itself, or its nearest ancestor with a visible box (a hidden <audio> behind a custom UI).
  function visibleNode(el) {
    let node = el;
    for (let depth = 0; node && depth < 8; depth++) {
      if (node.nodeType === 1) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return node;
      }
      const parent = node.parentNode;
      node = parent && parent.nodeType === 11 ? parent.host : parent;
      if (node && node.nodeType === 9) return null;
    }
    return null;
  }

  // Its box in this window's coordinates, adding the offsets of any same-origin iframes it sits in.
  function viewportRect(node) {
    const r = node.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let win = node.ownerDocument.defaultView;
    while (win && win !== window) {
      let frame = null;
      try {
        frame = win.frameElement;
      } catch (err) {
        frame = null;
      }
      if (!frame) break;
      const f = frame.getBoundingClientRect();
      left += f.left + frame.clientLeft;
      top += f.top + frame.clientTop;
      win = frame.ownerDocument.defaultView;
    }
    return { left, top, width: r.width, height: r.height };
  }

  function highlight(el) {
    if (!el.isConnected) {
      showNote('This one plays off the page, so there is no player to show.');
      return;
    }
    const node = visibleNode(el);
    if (!node) return;
    const box = viewportRect(node);
    const view = viewport();
    const offscreen =
      box.top + box.height < 0 || box.top > view.height || box.left + box.width < 0 || box.left > view.width;
    if (offscreen) safely(() => node.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    // Follow the player while the page scrolls, then fade away.
    glowUntil = Date.now() + (offscreen ? 2400 : 1500);
    ui.glow.hidden = false;
    cancelAnimationFrame(glowFrame);
    const follow = () => {
      if (!alive || minimized || Date.now() > glowUntil || !node.isConnected) {
        ui.glow.hidden = true;
        return;
      }
      const now = viewportRect(node);
      ui.glow.style.left = now.left - 4 + 'px';
      ui.glow.style.top = now.top - 4 + 'px';
      ui.glow.style.width = now.width + 8 + 'px';
      ui.glow.style.height = now.height + 8 + 'px';
      glowFrame = requestAnimationFrame(follow);
    };
    follow();
  }

  // ---- Position and dragging --------------------------------------------------------------------

  let desired = null;

  function viewport() {
    const root = document.documentElement;
    return {
      width: (root && root.clientWidth) || window.innerWidth,
      height: window.innerHeight,
    };
  }

  function placeAt(x, y) {
    const view = viewport();
    const maxX = Math.max(0, view.width - (host.offsetWidth || 272));
    const maxY = Math.max(0, view.height - (host.offsetHeight || 215));
    const left = Math.round(Math.min(Math.max(0, x), maxX));
    const top = Math.round(Math.min(Math.max(0, y), maxY));
    host.style.setProperty('left', left + 'px', 'important');
    host.style.setProperty('top', top + 'px', 'important');
    return { x: left, y: top };
  }

  // Both the panel's top bar and the minimized pill drag the panel. A press that doesn't move
  // (less than 4px) is a click, which expands the pill.
  let drag = null;
  [ui.bar, ui.pill].forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const box = host.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        handle,
        x: event.clientX,
        y: event.clientY,
        dx: event.clientX - box.left,
        dy: event.clientY - box.top,
        moved: false,
      };
      safely(() => handle.setPointerCapture(event.pointerId));
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 4) return;
      drag.moved = true;
      desired = placeAt(event.clientX - drag.dx, event.clientY - drag.dy);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const ended = drag;
      drag = null;
      if (ended.moved) save('pos', desired);
      else if (ended.handle === ui.pill && event.type === 'pointerup') setMinimized(false);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  });

  function onResize() {
    if (desired) placeAt(desired.x, desired.y);
  }

  // ---- Mounting ---------------------------------------------------------------------------------

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isPopoverOpen() {
    try {
      return host.matches(':popover-open');
    } catch (err) {
      return true;
    }
  }

  function mount() {
    let parent = document.documentElement;
    const fs = fullscreenElement();
    // Without popover support, a fullscreen container can only show the panel from inside it.
    // A bare <video> can't hold children, so there the panel stays hidden until fullscreen ends.
    if (!canPopover && fs && !isMedia(fs) && fs.localName !== 'iframe') parent = fs;
    if (!parent) return;
    if (host.parentNode !== parent) parent.append(host);
    if (canPopover && !isPopoverOpen()) safely(() => host.showPopover());
  }

  function onFullscreenChange() {
    // Re-showing moves the popover above the element that just entered the top layer.
    if (canPopover) safely(() => host.hidePopover());
    mount();
    if (desired) placeAt(desired.x, desired.y);
  }

  // ---- Lifecycle --------------------------------------------------------------------------------

  function refresh() {
    mediaList = collectMedia();
    mediaList.forEach((el) => {
      noteDuration(el);
      applyRate(el);
    });
    render();
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      if (alive) refresh();
    }, 0);
  }

  function tick() {
    if (!alive) return;
    if (tickCount % DEEP_SCAN_EVERY === 0) discoverRoots();
    tickCount += 1;
    mount();
    refresh();
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    clearTimeout(noteTimer);
    cancelAnimationFrame(glowFrame);
    roots.forEach((undo) => safely(undo));
    roots.clear();
    watched.forEach((undo) => safely(undo));
    watched.clear();
    locked.forEach((undo) => safely(undo));
    locked.clear();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    if (canPopover) safely(() => host.hidePopover());
    host.remove();
    if (window[NS] === api) delete window[NS];
  }

  const api = {
    destroy,
    // Read-only snapshot for test/test-page.html and debugging.
    inspect: () => ({
      version: VERSION,
      rate,
      minimized,
      target,
      media: mediaList.map((el) => ({ el, title: titleOf(el), locked: locked.has(el), live: isLive(el) })),
    }),
  };
  window[NS] = api;

  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  tick();
  const start = saved.pos;
  desired =
    start && isFinite(start.x) && isFinite(start.y)
      ? { x: start.x, y: start.y }
      : { x: viewport().width - (host.offsetWidth || 272) - 16, y: 16 };
  placeAt(desired.x, desired.y);
  timer = setInterval(tick, TICK_MS);
})();
