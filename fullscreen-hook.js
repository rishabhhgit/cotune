// Runs in the page's own JS world (not the isolated content-script world) of
// every frame, before the page's scripts. While a Cotune party is open, a
// player inside an iframe that asks for fullscreen is redirected to Cotune's
// whole-page "theater" fullscreen, so the call overlay stays visible and
// clickable. content.js sets data-cotune-theater on <html> when this applies.
(() => {
  if (window === window.top) return;
  for (const name of ["requestFullscreen", "webkitRequestFullscreen"]) {
    const original = Element.prototype[name];
    if (!original) continue;
    Element.prototype[name] = function (...args) {
      if (!document.documentElement.hasAttribute("data-cotune-theater")) {
        return original.apply(this, args);
      }
      window.top.postMessage({ cotune: "fullscreen-request" }, "*");
      return Promise.resolve();
    };
  }
})();
