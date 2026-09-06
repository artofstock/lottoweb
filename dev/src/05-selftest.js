/* ============================================================================
 * 05-selftest.js — 공정성 셀프테스트 (카이제곱 검정)
 *
 * 원본: _chi_square / _chi_square_pvalue / _verdict / LottoSelfTest
 *       (원본은 CLI 전용이었다 — `python 로또추첨기.py --selftest 5000`)
 *
 * 원본 대비 통계적으로 고친 두 가지
 * ──────────────────────────────────────────────────────────────────────────
 * ① 6개 동시 추첨의 카이제곱 보정
 *    원본은 "당첨번호 6개 전체" 도수에 자유도 44 카이제곱을 그대로 갖다 댔다.
 *    그런데 한 게임에서 6개는 중복 없이 뽑히므로 번호끼리 음의 상관이 있고,
 *    통계량의 귀무 기댓값이 44가 아니라 39가 된다. 즉 원본 검정은 항상
 *    관대한 쪽으로 틀려서, 실제로 편향이 있어도 놓칠 수 있었다.
 *
 *    정확히 보정된다. k개 중 m개를 비복원 추출할 때
 *        X²  ≈  ((k−m)/(k−1)) · χ²_(k−1)
 *    여기선 k=45, m=6 이므로 계수가 39/44.
 *        X²_보정 = X² × 44/39   →  이 값을 χ²₄₄ 와 비교하면 된다.
 *    (첫 번째로 나온 공만 세는 검정은 m=1이라 계수가 1 — 보정이 필요 없다.
 *     그래서 두 검정을 나란히 보여준다.)
 *
 * ② p-value를 근사가 아니라 제대로 계산
 *    원본은 Wilson–Hilferty 근사를 썼다. 자유도 44에서는 잘 맞지만
 *    구멍 검정(자유도 1 또는 3)에서는 눈에 띄게 어긋난다.
 *    여기서는 정규화 불완전감마함수를 급수/연분수로 직접 계산한다.
 * ========================================================================== */
'use strict';

/* ── 정규화 불완전감마 상위꼬리 Q(a,x) = P(X > x), X ~ Gamma(a,1) ──────────
 * P(χ²_df ≥ x) = Q(df/2, x/2).
 * 수치해석 정석대로 x < a+1 에서는 급수, 그 밖에서는 연분수를 쓴다. */
