/* ============================================================================
 * 08-app.js — 애플리케이션 (상태 흐름 · UI 배선)
 *
 * 원본: LottoMachine + LottoUI
 *
 * 원본에서 고친 버그
 *   · start_draw가 can_start 검사보다 먼저 타이머를 죽여서, 카운트다운 중
 *     시작 버튼을 누르면 자동 진행이 조용히 멈춰버렸다 → 검사를 먼저 한다.
 *   · 발표 오버레이(TTS OFF)가 예약한 타이머를 아무도 취소하지 않아서,
 *     리셋을 누르면 죽은 콜백이 되살아나 화면을 덮고 콜백 체인을 터뜨렸다
 *     → 모든 타이머를 한 곳에서 관리하고 리셋/숨김에서 전부 취소한다.
 *   · 목표 게임 수에 도달하면 자동진행 체크가 꺼지는데, 그게 설정 파일에
 *     "사용자가 껐다"로 저장됐다 → 저장하지 않는다.
 *   · 테두리 깜빡임이 패널색(#112240)으로 끝나서 캔버스 금테가 사라졌다
 *     → 원래 금색으로 되돌린다.
 *   · 6번째 공 포획음의 앞 두 음이 둘 다 880Hz라 한 음으로 뭉갰다
 *     → 사이에 짧은 무음을 넣는다.
 * ========================================================================== */
'use strict';

/* 버전은 여기 한 곳에만 둔다. 원본은 APP_VERSION이 1.9.9에 멈춘 채 파일명만
 * v1.9.11로 올라가 있었다 — 한 곳만 고치면 되게 만들어 놓고도 갱신을 놓친 것이다.
 * 화면(설정 탭)과 백업 파일이 모두 이 상수를 읽는다. */
const APP_VERSION = '2.1.0';
const BASED_ON = '로또추첨기FHD v1.9.11 (Python/Tkinter)';

/* ── 타이밍 상수 (원본 계승) ─────────────────────────────────────────────── */
const COUNTDOWN_SEC = 10;
const REVEAL_DELAY_MS = 300;
const REVEAL_INTERVAL_MS = 400;
const REVEAL_BREATH_MS = 80;
const OVERLAY_HOLD_MS = 700;
const READY_HOLD_MS = 500;
const TTS_POLL_MS = 40;
const TTS_LATCH_MS = 60;
const TTS_MAX_WAIT_MS = 4000;   // 음성이 끝났다는 신호를 못 받아도 여기서 넘어간다
const BORDER_FLASH_MS = 120;
const BORDER_FLASH_STEPS = ['#ffffff', '#FFD700', '#ffffff', '#FFD700', '#ffffff', '#FFD700'];

/* ── 타이머 관리 ──────────────────────────────────────────────────────────
 * 원본이 죽은 콜백에 물린 이유는 setTimeout 핸들을 아무도 안 들고 있어서다.
 * 여기서는 이름표를 붙여 보관하고, 리셋 한 번이면 전부 사라진다. */
