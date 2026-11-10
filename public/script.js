'use strict';

/* =========================================================
   Практикум урока «Fetch API: GET-запросы к публичным REST API»
   Все результаты выводятся в один контейнер <div id="output">.
   ========================================================= */

const JP = 'https://jsonplaceholder.typicode.com';
const ASTANA_WEATHER = 'https://api.open-meteo.com/v1/forecast?latitude=51.18&longitude=71.45&current_weather=true';
const output = document.getElementById('output');
const done = new Set(readStore('vokzal-lesson', []));

function markDone(task) {
  done.add(task);
  writeStore('vokzal-lesson', [...done]);
  if (['post', 'users', 'posts', 'missing', 'weather'].every((t) => done.has(t))) award('lesson');
}

function setMeta(text) {
  document.getElementById('output-meta').textContent = text;
}

// Индикатор «Загрузка...»
function showLoading(what) {
  output.textContent = '';
  const p = document.createElement('p');
  p.className = 'loading';
  p.textContent = 'Загрузка...';
  output.append(p);
  setMeta(what);
}

// Понятное сообщение об ошибке и кнопка «Повторить»
function showError(message, retry) {
  output.textContent = '';
  const box = document.createElement('div');
  box.className = 'error-card';
  const p = document.createElement('p');
  p.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-dark';
  button.textContent = 'Повторить';
  button.addEventListener('click', retry);
  box.append(p, button);
  output.append(box);
  sfx.play('error');
}

function errorText(error) {
  if (error instanceof TypeError) return 'Нет связи с сервером. Проверьте интернет.';
  return error.message;
}

/* ---------- 1. Один пост: fetch + .then() ---------- */
function loadPost() {
  showLoading('GET /posts/1');
  fetch(JP + '/posts/1')
    .then((response) => {
      if (!response.ok) throw new Error('Ошибка HTTP: ' + response.status);
      return response.json();
    })
    .then((post) => {
      output.textContent = '';
      const article = document.createElement('article');
      article.className = 'post';
      const title = document.createElement('h3');
      title.textContent = post.title;
      const body = document.createElement('p');
      body.textContent = post.body;
      const meta = document.createElement('span');
      meta.className = 'hint';
      meta.textContent = 'Пост №' + post.id + ', автор userId ' + post.userId;
      article.append(title, body, meta);
      output.append(article);
      markDone('post');
    })
    .catch((error) => showError('Пост не загрузился. ' + errorText(error), loadPost));
}

/* ---------- 2. Пользователи: async/await ---------- */
async function loadUsers() {
  showLoading('GET /users');
  try {
    const response = await fetch(JP + '/users');
    if (!response.ok) throw new Error('Ошибка HTTP: ' + response.status);
    const users = await response.json();
    output.textContent = '';
    const grid = document.createElement('ul');
    grid.className = 'user-cards';
    users.forEach((user) => {
      const card = document.createElement('li');
      card.className = 'user-card';
      const name = document.createElement('strong');
      name.textContent = user.name;
      const email = document.createElement('a');
      email.href = 'mailto:' + user.email;
      email.textContent = user.email;
      const city = document.createElement('span');
      city.textContent = 'Город: ' + user.address.city;
      const company = document.createElement('span');
      company.textContent = 'Компания: ' + user.company.name;
      card.append(name, email, city, company);
      grid.append(card);
    });
    output.append(grid);
    setMeta('GET /users · ' + users.length + ' пользователей');
    markDone('users');
  } catch (error) {
    showError('Пользователи не загрузились. ' + errorText(error), loadUsers);
  }
}

/* ---------- 3. Посты пользователя: параметр ?userId= ---------- */
async function loadUserPosts(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('user-id');
  const userId = Number(input.value);
  if (!Number.isInteger(userId) || userId < 1 || userId > 10) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    showError('userId должен быть целым числом от 1 до 10.', () => input.focus());
    return;
  }
  input.removeAttribute('aria-invalid');
  const url = `${JP}/posts?userId=${userId}`;
  showLoading('GET /posts?userId=' + userId);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Ошибка HTTP: ' + response.status);
    const posts = await response.json();
    output.textContent = '';
    const list = document.createElement('ol');
    list.className = 'post-list';
    posts.forEach((post) => {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = post.title;
      const body = document.createElement('p');
      body.textContent = post.body;
      li.append(title, body);
      list.append(li);
    });
    output.append(list);
    setMeta('GET /posts?userId=' + userId + ' · ' + posts.length + ' постов');
    markDone('posts');
  } catch (error) {
    showError('Посты не загрузились. ' + errorText(error), loadUserPosts);
  }
}

/* ---------- 4. Ошибка: несуществующий адрес ---------- */
async function loadMissing() {
  showLoading('GET /posts/99999');
  try {
    const response = await fetch(JP + '/posts/99999');
    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'Пост №99999 не найден (ответ сервера 404). fetch не считает это ошибкой, поэтому мы проверили response.ok сами.'
        : 'Ошибка HTTP: ' + response.status);
    }
    const post = await response.json();
    output.textContent = post.title;
  } catch (error) {
    showError(errorText(error), loadMissing);
    setMeta('GET /posts/99999 · 404');
    markDone('missing');
  }
}

/* ---------- 5. Погода в Астане (Open-Meteo) ---------- */
async function loadWeather() {
  showLoading('GET api.open-meteo.com/v1/forecast');
  try {
    const response = await fetch(ASTANA_WEATHER);
    if (!response.ok) throw new Error('Ошибка HTTP: ' + response.status);
    const data = await response.json();
    const w = data.current_weather;
    output.textContent = '';
    const card = document.createElement('div');
    card.className = 'weather-card';
    const city = document.createElement('h3');
    city.textContent = 'Астана';
    const temp = document.createElement('strong');
    temp.className = 'weather-big num';
    temp.textContent = Math.round(w.temperature) + ' °C';
    const wind = document.createElement('p');
    wind.textContent = 'Ветер ' + w.windspeed + ' км/ч (' + (w.windspeed / 3.6).toFixed(1) + ' м/с), ' + WEATHER_TEXT(w.weathercode) + '.';
    const when = document.createElement('span');
    when.className = 'hint';
    when.textContent = 'Данные Open-Meteo на ' + w.time.replace('T', ' ') + ' по Гринвичу';
    card.append(city, temp, wind, when);
    output.append(card);
    setMeta('GET open-meteo · 200');
    markDone('weather');
    award('weather');
  } catch (error) {
    showError('Погода не загрузилась. ' + errorText(error), loadWeather);
  }
}

document.getElementById('post-btn').addEventListener('click', loadPost);
document.getElementById('users-btn').addEventListener('click', loadUsers);
document.getElementById('posts-form').addEventListener('submit', loadUserPosts);
document.getElementById('missing-btn').addEventListener('click', loadMissing);
document.getElementById('weather-btn').addEventListener('click', loadWeather);
