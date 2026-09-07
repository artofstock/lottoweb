/* ============================================================================
 * 01-physics.js — 물리 엔진 (원본 LottoEngine 1:1 포팅)
 *
 * 원본: 로또추첨기FHD_v1_9_11.py  ·  LottoEngine / Ball / _SpatialGrid
 *
 * 순수성 선언 (원본 헤더에서 계승)
 *   · 사전 당첨 번호 확정 없음
 *   · 특정 공 유도·조작 없음
 *   · 숨겨진 가중치·편향 없음
 *   45개 공은 동일한 물리 법칙 아래 움직이고, 구멍에 먼저 들어온 공이 당첨된다.
 *
 * DOM·브라우저 API를 일절 참조하지 않는다 → Web Worker에서 그대로 실행 가능
 * (공정성 셀프테스트가 이 파일을 헤드리스로 돌린다).
 * ========================================================================== */
'use strict';

/* ── 화면 크기 / 물리 상수 ────────────────────────────────────────────────
 * 원본과 동일한 좌표계를 유지한다. 캔버스는 CSS로 스케일만 하고,
 * 물리 좌표는 언제나 1430 x 1050 논리 픽셀 위에서 계산된다.
 * → 화면 크기가 달라져도 추첨 결과 분포가 흔들리지 않는다. */
const STAGE_W = 1430;
const STAGE_H = 1050;

const BALL_R = 32;
const HOLE_R = 36;
const MAGNET_RANGE = 230;
const MAGNET_STRENGTH = 0.18;
const ACCEL_INTERVAL_MS = 8000;
const ACCEL_RATE = 1.06;
const MAX_SPEED = 26;

/* 공간 분할 그리드 셀 크기: BALL_R * 4 = 128px (공 지름의 2배)
 * 같은 셀 + 인접 8셀만 검사하면 모든 충돌 후보가 포함된다. */
const CELL_SIZE = BALL_R * 4;

/* 반발계수 (Coefficient of Restitution) */
const RESTITUTION_BALL = 0.95;
const RESTITUTION_WALL = 0.90;

/* 접선 마찰계수 (쿨롱 마찰 간략화) */
const FRICTION_TANGENT = 0.01;

/* 목표속도 추적 — 시간이 갈수록 확실히 빨라지는 구조 */
const TARGET_SPEED_INIT = 10.0;
const TARGET_SPEED_MAX = MAX_SPEED;
const SPEED_PUSH = 0.12;

/* 물리 한 틱의 길이. 원본 FRAME_MS=28 (~35.7Hz).
 * 브라우저는 60/120Hz로 그리지만 물리는 반드시 이 고정 스텝으로 돌린다.
 * (프레임당 상수인 MAGNET_STRENGTH·SPEED_PUSH가 화면 주사율에 휘둘리면
 *  추첨 속도와 분포가 기기마다 달라진다.) */
const PHYSICS_STEP_MS = 28;

/* 구멍 좌표 — 인덱스: 0=좌상, 1=우상, 2=좌하, 3=우하 */
const HOLE_CENTERS_4 = [
  [HOLE_R + 18, HOLE_R + 18],
  [STAGE_W - HOLE_R - 18, HOLE_R + 18],
  [HOLE_R + 18, STAGE_H - HOLE_R - 18],
  [STAGE_W - HOLE_R - 18, STAGE_H - HOLE_R - 18],
];
const HOLE_LABELS = ['좌상', '우상', '좌하', '우하'];

/* 구멍 개수별 활성 인덱스 — 원본 apply_hole_count_visual과 동일 매핑 */
const HOLE_INDICES = {
  1: [1],           // 우상 (원본 기본 위치)
  2: [1, 2],        // 우상 + 좌하 — 화면 중심 기준 180° 회전 대칭
  4: [0, 1, 2, 3],
};

/* 번호대별 공 색상 */
function ballColor(n) {
  if (n <= 10) return '#FF6B6B';
  if (n <= 20) return '#4FC3F7';
  if (n <= 30) return '#FFD54F';
  if (n <= 40) return '#81C784';
  return '#CE93D8';
}

