/* ============================================================================
 * 03-state.js — 상태머신 · 설정 · 저장소
 *
 * 원본: GameState / _StateMachine / LottoConfig / LottoStorage
 *
 * 웹 이식에서 달라진 점
 *   · lotto_config.json  → localStorage
 *   · 결과 .txt 파일 append → localStorage에 회차별로 누적, 내려받기는 사용자가
 *     원할 때 .txt / .csv 로 뽑는다 (브라우저는 파일에 append를 못 한다)
 *   · lotto_template.xlsx 기반 엑셀 자동 생성 → 제거.
 *     외부 라이브러리 없이 재현할 수 없고, CSV면 엑셀이 그대로 연다.
 * ========================================================================== */
'use strict';

/* ── 게임 상태 ─────────────────────────────────────────────────────────── */
const GameState = Object.freeze({
  IDLE: 'IDLE',            // 대기: 시작 전 / 리셋 후
  RUNNING: 'RUNNING',      // 추첨 진행 중
  OVERLAY: 'OVERLAY',      // 번호 발표 오버레이 재생 중
  COUNTDOWN: 'COUNTDOWN',  // 자동 진행 카운트다운 중
  COMPLETED: 'COMPLETED',  // 목표 게임 수 도달
});

/* 허용된 (from → to) 전이만 통과시킨다. 상태를 바꾸는 곳이 한 군데뿐이라
 * "화면은 추첨 중인데 내부는 대기" 같은 불일치가 구조적으로 불가능하다. */
const ALLOWED_TRANSITIONS = new Set([
  'IDLE>RUNNING',
  'RUNNING>OVERLAY',
  'RUNNING>IDLE',        // 6개 미달 종료 (edge case)
  'OVERLAY>IDLE',        // 자동진행 OFF
  'OVERLAY>COUNTDOWN',   // 자동진행 ON
  'OVERLAY>COMPLETED',   // 목표 게임 수 도달
  'COUNTDOWN>RUNNING',
  'COUNTDOWN>IDLE',      // 카운트다운 중 리셋
  'COMPLETED>IDLE',
  'COMPLETED>RUNNING',
]);

class StateMachine {
  constructor(onChange) {
    this._state = GameState.IDLE;
    this._onChange = onChange || (() => {});
  }
  get current() { return this._state; }

  transition(to, force = false) {
    const pair = `${this._state}>${to}`;
    if (!force && !ALLOWED_TRANSITIONS.has(pair)) {
      throw new Error(`[StateMachine] 허용되지 않은 전이: ${this._state} → ${to}`);
    }
    const prev = this._state;
    this._state = to;
    if (prev !== to) this._onChange(to, prev);
    return prev;
  }

  isIdle() { return this._state === GameState.IDLE; }
  isRunning() { return this._state === GameState.RUNNING; }
  isOverlay() { return this._state === GameState.OVERLAY; }
  isCountdown() { return this._state === GameState.COUNTDOWN; }
  isCompleted() { return this._state === GameState.COMPLETED; }
  canStart() { return this._state === GameState.IDLE || this._state === GameState.COMPLETED; }
}

/* ── 설정 ──────────────────────────────────────────────────────────────────
 * 원본 DEFAULTS를 그대로 계승하고, 웹판에서 새로 생긴 항목을 덧붙였다.
 * 저장된 키 중 DEFAULTS에 있는 것만 병합한다 — 옛 저장값에 남은 쓰레기 키가
 * 새 버전으로 흘러들지 않는다. */
const CONFIG_KEY = 'lotto_web:config';

const CONFIG_DEFAULTS = {
  round: 1217,
  roundSuffix: '',
  maxGames: 100,
  soundOn: true,
  autoPlay: false,
  ttsOn: false,
  holeCount: 1,
  // ── 웹판 신규 ──
  /* 음성안내 시점. 원본은 공이 들어갈 때와 발표 오버레이에서 두 번 읽었다.
   * 방송에서는 의도된 반복이지만 개인용으로는 성가시다 — 고를 수 있게 했다.
   * 'both' | 'capture' | 'reveal' */
  speakOn: 'both',
  theme: 'dark',            // 'dark' | 'light'
  reduceMotion: false,      // 공 잔상·글로우 등 장식 효과 끄기 (저사양/멀미 대응)
  smoothRender: true,       // 물리 28ms 틱 사이를 보간해 화면 주사율로 그림
  filterOn: false,          // 조건 필터 사용 여부
  filter: null,             // 조건 필터 설정 (Filters.DEFAULT 형태)
  panelTab: 'draw',         // 마지막으로 열려 있던 패널 탭
};

