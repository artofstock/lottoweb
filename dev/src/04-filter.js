/* ============================================================================
 * 04-filter.js — 조건 필터 (웹판 신규 기능)
 *
 * 원본에는 없다. 사용자가 건 조건을 만족하는 조합이 나올 때까지 추첨을
 * 다시 돌리는 기능이다.
 *
 * ── 순수성을 지키는 방식 ────────────────────────────────────────────────
 * 공에 가중치를 주거나 특정 번호를 유도하지 않는다. 물리는 손대지 않는다.
 * 조건에 맞지 않는 "추첨 한 판 전체"를 통째로 버릴 뿐이다.
 * 이건 통계학에서 기각 표집(rejection sampling)이라 부르는 방법이고,
 * 결과 분포는 "조건을 만족하는 모든 조합 위의 균등분포"가 된다.
 * 즉 조건을 통과하는 조합끼리는 여전히 완벽히 동등하다.
 *
 * ── 화면에 쓰면 안 되는 문장 ────────────────────────────────────────────
 * "조건을 걸어도 번호별 확률은 그대로다" — 이건 거짓이다.
 * 7번을 제외하면 P(7)은 6/45가 아니라 0이고, 합계 하한을 올리면 큰 번호가
 * 더 자주 나온다. 기각 표집은 기저 분포를 허용 집합 위로 "자를" 뿐,
 * 자르고 난 뒤의 주변확률까지 보존하지는 않는다.
 * 공정성을 내세우는 앱이 검증 가능한 거짓을 자막으로 내보내면 그걸로 끝이다.
 * 참인 문장만 쓴다: "조건을 통과하는 모든 조합은 서로 완전히 동등합니다."
 * 그리고 번호별 확률이 달라진다는 사실 자체를 조건 패널에 명시한다.
 *
 * ── 왜 시드로 미리 굴려보는가 ───────────────────────────────────────────
 * 화면에서 눈으로 재추첨을 시키면 정직하긴 한데, 1구멍 모드는 한 판에
 * 42초가 걸린다. 통과율 1/50짜리 조건이면 35분을 기다려야 한다.
 * 그래서 난수 시드를 먼저 고르고 그 시드로 헤드리스 추첨을 돌려본다.
 * 조건을 통과한 시드를 찾으면, 화면에서는 "그 시드"로 물리를 재생한다.
 * 화면에 보이는 공의 움직임이 실제로 그 번호를 만들어낸다 — 연출이 아니다.
 * 버려진 판이 몇 번이었는지도 화면에 그대로 표시한다.
 * ========================================================================== */
'use strict';

/* 6개 서로 다른 번호 합의 이론적 한계 */
const SUM_MIN = 1 + 2 + 3 + 4 + 5 + 6;        // 21
const SUM_MAX = 40 + 41 + 42 + 43 + 44 + 45;  // 255
const MAX_INCLUDE = 5;

const FILTER_DEFAULT = Object.freeze({
  exclude: [],        // 제외수 — 이 번호는 나오면 안 된다
  include: [],        // 고정수 — 이 번호는 반드시 다 나와야 한다 (최대 5개)
                      // 6개를 고정하면 결과가 하나로 확정된다. 그건 조건 필터가
                      // 아니라 사전 결정이고, 순수성 선언의 정면 위반이다.
  oddMin: 0,          // 홀수 개수 하한 (0~6)
  oddMax: 6,          // 홀수 개수 상한
  sumMin: SUM_MIN,
  sumMax: SUM_MAX,
  maxRun: 6,          // 연속 번호 최대 길이 (1이면 연속 번호 자체를 금지)
  bandMax: 6,         // 한 구간(1-10/11-20/21-30/31-40/41-45)에 몰릴 수 있는 최대 개수
  prevOverlapMax: 6,  // 직전 회차 당첨번호와 겹치는 개수의 상한
  prevNumbers: [],    // 그 직전 회차 번호 (prevOverlapMax < 6 일 때만 의미 있음)
});

/* 사용자 입력을 안전한 값으로 정규화한다.
 * 화면에서 막더라도 URL 파라미터·백업 복원 등 다른 경로로 들어올 수 있다. */
