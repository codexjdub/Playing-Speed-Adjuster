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

field('options').addEventListener('change', save);
field('options').addEventListener('submit', (event) => event.preventDefault());
field('forget').addEventListener('click', forget);
load();
