/* ============================================================================
 * verify.js — 배포 전 자동 검증
 *
 *   node verify.js
 *
 * 브라우저 없이 돌 수 있는 것을 전부 여기서 검사한다.
 * 물리·필터·등수·통계는 순수 함수라 DOM 없이 그대로 실행된다.
 * 실패가 하나라도 있으면 종료코드 1 — 그대로 배포 스크립트에 물릴 수 있다.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// 워커와 공유되는 코어만 모아 평가한다 (DOM 의존 코드는 넣지 않는다)
const core = ['01-physics.js', '03-state.js', '04-filter.js', '05-selftest.js']
  .map(read).join('\n');

global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const M = new Function('localStorage', core + `
return {LottoEngine,makeRng,HOLE_CENTERS_4,HOLE_INDICES,HOLE_LABELS,STAGE_W,STAGE_H,
  BALL_R,HOLE_R,PHYSICS_STEP_MS,ballColor,combStats,checkRank,normalizeFilter,
  filterAccepts,filterReject,analyzeFilter,isFilterTrivial,runSelfTest,
  chiSquarePValue,hypergeoScale,sanitizeSuffix};`)(global.localStorage);

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
};
const H = (t) => console.log('\n=== ' + t + ' ===');

/* ── 1. 원본과 같은 기하·상수 ─────────────────────────────────────────── */
H('[1] 기하 · 상수 (원본 대조)');
T('무대 1430x1050', M.STAGE_W === 1430 && M.STAGE_H === 1050);
T('BALL_R 32 / HOLE_R 36', M.BALL_R === 32 && M.HOLE_R === 36);
T('물리 틱 28ms', M.PHYSICS_STEP_MS === 28);
T('구멍 좌표', JSON.stringify(M.HOLE_CENTERS_4) === '[[54,54],[1376,54],[54,996],[1376,996]]',
  JSON.stringify(M.HOLE_CENTERS_4));
T('구멍모드 1/2/4 매핑', JSON.stringify(M.HOLE_INDICES) === '{"1":[1],"2":[1,2],"4":[0,1,2,3]}');
T('공 색상 5구간', [1, 11, 21, 31, 41].map(M.ballColor).join(',')
  === '#FF6B6B,#4FC3F7,#FFD54F,#81C784,#CE93D8');
{
  // v1.9.6 공정성 불변식: 스폰 사각형에서 모든 구멍까지 최단거리가 38px로 같다
  let best = Infinity;
  for (const [hx, hy] of M.HOLE_CENTERS_4)
    for (let x = 37; x <= 1393; x++)
      for (const y of [92, 958]) best = Math.min(best, Math.hypot(hx - x, hy - y));
  T('스폰->구멍 최단거리 38px', Math.abs(best - 38) < 1e-9, best.toFixed(3) + 'px');
}

/* ── 2. 물리 공정성 ───────────────────────────────────────────────────── */
H('[2] 물리 공정성 (구멍모드별 1,200판)');
for (const hc of [1, 2, 4]) {
  const e = new M.LottoEngine({ holeCount: hc, rng: M.makeRng(20260906) });
  const N = 1200, freq = new Array(46).fill(0), holes = [0, 0, 0, 0];
  let to = 0, ticks = 0, dup = 0, short = 0;
  for (let i = 0; i < N; i++) {
    const r = e.runHeadless();
    if (r.timeout) to++;
    if (r.numbers.length !== 6) short++;
    if (new Set(r.numbers).size !== 6) dup++;
    for (const n of r.numbers) freq[n]++;
    for (const h of r.holes) holes[h]++;
    ticks += r.ticks;
  }
  const exp = N * 6 / 45;
  let x2 = 0;
  for (let n = 1; n <= 45; n++) { const d = freq[n] - exp; x2 += d * d / exp; }
  const adj = x2 / M.hypergeoScale(45, 6);
  const p = M.chiSquarePValue(adj, 44);
  const act = M.HOLE_INDICES[hc];
  const hh = act.map(i => holes[i]);
  const he = hh.reduce((a, b) => a + b, 0) / hh.length;
  const hx2 = hh.reduce((s, v) => s + (v - he) ** 2 / he, 0);
  const hp = act.length > 1 ? M.chiSquarePValue(hx2, act.length - 1) : 1;

  console.log(`  구멍${hc}: 평균 ${(ticks / N * 28 / 1000).toFixed(1)}초/판 · ` +
    `번호 X²보정 ${adj.toFixed(1)} p=${p.toFixed(3)} · 구멍 p=${hp.toFixed(3)} [${hh.join(', ')}]`);
  T(`구멍${hc} 중복/미달/타임아웃 0`, dup === 0 && short === 0 && to === 0,
    `dup=${dup} short=${short} timeout=${to}`);
  T(`구멍${hc} 번호분포 균등 (p>=0.01)`, p >= 0.01, `p=${p.toFixed(4)}`);
  T(`구멍${hc} 구멍분포 균등 (p>=0.01)`, hp >= 0.01, `p=${hp.toFixed(4)}`);
}

