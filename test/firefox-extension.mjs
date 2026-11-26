// Smoke test for the Firefox extension in dist/firefox. Runs in the Tests workflow on GitHub, whose machines
// have Firefox and geckodriver; the workflow installs selenium-webdriver just for this step:
//
//   npm install --no-save selenium-webdriver@4 && node test/firefox-extension.mjs
//
// Installs the extension temporarily, then checks that PSA starts on its own, brings over (once) what the
// bookmarklet saved on the site, shows the pill when something plays here or in an embedded player, that a
// real ] key press speeds up the page, a player embedded from another origin and one in a same-site frame
// (without a second PSA there), that a late copy of its own speed change is ignored, that the speed is
// remembered after a reload, how the toolbar's toggle (togglePanel) shows and hides PSA, that a same-site
// player frame added later is looked after at once, that muted playing doesn't pop up the pill, that the panel
// names a page's only player when it is embedded from another site (until the address changes), that the
// settings page lists this site with its speed and forgets just it, and that "Turn off PSA" stops it on the site
// until the toolbar popup turns it back on.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = readFileSync(join(root, 'src', 'psa.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
const port = 8767;
// The page and its embedded player come from different origins: 127.0.0.1 and localhost.
const frameUrl = `http://localhost:${port}/test/extension-frame.html`;
const pageUrl = `http://127.0.0.1:${port}/test/extension.html?frame=` + encodeURIComponent(frameUrl);
// A fixed address for the extension's own pages (Firefox picks a random one otherwise), to open its settings.
const extensionUuid = '6d1f5f7e-3c2b-4a59-9e1d-7b8c2a4f0e31';

const server = spawn(process.execPath, ['test/serve.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '::' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('Serving on')) resolve();
  });
  server.on('exit', (code) => reject(new Error('The test server exited with code ' + code)));
});

// Firefox installs extensions from a zip.
const xpi = join(mkdtempSync(join(tmpdir(), 'psa-')), 'psa.zip');
execFileSync('zip', ['-qr', xpi, '.'], { cwd: join(root, 'dist', 'firefox') });

const lines = [];
const check = (ok, name, detail) =>
  lines.push({ ok, text: (ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? ' — ' + detail : '') });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let driver = null;
