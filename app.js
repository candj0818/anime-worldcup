import { createStore } from './store.js';
import { prepareImage } from './images.js';
import { shuffle, roundLabel, newGame, applyChoice, skipPair, canDropBoth, tiebreakInfo, personalRanking, resultOf } from './engine.js';

const MAX_CHARS = 140;
const PROGRESS_KEY = 'wc_progress_v1';
const $app = document.getElementById('app');

let store;
let chars = [];
let charMap = new Map();
let tab = 'play';
let game = null;      // 진행 중이거나 막 끝난 월드컵
let pending = [];     // 등록 대기 중인 사진 [{img, name}]
let busy = false;     // 연타 방지
let lastSave = null;  // 방금 끝난 판의 결과 저장(누적 순위를 그 뒤에 불러옴)

// ---------- 공통 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

const normName = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

// 고화질 사진: 필요한 것만 받아오고, 휴대폰 메모리를 위해 최근 것 몇 장만 기억
const FULL_CACHE_MAX = 12;
const fullCache = new Map(); // id -> dataURL 또는 받는 중인 Promise

function loadFull(id) {
  const hit = fullCache.get(id);
  if (hit !== undefined) {
    fullCache.delete(id); fullCache.set(id, hit); // 최근 사용으로 갱신
    return Promise.resolve(hit);
  }
  const p = store.getFull(id)
    .then(src => {
      const v = src || charMap.get(id)?.img || null;
      fullCache.set(id, v);
      while (fullCache.size > FULL_CACHE_MAX) fullCache.delete(fullCache.keys().next().value);
      return v;
    })
    .catch(() => { fullCache.delete(id); return null; });
  fullCache.set(id, p);
  return p;
}

// 이미 받아둔 고화질이 있으면 바로, 없으면 썸네일을 먼저 보여준다
function bestSrc(c) {
  const v = fullCache.get(c.id);
  return typeof v === 'string' ? v : c.img;
}

// data-full 이 붙은 사진을 고화질로 교체
function upgradeImages() {
  $app.querySelectorAll('img[data-full]').forEach(el => {
    loadFull(el.dataset.full).then(src => {
      if (src && el.isConnected && el.getAttribute('src') !== src) el.src = src;
    });
  });
}

async function loadChars() {
  chars = await store.listCharacters();
  charMap = new Map(chars.map(c => [c.id, c]));
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  window.scrollTo(0, 0);
  render();
}

function render() {
  document.body.classList.toggle('playing', tab === 'play' && !!game && !game.done);
  if (tab === 'play') renderPlay();
  else if (tab === 'upload') renderUpload();
  else renderRank();
}

// ---------- 진행 상황 저장(중간에 나가도 이어하기) ----------
function saveProgress() {
  if (!game || game.done) return;
  const { history, ...rest } = game;
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(rest)); } catch { /* 저장 불가해도 게임은 계속 */ }
}
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch { return null; }
}
function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch { /* 무시 */ }
}

// ---------- 토너먼트 ----------
// 닉네임은 이 기기에 기억해 두고 다음 판에도 채워 둔다
const NICK_KEY = 'wc_nick';
function loadNick() { try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; } }
function saveNick(v) { try { localStorage.setItem(NICK_KEY, v); } catch { /* 무시 */ } }

function startGame(size) {
  const input = $app.querySelector('[data-nick]');
  const nick = (input?.value || '').trim().slice(0, 20);
  if (!nick) { toast('닉네임을 먼저 적어 주세요'); input?.focus(); return; }
  saveNick(nick);
  const ids = shuffle(chars.map(c => c.id)).slice(0, size);
  game = { ...newGame(ids), nick, saved: false, history: [] };
  saveProgress();
  render();
}

function snapshot() {
  const { history, ...rest } = game;
  return JSON.stringify(rest);
}

function choose(result) {
  game.history.push(snapshot());
  if (game.history.length > 400) game.history.shift();
  applyChoice(game, result);
  afterMove();
}

function afterMove() {
  if (!game.done) return saveProgress();
  clearProgress();
  if (!game.saved) {
    game.saved = true;
    lastSave = store.addResult({ ...resultOf(game), nick: game.nick || '익명' })
      .catch(e => toast('결과 저장 실패: ' + e.message, 4000));
  }
}

