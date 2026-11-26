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
  button.focus({ focusVisible: false });
}

field('settings').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

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
    return;
  }
  // The site, where it has one worth naming: not on Firefox's own pages or other add-ons' pages.
  if (status.site && status.state !== 'blocked') field('site').textContent = status.site;
  if (status.state === 'excluded') {
    show('PSA is off here', 'This site is in your list of sites to skip.', 'Turn back on', async () => {
      await browser.runtime.sendMessage({ type: 'include', tabId });
      show('PSA is back on', 'Reload the page to start it here.', 'Reload', () => reload(tabId));
    });
  } else if (status.state === 'reload') {
    show('Reload to start PSA', 'PSA was off when this page loaded.', 'Reload', () => reload(tabId));
  } else {
    show(
      "PSA can't run here",
      'Firefox keeps add-ons off some pages, like its own, addons.mozilla.org and PDFs. Just installed or updated PSA? Reload the page.',
      'Reload',
      () => reload(tabId)
    );
  }
})();
