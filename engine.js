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
    g.done = true;
    g.champions = g.next;
    g.champions.forEach(id => { g.elim[id] = 999; });
    return;
  }
  g.round = shuffle(g.next);
  g.next = [];
  g.i = 0;
  g.roundNo++;
  g.roundSizes[g.roundNo] = g.round.length;
}

// 탈락 라운드가 늦을수록 → 승 많을수록 → 무 많을수록 → 패 적을수록 상위
export function personalRanking(g) {
  const rows = Object.keys(g.stats).map(id => ({ id, elim: g.elim[id] ?? g.roundNo, s: g.stats[id] }));
  rows.sort((x, y) => y.elim - x.elim || y.s[0] - x.s[0] || y.s[1] - x.s[1] || x.s[2] - y.s[2]);
  const same = (x, y) => x.elim === y.elim && x.s[0] === y.s[0] && x.s[1] === y.s[1] && x.s[2] === y.s[2];
  rows.forEach((r, i) => { r.rank = i > 0 && same(r, rows[i - 1]) ? rows[i - 1].rank : i + 1; });
  return rows;
}

// 저장할 결과 요약
export function resultOf(g) {
  return {
    size: g.size,
    champions: g.champions,
    top10: personalRanking(g).slice(0, 10).map(r => r.id),
    stats: g.stats
  };
}
