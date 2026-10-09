// The settings page: saves each change as it is made.
const DEFAULT_OPTIONS = { defaultRate: 1, shortcuts: true, autoShow: true, excluded: '' };
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

async function forget() {
  const everything = await browser.storage.local.get(null);
  const keys = Object.keys(everything).filter((key) => key.startsWith('site:') || key.startsWith('resume:'));
  await browser.storage.local.remove(keys);
  show('Forgot ' + keys.length + (keys.length === 1 ? ' item.' : ' items.'));
}

// ---- Saved sites: each site's speed and saved places, with a Forget button for just that site ----------

const isSiteKey = (key) => key.startsWith('site:') || key.startsWith('resume:');

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

async function showSites() {
  const everything = await browser.storage.local.get(null);
  const origins = new Set(Object.keys(everything).filter(isSiteKey).map((key) => key.slice(key.indexOf(':') + 1)));
  const list = field('sites');
  const rows = [...origins]
    .map((origin) => ({ origin, name: siteName(origin) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ origin, name }) => {
      const values = everything['site:' + origin] || {};
      const places = Object.keys(everything['resume:' + origin] || {}).length;
      const parts = [Number.isFinite(values.rate) ? values.rate.toFixed(2) + '×' : 'default speed'];
      if (places) parts.push(places + (places === 1 ? ' saved place' : ' saved places'));
      const row = make('li');
      const forgetButton = make('button', null, 'Forget');
      forgetButton.type = 'button';
      forgetButton.setAttribute('aria-label', 'Forget ' + name);
      forgetButton.addEventListener('click', () => forgetSite(origin));
      row.append(make('span', 'site', name), make('span', 'detail', parts.join(' · ')), forgetButton);
      row.title = name;
      return row;
    });
  list.replaceChildren(...(rows.length ? rows : [make('li', 'empty', 'No saved sites yet.')]));
}

field('options').addEventListener('change', save);
field('options').addEventListener('submit', (event) => event.preventDefault());
field('forget').addEventListener('click', forget);
// Kept up to date while this page is open, as PSA saves speeds and places in other tabs.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(isSiteKey)) showSites();
});
load();
showSites();
