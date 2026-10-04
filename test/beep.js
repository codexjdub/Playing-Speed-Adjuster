// Test tone: an 8-bit mono WAV with a 0.12 s beep every second, so speed changes are audible (pitch stays the
// same). Generated here so the test pages need no media files.
function beepUrl(freq, seconds) {
  const sampleRate = 8000;
  const n = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + n);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + n, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  ascii(36, 'data'); view.setUint32(40, n, true);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const s = t % 1 < 0.12 ? Math.sin(2 * Math.PI * freq * t) * 0.2 : 0;
    view.setUint8(44 + i, 128 + Math.round(s * 127));
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
