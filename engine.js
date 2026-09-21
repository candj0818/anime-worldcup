// 토너먼트 규칙(화면과 무관한 순수 로직). 실제 게임과 테스트용 가짜 참여자가 함께 쓴다.

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function roundLabel(n) {
  if (n === 2) return '결승';
  if (n === 4) return '준결승';
  return `${n}강`;
}

export function newGame(ids) {
  return {
    size: ids.length,
    round: ids, next: [], i: 0, roundNo: 1,
    roundSizes: { 1: ids.length },
    elim: {},                 // id -> 탈락한 라운드 번호 (우승은 999)
    stats: Object.fromEntries(ids.map(id => [id, [0, 0, 0]])), // [승, 무, 패]
    champions: [], done: false
  };
}

// '둘 다 싫어'를 누르면 아무도 안 남는 경우(결승, 또는 이번 라운드 마지막 대결인데 아직 진출자 0명)엔 못 누름
export function canDropBoth(g) {
  return !(g.next.length === 0 && g.i + 2 >= g.round.length);
}

// result: 'a' | 'b' | 'draw'(둘 다 좋아) | 'none'(둘 다 싫어) — 현재 대결(round[i] vs round[i+1])의 결과
export function applyChoice(g, result) {
  const a = g.round[g.i], b = g.round[g.i + 1];
  if (g.tb) return tbChoice(g, result === 'b' ? b : a, result === 'b' ? a : b);
  if (result === 'none') {
    if (!canDropBoth(g)) return;
    g.stats[a][2]++; g.stats[b][2]++;
    g.elim[a] = g.roundNo; g.elim[b] = g.roundNo;
  } else if (result === 'draw') {
    g.next.push(a, b);
    g.stats[a][1]++; g.stats[b][1]++;
  } else {
    const [w, l] = result === 'a' ? [a, b] : [b, a];
    g.next.push(w);
    g.stats[w][0]++; g.stats[l][2]++;
    g.elim[l] = g.roundNo;
  }
  advance(g);
}

// 대결 두 명이 모두 사라졌을 때(삭제됨) 그 대결을 건너뛴다
export function skipPair(g) {
  if (g.tb) { g.i += 2; return tbAfterMatch(g); }
  advance(g);
}

function advance(g) {
  g.i += 2;
  if (g.i + 1 >= g.round.length) endRound(g);
}

function endRound(g) {
  if (g.i < g.round.length) g.next.push(g.round[g.i]); // 홀수면 마지막 한 명은 부전승
  const prevLen = g.round.length;
  // 결승에서 무승부면 공동 우승
  if (g.next.length <= 1 || (prevLen === 2 && g.next.length === 2)) {
    g.champions = g.next;
    g.champions.forEach(id => { g.elim[id] = 999; });
    startTiebreak(g);
    return;
  }
  g.round = shuffle(g.next);
  g.next = [];
  g.i = 0;
  g.roundNo++;
  g.roundSizes[g.roundNo] = g.round.length;
}

// ---------- 동점 결정전 ----------
// 토너먼트가 끝났을 때 나의 TOP 10 안에 동점이 있으면, 동점인 캐릭터끼리 1:1로 더 붙여서 10위까지 정확히 가린다.
// (공동 우승은 결승에서 직접 고른 것이라 그대로 둔다)
// 각 동점 그룹에서 '남은 후보 중 1등'을 미니 토너먼트로 뽑고, 다음 1등은 아직 남은 후보에게 진 적 없는 캐릭터끼리만 다시 붙인다.
function startTiebreak(g) {
  const rows = baseRows(g);
  const groups = [];
  for (let p = 0; p < rows.length && p < 10;) {
    let q = p;
    while (q + 1 < rows.length && sameBase(rows[q + 1], rows[p])) q++;
    const len = q - p + 1;
    if (len > 1 && rows[p].elim !== 999) groups.push({ ids: rows.slice(p, q + 1).map(r => r.id), need: Math.min(len - 1, 10 - p), from: p + 1 });
    p = q + 1;
  }
  g.tbRank = {};
  if (!groups.length) { g.done = true; return; }
  g.tb = { groups, gi: 0, matches: 0 };
  tbStartGroup(g);
}

