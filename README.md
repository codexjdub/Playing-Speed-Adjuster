# Playing Speed Adjuster (PSA)

PSA is a bookmarklet that opens a small floating panel for the HTML5 `<audio>` and `<video>` on the current page. It works on any site; nothing in it is specific to one site.

<img src="docs/panel.png" alt="The PSA panel: title and status, −10s / Play / +20s buttons, the speed readout at 1.50× with − and + buttons, and speed presets" width="320">

- Speed from 0.25× to 4×: −/+ in 0.05 steps, presets (1, 1.25, 1.5, 1.75, 2, 2.5, 3), click the readout and type a value (`1.6`, `1.6x`, `160%`), or use the [keyboard shortcuts](#keyboard-shortcuts).
- Applies the speed to **every** audio and video element on the page, including ones added later, ones inside open shadow roots and same-origin iframes, and off-page `new Audio()` players.
- Remembers the speed (and panel position) per site in `localStorage`, and where you left off in long recordings: play one again from the start and the panel offers **Resume at 12:34**.
- Keeps re-applying the speed so sites that reset `playbackRate` don't win.
- Play/Pause, −10 s / +20 s skips, a best-effort title and the real time left at your speed for the active item (the one that most recently started playing), plus a picture-in-picture button for videos. Use ‹ › to pick another item; the one you pick is outlined on the page, and scrolled into view if needed.
- Live streams (live radio, anything without an end) stay at normal speed, since speeding them up only causes buffering.
- Drag the panel by its top bar, or minimize it (or double-click the bar) to a small pill that shows the speed, remembered per site. The pill has − and + for 0.1 steps, a menu of common speeds behind the speed, and a blue dot that glows briefly when the pill appears or the speed changes, so it's easy to spot. In fullscreen it has a spot of its own: the top-left corner until you drag it during fullscreen, then wherever you left it (per site). There the pill shrinks to the blue dot and the speed (the full pill again while you hover over it), and PSA fades away after 3 s without mouse movement, coming back when you move the mouse or the speed changes. Over a fullscreen embedded player, where PSA can't see the mouse, it doesn't fade. It stays open until you click × or run the bookmarklet again, and stays on top of fullscreen video and the page's own dialogs and popovers.

## Install

**[Open the install page](https://codexjdub.github.io/Playing-Speed-Adjuster/)** and drag the **PSA** button onto your bookmarks bar. The page also has demo tracks to try it on.

Or copy and paste: open [`dist/bookmarklet.txt`](dist/bookmarklet.txt) on GitHub and click **Copy raw file**. Create a bookmark named `PSA` and paste the copied line as its URL. In Safari, bookmark any page, then use **Edit Address…** on it.

The [test page](https://codexjdub.github.io/Playing-Speed-Adjuster/test/test-page.html) has many kinds of players and a button that runs automated checks.

Click the bookmark on a page with audio or video to open the panel. Click it again, or click ×, to close it.

In Firefox, you can [add the extension](https://addons.mozilla.org/firefox/addon/playing-speed-adjuster-psa/) instead; see [Firefox extension](#firefox-extension).

## Firefox extension

In Firefox, **[add PSA from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/playing-speed-adjuster-psa/)** to have it run on its own. It applies your speed and saves your place on every page, shows a small speed pill when something starts playing, and opens the full panel from its toolbar button (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>). Players embedded from other sites, such as a YouTube video in a blog, follow the page's speed; when the page has no player of its own, the panel names the embedded one's site. Its settings page has a speed for sites without one of their own, switches for the pill and the keyboard shortcuts, a list of sites to leave alone, and the sites with a saved speed or places, each of which can be forgotten on its own. On its first visit to a site, it brings over the speed and places the bookmarklet saved there, then removes them from the site's storage. In private windows it uses your saved speeds but saves nothing. It updates itself, and needs Firefox 140 or later (142 on Android).

## Keyboard shortcuts

While the panel is open, including minimized:

| Key | Action |
| --- | --- |
| `[` | Slow down by 0.1 |
| `]` | Speed up by 0.1 |
| `\` | Set 1.5× |

They're ignored while you type in a text field, and ⌘ or Ctrl combinations are left to the browser (⌘[ is still Back). When PSA handles a key, the page doesn't also receive it.

## Updating

Bookmarklets don't update themselves. The panel shows its version next to "PSA", and the install page shows the latest one. If yours is older, drag the button from the install page to your bookmarks bar again and delete the old bookmark. See [Releases](https://github.com/codexjdub/Playing-Speed-Adjuster/releases) for what changed.

## How it works

`src/psa.js` is the readable source and `src/install.html` is the install page template; `npm run build` rebuilds `dist/` and the site's `index.html`. The build minifies the code with [terser](https://terser.org/), checks the result parses, and writes strings in single quotes, and percent-encodes only the characters a `javascript:` URL can't carry, which keeps the bookmarklet around 35 KB.

- **Finding media.** Every 500 ms the panel queries each known document and shadow root for `audio, video`; every 2 s it re-walks the page to find new open shadow roots and same-origin iframes. While the panel is open, `HTMLMediaElement.prototype.play` is wrapped so players that are never inserted into the page are found too; closing the panel restores it.
- **Holding the speed.** Live streams are left alone: a MediaStream source, an `Infinity` duration, or a duration that keeps growing (chunked live players such as RTHK live radio). One that was sped up before it was known to be live is put back to 1×. For everything else it sets both `playbackRate` and `defaultPlaybackRate`, the latter because `load()` resets to it. It re-applies whenever the page changes a player's speed or source, when a player starts, and on every tick. If a site resets an element more than 8 times in 2 s, the panel replaces that element's `playbackRate` setter so the page's writes are ignored ("speed locked" in the panel). Closing the panel removes the lock.
- **Resume positions.** While the panel is open, it saves how far each recording longer than 3 minutes has got: every 5 s while playing, and at once on pause or when you leave the page. Recordings are told apart by the page they started playing on and their length (within 2 s, since players refine it as they load), because many sites play through a temporary `blob:` address that changes on every visit. The page address ignores tracking and start-time parameters such as `utm_…`, `fbclid` and `t`, and a player in an `about:blank` or `srcdoc` frame counts as part of the page around it. Positions in the first 30 s aren't saved, so starting over doesn't lose the old one, and a recording played to within 30 s of its end is forgotten. A stream that turns out to be live has its entry removed. They live in the site's `localStorage` under their own key, up to 100 per site.
- **Picture-in-picture.** For a video with a picture, the panel calls `requestPictureInPicture()`, first clearing `disablePictureInPicture` if the site set it. The button only appears where the browser lets pages start picture-in-picture (`document.pictureInPictureEnabled`).
- **Titles**, first match wins:
  1. The element's own `aria-label`, `aria-labelledby` or `title`.
  2. Text next to the player: walk outwards one container at a time and take the first visible heading, else visible text. Skip player controls, timecodes, text drawn over the video, and screen-reader-only text. Stop before a container that holds another player, because shared text can't tell them apart.
  3. Media Session metadata (`title — artist`), only when that item is the one playing.
  4. The media file name.
  5. The page title.

  With a single player on the page, Media Session is tried before nearby text.
- **Firefox extension.** The build wraps `src/psa.js` in a function and writes it, readable, to `dist/firefox/` with the files in `src/firefox/`. It runs in the page's own world, where wrapping `play()` and holding the speed work, and `bridge.js` passes messages between it and the background script, which keeps settings and positions in extension storage per site (the tab's page origin). A page reaches only its own site's values, and a frame embedded from another site only the speed. On a page without media and with no panel showing, it looks only every 5 s, walks the whole page every 30 s, and doesn't look at all while the tab is in the background; `[ ] \` are left alone there unless a player embedded from another site has played. After an update, the new version stops the copy already running in each open tab (copies from 1.7.4 and earlier stay until the tab reloads).
- **Isolation.** The panel lives in a shadow root on a `popover="manual"` host, so it sits in the top layer above page content. It is re-shown on top when fullscreen starts or the page opens its own dialog or popover, and while a modal dialog is open it moves inside it, since a modal dialog makes everything outside it unclickable. For the same reason it moves inside a fullscreen element: Chrome lets the mouse reach only what is inside one. The UI is built with DOM calls only (no `innerHTML`), so Trusted Types pages like YouTube don't block it. Styles use a constructed stylesheet, which a `style-src` CSP doesn't block. Keystrokes and clicks inside the panel don't reach the page, so typing a speed doesn't trigger site shortcuts. Clicking panel buttons doesn't take keyboard focus from the page.

## Limits

- Media inside **cross-site iframes** (e.g. a YouTube embed on a blog) can't be reached by the bookmarklet. Open the embed's own page and run the bookmarklet there. The Firefox extension reaches them, but only to apply the speed.
- Closed shadow roots and players that use only the Web Audio API have no reachable media element.
- In browsers without the Popover API, the panel can't show over a bare fullscreen `<video>` or the page's own dialogs. In Chrome it shows over a bare fullscreen `<video>` or embedded player but can't be clicked there, since it can't go inside them; the keyboard shortcuts still work.

## Development

Bump `VERSION` at the top of `src/psa.js` for each release; the build copies it to the install page.

```
npm ci
npm run build
npm test
```

`npm ci` installs the development tools (Node 20+): terser for the build and Playwright for the tests. Neither goes into the bookmarklet.

`npm test` opens the test page in headless Chrome, using your installed copy so nothing extra is downloaded. It runs the page's checks, checks that the mouse reaches PSA in real fullscreen, and clicks the real bookmarklet link on the install page. The test page covers labelled and unlabelled players, a shared heading with per-player labels, a stubborn page that keeps resetting the speed, a late-inserted player, shadow DOM, a same-origin iframe, off-page audio with Media Session, a playlist that calls `load()`, screen-reader-only text, a fullscreen container, live streams, a text field inside a closed shadow root, modal dialogs (one on top of another too), a popover over the whole page and a long recording; it also checks the skip buttons, the time left, picture-in-picture, resuming, the speed box, minimizing, the outline and the keyboard shortcuts. The runner also checks that the test server serves only the site's files.

To try a local build of the Firefox extension, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and choose `dist/firefox/manifest.json`. Firefox removes it when it restarts.

To try things by hand, run `npm run serve`, open http://127.0.0.1:8765/test/test-page.html, click **Load PSA**, pick a speed other than 1×, and click **Run checks**.

On every push, two GitHub Actions run:

- **Build check:** rebuilds and fails if the committed `dist/` or `index.html` doesn't match `src/`.
- **Tests:** runs the same checks in Chromium, Firefox and WebKit (Safari's engine). It also checks the Firefox extension with Mozilla's add-on checker and a smoke test in Firefox (`test/firefox-extension.mjs`, which needs `selenium-webdriver` and geckodriver, so it runs only there).

Publishing a GitHub release runs a third, **Firefox Add-ons**, which submits that version of the extension to Firefox Add-ons with its source code, the notes for Mozilla's reviewers (`src/firefox/reviewer-notes.txt`) and the release's "What's new". It needs two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, from an [API key on Firefox Add-ons](https://addons.mozilla.org/developers/addon/api/key/). A failed submission can be retried from the Actions tab with **Run workflow** and the release's tag.

## License

[MIT](LICENSE)