/* 단일 표본의 p-value 하나로는 편향을 판정할 수 없다 (5%는 원래 0.05 아래로
 * 떨어진다). 시드를 바꿔가며 여러 번 재고, p-value들이 균등분포를 따르는지
 * 본다 — 물리가 편향돼 있다면 p들이 0 쪽으로 쏠린다. */
H('[2b] 다중 시드 p-value 균등성 (구멍4 · 12시드 x 800판)');
{
  const ps = [];
  for (let s = 0; s < 12; s++) {
    const e = new M.LottoEngine({ holeCount: 4, rng: M.makeRng(1000 + s * 7919) });
    const freq = new Array(46).fill(0);
    const N = 800;
    for (let i = 0; i < N; i++) { const r = e.runHeadless(); for (const n of r.numbers) freq[n]++; }
    const exp = N * 6 / 45;
    let x2 = 0;
    for (let n = 1; n <= 45; n++) { const d = freq[n] - exp; x2 += d * d / exp; }
    ps.push(M.chiSquarePValue(x2 / M.hypergeoScale(45, 6), 44));
  }
  ps.sort((a, b) => a - b);
  const below05 = ps.filter(p => p < 0.05).length;
  const median = ps[Math.floor(ps.length / 2)];
  console.log('  p-values: ' + ps.map(p => p.toFixed(3)).join(', '));
  T('12개 중 p<0.05 가 3개 이하 (기대 0~1)', below05 <= 3, `${below05}개`);
  T('중앙값이 0.2~0.8 (균등분포다움)', median > 0.2 && median < 0.8, median.toFixed(3));
}

/* ── 3. 시드 재현성 (조건 필터가 정직한 근거) ─────────────────────────── */
H('[3] 시드 재현성');
for (const hc of [1, 2, 4]) {
  const S = 987654321;
  const a = new M.LottoEngine({ holeCount: hc, rng: M.makeRng(S) }).runHeadless();
  const b = new M.LottoEngine({ holeCount: hc, rng: M.makeRng(S) }).runHeadless();
  const c = new M.LottoEngine({ holeCount: hc, rng: M.makeRng(S + 1) }).runHeadless();
  T(`구멍${hc} 같은시드=같은결과(틱까지)`,
    JSON.stringify(a.order) === JSON.stringify(b.order) && a.ticks === b.ticks);
  T(`구멍${hc} 다른시드=다른결과`, JSON.stringify(a.numbers) !== JSON.stringify(c.numbers));
}
{
  /* 화면은 프레임마다 도는 틱 수가 들쭉날쭉하다. 그래도 헤드리스와 결과가
   * 같아야 "찾은 시드를 화면에서 그대로 재생한다"는 주장이 성립한다. */
  const S = 13579;
  const head = new M.LottoEngine({ holeCount: 4, rng: M.makeRng(S) }).runHeadless();
  const e = new M.LottoEngine({ holeCount: 4, rng: M.makeRng(S) });
  e.resetDraw(); e.createAllBalls();
  const batch = [1, 3, 5, 7, 2, 8, 4];
  let t = 0, bi = 0;
  while (e.drawnNumbers.length < 6 && t < 20000) {
    const k = batch[bi++ % batch.length];
    for (let j = 0; j < k && e.drawnNumbers.length < 6; j++) { e.step(); t++; }
  }
  T('프레임 배칭이 달라도 동일 (틱수까지)',
    JSON.stringify(head.order) === JSON.stringify(e.drawnNumbers) && head.ticks === t,
    `헤드리스 ${head.ticks}틱 / 화면 ${t}틱`);
}

