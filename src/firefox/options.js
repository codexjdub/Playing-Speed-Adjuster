// The settings page: saves each change as it is made.
// DEFAULT_OPTIONS comes from defaults.js, loaded first.
const field = (id) => document.getElementById(id);
const status = field('status');
const rateField = field('defaultRate');

// A short message at the bottom of the page, read out by screen readers.
let statusTimer = 0;
function show(text) {
  status.textContent = text;
  status.classList.add('shown');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('shown'), 2200);
}

// ---- Sites to skip, shown as chips. They are stored as one host name per line, which background.js reads. ----
// An entry may be typed as a whole address, such as https://meet.google.com/abc, or *.example.com: only its
// host name is kept, without www. (a site includes its subdomains, so example.com covers www.example.com).
const hostOf = (entry) =>
  String(entry)
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '');
const listOf = (text) => [...new Set(String(text || '').split(/[\s,]+/).map(hostOf).filter(Boolean))];
let skipped = [];

function showChips() {
  const chips = skipped.map((site) => {
    const chip = make('span', 'chip');
    const remove = make('button', null, '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Stop skipping ' + site);
    remove.title = 'Stop skipping ' + site;
    remove.addEventListener('click', () => {
      skipped = skipped.filter((other) => other !== site);
      showChips();
      save('PSA is back on for ' + site + '.');
      field('newSite').focus();
    });
    chip.append(make('span', null, site), remove);
    return chip;
  });
  field('chips').replaceChildren(...(chips.length ? chips : [make('span', 'none', 'No sites yet.')]));
}

function addSite() {
  const input = field('newSite');
  const sites = listOf(input.value);
  if (!sites.length) {
    input.focus();
    return;
  }
  const added = sites.filter((site) => !skipped.includes(site));
  skipped = [...skipped, ...added];
  input.value = '';
  showChips();
  save(added.length ? 'Skipping ' + added.join(', ') + '.' : 'Already skipped.');
}

// ---- Default speed ----
const clampRate = (rate) => Math.min(4, Math.max(0.25, Math.round(rate * 100) / 100));

// − and + move to the next quarter (1.1 → 1.25 → 1.5), like the panel's presets.
function stepRate(direction) {
  const rate = Number(rateField.value) || DEFAULT_OPTIONS.defaultRate;
  const next = direction > 0 ? Math.floor(rate * 4 + 1e-6) / 4 + 0.25 : Math.ceil(rate * 4 - 1e-6) / 4 - 0.25;
  rateField.value = clampRate(next).toFixed(2);
  save();
}

async function load() {
  const { options } = await browser.storage.local.get('options');
  const values = { ...DEFAULT_OPTIONS, ...options };
  if (document.activeElement !== rateField) rateField.value = Number(values.defaultRate).toFixed(2);
  field('shortcuts').checked = values.shortcuts;
  field('autoShow').checked = values.autoShow;
  skipped = listOf(values.excluded);
  showChips();
}

async function save(message) {
  const rate = Math.round(Number(rateField.value) * 100) / 100;
  if (!(rate >= 0.25 && rate <= 4)) {
    show('Choose a speed from 0.25× to 4×.');
    return;
  }
  await browser.storage.local.set({
    options: {
      defaultRate: rate,
      shortcuts: field('shortcuts').checked,
      autoShow: field('autoShow').checked,
      excluded: skipped.join('\n'),
    },
  });
  show(typeof message === 'string' ? message : 'Saved');
}

const isSiteKey = (key) => key.startsWith('site:') || key.startsWith('resume:');
const originOf = (key) => key.slice(key.indexOf(':') + 1);

// Everything goes only on a second click within a few seconds.
let confirmTimer = 0;
async function forget() {
  const button = field('forget');
  if (!button.dataset.confirm) {
    button.dataset.confirm = '1';
    button.textContent = 'Click again to forget every saved site';
    confirmTimer = setTimeout(resetForget, 4000);
    return;
  }
  resetForget();
  const everything = await browser.storage.local.get(null);
  const keys = Object.keys(everything).filter(isSiteKey);
  await browser.storage.local.remove(keys);
  const sites = new Set(keys.map(originOf)).size;
  show('Forgot ' + sites + (sites === 1 ? ' site.' : ' sites.'));
}

function resetForget() {
  clearTimeout(confirmTimer);
  const button = field('forget');
  delete button.dataset.confirm;
  button.textContent = 'Forget all saved speeds and places';
}

// ---- Saved sites: each site's speed and saved places, with a Forget button for just that site, and under it
// the channels with a speed of their own (YouTube's "Just this channel"), each with its own Forget button ----
// The list keeps its own copy of the site: and resume: entries, updated from each storage change, and is
// drawn again only when what it shows changes: a playing tab saves its place every few seconds.

const entries = {};
let drawn = '';