function logGamma(x) {
  // Lanczos 근사 (g=7, n=9) — 배정밀도에서 유효숫자 15자리
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // 반사 공식 — 작은 인자에서 정밀도 유지
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = C[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  if (x < a + 1) {
    // 급수 전개 P(a,x), Q = 1 - P
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // 연분수 (Lentz 알고리즘)
  const TINY = 1e-300;
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/* P(χ²_df ≥ chi2) */
function chiSquarePValue(chi2, df) {
  if (df <= 0 || chi2 <= 0) return 1;
  return Math.max(0, Math.min(1, gammaQ(df / 2, chi2 / 2)));
}

/* 균등 기대값에 대한 적합도 통계량 Σ(O−E)²/E */
function chiSquare(observed, expected) {
  if (expected <= 0) return 0;
  let s = 0;
  for (const o of observed) { const d = o - expected; s += d * d / expected; }
  return s;
}

/* 판정 — p-value 기준. 원본은 임계값 표를 하드코딩했지만
 * p-value를 정확히 계산할 수 있으므로 표가 필요 없다. */
function verdict(p) {
  if (p >= 0.05) return { level: 'ok', icon: '✅', text: '균등 분포와 통계적으로 구분되지 않음 — 편향 근거 없음' };
  if (p >= 0.01) return { level: 'weak', icon: '🟡', text: '약한 이탈 (p < 0.05) — 표본을 늘려 재확인 권장' };
  if (p >= 0.001) return { level: 'strong', icon: '🟠', text: '유의한 이탈 (p < 0.01) — 편향 의심' };
  return { level: 'severe', icon: '🔴', text: '매우 강한 이탈 (p < 0.001) — 편향 가능성 높음' };
}

/* 비복원 추출 보정계수: k개 중 m개를 뽑을 때 X²의 스케일 (k−m)/(k−1) */
function hypergeoScale(k, m) { return (k - m) / (k - 1); }

/* ── 한 번의 셀프테스트 실행 ───────────────────────────────────────────────
 * onProgress(done, total)는 워커에서 postMessage 폭주를 막기 위해
 * 호출 측에서 스로틀링한다.
 *
 * seed를 주면 그대로 재현된다. 재현할 수 없는 공정성 검증은 검증이 아니다. */
function runSelfTest(opts) {
  const nDraws = Math.max(1, opts.nDraws | 0);
  const holeCount = [1, 2, 4].includes(opts.holeCount) ? opts.holeCount : 1;
  const seed = (opts.seed >>> 0) || 0x9e3779b9;
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const maxTicks = opts.maxTicks || 20000;

  const engine = new LottoEngine({ holeCount, rng: makeRng(seed) });

  const freqAll = new Array(46).fill(0);    // 당첨 6개 전체
  const freqFirst = new Array(46).fill(0);  // 첫 번째로 잡힌 공만 (게임당 1개 → 독립)
  const holeHits = [0, 0, 0, 0];
  let valid = 0, timeouts = 0, ticksSum = 0;
  let stopped = false;

  const t0 = Date.now();
  for (let i = 1; i <= nDraws; i++) {
    if (shouldStop()) { stopped = true; break; }
    const r = engine.runHeadless(maxTicks);
    if (r.timeout) {
      timeouts++;
    } else {
      valid++;
      ticksSum += r.ticks;
      for (const n of r.numbers) freqAll[n]++;
      freqFirst[r.order[0]]++;
      for (const h of r.holes) holeHits[h]++;
    }
    if (i % 50 === 0 || i === nDraws) onProgress(i, nDraws);
  }
  const elapsedMs = Date.now() - t0;

  /* ── 검정 ① 당첨번호 6개 전체 분포 (비복원 보정 적용) ── */
  const obsAll = freqAll.slice(1);
  const expAll = valid * 6 / 45;
  const rawAll = chiSquare(obsAll, expAll);
  const scale = hypergeoScale(45, 6);              // 39/44
  const adjAll = rawAll / scale;                   // χ²₄₄ 와 비교 가능한 값
  const pAll = chiSquarePValue(adjAll, 44);

  /* ── 검정 ② 첫 번째 공 분포 (게임당 1개 → 보정 불필요, 순수 χ²₄₄) ── */
  const obsFirst = freqFirst.slice(1);
  const expFirst = valid / 45;
  const rawFirst = chiSquare(obsFirst, expFirst);
  const pFirst = chiSquarePValue(rawFirst, 44);

  /* ── 검정 ③ 구멍별 포획 분포 ── */
  const activeIdx = HOLE_INDICES[holeCount];
  const obsHole = activeIdx.map(i => holeHits[i]);
  const totalCap = obsHole.reduce((a, b) => a + b, 0);
  const expHole = totalCap / activeIdx.length;
  const dfHole = activeIdx.length - 1;
  const rawHole = dfHole > 0 ? chiSquare(obsHole, expHole) : 0;
  const pHole = dfHole > 0 ? chiSquarePValue(rawHole, dfHole) : 1;

  /* 번호별 표준화 잔차 — 어떤 번호가 얼마나 튀는지 눈으로 보라고.
   * 한 게임에서 6개를 비복원으로 뽑으므로 분산은 N·p(1−p) 이다. */
  const p6 = 6 / 45;
  const sdAll = Math.sqrt(valid * p6 * (1 - p6));
  const z = obsAll.map(o => (sdAll > 0 ? (o - expAll) / sdAll : 0));

  return {
    ok: true,
    stopped,
    holeCount,
    seed,
    nDraws,
    valid,
    timeouts,
    elapsedMs,
    avgTicks: valid ? ticksSum / valid : 0,
    avgSeconds: valid ? (ticksSum / valid) * PHYSICS_STEP_MS / 1000 : 0,
    drawsPerSec: elapsedMs > 0 ? (valid + timeouts) / (elapsedMs / 1000) : 0,
    freqAll: obsAll,
    freqFirst: obsFirst,
    z,
    holeLabels: activeIdx.map(i => HOLE_LABELS[i]),
    holeHits: obsHole,
    tests: {
      all: {
        title: '당첨번호 6개 전체 분포',
        note: '한 게임에서 6개를 중복 없이 뽑으므로 통계량을 44/39 배 보정했습니다.',
        observedMin: Math.min(...obsAll),
        observedMax: Math.max(...obsAll),
        expected: expAll,
        chi2Raw: rawAll,
        chi2: adjAll,
        df: 44,
        p: pAll,
        verdict: verdict(pAll),
      },
      first: {
        title: '첫 번째로 나온 공 분포',
        note: '게임당 1개만 세므로 보정 없이 그대로 χ²₄₄ 검정입니다 — 가장 깨끗한 검정.',
        observedMin: Math.min(...obsFirst),
        observedMax: Math.max(...obsFirst),
        expected: expFirst,
        chi2Raw: rawFirst,
        chi2: rawFirst,
        df: 44,
        p: pFirst,
        verdict: verdict(pFirst),
      },
      hole: dfHole > 0 ? {
        title: '구멍별 포획 분포',
        note: '활성 구멍들이 공을 고르게 나눠 먹는지 봅니다.',
        expected: expHole,
        chi2Raw: rawHole,
        chi2: rawHole,
        df: dfHole,
        p: pHole,
        verdict: verdict(pHole),
      } : null,
    },
  };
}