class Timers {
  constructor() { this.map = new Map(); }
  set(name, fn, ms) {
    this.clear(name);
    this.map.set(name, setTimeout(() => { this.map.delete(name); fn(); }, ms));
  }
  clear(name) {
    const id = this.map.get(name);
    if (id !== undefined) { clearTimeout(id); this.map.delete(name); }
  }
  clearAll() {
    for (const id of this.map.values()) clearTimeout(id);
    this.map.clear();
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/* 번호 목록 파싱.
 * 한글 IME가 켜진 상태로 숫자를 치면 전각("１２")이 섞여 들어온다. 그대로
 * parseInt하면 NaN이라 조용히 무시되고, 사용자는 왜 저장이 안 되는지 모른다.
 * NFKC 정규화가 전각을 반각으로 접어준다. 구분자는 뭐든 받는다. */
function parseNumbers(text) {
  return (String(text).normalize('NFKC').match(/\d+/g) || [])
    .map(Number)
    .filter(n => n >= 1 && n <= 45);
}

function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── 워커 풀 ──────────────────────────────────────────────────────────────
 * 물리 코드는 파일 안에 정확히 한 벌만 존재한다. id="core-src" 스크립트의
 * 텍스트를 메인 스레드가 실행하고, 같은 문자열을 Blob으로 만들어 워커도
 * 실행한다. "화면에서 도는 물리"와 "검정이 채점한 물리"가 같은 코드라는 게
 * 코드 구조 자체로 보장된다 — 이게 공정성 주장의 근거다. */
let _workerUrl = null;
function workerUrl() {
  if (_workerUrl) return _workerUrl;
  const core = document.getElementById('core-src').textContent;
  const glue = document.getElementById('worker-glue').textContent;
  _workerUrl = URL.createObjectURL(new Blob([core + '\n' + glue], { type: 'text/javascript' }));
  return _workerUrl;
}

/* 워커를 쓸 수 있는가.
 * index.html을 더블클릭해서 열면 문서 origin이 opaque("null")가 되고,
 * 크롬은 그런 문서에서 blob: 워커 생성을 SecurityError로 막는다.
 * 파이어폭스는 대체로 허용한다 — 브라우저를 짐작하지 말고 실제로 만들어 본다.
 * GitHub Pages(https)에 올리면 어디서든 정상 동작하므로, 이건 로컬 실행 전용 폴백이다. */
let _workerOk = null;
function workersAvailable() {
  if (_workerOk !== null) return _workerOk;
  try {
    const w = new Worker(workerUrl());
    w.terminate();
    _workerOk = true;
  } catch (e) {
    console.warn('워커를 만들 수 없습니다 — 메인 스레드로 폴백합니다.', e);
    _workerOk = false;
  }
  return _workerOk;
}

function workerCount() {
  if (!workersAvailable()) return 1;
  /* hardwareConcurrency는 믿을 게 못 된다. 구형 사파리는 undefined를 주고,
   * 휴대폰은 효율 코어까지 합쳐 8을 보고하지만 실제 성능 코어는 2~4개다.
   * 그 수만큼 띄우면 발열 스로틀로 오히려 느려진다. */
  const hc = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return Math.max(1, Math.min(coarse ? 3 : 6, hc - 1));
}

/* 워커를 못 쓸 때 메인 스레드 시간분할이 실제로 얼마나 느린가.
 * 프레임당 12ms만 쓰고 rAF를 기다리므로 전용 워커보다 훨씬 느리다.
 * 실측(데스크톱 크롬): 500게임 예측 1.9초 vs 실제 10초 → 약 5배.
 * 예상 시간을 워커 기준으로 그대로 보여주면 5배 낙관적인 거짓말이 된다. */
const FALLBACK_SLOWDOWN = 5;

/* 워커 없이 메인 스레드에서 시간분할로 도는 대체 실행기.
 * 프레임당 budgetMs만 쓰고 rAF로 양보하므로 화면이 얼지 않는다.
 * onChunk(진행분)를 호출하고, done이면 결과를 resolve한다. */
function runSliced({ budgetMs = 12, step, onProgress }) {
  return new Promise((resolve) => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const t0 = performance.now();
      let done = null;
      while (performance.now() - t0 < budgetMs) {
        done = step();
        if (done) break;
      }
      onProgress?.();
      if (done) resolve(done);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    resolve.cancel = () => { cancelled = true; };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 앱
 * ════════════════════════════════════════════════════════════════════════ */
class App {
  constructor() {
    this.cfg = new Config();
    this.store = new Storage();
    this.timers = new Timers();
    this.sm = new StateMachine((to) => this.onStateChange(to));

    this.params = new URLSearchParams(location.search);
    this.broadcast = this.params.get('broadcast') === '1' || this.params.get('obs') === '1';

    this.applyUrlOverrides();

    this.engine = new LottoEngine({ holeCount: this.cfg.get('holeCount') });
    this.renderer = new Renderer($('#field'));

    this.acc = 0;
    this.lastT = 0;
    this.droppedSteps = 0;
    this.filterTries = 0;      // 이번 판을 얻기까지 버린 판 수
    this.filterDiscarded = 0;  // 세션 누적 폐기 수
    this.searchWorkers = [];
    this.testWorkers = [];
    this.msPerDraw = { 1: 12, 2: 7, 4: 4 };   // 시작 시 실측으로 덮어쓴다

    this.buildUI();
    this.bindEvents();
    this.applyConfig();
    this.spawnBalls();
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);

    this.calibrate();
    if (this.broadcast) this.enterBroadcast();
    if (this.params.get('autostart') === '1') {
      /* 자동 시작은 소리 잠금과 정면으로 부딪힌다. 브라우저는 사용자가 한 번
       * 건드리기 전엔 소리를 안 내주므로, 무음으로 시작하되 배지를 띄운다. */
      this.timers.set('autostart', () => this.startDraw(), 900);
    }
  }

  /* ── URL 파라미터 ────────────────────────────────────────────────────────
   * OBS 브라우저 소스에는 설정 화면이 없다. 그래서 방송에 필요한 상태는
   * 전부 URL로 넣을 수 있어야 한다. 이게 방송 모드의 실질적인 계약이다. */
  applyUrlOverrides() {
    const p = this.params;
    const num = (k, lo, hi) => {
      const v = parseInt(p.get(k), 10);
      return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
    };
    const bool = (k) => (p.has(k) ? p.get(k) === '1' || p.get(k) === 'true' : null);

    /* ★ 저장하지 않는다.
     * OBS 브라우저 소스 링크는 대개 방송용 설정(4구멍·자동진행·특정 회차)을
     * 달고 있다. 그걸 localStorage에 써버리면, 나중에 같은 브라우저에서 앱을
     * 그냥 열었을 때 사용자가 만진 적 없는 설정이 남아 있게 된다.
     * persist=1을 명시했을 때만 저장한다. */
    const persist = bool('persist') === true;
    const put = (k, v) => (persist ? this.cfg.set(k, v) : this.cfg.setTransient(k, v));

    const round = num('round', 1, 99999);
    if (round !== null) put('round', round);
    if (p.has('suffix')) put('roundSuffix', p.get('suffix').slice(0, 20));
    const holes = num('holes', 1, 4);
    if (holes !== null && [1, 2, 4].includes(holes)) put('holeCount', holes);
    const games = num('games', 1, 500);
    if (games !== null && MAX_GAMES_OPTIONS.includes(games)) put('maxGames', games);
    for (const [k, key] of [['sound', 'soundOn'], ['tts', 'ttsOn'], ['auto', 'autoPlay']]) {
      const v = bool(k);
      if (v !== null) put(key, v);
    }
    this.transparent = bool('transparent') === true;
  }

  /* 이 기기에서 헤드리스 한 판이 실제로 몇 ms인지 잰다.
   * 조건 필터의 "찾는 데 N초" 예상이 상수 추정이면 몇 배씩 틀린다. */
  calibrate() {
    setTimeout(() => {
      for (const hc of [1, 2, 4]) {
        const e = new LottoEngine({ holeCount: hc, rng: makeRng(1) });
        const times = [];
        for (let i = 0; i < 12; i++) {
          e.rng = makeRng((i * 2654435761) >>> 0);
          const t0 = performance.now();
          e.runHeadless();
          times.push(performance.now() - t0);
        }
        /* 평균이 아니라 중앙값. 첫 한두 판은 JIT 워밍업으로 몇 배 느려서
         * 평균을 쓰면 "찾는 데 걸리는 시간" 예상이 통째로 부풀어 오른다. */
        times.sort((a, b) => a - b);
        this.msPerDraw[hc] = times[Math.floor(times.length / 2)];
      }
      this.updateFilterAnalysis();
      this.updateTestEta();
    }, 400);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 메인 루프 — 고정 28ms 물리 + 화면 주사율 보간
   * ════════════════════════════════════════════════════════════════════ */
  loop(now) {
    requestAnimationFrame(this.loop);
    if (!this.lastT) this.lastT = now;
    let dt = now - this.lastT;
    this.lastT = now;
    /* 탭이 백그라운드에 있다가 돌아오면 dt가 수십 초로 튄다. 그대로 두면
     * 물리를 수천 틱 몰아쳐서 화면이 멎는다 (spiral of death). 잘라낸다. */
    if (dt > 140) dt = 140;

    if (this.sm.isRunning()) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYSICS_STEP_MS && steps < 5) {
        for (const b of this.engine.balls) { b.rx = b.x; b.ry = b.y; }
        const cap = this.engine.step();
        this.acc -= PHYSICS_STEP_MS;
        steps++;
        if (cap) { this.onCapture(cap); if (!this.sm.isRunning()) break; }
      }
      if (this.acc > PHYSICS_STEP_MS) { this.droppedSteps++; this.acc = PHYSICS_STEP_MS; }
      this.updateGlow();
    } else {
      this.acc = 0;
      for (const b of this.engine.balls) { b.rx = b.x; b.ry = b.y; }
    }

    const alpha = this.cfg.get('smoothRender') ? Math.min(1, this.acc / PHYSICS_STEP_MS) : 1;
    this.renderer.draw(this.engine.balls, alpha, { borderColor: this._borderColor });
  }

  updateGlow() {
    const g = [0, 0, 0, 0];
    const idx = this.engine.activeHoleIndices;
    const dists = this.engine.nearestDistancePerHole();
    idx.forEach((holeIdx, i) => { g[holeIdx] = glowTier(dists[i]); });
    this.renderer.holeGlow = g;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 추첨 흐름
   * ════════════════════════════════════════════════════════════════════ */
  spawnBalls(seed) {
    this.engine.rng = seed === undefined ? makeRng() : makeRng(seed);
    this.engine.resetDraw();
    this.engine.createAllBalls();
    for (const b of this.engine.balls) { b.rx = b.x; b.ry = b.y; }
    this.updateGlow();
  }

  async startDraw() {
    // ★ 원본 버그: 여기서 타이머부터 죽이고 나서 검사했다.
    //   카운트다운 중 시작을 누르면 자동 진행이 조용히 멈췄다.
    if (!this.sm.canStart()) return;
    /* 시드 탐색 중에는 상태가 아직 IDLE이라 canStart()가 true다.
     * 그 사이 시작을 또 누르면 워커 풀이 통째로 미아가 되고,
     * 곧이어 RUNNING→RUNNING 전이가 예외를 던진다. */
    if (this._searching) return;
    this.timers.clearAll();
    this.setCountdown('');
    this.hideOverlay('statsOv');
    Beeper.unlock();

    if (!this.store.session) this.store.startSession(this.cfg.get('round'), this.cfg.get('roundSuffix'));

    let seed;
    this.filterTries = 1;
    const filterOn = this.cfg.get('filterOn') && !isFilterTrivial(this.cfg.get('filter'));

    if (filterOn) {
      const found = await this.searchFilteredSeed();
      if (!found) return;             // 사용자가 취소했거나 못 찾음
      seed = found.seed;
      this.filterTries = found.tried;
      this.filterDiscarded += found.tried - 1;
      this.updateFilterBadge();
    }

    this.sm.transition(GameState.RUNNING);
    this.spawnBalls(seed);
    this.acc = 0;
    this.droppedSteps = 0;

    SFX.start();
    if (Speaker.enabled) Speaker.speakFixed('start');
    this.resetSlots();
    this.setStatus('추첨 중…  공이 구멍 안으로 완전히 들어가야 합니다');
    this.updateCombLine([]);
  }

  onCapture({ ball }) {
    const count = this.engine.drawnNumbers.length;
    const isLast = count === 6;

    SFX.capture(count, isLast);
    if (Speaker.enabled && this.cfg.get('speakOn') !== 'reveal') Speaker.speakNumber(ball.number);

    this.fillSlot(count - 1, ball.number);
    this.updateCombLine(this.engine.drawnNumbers);
    this.setStatus(`추첨 완료: ${count} / 6`);

    if (isLast) {
      this.timers.set('borderFlash', () => this.borderFlash(0), 100);
      this.finish();
    }
  }

  finish() {
    this.sm.transition(GameState.OVERLAY);
    this.setStatus('게임 완료!');
    this.renderer.holeGlow = [0, 0, 0, 0];

    const nums = this.engine.drawnNumbers.slice().sort((a, b) => a - b);
    this.store.saveResult(nums, { holeCount: this.engine.holeCount, tries: this.filterTries });
    this.engine.recordDraw(nums);
    this.updateCounter();
    this.renderHistory();
    this.renderMyNumbers();   // 방금 뽑은 조합도 바로 대조표에 올라와야 한다

    // ★ 원본과 동일한 래치 방식: 여기서 한 번 판정해 두고 오버레이 후에 읽는다.
    this._reachedMax = this.engine.totalGames >= this.cfg.get('maxGames');

    this.showReveal(nums);
  }

  afterOverlay() {
    this.engine.balls = [];
    const reached = this._reachedMax;
    this._reachedMax = false;

    if (reached) {
      this.showStats();
      this.engine.resetStats();
      this.updateCounter();
      this.store.endSession();
      this.sm.transition(GameState.COMPLETED);
      this.sm.transition(GameState.IDLE, true);
      // ★ 원본은 이 자동 해제를 설정 파일에 저장해버렸다. 저장하지 않는다.
      $('#autoPlay').checked = false;
      this._autoRuntime = false;
      SFX.complete();
      if (Speaker.enabled) Speaker.speakFixed('complete');
      this.setStatus(`${this.cfg.get('maxGames')}게임 완료! 결과가 저장되었습니다.`);
    } else if (this._autoRuntime) {
      this.sm.transition(GameState.COUNTDOWN);
      this.countdownLeft = COUNTDOWN_SEC;
      this.showStats();
      this.tickCountdown();
    } else {
      this.sm.transition(GameState.IDLE);
      this.setStatus('추첨 시작 버튼을 눌러주세요');
    }
  }

  tickCountdown() {
    if (!this.sm.isCountdown()) { this.setCountdown(''); this.hideOverlay('statsOv'); return; }
    if (this.countdownLeft <= 0) {
      this.setCountdown('');
      this.hideOverlay('statsOv');
      this.sm.transition(GameState.IDLE);
      this.startDraw();
      return;
    }
    this.setCountdown(`다음 게임까지 ${this.countdownLeft}초`);
    SFX.countdownTick(this.countdownLeft);
    this.countdownLeft--;
    this.timers.set('countdown', () => this.tickCountdown(), 1000);
  }

  reset() {
    this.timers.clearAll();
    /* ★ abortSearch()는 워커만 죽인다. 취소 클로저를 부르지 않으면
     *   · 메인스레드 폴백: rAF 탐색이 계속 돌다가 리셋한 지 한참 뒤에
     *     제 발로 추첨을 시작해버린다.
     *   · 워커 경로: 대기 중인 Promise가 영영 안 풀려 시작 버튼이 잠긴다. */
    if (this._cancelSearch) this._cancelSearch();
    this.abortSearch();
    Speaker.cancel();
    this.sm.transition(GameState.IDLE, true);
    /* IDLE→IDLE 은 전이가 아니라서 onStateChange 가 안 불린다.
     * 그래서 리셋해도 잠긴 컨트롤이 안 풀리는 경우가 있었다 — 직접 부른다. */
    this.onStateChange();
    this._reachedMax = false;
    this.hideOverlay('reveal');
    this.hideOverlay('statsOv');
    this.setCountdown('');
    this._borderColor = '#FFD700';
    this.spawnBalls();
    this.resetSlots();
    this.updateCombLine([]);
    this.setStatus('리셋 완료. 추첨 시작 버튼을 눌러주세요');
  }

  onStateChange() {
    const idle = this.sm.isIdle() || this.sm.isCompleted();
    this.refreshStartButton();
    $('#holeBtn').disabled = !idle;
    $('#roundInput').disabled = !idle;
    $('#suffixInput').disabled = !idle;
    $('#maxGames').disabled = !idle;
    $('#filterOn').disabled = !idle;
  }

  /* ── 조건 필터: 시드 탐색 ────────────────────────────────────────────────
   * 조건을 만족하는 판이 나올 때까지 헤드리스로 굴린다. 통과한 판의 시드를
   * 화면 물리에 그대로 넣으므로, 시청자가 보는 공의 움직임이 실제로 그 번호를
   * 만들어낸다. 몇 판을 버렸는지는 무대 위에 그대로 표시한다. */
  searchFilteredSeed() {
    const filter = normalizeFilter(this.cfg.get('filter'));
    const holeCount = this.engine.holeCount;
    const maxAttempts = 400_000;

    /* 워커를 몇 개 쓸지는 "폐기 판수를 정확히 셀 수 있는가"로 정한다.
     * 워커를 여러 개 띄우면, 하나가 답을 찾는 순간 나머지를 강제 종료하는데
     * 그때 아직 보고되지 않은 잔여분(워커당 최대 24판)이 사라진다.
     * 짧은 탐색에서는 그 오차가 전체의 절반을 넘길 수도 있다 — 화면에
     * "폐기 8판"이라 써놓고 실제로는 60판을 버린 셈이 된다.
     * 그래서 예상 시도가 적으면 워커 1개로 정확히 세고(어차피 순식간),
     * 길어질 때만 병렬로 간다(그때는 잔여분이 0.1% 수준이라 무해). */
    const est = analyzeFilter(filter);
    const expected = est.ok ? est.expectedTries : Infinity;
    const n = expected < 3000 ? 1 : workerCount();

    this._searching = true;
    this.setStatus('조건에 맞는 추첨을 찾는 중…');
    $('#searchBox').hidden = false;
    $('#searchTried').textContent = '0';
    $('#startBtn').disabled = true;
    /* 탐색은 동결된 조건 스냅샷으로 돈다. 도중에 조건이 바뀌면 시도마다
     * 채택 규칙이 달라져 "조건을 만족하는 조합 위의 균등분포"가 깨진다. */
    this.lockFilterInputs(true);

    if (!workersAvailable()) return this.searchOnMainThread(filter, holeCount, maxAttempts);

    return new Promise((resolve) => {
      let settled = false;
      let tried = 0;
      const url = workerUrl();
      this.searchWorkers = [];

      const done = (result) => {
        if (settled) return;
        settled = true;
        this._searching = false;
        this._cancelSearch = null;   // 낡은 클로저가 다시 불리지 않게
        this.abortSearch();
        this.refreshStartButton();
        resolve(result);
      };

      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        this.searchWorkers.push(w);
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'progress') {
            tried += m.delta;
            $('#searchTried').textContent = tried.toLocaleString();
          } else if (m.type === 'found') {
            tried += m.delta || 0;
            done({ seed: m.seed, numbers: m.numbers, tried: Math.max(1, tried) });
          } else if (m.type === 'exhausted') {
            this.setStatus('조건을 만족하는 추첨을 찾지 못했습니다. 조건을 완화해 주세요.');
            done(null);
          }
        };
        w.onerror = () => done(null);
        w.postMessage({
          cmd: 'search', filter, holeCount,
          maxAttempts: Math.ceil(maxAttempts / n),
        });
      }

      this._cancelSearch = () => { this.setStatus('조건 추첨을 취소했습니다.'); done(null); };
    });
  }

