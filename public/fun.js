'use strict';

/* =========================================================
   Звуки, голос диктора, значки, уведомления и пасхалки.
   Подключается первым: остальные файлы пользуются sfx, speak, award, toast.
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    /* хранилище недоступно: просто не запомним */
  }
}

const prefs = Object.assign({ sound: true, voice: true }, readStore('vokzal-prefs', {}));

/* ---------- Звуки: всё синтезируется в коде ---------- */
const sfx = (() => {
  let ctx = null;
  let lastFlap = 0;

  function audio() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, duration, { type = 'sine', volume = 0.12, delay = 0, slideTo = null } = {}) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  function noise(duration, { volume = 0.15, filter = 2000, delay = 0, type = 'bandpass' } = {}) {
    const a = audio();
    if (!a) return;
    const buffer = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * duration)), a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = a.createBufferSource();
    const biquad = a.createBiquadFilter();
    const gain = a.createGain();
    src.buffer = buffer;
    biquad.type = type;
    biquad.frequency.value = filter;
    gain.gain.value = volume;
    src.connect(biquad).connect(gain).connect(a.destination);
    src.start(a.currentTime + delay);
  }

  const SOUNDS = {
    // перещёлкивание пластинок табло
    flap: () => {
      const now = performance.now();
      if (now - lastFlap < 45) return;
      lastFlap = now;
      noise(0.025, { volume: 0.07, filter: 3200 + Math.random() * 1500 });
    },
    // вокзальный сигнал перед объявлением: до-ми-соль-до
    chime: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.9, { type: 'sine', volume: 0.09, delay: i * 0.32 })),
    ok: () => tone(880, 0.12, { type: 'triangle', volume: 0.06, slideTo: 1320 }),
    error: () => { tone(220, 0.18, { type: 'square', volume: 0.035 }); tone(165, 0.25, { type: 'square', volume: 0.035, delay: 0.16 }); },
    badge: () => [784, 988, 1319].forEach((f, i) => tone(f, 0.35, { type: 'triangle', volume: 0.07, delay: i * 0.08 })),
    chuh: () => {
      for (let i = 0; i < 8; i++) noise(0.12, { volume: 0.18, filter: 900, delay: i * 0.22, type: 'lowpass' });
      tone(660, 0.5, { type: 'sawtooth', volume: 0.03, delay: 1.8 });
      tone(880, 0.5, { type: 'sawtooth', volume: 0.03, delay: 1.8 });
    },
    bell: () => [0, 0.45].forEach((d) => { tone(1175, 1.4, { volume: 0.08, delay: d }); tone(2350, 0.8, { volume: 0.03, delay: d }); }),
  };

  return {
    play(name) {
      if (prefs.sound && SOUNDS[name]) SOUNDS[name]();
    },
  };
})();

/* ---------- Голос диктора ---------- */
function speak(text) {
  if (!prefs.voice || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const phrase = new SpeechSynthesisUtterance(text);
  phrase.lang = 'ru-RU';
  phrase.rate = 0.95;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('ru'));
  if (voice) phrase.voice = voice;
  window.speechSynthesis.speak(phrase);
}

/* ---------- Уведомления ---------- */
function toast(text, kind = '') {
  const box = $('#toasts');
  const item = document.createElement('div');
  item.className = 'toast' + (kind ? ' toast-' + kind : '');
  item.textContent = text;
  box.append(item);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => {
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 300);
  }, 3200);
}

/* ---------- Значки ----------
   Обычные значки повторяют состояния из задания, секретные — пасхалки. */