function tbStartGroup(g) {
  const grp = g.tb.groups[g.tb.gi];
  g.tb.pool = [...grp.ids]; g.tb.order = []; g.tb.lostTo = {};
  tbNextSelection(g);
}

function tbNextSelection(g) {
  const t = g.tb, pool = t.pool;
  const cand = pool.filter(x => !(t.lostTo[x] || []).some(w => pool.includes(w)));
  if (cand.length === 1) return tbPicked(g, cand[0]);
  g.round = shuffle(cand); g.next = []; g.i = 0;
}

function tbChoice(g, w, l) {
  (g.tb.lostTo[l] ||= []).push(w);
  g.next.push(w);
  g.i += 2; g.tb.matches++;
  tbAfterMatch(g);
}

function tbAfterMatch(g) {
  if (g.i + 1 < g.round.length) return;
  if (g.i < g.round.length) g.next.push(g.round[g.i]);
  if (g.next.length === 1) return tbPicked(g, g.next[0]);
  if (!g.next.length) return tbNextSelection(g);
  g.round = shuffle(g.next); g.next = []; g.i = 0;
}

function tbPicked(g, id) {
  const t = g.tb, grp = t.groups[t.gi];
  t.order.push(id);
  t.pool = t.pool.filter(x => x !== id);
  if (t.order.length < grp.need) return tbNextSelection(g);
  t.order.forEach((x, i) => { g.tbRank[x] = i; });
  if (t.pool.length === 1) g.tbRank[t.pool[0]] = t.order.length; // 마지막 한 명은 자동으로 정해짐
  t.gi++;
  if (t.gi < t.groups.length) return tbStartGroup(g);
  delete g.tb;
  g.round = []; g.next = []; g.i = 0;
  g.done = true;
}

// 남은 동점 결정전 대결 수를 대략 보여주기 위한 정보
export function tiebreakInfo(g) {
  if (!g.tb) return null;
  const grp = g.tb.groups[g.tb.gi];
  return { from: grp.from, to: grp.from + grp.ids.length - 1, size: grp.ids.length, place: grp.from + g.tb.order.length };
}

// 탈락 라운드가 늦을수록 → 승 많을수록 → 무 많을수록 → 패 적을수록 상위
function baseRows(g) {
  const rows = Object.keys(g.stats).map(id => ({ id, elim: g.elim[id] ?? g.roundNo, s: g.stats[id] }));
  rows.sort((x, y) => y.elim - x.elim || y.s[0] - x.s[0] || y.s[1] - x.s[1] || x.s[2] - y.s[2]);
  return rows;
}
const sameBase = (x, y) => x.elim === y.elim && x.s[0] === y.s[0] && x.s[1] === y.s[1] && x.s[2] === y.s[2];

// 위 기준이 같으면 동점 결정전 결과 순. 결정전을 안 한 동점끼리는 같은 순위.
export function personalRanking(g) {
  const tb = g.tbRank || {};
  const tbv = r => tb[r.id] ?? Infinity;
  const rows = baseRows(g);
  rows.sort((x, y) => y.elim - x.elim || y.s[0] - x.s[0] || y.s[1] - x.s[1] || x.s[2] - y.s[2] || (tbv(x) === tbv(y) ? 0 : tbv(x) < tbv(y) ? -1 : 1));
  const same = (x, y) => sameBase(x, y) && tbv(x) === tbv(y);
  rows.forEach((r, i) => { r.rank = i > 0 && same(r, rows[i - 1]) ? rows[i - 1].rank : i + 1; });
  return rows;
}

// 저장할 결과 요약
export function resultOf(g) {
  return {
    size: g.size,
    champions: g.champions,
    top10: personalRanking(g).slice(0, 10).map(r => r.id),
    top10pts: personalRanking(g).slice(0, 10).map(r => 11 - r.rank), // 같은 순위(공동 우승 등)는 같은 점수
    stats: g.stats
  };
}
