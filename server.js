'use strict';

/* =========================================================
   Вокзал Щучинск — сервер табло
   Express раздаёт public/ и отвечает на /api/...,
   WebSocket на том же порту раз в 5 секунд шлёт обновления.
   Запуск: npm install, затем npm start (или node server.js)
   ========================================================= */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MINUTE = 60 * 1000;

const app = express();
app.use(express.json({ limit: '10kb' }));

/* ---------- Лог запросов в терминал (уровень 2, пункт 9) ---------- */
const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    const color = status >= 500 ? 31 : status >= 400 ? 33 : 32;
    const time = new Date().toLocaleTimeString('ru-RU');
    console.log(`${paint(90, time)}  ${paint(36, req.method.padEnd(6))} ${req.originalUrl.padEnd(28)} ${paint(color, status)}  ${Date.now() - started} мс`);
  });
  res.on('close', () => {
    // клиент оборвал запрос (AbortController) раньше, чем пришёл ответ
    if (!res.writableFinished) {
      console.log(`${paint(90, new Date().toLocaleTimeString('ru-RU'))}  ${paint(36, req.method.padEnd(6))} ${req.originalUrl.padEnd(28)} ${paint(35, 'отменён клиентом')}`);
    }
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Данные: 5 поездов (уровень 1, пункт 4) ----------
   Расписание учебное: время отправления считается от запуска сервера,
   чтобы на демонстрации статусы менялись прямо на глазах. */
const TRAINS = [
  { id: 1, number: '002Ц', type: 'Скоростной «Тальго»', to: 'Астана', stops: ['Щучинск', 'Кокшетау-1', 'Астана-Нурлы Жол'], wagons: 8, lat: 51.18, lon: 71.45, in: 6 },
  { id: 2, number: '6923', type: 'Пригородный', to: 'Бурабай', stops: ['Щучинск', 'Курорт-Боровое', 'Бурабай'], wagons: 4, lat: 53.08, lon: 70.31, in: 14 },
  { id: 3, number: '317Т', type: 'Пассажирский', to: 'Петропавловск', stops: ['Щучинск', 'Кокшетау-1', 'Смирново', 'Петропавловск'], wagons: 12, lat: 54.87, lon: 69.15, in: 23 },
  { id: 4, number: '081Т', type: 'Пассажирский', to: 'Алматы-2', stops: ['Щучинск', 'Астана', 'Караганды', 'Балхаш', 'Алматы-2'], wagons: 15, lat: 43.24, lon: 76.92, in: 37 },
  { id: 5, number: '6911', type: 'Пригородный', to: 'Кокшетау', stops: ['Щучинск', 'Шортанды', 'Кокшетау-1'], wagons: 5, lat: 53.28, lon: 69.39, in: 52 },
];

const state = new Map();
const startedAt = Date.now();
TRAINS.forEach((t, i) => {
  state.set(t.id, {
    departure: startedAt + t.in * MINUTE,
    platform: (i % 3) + 1,
    delay: 0,
    cancelled: false,
    updatedAt: startedAt,
  });
});

function statusOf(train, s, now = Date.now()) {
  if (s.cancelled) return { code: 'cancelled', text: 'Отменён' };
  const left = (s.departure + s.delay * MINUTE - now) / MINUTE;
  if (left <= 0) return { code: 'departed', text: 'Отправлен' };
  if (left <= 5) return { code: 'boarding', text: 'Посадка' };
  if (s.delay > 0) return { code: 'delayed', text: `Задержка ${s.delay} мин` };
  return { code: 'scheduled', text: 'По расписанию' };
}

function view(train) {
  const s = state.get(train.id);
  const { in: _skip, ...rest } = train;
  return {
    ...rest,
    departure: new Date(s.departure).toISOString(),
    platform: s.platform,
    delay: s.delay,
    cancelled: s.cancelled,
    status: statusOf(train, s),
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

const allItems = () => TRAINS.map(view);
const findTrain = (id) => TRAINS.find((t) => t.id === Number(id));

/* ---------- Эндпоинты (уровень 1) ---------- */
app.get('/api/items', (req, res) => {
  res.json(allItems());
});

app.get('/api/items/:id', (req, res) => {
  const train = findTrain(req.params.id);
  if (!train) return res.status(404).json({ error: 'Поезд не найден', id: req.params.id });
  res.json(view(train));
});

/* ---------- Изменение поезда диспетчером (PATCH, JSON в теле) ---------- */
app.patch('/api/items/:id', (req, res) => {
  const train = findTrain(req.params.id);
  if (!train) return res.status(404).json({ error: 'Поезд не найден', id: req.params.id });
  const s = state.get(train.id);
  const { platform, delay, cancelled } = req.body || {};
  if (platform !== undefined) {
    if (![1, 2, 3, 4].includes(platform)) return res.status(400).json({ error: 'Путь должен быть от 1 до 4' });
    s.platform = platform;
  }
  if (delay !== undefined) {
    if (!Number.isInteger(delay) || delay < 0 || delay > 999) return res.status(400).json({ error: 'Задержка от 0 до 999 минут' });
    s.delay = delay;
  }
  if (cancelled !== undefined) s.cancelled = Boolean(cancelled);
  s.updatedAt = Date.now();
  const item = view(train);
  broadcast({ type: 'update', reason: 'dispatcher', changed: [train.id], items: allItems(), at: new Date().toISOString() });
  res.json(item);
});

/* ---------- Объявление диктора (POST, JSON в теле) ---------- */
app.post('/api/announcements', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Пустое объявление' });
  const announcement = { id: Date.now(), text, at: new Date().toISOString() };
  broadcast({ type: 'announce', ...announcement });
  res.status(201).json(announcement);
});

/* ---------- Рубильники (уровень 3) ---------- */
app.get('/api/fail/500', (req, res) => {
  res.status(500).json({ error: 'Диспетчерская не отвечает: внутренняя ошибка сервера' });
});

app.get('/api/fail/slow', (req, res) => {
  const timer = setTimeout(() => res.json(allItems()), 3000);
  req.on('close', () => clearTimeout(timer)); // клиент отменил — не отвечаем впустую
});

app.get('/api/fail/broken-json', (req, res) => {
  res.type('application/json').send('[{"id": 1, "number": "002Ц", "to": "Аст');
});

// Любой другой адрес /api/... — понятный JSON с 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Такого адреса нет', path: req.originalUrl });
});

/* ---------- WebSocket на том же порту (уровень 6) ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

function sendClients() {
  broadcast({ type: 'clients', count: wss.clients.size });
}

wss.on('connection', (socket, req) => {
  console.log(`${paint(90, new Date().toLocaleTimeString('ru-RU'))}  ${paint(36, 'WS    ')} подключилось табло, всего ${wss.clients.size}`);
  socket.send(JSON.stringify({ type: 'hello', items: allItems(), clients: wss.clients.size, at: new Date().toISOString() }));
  sendClients();
  socket.on('close', () => {
    console.log(`${paint(90, new Date().toLocaleTimeString('ru-RU'))}  ${paint(36, 'WS    ')} табло отключилось, осталось ${wss.clients.size}`);
    sendClients();
  });
});

// Раз в 5 секунд вокзал живёт своей жизнью: задержки, посадка, новые рейсы
setInterval(() => {
  const now = Date.now();
  const changed = [];
  for (const train of TRAINS) {
    const s = state.get(train.id);
    const before = statusOf(train, s, now - 5000).code;
    // ушедший поезд через 2 минуты уступает место следующему рейсу
    if (s.departure + s.delay * MINUTE + 2 * MINUTE < now) {
      s.departure = now + (40 + Math.floor(Math.random() * 40)) * MINUTE;
      s.delay = 0;
      s.cancelled = false;
      s.platform = 1 + Math.floor(Math.random() * 3);
      s.updatedAt = now;
      changed.push(train.id);
      continue;
    }
    const code = statusOf(train, s, now).code;
    // иногда поезд задерживается (не во время посадки и не отменённый)
    if (code === 'scheduled' || code === 'delayed') {
      if (Math.random() < 0.06) {
        s.delay += 5;
        s.updatedAt = now;
        changed.push(train.id);
        continue;
      }
    }
    if (code !== before) changed.push(train.id);
  }
  broadcast({ type: 'update', reason: 'tick', changed, items: allItems(), at: new Date(now).toISOString() });
}, 5000);

server.listen(PORT, () => {
  console.log('');
  console.log(paint(1, '  Вокзал Щучинск: табло запущено'));
  console.log(`  Табло:      ${paint(36, `http://localhost:${PORT}`)}`);
  console.log(`  Поезда:     ${paint(36, `http://localhost:${PORT}/api/items`)}`);
  console.log(`  WebSocket:  ${paint(36, `ws://localhost:${PORT}`)}`);
  console.log(paint(90, '  Остановить: Ctrl+C'));
  console.log('');
});
