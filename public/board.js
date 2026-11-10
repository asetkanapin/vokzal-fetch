'use strict';

/* =========================================================
   Табло отправления
   Уровень 2: данные с нашего сервера (/api/items).
   Уровень 3: рубильники 500 / медленно / битый JSON / 404.
   Уровень 4: отмена, таймаут, защита от двойного щелчка (requestJSON в api.js).
   Уровень 5: кэш в localStorage на 5 минут и плашка «нет связи».
   Уровень 6: WebSocket — табло обновляется само, без кнопки.
   ========================================================= */

const SOURCES = {
  normal: '/api/items',
  500: '/api/fail/500',
  slow: '/api/fail/slow',
  json: '/api/fail/broken-json',
  404: '/api/items/99',
};
const CACHE_KEY = 'vokzal-cache';
const CACHE_TTL = 5 * 60 * 1000; // кэш старше 5 минут не показываем
const HERE = { name: 'Щучинск', lat: 52.94, lon: 70.19 };
const COLS = { time: 5, number: 4, to: 14, platform: 1, status: 16 };

const boardState = {
  items: [],
  source: 'normal',
  live: true,
  phase: 'idle', // idle | loading | ok | error
  lastUpdate: null,
  ghost: null,
  openId: null,
  myPatchAt: 0,
};

/* ---------- Время ---------- */
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (date) => pad(date.getHours()) + ':' + pad(date.getMinutes());
const hhmmss = (date) => hhmm(date) + ':' + pad(date.getSeconds());

/* ---------- Кэш (уровень 5) ---------- */
function saveCache(items) {
  writeStore(CACHE_KEY, { at: Date.now(), items });
}

function readFreshCache() {
  const cache = readStore(CACHE_KEY, null);
  if (!cache || !Array.isArray(cache.items)) return null;
  if (Date.now() - cache.at > CACHE_TTL) return null; // старше 5 минут — как будто его нет
  return cache;
}

/* ---------- Статус поезда на табло ---------- */
function statusFlap(item) {
  const code = item.status.code;
  if (code === 'delayed' && [404, 500, 777].includes(item.delay)) {
    return { text: { 404: '404 НЕ НАЙДЕН', 500: 'ДИСПЕТЧЕР УПАЛ', 777: 'ДЖЕКПОТ 777' }[item.delay], code: 'joke' };
  }
  const text = {
    scheduled: 'ПО РАСПИСАНИЮ',
    boarding: 'ПОСАДКА',
    delayed: 'ЗАДЕРЖКА ' + item.delay + ' МИН',
    departed: 'ОТПРАВЛЕН',
    cancelled: 'ОТМЕНЁН',
  }[code] || item.status.text;
  return { text, code };
}

function sortItems(items) {
  return [...items].sort((a, b) => new Date(a.departure) - new Date(b.departure));
}

/* ---------- Отрисовка табло ---------- */
const boardBody = $('#board-body');
const rows = new Map(); // id → элемент строки

function makeRow(item) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'board-row';
  button.dataset.id = item.id;
  button.innerHTML = '<span class="flaps c-time"></span><span class="flaps c-number"></span><span class="flaps c-to"></span><span class="flaps c-platform"></span><span class="flaps c-status"></span>';
  li.append(button);
  return li;
}

