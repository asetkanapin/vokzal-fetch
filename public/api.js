'use strict';

/* =========================================================
   Запросы к серверу
   - журнал «Сеть»: каждый fetch на странице попадает в таблицу;
   - requestJSON(): проверка response.ok, разбор JSON, таймаут через abort(),
     отмена предыдущего запроса и защита от двойного щелчка (уровень 4).
   ========================================================= */

/* ---------- Журнал «Сеть» ---------- */
const netEntries = [];
const NET_LIMIT = 40;

function shortUrl(url) {
  const u = new URL(url, location.href);
  const host = u.origin === location.origin ? '' : u.host.replace(/^www\./, '');
  return (host ? host + ' ' : '') + u.pathname + u.search;
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  return bytes < 1024 ? bytes + ' Б' : (bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' КБ';
}

function renderNet() {
  const body = $('#netlog');
  body.textContent = '';
  for (const e of netEntries) {
    const tr = document.createElement('tr');
    tr.className = 'net-' + e.kind;
    const cells = [
      e.method,
      shortUrl(e.url),
      e.statusText,
      e.ms == null ? '…' : Math.round(e.ms) + ' мс',
      formatSize(e.size),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 1) td.title = e.url;
      if (i >= 2) td.className = 'num';
      tr.append(td);
    });
    body.append(tr);
  }
}

$('#net-clear').addEventListener('click', () => {
  netEntries.length = 0;
  renderNet();
});

// Обёртка над fetch: тот же fetch, только каждый вызов записывается в журнал
const nativeFetch = window.fetch.bind(window);
window.fetch = async function trackedFetch(input, init = {}) {
  const entry = {
    method: (init.method || 'GET').toUpperCase(),
    url: typeof input === 'string' ? input : input.url,
    statusText: '…',
    kind: 'pending',
    started: performance.now(),
    ms: null,
    size: null,
  };
  netEntries.unshift(entry);
  if (netEntries.length > NET_LIMIT) netEntries.pop();
  renderNet();
  try {
    const response = await nativeFetch(input, init);
    entry.statusText = String(response.status);
    entry.kind = response.ok ? 'ok' : 'bad';
    entry.ms = performance.now() - entry.started;
    response.clone().arrayBuffer()
      .then((buf) => { entry.size = buf.byteLength; entry.ms = performance.now() - entry.started; renderNet(); })
      .catch(() => { entry.statusText += ' (canceled)'; entry.kind = 'canceled'; renderNet(); });
    renderNet();
    return response;
  } catch (error) {
    entry.ms = performance.now() - entry.started;
    const reason = init.signal && init.signal.aborted ? init.signal.reason : null;
    if (reason && reason.name === 'TimeoutError') { entry.statusText = '(canceled) таймаут'; entry.kind = 'canceled'; }
    else if (reason) { entry.statusText = '(canceled)'; entry.kind = 'canceled'; }
    else { entry.statusText = 'нет связи'; entry.kind = 'failed'; }
    renderNet();
    throw error;
  }
};

/* ---------- requestJSON ---------- */
const running = new Map(); // группа → { key, controller, promise }

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function abortReason(name, message) {
  return new DOMException(message, name);
}

/**
 * Запрос с проверкой ответа.
 * group: запросы одной группы не идут параллельно:
 *   тот же адрес ещё в пути → возвращаем тот же промис (двойной щелчок = один запрос);
 *   другой адрес → старый запрос отменяется через abort().
 * timeout: через сколько мс отменить запрос по-настоящему (abort), 0 — не ограничивать.
 */
function requestJSON(url, { method = 'GET', body, group = null, timeout = 0 } = {}) {
  const key = method + ' ' + url;
  if (group && running.has(group)) {
    const current = running.get(group);
    if (current.key === key) {
      document.dispatchEvent(new CustomEvent('net:dedupe', { detail: { url } }));
      return current.promise;
    }
    current.controller.abort(abortReason('ReplacedError', 'Запрос заменён новым'));
    document.dispatchEvent(new CustomEvent('net:replaced', { detail: { url: current.key } }));
  }

  const controller = new AbortController();
  let timer = null;
  if (timeout) {
    timer = setTimeout(() => {
      controller.abort(abortReason('TimeoutError', 'Сервер не ответил за ' + timeout / 1000 + ' с'));
    }, timeout);
  }

  const promise = (async () => {
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        throw new SyntaxError('Сервер прислал повреждённый JSON');
      }
      if (!response.ok) {
        const reason = data && (typeof data.error === 'string' ? data.error : data.reason);
        throw new HttpError(response.status, reason || 'Ошибка HTTP ' + response.status);
      }
      return data;
    } catch (error) {
      // если запрос отменили, отдаём причину отмены (таймаут или замена), а не общий AbortError
      if (controller.signal.aborted && controller.signal.reason instanceof DOMException) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      if (group && running.get(group)?.controller === controller) running.delete(group);
    }
  })();

  if (group) running.set(group, { key, controller, promise });
  return promise;
}

/* Понятное описание ошибки для пользователя */
function describeError(error) {
  if (error.name === 'ReplacedError') return { kind: 'replaced', flap: 'ОТМЕНЁН', text: 'Запрос отменён: его заменил новый.' };
  if (error.name === 'TimeoutError') return { kind: 'timeout', flap: 'ТАЙМАУТ', text: error.message + '. Запрос отменён через abort(), сервер больше не ждём.' };
  if (error.name === 'SyntaxError') return { kind: 'json', flap: 'БИТЫЕ ДАННЫЕ', text: 'Сервер прислал повреждённые данные (битый JSON). Мы не стали показывать мусор.' };
  if (error.name === 'HttpError' && error.status === 404) return { kind: 'e404', flap: 'НЕ НАЙДЕН 404', text: 'Сервер ответил 404: ' + error.message.toLowerCase() + '.' };
  if (error.name === 'HttpError' && error.status >= 500) return { kind: 'e500', flap: 'ОШИБКА ' + error.status, text: 'Сервер ответил ' + error.status + ': ' + error.message + '.' };
  if (error.name === 'HttpError') return { kind: 'http', flap: 'ОШИБКА ' + error.status, text: error.message };
  if (error instanceof TypeError) return { kind: 'offline', flap: 'НЕТ СВЯЗИ', text: 'Нет связи с сервером. Проверьте интернет или запущен ли node server.js.' };
  return { kind: 'unknown', flap: 'ОШИБКА', text: error.message || 'Что-то пошло не так.' };
}