try {
  const options = new firefox.Options()
    .addArguments('-headless')
    .setPreference('media.autoplay.default', 0)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'psa@codexjdub.github.io': extensionUuid }));
  // System access, which geckodriver grants only when asked, lets the test open the extension's settings page
  // in a tab of its own (see below).
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  const run = (script) => driver.executeScript(script);
  // Polls a script until it returns something truthy, or gives up and returns the last value.
  const until = async (script, ms = 8000) => {
    let value = null;
    for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
      value = await run(script).catch(() => null);
      if (value) break;
    }
    return value;
  };
  // A web page can't navigate to the extension's pages, so they open in a new tab from Firefox's own side, as
  // the toolbar menu would. Returns the new tab's handle, switched to.
  const openExtensionTab = async (path) => {
    const before = await driver.getAllWindowHandles();
    await driver.setContext(firefox.Context.CHROME);
    try {
      await driver.executeScript('gBrowser.selectedTab = gBrowser.addTrustedTab(arguments[0]);', `moz-extension://${extensionUuid}/${path}`);
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
    const handle = (await driver.getAllWindowHandles()).find((h) => !before.includes(h));
    await driver.switchTo().window(handle);
    return handle;
  };
  const inFrame = async (script) => {
    await driver.switchTo().frame(0);
    try {
      return await until(script);
    } finally {
      await driver.switchTo().defaultContent();
    }
  };

  await driver.installAddon(xpi, true);
  await driver.get(pageUrl);

  const started = await until('return window.__speedCtl && window.__speedCtl.inspect().version');
  check(started === version, 'PSA ' + version + ' starts on its own', started);
  check((await run('return window.__speedCtl.inspect().shown')) === false, 'nothing is shown before anything plays');

  // What the bookmarklet saved on this site comes over on the first visit, and leaves the site's storage so
  // it isn't brought back after "Forget saved speeds and places".
  await run(
    'localStorage.setItem("speedCtl.v1", JSON.stringify({ rate: 1.5 })); localStorage.setItem("speedCtl.resume.v1", JSON.stringify({ "/old 600": [90, Date.now()] }));'
  );
  await driver.navigate().refresh();
  const migrated = await until(
    'return !!window.__speedCtl && Math.abs(window.__speedCtl.inspect().rate - 1.5) < 0.005 && localStorage.getItem("speedCtl.v1") === null && localStorage.getItem("speedCtl.resume.v1") === null'
  );
  check(!!migrated, "the bookmarklet's saved speed is brought over once, then removed from the site's storage",
    await run('return [window.__speedCtl && window.__speedCtl.inspect().rate, localStorage.getItem("speedCtl.v1")].join(" ")'));

  // Played with sound: muted playing (how ads autoplay) doesn't count as starting.
  await run('const a = document.getElementById("episode"); return a.play().then(() => "ok", (e) => e.name)');
  const pill = await until(
    'const s = document.querySelector("speed-ctl"); return !!s && !s.shadowRoot.querySelector(".pill").hidden && s.shadowRoot.querySelector(".panel").hidden'
  );
  check(!!pill, 'the pill appears when something plays');

  const embedded = await inFrame('return !!window.__speedCtl && document.getElementById("embedded").readyState >= 1');
  check(!!embedded, 'PSA also runs in a player embedded from another site');

  // Every speed message the page's PSA receives, to send one again later.
  await run('window.__rateMessages = []; document.addEventListener("psa:to-page", (e) => { if (JSON.parse(e.detail).type === "rate") window.__rateMessages.push(e.detail); });');

  // A real key press: ] speeds up by 0.1 in the page, and the embedded player and the same-site frame follow.
  await run('document.getElementById("episode").pause(); document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const pageRate = await until('const r = document.getElementById("episode").playbackRate; return Math.abs(r - 1.6) < 0.005 && r');
  check(!!pageRate, '] speeds up the page to 1.6×', await run('return document.getElementById("episode").playbackRate'));
  const frameRate = await inFrame('const r = document.getElementById("embedded").playbackRate; return Math.abs(r - 1.6) < 0.005 && r');
  check(!!frameRate, 'the embedded player follows to 1.6×');
  const sameSite = await until(
    'const f = document.getElementById("same"); const a = f.contentDocument.getElementById("inner"); return !!a && Math.abs(a.playbackRate - 1.6) < 0.005 && f.contentWindow.__speedCtl === undefined'
  );
  check(!!sameSite, "a same-site frame's player follows to 1.6× without a PSA of its own",
    await run('const f = document.getElementById("same"); return [f.contentDocument.getElementById("inner").playbackRate, !!f.contentWindow.__speedCtl].join(" ")'));

  // The background passes each speed to every frame, the one it came from too, possibly after newer presses.
  await until('return window.__rateMessages.length > 0');
  await driver.actions().sendKeys(']').perform();
  await until('return Math.abs(window.__speedCtl.inspect().rate - 1.7) < 0.005');
  await run('document.dispatchEvent(new CustomEvent("psa:to-page", { detail: window.__rateMessages[0] }));');
  await wait(500);
  const kept = await run('return window.__speedCtl.inspect().rate');
  check(Math.abs(kept - 1.7) < 0.005, "a late copy of the page's own speed change doesn't take the speed back", kept);

  await driver.navigate().refresh();
  const remembered = await until('return window.__speedCtl && Math.abs(window.__speedCtl.inspect().rate - 1.7) < 0.005');
  check(!!remembered, 'the speed is remembered after a reload', await run('return window.__speedCtl && window.__speedCtl.inspect().rate'));

  // Through the background to the page's frame, the same way as the toolbar button's message.
  await inFrame('if (!window.__speedCtl) return false; document.getElementById("embedded").play(); return true;');
  const embeddedPill = await until('const i = window.__speedCtl.inspect(); return i.shown && i.minimized');
  check(!!embeddedPill, 'a player in an embedded frame starting shows the page\'s pill');

  const panel = await run(
    'window.__speedCtl.togglePanel(); const i = window.__speedCtl.inspect(); const s = document.querySelector("speed-ctl"); return i.shown && !i.minimized && !!s && !s.shadowRoot.querySelector(".panel").hidden'
  );
  check(!!panel, "togglePanel (the toolbar button's action) opens the full panel");

  // Hidden with the toolbar button, PSA stays hidden when something plays, as after ×.
  await run('window.__speedCtl.togglePanel(); document.getElementById("episode").play();');
  await wait(1000);
  const stayedHidden = await run('return window.__speedCtl.inspect().shown === false && !document.getElementById("episode").paused');
  check(stayedHidden, 'hidden with the toolbar button, it stays hidden when something plays');

  // A key still flashes the new speed over the page, without the panel or the pill, and then PSA is out of
  // sight again.
  await run('document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const flashed = await until(
    'const s = document.querySelector("speed-ctl"); return !!s && s.classList.contains("flash-only") && !s.shadowRoot.querySelector(".flash").hidden && s.shadowRoot.querySelector(".flash").textContent'
  , 1500);
  check(flashed === '1.80×', 'hidden, a key flashes the new speed on its own', flashed);
  await driver.actions().sendKeys('[').perform();
  const flashGone = await until('return !document.querySelector("speed-ctl") && window.__speedCtl.inspect().shown === false', 4000);
  check(!!flashGone, 'after the flash PSA is out of sight again');

  // Faded out of sight in fullscreen while hidden (simulated fullscreen), it is visible again when shown.
  await run(
    'Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.getElementById("episode") }); document.dispatchEvent(new Event("fullscreenchange"));'
  );
  await wait(3600);
  const visible = await run(
    'window.__speedCtl.togglePanel(); const p = document.querySelector("speed-ctl").shadowRoot.querySelector(".panel"); const ok = window.__speedCtl.inspect().shown && !p.classList.contains("faded"); delete document.fullscreenElement; document.dispatchEvent(new Event("fullscreenchange")); return ok;'
  );
  check(visible, 'shown in fullscreen after fading while hidden, it is visible');

  // A player in a frame from this site, added later to a page with nothing playing: the frame hands itself to
  // the page's PSA, so it gets the speed and the pill at once (a full look comes only every 30 s there).
  await driver.get(pageUrl + '&embed-only');
  await until('return !!window.__speedCtl');
  const siteRate = await run('return window.__speedCtl.inspect().rate');
  await run('const f = document.createElement("iframe"); f.id = "late"; f.srcdoc = "<p>Late player</p>"; document.body.append(f);');
  await until('const f = document.getElementById("late"); return !!f.contentDocument && f.contentDocument.readyState === "complete" && !!f.contentDocument.body');
  await run(
    'const d = document.getElementById("late").contentDocument; const a = d.createElement("audio"); a.id = "late-audio"; d.body.append(a); a.src = beepUrl(660, 60); a.play();'
  );
  const late = await until(
    `const a = document.getElementById("late").contentDocument.getElementById("late-audio"); return Math.abs(a.playbackRate - ${siteRate}) < 0.005 && !a.paused && window.__speedCtl.inspect().shown`,
    2500
  );
  check(!!late, "a player in a same-site frame added later gets the page's speed and the pill at once",
    await run('const a = document.getElementById("late").contentDocument.getElementById("late-audio"); return [a.playbackRate, a.paused, window.__speedCtl.inspect().shown].join(" ")'));

  // A page whose only player is embedded from another site: muted playing doesn't pop up the pill, unmuting
  // does, the panel names that site, ] on the page still reaches the player, and a new address forgets it.
  await driver.get(pageUrl + '&embed-only');
  await until('return !!window.__speedCtl');
  await inFrame('if (!window.__speedCtl) return false; const a = document.getElementById("embedded"); a.muted = true; a.play(); return true;');
  await wait(1500);
  const quiet = await run('return window.__speedCtl.inspect().shown === false');
  check(quiet, "a muted player in an embedded frame (as ads autoplay) doesn't pop up the pill");
  await inFrame('const a = document.getElementById("embedded"); a.muted = false; return !a.paused;');
  const unmuted = await until('return window.__speedCtl.inspect().shown');
  check(!!unmuted, 'unmuting it shows the pill');
  await run('window.__speedCtl.togglePanel();');
  const named = await until(
    'const s = document.querySelector("speed-ctl").shadowRoot; return s.querySelector(".title").textContent + " / " + s.querySelector(".sub").textContent;'
  );
  check(
    named === 'Embedded player from localhost / Speed follows PSA · play and skip in the player itself',
    "the panel names a page's only player, embedded from another site",
    named
  );
  await run('document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const faster = Math.round((siteRate + 0.1) * 100) / 100;
  const embedOnlyRate = await inFrame(`const r = document.getElementById("embedded").playbackRate; return Math.abs(r - ${faster}) < 0.005 && r`);
  check(!!embedOnlyRate, '] on that page speeds up the embedded player to ' + faster + '×');
  await run('history.pushState(null, "", location.href + "&moved");');
  const forgotten = await until(
    'return document.querySelector("speed-ctl").shadowRoot.querySelector(".title").textContent === "No audio or video found yet"'
  );
  check(!!forgotten, 'after the page changes its address, the panel no longer names the embedded player');

  // YouTube's "Just this channel", on a stand-in for a YouTube video page: the channel keeps 1× while the
  // site keeps its speed, and the settings page lists the channel under the site.
  await run(
    'const u = new URL(location.href); u.searchParams.set("v", "vid1"); history.replaceState(null, "", u); const w = document.createElement("ytd-watch-flexy"); w.setAttribute("video-id", "vid1"); w.innerHTML = \'<div id="owner"><ytd-channel-name><a href="/@jazzcafe">Jazz Cafe</a></ytd-channel-name></div>\'; document.body.append(w);'
  );
  const switchShown = await until('const s = document.querySelector("speed-ctl").shadowRoot.querySelector(".channel"); return !s.hidden && s.getAttribute("aria-checked") === "false"');
  check(!!switchShown, 'a YouTube video page shows "Just this channel"');
  await run('const s = document.querySelector("speed-ctl").shadowRoot; s.querySelector(".channel").click(); s.querySelector(".presets button").click();');
  const channelRate = await until('const i = window.__speedCtl.inspect(); return i.channel === "@jazzcafe" && Math.abs(i.rate - 1) < 0.005 && Math.abs(i.siteRate - 1) > 0.005');
  check(!!channelRate, 'with it on, 1× is kept for the channel and not for the site',
    await run('const i = window.__speedCtl.inspect(); return [i.channel, i.rate, i.siteRate].join(" ")'));

  // The settings page lists this site with its speed, and forgets just it.
  const savedRate = await run('return window.__speedCtl.inspect().siteRate');
  const pageTab = await driver.getWindowHandle();
  await openExtensionTab('options.html');
  const shownVersion = await until('return document.getElementById("version").textContent');
  check(shownVersion === 'Version ' + version, 'the settings page shows the version', shownVersion);
  // Playing at 1.6× and 1.7× above saved some time, sent when each page was left.
  const timeSaved = await until('const t = document.getElementById("monthSaved").textContent; return t !== "0 min" && t');
  check(!!timeSaved, 'the settings page shows the time saved this month', timeSaved);
  const site = '127.0.0.1:8767';
  const findRow = `return [...document.querySelectorAll("#sites li")].find((li) => li.textContent.includes("http://${site}"))`;
  const findChannel = 'return [...document.querySelectorAll("#sites li.channel")].find((li) => li.textContent.includes("Jazz Cafe"))';
  const channelListed = await until(findChannel + '?.textContent || null');
  check(!!channelListed && channelListed.includes('1.00×'), 'the settings page lists the channel with its speed', channelListed);
  await run(findChannel + '?.querySelector("button").click()');
  const channelGone = await until(findChannel + ' ? null : true');
  check(!!channelGone && !!(await run(findRow)), 'Forget on a channel removes just the channel');
  const listed = await until(findRow + '?.textContent || null');
  check(!!listed && listed.includes(savedRate.toFixed(2) + '×'), 'the settings page lists this site with its speed', listed);
  await run(findRow + '?.querySelector("button").click()');
  const gone = await until(findRow + ' ? null : true');
  check(!!gone, 'Forget on the settings page removes just that site');
  await driver.close();
  await driver.switchTo().window(pageTab);
  await driver.get(pageUrl);
  const reset = await until('return !!window.__speedCtl && window.__speedCtl.inspect().rate === 1');
  check(!!reset, 'a forgotten site is back to the default speed', await run('return window.__speedCtl && window.__speedCtl.inspect().rate'));

  // "Turn off PSA on 127.0.0.1" at the bottom of the panel: the site joins the sites to skip, and PSA stops in
  // every frame with the players back to their own speed.
  await run('document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const sped = await until('return Math.abs(document.getElementById("episode").playbackRate - 1.1) < 0.005');
  await run('window.__speedCtl.togglePanel();');
  const offText = await until('const b = document.querySelector("speed-ctl").shadowRoot.querySelector(".off"); return b && b.textContent');
  check(offText === 'Turn off PSA on 127.0.0.1', 'the panel offers "Turn off PSA on 127.0.0.1"', offText);
  await run('document.querySelector("speed-ctl").shadowRoot.querySelector(".off").click();');
  const off = await until('return !window.__speedCtl && !document.querySelector("speed-ctl") && document.getElementById("episode").playbackRate === 1');
  check(!!sped && !!off, 'turning it off stops PSA and puts the player back to 1×',
    await run('return [!!window.__speedCtl, document.getElementById("episode").playbackRate].join(" ")'));
  check(!!(await inFrame('return !window.__speedCtl')), 'it stops in the embedded player too');

  // The settings page shows the site among the sites to skip, as a chip. A whole address typed in is kept as
  // its site, without www., and × takes a chip away.
  await openExtensionTab('options.html');
  const chipText = 'return [...document.querySelectorAll("#chips .chip span")].map((c) => c.textContent).join(" ")';
  const chips = await until(chipText + ' || null');
  check(chips === '127.0.0.1', 'the settings page lists the site among the sites to skip', chips);
  await run('const i = document.getElementById("newSite"); i.value = "https://www.example.org/watch?v=1"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));');
  const typed = await until(chipText + ' === "127.0.0.1 example.org" && (window.wrappedJSObject || window).browser.storage.local.get("options").then((o) => o.options.excluded === "127.0.0.1\\nexample.org" && o.options.excluded)');
  check(typed === '127.0.0.1\nexample.org', 'a typed address is added as its site', JSON.stringify(typed));
  await run('[...document.querySelectorAll("#chips .chip")].find((c) => c.textContent.includes("example.org")).querySelector("button").click();');
  const removed = await until(chipText + ' === "127.0.0.1"');
  check(!!removed, '× takes a site off the list');
  await driver.close();
  await driver.switchTo().window(pageTab);

  // The toolbar popup, opened in a tab of its own: there, the active tab is its own, which add-ons can't reach.
  const popupText = 'const b = document.getElementById("box"); return !b.hidden && document.getElementById("title").textContent';
  await openExtensionTab('popup.html');
  const blocked = await until(popupText);
  check(blocked === "PSA can't run here", "the popup on a page add-ons can't reach says so", blocked);
  const pageTabId = await run(
    'const w = window.wrappedJSObject || window; const b = w.browser || (typeof browser !== "undefined" ? browser : null); return b.tabs.query({}).then((tabs) => tabs.find((t) => t.url.startsWith("http://127.0.0.1")).id);'
  );
  await run(`location.href = "popup.html?tab=${pageTabId}";`);
  const excludedText = await until(popupText + ' === "PSA is off here" && document.getElementById("site").textContent + " / " + document.getElementById("act").textContent');
  check(excludedText === '127.0.0.1 / Turn back on', 'the popup for the page says PSA is off on 127.0.0.1 and offers "Turn back on"', excludedText);
  await run('document.getElementById("act").click();');
  const backOn = await until(popupText + ' === "PSA is back on" && document.getElementById("act").textContent');
  check(backOn === 'Reload', '"Turn back on" takes the site off the list and offers a reload', backOn);
  await run(`location.href = "popup.html?tab=${pageTabId}&again";`);
  const needsReload = await until(popupText);
  check(needsReload === 'Reload to start PSA', 'opened again before the reload, the popup asks for one', needsReload);
  await driver.close();
  await driver.switchTo().window(pageTab);
  await driver.navigate().refresh();
  const again = await until('return !!window.__speedCtl');
  check(!!again, 'after the reload PSA runs on the site again');

  // Where PSA runs, the popup steps aside: it shows or hides PSA's panel, as the toolbar button does.
  await openExtensionTab(`popup.html?tab=${pageTabId}`);
  await wait(1500);
  await driver.switchTo().window(pageTab);
  const toggled = await until('const i = window.__speedCtl.inspect(); return i.shown && !i.minimized');
  check(!!toggled, 'where PSA runs, the popup opens its panel instead');

  // The welcome page runs PSA on its sample: playing shows the pill, ] speeds it up with a flash, and nothing
  // is saved for the page.
  await openExtensionTab('welcome.html');
  await until('return !!window.__speedCtl');
  await run('document.getElementById("play").click();');
  const welcomePill = await until('const i = window.__speedCtl && window.__speedCtl.inspect(); return !!i && i.shown && i.minimized && !document.getElementById("sample").paused');
  check(!!welcomePill, 'on the welcome page, playing the sample shows the pill');
  await run('document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const welcomeRate = await until('const r = document.getElementById("sample").playbackRate; const f = document.querySelector("speed-ctl").shadowRoot.querySelector(".flash"); return Math.abs(r - 1.1) < 0.005 && !f.hidden && f.textContent');
  check(welcomeRate === '1.10×', '] speeds the sample up to 1.1× and flashes it', welcomeRate);
  const welcomeKeys = await run(
    'return (window.wrappedJSObject || window).browser.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.includes("moz-extension")).join(" "));'
  );
  check(welcomeKeys === '', 'nothing is saved for the welcome page', welcomeKeys);
  await driver.close();
  await driver.switchTo().window(pageTab);
} catch (err) {
  check(false, 'the run stopped', err.message.split('\n')[0]);
} finally {
  if (driver) await driver.quit().catch(() => {});
}

const failed = lines.filter((line) => !line.ok);
console.log('PSA ' + version + ' · Firefox extension\n');
lines.forEach((line) => console.log(line.text));
console.log('\n' + (failed.length ? failed.length + ' of ' + lines.length + ' checks failed' : 'All ' + lines.length + ' checks passed'));
process.exit(failed.length ? 1 : 0);