function renderBoard(items, changed = []) {
  const list = sortItems(items);
  if (boardState.ghost) list.push(boardState.ghost);
  const seen = new Set();
  for (const item of list) {
    seen.add(String(item.id));
    let li = rows.get(String(item.id));
    if (!li) {
      li = makeRow(item);
      rows.set(String(item.id), li);
    }
    boardBody.append(li); // append переставляет строку на нужное место
    const row = li.firstElementChild;
    const status = statusFlap(item);
    const time = new Date(item.departure);
    row.dataset.status = status.code;
    setFlaps(row.querySelector('.c-time'), hhmm(time), COLS.time);
    setFlaps(row.querySelector('.c-number'), item.number, COLS.number);
    setFlaps(row.querySelector('.c-to'), item.to, COLS.to);
    setFlaps(row.querySelector('.c-platform'), String(item.platform), COLS.platform);
    setFlaps(row.querySelector('.c-status'), status.text, COLS.status);
    row.setAttribute('aria-label', `${hhmm(time)}, поезд ${item.number} до ${item.to}, путь ${item.platform}, ${status.text.toLowerCase()}`);
    if (changed.includes(item.id)) {
      row.classList.remove('is-changed');
      void row.offsetWidth;
      row.classList.add('is-changed');
    }
    if (status.code === 'joke') award('joke');
  }
  for (const [id, li] of rows) {
    if (!seen.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }
}

/* ---------- Состояния табло ---------- */
let stopSpin = null;

function setPhase(phase, info = {}) {
  boardState.phase = phase;
  const board = $('#board');
  const message = $('#board-message');
  const flaps = $('#board-message-flaps');
  board.setAttribute('aria-busy', String(phase === 'loading'));
  board.classList.toggle('is-loading', phase === 'loading');
  board.classList.toggle('is-error', phase === 'error');
  if (stopSpin) { stopSpin(); stopSpin = null; }

  if (phase === 'loading') {
    message.hidden = false;
    message.dataset.kind = 'loading';
    $('#retry-btn').hidden = true;
    $('#board-message-text').textContent = 'Загрузка...';
    stopSpin = spinFlaps(flaps, 12);
    flaps.setAttribute('aria-label', 'Загрузка');
  } else if (phase === 'error') {
    message.hidden = false;
    message.dataset.kind = info.kind;
    $('#retry-btn').hidden = false;
    $('#board-message-text').textContent = info.text;
    setFlaps(flaps, info.flap, 14);
  } else {
    message.hidden = true;
  }
}

function setStateLine(text, kind = '') {
  const line = $('#state-line');
  line.textContent = text;
  line.dataset.kind = kind;
}

function showCacheNotice(cache) {
  const notice = $('#cache-notice');
  if (!cache) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.textContent = 'Нет связи, показаны сохранённые данные от ' + hhmmss(new Date(cache.at)) + '. Они обновятся сами, как только связь вернётся.';
}

/* ---------- Загрузка табло ---------- */
async function loadBoard() {
  const source = boardState.source;
  const url = SOURCES[source];
  const timeout = Number($('#timeout-select').value);
  const started = performance.now();
  setPhase('loading');
  setStateLine('Загрузка... ' + url, 'loading');
  try {
    const data = await requestJSON(url, { group: 'board', timeout });
    if (source !== boardState.source) return;
    const items = Array.isArray(data) ? data : [data];
    boardState.items = items;
    saveCache(items);
    renderBoard(items);
    setPhase('ok');
    showCacheNotice(null);
    boardState.lastUpdate = new Date();
    $('#board-sub').innerHTML = '';
    $('#board-sub').append((DEMO ? 'Демо-сервер в браузере, загружено в ' : 'Загружено с вашего сервера в ') + hhmmss(boardState.lastUpdate) + ' · ', codeEl('GET ' + url));
    setStateLine('Готово: ' + items.length + ' ' + plural(items.length, 'поезд', 'поезда', 'поездов') + ' за ' + Math.round(performance.now() - started) + ' мс.', 'ok');
    sfx.play('ok');
    award(source === 'slow' ? 'slow' : 'first');
  } catch (error) {
    const info = describeError(error);
    if (info.kind === 'replaced') return; // уже идёт новый запрос
    console.error('Табло не загрузилось:', error.name, error.message);
    sfx.play('error');
    if (info.kind === 'offline') {
      const cache = readFreshCache();
      if (cache) {
        boardState.items = cache.items;
        renderBoard(cache.items);
        setPhase('ok');
        showCacheNotice(cache);
        setStateLine('Нет связи: показаны сохранённые данные.', 'warn');
        award('offline');
        return;
      }
      info.text += ' Сохранённых данных свежее 5 минут нет.';
    }
    showCacheNotice(null);
    setPhase('error', info);
    setStateLine(info.text, 'error');
    const badge = { e404: 'e404', e500: 'e500', json: 'json', timeout: 'timeout' }[info.kind];
    if (badge) award(badge);
  }
}

function codeEl(text) {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ---------- Рубильники ---------- */
function syncLive() {
  boardState.live = boardState.source === 'normal';
  $('#live-state').textContent = boardState.live ? 'Живые обновления включены' : 'Живые обновления на паузе, пока включён рубильник';
}

$$('input[name="source"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    boardState.source = radio.value;
    syncLive();
    loadBoard(); // новый запрос отменит предыдущий, если тот ещё в пути
  });
});

$('#reload-btn').addEventListener('click', loadBoard);
$('#retry-btn').addEventListener('click', loadBoard);

document.addEventListener('net:dedupe', () => {
  toast('Запрос уже идёт: второй щелчок не отправил новый');
  award('dedupe');
});
document.addEventListener('net:replaced', () => {
  toast('Предыдущий запрос отменён: в Network он помечен (canceled)');
  award('replaced');
});

