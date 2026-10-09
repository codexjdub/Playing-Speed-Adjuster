// The settings page: saves each change as it is made.
// DEFAULT_OPTIONS comes from defaults.js, loaded first.
const field = (id) => document.getElementById(id);
const status = field('status');

function show(text) {
  status.textContent = text;
  setTimeout(() => {
    if (status.textContent === text) status.textContent = '';
  }, 2500);
}

async function load() {
  const { options } = await browser.storage.local.get('options');
  const values = { ...DEFAULT_OPTIONS, ...options };
  field('defaultRate').value = values.defaultRate;
  field('shortcuts').checked = values.shortcuts;
  field('autoShow').checked = values.autoShow;
  field('excluded').value = values.excluded;
}

async function save() {
  const rate = Math.round(Number(field('defaultRate').value) * 100) / 100;
  if (!(rate >= 0.25 && rate <= 4)) {
    show('Choose a speed from 0.25 to 4.');
    return;
  }
  await browser.storage.local.set({
    options: {
      defaultRate: rate,
      shortcuts: field('shortcuts').checked,
      autoShow: field('autoShow').checked,
      excluded: field('excluded').value,
    },
  });
  show('Saved.');
}

const isSiteKey = (key) => key.startsWith('site:') || key.startsWith('resume:');
const originOf = (key) => key.slice(key.indexOf(':') + 1);

async function forget() {
  const everything = await browser.storage.local.get(null);
  const keys = Object.keys(everything).filter(isSiteKey);
  await browser.storage.local.remove(keys);
  const sites = new Set(keys.map(originOf)).size;
  show('Forgot ' + sites + (sites === 1 ? ' site.' : ' sites.'));
}

// ---- Saved sites: each site's speed and saved places, with a Forget button for just that site ----------
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

function siteRows() {
  return [...new Set(Object.keys(entries).map(originOf))]
    .map((origin) => {
      const values = entries['site:' + origin] || {};
      const places = Object.keys(entries['resume:' + origin] || {}).length;
      const parts = [Number.isFinite(values.rate) ? values.rate.toFixed(2) + '×' : 'default speed'];
      if (places) parts.push(places + (places === 1 ? ' saved place' : ' saved places'));
      return { origin, name: siteName(origin), detail: parts.join(' · ') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function showSites() {
  const rows = siteRows();
  const signature = JSON.stringify(rows);
  if (signature === drawn) return;
  drawn = signature;
  const list = field('sites');
  // Keyboard focus stays on the same site's Forget button, or moves to the next one when that site is gone.
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.origin : null;
  const oldOrder = [...list.querySelectorAll('button')].map((button) => button.dataset.origin);
  const buttons = new Map();
  const items = rows.map(({ origin, name, detail }) => {
    const row = make('li');
    const forgetButton = make('button', null, 'Forget');
    forgetButton.type = 'button';
    forgetButton.dataset.origin = origin;
    forgetButton.setAttribute('aria-label', 'Forget ' + name);
    forgetButton.addEventListener('click', () => forgetSite(origin));
    buttons.set(origin, forgetButton);
    row.append(make('span', 'site', name), make('span', 'detail', detail), forgetButton);
    row.title = name;
    return row;
  });
  list.replaceChildren(...(items.length ? items : [make('li', 'empty', 'No saved sites yet.')]));
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

field('options').addEventListener('change', save);
field('options').addEventListener('submit', (event) => event.preventDefault());
field('forget').addEventListener('click', forget);
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter(isSiteKey);
  keys.forEach((key) => {
    if (changes[key].newValue === undefined) delete entries[key];
    else entries[key] = changes[key].newValue;
  });
  if (keys.length) showSites();
});
load();
loadSites();
