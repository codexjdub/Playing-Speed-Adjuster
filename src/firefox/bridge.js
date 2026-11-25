// PSA for Firefox, in each frame's content-script world. PSA itself runs in the page's own world (psa.js),
// because wrapping play() and holding the speed only work there, but only this world can reach the
// background script. Messages between the two travel as JSON strings in DOM events on the document.
(() => {
  const TO_PAGE = 'psa:to-page';
  const FROM_PAGE = 'psa:from-page';
  let init = null;
  // Whether PSA runs on this page: it didn't start on a site to skip, and "Turn off PSA" stops it.
  let stopped = false;

  const toPage = (message) => document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));

  // This site's values, sent on as soon as they arrive. If psa.js isn't listening yet, its "hello" asks again.
  browser.runtime.sendMessage({ type: 'init' }).then(
    (reply) => {
      if (!reply || reply.excluded) return;
      init = { ...reply, type: 'init' };
      toPage(init);
    },
    () => {}
  );

  document.addEventListener(FROM_PAGE, (event) => {
    let message = null;
    try {
      message = JSON.parse(event.detail);
    } catch (err) {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello') {
      if (init) toPage(init);
      return;
    }
    browser.runtime.sendMessage(message).catch(() => {});
  });

  // The toolbar popup's question, answered here: PSA itself never replies.
  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'ping') return Promise.resolve(!!init && !stopped);
    if (message && message.type === 'stop') stopped = true;
    toPage(message);
    return undefined;
  });
})();
