// PSA for Firefox: keeps settings and positions in extension storage, and passes messages between the
// frames of a tab and the toolbar button.
//
// The toolbar button shows the popup (popup.html) by default, which says why PSA isn't running in the tab: a
// site in the list of sites to skip, or a page add-ons can't reach. A tab's page that starts PSA turns the popup
// off for that tab, so the button shows and hides PSA's panel instead. Firefox puts the popup back when the
// tab moves to another page.
//
// Everything is kept per site, meaning the origin of the tab's page, so a player embedded from another
// site follows the speed of the page it is on. Storage keys:
//   options          { defaultRate, shortcuts, autoShow, excluded }   set on the options page
//   site:<origin>    { rate, pos, fsPos, channels }                     speed, panel position, and in fullscreen;
//                    channels: { "<channel>": [speed, name, savedAt] }  YouTube channels with a speed of their own
//   resume:<origin>  { "<page> <length>": [seconds, savedAt] }          where recordings were left
// A page can only reach its own site's values, and frames embedded from other sites only the speed.
// Private windows leave nothing behind: they read the saved values, but their changes aren't saved.

// DEFAULT_OPTIONS comes from defaults.js, loaded first.
const RESUME_KEEP = 100;
const NAME_LIMIT = 2000; // characters in a saved place's name ("<page> <length>")
const CHANNEL_KEEP = 200;

// Storage writes are read-modify-write, so they run one at a time.
let queue = Promise.resolve();
const serially = (task) => (queue = queue.then(task, task));

function siteOf(sender) {
  try {
    const url = new URL(sender.tab.url);
    return url.origin === 'null' ? url.protocol : url.origin;
  } catch (err) {
    return '';
  }
}

async function loadOptions() {
  const { options } = await browser.storage.local.get('options');
  return { ...DEFAULT_OPTIONS, ...options };
}

// An entry in the list of sites to leave alone may be a whole address, such as https://meet.google.com/abc
// pasted from the address bar, or *.example.com: only its host name counts.
const hostOf = (entry) =>
  entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^\*\./, '');

function isExcluded(list, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (err) {
    return false;
  }
  return String(list || '')
    .split(/[\s,]+/)
    .map(hostOf)
    .filter(Boolean)
    .some((site) => host === site || host.endsWith('.' + site));
}

// The host name a page's site is skipped by: www.example.com and example.com are the same site.
function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return '';
  }
}

const usePopup = (tabId, on) => browser.action.setPopup({ tabId, popup: on ? null : '' }).catch(() => {});

const isRate = (value) => Number.isFinite(value) && value >= 0.25 && value <= 4;
const isSpot = (value) => !!value && Number.isFinite(value.x) && Number.isFinite(value.y);

