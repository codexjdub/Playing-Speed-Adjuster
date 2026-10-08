// Smoke test for the Firefox extension in dist/firefox. Runs in the Tests workflow on GitHub, whose machines
// have Firefox and geckodriver; the workflow installs selenium-webdriver just for this step:
//
//   npm install --no-save selenium-webdriver@4 && node test/firefox-extension.mjs
//
// Installs the extension temporarily, then checks that PSA starts on its own, brings over (once) what the
// bookmarklet saved on the site, shows the pill when something plays here or in an embedded player, that a
// real ] key press speeds up the page, a player embedded from another origin and one in a same-site frame
// (without a second PSA there), that a late copy of its own speed change is ignored, that the speed is
// remembered after a reload, and how the toolbar's toggle (togglePanel) shows and hides PSA.
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
  const options = new firefox.Options().addArguments('-headless').setPreference('media.autoplay.default', 0);
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
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

  await run('const a = document.getElementById("episode"); a.muted = true; return a.play().then(() => "ok", (e) => e.name)');
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
  await inFrame('if (!window.__speedCtl) return false; const a = document.getElementById("embedded"); a.muted = true; a.play(); return true;');
  const embeddedPill = await until('const i = window.__speedCtl.inspect(); return i.shown && i.minimized');
  check(!!embeddedPill, 'a player in an embedded frame starting shows the page\'s pill');

  const panel = await run(
    'window.__speedCtl.togglePanel(); const i = window.__speedCtl.inspect(); const s = document.querySelector("speed-ctl"); return i.shown && !i.minimized && !!s && !s.shadowRoot.querySelector(".panel").hidden'
  );
  check(!!panel, "togglePanel (the toolbar button's action) opens the full panel");

  // Hidden with the toolbar button, PSA stays hidden when something plays, as after ×.
  await run('window.__speedCtl.togglePanel(); const a = document.getElementById("episode"); a.muted = true; a.play();');
  await wait(1000);
  const stayedHidden = await run('return window.__speedCtl.inspect().shown === false && !document.getElementById("episode").paused');
  check(stayedHidden, 'hidden with the toolbar button, it stays hidden when something plays');

  // Faded out of sight in fullscreen while hidden (simulated fullscreen), it is visible again when shown.
  await run(
    'Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.getElementById("episode") }); document.dispatchEvent(new Event("fullscreenchange"));'
  );
  await wait(3600);
  const visible = await run(
    'window.__speedCtl.togglePanel(); const p = document.querySelector("speed-ctl").shadowRoot.querySelector(".panel"); const ok = window.__speedCtl.inspect().shown && !p.classList.contains("faded"); delete document.fullscreenElement; document.dispatchEvent(new Event("fullscreenchange")); return ok;'
  );
  check(visible, 'shown in fullscreen after fading while hidden, it is visible');
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