  /* 워커를 못 쓰는 환경(로컬 file:// 등)의 폴백.
   * 같은 물리·같은 판정으로 돌되, 메인 스레드를 12ms씩만 빌려 쓴다. */
  searchOnMainThread(filter, holeCount, maxAttempts) {
    $('#searchNote').hidden = false;
    const engine = new LottoEngine({ holeCount });
    const seedRng = makeRng();
    let tried = 0;
    let cancelled = false;
    let settled = false;

    return new Promise((resolve) => {
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cancelled = true;
        this._searching = false;
        this._cancelSearch = null;
        this.lockFilterInputs(false);
        $('#searchBox').hidden = true;
        $('#searchNote').hidden = true;
        this.refreshStartButton();
        if (!result) this.setStatus('조건 추첨을 멈췄습니다.');
        resolve(result);
      };
      /* 다음 프레임까지 기다리지 않고 그 자리에서 끝낸다. 플래그만 세우면
       * 리셋 직후 한 프레임이 더 돌아 추첨이 제 발로 시작될 수 있다. */
      this._cancelSearch = () => finish(null);
      const tick = () => {
        if (cancelled || settled) return;
        const t0 = performance.now();
        while (performance.now() - t0 < 12) {
          if (tried >= maxAttempts) {
            this.setStatus('조건을 만족하는 추첨을 찾지 못했습니다. 조건을 완화해 주세요.');
            return finish(null);
          }
          const seed = seedRng.nextUint32();
          engine.rng = makeRng(seed);
          const r = engine.runHeadless();
          tried++;
          if (!r.timeout && filterAccepts(r.numbers, filter)) {
            return finish({ seed, numbers: r.numbers, tried });
          }
        }
        $('#searchTried').textContent = tried.toLocaleString();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  lockFilterInputs(locked) {
    for (const id of ['oddMin', 'oddMax', 'sumMin', 'sumMax', 'maxRun', 'bandMax',
                      'prevOverlapMax', 'prevNumbers', 'filterOn', 'filterClear',
                      'usePrevWinning', 'holeBtn']) {
      const e = $('#' + id);
      if (e) e.disabled = locked;
    }
    $$('#numGrid button').forEach(b => { b.disabled = locked; });
  }

  abortSearch() {
    for (const w of this.searchWorkers) w.terminate();
    this.searchWorkers = [];
    this._searching = false;
    $('#searchBox').hidden = true;
    $('#searchNote').hidden = true;
    this.lockFilterInputs(false);
    // 어떤 경로로 들어와도 시작 버튼이 잠긴 채 남지 않게
    this.refreshStartButton();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 발표 오버레이
   * ════════════════════════════════════════════════════════════════════ */
  showReveal(nums) {
    const box = $('#reveal');
    const wrap = $('#revealNums');
    wrap.innerHTML = '';
    $('#revealTitle').textContent = '당첨 번호';
    $('#revealReady').hidden = true;
    wrap.hidden = false;

    this._revealNodes = nums.map(n => {
      const node = el('div', { class: 'n' }, String(n));
      node.style.background = ballColor(n);
      node.style.color = '#0b1420';
      wrap.append(node);
      return node;
    });

    box.classList.add('show');

    /* 발표 방식이 도중에 바뀌면 체인이 어긋난다 (원본의 실제 버그).
     * 오버레이가 뜨는 순간의 상태로 못 박고, 끝날 때까지 그 방식으로 간다. */
    const ttsMode = Speaker.enabled && Speaker.available;
    if (ttsMode) {
      /* ★ 포획 때 읽은 번호들이 아직 큐에 남아 있다. isBusy()는 그것까지 세므로
       * 그대로 두면 첫 번호 발표가 4초 가까이 밀린다 (원본도 같은 문제였다).
       * 포획 안내는 이미 제 역할을 했으니 여기서 끊고 발표를 새로 시작한다. */
      Speaker.cancel();
      this.timers.set('reveal', () => this.revealChain(0, nums), REVEAL_DELAY_MS);
    } else {
      /* ★ 원본은 마지막 번호 뒤에 간격을 한 번 더 세서(len 대신 len-1이어야 함)
       *   전환이 400ms 늦었다. 여기서는 정확히 (n-1)번의 간격만 센다. */
      nums.forEach((n, i) => {
        this.timers.set(`rev${i}`, () => this.revealOne(i, n), REVEAL_DELAY_MS + i * REVEAL_INTERVAL_MS);
      });
      const total = REVEAL_DELAY_MS + (nums.length - 1) * REVEAL_INTERVAL_MS + OVERLAY_HOLD_MS;
      this.timers.set('revealEnd', () => this.toReady(), total);
    }
  }

  /* TTS ON — 화면과 음성을 1:1로 교대시킨다.
   * 고정 간격으로 돌리면 "삼십이번" 같은 긴 발음이 밀려서 마지막 두세 개가 잘린다. */
  revealChain(i, nums) {
    if (!$('#reveal').classList.contains('show')) return;   // 리셋됨
    if (i >= nums.length) { this.toReady(); return; }

    this.revealOne(i, nums[i]);

    const started = performance.now();
    const poll = () => {
      if (!$('#reveal').classList.contains('show')) return;
      const waited = performance.now() - started;
      // 큐에 실릴 시간을 조금 주고, 신호를 못 받아도 상한에서 넘어간다
      if ((waited > TTS_LATCH_MS && !Speaker.isBusy()) || waited > TTS_MAX_WAIT_MS) {
        this.timers.set('chain', () => this.revealChain(i + 1, nums), REVEAL_BREATH_MS);
      } else {
        this.timers.set('poll', poll, TTS_POLL_MS);
      }
    };
    this.timers.set('poll', poll, TTS_LATCH_MS);
  }

  revealOne(i, n) {
    const node = this._revealNodes?.[i];
    if (node) node.classList.add('in');
    SFX.reveal(i);
    if (Speaker.enabled && this.cfg.get('speakOn') !== 'capture') Speaker.speakNumber(n);
  }

  toReady() {
    $('#revealNums').hidden = true;
    $('#revealTitle').textContent = '';
    $('#revealReady').hidden = false;
    this.timers.set('ready', () => {
      this.hideOverlay('reveal');
      this.afterOverlay();
    }, READY_HOLD_MS);
  }

  hideOverlay(id) {
    $('#' + id).classList.remove('show');
    if (id === 'reveal') {
      for (const k of ['reveal', 'revealEnd', 'chain', 'poll', 'ready']) this.timers.clear(k);
      for (let i = 0; i < 6; i++) this.timers.clear('rev' + i);
    }
  }

  /* ── 통계 오버레이 ─────────────────────────────────────────────────────── */
  showStats() {
    const total = this.engine.totalGames;
    if (!total) return;

    /* 한 번도 안 나온 번호는 빼고 센다.
     * 게임 수가 적으면 나온 번호가 20개도 안 되는데, 그대로 20줄을 채우면
     * 0회짜리 번호가 "TOP 20" 안에 들어앉고 최소폭 때문에 막대까지 그려진다.
     * 안 나온 번호를 순위표에 올리는 건 그냥 틀린 표시다. */
    const freq = this.engine.sortedFreq().filter(([, c]) => c > 0).slice(0, 20);
    if (!freq.length) return;
    const max = freq[0][1];

    const body = $('#statsBody');
    body.innerHTML = '';
    freq.forEach(([n, c], i) => {
      const bar = el('i', { class: 'bar' });
      // 최다 출현 번호를 100%로 두고 나머지를 그 비율로 그린다 (3회 : 2회 = 100% : 67%)
      bar.style.width = (c / max) * 100 + '%';
      bar.style.background = ballColor(n);
      const ball = el('span', { class: 'mini-ball' }, String(n));
      ball.style.background = ballColor(n);
      body.append(el('div', { class: 'freq-row' },
        el('span', { class: 'rank' }, `${i + 1}위`),
        ball,
        el('span', { class: 'bar-wrap' }, bar),
        el('span', { class: 'cnt' }, `${c}회`),
      ));
    });

    $('#statsTitle').textContent = freq.length >= 20
      ? `누적 ${total}게임 · 번호 출현 TOP 20`
      : `누적 ${total}게임 · 나온 번호 ${freq.length}개`;
    $('#statsOv').classList.add('show');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 무대 표시
   * ════════════════════════════════════════════════════════════════════ */
  resetSlots() {
    $$('#slots .slot').forEach((s, i) => {
      s.className = 'slot';
      s.textContent = '';
      s.setAttribute('aria-label', `${i + 1}번째 공`);
      s.style.background = '';
      s.style.borderColor = '';
    });
  }

  fillSlot(i, n) {
    const s = $$('#slots .slot')[i];
    if (!s) return;
    s.className = 'slot filled pop';
    s.textContent = String(n);
    s.setAttribute('aria-label', `${i + 1}번째 공 ${n}번`);
    s.style.background = ballColor(n);
    s.style.color = '#0b1420';
  }

  /* 폰에서는 이 한 줄이 캔버스보다 중요하다 — 조합의 성격을 즉시 알려준다.
   * 조건 필터가 켜져 있으면 위반 항목을 빨갛게 물들인다. */
  updateCombLine(nums) {
    const line = $('#combLine');
    if (!nums.length) { line.innerHTML = ''; return; }
    const st = combStats(nums);
    /* 위반 표시는 6개가 다 나온 뒤에만 한다. 추첨 도중의 부분 합계는 당연히
     * 하한 미만이라, 그때 빨갛게 칠하면 "조건을 어겼다"는 거짓 신호가 된다. */
    const f = (this.cfg.get('filterOn') && st.count === 6) ? normalizeFilter(this.cfg.get('filter')) : null;
    const bad = (cond) => (f && cond ? ' bad' : '');
    line.innerHTML = '';
    line.append(
      el('span', { class: 'item' + bad(st.sum < f?.sumMin || st.sum > f?.sumMax) }, '합계 ', el('b', {}, st.sum)),
      el('span', { class: 'item' + bad(st.odd < f?.oddMin || st.odd > f?.oddMax) }, '홀', el('b', {}, st.odd), ':짝', el('b', {}, st.even)),
      el('span', { class: 'item' + bad(f && st.maxRun > f.maxRun) }, '최대연속 ', el('b', {}, st.maxRun)),
      el('span', { class: 'item' }, '끝수합 ', el('b', {}, st.tailSum)),
    );
  }

  setStatus(t) { $('#status').textContent = t; }
  setCountdown(t) {
    const c = $('#countdown');
    c.textContent = t;
    c.classList.toggle('show', !!t);
  }
  updateCounter() {
    $('#counter').textContent = `${this.engine.totalGames} / ${this.cfg.get('maxGames')} 게임`;
  }
  updateTitle() {
    const sfx = this.cfg.get('roundSuffix');
    const t = `제 ${this.cfg.get('round')}회${sfx ? ' ' + sfx : ''} 로또 예상번호 추첨`;
    $('#stageTitle').textContent = t;
    document.title = t;
  }
  updateFilterBadge() {
    const on = this.cfg.get('filterOn') && !isFilterTrivial(this.cfg.get('filter'));
    $('#app').dataset.filter = on ? 'on' : 'off';
    // 조건이 켜지면 순수성 선언이 그대로 적용되지 않는다는 사실을 설정 탭에 띄운다
    const note = $('#purityFilterNote');
    if (note) note.hidden = !on;
    if (on) $('#filterDiscard').textContent = `조건 추첨 · 폐기 ${this.filterDiscarded.toLocaleString()}판`;
  }

  borderFlash(step) {
    if (step >= BORDER_FLASH_STEPS.length) {
      // ★ 원본은 패널색으로 끝나서 캔버스 금테가 사라졌다. 금색으로 되돌린다.
      this._borderColor = '#FFD700';
      $('#stage').classList.remove('flash');
      return;
    }
    this._borderColor = BORDER_FLASH_STEPS[step];
    $('#stage').classList.toggle('flash', step % 2 === 0);
    this.timers.set('borderFlash', () => this.borderFlash(step + 1), BORDER_FLASH_MS);
  }

  /* 무대 스케일 단위 — 무대 안쪽 치수가 전부 여기 비례한다.
   * 폰에서 글씨가 못 읽을 만큼 작아지지 않게 하한을 둔다. */
  resize() {
    const stage = $('#stage');
    const r = stage.getBoundingClientRect();
    const su = Math.max(0.30, Math.min(1.25, r.width / 1920));
    stage.style.setProperty('--su', su.toFixed(4));

    const wrap = $('#fieldWrap');
    const fr = wrap.getBoundingClientRect();
    this.renderer.resize(Math.max(1, fr.width), Math.max(1, fr.height));
  }

  /* ══════════════════════════════════════════════════════════════════════
   * UI 구성 · 배선
   * ════════════════════════════════════════════════════════════════════ */
  buildUI() {
    // 슬롯 6개
    const slots = $('#slots');
    for (let i = 0; i < 6; i++) {
      // role="list" 컨테이너에 listitem 이 없으면 스크린리더는 빈 목록으로 읽는다
      slots.append(el('div', { class: 'slot', role: 'listitem', 'aria-label': `${i + 1}번째 공` }));
    }

    // 게임 수 옵션
    const mg = $('#maxGames');
    for (const v of MAX_GAMES_OPTIONS) mg.append(el('option', { value: v }, `${v}게임`));

    // 번호 선택 격자 (제외수/고정수) — 클릭하면 없음 → 고정 → 제외 → 없음
    const grid = $('#numGrid');
    for (let n = 1; n <= 45; n++) {
      grid.append(el('button', { type: 'button', 'data-n': n, title: `${n}번` }, String(n)));
    }
  }

  applyConfig() {
    const c = this.cfg;
    document.documentElement.dataset.theme = c.get('theme');
    $('#roundInput').value = c.get('round');
    $('#suffixInput').value = c.get('roundSuffix');
    $('#maxGames').value = c.get('maxGames');
    $('#autoPlay').checked = c.get('autoPlay');
    this._autoRuntime = c.get('autoPlay');
    $('#smoothRender').checked = c.get('smoothRender');
    $('#reduceMotion').checked = c.get('reduceMotion');
    $('#filterOn').checked = c.get('filterOn');
    $('#speakOn').value = c.get('speakOn');
    $('#versionInfo').textContent = `웹판 v${APP_VERSION} · 원본 ${BASED_ON}`;

    Beeper.setEnabled(c.get('soundOn'));
    $('#soundBtn').setAttribute('aria-pressed', String(c.get('soundOn')));
    this.syncTtsButton();

    this.renderer.reduceMotion = c.get('reduceMotion');
    this.renderer.transparent = !!this.transparent;
    this.renderer.holeCount = c.get('holeCount');
    this.engine.setHoleCount(c.get('holeCount'));
    $('#holeBtn').textContent = `🎯 ${c.get('holeCount')}구멍`;

    this.loadFilterIntoUI();
    this.updateTitle();
    this.updateCounter();
    this.updateFilterBadge();
    this.renderHistory();
    this.renderMyNumbers();
    this.onStateChange();
  }

  syncTtsButton() {
    const btn = $('#ttsBtn');
    const avail = Speaker.available;
    btn.disabled = !avail;
    const on = avail && this.cfg.get('ttsOn');
    Speaker.setEnabled(on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = avail
      ? `음성안내 ${on ? '켜짐' : '꺼짐'} — ${Speaker.voiceName}`
      : '이 브라우저에 한국어 음성이 설치돼 있지 않습니다';
    $('#ttsInfo').textContent = avail
      ? `사용 음성: ${Speaker.voiceName}`
      : '한국어 음성을 찾지 못했습니다. Windows·Android·iOS의 최신 브라우저에서 지원됩니다.';
  }

  bindEvents() {
    Speaker.onAvailabilityChange(() => this.syncTtsButton());

    $('#startBtn').onclick = () => this.startDraw();
    $('#resetBtn').onclick = () => this.reset();
    $('#searchCancel').onclick = () => this._cancelSearch?.();

    $('#soundBtn').onclick = (e) => {
      const on = !this.cfg.get('soundOn');
      this.cfg.set('soundOn', on);
      Beeper.setEnabled(on);
      if (on) Beeper.unlock();
      e.currentTarget.setAttribute('aria-pressed', String(on));
      this.checkAudioLock();
    };
    $('#ttsBtn').onclick = () => {
      if (!Speaker.available) return;
      this.cfg.set('ttsOn', !this.cfg.get('ttsOn'));
      this.syncTtsButton();
    };
    $('#holeBtn').onclick = () => {
      if (!this.sm.isIdle() && !this.sm.isCompleted()) return;
      const next = { 1: 2, 2: 4, 4: 1 }[this.cfg.get('holeCount')] || 1;
      this.cfg.set('holeCount', next);
      this.engine.setHoleCount(next);
      this.renderer.holeCount = next;
      this.renderer.holeGlow = [0, 0, 0, 0];
      $('#holeBtn').textContent = `🎯 ${next}구멍`;
      this.spawnBalls();
      this.updateFilterAnalysis();
    };

    $('#roundInput').onchange = (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isInteger(v) || v < 1 || v > 99999) { e.target.value = this.cfg.get('round'); return; }
      this.cfg.set('round', v);
      this.store.endSession();      // 회차가 바뀌면 새 세션으로 간다
      this.updateTitle();
      this.renderMyNumbers();
    };
    $('#suffixInput').onchange = (e) => {
      this.cfg.set('roundSuffix', e.target.value.slice(0, 20));
      this.store.endSession();
      this.updateTitle();
    };
    $('#maxGames').onchange = (e) => {
      this.cfg.set('maxGames', parseInt(e.target.value, 10));
      this.updateCounter();
    };
    $('#autoPlay').onchange = (e) => {
      this._autoRuntime = e.target.checked;
      this.cfg.set('autoPlay', e.target.checked);
    };
    $('#smoothRender').onchange = (e) => this.cfg.set('smoothRender', e.target.checked);
    $('#speakOn').onchange = (e) => this.cfg.set('speakOn', e.target.value);
    $('#reduceMotion').onchange = (e) => {
      this.cfg.set('reduceMotion', e.target.checked);
      this.renderer.reduceMotion = e.target.checked;
    };
    $('#themeBtn').onclick = () => {
      const t = this.cfg.get('theme') === 'dark' ? 'light' : 'dark';
      this.cfg.set('theme', t);
      document.documentElement.dataset.theme = t;
    };

    // 탭
    $$('.tab').forEach(t => {
      t.onclick = () => {
        $$('.tab').forEach(x => x.setAttribute('aria-selected', 'false'));
        t.setAttribute('aria-selected', 'true');
        $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + t.dataset.panel));
        this.cfg.set('panelTab', t.dataset.panel);
      };
    });
    const saved = $(`.tab[data-panel="${this.cfg.get('panelTab')}"]`);
    (saved || $$('.tab')[0])?.click();

    this.bindFilterEvents();
    this.bindMyNumberEvents();
    this.bindTestEvents();
    this.bindDataEvents();

    // 방송 링크 만들기
    $('#buildLink').onclick = () => this.buildBroadcastLink();
    $('#copyLink').onclick = async () => {
      const v = $('#linkOut').value;
      if (!v) return;
      try { await navigator.clipboard.writeText(v); $('#copyLink').textContent = '복사됨'; }
      catch { $('#linkOut').select(); document.execCommand?.('copy'); $('#copyLink').textContent = '복사됨'; }
      setTimeout(() => { $('#copyLink').textContent = '복사'; }, 1400);
    };

    $('#audioLock').onclick = () => { Beeper.unlock(); this.checkAudioLock(); };

    // 창 크기
    const ro = new ResizeObserver(() => this.resize());
    ro.observe($('#stage'));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));

    // 첫 제스처에서 소리 잠금 해제
    const unlock = () => { Beeper.unlock(); this.checkAudioLock(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // 단축키 — 원본 Space/R/S/T/H 계승
    window.addEventListener('keydown', (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      /* 버튼에 포커스가 있으면 Space·Enter 는 그 버튼을 눌러야 한다.
       * 가로채면 [리셋]으로 탭 이동해 Space 를 누른 사용자가 추첨을 시작하게 된다. */
      if (e.target.tagName === 'BUTTON' && (k === ' ' || k === 'spacebar' || k === 'enter')) return;
      // 화면에서 막아둔 동작을 단축키로 우회할 수 있으면 막아둔 의미가 없다
      if (k === ' ' || k === 'spacebar') {
        e.preventDefault();
        if (!$('#startBtn').disabled) this.startDraw();
      }
      else if (k === 'r') this.reset();
      else if (k === 's') $('#soundBtn').click();
      else if (k === 't') $('#ttsBtn').click();
      else if (k === 'h') $('#holeBtn').click();
      else if (k === 'b') this.toggleBroadcast();
      else if (k === 'escape' && this.broadcast) this.toggleBroadcast();
      else if (k === '?' && !$('#helpDlg').open) $('#helpDlg').showModal();
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.sm.isRunning()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  checkAudioLock() {
    const need = this.cfg.get('soundOn') && !Beeper.isUnlocked();
    $('#audioLock').classList.toggle('show', need);
  }

  /* ── 방송 모드 ─────────────────────────────────────────────────────────── */
  enterBroadcast() {
    this.broadcast = true;
    $('#app').dataset.mode = 'broadcast';
    if (this.transparent) $('#app').dataset.transparent = '1';
    setTimeout(() => this.resize(), 60);
    this.checkAudioLock();
  }
  toggleBroadcast() {
    if (this.broadcast) {
      this.broadcast = false;
      $('#app').dataset.mode = 'normal';
      $('#app').removeAttribute('data-transparent');
      setTimeout(() => this.resize(), 60);
    } else {
      this.enterBroadcast();
    }
  }

  buildBroadcastLink() {
    const p = new URLSearchParams();
    p.set('broadcast', '1');
    p.set('round', this.cfg.get('round'));
    if (this.cfg.get('roundSuffix')) p.set('suffix', this.cfg.get('roundSuffix'));
    p.set('holes', this.cfg.get('holeCount'));
    p.set('games', this.cfg.get('maxGames'));
    p.set('sound', this.cfg.get('soundOn') ? '1' : '0');
    p.set('tts', this.cfg.get('ttsOn') ? '1' : '0');
    if ($('#linkAuto').checked) p.set('auto', '1');
    if ($('#linkAutostart').checked) p.set('autostart', '1');
    if ($('#linkTransparent').checked) p.set('transparent', '1');
    $('#linkOut').value = location.origin + location.pathname + '?' + p.toString();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 조건 필터 패널
   * ════════════════════════════════════════════════════════════════════ */
  currentFilter() { return normalizeFilter(this.cfg.get('filter')); }

  loadFilterIntoUI() {
    const f = this.currentFilter();
    $('#oddMin').value = f.oddMin; $('#oddMax').value = f.oddMax;
    $('#sumMin').value = f.sumMin; $('#sumMax').value = f.sumMax;
    $('#maxRun').value = f.maxRun;
    $('#bandMax').value = f.bandMax;
    $('#prevOverlapMax').value = f.prevOverlapMax;
    $('#prevNumbers').value = f.prevNumbers.join(', ');
    $$('#numGrid button').forEach(b => {
      const n = +b.dataset.n;
      if (f.include.includes(n)) b.dataset.pick = 'include';
      else if (f.exclude.includes(n)) b.dataset.pick = 'exclude';
      else b.removeAttribute('data-pick');
    });
    $('#filterOn').checked = this.cfg.get('filterOn');
    /* 무대 배지도 여기서 같이 맞춘다. 이 함수가 "설정 → 화면" 동기화의
     * 단일 창구인데 배지만 빠져 있으면, 체크박스를 거치지 않는 경로(복원·
     * 프로그램적 변경)에서 조건이 켜졌는데 무대에는 표시가 안 되는 상태가 된다.
     * 조건 추첨을 쓰면서 그 사실이 화면에 안 뜨는 건 그냥 부정직한 화면이다. */
    this.updateFilterBadge();
    this.updateFilterAnalysis();
  }

  readFilterFromUI() {
    const include = [], exclude = [];
    $$('#numGrid button').forEach(b => {
      const n = +b.dataset.n;
      if (b.dataset.pick === 'include') include.push(n);
      else if (b.dataset.pick === 'exclude') exclude.push(n);
    });
    return normalizeFilter({
      include, exclude,
      oddMin: +$('#oddMin').value, oddMax: +$('#oddMax').value,
      sumMin: +$('#sumMin').value, sumMax: +$('#sumMax').value,
      maxRun: +$('#maxRun').value,
      bandMax: +$('#bandMax').value,
      prevOverlapMax: +$('#prevOverlapMax').value,
      prevNumbers: parseNumbers($('#prevNumbers').value),
    });
  }

  bindFilterEvents() {
    const commit = () => {
      const raw = this.readFilterFromUI();
      this.cfg.set('filter', raw);
      this.loadFilterIntoUI();   // 정규화 결과를 화면에 되비춘다 (조용한 보정 금지)
      this.updateFilterBadge();
    };

    // 번호 격자 — 없음 → 고정 → 제외 → 없음
    $('#numGrid').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const cur = b.dataset.pick;
      if (!cur) {
        /* 고정수는 5개까지. 6개를 고정하면 조합이 하나로 정해져 "추첨"이
         * 아니게 된다 — 순수성 선언과 정면으로 어긋난다. */
        const n = $$('#numGrid button[data-pick="include"]').length;
        if (n >= 5) {
          this.setFilterHint('warn',
            '고정수는 5개까지만 지정할 수 있습니다. 6개를 모두 고정하면 결과가 하나로 ' +
            '정해져 버려, 이 프로그램의 순수성 선언과 어긋납니다.');
          return;
        }
        b.dataset.pick = 'include';
      } else if (cur === 'include') b.dataset.pick = 'exclude';
      else b.removeAttribute('data-pick');
      commit();
    };

    for (const id of ['oddMin', 'oddMax', 'sumMin', 'sumMax', 'maxRun', 'bandMax', 'prevOverlapMax', 'prevNumbers']) {
      $('#' + id).oninput = () => {
        clearTimeout(this._filterDebounce);
        this._filterDebounce = setTimeout(commit, 260);
      };
    }

    $('#filterOn').onchange = (e) => {
      this.cfg.set('filterOn', e.target.checked);
      this.updateFilterBadge();
      this.updateFilterAnalysis();
    };
    $('#filterClear').onclick = () => {
      this.cfg.set('filter', { ...FILTER_DEFAULT });
      this.loadFilterIntoUI();
      this.updateFilterBadge();
    };
    $('#usePrevWinning').onclick = () => {
      const w = this.store.getWinning(this.cfg.get('round') - 1);
      if (!w) { this.setFilterHint('error', `${this.cfg.get('round') - 1}회 당첨번호가 저장돼 있지 않습니다. [내 번호] 탭에서 먼저 입력해 주세요.`); return; }
      $('#prevNumbers').value = w.n.join(', ');
      commit();
    };
  }

  setFilterHint(level, text, culprits) {
    const h = $('#filterHint');
    h.className = 'hint ' + level;
    h.textContent = text;
    const c = $('#filterCulprits');
    if (culprits && culprits.length) {
      c.hidden = false;
      c.innerHTML = '';
      c.append(el('div', { class: 'hint' }, '가장 크게 완화되는 조건: ' +
        culprits.map(x => `${x.label}`).join(' → ')));
    } else {
      c.hidden = true;
    }
  }

  updateFilterAnalysis() {
    const f = this.currentFilter();

    if (!this.cfg.get('filterOn')) {
      this.setFilterHint('', '조건 필터가 꺼져 있습니다. 순수 물리 추첨 결과를 그대로 사용합니다.');
      this._filterBlocks = false;
    } else if (isFilterTrivial(f)) {
      this.setFilterHint('ok', '아직 조건이 없습니다. 조건을 걸면 통과율과 예상 소요 시간이 여기에 표시됩니다.');
      this._filterBlocks = false;
    } else {
      const a = analyzeFilter(f);
      const perDraw = (this.msPerDraw[this.engine.holeCount] || 8)
                    * (workersAvailable() ? 1 : FALLBACK_SLOWDOWN);
      const d = describeFilterOdds(a, perDraw, workerCount());
      this.setFilterHint(d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : 'ok',
                         d.text, d.culprits);
      this._filterBlocks = !a.ok;
    }
    /* ★ 어느 갈래로 빠지든 버튼 상태를 반드시 다시 계산한다.
     * 예전에는 위 두 갈래에서 그냥 return 해버려서, 불가능한 조건 때문에
     * 비활성화된 시작 버튼이 조건 필터를 꺼도 그대로 잠긴 채 남았다.
     * 대기 상태에선 상태 전이가 안 일어나므로 아무도 풀어주지 않는다 —
     * 추첨을 아예 못 하는 막다른 골목이었다. */
    this.refreshStartButton();
  }

  /* 시작 버튼을 켤지 끌지 판단하는 곳은 여기 한 군데뿐이다.
   * 두 군데에서 각자 계산하면 반드시 어긋난다. */
  refreshStartButton() {
    $('#startBtn').disabled = !this.sm.canStart() || !!this._filterBlocks;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 이력 · 내 번호 · 당첨 대조
   * ════════════════════════════════════════════════════════════════════ */
  renderHistory() {
    const body = $('#histBody');
    const s = this.store.session;
    body.innerHTML = '';
    if (!s || !s.draws.length) {
      body.append(el('tr', {}, el('td', { colspan: '3', class: 'empty' }, '아직 추첨 기록이 없습니다.')));
      return;
    }
    s.draws.slice().reverse().slice(0, 200).forEach((d, i) => {
      const n = s.draws.length - i;
      const cell = el('div', { class: 'nums-cell' });
      for (const v of d.n) {
        const c = el('span', { class: 'chip' }, String(v));
        c.style.background = ballColor(v);
        cell.append(c);
      }
      body.append(el('tr', {},
        el('td', {}, String(n)),
        el('td', {}, cell),
        el('td', {}, new Date(d.t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })),
      ));
    });
  }

  bindMyNumberEvents() {
    $('#winSave').onclick = () => {
      const round = parseInt(String($('#winRound').value).normalize('NFKC'), 10);
      const nums = parseNumbers($('#winNums').value);
      const bonus = parseInt(String($('#winBonus').value).normalize('NFKC'), 10);
      const uniq = [...new Set(nums)];

      if (!Number.isInteger(round) || round < 1) return this.setWinHint('error', '회차를 올바르게 입력해 주세요.');
      if (uniq.length !== 6) return this.setWinHint('error', `당첨번호 6개를 입력해 주세요 (현재 ${uniq.length}개, 중복 제외).`);
      if (!Number.isInteger(bonus) || bonus < 1 || bonus > 45) return this.setWinHint('error', '보너스 번호를 1~45 중에서 입력해 주세요.');
      if (uniq.includes(bonus)) return this.setWinHint('error', '보너스 번호는 당첨번호 6개와 겹칠 수 없습니다.');

      this.store.setWinning(round, uniq, bonus);
      this.setWinHint('ok', `${round}회 당첨번호를 저장했습니다. 저장된 추첨 결과와 자동으로 대조합니다.`);
      this.renderMyNumbers();
    };
    $('#winRound').value = this.cfg.get('round');
    $('#mySessionSel').onchange = () => this.renderMyNumbers();
  }

  setWinHint(level, text) {
    const h = $('#winHint');
    h.className = 'hint ' + level;
    h.textContent = text;
  }

  renderMyNumbers() {
    const sel = $('#mySessionSel');
    const sessions = this.store.allSessions();
    const prev = sel.value;
    sel.innerHTML = '';
    if (!sessions.length) {
      sel.append(el('option', { value: '' }, '저장된 추첨이 없습니다'));
    } else {
      for (const s of sessions) {
        sel.append(el('option', { value: s.id },
          `${s.round}회${s.roundSuffix ? ' ' + s.roundSuffix : ''} · ${s.draws.length}게임 · ${new Date(s.startedAt).toLocaleDateString('ko-KR')}`));
      }
    }
    /* 사용자가 고른 회차가 있으면 그걸 지키고, 없으면 진행 중인 추첨을 고른다.
     * (그냥 첫 항목을 쓰면 새 추첨을 시작해도 옛 회차가 계속 떠 있는다.) */
    if (prev && sessions.some(s => s.id === prev)) sel.value = prev;
    else if (this.store.sessionId && sessions.some(s => s.id === this.store.sessionId)) {
      sel.value = this.store.sessionId;
    }

    const session = sessions.find(s => s.id === sel.value) || sessions[0];
    const body = $('#myBody');
    const sum = $('#mySummary');
    body.innerHTML = '';
    sum.innerHTML = '';
    if (!session || !session.draws.length) {
      body.append(el('tr', {}, el('td', { colspan: '3', class: 'empty' }, '저장된 번호가 없습니다. 추첨을 한 판 돌려보세요.')));
      return;
    }

    const win = this.store.getWinning(session.round);
    const tally = [0, 0, 0, 0, 0, 0];   // [낙첨, 1등, 2등, 3등, 4등, 5등]

    session.draws.forEach((d, i) => {
      const r = win ? checkRank(d.n, win.n, win.bonus) : null;
      if (r) tally[r.rank]++;
      const cell = el('div', { class: 'nums-cell' });
      for (const v of d.n) {
        const hit = win && win.n.includes(v);
        // 보너스는 등수와 무관하게 표시한다 — 4등 조합에 섞여 있어도 보여줘야
        // "왜 5개 맞았는데 4등이지?" 같은 오해가 안 생긴다.
        const isBonus = win && v === win.bonus;
        const c = el('span', {
          class: 'chip' + (win ? (hit ? ' hit' : (isBonus ? ' bonus' : ' miss')) : ''),
        }, String(v));
        c.style.background = ballColor(v);
        cell.append(c);
      }
      body.append(el('tr', {},
        el('td', {}, String(i + 1)),
        el('td', {}, cell),
        el('td', {}, r
          ? el('span', { class: 'rank-tag rank-' + r.rank }, `${r.label}${r.rank ? ` (${r.matched})` : ''}`)
          : el('span', { class: 'rank-tag rank-0' }, '—')),
      ));
    });

    if (win) {
      const cell = el('div', { class: 'nums-cell' });
      for (const v of win.n) {
        const c = el('span', { class: 'chip' }, String(v)); c.style.background = ballColor(v); cell.append(c);
      }
      const b = el('span', { class: 'chip bonus' }, String(win.bonus));
      b.style.background = ballColor(win.bonus);
      cell.append(el('span', { class: 'hint', style: 'align-self:center;margin:0 4px' }, '+'), b);
      sum.append(
        el('div', { class: 'row' }, el('span', { class: 'hint' }, `${session.round}회 당첨번호`), cell),
        el('div', { class: 'hint' },
          `총 ${session.draws.length}게임 · ` +
          RANK_LABELS.map((l, i) => `${l} ${tally[i + 1]}`).join(' · ') +
          ` · 낙첨 ${tally[0]}`),
      );
    } else {
      sum.append(el('div', { class: 'hint' },
        `${session.round}회 당첨번호가 아직 없습니다. 위에 입력하면 ${session.draws.length}게임을 한 번에 대조합니다.`));
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 공정성 셀프테스트
   * ════════════════════════════════════════════════════════════════════ */
  bindTestEvents() {
    $('#testRun').onclick = () => this.runSelfTest();
    $('#testStop').onclick = () => this.stopSelfTest();
    $('#testN').oninput = () => this.updateTestEta();
    $('#testHoles').onchange = () => this.updateTestEta();
    this.updateTestEta();
  }

  updateTestEta() {
    const n = +$('#testN').value;
    const hc = +$('#testHoles').value;
    const solo = !workersAvailable();
    const ms = (this.msPerDraw[hc] || 8) * n / workerCount() * (solo ? FALLBACK_SLOWDOWN : 1);
    $('#testEta').textContent = solo
      ? `${n.toLocaleString()}게임 · 단일 스레드(워커 불가) · 예상 ${fmtDuration(ms)}`
      : `${n.toLocaleString()}게임 · 워커 ${workerCount()}개 · 예상 ${fmtDuration(ms)}`;
  }

  runSelfTest() {
    this.stopSelfTest();
    const nDraws = +$('#testN').value;
    const holeCount = +$('#testHoles').value;
    const n = workerCount();
    const per = Math.ceil(nDraws / n);

    $('#testRun').disabled = true;
    $('#testStop').disabled = false;
    $('#testProgress').hidden = false;
    $('#testReport').innerHTML = '';
    $('#testBar').style.width = '0%';

    if (!workersAvailable()) return this.runSelfTestOnMainThread(nDraws, holeCount);

    const url = workerUrl();
    const partials = [];
    let done = 0;
    const total = per * n;
    const t0 = performance.now();
    const seedRoot = (Math.random() * 4294967296) >>> 0;

    for (let i = 0; i < n; i++) {
      const w = new Worker(url);
      this.testWorkers.push(w);
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') {
          done += m.delta;
          $('#testBar').style.width = Math.min(100, (done / total) * 100) + '%';
          $('#testProgressText').textContent =
            `${done.toLocaleString()} / ${total.toLocaleString()}게임`;
        } else if (m.type === 'partial') {
          partials.push(m.data);
          if (partials.length === n) {
            this.stopSelfTest();
            this.renderTestReport(mergeSelfTests(partials), performance.now() - t0);
          }
        }
      };
      w.onerror = (e) => { console.error(e); this.stopSelfTest(); };
      w.postMessage({
        cmd: 'selftest',
        nDraws: per,
        holeCount,
        seed: (seedRoot + i * 2654435761) >>> 0,
      });
    }
  }

  /* 워커 없이 도는 셀프테스트. 결과는 워커판과 완전히 같다 (같은 코드) —
   * 다만 한 스레드뿐이라 느리다. 화면이 얼지 않게 rAF로 잘라서 돌린다. */
  runSelfTestOnMainThread(nDraws, holeCount) {
    $('#testNote').hidden = false;
    const engine = new LottoEngine({ holeCount, rng: makeRng((Math.random() * 4294967296) >>> 0) });
    const freqAll = new Array(46).fill(0);
    const freqFirst = new Array(46).fill(0);
    const holeHits = [0, 0, 0, 0];
    let done = 0, valid = 0, timeouts = 0, ticks = 0;
    const t0 = performance.now();
    this._testCancelled = false;

    const tick = () => {
      if (this._testCancelled) return;
      const s = performance.now();
      while (performance.now() - s < 12 && done < nDraws) {
        const r = engine.runHeadless();
        done++;
        if (r.timeout) { timeouts++; continue; }
        valid++; ticks += r.ticks;
        for (const n of r.numbers) freqAll[n]++;
        freqFirst[r.order[0]]++;
        for (const h of r.holes) holeHits[h]++;
      }
      $('#testBar').style.width = ((done / nDraws) * 100) + '%';
      $('#testProgressText').textContent = `${done.toLocaleString()} / ${nDraws.toLocaleString()}게임`;

      if (done >= nDraws) {
        const activeIdx = HOLE_INDICES[holeCount];
        const partial = {
          holeCount, valid, timeouts,
          avgTicks: valid ? ticks / valid : 0,
          freqAll: freqAll.slice(1), freqFirst: freqFirst.slice(1),
          holeHits: activeIdx.map(i => holeHits[i]),
          holeLabels: activeIdx.map(i => HOLE_LABELS[i]),
          tests: {
            all: { title: '당첨번호 6개 전체 분포', note: '한 게임에서 6개를 중복 없이 뽑으므로 통계량을 44/39 배 보정했습니다.', df: 44 },
            first: { title: '첫 번째로 나온 공 분포', note: '게임당 1개만 세므로 보정 없이 그대로 χ²₄₄ 검정입니다 — 가장 깨끗한 검정.', df: 44 },
            hole: activeIdx.length > 1
              ? { title: '구멍별 포획 분포', note: '활성 구멍들이 공을 고르게 나눠 먹는지 봅니다.', df: activeIdx.length - 1 }
              : null,
          },
        };
        this.stopSelfTest();
        this.renderTestReport(mergeSelfTests([partial]), performance.now() - t0);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stopSelfTest() {
    this._testCancelled = true;
    for (const w of this.testWorkers) w.terminate();
    this.testWorkers = [];
    $('#testRun').disabled = false;
    $('#testStop').disabled = true;
    $('#testProgress').hidden = true;
    $('#testNote').hidden = true;
  }

  renderTestReport(r, wallMs) {
    const box = $('#testReport');
    box.innerHTML = '';

    box.append(el('div', { class: 'hint' },
      `${r.holeCount}구멍 · 유효 ${r.valid.toLocaleString()}게임 · 타임아웃 ${r.timeouts} · ` +
      `실제 ${fmtDuration(wallMs)} 소요 · 게임당 평균 시뮬레이션 시간 ${r.avgSeconds.toFixed(1)}초`));

    /* 유효 게임이 하나도 없으면 검정할 것이 없다. 0으로 나눈 통계량을
     * ✅로 렌더하면 "공정함이 확인됐다"는 정반대 신호를 준다. */
    if (r.valid === 0) {
      box.append(el('div', { class: 'hint error' },
        '유효 게임이 0판입니다 — 모든 판이 타임아웃됐습니다. 검정을 수행할 수 없습니다.'));
      return;
    }
    if (r.timeouts / (r.valid + r.timeouts) > 0.01) {
      box.append(el('div', { class: 'hint warn' },
        `타임아웃이 ${((r.timeouts / (r.valid + r.timeouts)) * 100).toFixed(1)}% 발생했습니다. ` +
        '타임아웃된 판은 집계에서 빠지므로, 그 자체가 선택 편향이 될 수 있습니다.'));
    }

    for (const key of ['first', 'all', 'hole']) {
      const t = r.tests[key];
      if (!t) continue;

      /* 피어슨 카이제곱 근사는 각 칸의 기대도수가 5 이상이어야 쓸 수 있다.
       * 그 아래에서는 초록 판정을 띄우면 안 된다 — 검정이 성립하지 않는다. */
      if (t.expected < 5) {
        box.append(el('div', { class: 'test-card' },
          el('h5', {}, t.title),
          el('div', { class: 'test-verdict weak' }, '⚠ 표본이 너무 작아 검정할 수 없습니다'),
          el('div', { class: 'hint' },
            `칸당 기대 도수가 ${t.expected.toFixed(1)}입니다. 카이제곱 검정은 5 이상이어야 ` +
            `쓸 수 있습니다. ` +
            (key === 'first'
              ? '이 검정은 게임당 1개만 세므로 최소 225게임이 필요합니다.'
              : '최소 38게임이 필요합니다.')),
        ));
        continue;
      }
      const card = el('div', { class: 'test-card' },
        el('h5', {}, t.title),
        el('div', { class: 'test-verdict ' + t.verdict.level }, `${t.verdict.icon} ${t.verdict.text}`),
        el('dl', { class: 'kv' },
          el('dt', {}, 'χ² 통계량'), el('dd', {}, t.chi2.toFixed(2) + (key === 'all' ? ` (원자료 ${t.chi2Raw.toFixed(2)})` : '')),
          el('dt', {}, '자유도'), el('dd', {}, String(t.df)),
          el('dt', {}, 'p-value'), el('dd', {}, t.p < 0.0001 ? t.p.toExponential(2) : t.p.toFixed(4)),
          el('dt', {}, '기대 도수'), el('dd', {}, t.expected.toFixed(1)),
        ),
        el('div', { class: 'hint' }, t.note),
      );
      box.append(card);
    }

    // 구멍별 실제 분포
    if (r.holeHits.length > 1) {
      box.append(el('div', { class: 'hint' },
        '구멍별 포획: ' + r.holeLabels.map((l, i) => `${l} ${r.holeHits[i].toLocaleString()}`).join(' · ')));
    }

    // 번호별 표준화 잔차 — 어떤 번호가 튀는지 눈으로
    const bars = el('div', { class: 'zbars' });
    const maxAbs = Math.max(2.5, ...r.z.map(Math.abs));
    r.z.forEach((z, i) => {
      const b = el('div', { class: 'zbar' + (Math.abs(z) > 2.5 ? ' hot' : '') , title: `${i + 1}번 · ${r.freqAll[i]}회 · z=${z.toFixed(2)}` });
      const h = Math.max(2, (Math.abs(z) / maxAbs) * 34);
      const bar = el('i');
      bar.style.height = h + 'px';
      bar.style.top = z >= 0 ? `calc(50% - ${h}px)` : '50%';
      b.append(bar);
      bars.append(b);
    });
    box.append(el('h5', { style: 'margin:16px 0 2px;font-size:13px' }, '번호별 표준화 잔차 (1 → 45)'), bars,
      el('div', { class: 'hint' }, '막대가 위/아래로 길수록 기대보다 많이/적게 나온 번호입니다. |z| > 2.5는 붉게 표시되지만, 45개 중 한둘은 우연히도 그렇게 나옵니다.'));
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 데이터 내보내기 / 가져오기
   * ════════════════════════════════════════════════════════════════════ */
  bindDataEvents() {
    $('#expTxt').onclick = () => {
      const s = this.store.session || this.store.allSessions()[0];
      if (!s) return;
      download(s.name + '.txt', this.store.exportTxt(s));
    };
    $('#expCsv').onclick = () => {
      const s = this.store.session || this.store.allSessions()[0];
      if (!s) return;
      download(s.name + '.csv', this.store.exportCsv(s), 'text/csv;charset=utf-8');
    };
    $('#expBackup').onclick = () => {
      download(`lotto_backup_${stampNow()}.json`, this.store.exportBackup(), 'application/json');
    };
    $('#impBackup').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = this.store.importBackup(await file.text());
        $('#dataHint').className = 'hint ok';
        $('#dataHint').textContent = `가져왔습니다 — 추첨 ${res.sessions}건, 당첨번호 ${res.winning}건 추가.`;
        this.renderMyNumbers();
        this.renderHistory();
      } catch (err) {
        $('#dataHint').className = 'hint error';
        $('#dataHint').textContent = '가져오기 실패: ' + err.message;
      }
      e.target.value = '';
    };
    $('#clearAll').onclick = () => {
      if (!confirm('저장된 추첨 기록과 당첨번호를 모두 지웁니다. 되돌릴 수 없습니다.\n\n먼저 [전체 백업]으로 내려받아 두는 것을 권합니다. 계속할까요?')) return;
      this.store.clearAll();
      this.engine.resetStats();
      this.updateCounter();
      this.renderHistory();
      this.renderMyNumbers();
      $('#dataHint').className = 'hint';
      $('#dataHint').textContent = '모두 삭제했습니다.';
    };
  }
}

/* 워커 여러 개의 부분 결과를 하나로 합친다. 도수는 더하고, 검정은 합친
 * 도수로 다시 계산한다 — p-value를 평균 내면 안 된다 (그건 통계가 아니다). */
function mergeSelfTests(parts) {
  const base = parts[0];
  const freqAll = new Array(45).fill(0);
  const freqFirst = new Array(45).fill(0);
  const holeHits = new Array(base.holeHits.length).fill(0);
  let valid = 0, timeouts = 0, ticks = 0;

  for (const p of parts) {
    for (let i = 0; i < 45; i++) { freqAll[i] += p.freqAll[i]; freqFirst[i] += p.freqFirst[i]; }
    p.holeHits.forEach((v, i) => { holeHits[i] += v; });
    valid += p.valid;
    timeouts += p.timeouts;
    ticks += p.avgTicks * p.valid;
  }

  const scale = hypergeoScale(45, 6);
  const expAll = valid * 6 / 45;
  const rawAll = chiSquare(freqAll, expAll);
  const adjAll = rawAll / scale;
  const pAll = chiSquarePValue(adjAll, 44);

  const expFirst = valid / 45;
  const rawFirst = chiSquare(freqFirst, expFirst);
  const pFirst = chiSquarePValue(rawFirst, 44);

  const totalCap = holeHits.reduce((a, b) => a + b, 0);
  const expHole = totalCap / holeHits.length;
  const dfHole = holeHits.length - 1;
  const rawHole = dfHole > 0 ? chiSquare(holeHits, expHole) : 0;
  const pHole = dfHole > 0 ? chiSquarePValue(rawHole, dfHole) : 1;

  const p6 = 6 / 45;
  const sd = Math.sqrt(valid * p6 * (1 - p6));
  const z = freqAll.map(o => (sd > 0 ? (o - expAll) / sd : 0));

  return {
    holeCount: base.holeCount,
    valid, timeouts,
    avgTicks: valid ? ticks / valid : 0,
    avgSeconds: valid ? (ticks / valid) * PHYSICS_STEP_MS / 1000 : 0,
    freqAll, freqFirst, z,
    holeLabels: base.holeLabels,
    holeHits,
    tests: {
      all: { ...base.tests.all, chi2Raw: rawAll, chi2: adjAll, p: pAll, expected: expAll, verdict: verdict(pAll) },
      first: { ...base.tests.first, chi2Raw: rawFirst, chi2: rawFirst, p: pFirst, expected: expFirst, verdict: verdict(pFirst) },
      hole: base.tests.hole
        ? { ...base.tests.hole, chi2Raw: rawHole, chi2: rawHole, p: pHole, expected: expHole, verdict: verdict(pHole) }
        : null,
    },
  };
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