/* 설정은 두 겹이다.
 *   _data  — 이번 실행에 실제로 적용되는 값 (URL 덮어쓰기 포함)
 *   _saved — 디스크에 남을 값
 * 방송 모드 URL이 _data만 바꾸고 _saved는 건드리지 않기 때문에, 나중에
 * 다른 설정을 하나 바꿔 저장이 일어나도 URL 값이 딸려 들어가지 않는다.
 * (한 겹으로 두면 탭 하나만 눌러도 전체가 저장되면서 URL 값이 새어 나간다 —
 *  실제로 그렇게 새는 걸 확인하고 두 겹으로 나눴다.) */
class Config {
  constructor() {
    this._data = { ...CONFIG_DEFAULTS };
    this._saved = { ...CONFIG_DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const k of Object.keys(CONFIG_DEFAULTS)) {
        if (k in saved) { this._data[k] = saved[k]; this._saved[k] = saved[k]; }
      }
    } catch (e) {
      /* 사파리 프라이빗 모드·저장공간 차단 등에서 던진다.
       * 설정을 못 읽는 건 치명적이지 않다 — 기본값으로 그냥 돈다. */
      console.warn('설정 로드 실패 — 기본값 사용', e);
    }
    this._normalize();
  }

  _normalize() {
    this._normalizeOne(this._data);
    this._normalizeOne(this._saved);
  }

  /* 저장될 값도 같은 규칙으로 정리한다. 안 하면 디스크에 잘못된 값이 남고,
   * 다음 실행에서 그걸 다시 읽어 고치는 일이 반복된다. */
  _normalizeOne(d) {
    d.round = Math.max(1, Math.min(99999, parseInt(d.round, 10) || 1217));
    d.roundSuffix = String(d.roundSuffix ?? '').slice(0, 20);
    d.maxGames = MAX_GAMES_OPTIONS.includes(+d.maxGames) ? +d.maxGames : 100;
    d.holeCount = [1, 2, 4].includes(+d.holeCount) ? +d.holeCount : 1;
    d.theme = d.theme === 'light' ? 'light' : 'dark';
    d.speakOn = ['both', 'capture', 'reveal'].includes(d.speakOn) ? d.speakOn : 'both';
    for (const k of ['soundOn', 'autoPlay', 'ttsOn', 'reduceMotion', 'smoothRender', 'filterOn']) {
      d[k] = !!d[k];
    }
  }

  save() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this._saved));
    } catch (e) {
      console.warn('설정 저장 실패', e);
    }
  }

  get(k) { return this._data[k]; }
  set(k, v) {
    if (!(k in CONFIG_DEFAULTS)) return;
    this._data[k] = v;
    this._saved[k] = v;
    this._normalize();
    this.save();
  }
  /* 저장하지 않고 이번 실행에만 적용한다.
   * 방송 모드 URL이 이걸 쓴다 — OBS 소스 링크 한 번 열었다고 사용자의
   * 데스크톱 설정(회차·구멍 개수·소리)이 조용히 바뀌면 안 된다. */
  setTransient(k, v) {
    if (!(k in CONFIG_DEFAULTS)) return;
    this._data[k] = v;
    this._normalize();
  }
  get all() { return { ...this._data }; }
}

const MAX_GAMES_OPTIONS = [10, 20, 50, 100, 200, 300, 400, 500];

/* ── 저장소 ────────────────────────────────────────────────────────────────
 * 원본은 실행 폴더에 lotto_{회차}_result_{일시}.txt 를 만들고 한 줄씩 붙였다.
 * 브라우저에는 그런 파일 핸들이 없으므로, 회차별 세션을 localStorage에 두고
 * 사용자가 원할 때 같은 형식의 텍스트로 내보낸다.
 *
 * 스키마 버전을 박아 둔다. 나중에 구조가 바뀌어도 옛 저장값을 알아보고
 * 옮겨 담을 수 있어야 사용자가 기록을 잃지 않는다. */
const STORE_KEY = 'lotto_web:store';
const STORE_SCHEMA = 1;

