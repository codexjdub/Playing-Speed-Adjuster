# Playing Speed Adjuster (PSA)

PSA is a bookmarklet that opens a small floating panel for the HTML5 `<audio>` and `<video>` on the current page. It works on any site; nothing in it is specific to one site.

- Speed from 0.25× to 4×: −/+ in 0.05 steps, presets (1, 1.25, 1.5, 1.75, 2, 2.5, 3), or click the readout and type a value (`1.6`, `1.6x`, `160%`).
- Applies the speed to **every** audio and video element on the page, including ones added later, ones inside open shadow roots and same-origin iframes, and off-page `new Audio()` players.
- Remembers the speed (and panel position) per site in `localStorage`.
- Keeps re-applying the speed so sites that reset `playbackRate` don't win.
- Play/Pause and a best-effort title for the active item (the one that most recently started playing). Use ‹ › to pick another item.
- Drag the panel by its top bar. It stays open until you click × or run the bookmarklet again.

## Install

**[Open the install page](https://codexjdub.github.io/Playing-Speed-Adjuster/dist/install.html)** and drag the **PSA** button onto your bookmarks bar.

Or copy and paste: open [`dist/bookmarklet.txt`](dist/bookmarklet.txt) on GitHub and click **Copy raw file**. Create a bookmark named `PSA` and paste the copied line as its URL. In Safari, bookmark any page, then use **Edit Address…** on it.

You can try it on the [test page](https://codexjdub.github.io/Playing-Speed-Adjuster/test/test-page.html).

Click the bookmark on a page with audio or video to open the panel. Click it again, or click ×, to close it.

## How it works

`src/psa.js` is the readable source; `node build.mjs` (Node 18+, no dependencies) rebuilds `dist/`. The build strips comments and indentation, checks the result parses, and URL-encodes it.

- **Finding media.** Every 500 ms the panel queries each known document and shadow root for `audio, video`; every 2 s it re-walks the page to find new open shadow roots and same-origin iframes. While the panel is open, `HTMLMediaElement.prototype.play` is wrapped so players that are never inserted into the page are found too; closing the panel restores it.
- **Holding the speed.** It sets both `playbackRate` and `defaultPlaybackRate`, the latter because `load()` resets to it. It re-applies on `ratechange`, `play`, `loadstart` and `loadedmetadata`, and on every tick. If a site resets an element more than 8 times in 2 s, the panel replaces that element's `playbackRate` setter so the page's writes are ignored ("speed locked" in the panel). Closing the panel removes the lock.
- **Titles**, first match wins:
  1. The element's own `aria-label`, `aria-labelledby` or `title`.
  2. Text next to the player: walk outwards one container at a time and take the first visible heading, else visible text. Skip player controls, timecodes, text drawn over the video, and screen-reader-only text. Stop before a container that holds another player, because shared text can't tell them apart.
  3. Media Session metadata (`title — artist`), only when that item is the one playing.
  4. The media file name.
  5. The page title.

  With a single player on the page, Media Session is tried before nearby text.
- **Isolation.** The panel lives in a shadow root on a `popover="manual"` host, so it sits in the top layer above page content and is re-shown above a fullscreen element when fullscreen starts. The UI is built with DOM calls only (no `innerHTML`), so Trusted Types pages like YouTube don't block it. Styles use a constructed stylesheet, which a `style-src` CSP doesn't block. Keystrokes and clicks inside the panel don't reach the page, so typing a speed doesn't trigger site shortcuts. Clicking panel buttons doesn't take keyboard focus from the page.

## Limits

- Media inside **cross-site iframes** (e.g. a YouTube embed on a blog) can't be reached. Open the embed's own page and run the bookmarklet there.
- Closed shadow roots and players that use only the Web Audio API have no reachable media element.
- In browsers without the Popover API, the panel can't show over a bare fullscreen `<video>`.

## Development

```
node build.mjs
node test/serve.mjs
```

Then open http://127.0.0.1:8765/test/test-page.html, click **Load controller**, pick a speed other than 1×, and click **Run checks**. The test page covers labelled and unlabelled players, a shared heading with per-player labels, a stubborn page that keeps resetting the speed, a late-inserted player, shadow DOM, a same-origin iframe, off-page audio with Media Session, a playlist that calls `load()`, screen-reader-only text, and a fullscreen container. `.claude/launch.json` starts the same server for Claude Code's preview browser.

## License

[MIT](LICENSE)