function undo() {
  const prev = game.history.pop();
  if (!prev) return;
  const history = game.history;
  game = { ...JSON.parse(prev), history };
  saveProgress();
}

// ---------- 화면: 월드컵 ----------
function renderPlay() {
  if (game && !game.done) return renderMatch();
  if (game && game.done) return renderResult();

  const n = chars.length;
  if (n < 2) {
    $app.innerHTML = `
      <section class="card center">
        <div class="big-emoji">🌸</div>
        <h2>아직 캐릭터가 부족해요</h2>
        <p class="muted">2명 이상 등록되면 시작할 수 있어요. (지금 ${n}명)</p>
        <button class="btn primary" data-go="upload">캐릭터 등록하러 가기</button>
      </section>`;
    return;
  }

  const saved = loadProgress();
  const sizes = [8, 16, 32, 64, 128].filter(s => s < n);
  $app.innerHTML = `
    ${saved ? `
      <section class="card resume">
        <div><strong>하던 월드컵이 있어요</strong>
        <p class="muted">${esc(roundLabel(saved.round.length))} · ${saved.size}명 참가</p></div>
        <div class="row">
          <button class="btn primary" data-resume>이어하기</button>
          <button class="btn ghost" data-discard>버리기</button>
        </div>
      </section>` : ''}
    <section class="card">
      <h2>닉네임</h2>
      <p class="muted">내 TOP 10이 이 이름으로 전체 순위 탭에 공개돼요.</p>
      <input type="text" data-nick maxlength="20" placeholder="예: 벚꽃러버" value="${esc(loadNick())}">
    </section>
    <section class="card">
      <h2>몇 강으로 할까요?</h2>
      <p class="muted">등록된 캐릭터 <strong>${n}명</strong> 중에서 무작위로 뽑아요.</p>
      <div class="sizes">
        ${sizes.map(s => `<button class="size" data-size="${s}"><b>${s}강</b><small>${s - 1}판 이상</small></button>`).join('')}
        <button class="size all" data-size="${n}"><b>전체 ${n}명</b><small>${n - 1}판 이상</small></button>
      </div>
    </section>
    <section class="card rules">
      <h3>규칙</h3>
      <ul>
        <li>더 좋은 캐릭터 사진을 <b>두 번 톡톡</b> 누르세요.</li>
        <li><b>💕 둘 다 좋아</b>를 누르면 둘 다 다음 라운드로 올라가요. 결승이면 <b>공동 우승</b>이에요.</li>
        <li><b>👎 둘 다 싫어</b>를 누르면 둘 다 탈락해요. (아무도 안 남게 되는 대결에선 못 눌러요)</li>
        <li>끝났을 때 TOP 10 안에 동점이 있으면 <b>동점 결정전</b>으로 10위까지 정확히 정해요.</li>
        <li>인원이 홀수가 되면 한 명은 부전승으로 올라가요.</li>
        <li>중간에 나가도 이 기기에서 이어서 할 수 있어요.</li>
      </ul>
    </section>`;
}