/* 파일명 안전 문자열 — 원본 _sanitize_suffix와 같은 규칙 */
function sanitizeSuffix(suffix) {
  if (!suffix) return '';
  return String(suffix)
    .replace(/[\\/:*?"<>|\t\n\r]/g, '')
    .trim()
    .replace(/ /g, '_');
}

function stampNow() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

class Storage {
  constructor() {
    this.data = { schema: STORE_SCHEMA, sessions: [], winning: {} };
    this.load();
    this.sessionId = null;
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === STORE_SCHEMA) {
        this.data = {
          schema: STORE_SCHEMA,
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
          winning: parsed.winning && typeof parsed.winning === 'object' ? parsed.winning : {},
        };
      } else if (parsed) {
        console.warn(`저장 스키마 불일치 (${parsed.schema} ≠ ${STORE_SCHEMA}) — 기록을 새로 시작합니다`);
      }
    } catch (e) {
      console.warn('저장소 로드 실패', e);
    }
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
      return true;
    } catch (e) {
      /* QuotaExceededError — 오래된 세션부터 버리고 한 번 더 시도한다.
       * 조용히 실패하면 사용자는 저장된 줄 알고 기록을 잃는다. */
      console.warn('저장소 쓰기 실패 — 오래된 세션 정리 후 재시도', e);
      while (this.data.sessions.length > 10) this.data.sessions.shift();
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /* 새 추첨 세션 시작 — 원본의 create_new_file()에 해당.
   * 원본과 같은 "게으른 생성": 첫 추첨을 시작할 때 부른다.
   * 그래야 켜자마자 끄는 사용자에게 빈 기록이 남지 않는다. */
  startSession(round, roundSuffix) {
    const safe = sanitizeSuffix(roundSuffix);
    const suffixPart = safe ? `_${safe}` : '';
    const session = {
      id: `s${Date.now()}`,
      round,
      roundSuffix: roundSuffix || '',
      name: `lotto_${round}${suffixPart}_result_${stampNow()}`,
      startedAt: new Date().toISOString(),
      draws: [],
    };
    this.data.sessions.push(session);
    /* 세션 개수 상한 — 오래된 것부터 버린다. 없으면 몇 달 뒤 저장공간이 찬다. */
    while (this.data.sessions.length > 50) this.data.sessions.shift();
    this.sessionId = session.id;
    this.save();
    return session;
  }

  get session() {
    return this.data.sessions.find(s => s.id === this.sessionId) || null;
  }

  /* 오름차순 6개를 현재 세션에 기록 */
  saveResult(numbers, meta = {}) {
    if (!numbers || numbers.length !== 6) return null;
    const s = this.session;
    if (!s) return null;
    const row = {
      n: numbers.slice(),
      t: Date.now(),
      hole: meta.holeCount ?? null,       // 몇 구멍 모드에서 뽑혔는지
      tries: meta.tries ?? 1,             // 조건 필터가 몇 번 만에 통과시켰는지
    };
    s.draws.push(row);
    this.save();
    return row;
  }

  endSession() { this.sessionId = null; }

  allSessions() { return this.data.sessions.slice().reverse(); }

  deleteSession(id) {
    this.data.sessions = this.data.sessions.filter(s => s.id !== id);
    if (this.sessionId === id) this.sessionId = null;
    this.save();
  }

  clearAll() {
    this.data = { schema: STORE_SCHEMA, sessions: [], winning: {} };
    this.sessionId = null;
    this.save();
  }

  /* ── 실제 당첨번호 ────────────────────────────────────────────────────
   * 회차번호 → {n: [6개], bonus: number, savedAt}
   * 사용자가 직접 입력한다. 자동 조회는 하지 않는다 — 동행복권은 CORS를
   * 허용하지 않고, 프록시를 두면 "네트워크 없이 도는 한 파일"이 깨진다. */
  setWinning(round, numbers, bonus) {
    this.data.winning[String(round)] = {
      n: numbers.slice().sort((a, b) => a - b),
      bonus,
      savedAt: Date.now(),
    };
    this.save();
  }
  getWinning(round) { return this.data.winning[String(round)] || null; }
  deleteWinning(round) { delete this.data.winning[String(round)]; this.save(); }

  /* ── 내보내기 ─────────────────────────────────────────────────────────── */

  /* 원본 .txt 와 같은 형식: 헤더 한 줄 + 탭 구분 6열 */
  exportTxt(session) {
    const s = session || this.session;
    if (!s) return '';
    const head = `# 로또 ${s.round}회${s.roundSuffix ? ' ' + s.roundSuffix : ''} 예상번호 추첨 결과`;
    return head + '\n' + s.draws.map(d => d.n.join('\t')).join('\n') + '\n';
  }

  /* 엑셀이 바로 여는 CSV. 회차·순번·6개 번호·합계·홀짝·당첨 등수까지 넣는다
   * — 원본 엑셀 템플릿이 하던 일을 라이브러리 없이 대신한다. */
  exportCsv(session) {
    const s = session || this.session;
    if (!s) return '';
    const win = this.getWinning(s.round);
    const cols = ['회차', '부제', '순번', '번호1', '번호2', '번호3', '번호4', '번호5', '번호6',
                  '합계', '홀수', '짝수', '연속', '일치', '등수'];
    const lines = [cols.join(',')];
    s.draws.forEach((d, i) => {
      const st = combStats(d.n);
      const rank = win ? checkRank(d.n, win.n, win.bonus) : null;
      lines.push([
        s.round,
        `"${(s.roundSuffix || '').replace(/"/g, '""')}"`,
        i + 1,
        ...d.n,
        st.sum, st.odd, st.even, st.maxRun,
        rank ? rank.matched : '',
        rank ? rank.label : '',
      ].join(','));
    });
    /* 엑셀이 UTF-8 CSV를 한글 깨짐 없이 열게 하려면 BOM이 있어야 한다. */
    return '﻿' + lines.join('\n') + '\n';
  }

  /* 전체 백업 — 브라우저 저장소를 비워도 되돌릴 수 있게 */
  exportBackup() {
    return JSON.stringify({
      app: '로또 예상번호 추첨기 (웹)',
      appVersion: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null),
      schema: STORE_SCHEMA,
      exportedAt: new Date().toISOString(),
      data: this.data,
    }, null, 2);
  }

  importBackup(text) {
    const parsed = JSON.parse(text);
    const d = parsed.data || parsed;
    if (!d || d.schema !== STORE_SCHEMA || !Array.isArray(d.sessions)) {
      throw new Error('이 파일은 이 앱의 백업 파일이 아니거나 버전이 다릅니다.');
    }
    /* 병합이 아니라 합집합 — 같은 id는 기존 것을 남긴다.
     * 덮어쓰기로 만들면 실수 한 번에 기록이 통째로 날아간다. */
    const known = new Set(this.data.sessions.map(s => s.id));
    let added = 0;
    for (const s of d.sessions) {
      if (!known.has(s.id)) { this.data.sessions.push(s); added++; }
    }
    let winAdded = 0;
    for (const [round, w] of Object.entries(d.winning || {})) {
      if (!this.data.winning[round]) { this.data.winning[round] = w; winAdded++; }
    }
    this.data.sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    this.save();
    return { sessions: added, winning: winAdded };
  }
}

