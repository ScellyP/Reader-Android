/* Moon & space theme glue: fills every [data-moon] badge with today's real
   moon phase (same maths as the Moonlit Lock) and keeps it fresh. The theme's
   stars, ornaments and glows are plain CSS (see <style id="moon-theme">). */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  function paint() {
    const ml = window.NovelMoonLock;
    if (!ml || !ml.moonPhaseInfo || !ml.moonPhasePath) return;
    const phase = ml.moonPhaseInfo(new Date());
    const label = phase.name + ' \u00b7 ' + Math.round(phase.illumination * 100) + '% lit';
    document.querySelectorAll('[data-moon-label]').forEach(function (el) { el.textContent = label; });
    document.querySelectorAll('[data-moon]').forEach(function (el) {
      el.textContent = '';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const disc = document.createElementNS(NS, 'circle');
      disc.setAttribute('cx', '12'); disc.setAttribute('cy', '12'); disc.setAttribute('r', '10');
      disc.setAttribute('fill', 'currentColor'); disc.setAttribute('fill-opacity', '.16');
      disc.setAttribute('stroke', 'currentColor'); disc.setAttribute('stroke-opacity', '.45'); disc.setAttribute('stroke-width', '1.2');
      const lit = document.createElementNS(NS, 'path');
      lit.setAttribute('d', ml.moonPhasePath(phase.fraction, 12, 12, 10));
      lit.setAttribute('fill', 'currentColor');
      svg.appendChild(disc); svg.appendChild(lit);
      el.appendChild(svg);
      el.setAttribute('title', label);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', label);
    });
  }
  paint();
  setInterval(paint, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') paint(); });
})();
