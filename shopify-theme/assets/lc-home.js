/* lc-home.js — scroll reveal for the homepage (Étape 4).
   Adds .is-visible to .lc-reveal elements as they enter the viewport.
   Respects prefers-reduced-motion. Deployed via Asset API to theme 160213696617,
   loaded (defer) from the lc_hero custom-liquid section. */
(function () {
  function showAll() {
    document.querySelectorAll('.lc-reveal').forEach(function (el) {
      el.classList.add('is-visible');
    });
  }
  // No IntersectionObserver (old browsers) or reduced motion: show everything immediately.
  if (!('IntersectionObserver' in window) ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    showAll();
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });

  function init() {
    document.querySelectorAll('.lc-reveal').forEach(function (el) { io.observe(el); });
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
