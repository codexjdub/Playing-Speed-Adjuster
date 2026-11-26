// The welcome page, opened once when PSA is installed. It runs PSA itself (psa.js, loaded after this) on a
// sample tune. Content scripts don't reach the extension's own pages, so this stands in for bridge.js: it
// answers PSA's "hello" with the default settings and drops everything PSA sends, so nothing done here is
// saved or shows up among the saved sites.
(() => {
  const DEFAULTS = { defaultRate: 1, shortcuts: true, autoShow: true };
  const toPage = (message) => document.dispatchEvent(new CustomEvent('psa:to-page', { detail: JSON.stringify(message) }));
  document.addEventListener('psa:from-page', (event) => {
    let message = null;
    try {
      message = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    if (message && message.type === 'hello') {
      toPage({
        type: 'init',
        top: true,
        fresh: false,
        settings: { ...DEFAULTS, rate: undefined },
        positions: {},
      });
    }
  });

  // A gentle tune, made here so the page needs no media file: a melody over slow bass notes, 48 s, looped.
  function tuneUrl() {
    const rate = 22050;
    const seconds = 48;
    const n = rate * seconds;
    const data = new DataView(new ArrayBuffer(44 + n * 2));
    const ascii = (offset, text) => [...text].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    data.setUint32(4, 36 + n * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 1, true);
    data.setUint32(24, rate, true);
    data.setUint32(28, rate * 2, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    ascii(36, 'data');
    data.setUint32(40, n * 2, true);
    const hz = (semitones) => 440 * Math.pow(2, semitones / 12);
    // A major pentatonic, in steps from A4.
    const melody = [0, 4, 7, 9, 12, 9, 7, 4, 2, 4, 7, 12, 14, 12, 9, 7];
    const bass = [-24, -20, -17, -22];
    const note = 0.375;
    for (let i = 0; i < n; i += 1) {
      const t = i / rate;
      const step = Math.floor(t / note);
      const into = t - step * note;
      const lead = Math.sin(2 * Math.PI * hz(melody[step % melody.length]) * t) * Math.exp(-into * 6) * 0.28;
      const bar = Math.floor(t / (note * 8));
      const intoBar = t - bar * note * 8;
      const low = Math.sin(2 * Math.PI * hz(bass[bar % bass.length]) * t) * Math.exp(-intoBar * 0.9) * 0.18;
      const fade = Math.min(1, t * 8, (seconds - t) * 8);
      data.setInt16(44 + i * 2, Math.round((lead + low) * fade * 32767), true);
    }
    return URL.createObjectURL(new Blob([data.buffer], { type: 'audio/wav' }));
  }

  const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">
    <rect width="320" height="200" fill="#1d3b5c"/><circle cx="74" cy="56" r="22" fill="#e9eef5"/>
    <rect y="112" width="320" height="88" fill="#14507a"/>
    <path d="M0 112 q24 -12 48 0 t48 0 t48 0 t48 0 t48 0 t48 0 t48 0 v16 h-320z" fill="#2a6f9e"/>
    <path d="M0 146 q24 -10 48 0 t48 0 t48 0 t48 0 t48 0 t48 0 t48 0 v16 h-320z" fill="#1f5f8b"/>
    <rect x="220" y="134" width="100" height="66" fill="#d8c08a"/></svg>`;

  const PLAY = 'M4.5 2.3v11.4c0 .6.6.9 1.1.6l8.6-5.7c.4-.3.4-.9 0-1.2L5.6 1.7c-.5-.3-1.1 0-1.1.6z';
  const PAUSE = 'M3.5 2h3v12h-3zM9.5 2h3v12h-3z';
  const field = (id) => document.getElementById(id);
  const sample = field('sample');
  sample.poster = 'data:image/svg+xml,' + encodeURIComponent(art);
  sample.loop = true;
  sample.src = tuneUrl();

  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const speed = (r) => (Math.round(r * 100) / 100).toString() + '×';
  function show() {
    const playing = !sample.paused;
    field('playIcon').setAttribute('d', playing ? PAUSE : PLAY);
    field('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    field('status').textContent = playing
      ? 'Playing at ' + speed(sample.playbackRate) + ' · ' + clock(sample.currentTime)
      : sample.currentTime > 0
        ? 'Paused at ' + clock(sample.currentTime)
        : 'Press play';
  }
  const toggle = () => (sample.paused ? sample.play().catch(() => {}) : sample.pause());
  field('play').addEventListener('click', toggle);
  sample.addEventListener('click', toggle);
  ['play', 'pause', 'ratechange', 'timeupdate'].forEach((type) => sample.addEventListener(type, show));
  field('settings').addEventListener('click', () => browser.runtime.openOptionsPage());

  // welcome.html?new, from the panel's "New" tag after an update: this version's news above the sample.
  const version = browser.runtime.getManifest().version;
  if (new URLSearchParams(location.search).has('new') && NEWS[version]) {
    document.title = "What's new in PSA " + version;
    document.querySelector('h1').textContent = "What's new in PSA " + version;
    document.querySelector('header p').textContent = 'PSA updated itself. Here is what changed, with the tune below to try it on.';
    field('newsList').replaceChildren(
      ...NEWS[version].map(([title, text]) => {
        const item = document.createElement('li');
        const name = document.createElement('b');
        name.textContent = title;
        item.append(name, text);
        return item;
      })
    );
    field('news').hidden = false;
  }
})();