function normalizeFilter(f) {
  const src = { ...FILTER_DEFAULT, ...(f || {}) };
  const clean = (arr) => [...new Set(
    (Array.isArray(arr) ? arr : [])
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 45)
  )].sort((a, b) => a - b);

  const out = {
    exclude: clean(src.exclude),
    /* 5개까지만 받는다. 화면에서도 막지만 URL·백업 복원으로 들어올 수 있다. */
    include: clean(src.include).slice(0, MAX_INCLUDE),
    oddMin: clamp(src.oddMin, 0, 6),
    oddMax: clamp(src.oddMax, 0, 6),
    sumMin: clamp(src.sumMin, SUM_MIN, SUM_MAX),
    sumMax: clamp(src.sumMax, SUM_MIN, SUM_MAX),
    maxRun: clamp(src.maxRun, 1, 6),
    /* 하한이 2다. 6개를 5구간에 넣으면 비둘기집 원리로 어느 구간엔 반드시
     * ⌈6/5⌉=2개가 들어간다 — bandMax=1은 통과 조합이 0개인 조건이다. */
    bandMax: clamp(src.bandMax, 2, 6),
    prevOverlapMax: clamp(src.prevOverlapMax, 0, 6),
    prevNumbers: clean(src.prevNumbers),
  };
  if (out.oddMin > out.oddMax) [out.oddMin, out.oddMax] = [out.oddMax, out.oddMin];
  if (out.sumMin > out.sumMax) [out.sumMin, out.sumMax] = [out.sumMax, out.sumMin];
  /* 고정수와 제외수가 겹치면 고정수를 살린다 — 사용자가 마지막에 누른 쪽을
   * 존중하는 게 맞지만 그 순서를 알 수 없으므로, 더 강한 의도인 고정수 우선. */
  out.exclude = out.exclude.filter(n => !out.include.includes(n));
  return out;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/* 아무 조건도 안 건 상태인가 (= 필터가 사실상 꺼진 것과 같은가) */
function isFilterTrivial(f) {
  const n = normalizeFilter(f);
  return n.exclude.length === 0 && n.include.length === 0
    && n.oddMin === 0 && n.oddMax === 6
    && n.sumMin === SUM_MIN && n.sumMax === SUM_MAX
    && n.maxRun === 6 && n.bandMax === 6
    && n.prevOverlapMax === 6;
}

/* ── 판정 ──────────────────────────────────────────────────────────────────
 * nums: 오름차순 6개. 통과하면 null, 실패하면 사유 문자열을 반환한다.
 * (사유를 돌려주는 이유: 화면에 "왜 버려졌는지"를 그대로 보여주기 위해서다.
 *  그냥 버리면 사용자는 앱이 멈춘 줄 안다.) */
function filterReject(nums, f) {
  const st = combStats(nums);
  const n = st.sorted;

  for (const x of f.exclude) if (n.includes(x)) return `제외수 ${x} 포함`;
  for (const x of f.include) if (!n.includes(x)) return `고정수 ${x} 누락`;
  if (st.odd < f.oddMin || st.odd > f.oddMax) return `홀수 ${st.odd}개 (허용 ${f.oddMin}~${f.oddMax})`;
  if (st.sum < f.sumMin || st.sum > f.sumMax) return `합계 ${st.sum} (허용 ${f.sumMin}~${f.sumMax})`;
  if (st.maxRun > f.maxRun) return `연속 ${st.maxRun}개 (허용 ${f.maxRun}개)`;
  if (Math.max(...st.bands) > f.bandMax) return `한 구간에 ${Math.max(...st.bands)}개 (허용 ${f.bandMax}개)`;
  /* 직전 회차 조건은 번호가 정확히 6개일 때만 건다. 3개만 입력된 상태로
   * 판정하면 "중복 최대 2개"가 실제보다 헐거워져 조용히 틀린 결과를 낸다. */
  if (f.prevOverlapMax < 6 && f.prevNumbers.length === 6) {
    const ov = n.filter(x => f.prevNumbers.includes(x)).length;
    if (ov > f.prevOverlapMax) return `직전 회차와 ${ov}개 중복 (허용 ${f.prevOverlapMax}개)`;
  }
  return null;
}

const filterAccepts = (nums, f) => filterReject(nums, f) === null;

/* ── 실현 가능성 검사 ──────────────────────────────────────────────────────
 * 조건이 모순이면 재추첨 루프가 영원히 안 끝난다. 반드시 시작 전에 잡아야 한다.
 *
 * 1단계는 확실하게 불가능한 것들을 논리로 걸러낸다.
 * 2단계는 나머지를 몬테카를로로 통과율을 추정한다. 조건들이 서로 얽히면
 *   (예: 고정수 3개 + 좁은 합계 + 홀짝 제한) 해석적으로 세는 게 사실상 불가능한데,
 *   무작위 조합 표본은 그 얽힘까지 그대로 반영한다.
 *   물리 추첨의 결과 분포가 C(45,6) 위의 균등분포이므로 (공 45개가 물리적으로
 *   동일하고, 번호↔공 배정을 매 게임 셔플하므로) 이 표본 추정이 곧 실제 통과율이다.
 *
 * 반환: {ok, reason, rate, expectedTries, poolSize, exact}
 * ────────────────────────────────────────────────────────────────────────── */