const BADGES = [
  { id: 'first', title: 'Первый рейс', text: 'Табло загрузилось с вашего сервера.', icon: 'train' },
  { id: 'e404', title: 'Поезд-призрак', text: 'Сервер честно ответил 404.', icon: 'ghost' },
  { id: 'e500', title: 'Авария', text: 'Поймали ответ 500 и не упали.', icon: 'bolt' },
  { id: 'slow', title: 'Долгое ожидание', text: 'Дождались ответа через 3 секунды.', icon: 'clock' },
  { id: 'timeout', title: 'Стоп-кран', text: 'Таймаут отменил запрос через abort().', icon: 'stop' },
  { id: 'json', title: 'Мятый билет', text: 'Разобрались с битым JSON.', icon: 'ticket' },
  { id: 'replaced', title: 'Пересадка', text: 'Новый запрос отменил предыдущий (canceled).', icon: 'switch' },
  { id: 'dedupe', title: 'Не толкайтесь', text: 'Двойной щелчок дал один запрос.', icon: 'hand' },
  { id: 'offline', title: 'Без связи', text: 'Сеть пропала, показаны сохранённые данные.', icon: 'plug' },
  { id: 'ws', title: 'Две кассы', text: 'Табло открыто в двух вкладках сразу.', icon: 'tabs' },
  { id: 'dispatcher', title: 'Диспетчер', text: 'Изменили поезд запросом PATCH.', icon: 'cap' },
  { id: 'announce', title: 'Диктор', text: 'Сделали объявление запросом POST.', icon: 'mic' },
  { id: 'weather', title: 'Синоптик', text: 'Узнали погоду через Open-Meteo.', icon: 'sun' },
  { id: 'lesson', title: 'Отличник', text: 'Выполнили все задания практикума.', icon: 'book' },
  { id: 'konami', title: 'Ночной экспресс', text: 'Секретный поезд вышел на путь 0.', icon: 'moon', secret: true },
  { id: 'chuh', title: 'Чух-чух', text: 'Набрали на клавиатуре «чух».', icon: 'smoke', secret: true },
  { id: 'rewind', title: 'Машина времени', text: 'Пять щелчков по часам.', icon: 'rewind', secret: true },
  { id: 'joke', title: 'Шутник', text: 'Задержка в 404, 500 или 777 минут.', icon: 'smile', secret: true },
];

const ICONS = {
  train: '<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9 16v4M15 16v4"/>',
  ghost: '<path d="M6 20V10a6 6 0 0 1 12 0v10l-2-2-2 2-2-2-2 2-2-2z"/><path d="M10 10h.01M14 10h.01"/>',
  bolt: '<path d="M13 2 5 14h6l-1 8 8-12h-6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stop: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M9 12h6"/>',
  ticket: '<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z"/><path d="M13 7v10" stroke-dasharray="2 2"/>',
  switch: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  hand: '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L8 15"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5M3 3l18 18"/>',
  tabs: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M9 6V4h10a2 2 0 0 1 2 2v10h-2"/>',
  cap: '<path d="M3 13h18M5 13c0-5 3-8 7-8s7 3 7 8M3 13l1 3h16l1-3M12 5v3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-6"/>',
  moon: '<path d="M20 14A8 8 0 1 1 10 4a7 7 0 0 0 10 10z"/>',
  smoke: '<path d="M4 20h12v-6H4zM16 16h3l1 4M7 14V9h4v5M8 6a2 2 0 1 1 3-2 2 2 0 0 1 3 2"/>',
  rewind: '<path d="M11 6 4 12l7 6zM20 6l-7 6 7 6z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a5 5 0 0 0 8 0M9 9h.01M15 9h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01"/>',
};

let earned = readStore('vokzal-badges', {});

function award(id) {
  if (earned[id]) return;
  const badge = BADGES.find((b) => b.id === id);
  if (!badge) return;
  earned[id] = Date.now();
  writeStore('vokzal-badges', earned);
  renderBadges();
  sfx.play('badge');
  toast('Новый значок: «' + badge.title + '»', 'badge');
  const regular = BADGES.filter((b) => !b.secret);
  if (regular.every((b) => earned[b.id])) {
    setTimeout(() => toast('Все обычные значки собраны: можно делать отчёт!', 'badge'), 900);
  }
}

function renderBadges() {
  const list = $('#badges');
  const regular = BADGES.filter((b) => !b.secret);
  const got = BADGES.filter((b) => earned[b.id]).length;
  $('#badge-count').textContent = got + '/' + BADGES.length;
  list.textContent = '';
  for (const badge of BADGES) {
    const has = Boolean(earned[badge.id]);
    const li = document.createElement('li');
    li.className = 'badge' + (has ? ' is-earned' : '') + (badge.secret ? ' is-secret' : '');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = badge.secret && !has ? ICONS.question : ICONS[badge.icon];
    const title = document.createElement('strong');
    title.textContent = badge.secret && !has ? 'Секретный значок' : badge.title;
    const text = document.createElement('span');
    text.textContent = badge.secret && !has ? 'Ищите пасхалки на вокзале.' : badge.text;
    const when = document.createElement('time');
    when.className = 'num';
    when.textContent = has ? new Date(earned[badge.id]).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'не получен';
    li.append(icon, title, text, when);
    list.append(li);
  }
  const done = regular.filter((b) => earned[b.id]).length;
  $('#badges-sub').textContent = 'Собрано ' + done + ' из ' + regular.length + ' обычных значков. Каждый — одно состояние из задания: соберёте все, и все скриншоты для отчёта у вас будут.';
}

