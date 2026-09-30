// Builds the bookmarklet from src/psa.js. No dependencies.
//
//   node build.mjs
//
// Writes dist/psa.min.js (plain script, used by the test page),
// dist/bookmarklet.txt (the javascript: URL) and dist/install.html (drag-to-install page).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const source = readFileSync(join(root, 'src', 'psa.js'), 'utf8');

// Syntax-safe shrinking: drop the header comment, full-line // comments, indentation and blank lines.
// Newlines are kept, so trailing comments and automatic semicolons still parse the same way.
const code = source
  .replace(/^\/\*[\s\S]*?\*\/\s*/, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('//'))
  .join('\n');

// Throws with a line number if the shrinking ever breaks the syntax.
new vm.Script(code, { filename: 'psa.min.js' });

const bookmarklet = 'javascript:' + encodeURIComponent(code);

const install = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playing Speed Adjuster</title>
<style>
  :root { --bg: #f6f6f4; --fg: #1d1d1f; --muted: #5f6368; --card: #ffffff; --line: #deded9; --accent: #1a66d2; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161618; --fg: #f2f2f2; --muted: #a3a3a8; --card: #212124; --line: #36363a; --accent: #6aa8ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  p, li { color: var(--fg); }
  .lede { color: var(--muted); margin: 0 0 28px; }
  .bm { display: inline-flex; align-items: center; gap: 8px; padding: 12px 20px; border-radius: 10px;
        background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; cursor: grab; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  ol { padding-left: 22px; margin: 16px 0 0; }
  textarea { width: 100%; height: 88px; margin-top: 8px; padding: 10px; border-radius: 8px; border: 1px solid var(--line);
             background: var(--bg); color: var(--fg); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  button { margin-top: 8px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card);
           color: var(--fg); font: inherit; cursor: pointer; }
  code { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Playing Speed Adjuster (PSA)</h1>
  <p class="lede">A floating speed and play/pause panel for the audio and video on any page.</p>

  <div class="card">
    <a class="bm" href="${bookmarklet}" title="Drag me to your bookmarks bar">PSA</a>
    <ol>
      <li>Show your bookmarks bar (<code>⌘⇧B</code> on Mac, <code>Ctrl+Shift+B</code> on Windows).</li>
      <li>Drag the <strong>PSA</strong> button onto it.</li>
      <li>On a page with audio or video, click the bookmark. Click it again (or ×) to close the panel.</li>
    </ol>
  </div>

  <h2>Can't drag? Paste it instead</h2>
  <p>Create a new bookmark named <strong>PSA</strong>, then paste this as its URL (works in Safari and on mobile):</p>
  <textarea id="code" readonly>${bookmarklet}</textarea>
  <button id="copy" type="button">Copy bookmarklet</button>
  <span id="copied" class="muted"></span>

  <h2>What it does</h2>
  <ul>
    <li>Sets the speed of every audio and video element on the page, including ones added later.</li>
    <li>Remembers the speed for each site and keeps re-applying it if the site resets it.</li>
    <li>Play/Pause and a best-effort title for the item that most recently started playing; ‹ › switches items.</li>
    <li>Drag the panel by its top bar. It stays until you close it.</li>
  </ul>
  <p class="muted">${code.length.toLocaleString('en')} characters. Can't reach media inside cross-site iframes
    (e.g. a YouTube embed on another site) — open the embed's own page instead.</p>
</main>
<script>
  document.getElementById('copy').addEventListener('click', async () => {
    const box = document.getElementById('code');
    try {
      await navigator.clipboard.writeText(box.value);
    } catch (err) {
      box.select();
      document.execCommand('copy');
    }
    document.getElementById('copied').textContent = 'Copied.';
  });
</script>
</body>
</html>
`;

mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'psa.min.js'), code + '\n');
writeFileSync(join(dist, 'bookmarklet.txt'), bookmarklet + '\n');
writeFileSync(join(dist, 'install.html'), install);

console.log(`Built bookmarklet: ${code.length} chars of code, ${bookmarklet.length} chars as a URL.`);