// "https://www.youtube.com" reads as www.youtube.com; other schemes keep theirs, and file: is local files.
function siteName(origin) {
  if (origin === 'file:') return 'Local files';
  return origin.replace(/^https:\/\//, '');
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function forgetSite(origin) {
  await browser.storage.local.remove(['site:' + origin, 'resume:' + origin]);
  show('Forgot ' + siteName(origin) + '.');
}

async function forgetChannel(origin, id, name) {
  const key = 'site:' + origin;
  const { [key]: values } = await browser.storage.local.get(key);
  if (!values || !values.channels) return;
  const channels = { ...values.channels };
  delete channels[id];
  await browser.storage.local.set({ [key]: { ...values, channels } });
  show('Forgot ' + name + '.');
}

const channelsOf = (values) =>
  Object.entries(values.channels && typeof values.channels === 'object' ? values.channels : {})
    .filter(([, entry]) => Array.isArray(entry) && Number.isFinite(entry[0]) && typeof entry[1] === 'string')
    .map(([id, entry]) => ({ id, name: entry[1] || id, rate: entry[0] }))
    .sort((a, b) => a.name.localeCompare(b.name));

// One row for each site, followed by one for each of its channels. `key` names the row's Forget button.
function siteRows() {
  return [...new Set(Object.keys(entries).map(originOf))]
    .map((origin) => {
      const values = entries['site:' + origin] || {};
      const places = Object.keys(entries['resume:' + origin] || {}).length;
      const parts = [Number.isFinite(values.rate) ? values.rate.toFixed(2) + '×' : 'default speed'];
      if (places) parts.push(places + (places === 1 ? ' saved place' : ' saved places'));
      return { origin, name: siteName(origin), detail: parts.join(' · '), channels: channelsOf(values) };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(({ origin, name, detail, channels }) => [
      { key: origin, name, detail, forget: () => forgetSite(origin) },
      ...channels.map((c) => ({
        key: origin + ' ' + c.id,
        name: c.name,
        detail: 'Channel · ' + c.rate.toFixed(2) + '×',
        channel: true,
        forget: () => forgetChannel(origin, c.id, c.name),
      })),
    ]);
}

function showSites() {
  const rows = siteRows();
  const signature = JSON.stringify(rows.map(({ key, name, detail }) => [key, name, detail]));
  if (signature === drawn) return;
  drawn = signature;
  const list = field('sites');
  // Keyboard focus stays on the same site's Forget button, or moves to the next one when that site is gone.
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const oldOrder = [...list.querySelectorAll('button')].map((button) => button.dataset.key);
  const buttons = new Map();
  const items = rows.map(({ key, name, detail, channel, forget }) => {
    const row = make('li', channel ? 'channel' : null);
    const forgetButton = make('button', 'ghost', 'Forget');
    forgetButton.type = 'button';
    forgetButton.dataset.key = key;
    forgetButton.setAttribute('aria-label', 'Forget ' + name);
    forgetButton.addEventListener('click', forget);
    buttons.set(key, forgetButton);
    const label = make('span', 'label');
    label.append(make('b', null, name), make('span', null, detail));
    if (!channel) row.append(make('span', 'avatar', (name.replace(/^[a-z]+:\/\/|^www\./g, '')[0] || '?')));
    row.append(label, forgetButton);
    row.title = name;
    return row;
  });
  list.replaceChildren(...(items.length ? items : [make('li', 'empty', 'No saved sites yet. Set a speed on a site and it appears here.')]));
  if (focused == null) return;
  const next = buttons.get(focused) || oldOrder.slice(oldOrder.indexOf(focused) + 1).map((o) => buttons.get(o)).find(Boolean);
  (next || [...buttons.values()].pop() || field('forget')).focus();
}

async function loadSites() {
  const everything = await browser.storage.local.get(null);
  Object.keys(everything)
    .filter(isSiteKey)
    .forEach((key) => {
      entries[key] = everything[key];
    });
  showSites();
}

field('options').addEventListener('change', (event) => {
  if (event.target.id !== 'newSite') save();
});
field('options').addEventListener('submit', (event) => event.preventDefault());
field('newSite').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addSite();
  }
});
field('addSite').addEventListener('click', addSite);
field('slower').addEventListener('click', () => stepRate(-1));
field('faster').addEventListener('click', () => stepRate(1));
rateField.addEventListener('blur', () => {
  const rate = Number(rateField.value);
  if (rate >= 0.25 && rate <= 4) rateField.value = clampRate(rate).toFixed(2);
});
field('forget').addEventListener('click', forget);
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // "Turn off PSA" in a tab, or "Turn back on" in the popup, shows up here at once.
  if (changes.options) load();
  if (changes.stats) showSaved(changes.stats.newValue);
  const keys = Object.keys(changes).filter(isSiteKey);
  keys.forEach((key) => {
    if (changes[key].newValue === undefined) delete entries[key];
    else entries[key] = changes[key].newValue;
  });
  if (keys.length) showSites();
});
// ---- Time saved ----
const WEEK_HEIGHT = 44;
function showSaved(stats) {
  const { thisMonth, total, week } = savedTime(stats);
  field('monthSaved').textContent = formatSaved(thisMonth);
  field('savedNote').textContent = total
    ? 'In all: ' + formatSaved(total) + ', by playing faster than 1×'
    : 'Play something faster than 1× and the time you save adds up here.';
  const most = Math.max(...week.map((day) => day.seconds), 60);
  const bars = week.map(({ date, seconds }, index) => {
    const column = make('div');
    const bar = make('i', index === week.length - 1 ? 'today' : null);
    bar.style.height = Math.max(3, Math.round((seconds / most) * WEEK_HEIGHT)) + 'px';
    column.append(bar, make('small', null, date.toLocaleDateString(undefined, { weekday: 'narrow' })));
    column.title = date.toLocaleDateString(undefined, { weekday: 'long' }) + ': ' + formatSaved(seconds);
    return column;
  });
  field('week').replaceChildren(...bars);
  field('week').setAttribute(
    'aria-label',
    'Last 7 days: ' + week.map(({ date, seconds }) => date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + formatSaved(seconds)).join(', ')
  );
}
browser.storage.local.get('stats').then(({ stats }) => showSaved(stats));

field('version').textContent = 'Version ' + browser.runtime.getManifest().version;
load();
loadSites();