$('#badges-reset').addEventListener('click', () => {
  earned = {};
  writeStore('vokzal-badges', earned);
  renderBadges();
  toast('Значки сброшены');
});

/* ---------- Разделы (#board, #lesson, #badges) ---------- */
const VIEWS = { board: 'Табло', lesson: 'Практикум', badges: 'Значки' };

function showView(fromClick) {
  const name = location.hash.slice(1) in VIEWS ? location.hash.slice(1) : 'board';
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.tabs a').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = VIEWS[name] + ' · Вокзал Щучинск';
  if (fromClick) {
    const h1 = $('#view-' + name + ' h1');
    h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }
}
window.addEventListener('hashchange', () => showView(true));

/* ---------- Кнопки звука и голоса ---------- */
function syncPrefs() {
  $('#sound-btn').setAttribute('aria-pressed', String(prefs.sound));
  $('#voice-btn').setAttribute('aria-pressed', String(prefs.voice));
  writeStore('vokzal-prefs', prefs);
}
$('#sound-btn').addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  syncPrefs();
  toast(prefs.sound ? 'Звук включён' : 'Звук выключен');
});
$('#voice-btn').addEventListener('click', () => {
  prefs.voice = !prefs.voice;
  if (!prefs.voice && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  syncPrefs();
  toast(prefs.voice ? 'Диктор будет читать объявления' : 'Диктор молчит');
});
$('#bell-btn').addEventListener('click', () => {
  sfx.play('bell');
  const bell = $('#bell-btn');
  bell.classList.remove('is-ringing');
  void bell.offsetWidth;
  bell.classList.add('is-ringing');
});

/* ---------- Пасхалка: код Konami → ночной экспресс ---------- */
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiStep = 0;
let typed = '';

document.addEventListener('keydown', (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const expected = KONAMI[konamiStep];
  const latin = { 'и': 'b', 'ф': 'a' }[key] || key;
  if (latin === expected) {
    konamiStep++;
    if (konamiStep === KONAMI.length) {
      konamiStep = 0;
      document.dispatchEvent(new CustomEvent('egg:ghost'));
      award('konami');
    }
  } else {
    konamiStep = latin === KONAMI[0] ? 1 : 0;
  }

  // Пасхалка: напечатать «чух» (не в поле ввода)
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
  if (key.length !== 1) return;
  typed = (typed + key).slice(-3);
  if (typed === 'чух' || typed === 'xuh') {
    typed = '';
    runEggTrain();
  }
});

function runEggTrain() {
  const box = $('#egg-train');
  box.innerHTML = `<svg viewBox="0 0 360 70" aria-hidden="true">
    <g class="puffs"><circle cx="40" cy="12" r="7"/><circle cx="28" cy="6" r="5"/><circle cx="18" cy="2" r="3"/></g>
    <path d="M30 20h26v14h18V22h12v26H22V30h8z" fill="#111"/>
    <rect x="34" y="24" width="10" height="8" fill="#ffd34d"/>
    <path d="M86 26h6v4h-6z" fill="#ffd34d"/>
    ${[100, 190, 280].map((x) => `<rect x="${x}" y="22" width="80" height="26" rx="4" fill="#2f5f9a"/><rect x="${x + 8}" y="27" width="64" height="8" rx="2" fill="#ffd34d"/><path d="M${x - 10} 40h10" stroke="#111" stroke-width="3"/>`).join('')}
    ${[34, 60, 82, 112, 160, 202, 250, 292, 340].map((x) => `<circle cx="${x}" cy="52" r="7" fill="#111"/><circle cx="${x}" cy="52" r="2.5" fill="#ffd34d"/>`).join('')}
    <path d="M0 62h360" stroke="#555" stroke-width="3"/>
  </svg>`;
  box.hidden = false;
  box.classList.remove('is-running');
  void box.offsetWidth;
  box.classList.add('is-running');
  sfx.play('chuh');
  award('chuh');
  setTimeout(() => { box.hidden = true; box.classList.remove('is-running'); }, 5200);
}

/* ---------- Пасхалка: ночная смена ---------- */
(() => {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5) {
    document.body.classList.add('is-night');
    setTimeout(() => toast('Ночная смена: вокзал работает, но буфет закрыт.'), 1500);
  }
})();

syncPrefs();
renderBadges();
showView(false);
