// Writes the metadata the Firefox Add-ons workflow sends with each version: the release's "What's new" as
// release notes (plain text, since Firefox Add-ons doesn't render Markdown) and src/firefox/reviewer-notes.txt
// for Mozilla's reviewers. Reads the release body from RELEASE_NOTES and writes to the path given.
import { readFileSync, writeFileSync } from 'node:fs';

const body = (process.env.RELEASE_NOTES || '').replace(/\r/g, '');
const notes = body
  .split(/\n## Updating/)[0]
  .replace(/^## [^\n]*\n+/, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  .replace(/^- /gm, '• ')
  .trim();
if (!notes) throw new Error('The release has no "What\'s new" notes.');
const approval = readFileSync(new URL('../../src/firefox/reviewer-notes.txt', import.meta.url), 'utf8');
const metadata = { version: { release_notes: { 'en-US': notes }, approval_notes: approval } };
writeFileSync(process.argv[2], JSON.stringify(metadata, null, 2) + '\n');
console.log('Release notes for Firefox Add-ons:\n\n' + notes);
