'use strict';

/* =========================================================
   Перекидное табло: каждая буква — отдельная пластинка.
   setFlaps(el, 'АСТАНА', 14) перещёлкивает только изменившиеся буквы,
   по дороге пролистывая пару случайных, как настоящее табло.
   ========================================================= */
const FLAP_CHARS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setFlaps(el, text, length, { instant = false, silent = false } = {}) {
  const target = String(text).toUpperCase().padEnd(length, ' ').slice(0, length);
  el.setAttribute('aria-label', String(text));
  // нужное количество пластинок
  while (el.children.length < length) {
    const ch = document.createElement('span');
    ch.className = 'ch';
    ch.setAttribute('aria-hidden', 'true');
    ch.textContent = ' ';
    el.append(ch);
  }
  while (el.children.length > length) el.lastElementChild.remove();

  [...el.children].forEach((ch, i) => {
    const next = target[i];
    if (ch.dataset.target === next) return;
    ch.dataset.target = next;
    clearTimeout(ch._timer);
    if (instant || reducedMotion) {
      ch.textContent = next;
      return;
    }
    let spins = 1 + Math.floor(Math.random() * 3);
    const step = () => {
      const last = spins === 0;
      ch.textContent = last ? next : FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)];
      ch.classList.remove('flip');
      void ch.offsetWidth; // перезапуск анимации
      ch.classList.add('flip');
      if (!silent) sfx.play('flap');
      if (!last) {
        spins--;
        ch._timer = setTimeout(step, 70);
      }
    };
    ch._timer = setTimeout(step, i * 22 + Math.random() * 40);
  });
}

// «Шуршание» пластинок во время загрузки
function spinFlaps(el, length) {
  const timer = setInterval(() => {
    const text = Array.from({ length }, () => FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)]).join('');
    setFlaps(el, text, length, { instant: true });
    [...el.children].forEach((ch) => {
      ch.classList.remove('flip');
      void ch.offsetWidth;
      ch.classList.add('flip');
    });
  }, 140);
  return () => clearInterval(timer);
}
