/* Copy is a battery (2026-11-14). Press it: what it holds goes to the clipboard, the battery shows full for 1.5 s, then
   empty again. No clipboard here: the text is shown selected, with "Select & copy".
   <button class="batt" data-copytext="ID" aria-label="Copy ...">  copies the text of the element ID (read when pressed)
   <pre> in a page's text gets one of its own (its code, read when pressed).
   STK_COPY.bind(button, function(){ return text; })  for anything else (the top page's stk.py). */
(function () {
  var SVG = '<svg viewBox="0 0 44 22" width="44" height="22" aria-hidden="true" focusable="false">' +
    '<rect x="1" y="1" width="37" height="20" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="39.5" y="7" width="3.5" height="8" rx="1.5" fill="currentColor"/>' +
    '<rect class="cell" x="4.5" y="4.5" width="30" height="13" rx="2" fill="currentColor"/></svg>';

  function fallback(btn, text) {
    var box = btn._sel;
    if (!box) {
      box = btn._sel = document.createElement("div");
      box.className = "batt-sel";
      box.innerHTML = '<span class="muted">Select &amp; copy</span><textarea readonly rows="4"></textarea>';
      btn.insertAdjacentElement("afterend", box);
    }
    var ta = box.querySelector("textarea");
    ta.value = text;
    box.hidden = false;
    ta.focus();
    ta.select();
  }

  function bind(btn, get) {
    if (btn._batt) return;
    btn._batt = true;
    btn.classList.add("batt");
    btn.type = "button";
    if (!btn.querySelector("svg")) btn.insertAdjacentHTML("afterbegin", SVG);
    btn.addEventListener("click", function () {
      var text = get();
      if (text == null || text === "") return;   // nothing to copy yet: the page says why next to it
      var write = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject();
      write.then(function () {
        clearTimeout(btn._t);
        btn.classList.add("full");
        btn.setAttribute("data-state", "copied");
        btn._t = setTimeout(function () { btn.classList.remove("full"); btn.removeAttribute("data-state"); }, 1500);
        if (btn._sel) btn._sel.hidden = true;
      }, function () { fallback(btn, text); });
    });
  }

  function all(root) {
    (root || document).querySelectorAll("[data-copytext]").forEach(function (b) {
      bind(b, function () { var el = document.getElementById(b.getAttribute("data-copytext")); return el ? el.textContent : ""; });
    });
    (root || document).querySelectorAll("main pre").forEach(function (pre) {
      if (pre._batt || pre.hasAttribute("data-nocopy")) return;
      pre._batt = true;
      var b = document.createElement("button");
      b.className = "batt on-pre";
      b.setAttribute("aria-label", "Copy this code");
      pre.insertAdjacentElement("beforebegin", b);
      bind(b, function () { var c = pre.querySelector("code") || pre; return c.textContent; });
    });
  }

  window.STK_COPY = { bind: bind, all: all };
  function start() {
    all();
    // code a page adds later (the docs read some of theirs in): its own battery too
    var main = document.querySelector("main");
    if (main && window.MutationObserver) {
      var t = null;
      new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { all(main); }, 50); }).observe(main, { childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
