// Builds the bookmarklet from src/psa.js. Needs terser (a dev dependency):
//
//   npm ci
//   node build.mjs
//
// Writes dist/psa.min.js (plain script, used by the test page), dist/bookmarklet.txt (the javascript: URL),
// and index.html, the install page (from src/install.html) that GitHub Pages serves at the site root.
// dist/install.html is a redirect to it for links from before the page moved.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { minify } from 'terser';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const source = readFileSync(join(root, 'src', 'psa.js'), 'utf8');
const template = readFileSync(join(root, 'src', 'install.html'), 'utf8');
const version = (source.match(/const VERSION = '([^']+)'/) || [])[1];
if (!version) throw new Error("src/psa.js has no `const VERSION = '…'` line");

// Terser leaves template literals alone, so squeeze the panel's CSS first: collapse whitespace and drop it
// around { } ; : , (the CSS has no descendant selectors followed by a pseudo-class, where a space matters).
const squeezeCss = (css) =>
  css
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
const prepared = source.replace(/const CSS = `([^`]*)`;/, (all, css) => 'const CSS = `' + squeezeCss(css) + '`;');

// Renames the bookmarklet's internal names, removes whitespace and shortens syntax. Text and property
// names are untouched, so saved settings and window.__speedCtl stay the same. play() keeps its name
// because it replaces HTMLMediaElement.prototype.play while the panel is open.
const minified = await minify(prepared, {
  ecma: 2020,
  compress: { passes: 2, keep_fnames: /^play$/ },
  mangle: { keep_fnames: /^play$/ },
  format: { comments: false },
});
// Ending on `void 0` guarantees the javascript: URL evaluates to undefined; a string result would replace the page.
const code = minified.code.replace(/;?$/, ';void 0;');

// Throws with a line number if minifying ever breaks the syntax.
new vm.Script(code, { filename: 'psa.min.js' });

// Percent-encode only what a javascript: URL or the install page's href="…" can't carry as-is:
// % (it starts an escape), whitespace, # (fragment), " and & (HTML), and non-ASCII characters.
const encodeForUrl = (text) => text.replace(/[%\s#"&]|[^\x20-\x7e]/gu, (c) => encodeURIComponent(c));
const bookmarklet = 'javascript:' + encodeForUrl(code);

// The bookmarklet goes in last, so its %XX escapes are never mistaken for placeholders.
const install = template
  .replace(/<!-- Template[^\n]*-->\n/, '')
  .replaceAll('%SIZE%', code.length.toLocaleString('en'))
  .replaceAll('%VERSION%', version)
  .replaceAll('%BOOKMARKLET%', () => bookmarklet);

const redirect = `<!doctype html>
<meta charset="utf-8">
<title>Playing Speed Adjuster (PSA)</title>
<meta http-equiv="refresh" content="0; url=../">
<link rel="canonical" href="../">
<p>The install page has moved to <a href="../">the site's front page</a>.</p>
`;

mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'psa.min.js'), code + '\n');
writeFileSync(join(dist, 'bookmarklet.txt'), bookmarklet + '\n');
writeFileSync(join(dist, 'install.html'), redirect);
writeFileSync(join(root, 'index.html'), install);

console.log(`Built PSA ${version}: ${code.length} chars of code, ${bookmarklet.length} chars as a URL.`);
