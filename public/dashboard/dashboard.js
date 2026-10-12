const $ = (sel) => document.querySelector(sel);
const PLAYER_COLORS = ['#e5322d', '#3b82f6', '#2fb86a', '#e0a800'];
const BUTTONS = [
  ['2', 1 << 3],
  ['1', 1 << 2],
  ['B', 1 << 1],
  ['A', 1 << 0],
  ['✚', (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10)],
];

let current = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showError(err) {
  const el = $('#error');
  el.textContent = err ? err.message ?? String(err) : '';
  el.hidden = !err;
}

async function action(fn) {
  showError(null);
  try {
    render(await fn());
  } catch (err) {
    showError(err);
  }
}

// ---------- Players ----------

const playersEl = $('#players');
for (let i = 0; i < 4; i++) {
  const card = document.createElement('div');
  card.className = 'player empty';
  card.style.setProperty('--c', PLAYER_COLORS[i]);
  card.innerHTML = `
    <div><div class="label">PLAYER ${i + 1}</div><div class="name">Waiting for a phone…</div></div>
    <div class="meter" title="Steering"><i></i></div>
    <div class="btns">${BUTTONS.map(([l]) => `<span>${l}</span>`).join('')}</div>`;
  playersEl.append(card);
}

function renderPlayers(players) {
  players.forEach((p, i) => {
    const card = playersEl.children[i];
    card.classList.toggle('on', Boolean(p));
    card.classList.toggle('empty', !p);
    card.querySelector('.name').textContent = p ? p.name : 'Waiting for a phone…';
    // ±90° of wheel turn spans the meter.
    const tilt = p ? Math.max(-90, Math.min(90, p.tilt)) : 0;
    card.querySelector('.meter i').style.left = `${41 + (tilt / 90) * 41}%`;
    card.querySelectorAll('.btns span').forEach((s, j) => s.classList.toggle('on', Boolean(p && p.buttons & BUTTONS[j][1])));
  });
}

// ---------- Setup ----------

function render(s) {
  const firstRender = !current;
  current = s;
  renderPlayers(s.players);

  if (firstRender || $('#phone-url').textContent !== (s.phoneUrl ?? '')) {
    $('#phone-url').textContent = s.phoneUrl ?? 'No Wi-Fi network found. Connect this computer to Wi-Fi.';
    $('#qr').src = `/api/qr.svg?u=${encodeURIComponent(s.phoneUrl ?? '')}`;
  }

  const game = s.game;
  $('#step-game').classList.toggle('done', Boolean(game));
  $('#game-detail').textContent = game
    ? `${game.name}${game.region ? ` · Mario Kart Wii (${game.region})` : game.isMarioKartWii ? '' : ' · this may not be Mario Kart Wii'}`
    : 'No game chosen yet.';

  $('#step-dolphin').classList.toggle('done', s.dolphin.found);
  $('#dolphin-detail').textContent = s.dolphin.found ? `Found at ${s.dolphin.path}` : "Couldn't find Dolphin on this computer.";
  $('#dolphin-missing').hidden = s.dolphin.found;

  if (firstRender) {
    $('#fullscreen').checked = s.fullscreen;
    $('#dolphin-path').placeholder = { darwin: '/Applications/Dolphin.app', win32: 'C:\\Dolphin-x64\\Dolphin.exe' }[s.platform] ?? '/usr/bin/dolphin-emu';
  }

  const running = s.dolphin.running;
  $('#play').hidden = running;
  $('#stop').hidden = !running;
  $('#play').disabled = !game || !s.dolphin.found;
  if (s.error) showError(new Error(s.error));
}

$('#find-games').addEventListener('click', async () => {
  const list = $('#game-list');
  $('#find-games').textContent = 'Looking…';
  try {
    const games = await api('/api/games');
    list.innerHTML = '';
    if (games.length === 0) {
      list.innerHTML = '<li class="note">No game files found in Downloads, Desktop, Documents or Games. Enter the location below.</li>';
    }
    for (const g of games.slice(0, 12)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.title = g.path;
      btn.innerHTML = `<span class="file"></span>${g.isMarioKartWii ? `<span class="tag">Mario Kart Wii${g.region ? ` · ${g.region}` : ''}</span>` : ''}`;
      btn.querySelector('.file').textContent = g.path;
      btn.addEventListener('click', () => {
        list.hidden = true;
        action(() => api('/api/settings', { gamePath: g.path }));
      });
      li.append(btn);
      list.append(li);
    }
    list.hidden = false;
  } catch (err) {
    showError(err);
  } finally {
    $('#find-games').textContent = 'Find it for me';
  }
});

$('#save-game').addEventListener('click', () => action(() => api('/api/settings', { gamePath: $('#game-path').value })));
$('#save-dolphin').addEventListener('click', () => action(() => api('/api/settings', { dolphinPath: $('#dolphin-path').value })));
$('#recheck').addEventListener('click', () => action(() => api('/api/state')));
$('#fullscreen').addEventListener('change', (e) => action(() => api('/api/settings', { fullscreen: e.target.checked })));
$('#play').addEventListener('click', () => action(() => api('/api/launch', {})));
$('#stop').addEventListener('click', () => action(() => api('/api/stop', {})));

// ---------- Live updates ----------

function listen() {
  const events = new EventSource('/api/events');
  events.onmessage = (e) => render(JSON.parse(e.data));
  events.onerror = () => {
    events.close();
    $('#phone-url').textContent = 'Portable Kart stopped. Start it again to keep playing.';
    setTimeout(listen, 2000);
  };
}
listen();