/* ── 4. 등수 판정 ─────────────────────────────────────────────────────── */
H('[4] 당첨 등수 판정');
{
  const W = [1, 2, 3, 4, 5, 6], B = 7;
  const cases = [
    [[1, 2, 3, 4, 5, 6], '1등', false], [[1, 2, 3, 4, 5, 7], '2등', true],
    [[1, 2, 3, 4, 5, 8], '3등', false], [[1, 2, 3, 4, 8, 9], '4등', false],
    [[1, 2, 3, 4, 7, 9], '4등', true],  [[1, 2, 3, 8, 9, 10], '5등', false],
    [[1, 2, 3, 7, 9, 10], '5등', true], [[1, 2, 8, 9, 10, 11], '낙첨', false],
    [[1, 2, 7, 9, 10, 11], '낙첨', true],
  ];
  let ok = true;
  for (const [p, exp, expB] of cases) {
    const r = M.checkRank(p, W, B);
    if (r.label !== exp || r.bonusPicked !== expB) {
      ok = false; console.log(`    !! [${p}] -> ${r.label}/${r.bonusPicked}, 기대 ${exp}/${expB}`);
    }
  }
  T('9개 경계 케이스 전부 정확', ok);
  T('보너스가 당첨6개에 섞인 오염데이터 방어', M.checkRank([1, 2, 3, 4, 5, 9], W, 3).label === '3등');
  T('보너스 범위 밖 방어', M.checkRank([1, 2, 3, 4, 5, 9], W, 99).label === '3등');
}