const handlers = {
  // A frame's PSA asks for this site's values when it starts.
  async init(message, sender) {
    const site = siteOf(sender);
    const options = await loadOptions();
    if (!site || isExcluded(options.excluded, sender.tab.url)) return { excluded: true };
    const top = sender.frameId === 0;
    if (top) usePopup(sender.tab.id, false);
    const stored = await browser.storage.local.get(['site:' + site, 'resume:' + site]);
    const siteValues = stored['site:' + site];
    return {
      top,
      fresh: !siteValues,
      settings: {
        defaultRate: options.defaultRate,
        shortcuts: options.shortcuts,
        autoShow: options.autoShow,
        rate: siteValues && siteValues.rate,
        // Only the page itself gets its panel position and saved places, not frames embedded from elsewhere.
        pos: top && siteValues ? siteValues.pos : undefined,
        fsPos: top && siteValues ? siteValues.fsPos : undefined,
        channels: top && siteValues ? siteValues.channels : undefined,
      },
      positions: top ? stored['resume:' + site] || {} : {},
    };
  },

  async save(message, sender) {
    const site = siteOf(sender);
    const top = sender.frameId === 0;
    let value = null;
    if (message.key === 'rate' && isRate(message.value)) value = message.value;
    else if ((message.key === 'pos' || message.key === 'fsPos') && top && isSpot(message.value)) {
      value = { x: message.value.x, y: message.value.y };
    }
    if (!site || value === null) return;
    if (!sender.tab.incognito) {
      await serially(async () => {
        const key = 'site:' + site;
        const { [key]: values } = await browser.storage.local.get(key);
        await browser.storage.local.set({ [key]: { ...values, [message.key]: value } });
      });
    }
    // Every frame of the tab follows a new speed, whichever frame it was changed in. The frame it came from
    // knows its own mark (`from`) and ignores it.
    if (message.key === 'rate') {
      const from = typeof message.from === 'string' ? message.from.slice(0, 32) : '';
      browser.tabs.sendMessage(sender.tab.id, { type: 'rate', rate: value, from }).catch(() => {});
    }
  },

  // A channel's own speed (an entry), or none (null), from the page itself; the one changed longest ago goes
  // once there are more than CHANNEL_KEEP.
  async channel(message, sender) {
    const site = siteOf(sender);
    const id = typeof message.id === 'string' ? message.id.slice(0, 100) : '';
    const entry = message.entry;
    const valid =
      entry === null ||
      (Array.isArray(entry) && isRate(entry[0]) && typeof entry[1] === 'string' && Number.isFinite(entry[2]));
    if (!site || !id || !valid || sender.frameId !== 0 || sender.tab.incognito) return;
    await serially(async () => {
      const key = 'site:' + site;
      const { [key]: values = {} } = await browser.storage.local.get(key);
      const channels = { ...values.channels };
      if (entry) channels[id] = [entry[0], entry[1].slice(0, 100), entry[2]];
      else delete channels[id];
      const ids = Object.keys(channels).sort((a, b) => channels[a][2] - channels[b][2]);
      ids.slice(0, Math.max(0, ids.length - CHANNEL_KEEP)).forEach((old) => delete channels[old]);
      await browser.storage.local.set({ [key]: { ...values, channels } });
    });
  },

  async positions(message, sender) {
    const site = siteOf(sender);
    if (!site || sender.frameId !== 0 || sender.tab.incognito) return;
    const remove = Array.isArray(message.remove) ? message.remove.slice(0, RESUME_KEEP) : [];
    const set = Object.entries(message.set && typeof message.set === 'object' ? message.set : {}).slice(0, RESUME_KEEP);
    await serially(async () => {
      const key = 'resume:' + site;
      const { [key]: stored = {} } = await browser.storage.local.get(key);
      remove.forEach((name) => {
        if (typeof name === 'string') delete stored[name];
      });
      set.forEach(([name, entry]) => {
        if (name.length <= NAME_LIMIT && Array.isArray(entry) && Number.isFinite(entry[0]) && Number.isFinite(entry[1])) {
          stored[name] = [entry[0], entry[1]];
        }
      });
      const names = Object.keys(stored).sort((a, b) => stored[a][1] - stored[b][1]);
      names.slice(0, Math.max(0, names.length - RESUME_KEEP)).forEach((name) => delete stored[name]);
      await browser.storage.local.set({ [key]: stored });
    });
  },

  // Something started playing in an embedded frame: the page's own PSA shows its pill, and names the frame's
  // site in its panel when the page has no player of its own.
  async started(message, sender) {
    let site = '';
    try {
      site = new URL(sender.url).hostname.replace(/^www\./, '');
    } catch (err) {
      site = '';
    }
    browser.tabs.sendMessage(sender.tab.id, { type: 'started', site }, { frameId: 0 }).catch(() => {});
  },

  // "Turn off PSA on this site" in the panel: the site joins the list of sites to skip, and PSA stops in every
  // frame of the tab. The toolbar popup can turn it back on.
  async exclude(message, sender) {
    const host = siteHost(sender.tab.url);
    if (sender.frameId !== 0 || !host) return;
    await serially(async () => {
      const options = await loadOptions();
      if (isExcluded(options.excluded, sender.tab.url)) return;
      const excluded = [String(options.excluded || '').trim(), host].filter(Boolean).join('\n');
      await browser.storage.local.set({ options: { ...options, excluded } });
    });
    browser.tabs.sendMessage(sender.tab.id, { type: 'stop' }).catch(() => {});
    usePopup(sender.tab.id, true);
    await browser.action.setBadgeText({ tabId: sender.tab.id, text: '' });
  },

  // Time saved by playing faster than 1×, added to today's total (by the computer's clock). Kept for about a
  // year of days with any; private windows save nothing.
  async saved(message, sender) {
    const seconds = Math.round(Number(message.seconds));
    if (sender.tab.incognito || !(seconds >= 1 && seconds <= 3600)) return;
    const now = new Date();
    const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
    await serially(async () => {
      const { stats } = await browser.storage.local.get('stats');
      const days = { ...(stats && stats.days) };
      days[day] = (Number(days[day]) || 0) + seconds;
      const kept = Object.keys(days).sort().slice(-400);
      await browser.storage.local.set({ stats: { days: Object.fromEntries(kept.map((key) => [key, days[key]])) } });
    });
  },

  async badge(message, sender) {
    if (sender.frameId !== 0 || !isRate(message.rate)) return;
    await browser.action.setBadgeText({ tabId: sender.tab.id, text: String(message.rate) });
  },
};

