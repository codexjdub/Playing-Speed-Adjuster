// Runs the test page's checks in a real, headless browser. Used by `npm test` and the Tests workflow.
//
//   node test/run-checks.mjs [--browser chromium|firefox|webkit] [--channel chrome]
//
// Starts test/serve.mjs and checks what it serves, loads PSA on the test page at 1.8×, runs the page's own
// checks (they stay defined in test-page.html), checks that the mouse reaches PSA in real fullscreen, then
// clicks the real javascript: link on the install page.
// Exits with 1 on any failure.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf('--' + name);
  return index === -1 ? undefined : args[index + 1];
};
const browserName = option('browser') || 'chromium';
const channel = option('channel');
const engines = { chromium, firefox, webkit };
if (!engines[browserName]) {
  console.error('Unknown browser "' + browserName + '". Use chromium, firefox or webkit.');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const version = readFileSync(new URL('../src/psa.js', import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/)[1];
const port = 8766;
const base = 'http://127.0.0.1:' + port;

const server = spawn(process.execPath, ['test/serve.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Stop the server however this run ends, including a crash before the checks start.
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('Serving on')) resolve();
  });
  server.on('exit', (code) => reject(new Error('The test server exited with code ' + code)));
});

const lines = [];
const pass = (text) => lines.push({ ok: true, text: 'PASS ' + text });
const fail = (text) => lines.push({ ok: false, text: 'FAIL ' + text });
const consoleMessages = [];
let diagnostics = null;

// Where the test page got to, its errors and every player's state: printed when something fails.
const diagnose = (page) =>
  page
    .evaluate(() => ({
      progress: window.__speedCtlCheckProgress || [],
      psaRunning: !!window.__speedCtl,
      players: [...document.querySelectorAll('audio, video')].map((el) => ({
        name: el.dataset.expect || el.id || el.localName,
        readyState: el.readyState,
        paused: el.paused,
        error: el.error ? el.error.code + ' ' + (el.error.message || '') : null,
        time: Math.round(el.currentTime * 10) / 10,
        duration: el.duration,
        rate: el.playbackRate,
      })),
    }))
    .catch((err) => ({ unavailable: err.message.split('\n')[0] }));

let browser = null;
try {
  // 0. The test server: only the site's files are served, and a malformed address doesn't stop it.
  const status = (path) => fetch(base + path).then((res) => res.status, () => 0);
  for (const path of ['/.git/HEAD', '/AGENTS.md', '/package.json']) {
    const code = await status(path);
    if (code === 404) pass('test server hides ' + path);
    else fail('test server hides ' + path + ' — got ' + code);
  }
  const bad = await status('/%E0%A4%A');
  const after = await status('/index.html');
  if (bad === 400 && after === 200) pass('test server answers a malformed address with 400 and keeps running');
  else fail('test server and a malformed address — got ' + bad + ', then ' + after + ' for /index.html');

  // The checks start players from script, so let media play without a user gesture.
  browser = await engines[browserName].launch({
    channel,
    args: browserName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [],
    firefoxUserPrefs: browserName === 'firefox' ? { 'media.autoplay.default': 0 } : undefined,
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => fail('uncaught error on ' + page.url() + ': ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') consoleMessages.push(msg.type() + ': ' + msg.text());
  });

  // 1. The test page's own checks.
  await page.goto(base + '/test/test-page.html');
  await page.evaluate(() => localStorage.setItem('speedCtl.v1', JSON.stringify({ rate: 1.8 })));
  await page.waitForTimeout(2500); // the late player is added after 2 s
  await page.click('#load');
  await page.waitForFunction(() => window.__speedCtl, null, { timeout: 10000 });
  await page.click('#checks');
  // Off to the side: PSA doesn't fade in fullscreen while the pointer is on it.
  await page.mouse.move(5, 715);
  const results = await page
    .waitForFunction(() => window.__speedCtlCheckResults, null, { timeout: 90000 })
    .then((handle) => handle.jsonValue())
    .catch((err) => {
      fail('the test page did not finish its checks: ' + err.message.split('\n')[0]);
      return { lines: [] };
    });
  results.lines.forEach((text) => lines.push({ ok: !text.startsWith('FAIL'), text }));
  diagnostics = await diagnose(page);

  // 1b. Real fullscreen, which the test page can only pretend: the mouse must still reach PSA. (Chrome lets
  // it reach only what is inside the fullscreen element.)
  const reachName = 'the mouse reaches PSA over a real fullscreen element';
  await page.evaluate(() => {
    if (!window.__speedCtl) document.getElementById('load').click();
  });
  await page.waitForFunction(() => window.__speedCtl, null, { timeout: 10000 });
  await page.click('#fs');
  const wentFullscreen = await page
    .waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 })
    .then(() => true, () => false);
  if (!wentFullscreen) {
    lines.push({ ok: true, text: 'SKIP ' + reachName + ' — this browser did not go fullscreen here' });
  } else {
    await page.waitForTimeout(500);
    const spot = await page.evaluate(() => {
      const r = document.querySelector('speed-ctl').getBoundingClientRect();
      return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
    });
    await page.mouse.move(spot.x, spot.y, { steps: 3 });
    const reached = await page.evaluate(({ x, y }) => {
      const top = document.elementsFromPoint(x, y)[0];
      return { top: top ? top.localName : null, hover: document.querySelector('speed-ctl').matches(':hover') };
    }, spot);
    if (reached.top === 'speed-ctl' && reached.hover) pass(reachName);
    else fail(reachName + ' — ' + JSON.stringify(reached));
    await page.evaluate(() => document.exitFullscreen()).catch(() => {});
    await page.mouse.move(5, 715);
  }

  // 2. The real bookmarklet link: the encoded javascript: URL must run and report this version.
  await page.goto(base + '/');
  await page.click('a.bm');
  const linkVersion = await page
    .waitForFunction(() => window.__speedCtl && window.__speedCtl.inspect().version, null, { timeout: 10000 })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  if (linkVersion === version) pass('bookmarklet link on the install page runs PSA ' + version);
  else fail('bookmarklet link on the install page — got ' + JSON.stringify(linkVersion) + ', expected ' + version);
} catch (err) {
  fail('the run stopped: ' + err.message.split('\n')[0]);
} finally {
  if (browser) await browser.close();
}

const failed = lines.filter((line) => !line.ok);
const skipped = lines.filter((line) => line.text.startsWith('SKIP')).length;
console.log('PSA ' + version + ' · ' + browserName + (channel ? ' (' + channel + ')' : '') + '\n');
lines.forEach((line) => console.log(line.text));
console.log(
  '\n' +
    (failed.length
      ? failed.length + ' of ' + lines.length + ' checks failed'
      : 'All ' + (lines.length - skipped) + ' checks passed' + (skipped ? ', ' + skipped + ' skipped' : ''))
);
if (failed.length) {
  console.log('\nDiagnostics from the test page:\n' + JSON.stringify(diagnostics, null, 2));
  if (consoleMessages.length) console.log('\nBrowser console:\n' + consoleMessages.join('\n'));
}
process.exit(failed.length ? 1 : 0);