/* ── 5. 조건 필터 판정을 전수 열거와 대조 ─────────────────────────────── */
H('[5] 조건 필터 판정 (C(45,6) 전수 열거 대조)');
{
  const tests = {
    'odd=0': [{ oddMin: 0, oddMax: 0 }, 0.916], 'odd=3': [{ oddMin: 3, oddMax: 3 }, 33.485],
    'odd=6': [{ oddMin: 6, oddMax: 6 }, 1.239], 'sum130-145': [{ sumMin: 130, sumMax: 145 }, 20.540],
    'sum100-175': [{ sumMin: 100, sumMax: 175 }, 78.963], 'sum21-50': [{ sumMin: 21, sumMax: 50 }, 0.090],
    'maxRun<=1': [{ maxRun: 1 }, 47.125], 'maxRun<=2': [{ maxRun: 2 }, 94.372],
    'maxRun<=3': [{ maxRun: 3 }, 99.597], 'bandMax<=2': [{ bandMax: 2 }, 54.708],
    'bandMax<=3': [{ bandMax: 3 }, 93.372], 'bandMax<=4': [{ bandMax: 4 }, 99.556],
    'fix1': [{ include: [7] }, 13.333], 'fix3': [{ include: [7, 20, 33] }, 0.141],
    'excl1-20': [{ exclude: Array.from({ length: 20 }, (_, i) => i + 1) }, 2.174],
  };
  const norm = {}, cnt = {};
  for (const k in tests) { norm[k] = M.normalizeFilter(tests[k][0]); cnt[k] = 0; }
  let total = 0;
  const a = new Array(6);
  for (a[0] = 1; a[0] <= 40; a[0]++) for (a[1] = a[0] + 1; a[1] <= 41; a[1]++)
  for (a[2] = a[1] + 1; a[2] <= 42; a[2]++) for (a[3] = a[2] + 1; a[3] <= 43; a[3]++)
  for (a[4] = a[3] + 1; a[4] <= 44; a[4]++) for (a[5] = a[4] + 1; a[5] <= 45; a[5]++) {
    total++;
    for (const k in norm) if (M.filterAccepts(a, norm[k])) cnt[k]++;
  }
  T('전수 조합 수 8,145,060', total === 8145060, total.toLocaleString());
  let allok = true;
  for (const k in cnt) {
    const p = cnt[k] / total * 100, ref = tests[k][1];
    if (Math.abs(p - ref) > 0.02) { allok = false; console.log(`    !! ${k}: ${p.toFixed(3)}% vs 참값 ${ref}%`); }
  }
  T('15개 조건 술어가 전수 참값과 일치', allok);

  // 통과율 추정이 참값에 얼마나 가까운가
  const ex = (f) => {
    f = M.normalizeFilter(f);
    let c = 0, t = 0;
    const b = new Array(6);
    for (b[0] = 1; b[0] <= 40; b[0]++) for (b[1] = b[0] + 1; b[1] <= 41; b[1]++)
    for (b[2] = b[1] + 1; b[2] <= 42; b[2]++) for (b[3] = b[2] + 1; b[3] <= 43; b[3]++)
    for (b[4] = b[3] + 1; b[4] <= 44; b[4]++) for (b[5] = b[4] + 1; b[5] <= 45; b[5]++) {
      t++; if (M.filterAccepts(b, f)) c++;
    }
    return c / t;
  };
  const cs = {
    '제외1~20': { exclude: Array.from({ length: 20 }, (_, i) => i + 1) },
    '제외1~20+홀3': { exclude: Array.from({ length: 20 }, (_, i) => i + 1), oddMin: 3, oddMax: 3 },
    '고정수2개': { include: [7, 14] },
    '연속금지+구간2': { maxRun: 1, bandMax: 2 },
    '합계130-145': { sumMin: 130, sumMax: 145 },
  };
  let worst = 0;
  for (const k in cs) {
    const e = ex(cs[k]), an = M.analyzeFilter(cs[k]);
    const est = an.ok ? an.rate : 0;
    const err = Math.abs(est / e - 1) * 100;
    worst = Math.max(worst, err);
    console.log(`  ${k.padEnd(16)} 참값 1/${(1 / e).toFixed(1).padStart(7)} · ` +
      `추정 1/${(1 / est).toFixed(1).padStart(7)} · 오차 ${err.toFixed(1)}%`);
  }
  T('통과율 추정 오차 15% 이내', worst < 15, `최대 ${worst.toFixed(1)}%`);
}

/* ── 6. 조건 필터 방어 ────────────────────────────────────────────────── */
H('[6] 조건 필터 방어 (불가능·위험 조건)');
{
  const bad = [
    ['고정수 6개 (사전확정)', { include: [1, 2, 3, 4, 5, 6] }],
    ['제외수 40개', { exclude: Array.from({ length: 40 }, (_, i) => i + 1) }],
    ['고정10,11,12 + 연속2이하', { include: [10, 11, 12], maxRun: 2 }],
    ['고정 홀5개 + 홀0개', { include: [1, 3, 5, 7, 9], oddMax: 0 }],
    ['고정5개 + 합21~25', { include: [10, 20, 30, 40, 45], sumMin: 21, sumMax: 25 }],
  ];
  let ok = true;
  for (const [n, f] of bad) {
    const a = M.analyzeFilter(f);
    if (a.ok) { ok = false; console.log('    !! 통과시킴: ' + n); }
  }
  T('불가능한 조건 5종 전부 차단', ok);

  /* 예전 몬테카를로는 이 둘을 "불가능"이라고 잘못 판정했다 (히트 0).
   * 실제로는 가능하고 아주 희박할 뿐이라, 이제 전수 계산으로 정확히 센다. */
  {
    const a = M.analyzeFilter({ include: [1, 2, 3], sumMax: 30 });
    T('희박하지만 가능한 조건을 차단하지 않음', a.ok && a.exact, `ok=${a.ok} exact=${a.exact}`);
    T('  그 통과율이 전수 참값과 일치', Math.abs(1 / a.rate - 153680) < 1, (1 / a.rate).toFixed(0));
    const b = M.analyzeFilter({ include: [3, 17, 28, 41, 45] });
    T('고정수 5개(앱 최대치)를 차단하지 않음', b.ok && b.exact, `ok=${b.ok} exact=${b.exact}`);
    T('  그 통과율도 참값과 일치', Math.abs(1 / b.rate - 203627) < 1, (1 / b.rate).toFixed(0));
  }
  T('고정수 5개로 제한', M.normalizeFilter({ include: [1, 2, 3, 4, 5, 6] }).include.length === 5);
  T('bandMax 하한 2 (비둘기집)', M.normalizeFilter({ bandMax: 1 }).bandMax === 2);
  T('고정수∩제외수 -> 고정수 우선',
    M.normalizeFilter({ include: [7], exclude: [7, 8] }).exclude.join(',') === '8');
  T('하한>상한이면 교환', M.normalizeFilter({ sumMin: 200, sumMax: 100 }).sumMin === 100);
  T('직전회차 6개 아니면 무시',
    M.filterReject([1, 2, 3, 4, 5, 6], M.normalizeFilter({ prevOverlapMax: 0, prevNumbers: [1, 2, 3] })) === null);
  T('직전회차 6개면 적용',
    M.filterReject([1, 2, 3, 4, 5, 6], M.normalizeFilter({ prevOverlapMax: 0, prevNumbers: [1, 2, 3, 7, 8, 9] })) !== null);
  T('빈 필터는 자명(탐색 건너뜀)', M.isFilterTrivial({}) === true);
}