function renderMatch() {
  // 게임 도중 누가 캐릭터를 지웠으면 남은 쪽이 자동 진출
  let a = charMap.get(game.round[game.i]), b = charMap.get(game.round[game.i + 1]);
  while (!game.done && (!a || !b)) {
    if (!a && !b) {
      skipPair(game);
      afterMove();
    } else {
      choose(a ? 'a' : 'b');
      game.history.pop();
    }
    if (game.done) return render();
    a = charMap.get(game.round[game.i]); b = charMap.get(game.round[game.i + 1]);
  }

  const total = Math.floor(game.round.length / 2);
  const cur = game.i / 2 + 1;
  const bye = game.round.length % 2 === 1 ? ' · 1명 부전승' : '';
  const tb = tiebreakInfo(game);
  const title = tb ? '동점 결정전' : roundLabel(game.round.length);
  const sub = tb ? `공동 ${tb.from}위 ${tb.size}명 · ${tb.place}위 가리는 중` : `${cur} / ${total}${bye}`;
  const buttons = tb
    ? `<p class="hint">${tb.from}~${tb.to}위 동점 · 더 좋은 쪽을 골라주세요</p>`
    : `<button class="btn draw sm" data-pick="draw">💕 둘 다 좋아</button>
        <button class="btn dislike sm" data-pick="none" ${canDropBoth(game) ? '' : 'disabled'}>👎 둘 다 싫어</button>`;
  $app.innerHTML = `
    <section class="match">
      <div class="mhead">
        <div class="mtitle"><strong>${title}</strong><span>${sub}</span></div>
        <div class="bar"><i style="width:${tb ? 100 : ((cur - 1) / total) * 100}%"></i></div>
      </div>
      <p class="hint">사진을 <b>두 번 톡톡</b> 누르면 선택돼요</p>
      <div class="duel">
      <button class="pick pa" data-pick="a" aria-label="${esc(a.name)} 선택">
        <img src="${bestSrc(a)}" data-full="${esc(a.id)}" alt=""><span class="nm">${esc(a.name)}</span>
      </button>
      <button class="pick pb" data-pick="b" aria-label="${esc(b.name)} 선택">
        <img src="${bestSrc(b)}" data-full="${esc(b.id)}" alt=""><span class="nm">${esc(b.name)}</span>
      </button>
      </div>
      <div class="mid">
        <button class="btn ghost sm undo" data-undo ${game.history.length ? '' : 'disabled'} aria-label="되돌리기">↶</button>
        ${buttons}
      </div>
      <button class="linkbtn quit" data-quit>그만하기</button>
    </section>`;
  upgradeImages();
  // 다음 대결 사진을 미리 받아두기
  [game.round[game.i + 2], game.round[game.i + 3]].forEach(id => { if (charMap.has(id)) loadFull(id); });
}

function stageText(g, r) {
  if (r.elim === 999) return g.champions.length > 1 ? '공동 우승' : '우승';
  const size = g.roundSizes[r.elim];
  return size === 2 ? '준우승' : `${roundLabel(size)} 탈락`;
}

function rankRow(rank, c, main, sub) {
  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[rank] || rank;
  return `
    <li class="rrow${rank <= 3 ? ' top' : ''}">
      <span class="rk">${medal}</span>
      <img src="${c.img}" alt="" data-zoom="${esc(c.id)}">
      <span class="rinfo"><b>${esc(c.name)}</b><small>${sub}</small></span>
      <span class="rmain">${main}</span>
    </li>`;
}

function renderResult() {
  const rows = personalRanking(game).filter(r => charMap.has(r.id)).slice(0, 10);
  const champs = game.champions.map(id => charMap.get(id)).filter(Boolean);
  $app.innerHTML = `
    <section class="card champ">
      <p class="crown">🏆 ${game.nick ? esc(game.nick) + '님의 ' : '나의 '}${champs.length > 1 ? '공동 우승' : '우승'}</p>
      <div class="champ-imgs n${Math.min(champs.length, 2)}">
        ${champs.map(c => `<figure><img src="${bestSrc(c)}" data-full="${esc(c.id)}" data-zoom="${esc(c.id)}" alt=""><figcaption>${esc(c.name)}</figcaption></figure>`).join('')}
      </div>
      <p class="muted">${game.size}명 참가 월드컵</p>
    </section>
    <section class="card">
      <h2>나의 TOP 10</h2>
      <ol class="rlist">
        ${rows.map(r => {
          const c = charMap.get(r.id);
          const [w, d, l] = r.s;
          return rankRow(r.rank, c, esc(stageText(game, r)), `${w}승 ${d}무 ${l}패`);
        }).join('')}
      </ol>
    </section>
    <section class="card" id="cumul">${game.nick ? `<p class="muted">${esc(game.nick)}님의 누적 순위 불러오는 중…</p>` : ''}</section>
    <div class="row stack">
      <button class="btn primary" data-go="rank">📊 모두의 순위 보기</button>
      <button class="btn ghost" data-again>다시 하기</button>
    </div>`;
  upgradeImages();
  if (game.nick) fillCumulative(game.nick);
}

async function fillCumulative(nick) {
  const g = game;
  try {
    await lastSave;
    const results = await store.listResults();
    const box = document.getElementById('cumul');
    if (!box || game !== g) return;
    const games = gamesOf(results, nick);
    box.innerHTML = games.length ? cumulativeHtml(nick, games) : '';
  } catch { /* 누적 순위는 부가 정보라 실패해도 조용히 넘어감 */ }
}

