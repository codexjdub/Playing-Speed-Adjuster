// PSA for Firefox: keeps settings and positions in extension storage, and passes messages between the
// frames of a tab and the toolbar button.
//
// Everything is kept per site, meaning the origin of the tab's page, so a player embedded from another
// site follows the speed of the page it is on. Storage keys:
//   options          { defaultRate, shortcuts, autoShow, excluded }   set on the options page
//   site:<origin>    { rate, pos, fsPos }                               speed, panel position, and in fullscreen
//   resume:<origin>  { "<page> <length>": [seconds, savedAt] }          where recordings were left
// A page can only reach its own site's values, and frames embedded from other sites only the speed.
// Private windows leave nothing behind: they read the saved values, but their changes aren't saved.

const DEFAULT_OPTIONS = { defaultRate: 1, shortcuts: true, autoShow: true, excluded: '' };
const RESUME_KEEP = 100;
const NAME_LIMIT = 2000; // characters in a saved place's name ("<page> <length>")

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

const isRate = (value) => Number.isFinite(value) && value >= 0.25 && value <= 4;
const isSpot = (value) => !!value && Number.isFinite(value.x) && Number.isFinite(value.y);

const handlers = {
  // A frame's PSA asks for this site's values when it starts.
  async init(message, sender) {
    const site = siteOf(sender);
    const options = await loadOptions();
    if (!site || isExcluded(options.excluded, sender.tab.url)) return { excluded: true };
    const top = sender.frameId === 0;
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

  // Something started playing in an embedded frame: the page's own PSA shows its pill.
  async started(message, sender) {
    browser.tabs.sendMessage(sender.tab.id, { type: 'started' }, { frameId: 0 }).catch(() => {});
  },

  async badge(message, sender) {
    if (sender.frameId !== 0 || !isRate(message.rate)) return;
    await browser.action.setBadgeText({ tabId: sender.tab.id, text: String(message.rate) });
  },
};

browser.runtime.onMessage.addListener((message, sender) => {
  const handler = message && sender.tab && Object.hasOwn(handlers, message.type) ? handlers[message.type] : null;
  return handler ? handler(message, sender).catch(() => undefined) : undefined;
});

browser.action.onClicked.addListener((tab) => {
  browser.tabs.sendMessage(tab.id, { type: 'toggle' }, { frameId: 0 }).catch(() => {});
});

browser.action.setBadgeBackgroundColor({ color: '#5ea8ff' });
browser.action.setBadgeTextColor({ color: '#0b1b2e' });