function analyzeFilter(f, opts = {}) {
  /* 정규화가 고정수를 5개로 잘라내므로, 자르기 전 원본으로 먼저 확인한다.
   * 안 그러면 6개를 넣은 사용자에게 엉뚱한 사유가 표시된다. */
  const rawInclude = Array.isArray(f && f.include) ? f.include.length : 0;
  f = normalizeFilter(f);
  const rng = opts.rng || makeRng(0x5eed1e);   // 추정은 재현 가능해야 화면이 안 흔들린다

  // ── 1단계: 논리적으로 불가능한 경우 ──
  // 후보 풀을 먼저 만든다 — fail()이 poolSize를 참조하므로 첫 검사보다 앞서야 한다.
  const pool = [];
  for (let i = 1; i <= 45; i++) if (!f.exclude.includes(i)) pool.push(i);

  if (rawInclude > MAX_INCLUDE) {
    return fail(
      `고정수는 ${MAX_INCLUDE}개까지만 지정할 수 있습니다. 6개를 모두 고정하면 ` +
      `결과가 하나로 정해져 버려, 이 프로그램의 순수성 선언과 어긋납니다.`);
  }
  if (pool.length < 6) {
    return fail(`제외수가 너무 많습니다. 남은 번호가 ${pool.length}개뿐이라 6개를 뽑을 수 없습니다.`);
  }

  // 고정수만으로 이미 어기는 조건
  {
    const incStats = combStats(f.include.concat());
    if (f.include.length >= 2 && incStats.maxRun > f.maxRun) {
      return fail(`고정수에 이미 ${incStats.maxRun}개 연속이 들어 있어 "연속 ${f.maxRun}개 이하" 조건과 충돌합니다.`);
    }
    if (incStats.odd > f.oddMax) {
      return fail(`고정수의 홀수가 ${incStats.odd}개라 "홀수 ${f.oddMax}개 이하" 조건과 충돌합니다.`);
    }
    if (f.include.length - incStats.odd > 6 - f.oddMin) {
      return fail(`고정수의 짝수가 ${f.include.length - incStats.odd}개라 "홀수 ${f.oddMin}개 이상" 조건과 충돌합니다.`);
    }
    if (Math.max(0, ...incStats.bands) > f.bandMax) {
      return fail(`고정수가 한 구간에 ${Math.max(...incStats.bands)}개 몰려 있어 "구간당 ${f.bandMax}개 이하" 조건과 충돌합니다.`);
    }
  }

  // 합계 도달 가능 범위 — 고정수는 확정, 나머지는 후보 중 가장 작은/큰 것들로 채운다
  {
    const rest = pool.filter(n => !f.include.includes(n));
    const need = 6 - f.include.length;
    const incSum = f.include.reduce((a, b) => a + b, 0);
    const lo = incSum + rest.slice(0, need).reduce((a, b) => a + b, 0);
    const hi = incSum + rest.slice(rest.length - need).reduce((a, b) => a + b, 0);
    if (hi < f.sumMin) return fail(`지금 조건에서 만들 수 있는 최대 합이 ${hi}이라 "합계 ${f.sumMin} 이상"에 도달할 수 없습니다.`);
    if (lo > f.sumMax) return fail(`지금 조건에서 만들 수 있는 최소 합이 ${lo}이라 "합계 ${f.sumMax} 이하"에 도달할 수 없습니다.`);
  }

  // 홀짝: 후보 풀에 홀수·짝수가 충분히 있는가
  {
    const rest = pool.filter(n => !f.include.includes(n));
    const incOdd = f.include.filter(n => n % 2).length;
    const incEven = f.include.length - incOdd;
    const restOdd = rest.filter(n => n % 2).length;
    const restEven = rest.length - restOdd;
    const need = 6 - f.include.length;
    const maxOdd = incOdd + Math.min(restOdd, need);
    const minOdd = incOdd + Math.max(0, need - restEven);
    if (maxOdd < f.oddMin) return fail(`남은 번호에 홀수가 부족해 "홀수 ${f.oddMin}개 이상"을 만들 수 없습니다.`);
    if (minOdd > f.oddMax) return fail(`남은 번호에 짝수가 부족해 "홀수 ${f.oddMax}개 이하"를 만들 수 없습니다.`);
  }

  // ── 2단계: 몬테카를로 통과율 추정 ──
  // 표본 상한을 30만으로 잡는다. 화면을 멈춰 세우지 않으려면 100ms 안에 끝나야 하고,
  // 30만이면 1/3000 수준까지는 오차 10% 안쪽으로 잡힌다.
  // 그보다 희박한 조건은 어차피 "실용적으로 못 쓴다"가 결론이라 정밀도가 필요 없다.
  const rate = estimateRate(f, rng);

  if (rate === 0) {
    return {
      ok: false,
      reason: `조건이 너무 빡빡합니다. 무작위 조합 ${MC_MAX_SAMPLES.toLocaleString()}개 중 ` +
              `하나도 통과하지 못했습니다.`,
      rate: 0,
      expectedTries: Infinity,
      poolSize: pool.length,
      exact: false,
      culprits: findCulprits(f, rng),
    };
  }

  return {
    ok: true,
    reason: '',
    rate,
    expectedTries: 1 / rate,
    poolSize: pool.length,
    exact: lastRateWasExact,
    /* 통과율이 낮으면 어떤 조건이 발목을 잡는지 미리 계산해 둔다.
     * "조건을 완화하세요"만 띄우면 사용자는 뭘 만져야 할지 모른다. */
    culprits: (1 / rate) > 300 ? findCulprits(f, rng) : null,
  };

  function fail(reason) {
    return { ok: false, reason, rate: 0, expectedTries: Infinity, poolSize: pool.length, exact: true, culprits: null };
  }
}