// ---------- 닉네임별 누적 순위 ----------
// 같은 닉네임으로 한 판들을 모아서: 판마다 1위 10점 … 10위 1점을 더함.
// 점수 같으면 TOP 10에 든 횟수, 그다음 최고 순위 순.
const normNick = s => String(s || '익명').trim().toLowerCase();
const tsOf = r => r.createdAt?.toMillis?.() ?? 0;

function gamesOf(results, nick) {
  return results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (r.top10 || []).length && normNick(r.nick) === normNick(nick))
    .sort((x, y) => tsOf(x.r) - tsOf(y.r) || x.i - y.i)   // 오래된 판 → 최근 판
    .map(({ r }) => r);
}

function cumulate(games) {
  const m = new Map();
  for (const r of games) {
    r.top10.forEach((id, i) => {
      const rank = r.top10pts ? 11 - r.top10pts[i] : i + 1;
      if (!m.has(id)) m.set(id, { id, pts: 0, cnt: 0, best: 99, sum: 0, last: null });
      const a = m.get(id);
      a.pts += 11 - rank; a.cnt++; a.best = Math.min(a.best, rank); a.sum += rank;
    });
  }
  const rows = [...m.values()].filter(a => charMap.has(a.id))
    .sort((x, y) => y.pts - x.pts || y.cnt - x.cnt || x.best - y.best);
  rows.forEach((r, i) => {
    const p = rows[i - 1];
    r.rank = p && p.pts === r.pts && p.cnt === r.cnt && p.best === r.best ? p.rank : i + 1;
  });
  return rows;
}

function cumulativeHtml(nick, games) {
  const now = cumulate(games);
  const before = games.length > 1 ? new Map(cumulate(games.slice(0, -1)).map(r => [r.id, r.rank])) : null;
  const latest = games[games.length - 1];
  const latestRank = new Map(latest.top10.map((id, i) => [id, latest.top10pts ? 11 - latest.top10pts[i] : i + 1]));
  const move = r => {
    if (!before) return '';
    const b = before.get(r.id);
    if (b === undefined || b > 10) return '<em class="mv new">NEW</em>';
    if (b > r.rank) return `<em class="mv up">▲${b - r.rank}</em>`;
    if (b < r.rank) return `<em class="mv down">▼${r.rank - b}</em>`;
    return '<em class="mv same">–</em>';
  };
  return `
    <h2>📈 ${esc(nick)}님의 누적 TOP 10</h2>
    <p class="muted">${games.length}판 합산${before ? ' · 화살표는 직전 판까지의 누적 순위와 비교' : ''}</p>
    <ol class="rlist">
      ${now.slice(0, 10).map(r => {
        const lr = latestRank.get(r.id);
        return rankRow(r.rank, charMap.get(r.id), `${r.pts}점 ${move(r)}`,
          `TOP10 ${r.cnt}/${games.length}판 · 최고 ${r.best}위 · 평균 ${(r.sum / r.cnt).toFixed(1)}위${lr ? ` · 이번 ${lr}위` : ''}`);
      }).join('')}
    </ol>`;
}

// ---------- 화면: 캐릭터 등록 ----------
function renderUpload() {
  const n = chars.length;
  const left = MAX_CHARS - n;
  $app.innerHTML = `
    <section class="card">
      <h2>캐릭터 등록 <small class="count">${n} / ${MAX_CHARS}</small></h2>
      ${left > 0 ? `
        <p class="muted">좋아하는 캐릭터 사진을 고르고 이름을 적어주세요. 여러 장을 한꺼번에 골라도 돼요.</p>
        <label class="btn primary file">📷 사진 고르기
          <input type="file" accept="image/*" multiple id="file">
        </label>` : `<p class="muted">최대 ${MAX_CHARS}명이 모두 찼어요.</p>`}
      <div id="pending"></div>
    </section>
    <section class="card">
      <div class="listhead">
        <h2>등록된 캐릭터</h2>
        <button class="linkbtn" data-reload>↻ 새로고침</button>
      </div>
      ${chars.length ? `<input class="search" id="search" type="search" placeholder="이름 검색">
      <div class="grid">
        ${chars.map(c => `
          <figure class="tile" data-name="${esc(normName(c.name))}">
            <img src="${c.img}" alt="" loading="lazy" data-zoom="${esc(c.id)}">
            <figcaption>${esc(c.name)}</figcaption>
            ${c.uid === store.uid ? `<button class="del" data-del="${esc(c.id)}" aria-label="삭제">✕</button>` : ''}
          </figure>`).join('')}
      </div>` : `<p class="muted center">아직 아무도 등록하지 않았어요</p>`}
      <p class="muted tiny">✕ 버튼은 이 기기에서 직접 올린 캐릭터에만 보여요.</p>
    </section>
    ${store.mode === 'local' ? `
    <section class="card testkit">
      <h3>🧪 테스트 도구 <small class="muted">체험 모드에서만 보여요</small></h3>
      <div class="row stack">
        <button class="btn ghost" data-fake-chars>가짜 캐릭터 ${MAX_CHARS}명 채우기</button>
        <button class="btn ghost" data-fake-results>가짜 참여자 30명 결과 만들기</button>
        <button class="btn ghost danger" data-fake-clear>테스트 데이터 모두 지우기</button>
      </div>
    </section>` : ''}`;
  renderPending();
}

