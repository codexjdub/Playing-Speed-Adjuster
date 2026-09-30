// Builds the bookmarklet from src/psa.js. No dependencies.
//
//   node build.mjs
//
// Writes dist/psa.min.js (plain script, used by the test page), dist/bookmarklet.txt (the javascript: URL),
// and index.html, the install page (from src/install.html) that GitHub Pages serves at the site root.
// dist/install.html is a redirect to it for links from before the page moved.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const source = readFileSync(join(root, 'src', 'psa.js'), 'utf8');
const template = readFileSync(join(root, 'src', 'install.html'), 'utf8');
const version = (source.match(/const VERSION = '([^']+)'/) || [])[1];
if (!version) throw new Error("src/psa.js has no `const VERSION = '…'` line");

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