/* ── 조합 통계 (필터·CSV·화면 공용) ────────────────────────────────────── */
function combStats(nums) {
  const n = nums.slice().sort((a, b) => a - b);
  let sum = 0, odd = 0;
  for (const v of n) { sum += v; if (v % 2) odd++; }
  // 연속 번호의 최대 길이 (예: 12,13,14 → 3)
  let maxRun = 1, run = 1;
  for (let i = 1; i < n.length; i++) {
    run = (n[i] === n[i - 1] + 1) ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  // 구간 분포 (1~10 / 11~20 / 21~30 / 31~40 / 41~45)
  const bands = [0, 0, 0, 0, 0];
  for (const v of n) bands[Math.min(4, Math.floor((v - 1) / 10))]++;
  // 끝수 합 (일의 자리 합) — 로또 분석에서 흔히 쓰는 지표
  const tailSum = n.reduce((a, v) => a + (v % 10), 0);
  /* 짝수 개수는 n.length - odd 여야 한다. 6으로 고정하면 추첨 도중의
   * 부분 조합(공 3개만 나온 상태 등)에서 "홀3:짝3"처럼 없는 공을 세어버린다. */
  return { sum, odd, even: n.length - odd, count: n.length, maxRun, bands, tailSum, sorted: n };
}

/* ── 당첨 등수 판정 ────────────────────────────────────────────────────────
 * 6/45 규칙:  1등 6개 · 2등 5개+보너스 · 3등 5개 · 4등 4개 · 5등 3개 · 그 외 낙첨
 * 보너스는 2등 판정에만 쓴다. 5개 일치 + 보너스가 아니면 3등이고,
 * 4개 일치에 보너스가 겹쳐도 4등 그대로다 — 여기서 틀리는 구현이 많다. */
const RANK_LABELS = ['1등', '2등', '3등', '4등', '5등'];

function checkRank(picked, winning, bonus) {
  /* 보너스가 당첨 6개 안에 들어 있는 데이터는 애초에 있을 수 없다.
   * 화면 입력에서 막고 있지만, 백업 가져오기 등 다른 경로로 들어올 수 있다.
   * 그대로 두면 5개 일치가 전부 2등으로 부풀어 오르므로 여기서도 무효화한다. */
  const w = new Set(winning);
  const validBonus = Number.isInteger(bonus) && bonus >= 1 && bonus <= 45 && !w.has(bonus);

  const hit = picked.filter(n => w.has(n));
  const matched = hit.length;
  const bonusPicked = validBonus && picked.includes(bonus);

  let rank = 0;                              // 0 = 낙첨
  if (matched === 6) rank = 1;
  else if (matched === 5 && bonusPicked) rank = 2;
  else if (matched === 5) rank = 3;
  else if (matched === 4) rank = 4;
  else if (matched === 3) rank = 5;

  return {
    rank,
    matched,
    /* 사용자가 보너스 번호를 골랐는가 — 등수와는 별개다.
     * 4등 조합에 보너스가 섞여 있어도 등수는 4등 그대로지만,
     * 화면에서는 그 공을 따로 표시해 줘야 사용자가 납득한다. */
    bonusPicked,
    label: rank ? RANK_LABELS[rank - 1] : '낙첨',
    hitNumbers: hit,
  };
}
