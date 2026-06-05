// SOKOLENOK boot guard.
// Runs before app.js. If the app fails on a browser, show a recovery screen
// instead of leaving the user on a blank page.
(function () {
  'use strict';
  var shown = false;
  var bootOk = false;

  function show(reason) {
    if (shown || bootOk) return;
    shown = true;
    try {
      var old = document.getElementById('sok-boot-guard');
      if (old) old.remove();
      var wrap = document.createElement('div');
      wrap.id = 'sok-boot-guard';
      wrap.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:grid',
        'place-items:center',
        'padding:22px',
        'background:#050807',
        'color:#eef7f4',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'text-align:center'
      ].join(';');
      wrap.innerHTML =
        '<div style="max-width:420px;width:100%;border:1px solid rgba(74,222,128,.24);border-radius:18px;padding:24px;background:#0b1311;box-shadow:0 20px 70px rgba(0,0,0,.45)">' +
          '<div style="font-size:12px;font-weight:800;letter-spacing:.18em;color:#42d392;margin-bottom:12px">SOKOLENOK</div>' +
          '<div style="font-size:24px;font-weight:900;margin-bottom:10px">Страница не запустилась</div>' +
          '<div style="font-size:14px;line-height:1.55;color:#9dafaa;margin-bottom:18px">Обновите страницу. Если вы на iPhone, откройте сайт в новой вкладке или очистите данные сайта в Safari.</div>' +
          '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
            '<button id="sok-boot-reload" style="height:42px;padding:0 16px;border:0;border-radius:10px;background:#42d392;color:#061008;font-weight:800">Обновить</button>' +
            '<a href="/" style="height:42px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,.14);color:#eef7f4;text-decoration:none;display:inline-flex;align-items:center;font-weight:700">На главную</a>' +
          '</div>' +
          '<div style="font-size:11px;color:#5f746d;margin-top:14px">code: ' + String(reason || 'boot') + '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      var btn = document.getElementById('sok-boot-reload');
      if (btn) btn.onclick = function () {
        try {
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function (regs) {
              regs.forEach(function (r) { r.unregister(); });
              location.reload();
            });
            return;
          }
        } catch (_) {}
        location.reload();
      };
    } catch (_) {}
  }

  window.SOK_BOOT_OK = function () {
    bootOk = true;
    var old = document.getElementById('sok-boot-guard');
    if (old) old.remove();
  };

  window.addEventListener('error', function (event) {
    var src = event && event.filename ? event.filename : '';
    if (!bootOk && (!src || src.indexOf('/app.js') !== -1)) show('js-error');
  });
  window.addEventListener('unhandledrejection', function () {
    if (!bootOk) show('promise-error');
  });

  setTimeout(function () {
    if (!bootOk && document.body && document.body.dataset && document.body.dataset.page) show('timeout');
  }, 9000);
})();
