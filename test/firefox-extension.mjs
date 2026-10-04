// Smoke test for the Firefox extension in dist/firefox. Runs in the Tests workflow on GitHub, whose machines
// have Firefox and geckodriver; the workflow installs selenium-webdriver just for this step:
//
//   npm install --no-save selenium-webdriver@4 && node test/firefox-extension.mjs
//
// Installs the extension temporarily, then checks that PSA starts on its own, shows the pill when something
// plays, that a real ] key press speeds up both the page and a player embedded from another origin, that the
// speed is remembered after a reload, and that the toolbar's toggle opens the full panel.
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

  await run('const a = document.getElementById("episode"); a.muted = true; return a.play().then(() => "ok", (e) => e.name)');
  const pill = await until(
    'const s = document.querySelector("speed-ctl"); return !!s && !s.shadowRoot.querySelector(".pill").hidden && s.shadowRoot.querySelector(".panel").hidden'
  );
  check(!!pill, 'the pill appears when something plays');

  const embedded = await inFrame('return !!window.__speedCtl && document.getElementById("embedded").readyState >= 1');
  check(!!embedded, 'PSA also runs in a player embedded from another site');

  // A real key press: ] speeds up by 0.1 in the page, and the embedded player follows.
  await run('document.getElementById("episode").pause(); document.activeElement && document.activeElement.blur && document.activeElement.blur();');
  await driver.actions().sendKeys(']').perform();
  const pageRate = await until('const r = document.getElementById("episode").playbackRate; return Math.abs(r - 1.1) < 0.005 && r');
  check(!!pageRate, '] speeds up the page to 1.1×', await run('return document.getElementById("episode").playbackRate'));
  const frameRate = await inFrame('const r = document.getElementById("embedded").playbackRate; return Math.abs(r - 1.1) < 0.005 && r');
  check(!!frameRate, 'the embedded player follows to 1.1×');

  await driver.navigate().refresh();
  const remembered = await until('return window.__speedCtl && Math.abs(window.__speedCtl.inspect().rate - 1.1) < 0.005');
  check(!!remembered, 'the speed is remembered after a reload', await run('return window.__speedCtl && window.__speedCtl.inspect().rate'));

  const panel = await run(
    'window.__speedCtl.togglePanel(); const i = window.__speedCtl.inspect(); const s = document.querySelector("speed-ctl"); return i.shown && !i.minimized && !!s && !s.shadowRoot.querySelector(".panel").hidden'
  );
  check(!!panel, 'the toolbar toggle opens the full panel');
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
