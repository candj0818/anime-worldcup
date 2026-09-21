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
function startGame(size) {
  const ids = shuffle(chars.map(c => c.id)).slice(0, size);
  game = { ...newGame(ids), saved: false, history: [] };
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
    store.addResult(resultOf(game)).catch(e => toast('결과 저장 실패: ' + e.message, 4000));
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
      <img src="${c.img}" alt="">
      <span class="rinfo"><b>${esc(c.name)}</b><small>${sub}</small></span>
      <span class="rmain">${main}</span>
    </li>`;
}

function renderResult() {
  const rows = personalRanking(game).filter(r => charMap.has(r.id)).slice(0, 10);
  const champs = game.champions.map(id => charMap.get(id)).filter(Boolean);
  $app.innerHTML = `
    <section class="card champ">
      <p class="crown">🏆 ${champs.length > 1 ? '공동 우승' : '나의 우승'}</p>
      <div class="champ-imgs n${Math.min(champs.length, 2)}">
        ${champs.map(c => `<figure><img src="${bestSrc(c)}" data-full="${esc(c.id)}" alt=""><figcaption>${esc(c.name)}</figcaption></figure>`).join('')}
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
    <div class="row stack">
      <button class="btn primary" data-go="rank">📊 모두의 순위 보기</button>
      <button class="btn ghost" data-again>다시 하기</button>
    </div>`;
  upgradeImages();
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
            <img src="${c.img}" alt="" loading="lazy">
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
          <img src="${p.img}" alt="">
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
    if (!agg.has(id)) agg.set(id, { id, pts: 0, champ: 0, w: 0, d: 0, l: 0 });
    return agg.get(id);
  };
  for (const r of results) {
    (r.top10 || []).forEach((id, i) => { get(id).pts += r.top10pts?.[i] ?? 10 - i; });
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
  top.forEach((r, i) => {
    const p = top[i - 1];
    r.rank = p && p.pts === r.pts && p.champ === r.champ ? p.rank : i + 1;
  });

  $app.innerHTML = `
    <section class="card">
      <div class="listhead">
        <h2>모두의 TOP 10</h2>
        <button class="linkbtn" data-refresh-rank>↻ 새로고침</button>
      </div>
      <p class="muted">지금까지 <b>${results.length}판</b> 완료</p>
      ${top.length ? `<ol class="rlist">
        ${top.map(r => rankRow(r.rank, charMap.get(r.id), `${r.pts}점`,
          `🏆 ${r.champ}회 · 승률 ${Math.round(rate(r) * 100)}%`)).join('')}
      </ol>` : `<p class="muted center">아직 끝까지 한 사람이 없어요. 첫 번째가 되어 보세요!</p>`}
    </section>
    <section class="card rules">
      <h3>점수 계산</h3>
      <p class="muted">참여자마다 자기 TOP 10에 <b>1위 10점, 2위 9점 … 10위 1점</b>을 주고 모두 더해요. 점수가 같으면 우승 횟수, 그다음 승률 순으로 정해요. 둘 다 좋아는 반 승, 둘 다 싫어는 패로 쳐요.</p>
    </section>`;
}

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
