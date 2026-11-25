// The toolbar popup, shown only where PSA isn't running in the tab: it says why, on a site in the list of sites
// to skip (with "Turn back on"), a page that loaded while PSA was off there, or one add-ons can't reach. Where
// PSA turns out to be running after all, it shows or hides PSA's panel, as the toolbar button does there, and
// closes.
const field = (id) => document.getElementById(id);

// The tab the popup is about: the active one, or for the tests, which open the popup in a tab of its own, ?tab=.
async function tabOf() {
  const asked = Number(new URLSearchParams(location.search).get('tab'));
  if (asked) return asked;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : 0;
}

function show(title, text, action, onAction) {
  field('title').textContent = title;
  field('text').textContent = text;
  const button = field('act');
  button.textContent = action;
  button.onclick = onAction;
  field('box').hidden = false;
  button.focus();
}

async function reload(tabId) {
  await browser.tabs.reload(tabId);
  window.close();
}

(async () => {
  const tabId = await tabOf();
  const status = (await browser.runtime.sendMessage({ type: 'status', tabId }).catch(() => null)) || { state: 'blocked' };
  if (status.state === 'running') {
    await browser.tabs.sendMessage(tabId, { type: 'toggle' }, { frameId: 0 }).catch(() => {});
    window.close();
  } else if (status.state === 'excluded') {
    show('PSA is off on ' + status.site, 'It is in your list of sites to skip.', 'Turn back on', async () => {
      await browser.runtime.sendMessage({ type: 'include', tabId });
      show('PSA is back on for ' + status.site, 'Reload the page to use it here.', 'Reload', () => reload(tabId));
    });
  } else if (status.state === 'reload') {
    show('Reload to start PSA', 'PSA was off when this page loaded.', 'Reload', () => reload(tabId));
  } else {
    show(
      "PSA can't run on this page",
      "Firefox keeps add-ons out of some pages, such as its own pages, addons.mozilla.org and PDFs. If PSA was just installed or updated, reload the page.",
      'Reload',
      () => reload(tabId)
    );
  }
})();