/* ── 7. 카이제곱 수학 ─────────────────────────────────────────────────── */
H('[7] 카이제곱 수학');
{
  const ref = [[44, 60.481, 0.05], [44, 68.710, 0.01], [1, 3.8415, 0.05],
               [3, 7.8147, 0.05], [3, 16.2662, 0.001], [10, 2.5, 0.9910]];
  let ok = true;
  for (const [df, x, e] of ref) {
    const p = M.chiSquarePValue(x, df);
    if (Math.abs(p - e) > 5e-4) { ok = false; console.log(`    !! df=${df} x=${x}: ${p} vs ${e}`); }
  }
  T('p-value 정확 (scipy 참값 대비 5e-4 이내)', ok);
  T('비복원 보정계수 = 39/44', Math.abs(M.hypergeoScale(45, 6) - 39 / 44) < 1e-12);
  T('1개 추출은 보정 불필요', M.hypergeoScale(45, 1) === 1);

  /* 이상적 균등 추첨을 직접 만들어, 원본 방식이 관대하고 보정본이 맞는지 확인 */
  const rng = M.makeRng(4242);
  const pool = []; for (let i = 1; i <= 45; i++) pool.push(i);
  const draw = () => {
    for (let i = 0; i < 6; i++) {
      const j = rng.randint(i, 44);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, 6);
  };
  const S = M.hypergeoScale(45, 6);
  const raws = [], adjs = [];
  for (let t = 0; t < 800; t++) {
    const f = new Array(46).fill(0);
    for (let g = 0; g < 1500; g++) for (const n of draw()) f[n]++;
    const E = 1500 * 6 / 45;
    let x2 = 0;
    for (let n = 1; n <= 45; n++) { const d = f[n] - E; x2 += d * d / E; }
    raws.push(x2); adjs.push(x2 / S);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rej = (a, c) => a.filter(v => v > c).length / a.length * 100;
  console.log(`  원본 방식: 평균 ${mean(raws).toFixed(2)} (이론 39) · 기각률 ${rej(raws, 60.481).toFixed(2)}%`);
  console.log(`  보정  후: 평균 ${mean(adjs).toFixed(2)} (이론 44) · 기각률 ${rej(adjs, 60.481).toFixed(2)}%`);
  T('보정후 평균 ~44', Math.abs(mean(adjs) - 44) < 1.5, mean(adjs).toFixed(2));
  T('보정후 기각률 ~5%', Math.abs(rej(adjs, 60.481) - 5) < 2.5, rej(adjs, 60.481).toFixed(2) + '%');
  T('원본 방식이 관대함을 재현', rej(raws, 60.481) < 2.5, rej(raws, 60.481).toFixed(2) + '%');
}

/* ── 8. 셀프테스트 통합 ───────────────────────────────────────────────── */
H('[8] 셀프테스트 통합');
{
  const r = M.runSelfTest({ nDraws: 400, holeCount: 4, seed: 777 });
  T('유효 400판 · 타임아웃 0', r.valid === 400 && r.timeouts === 0);
  T('검정 3종 생성', !!r.tests.all && !!r.tests.first && !!r.tests.hole);
  T('6개전체 검정에 44/39 보정 적용',
    Math.abs(r.tests.all.chi2 - r.tests.all.chi2Raw / M.hypergeoScale(45, 6)) < 1e-9);
  T('첫공 검정은 보정 없음', r.tests.first.chi2 === r.tests.first.chi2Raw);
  T('구멍 라벨 정확', r.holeLabels.join(',') === '좌상,우상,좌하,우하');
  T('같은 시드 재현', JSON.stringify(M.runSelfTest({ nDraws: 400, holeCount: 4, seed: 777 }).freqAll)
    === JSON.stringify(r.freqAll));
  const r1 = M.runSelfTest({ nDraws: 100, holeCount: 1, seed: 777 });
  T('1구멍이면 구멍검정 없음 (df=0)', r1.tests.hole === null);
  console.log(`  4구멍 400판: 6개전체 p=${r.tests.all.p.toFixed(3)} · ` +
    `첫공 p=${r.tests.first.p.toFixed(3)} · 구멍 p=${r.tests.hole.p.toFixed(3)}`);
}

/* ── 9. 조합 통계 · 파일명 ────────────────────────────────────────────── */
H('[9] 조합 통계 · 파일명');
{
  const s = M.combStats([6, 41, 1, 22, 39]);
  T('부분조합 홀짝 정확 (6 고정 아님)', s.count === 5 && s.odd === 3 && s.even === 2,
    `n=${s.count} 홀${s.odd}:짝${s.even}`);
  const f = M.combStats([1, 2, 3, 4, 5, 6]);
  T('연속 6 감지', f.maxRun === 6);
  T('합계 21 · 끝수합 21', f.sum === 21 && f.tailSum === 21);
  T('구간 분포', JSON.stringify(M.combStats([1, 11, 21, 31, 41, 45]).bands) === '[1,1,1,1,2]');
  T('파일명 안전화', M.sanitizeSuffix(' 2차/테스트:1 ') === '2차테스트1', M.sanitizeSuffix(' 2차/테스트:1 '));
}

/* ── 10. 빌드 산출물 ──────────────────────────────────────────────────── */
H('[10] 빌드 산출물');
{
  const dist = path.join(__dirname, 'dist', 'index.html');
  T('dist/index.html 존재', fs.existsSync(dist));
  if (fs.existsSync(dist)) {
    const html = fs.readFileSync(dist, 'utf8');
    const ext = html.match(/(?:src|href)="https?:\/\/[^"]*"/g) || [];
    T('외부 참조 0건 (완전 자립)', ext.length === 0, ext.join(' '));
    /* 실제 <script> 태그만 센다. 08-app.js 주석 안에 이 태그를 설명하는
     * 문장이 있어서, 단순히 id="core-src" 문자열을 세면 2가 나온다. */
    T('코어 스크립트 태그 1개만 존재',
      (html.match(/<script id="core-src"/g) || []).length === 1);
    T('워커 글루 존재', html.includes('id="worker-glue"'));
    T('닫는 script 태그가 문자열에 없음', !/<\/script/i.test(
      html.slice(html.indexOf('id="core-src"'), html.lastIndexOf('</script>'))
        .replace(/<\/script>/g, '')));
    T('통계 막대에 display:block (인라인 버그 재발 방지)',
      /\.freq-row \.bar \{[^}]*display:\s*block/.test(html));
    T('[hidden] 강제 규칙 존재', html.includes('[hidden] { display: none !important; }'));
  }
}

console.log('\n' + '='.repeat(64));
console.log(`  통과 ${pass}건 · 실패 ${fail}건`);
console.log('='.repeat(64) + '\n');
process.exit(fail ? 1 : 0);