/* ── 난수원 ────────────────────────────────────────────────────────────────
 * 원본은 파이썬 메르센 트위스터를 썼다. 여기서는 시드를 명시적으로 다루는
 * PRNG를 쓴다 — 이유는 두 가지다.
 *   ① 실제 추첨: 시드를 crypto.getRandomValues로 뽑는다. 브라우저 Math.random
 *      보다 출처가 분명하고, 추첨 직전까지 아무도 시드를 모른다.
 *   ② 셀프테스트: 시드를 고정하면 같은 결과를 재현할 수 있다. 재현 불가능한
 *      공정성 검증은 검증이 아니다.
 * 알고리즘은 xoshiro128** — 주기 2^128-1, 통계 검정 통과, 정수 연산만 사용. */
function makeRng(seed) {
  let s0, s1, s2, s3;

  if (seed === undefined || seed === null) {
    const buf = new Uint32Array(4);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      // crypto가 없는 극단적 환경 폴백 (실사용 경로 아님)
      for (let i = 0; i < 4; i++) buf[i] = (Math.random() * 0x100000000) >>> 0;
    }
    [s0, s1, s2, s3] = buf;
  } else {
    // 32비트 시드 하나를 splitmix32로 128비트 상태로 펼친다.
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    s0 = next(); s1 = next(); s2 = next(); s3 = next();
  }
  // 전부 0인 상태는 고정점이라 절대 벗어나지 못한다 — 방어.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 0x9e3779b9;

  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;

  function nextUint32() {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7) >>> 0, 9)) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  }

  /* [0, 1) 균등 — 상위 24비트만 써서 부동소수점 편향을 피한다. */
  const random = () => (nextUint32() >>> 8) / 16777216;

  /* [lo, hi] 정수 균등 (파이썬 randint와 동일하게 양끝 포함).
   * 나머지 연산 편향을 제거하기 위해 거부 샘플링을 쓴다. */
  function randint(lo, hi) {
    const range = hi - lo + 1;
    if (range <= 0) return lo;
    const limit = Math.floor(0x100000000 / range) * range;
    let v;
    do { v = nextUint32(); } while (v >= limit);
    return lo + (v % range);
  }

  /* [lo, hi) 실수 균등 (파이썬 uniform은 [lo,hi]지만 경계값 확률은 0) */
  const uniform = (lo, hi) => lo + random() * (hi - lo);

  /* Fisher-Yates — 파이썬 random.shuffle과 동일 */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randint(0, i);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  return { random, randint, uniform, shuffle, nextUint32 };
}

/* ── 공 하나 ───────────────────────────────────────────────────────────────
 * 렌더 보간용으로 원본에 없던 rx/ry(직전 틱 위치)를 들고 있다.
 * 물리에는 관여하지 않는다 — 화면을 60/120Hz로 부드럽게 그리기 위한 값. */
class Ball {
  constructor(number, x, y, vx, vy) {
    this.number = number;
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.r = BALL_R;
    this.color = ballColor(number);
    this.mass = 1.0;
    /* Swept Sphere 검사용 구간의 양 끝.
     * 원본은 prev(이동 전) → 현재(충돌 보정까지 끝난 뒤)를 한 구간으로 봤는데,
     * 충돌 겹침 보정은 공을 순간이동시키는 처리라 실제로 지나간 경로가 아니다.
     * 그 구간으로 구멍을 검사하면 가지도 않은 길에서 공이 잡힐 수 있다.
     * 그래서 "속도로 실제 이동한 구간"(prev → postMove)만 따로 들고 있는다. */
    this.prevX = x; this.prevY = y;         // 이동 전
    this.postMoveX = x; this.postMoveY = y; // 속도 적용 직후 (충돌 보정 전)
    this.rx = x; this.ry = y;               // 렌더 보간용 (직전 틱 위치)
  }
}

/* ── 공간 분할 그리드 ──────────────────────────────────────────────────────
 * 45개 공 전수 비교는 990쌍. 그리드로 좁히면 보통 100쌍 안쪽으로 줄어든다.
 * 셀 크기가 공 지름의 2배라서 "같은 셀 + 오른쪽·아래쪽 인접 4셀"만 봐도
 * 충돌 가능한 모든 쌍이 정확히 한 번씩 나온다 (중복 없음). */
class SpatialGrid {
  constructor(cellSize = CELL_SIZE) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  build(balls) {
    this.cells.clear();
    for (const b of balls) {
      const cx = Math.floor(b.x / this.cellSize);
      const cy = Math.floor(b.y / this.cellSize);
      const key = cx * 100000 + cy;   // 셀 좌표 → 정수 키
      let bucket = this.cells.get(key);
      if (bucket === undefined) { bucket = []; this.cells.set(key, bucket); }
      bucket.push(b);
    }
  }

