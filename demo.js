// 체험 모드 전용 테스트 데이터: 가짜 캐릭터와 가짜 참여자 결과.
import { shuffle, newGame, applyChoice, resultOf } from './engine.js';

const FIRST = ['하', '유', '미', '레', '아', '사', '카', '나', '리', '치', '코', '루', '시', '에', '모', '토', '키', '네', '소', '라'];
const LAST = ['나', '코', '리', '미', '카', '토', '네'];
const HAIR_STYLES = 4;

function avatar(i) {
  const bg = (i * 47) % 360;
  const hair = `hsl(${(i * 97 + 20) % 360},${45 + (i % 3) * 15}%,${30 + (i % 5) * 9}%)`;
  const eye = `hsl(${(i * 131) % 360},70%,42%)`;
  const cloth = `hsl(${(i * 61 + 180) % 360},55%,45%)`;
  const style = i % HAIR_STYLES;
  const longHair = style < 2 ? `<rect x="52" y="170" width="196" height="200" rx="60" fill="${hair}"/>` : '';
  const twin = style === 2
    ? `<ellipse cx="45" cy="230" rx="30" ry="80" fill="${hair}"/><ellipse cx="255" cy="230" rx="30" ry="80" fill="${hair}"/>` : '';
  const bangs = style === 3
    ? `<path d="M68 190 Q70 90 150 88 Q232 90 232 190 Q205 140 150 150 Q98 140 68 190Z" fill="${hair}"/>`
    : `<path d="M66 200 Q60 86 150 84 Q240 86 234 200 L214 150 L190 170 L175 135 L150 165 L125 135 L110 170 L86 150Z" fill="${hair}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${bg},75%,80%)"/><stop offset="1" stop-color="hsl(${(bg + 50) % 360},70%,60%)"/></linearGradient></defs>
<rect width="300" height="400" fill="url(#g)"/>
${longHair}${twin}
<ellipse cx="150" cy="130" rx="92" ry="80" fill="${hair}"/>
<path d="M40 400 Q50 300 150 292 Q250 300 260 400Z" fill="${cloth}"/>
<rect x="132" y="250" width="36" height="50" fill="#f7d4c2"/>
<ellipse cx="150" cy="190" rx="78" ry="86" fill="#ffe4d6"/>
${bangs}
<ellipse cx="118" cy="200" rx="15" ry="21" fill="${eye}"/><ellipse cx="182" cy="200" rx="15" ry="21" fill="${eye}"/>
<circle cx="113" cy="192" r="6" fill="#fff"/><circle cx="177" cy="192" r="6" fill="#fff"/>
<ellipse cx="100" cy="228" rx="13" ry="6" fill="#ff9fb0" opacity=".6"/><ellipse cx="200" cy="228" rx="13" ry="6" fill="#ff9fb0" opacity=".6"/>
<path d="M140 240 Q150 ${248 + (i % 3) * 3} 160 240" stroke="#c0506a" stroke-width="3" fill="none" stroke-linecap="round"/>
<text x="16" y="34" font-family="sans-serif" font-size="22" font-weight="700" fill="rgba(0,0,0,.45)">#${i + 1}</text>
</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function makeFakeCharacters(n = 140) {
  return Array.from({ length: n }, (_, i) => ({
    name: `${FIRST[i % FIRST.length]}${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? i : ''}`,
    img: avatar(i)
  }));
}

// 캐릭터마다 숨은 인기도를 주고, 참여자마다 취향 차이를 더해 월드컵을 끝까지 자동으로 진행한다.
export function simulateResults(chars, players = 30, drawRate = 0.12) {
  const ids = chars.map(c => c.id);
  const pop = Object.fromEntries(ids.map(id => [id, Math.random() * 3]));
  const sizes = [16, 32, 64, 128, ids.length].filter(s => s <= ids.length);
  const results = [];
  for (let p = 0; p < players; p++) {
    const taste = Object.fromEntries(ids.map(id => [id, pop[id] + Math.random() * 1.5]));
    const g = newGame(shuffle([...ids]).slice(0, sizes[Math.floor(Math.random() * sizes.length)]));
    while (!g.done) {
      const a = g.round[g.i], b = g.round[g.i + 1];
      if (Math.random() < drawRate) { applyChoice(g, 'draw'); continue; }
      const pa = Math.exp(taste[a]) / (Math.exp(taste[a]) + Math.exp(taste[b]));
      applyChoice(g, Math.random() < pa ? 'a' : 'b');
    }
    results.push({ ...resultOf(g), nick: ["벚꽃러버", "민수", "지영", "하루"][p % 4] });
  }
  return results;
}
