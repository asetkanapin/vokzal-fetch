'use strict';

/* =========================================================
   Демо-режим без сервера
   Если index.html открыт двойным щелчком (file://), настоящего сервера нет.
   Тогда этот файл изображает его прямо в браузере:
   - fetch('/api/...') отвечает так же, как server.js (200, 404, 500, 3 секунды, битый JSON, PATCH, POST);
   - «WebSocket» раз в 5 секунд присылает обновления, а вкладки делятся данными через localStorage.
   При запуске через node server.js этот файл ничего не делает.
   ========================================================= */

const DEMO = location.protocol === 'file:';

const demoServer = DEMO ? (() => {
  const MINUTE = 60 * 1000;
  const STATE_KEY = 'vokzal-demo-state';
  const ANNOUNCE_KEY = 'vokzal-demo-announce';
  const TABS_KEY = 'vokzal-demo-tabs';
  const tabId = Math.random().toString(36).slice(2);

  const TRAINS = [
    { id: 1, number: '002Ц', type: 'Скоростной «Тальго»', to: 'Астана', stops: ['Щучинск', 'Кокшетау-1', 'Астана-Нурлы Жол'], wagons: 8, lat: 51.18, lon: 71.45, in: 6 },
    { id: 2, number: '6923', type: 'Пригородный', to: 'Бурабай', stops: ['Щучинск', 'Курорт-Боровое', 'Бурабай'], wagons: 4, lat: 53.08, lon: 70.31, in: 14 },
    { id: 3, number: '317Т', type: 'Пассажирский', to: 'Петропавловск', stops: ['Щучинск', 'Кокшетау-1', 'Смирново', 'Петропавловск'], wagons: 12, lat: 54.87, lon: 69.15, in: 23 },
    { id: 4, number: '081Т', type: 'Пассажирский', to: 'Алматы-2', stops: ['Щучинск', 'Астана', 'Караганды', 'Балхаш', 'Алматы-2'], wagons: 15, lat: 43.24, lon: 76.92, in: 37 },
    { id: 5, number: '6911', type: 'Пригородный', to: 'Кокшетау', stops: ['Щучинск', 'Шортанды', 'Кокшетау-1'], wagons: 5, lat: 53.28, lon: 69.39, in: 52 },
  ];

  const load = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* без хранилища */ }
  };

  // Общее для всех вкладок состояние поездов
  function getState() {
    let state = load(STATE_KEY, null);
    // состояние старше 3 часов начинаем заново, как перезапуск сервера
    if (!state || Date.now() - state.startedAt > 3 * 60 * MINUTE) {
      const startedAt = Date.now();
      state = { startedAt, trains: {} };
      TRAINS.forEach((t, i) => {
        state.trains[t.id] = { departure: startedAt + t.in * MINUTE, platform: (i % 3) + 1, delay: 0, cancelled: false, updatedAt: startedAt };
      });
      save(STATE_KEY, state);
    }
    return state;
  }

  function statusOf(s, now = Date.now()) {
    if (s.cancelled) return { code: 'cancelled', text: 'Отменён' };
    const left = (s.departure + s.delay * MINUTE - now) / MINUTE;
    if (left <= 0) return { code: 'departed', text: 'Отправлен' };
    if (left <= 5) return { code: 'boarding', text: 'Посадка' };
    if (s.delay > 0) return { code: 'delayed', text: `Задержка ${s.delay} мин` };
    return { code: 'scheduled', text: 'По расписанию' };
  }

  function view(train, state) {
    const s = state.trains[train.id];
    const { in: _skip, ...rest } = train;
    return {
      ...rest,
      departure: new Date(s.departure).toISOString(),
      platform: s.platform,
      delay: s.delay,
      cancelled: s.cancelled,
      status: statusOf(s),
      updatedAt: new Date(s.updatedAt).toISOString(),
    };
  }

  const allItems = (state = getState()) => TRAINS.map((t) => view(t, state));

  /* ---------- Ответы «сервера» ---------- */
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(signal.reason); return; }
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }
    });
  }

  async function handle(path, method, body, signal) {
    await delay(15 + Math.random() * 40, signal); // как будто сеть
    const state = getState();
    const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);

    if (method === 'GET' && path === '/api/items') return json(200, allItems(state));
    if (itemMatch && method === 'GET') {
      const train = TRAINS.find((t) => t.id === Number(itemMatch[1]));
      return train ? json(200, view(train, state)) : json(404, { error: 'Поезд не найден', id: itemMatch[1] });
    }
    if (itemMatch && method === 'PATCH') {
      const train = TRAINS.find((t) => t.id === Number(itemMatch[1]));
      if (!train) return json(404, { error: 'Поезд не найден', id: itemMatch[1] });
      const s = state.trains[train.id];
      const { platform, delay: late, cancelled } = body || {};
      if (platform !== undefined) {
        if (![1, 2, 3, 4].includes(platform)) return json(400, { error: 'Путь должен быть от 1 до 4' });
        s.platform = platform;
      }
      if (late !== undefined) {
        if (!Number.isInteger(late) || late < 0 || late > 999) return json(400, { error: 'Задержка от 0 до 999 минут' });
        s.delay = late;
      }
      if (cancelled !== undefined) s.cancelled = Boolean(cancelled);
      s.updatedAt = Date.now();
      save(STATE_KEY, state);
      emit({ type: 'update', reason: 'dispatcher', changed: [train.id], items: allItems(state), at: new Date().toISOString() });
      broadcastStorage('dispatcher', [train.id]);
      return json(200, view(train, state));
    }
    if (method === 'POST' && path === '/api/announcements') {
      const text = String((body && body.text) || '').trim().slice(0, 200);
      if (!text) return json(400, { error: 'Пустое объявление' });
      const announcement = { id: Date.now(), text, at: new Date().toISOString() };
      save(ANNOUNCE_KEY, announcement);
      emit({ type: 'announce', ...announcement });
      return json(201, announcement);
    }
    if (path === '/api/fail/500') return json(500, { error: 'Диспетчерская не отвечает: внутренняя ошибка сервера' });
    if (path === '/api/fail/slow') {
      await delay(3000, signal);
      return json(200, allItems());
    }
    if (path === '/api/fail/broken-json') {
      return new Response('[{"id": 1, "number": "002Ц", "to": "Аст', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return json(404, { error: 'Такого адреса нет', path });
  }

  // Подменяем fetch только для адресов /api/...; остальное (JSONPlaceholder, Open-Meteo) идёт в интернет
  const realFetch = window.fetch.bind(window);
  window.fetch = function demoFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    const { pathname } = new URL(url, 'http://demo.local');
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
    return handle(pathname, (init.method || 'GET').toUpperCase(), body, init.signal);
  };

  /* ---------- «WebSocket» ---------- */
  const sockets = new Set();

  function emit(message) {
    const data = JSON.stringify(message);
    sockets.forEach((s) => s.dispatch('message', { data }));
  }

  function liveTabs() {
    const tabs = load(TABS_KEY, {});
    const now = Date.now();
    for (const id of Object.keys(tabs)) if (now - tabs[id] > 8000) delete tabs[id];
    return tabs;
  }

  function heartbeat() {
    const tabs = liveTabs();
    const before = Object.keys(tabs).length;
    tabs[tabId] = Date.now();
    save(TABS_KEY, tabs);
    const count = Object.keys(tabs).length;
    if (count !== before) emit({ type: 'clients', count });
    return count;
  }

  function broadcastStorage(reason, changed) {
    save('vokzal-demo-ping', { reason, changed, from: tabId, at: Date.now() });
  }

  // Другая вкладка что-то поменяла → эта получает «сообщение по сокету»
  window.addEventListener('storage', (event) => {
    if (event.key === 'vokzal-demo-ping' && event.newValue) {
      const ping = JSON.parse(event.newValue);
      emit({ type: 'update', reason: ping.reason, changed: ping.changed || [], items: allItems(), at: new Date().toISOString() });
    }
    if (event.key === ANNOUNCE_KEY && event.newValue) {
      emit({ type: 'announce', ...JSON.parse(event.newValue) });
    }
    if (event.key === TABS_KEY) emit({ type: 'clients', count: Object.keys(liveTabs()).length });
  });

  // Раз в 5 секунд: задержки, посадка, новые рейсы (как setInterval в server.js)
  setInterval(() => {
    heartbeat();
    const state = getState();
    const now = Date.now();
    const changed = [];
    for (const train of TRAINS) {
      const s = state.trains[train.id];
      const before = statusOf(s, now - 5000).code;
      if (s.departure + s.delay * MINUTE + 2 * MINUTE < now) {
        s.departure = now + (40 + Math.floor(Math.random() * 40)) * MINUTE;
        s.delay = 0;
        s.cancelled = false;
        s.platform = 1 + Math.floor(Math.random() * 3);
        s.updatedAt = now;
        changed.push(train.id);
        continue;
      }
      const code = statusOf(s, now).code;
      if ((code === 'scheduled' || code === 'delayed') && Math.random() < 0.03) {
        s.delay += 5;
        s.updatedAt = now;
        changed.push(train.id);
        continue;
      }
      if (code !== before) changed.push(train.id);
    }
    save(STATE_KEY, state);
    emit({ type: 'update', reason: 'tick', changed, items: allItems(state), at: new Date(now).toISOString() });
  }, 5000);

  window.addEventListener('beforeunload', () => {
    const tabs = liveTabs();
    delete tabs[tabId];
    save(TABS_KEY, tabs);
  });

  class DemoSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      sockets.add(this);
      setTimeout(() => {
        this.readyState = 1;
        this.dispatch('open', {});
        const count = heartbeat();
        this.dispatch('message', { data: JSON.stringify({ type: 'hello', items: allItems(), clients: count, at: new Date().toISOString() }) });
        this.dispatch('message', { data: JSON.stringify({ type: 'clients', count }) });
      }, 120);
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    }
    close() {
      sockets.delete(this);
      this.readyState = 3;
      this.dispatch('close', {});
    }
  }
  DemoSocket.OPEN = 1;

  return { DemoSocket };
})() : null;