/* 직전 estimateRate 호출이 전수 계산이었는지 (추정이 아니라) */
let lastRateWasExact = false;

const MC_MAX_SAMPLES = 300_000;
const MC_TARGET_HITS = 100;

function countComb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

/* 고정수를 뺀 나머지 자리를 전수 조합으로 채워 보며 통과 개수를 센다.
 * 분모는 C(45,6) — 물리 추첨이 뽑는 전체 모집단이다. */
function exactRate(pool, free, f) {
  const total = countComb(45, 6);
  if (free === 0) return filterAccepts(f.include.slice(), f) ? 1 / total : 0;
  const pick = new Array(free);
  let hits = 0;
  const rec = (start, depth) => {
    if (depth === free) {
      if (filterAccepts(f.include.concat(pick), f)) hits++;
      return;
    }
    for (let i = start; i <= pool.length - (free - depth); i++) {
      pick[depth] = pool[i];
      rec(i + 1, depth + 1);
    }
  };
  rec(0, 0);
  return hits / total;
}

/* 통과율 추정. 히트 100개를 모으면 조기 종료한다.
 *
 * ★ 반드시 1~45 전체에서 뽑는다.
 *   제외수를 뺀 후보 풀에서 뽑으면 "제외수를 피할 확률"이 통째로 빠진다.
 *   1~20을 제외하면 풀 기준으로는 통과율이 100%로 보이지만, 물리 추첨은
 *   45개 전부에서 뽑으므로 실제 통과율은 C(25,6)/C(45,6) = 1/46 이다.
 *   초안이 이 보정을 빠뜨려 예상 소요 시간이 46배까지 낙관적으로 나왔다
 *   (전수 열거와 대조해 확인). 물리가 뽑는 그 모집단에서 뽑아야 맞다. */
const ALL45 = Array.from({ length: 45 }, (_, i) => i + 1);

function estimateRate(f, rng) {
  /* 고정수가 많으면 남은 자리가 적어 조합을 전부 셀 수 있다.
   * 몬테카를로로는 이 영역을 감당하지 못한다 — 고정수 5개면 통과율이
   * 1/203,627 이라 30만 표본으로도 4번 중 1번은 히트 0이 나오고,
   * 시드가 고정돼 있어 "불가능"이라는 잘못된 판정이 그대로 굳는다.
   * 앱이 스스로 허용한 설정을 앱이 거부하는 셈이라 반드시 정확히 세야 한다. */
  const pool = ALL45.filter(n => !f.exclude.includes(n) && !f.include.includes(n));
  const free = 6 - f.include.length;
  if (free >= 0 && countComb(pool.length, free) <= 400_000) {
    lastRateWasExact = true;
    return exactRate(pool, free, f);
  }
  lastRateWasExact = false;
  const work = ALL45.slice();
  const buf = new Array(6);
  let hits = 0, samples = 0;
  while (samples < MC_MAX_SAMPLES && hits < MC_TARGET_HITS) {
    samplePool(work, buf, rng);
    samples++;
    if (filterAccepts(buf, f)) hits++;
  }
  return hits === 0 ? 0 : hits / samples;
}