/* ---------- WebSocket (уровень 6) ---------- */
let socket = null;
let retryDelay = 1000;

function setWs(state, text) {
  const box = $('#ws-status');
  box.dataset.state = state;
  $('#ws-text').textContent = text;
}

function connectWS() {
  if (DEMO) {
    // страница открыта файлом: «сокет» работает внутри браузера (demo-server.js)
    socket = new demoServer.DemoSocket();
  } else {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    socket = new WebSocket(url);
  }
  setWs('connecting', 'Подключение…');

  socket.addEventListener('open', () => {
    retryDelay = 1000;
    setWs('online', DEMO ? 'Демо без сервера' : 'Онлайн');
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (msg.type === 'hello' || msg.type === 'update') applyLive(msg);
    if (msg.type === 'clients') {
      setWs('online', (DEMO ? 'Демо · табло: ' : 'Онлайн · табло: ') + msg.count);
      if (msg.count >= 2) award('ws');
    }
    if (msg.type === 'announce') announce(msg.text, true);
  });

  socket.addEventListener('close', () => {
    setWs('offline', 'Нет связи · повтор через ' + Math.round(retryDelay / 1000) + ' с');
    setTimeout(connectWS, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  });
}

function applyLive(msg) {
  if (msg.type === 'hello' && msg.clients) setWs('online', (DEMO ? 'Демо · табло: ' : 'Онлайн · табло: ') + msg.clients);
  if (!boardState.live || !Array.isArray(msg.items)) return;
  if (boardState.phase === 'loading') return; // не мешаем идущему запросу
  boardState.items = msg.items;
  saveCache(msg.items);
  renderBoard(msg.items, msg.changed || []);
  if (boardState.phase === 'error') setPhase('ok');
  showCacheNotice(null);
  boardState.lastUpdate = new Date(msg.at || Date.now());
  $('#board-sub').textContent = 'Обновлено в ' + hhmmss(boardState.lastUpdate) + (DEMO ? ' автоматически, без кнопки (демо-сокет)' : ' через WebSocket, без кнопки');
  if (msg.reason === 'dispatcher' && Date.now() - boardState.myPatchAt > 1500) {
    const item = msg.items.find((i) => msg.changed.includes(i.id));
    if (item) toast('Диспетчер изменил поезд №' + item.number + ' в другой вкладке');
  }
  if (boardState.openId != null) {
    const open = msg.items.find((i) => i.id === boardState.openId);
    if (open) updateTrainLive(open);
  }
}

/* ---------- Объявления ---------- */
function announce(text, fromServer) {
  const ticker = $('#ticker-text');
  ticker.textContent = text;
  ticker.classList.remove('is-new');
  void ticker.offsetWidth;
  ticker.classList.add('is-new');
  sfx.play('chime');
  setTimeout(() => speak(text), prefs.sound ? 1300 : 0);
  if (fromServer) toast('Объявление: ' + text.slice(0, 60) + (text.length > 60 ? '…' : ''));
}

/* ---------- Часы и погода ---------- */
const clockEl = $('#clock');
let clockClicks = [];
let rewindUntil = 0;
let rewindBase = 0;

function tickClock() {
  let now = new Date();
  if (Date.now() < rewindUntil) {
    // пасхалка: время идёт назад
    now = new Date(rewindBase - (Date.now() - (rewindUntil - 10000)) * 30);
  }
  setFlaps(clockEl, hhmmss(now), 8, { silent: true });
  clockEl.setAttribute('aria-label', 'Время ' + hhmmss(now));
}
setInterval(tickClock, 1000);
tickClock();

clockEl.addEventListener('click', () => {
  const now = Date.now();
  clockClicks = clockClicks.filter((t) => now - t < 2500);
  clockClicks.push(now);
  if (clockClicks.length >= 5) {
    clockClicks = [];
    rewindBase = Date.now();
    rewindUntil = Date.now() + 10000;
    toast('Машина времени: часы пошли назад на 10 секунд');
    award('rewind');
  }
});

const WEATHER_TEXT = (code) => {
  if (code === 0) return 'ясно';
  if (code <= 3) return 'облачно';
  if (code <= 48) return 'туман';
  if (code <= 57) return 'морось';
  if (code <= 67) return 'дождь';
  if (code <= 77) return 'снег';
  if (code <= 82) return 'ливень';
  if (code <= 86) return 'снегопад';
  return 'гроза';
};

function weatherUrl(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&windspeed_unit=ms`;
}

// Погода меняется медленно: храним ответ 10 минут, чтобы не дёргать Open-Meteo зря
async function getWeather(lat, lon) {
  const key = 'vokzal-weather-' + lat + ',' + lon;
  const saved = readStore(key, null);
  if (saved && Date.now() - saved.at < 10 * 60 * 1000) return saved.w;
  const data = await requestJSON(weatherUrl(lat, lon), { timeout: 8000 });
  writeStore(key, { at: Date.now(), w: data.current_weather });
  return data.current_weather;
}

async function loadHereWeather() {
  const box = $('#weather-here');
  try {
    const w = await getWeather(HERE.lat, HERE.lon);
    box.textContent = `${HERE.name}: ${Math.round(w.temperature)} °C, ${WEATHER_TEXT(w.weathercode)}, ветер ${Math.round(w.windspeed)} м/с`;
  } catch (error) {
    box.textContent = 'Погода в Щучинске недоступна';
  }
}

/* ---------- Пасхалка: ночной экспресс ---------- */
document.addEventListener('egg:ghost', () => {
  const now = new Date();
  boardState.ghost = {
    id: 'ghost', number: '0000', type: 'Ночной экспресс', to: 'Луна', platform: 0, delay: 0,
    departure: new Date(now.getTime() + 60 * 1000).toISOString(),
    status: { code: 'boarding', text: 'Посадка' }, stops: ['Щучинск', 'Облака', 'Орбита', 'Луна'], wagons: 3,
  };
  renderBoard(boardState.items, ['ghost']);
  announce('Внимание! Ночной экспресс до Луны отправляется с нулевого пути. Пассажиров просим пристегнуться.', false);
  document.body.classList.add('is-ghost');
  setTimeout(() => {
    boardState.ghost = null;
    document.body.classList.remove('is-ghost');
    renderBoard(boardState.items);
  }, 25000);
});

/* =========================================================
   Карточка поезда
   ========================================================= */
const dialog = $('#train-dialog');
const trainBody = $('#train-body');

boardBody.addEventListener('click', (event) => {
  const row = event.target.closest('.board-row');
  if (!row) return;
  if (row.dataset.id === 'ghost') {
    toast('Ночной экспресс не берёт пассажиров без лунного билета');
    return;
  }
  openTrain(Number(row.dataset.id));
});

dialog.addEventListener('close', () => {
  boardState.openId = null;
});

async function openTrain(id) {
  boardState.openId = id;
  trainBody.innerHTML = '<p class="loading">Загрузка...</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const item = await requestJSON('/api/items/' + id, { group: 'detail', timeout: 5000 });
    if (boardState.openId !== id) return;
    renderTrain(item);
  } catch (error) {
    const info = describeError(error);
    if (info.kind === 'replaced') return;
    trainBody.textContent = '';
    const p = document.createElement('p');
    p.className = 'error-text';
    p.textContent = info.text;
    const retry = document.createElement('button');
    retry.className = 'btn btn-dark';
    retry.type = 'button';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', () => openTrain(id));
    trainBody.append(p, retry);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function trainSVG(wagons) {
  const w = 54;
  const width = 70 + wagons * (w + 6);
  let parts = `<g class="loco"><path d="M4 14h40l18 12v20H4z" fill="#111"/><rect x="12" y="20" width="14" height="10" rx="2" fill="#ffd34d"/><path d="M48 22l10 8h-10z" fill="#ffd34d"/></g>`;
  for (let i = 0; i < wagons; i++) {
    const x = 70 + i * (w + 6);
    parts += `<rect x="${x}" y="14" width="${w}" height="32" rx="4" fill="#2f5f9a"/>`;
    for (let k = 0; k < 3; k++) parts += `<rect x="${x + 6 + k * 16}" y="20" width="11" height="9" rx="1.5" fill="#cfe0f5"/>`;
    parts += `<text x="${x + w / 2}" y="41" text-anchor="middle" font-size="8" fill="#fff" font-family="Onest, sans-serif">${i + 1}</text>`;
  }
  const wheels = [];
  for (let x = 14; x < width - 10; x += 20) wheels.push(`<circle cx="${x}" cy="50" r="5" fill="#111"/>`);
  return `<svg class="consist" viewBox="0 0 ${width} 58" width="${width}" height="58" role="img" aria-label="Состав: локомотив и ${wagons} вагонов">${parts}${wheels.join('')}<path d="M0 56h${width}" stroke="#777" stroke-width="2"/></svg>`;
}

function renderTrain(item) {
  trainBody.textContent = '';
  const status = statusFlap(item);

  const head = el('header', 'train-head');
  const kicker = el('p', 'train-type', item.type + ' · №' + item.number);
  const title = el('h2', null, 'Щучинск → ' + item.to);
  title.id = 'train-title';
  const flapRow = el('div', 'train-flaps');
  const timeFlap = el('span', 'flaps c-time');
  const statusEl = el('span', 'flaps c-status');
  statusEl.dataset.status = status.code;
  flapRow.append(timeFlap, statusEl);
  head.append(kicker, title, flapRow);
  setFlaps(timeFlap, hhmm(new Date(item.departure)), 5, { instant: true });
  setFlaps(statusEl, status.text, COLS.status);

  const consist = el('div', 'consist-wrap');
  consist.innerHTML = trainSVG(Math.min(item.wagons, 15));

  const grid = el('div', 'train-grid');

  // Маршрут
  const route = el('section', 'train-section');
  route.append(el('h3', null, 'Маршрут'));
  const stops = el('ol', 'stops');
  item.stops.forEach((s) => stops.append(el('li', null, s)));
  route.append(stops);
  const left = el('p', 'train-left');
  left.id = 'train-left';
  route.append(left);

  // Погода
  const weather = el('section', 'train-section');
  weather.append(el('h3', null, 'Погода: ' + item.to));
  const wbox = el('div', 'weather-box', 'Загрузка...');
  weather.append(wbox);
  loadTrainWeather(item, wbox);

  grid.append(route, weather);

  // Диспетчерская
  const desk = el('section', 'train-section dispatcher');
  desk.append(el('h3', null, 'Диспетчерская'));
  desk.append(el('p', 'hint', 'Изменения уходят на сервер запросом PATCH и сразу появляются на всех открытых табло.'));

  const platformRow = el('div', 'disp-row');
  platformRow.append(el('span', 'disp-label', 'Путь'));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Путь');
  [1, 2, 3, 4].forEach((p) => {
    const b = el('button', null, String(p));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(item.platform === p));
    b.addEventListener('click', () => patchTrain(item.id, { platform: p }));
    seg.append(b);
  });
  platformRow.append(seg);

  const delayRow = el('div', 'disp-row');
  delayRow.append(el('span', 'disp-label', 'Задержка'));
  const minus = el('button', 'btn btn-ghost btn-sm', '−5');
  minus.type = 'button';
  minus.setAttribute('aria-label', 'Уменьшить задержку на 5 минут');
  const delayInput = el('input', 'delay-input');
  delayInput.type = 'number';
  delayInput.min = 0;
  delayInput.max = 999;
  delayInput.value = item.delay;
  delayInput.setAttribute('aria-label', 'Задержка в минутах');
  const plus = el('button', 'btn btn-ghost btn-sm', '+5');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Увеличить задержку на 5 минут');
  const setBtn = el('button', 'btn btn-dark btn-sm', 'Задать');
  setBtn.type = 'button';
  minus.addEventListener('click', () => patchTrain(item.id, { delay: Math.max(0, item.delay - 5) }));
  plus.addEventListener('click', () => patchTrain(item.id, { delay: Math.min(999, item.delay + 5) }));
  setBtn.addEventListener('click', () => patchTrain(item.id, { delay: Number(delayInput.value) }));
  delayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') setBtn.click(); });
  delayRow.append(minus, delayInput, plus, setBtn, el('span', 'disp-unit', 'мин'));

  const cancelRow = el('div', 'disp-row');
  const cancelBtn = el('button', 'btn ' + (item.cancelled ? 'btn-dark' : 'btn-danger') + ' btn-sm', item.cancelled ? 'Вернуть рейс' : 'Отменить рейс');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => patchTrain(item.id, { cancelled: !item.cancelled }));
  cancelRow.append(cancelBtn);

  const result = el('p', 'disp-result');
  result.id = 'disp-result';
  result.setAttribute('role', 'status');

  // Объявление
  const ann = el('div', 'announce');
  const label = el('label', 'field');
  label.append(el('span', null, 'Объявление диктора'));
  const text = document.createElement('textarea');
  text.rows = 3;
  text.maxLength = 200;
  text.value = defaultAnnouncement(item);
  label.append(text);
  const annBtn = el('button', 'btn btn-yellow', 'Объявить на вокзале');
  annBtn.type = 'button';
  annBtn.addEventListener('click', () => postAnnouncement(text.value, annBtn));
  ann.append(label, annBtn);

  desk.append(platformRow, delayRow, cancelRow, result, ann);

  const foot = el('p', 'train-foot');
  foot.append('Данные: ', codeEl('GET /api/items/' + item.id), ' · обновлено ' + hhmmss(new Date(item.updatedAt)));

  trainBody.append(head, consist, grid, desk, foot);
  updateLeft(item);
  trainBody._item = item;
}

function defaultAnnouncement(item) {
  return `Внимание! Поезд номер ${item.number}, Щучинск — ${item.to}, отправляется с ${item.platform}-го пути.`;
}

function updateLeft(item) {
  const left = $('#train-left');
  if (!left) return;
  const minutes = Math.round((new Date(item.departure) - Date.now()) / 60000) + item.delay;
  left.textContent = item.cancelled ? 'Рейс отменён.' : minutes > 0 ? 'Отправление через ' + minutes + ' мин' + (item.delay ? ' (с учётом задержки)' : '') + '.' : 'Поезд уже ушёл.';
}

// Пришло обновление по WebSocket, а карточка открыта: обновим её
function updateTrainLive(item) {
  const prev = trainBody._item;
  if (!prev || prev.id !== item.id) return;
  if (prev.platform !== item.platform || prev.delay !== item.delay || prev.cancelled !== item.cancelled || prev.status.code !== item.status.code) {
    const focusedText = document.activeElement && document.activeElement.tagName === 'TEXTAREA' ? document.activeElement.value : null;
    renderTrain(item);
    if (focusedText != null) $('textarea', trainBody).value = focusedText;
  } else {
    updateLeft(item);
  }
}

async function patchTrain(id, changes) {
  const result = $('#disp-result');
  if (result) result.textContent = 'Отправляем PATCH…';
  try {
    boardState.myPatchAt = Date.now();
    const item = await requestJSON('/api/items/' + id, { method: 'PATCH', body: changes });
    renderTrain(item);
    // если WebSocket не работает, обновим своё табло сами
    boardState.items = boardState.items.map((i) => (i.id === item.id ? item : i));
    if (boardState.live) renderBoard(boardState.items, [item.id]);
    $('#disp-result').textContent = 'Сохранено. Все открытые табло получили изменение.';
    award('dispatcher');
    if ([404, 500, 777].includes(item.delay)) award('joke');
  } catch (error) {
    const info = describeError(error);
    const box = $('#disp-result');
    if (box) box.textContent = 'Не сохранено: ' + info.text;
    sfx.play('error');
  }
}

async function postAnnouncement(text, button) {
  const clean = text.trim();
  if (!clean) {
    toast('Объявление пустое');
    return;
  }
  button.disabled = true;
  try {
    await requestJSON('/api/announcements', { method: 'POST', body: { text: clean } });
    award('announce');
    if (!socket || socket.readyState !== WebSocket.OPEN) announce(clean, false);
  } catch (error) {
    toast('Объявление не ушло: ' + describeError(error).text, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadTrainWeather(item, box) {
  try {
    const w = await getWeather(item.lat, item.lon);
    box.textContent = '';
    const temp = el('strong', 'weather-temp num', Math.round(w.temperature) + ' °C');
    const desc = el('span', null, WEATHER_TEXT(w.weathercode) + ', ветер ' + Math.round(w.windspeed) + ' м/с');
    const src = el('span', 'hint', 'Open-Meteo, данные на ' + w.time.slice(11, 16) + ' по Гринвичу');
    box.append(temp, desc, src);
    award('weather');
  } catch (error) {
    box.textContent = 'Погода недоступна: ' + describeError(error).text;
  }
}

/* ---------- Запуск ---------- */
(function start() {
  syncLive();
  const cache = readFreshCache();
  if (cache) {
    boardState.items = cache.items;
    renderBoard(cache.items);
  }
  if (DEMO) {
    setTimeout(() => toast('Демо-режим: страница открыта файлом, сервер работает внутри браузера. Настоящий сервер: npm start'), 600);
  }
  loadBoard();
  connectWS();
  loadHereWeather();
  window.addEventListener('offline', () => toast('Сеть пропала: покажем сохранённые данные', 'error'));
  window.addEventListener('online', () => {
    toast('Связь вернулась');
    if (boardState.source === 'normal') loadBoard();
  });
})();