  /* 후보 쌍을 콜백으로 흘려보낸다 (배열을 만들지 않아 GC 부담이 없다). */
  forEachPair(fn) {
    const NEIGHBORS = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 1]];
    for (const [key, bucket] of this.cells) {
      const cx = Math.floor(key / 100000);
      const cy = key - cx * 100000;
      for (const [ox, oy] of NEIGHBORS) {
        const other = (ox === 0 && oy === 0)
          ? bucket
          : this.cells.get((cx + ox) * 100000 + (cy + oy));
        if (other === undefined) continue;
        if (other === bucket) {
          for (let i = 0; i < bucket.length; i++)
            for (let j = i + 1; j < bucket.length; j++) fn(bucket[i], bucket[j]);
        } else {
          for (let i = 0; i < bucket.length; i++)
            for (let j = 0; j < other.length; j++) fn(bucket[i], other[j]);
        }
      }
    }
  }
}

/* ── 엔진 ──────────────────────────────────────────────────────────────────
 * UI에 전혀 의존하지 않는다 → 브라우저에서도 워커에서도 동일하게 돈다. */
class LottoEngine {
  constructor(opts = {}) {
    this.rng = opts.rng || makeRng();
    this.balls = [];
    this.drawnNumbers = [];
    this.freq = new Array(46).fill(0);   // 인덱스 1..45 사용
    this.holeHits = [0, 0, 0, 0];        // 구멍별 포획 횟수 (공정성 지표)
    this.totalGames = 0;
    this.grid = new SpatialGrid();
    this.targetSpeed = TARGET_SPEED_INIT;
    this.elapsedMs = 0;                  // 이번 추첨 경과 시간 (가속 타이머용)
    this._nextAccelMs = ACCEL_INTERVAL_MS;
    this.setHoleCount(opts.holeCount || 1);
  }

  /* 활성 구멍 개수: 1, 2, 4만 허용. 그 밖의 값은 1로 강제 (원본과 동일). */
  setHoleCount(count) {
    if (![1, 2, 4].includes(count)) count = 1;
    this.holeCount = count;
    this.activeHoleIndices = HOLE_INDICES[count];
    this.activeHoles = this.activeHoleIndices.map(i => HOLE_CENTERS_4[i]);
  }

  /* ── 공 초기화 ──────────────────────────────────────────────────────────
   * 생성 순서를 매 게임 셔플한다. 난수 스트림의 소비 순서와 번호가
   * 무관해져서 번호-초기위치 사이의 구조적 상관관계가 사라진다. */
  createAllBalls() {
    const numbers = [];
    for (let n = 1; n <= 45; n++) numbers.push(n);
    this.rng.shuffle(numbers);
    this.balls = [];
    for (const n of numbers) this.balls.push(this._makeBall(n));
    return this.balls;
  }

  _makeBall(number) {
    const R = this.rng;
    const r = BALL_R;
    /* 위·아래 모두 60px 버퍼 — 모든 활성 구멍과의 최단 거리가 38px로 같아진다.
     * (원본 v1.9.6 공정성 수정: 이전엔 아래쪽 구멍이 통계적으로 유리했음)
     *
     * 원본은 45개 위치를 서로 겹치는지 보지 않고 그냥 뽑았다. 그래서 시작하자마자
     * 겹친 공들이 서로를 밀어내며 튕겨나가는 폭발이 일어난다 — 보기에도 어수선하고,
     * 겹침 보정이 임펄스 없이 위치만 옮기는 처리라 물리적으로도 공짜 에너지다.
     * 여기서는 이미 놓인 공과 겹치지 않는 자리를 찾아 놓는다.
     * (지름 64px 공 45개 vs 1357x867 영역 = 점유율 11% — 금방 자리를 찾는다.
     *  번호↔위치 배정은 위에서 이미 셔플했으므로 번호별 편향은 생기지 않는다.) */
    const xMin = r + 5, xMax = STAGE_W - r - 5;
    const yMin = r + 60, yMax = STAGE_H - r - 60;
    const minGapSq = (2 * r + 2) ** 2;

    let x = 0, y = 0;
    for (let attempt = 0; attempt < 240; attempt++) {
      x = R.randint(xMin, xMax);
      y = R.randint(yMin, yMax);
      let clear = true;
      for (const o of this.balls) {
        const dx = o.x - x, dy = o.y - y;
        if (dx * dx + dy * dy < minGapSq) { clear = false; break; }
      }
      if (clear) break;
      /* 240번 안에 못 찾으면 마지막 후보를 그냥 쓴다. 무한루프는 절대 안 된다 —
       * 자리를 못 찾는 상황보다 앱이 멈추는 게 훨씬 나쁘다. */
    }

    let vx = R.uniform(-13, 13);
    let vy = R.uniform(-13, 13);
    if (Math.abs(vx) < 4) vx = 4 * (vx >= 0 ? 1 : -1);
    if (Math.abs(vy) < 4) vy = 4 * (vy >= 0 ? 1 : -1);
    return new Ball(number, x, y, vx, vy);
  }

