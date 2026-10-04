// PSA for Firefox: keeps settings and positions in extension storage, and passes messages between the
// frames of a tab and the toolbar button.
//
// Everything is kept per site, meaning the origin of the tab's page, so a player embedded from another
// site follows the speed of the page it is on. Storage keys:
//   options          { defaultRate, shortcuts, autoShow, excluded }   set on the options page
//   site:<origin>    { rate, pos }                                      speed and panel position
//   resume:<origin>  { "<page> <length>": [seconds, savedAt] }          where recordings were left
// A page can only reach its own site's values, and frames embedded from other sites only the speed.

const DEFAULT_OPTIONS = { defaultRate: 1, shortcuts: true, autoShow: true, excluded: '' };
const RESUME_KEEP = 100;

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

function isExcluded(list, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (err) {
    return false;
  }
  return String(list || '')
    .split(/[\s,]+/)
    .map((site) => site.trim().toLowerCase())
    .filter(Boolean)
    .some((site) => host === site || host.endsWith('.' + site));
}

const isRate = (value) => typeof value === 'number' && value >= 0.25 && value <= 4;

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
      },
      positions: top ? stored['resume:' + site] || {} : {},
    };
  },

  async save(message, sender) {
    const site = siteOf(sender);
    const top = sender.frameId === 0;
    const valid =
      (message.key === 'rate' && isRate(message.value)) ||
      (message.key === 'pos' && top && message.value && isFinite(message.value.x) && isFinite(message.value.y));
    if (!site || !valid) return;
    await serially(async () => {
      const key = 'site:' + site;
      const { [key]: values } = await browser.storage.local.get(key);
      await browser.storage.local.set({ [key]: { ...values, [message.key]: message.value } });
    });
    // Every frame of the tab follows a new speed, whichever frame it was changed in.
    if (message.key === 'rate') browser.tabs.sendMessage(sender.tab.id, { type: 'rate', rate: message.value }).catch(() => {});
  },

  async positions(message, sender) {
    const site = siteOf(sender);
    if (!site || sender.frameId !== 0) return;
    await serially(async () => {
      const key = 'resume:' + site;
      const { [key]: stored = {} } = await browser.storage.local.get(key);
      (Array.isArray(message.remove) ? message.remove : []).forEach((name) => delete stored[name]);
      Object.entries(message.set || {}).forEach(([name, entry]) => {
        if (Array.isArray(entry) && isFinite(entry[0]) && isFinite(entry[1])) stored[name] = [entry[0], entry[1]];
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