async function testKit(action) {
  const { makeFakeCharacters, simulateResults } = await import('./demo.js');
  if (action === 'chars') {
    if (chars.length && !confirm(`지금 있는 캐릭터 ${chars.length}명과 순위 기록을 지우고 가짜 ${MAX_CHARS}명으로 바꿀까요?`)) return;
    await store.replaceCharacters(makeFakeCharacters(MAX_CHARS));
    clearProgress();
    game = null;
    await loadChars();
    toast(`가짜 캐릭터 ${chars.length}명을 만들었어요`);
  } else if (action === 'results') {
    if (chars.length < 16) return toast('먼저 캐릭터를 16명 이상 만들어 주세요');
    await store.addResults(simulateResults(chars, 30));
    toast('가짜 참여자 30명이 월드컵을 끝냈어요. 전체 순위를 보세요!');
  } else if (action === 'clear') {
    if (!confirm('이 브라우저의 캐릭터와 순위 기록을 모두 지울까요?')) return;
    await store.clearAll();
    clearProgress();
    game = null;
    await loadChars();
    toast('모두 지웠어요');
  }
  renderUpload();
}

function renderPending() {
  const box = document.getElementById('pending');
  if (!box) return;
  if (!pending.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <ul class="plist">
      ${pending.map((p, i) => `
        <li>
          <img src="${p.img}" alt="" data-zoom="">
          <input type="text" maxlength="40" placeholder="캐릭터 이름" data-pname="${i}" value="${esc(p.name)}">
          <button class="del static" data-prm="${i}" aria-label="빼기">✕</button>
        </li>`).join('')}
    </ul>
    <button class="btn primary wide" data-submit>${pending.length}명 올리기</button>`;
}

async function onFiles(files) {
  const room = MAX_CHARS - chars.length - pending.length;
  const picked = [...files].slice(0, Math.max(0, room));
  if (files.length > picked.length) toast(`자리가 ${room}명 남아서 ${picked.length}장만 받았어요`);
  for (const f of picked) {
    try {
      const { thumb, full } = await prepareImage(f);
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40);
      pending.push({ img: thumb, full, name: /^(img|image|dsc|kakaotalk|screenshot|photo)/i.test(name) ? '' : name });
      renderPending();
    } catch (e) {
      toast(`${f.name}: ${e.message}`);
    }
  }
}

async function submitPending() {
  const existing = new Set(chars.map(c => normName(c.name)));
  const seen = new Set();
  for (const p of pending) {
    const k = normName(p.name);
    if (!k) return toast('이름이 비어 있는 사진이 있어요');
    if (existing.has(k)) return toast(`"${p.name.trim()}"은(는) 이미 등록돼 있어요`);
    if (seen.has(k)) return toast(`"${p.name.trim()}" 이름이 두 번 들어가 있어요`);
    seen.add(k);
  }
  if (chars.length + pending.length > MAX_CHARS) return toast(`최대 ${MAX_CHARS}명까지만 등록할 수 있어요`);

  busy = true;
  const btn = document.querySelector('[data-submit]');
  let ok = 0;
  try {
    while (pending.length) {
      if (btn) btn.textContent = `올리는 중… (${ok + 1}/${ok + pending.length})`;
      const p = pending[0];
      await store.addCharacter({ name: p.name.trim().replace(/\s+/g, ' '), img: p.img, full: p.full });
      pending.shift();
      ok++;
    }
    toast(`${ok}명 등록 완료!`);
  } catch (e) {
    toast('등록 실패: ' + e.message, 4000);
  } finally {
    busy = false;
    await loadChars();
    renderUpload();
  }
}

// ---------- 화면: 전체 순위 ----------
async function renderRank() {
  $app.innerHTML = `<p class="loading">순위 집계 중…</p>`;
  let results;
  try {
    results = await store.listResults();
  } catch (e) {
    $app.innerHTML = `<section class="card center"><p>순위를 불러오지 못했어요.</p><p class="muted">${esc(e.message)}</p></section>`;
    return;
  }
  if (tab !== 'rank') return;

  const agg = new Map();
  const get = id => {
    if (!agg.has(id)) agg.set(id, { id, pts: 0, champ: 0, w: 0, d: 0, l: 0, ranks: [] });
    return agg.get(id);
  };
  for (const r of results) {
    (r.top10 || []).forEach((id, i) => {
      const pts = r.top10pts?.[i] ?? 10 - i;
      get(id).pts += pts; get(id).ranks.push(11 - pts);
    });
    (r.champions || []).forEach(id => { get(id).champ++; });
    for (const [id, s] of Object.entries(r.stats || {})) {
      const a = get(id);
      a.w += s[0] || 0; a.d += s[1] || 0; a.l += s[2] || 0;
    }
  }
  const rate = a => { const m = a.w + a.d + a.l; return m ? (a.w + a.d * 0.5) / m : 0; };
  const rows = [...agg.values()].filter(a => charMap.has(a.id) && a.pts > 0)
    .sort((x, y) => y.pts - x.pts || y.champ - x.champ || rate(y) - rate(x));
  const top = rows.slice(0, 10);
  const pct = a => Math.round(rate(a) * 100);
  top.forEach((r, i) => {
    const p = top[i - 1];
    r.rank = p && p.pts === r.pts && p.champ === r.champ && pct(p) === pct(r) ? p.rank : i + 1;
  });

  // 순위 이유: 어떤 순위로 몇 번 뽑혔는지 + 바로 위/아래와 동점이면 무엇으로 갈렸는지
  const why = (r, i) => {
    const cnt = {};
    r.ranks.forEach(k => { cnt[k] = (cnt[k] || 0) + 1; });
    const dist = Object.keys(cnt).map(Number).sort((a, b) => a - b);
    const distTxt = dist.slice(0, 4).map(k => `${k}위×${cnt[k]}`).join(' ') + (dist.length > 4 ? ' …' : '');
    const lines = [
      `${results.length}판 중 ${r.ranks.length}판 TOP10 · ${distTxt}`,
      `🏆 우승 ${r.champ}회 · 승률 ${pct(r)}%`
    ];
    const tieNote = (o, above) => {
      if (!o || o.pts !== r.pts) return null;
      const who = esc(charMap.get(o.id).name);
      if (o.champ !== r.champ) return `${who}와 같은 ${r.pts}점 → 우승 ${above ? '적어서 아래' : '많아서 위'}`;
      if (pct(o) !== pct(r)) return `${who}와 점수·우승 같음 → 승률 ${above ? '낮아서 아래' : '높아서 위'}`;
      return `${who}와 점수·우승·승률 모두 같아 공동 순위`;
    };
    const note = tieNote(top[i - 1], true) || tieNote(top[i + 1], false);
    if (note) lines.push(`<span class="why">⚖️ ${note}</span>`);
    return lines.join('<br>');
  };

  const byNick = new Map();
  for (const r of results) {
    if (!(r.top10 || []).length) continue;
    const k = normNick(r.nick);
    if (!byNick.has(k)) byNick.set(k, r.nick || '익명');
  }
  const players = [...byNick.values()].map(nick => ({ nick, games: gamesOf(results, nick) }))
    .sort((x, y) => tsOf(y.games[y.games.length - 1]) - tsOf(x.games[x.games.length - 1]));

  $app.innerHTML = `
    <section class="card">
      <div class="listhead">
        <h2>모두의 TOP 10</h2>
        <button class="linkbtn" data-refresh-rank>↻ 새로고침</button>
      </div>
      <p class="muted">지금까지 <b>${results.length}판</b> 완료</p>
      ${top.length ? `<ol class="rlist">
        ${top.map((r, i) => rankRow(r.rank, charMap.get(r.id), `${r.pts}점`, why(r, i))).join('')}
      </ol>` : `<p class="muted center">아직 끝까지 한 사람이 없어요. 첫 번째가 되어 보세요!</p>`}
    </section>
    <section class="card">
      <h2>참여자별 TOP 10</h2>
      ${players.length ? `<p class="muted">이름을 누르면 그 사람의 누적 TOP 10과 판별 기록이 보여요.</p>
      <div class="players">${players.map(playerBlock).join('')}</div>`
        : `<p class="muted">아직 없어요.</p>`}
    </section>
    <section class="card rules">
      <h3>점수 계산</h3>
      <p class="muted">참여자마다 자기 TOP 10에 <b>1위 10점, 2위 9점 … 10위 1점</b>을 주고 모두 더해요. 점수가 같으면 우승 횟수, 그다음 승률 순으로 정해요. 각 캐릭터 아래 <b>몇 위로 몇 번 뽑혔는지</b>와 동점일 때 <b>무엇으로 갈렸는지</b>를 적어 뒀어요. 둘 다 좋아는 반 승, 둘 다 싫어는 패로 쳐요.</p>
    </section>
    <p class="center"><button class="linkbtn" data-reset-rank>🔒 순위 초기화 (관리자)</button></p>`;
}

function playerBlock({ nick, games }) {
  const top = cumulate(games)[0];
  return `
    <details class="player">
      <summary><b>${esc(nick)}</b><span>👑 ${esc(top ? charMap.get(top.id).name : '-')}</span><small>${games.length}판 참여 · 누적 1위</small></summary>
      <div class="cumul">${cumulativeHtml(nick, games)}</div>
      ${games.length > 1 ? `<h3 class="sub">판별 기록</h3>
      <div class="players">${games.slice().reverse().map(gameBlock).join('')}</div>` : ''}
    </details>`;
}

function gameBlock(r) {
  const champ = (r.champions || []).map(id => charMap.get(id)?.name).filter(Boolean).join(', ') || '(삭제된 캐릭터)';
  const ms = r.createdAt?.toMillis?.();
  const when = ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const rows = r.top10.map((id, i) => {
    const c = charMap.get(id);
    if (!c) return '';
    const rank = r.top10pts ? 11 - r.top10pts[i] : i + 1;
    return rankRow(rank, c, '', '');
  }).join('');
  return `
    <details class="player">
      <summary><b>${esc(r.nick || '익명')}</b><span>🏆 ${esc(champ)}</span><small>${r.size}강${when ? " · " + when : ""}</small></summary>
      <ol class="rlist">${rows}</ol>
    </details>`;
}

// ---------- 사진 크게 보기 ----------
// 썸네일을 누르면 화면 가득 고화질로. 아무 데나 누르면 닫힘.
function openZoom(img) {
  const id = img.dataset.zoom;
  const c = id ? charMap.get(id) : null;
  const box = document.createElement('div');
  box.className = 'zoom';
  box.innerHTML = `<img src="${img.getAttribute('src')}" alt="">${c ? `<p>${esc(c.name)}</p>` : ''}<button class="zoom-x" aria-label="닫기">✕</button>`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  if (c) loadFull(id).then(src => { if (src && box.isConnected) box.querySelector('img').src = src; });
}

$app.addEventListener('click', e => {
  const img = e.target.closest('img[data-zoom]');
  if (img) openZoom(img);
});

// ---------- 이벤트 ----------
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

let lastTap = { pick: null, at: 0 };
$app.addEventListener('click', async e => {
  const t = e.target.closest('button, [data-go]');
  if (!t || busy) return;
  const d = t.dataset;

  if (d.go) return setTab(d.go);
  if (d.size) return startGame(Number(d.size));
  if ('resume' in d) {
    const saved = loadProgress();
    if (saved) { game = { ...saved, history: [] }; render(); }
    return;
  }
  if ('discard' in d) { if (confirm('하던 월드컵을 버릴까요?')) { clearProgress(); render(); } return; }
  if (d.pick) {
    // 사진은 두 번 톡톡 눌러야 선택 (스크롤하다 잘못 눌리는 것 방지). 둘 다 좋아/싫어 버튼은 한 번.
    if (d.pick === 'a' || d.pick === 'b') {
      const now = Date.now();
      if (lastTap.pick !== d.pick || now - lastTap.at > 450) {
        lastTap = { pick: d.pick, at: now };
        $app.querySelectorAll('.pick').forEach(p => p.classList.toggle('armed', p === t));
        return;
      }
      lastTap = { pick: null, at: 0 };
    }
    busy = true;
    if (d.pick === 'a' || d.pick === 'b') {
      t.classList.add('chosen');
      $app.querySelector(d.pick === 'a' ? '.pb' : '.pa')?.classList.add('lost');
    } else if (d.pick === 'none') {
      $app.querySelectorAll('.pick').forEach(p => p.classList.add('lost'));
    } else {
      $app.querySelectorAll('.pick').forEach(p => p.classList.add('chosen'));
    }
    await new Promise(r => setTimeout(r, 260));
    choose(d.pick);
    busy = false;
    window.scrollTo(0, 0);
    return render();
  }
  if ('undo' in d) { undo(); return render(); }
  if ('quit' in d) {
    if (confirm('그만할까요? 진행 상황은 저장돼서 나중에 이어할 수 있어요.')) { game = null; render(); }
    return;
  }
  if ('again' in d) { game = null; return render(); }
  if ('reload' in d) { busy = true; try { await loadChars(); } finally { busy = false; } return renderUpload(); }
  if ('refreshRank' in d) { await loadChars(); return renderRank(); }
  if ('resetRank' in d) {
    const pw = prompt('관리자 비밀번호를 입력하세요');
    if (pw === null) return;
    if (!confirm('모두의 TOP 10을 0판부터 다시 시작할까요?\n(캐릭터와 사진은 그대로예요)')) return;
    busy = true;
    try {
      await store.resetRanking(pw);
      toast('전체 순위를 초기화했어요');
    } catch (err) {
      toast(/permission/i.test(err.code || err.message) ? '비밀번호가 틀렸어요' : '초기화 실패: ' + err.message, 4000);
    } finally { busy = false; }
    return renderRank();
  }
  if ('fakeChars' in d || 'fakeResults' in d || 'fakeClear' in d) {
    busy = true;
    try { await testKit('fakeChars' in d ? 'chars' : 'fakeResults' in d ? 'results' : 'clear'); }
    catch (err) { toast(err.message, 4000); }
    finally { busy = false; }
    return;
  }
  if (d.prm) { pending.splice(Number(d.prm), 1); return renderPending(); }
  if ('submit' in d) return submitPending();
  if (d.del) {
    const c = charMap.get(d.del);
    if (!c || !confirm(`"${c.name}"을(를) 삭제할까요?`)) return;
    busy = true;
    try { await store.deleteCharacter(d.del); toast('삭제했어요'); }
    catch (err) { toast('삭제 실패: ' + err.message, 4000); }
    finally { busy = false; }
    await loadChars();
    return renderUpload();
  }
});

$app.addEventListener('input', e => {
  if (e.target.dataset.pname !== undefined) pending[Number(e.target.dataset.pname)].name = e.target.value;
  if (e.target.id === 'search') {
    const q = normName(e.target.value);
    $app.querySelectorAll('.tile').forEach(t => { t.hidden = !!q && !t.dataset.name.includes(q); });
  }
});

$app.addEventListener('change', e => {
  if (e.target.id === 'file' && e.target.files.length) {
    onFiles(e.target.files);
    e.target.value = '';
  }
});

// ---------- 시작 ----------
try {
  store = await createStore();
  if (store.mode === 'local') {
    const m = document.getElementById('mode');
    m.textContent = '체험 모드';
    m.title = 'Firebase 설정 전이라 이 브라우저에만 저장돼요';
    m.hidden = false;
  }
  await loadChars();
  render();
} catch (e) {
  $app.innerHTML = `<section class="card center"><h2>연결에 실패했어요</h2><p class="muted">${esc(e.message)}</p>
    <button class="btn primary" onclick="location.reload()">다시 시도</button></section>`;
}