  /* ── 자석 ───────────────────────────────────────────────────────────────
   * 각 공마다 "가장 가까운 구멍 1개"에만 인력을 건다.
   * 4개 모두에 동시에 걸면 합력이 상쇄돼 공이 화면 중앙에 멈춰 설 수 있다. */
  applyMagnet() {
    const holes = this.activeHoles;
    for (const b of this.balls) {
      let minDistSq = Infinity, ndx = 0, ndy = 0;
      for (let i = 0; i < holes.length; i++) {
        const dxH = holes[i][0] - b.x;
        const dyH = holes[i][1] - b.y;
        const dSq = dxH * dxH + dyH * dyH;
        if (dSq < minDistSq) { minDistSq = dSq; ndx = dxH; ndy = dyH; }
      }
      const dist = Math.sqrt(minDistSq);
      if (dist > 0 && dist < MAGNET_RANGE) {
        const force = MAGNET_STRENGTH * (1 - dist / MAGNET_RANGE);
        b.vx += (ndx / dist) * force;
        b.vy += (ndy / dist) * force;
      }
    }
  }

  /* ── 이동 + 벽 반사 + 목표속도 추적 ────────────────────────────────────── */
  moveBalls() {
    const tgt = this.targetSpeed;
    for (const b of this.balls) {
      b.prevX = b.x; b.prevY = b.y;

      const spd = Math.hypot(b.vx, b.vy);
      if (spd > MAX_SPEED) {
        const ratio = MAX_SPEED / spd;
        b.vx *= ratio; b.vy *= ratio;
      } else if (spd < tgt && spd > 1e-6) {
        const ratio = (spd + SPEED_PUSH) / spd;   // 방향 유지, 크기만 증가
        b.vx *= ratio; b.vy *= ratio;
      } else if (spd < 1e-6) {
        const angle = this.rng.uniform(0, Math.PI * 2);
        b.vx = Math.cos(angle) * tgt;
        b.vy = Math.sin(angle) * tgt;
      }

      b.x += b.vx;
      b.y += b.vy;

      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * RESTITUTION_WALL; }
      else if (b.x + b.r > STAGE_W) { b.x = STAGE_W - b.r; b.vx = -Math.abs(b.vx) * RESTITUTION_WALL; }

      if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy) * RESTITUTION_WALL; }
      else if (b.y + b.r > STAGE_H) { b.y = STAGE_H - b.r; b.vy = -Math.abs(b.vy) * RESTITUTION_WALL; }

      // 속도로 실제 이동한 끝점 — 이 뒤에 오는 충돌 보정은 여기 반영하지 않는다.
      b.postMoveX = b.x; b.postMoveY = b.y;
    }
  }

  /* ── 충돌 ───────────────────────────────────────────────────────────────
   * ① 반발계수  J = -(1+e) * vn / (1/m1 + 1/m2)
   * ② 접선 마찰 쿨롱 근사  |Jt| <= mu * |Jn|
   * ③ 겹침 분리 질량 역비율 (동질량이면 절반씩) + 0.5px 여유 */
  checkCollisions() {
    this.grid.build(this.balls);
    const rng = this.rng;

    this.grid.forEachPair((b1, b2) => {
      const dx = b1.x - b2.x;
      const dy = b1.y - b2.y;
      const dist = Math.hypot(dx, dy);
      const md = b1.r + b2.r;
      if (dist >= md) return;

      let nx, ny;
      if (dist < 1e-9) {            // 완전 중첩 — 임의 방향으로 밀어냄
        const angle = rng.uniform(0, Math.PI * 2);
        nx = Math.cos(angle); ny = Math.sin(angle);
      } else {
        nx = dx / dist; ny = dy / dist;
      }
      const tx = -ny, ty = nx;

      const rvx = b1.vx - b2.vx;
      const rvy = b1.vy - b2.vy;
      const vn = rvx * nx + rvy * ny;
      const vt = rvx * tx + rvy * ty;

      const invMassSum = 1.0 / b1.mass + 1.0 / b2.mass;

      /* 이미 서로 멀어지는 중이면 임펄스는 주지 않는다 (한 번 튄 걸 또 튀기면
       * 에너지가 늘어난다). 다만 겹침 분리는 해준다 — 원본은 여기서 return해서
       * 겹친 채로 멀어지는 쌍이 그대로 남았고, 화면에서 공이 파고든 것처럼 보였다. */
      if (vn <= 0) {
        const Jn = -(1.0 + RESTITUTION_BALL) * vn / invMassSum;

        const JtMax = FRICTION_TANGENT * Math.abs(Jn);
        const JtRaw = -vt / invMassSum;
        const Jt = Math.max(-JtMax, Math.min(JtMax, JtRaw));

        b1.vx += (Jn * nx + Jt * tx) / b1.mass;
        b1.vy += (Jn * ny + Jt * ty) / b1.mass;
        b2.vx -= (Jn * nx + Jt * tx) / b2.mass;
        b2.vy -= (Jn * ny + Jt * ty) / b2.mass;
      }

      const ov = (md - dist) + 0.5;   // 0.5px 여유 — 다음 틱 재충돌 방지
      const w1 = (1.0 / b1.mass) / invMassSum;
      const w2 = 1.0 - w1;
      b1.x += nx * ov * w1; b1.y += ny * ov * w1;
      b2.x -= nx * ov * w2; b2.y -= ny * ov * w2;
    });
  }

  /* ── 구멍 감지 ──────────────────────────────────────────────────────────
   * 캡처 반경은 HOLE_R - BALL_R = 4px 밖에 안 된다. 최대 속도는 26px/틱이라
   * 현재 위치만 보면 빠른 공이 캡처 영역을 통째로 건너뛴다 (터널링).
   * 그러면 "빠른 공일수록 안 잡힌다"는 속도 편향이 생긴다 — 순수성 위반.
   * 그래서 직전 위치와 현재 위치를 잇는 선분이 캡처원을 스쳤는지까지 본다.
   *
   * 반환: {ball, holeIndex} 또는 null. 한 틱에 한 공만 잡는다. */
  checkHole() {
    const captureDistSq = (HOLE_R - BALL_R) ** 2;   // 16

    for (let bi = 0; bi < this.balls.length; bi++) {
      const ball = this.balls[bi];

      for (let hi = 0; hi < this.activeHoles.length; hi++) {
        const hx = this.activeHoles[hi][0];
        const hy = this.activeHoles[hi][1];
        const holeIndex = this.activeHoleIndices[hi];

        // ① 빠른 경로 — 현재 위치
        const ddx = ball.x - hx, ddy = ball.y - hy;
        if (ddx * ddx + ddy * ddy <= captureDistSq) {
          return this._capture(bi, holeIndex);
        }

        /* ② Swept Sphere — 속도로 실제 이동한 구간과 구멍 중심의 최단거리.
         * 끝점은 postMove다. 충돌 겹침 보정으로 옮겨진 거리까지 경로에 넣으면
         * 지나간 적 없는 길에서 공이 잡힌다 (원본의 미세한 오포획 원인). */
        const segDx = ball.postMoveX - ball.prevX;
        const segDy = ball.postMoveY - ball.prevY;
        const segLenSq = segDx * segDx + segDy * segDy;
        /* 원본은 이동량 8px 이하면 이 검사를 통째로 건너뛰었다. 캡처원 지름이
         * 8px이라 5~8px 이동이 원을 관통해 빠져나가는 경우를 놓칠 수 있었다.
         * 하한을 없앴다 — 계산비용은 무시할 수준이고 미세한 속도 편향이 사라진다. */
        if (segLenSq < 1e-9) continue;

        const toHx = hx - ball.prevX;
        const toHy = hy - ball.prevY;
        const t = (toHx * segDx + toHy * segDy) / segLenSq;
        /* 끝점 t=1 은 반드시 포함해야 한다.
         * 원본은 t>=1 을 잘라내고 "끝점은 ①이 이미 검사한다"고 적었는데,
         * ①이 보는 건 충돌 보정까지 끝난 현재 위치이고 이 구간의 끝점은
         * 보정 전 위치다. 공이 속도로 캡처원 안에 들어갔는데 같은 틱의
         * 충돌 보정이 밖으로 밀어내면, 두 검사 모두 그 공을 놓친다. */
        if (t <= 0 || t > 1) continue;

        const px = ball.prevX + t * segDx;
        const py = ball.prevY + t * segDy;
        const cx = px - hx, cy = py - hy;
        if (cx * cx + cy * cy <= captureDistSq) {
          // 경로상에서 캡처 — 공 위치를 실제 캡처 지점으로 보정
          ball.x = px; ball.y = py;
          return this._capture(bi, holeIndex);
        }
      }
    }
    return null;
  }

  _capture(ballIndex, holeIndex) {
    const ball = this.balls[ballIndex];
    this.balls.splice(ballIndex, 1);
    this.drawnNumbers.push(ball.number);
    this.holeHits[holeIndex]++;
    return { ball, holeIndex };
  }

  /* ── 한 물리 틱 ─────────────────────────────────────────────────────────
   * 원본 _animate() 한 프레임과 정확히 같은 순서·같은 연산.
   * 반환: 이번 틱에 잡힌 {ball, holeIndex} 또는 null. */
  step() {
    this.elapsedMs += PHYSICS_STEP_MS;
    if (this.elapsedMs >= this._nextAccelMs) {
      this.accelerate();
      this._nextAccelMs += ACCEL_INTERVAL_MS;
    }
    this.applyMagnet();
    this.moveBalls();
    this.checkCollisions();
    if (this.drawnNumbers.length < 6) return this.checkHole();
    return null;
  }

  accelerate() {
    this.targetSpeed = Math.min(this.targetSpeed * ACCEL_RATE, TARGET_SPEED_MAX);
  }

  /* 활성 구멍 중 가장 가까운 공까지의 거리 (발광 강도용) */
  nearestBallDistance() {
    let best = Infinity;
    for (const b of this.balls) {
      for (const [hx, hy] of this.activeHoles) {
        const d = Math.hypot(hx - b.x, hy - b.y);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /* 구멍마다 따로 — 다구멍 모드에서 각 구멍이 독립적으로 발광한다. */
  nearestDistancePerHole() {
    return this.activeHoles.map(([hx, hy]) => {
      let best = Infinity;
      for (const b of this.balls) {
        const d = Math.hypot(hx - b.x, hy - b.y);
        if (d < best) best = d;
      }
      return best;
    });
  }

  /* 다음 게임 준비 — 통계(freq/totalGames)는 건드리지 않는다. */
  resetDraw() {
    this.balls = [];
    this.drawnNumbers = [];
    this.targetSpeed = TARGET_SPEED_INIT;
    this.elapsedMs = 0;
    this._nextAccelMs = ACCEL_INTERVAL_MS;
  }

  recordDraw(numbers) {
    this.totalGames++;
    for (const n of numbers) this.freq[n]++;
  }

  resetStats() {
    this.freq = new Array(46).fill(0);
    this.holeHits = [0, 0, 0, 0];
    this.totalGames = 0;
  }

  /* [번호, 횟수] 내림차순. 동률은 번호 오름차순 — 표시 순서가 흔들리지 않게. */
  sortedFreq() {
    const out = [];
    for (let n = 1; n <= 45; n++) out.push([n, this.freq[n]]);
    out.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    return out;
  }

  /* 한 게임을 끝까지 헤드리스로 돌린다 (셀프테스트·조건 필터 재추첨용).
   * maxTicks 안에 6개를 못 채우면 timeout:true 로 반환한다.
   * 기본 20000틱 = 물리시간 560초 — 정상 게임은 1구멍도 2000틱 안쪽. */
  runHeadless(maxTicks = 20000) {
    this.resetDraw();
    this.createAllBalls();
    const holeOf = [];
    for (let t = 0; t < maxTicks; t++) {
      const cap = this.step();
      if (cap) holeOf.push(cap.holeIndex);
      if (this.drawnNumbers.length >= 6) {
        return {
          numbers: this.drawnNumbers.slice().sort((a, b) => a - b),
          order: this.drawnNumbers.slice(),
          holes: holeOf,
          ticks: t + 1,
          timeout: false,
        };
      }
    }
    return {
      numbers: this.drawnNumbers.slice().sort((a, b) => a - b),
      order: this.drawnNumbers.slice(),
      holes: holeOf,
      ticks: maxTicks,
      timeout: true,
    };
  }
}