/* 조건을 하나씩 꺼 보면서 통과율이 얼마나 회복되는지 잰다.
 * 가장 크게 회복시키는 조건이 곧 "지금 제일 빡빡한 조건"이다. */
function findCulprits(f, rng) {
  const relaxations = [
    ['exclude', '제외수', { exclude: [] }],
    ['include', '고정수', { include: [] }],
    ['odd', '홀짝 비율', { oddMin: 0, oddMax: 6 }],
    ['sum', '합계 범위', { sumMin: SUM_MIN, sumMax: SUM_MAX }],
    ['maxRun', '연속수 제한', { maxRun: 6 }],
    ['bandMax', '구간 분포', { bandMax: 6 }],
    ['prev', '직전 회차 중복', { prevOverlapMax: 6 }],
  ];
  /* 모든 추정을 같은 모집단(1~45 전체)에서 하므로 조건을 하나씩 풀었을 때의
   * 통과율이 서로 같은 척도로 비교된다. 제외수만 다른 풀에서 재던 초안은
   * 배율이 뒤죽박죽이라 "무엇을 풀어야 하는지"를 잘못 짚었다. */
  const base = estimateRate(f, makeRng(0xc0ffee));
  const out = [];

  for (const [key, label, patch] of relaxations) {
    // 실제로 걸려 있지 않은 조건은 건너뛴다 (풀어도 달라질 게 없다)
    if (JSON.stringify({ ...f, ...patch }) === JSON.stringify(f)) continue;
    const r = estimateRate({ ...f, ...patch }, makeRng(0xc0ffee));
    out.push({ key, label, rate: r, gain: base > 0 ? r / base : (r > 0 ? Infinity : 1) });
  }
  /* base 가 0이면 gain 이 전부 Infinity 라 Infinity-Infinity = NaN 이 되고,
   * NaN 비교자는 정렬 순서를 미정의로 만든다. 통과율 자체로 정렬한다. */
  out.sort((a, b) => (b.rate - a.rate) || (b.gain - a.gain) || 0);
  return out.slice(0, 3);
}

/* 후보 풀에서 서로 다른 6개를 균등하게 뽑아 buf에 오름차순으로 담는다.
 * 부분 Fisher-Yates — 풀 전체를 섞지 않고 앞 6칸만 확정한다. */
function samplePool(pool, buf, rng) {
  const n = pool.length;
  for (let i = 0; i < 6; i++) {
    const j = i + rng.randint(0, n - 1 - i);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    buf[i] = pool[i];
  }
  buf.sort((a, b) => a - b);
  return buf;
}

function comb(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

/* ── 사람이 읽을 수 있는 설명 ──────────────────────────────────────────────
 * msPerDraw: 헤드리스 추첨 1판에 실제로 걸리는 시간 (앱 시작 시 실측한다).
 *            구멍 개수·기기 성능에 따라 3ms에서 15ms까지 벌어지므로 상수로
 *            박아두면 예상 시간이 몇 배씩 틀린다.
 * workers  : 동시에 돌리는 워커 수 */
function describeFilterOdds(analysis, msPerDraw = 8, workers = 1) {
  if (!analysis.ok) {
    return {
      level: 'error',
      text: analysis.reason,
      culprits: analysis.culprits,
    };
  }
  const tries = analysis.expectedTries;
  const pct = analysis.rate * 100;
  const rateText = pct >= 1
    ? `약 ${pct.toFixed(pct >= 10 ? 0 : 1)}%`
    : `약 ${Math.round(1 / analysis.rate).toLocaleString()}판에 1번`;

  /* 화면 재생 시간은 "통과한 1판"만이다. 버려지는 판은 헤드리스라 순간에 가깝다. */
  const searchMs = (tries * msPerDraw) / Math.max(1, workers);

  let level = 'ok';
  let text = `조건 통과율 ${rateText}. 평균 ${Math.ceil(tries).toLocaleString()}판을 미리 굴려 1판을 씁니다.`;

  if (searchMs > 120_000) {
    level = 'error';
    text += ` 조건을 만족하는 판을 찾는 데 ${fmtDuration(searchMs)}쯤 걸립니다 — 사실상 쓰기 어렵습니다.`;
  } else if (searchMs > 15_000) {
    level = 'warn';
    text += ` 찾는 데 ${fmtDuration(searchMs)}쯤 걸립니다.`;
  } else if (searchMs > 1_500) {
    level = 'warn';
    text += ` 찾는 데 ${fmtDuration(searchMs)}쯤 걸립니다.`;
  }
  return { level, text, searchMs, culprits: analysis.culprits };
}

function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}밀리초`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}분`;
  return `${(ms / 3_600_000).toFixed(1)}시간`;
}