// The toolbar popup asks about the tab it was opened for.
const popupHandlers = {
  // Why PSA isn't running in the tab, if it isn't: the site is one to skip, the page loaded while it was (or
  // PSA was turned off there) so it needs a reload, or add-ons can't reach the page. Where it is running after
  // all, the popup goes away again for the tab.
  async status(message) {
    const tab = await browser.tabs.get(message.tabId);
    const options = await loadOptions();
    const site = siteHost(tab.url);
    if (site && isExcluded(options.excluded, tab.url)) return { state: 'excluded', site };
    const reply = await browser.tabs.sendMessage(tab.id, { type: 'ping' }, { frameId: 0 }).then(
      (running) => (running ? 'running' : 'reload'),
      () => 'blocked'
    );
    if (reply === 'running') usePopup(tab.id, false);
    return { state: reply, site };
  },

  // "Turn back on": every entry in the list of sites to skip that covers the tab's site comes out.
  async include(message) {
    const tab = await browser.tabs.get(message.tabId);
    await serially(async () => {
      const options = await loadOptions();
      const host = (() => {
        try {
          return new URL(tab.url).hostname;
        } catch (err) {
          return '';
        }
      })();
      const excluded = String(options.excluded || '')
        .split(/[\s,]+/)
        .filter((entry) => {
          const site = hostOf(entry);
          return site && !(host === site || host.endsWith('.' + site));
        })
        .join('\n');
      await browser.storage.local.set({ options: { ...options, excluded } });
    });
  },
};

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (sender.url && sender.url.startsWith(browser.runtime.getURL('popup.html'))) {
    return Object.hasOwn(popupHandlers, message.type) ? popupHandlers[message.type](message).catch(() => undefined) : undefined;
  }
  const handler = sender.tab && Object.hasOwn(handlers, message.type) ? handlers[message.type] : null;
  return handler ? handler(message, sender).catch(() => undefined) : undefined;
});

// Only where the popup is off for the tab, so PSA was running there.
browser.action.onClicked.addListener((tab) => {
  browser.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 }).catch(() => usePopup(tab.id, true));
});

browser.action.setBadgeBackgroundColor({ color: '#5ea8ff' });
browser.action.setBadgeTextColor({ color: '#0b1b2e' });

// A welcome page with a sample to try PSA on, once, when it is installed (not on updates, and not for a
// temporary install while testing).
browser.runtime.onInstalled.addListener(({ reason, temporary }) => {
  if (reason === 'install' && !temporary) browser.tabs.create({ url: 'welcome.html' }).catch(() => {});
});
