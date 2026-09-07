/* ============================================================================
 * 02-audio.js — 비프음 (Web Audio API) + 음성안내 (Web Speech API)
 *
 * 원본: _SoundEngine (pygame/winsound PCM 합성)  ·  _TTSEngine (edge-tts + mp3 캐시)
 *
 * 웹 이식에서 달라진 점
 *   · PCM 사인파를 직접 만들지 않고 OscillatorNode로 낸다. 파형·페이드아웃
 *     (12ms)·볼륨(0.72)은 원본과 같은 값을 쓴다.
 *   · edge-tts + mp3 캐시 폴더가 통째로 사라진다. 브라우저 내장 음성합성이
 *     그 자리를 대신하므로 네트워크도, 캐시 빌드 20초도 필요 없다.
 *   · 브라우저는 사용자 제스처 전에는 소리를 못 낸다. 첫 클릭/키입력에서
 *     AudioContext를 깨우는 처리가 반드시 필요하다 (unlock()).
 * ========================================================================== */
'use strict';

/* ── 비프 엔진 ─────────────────────────────────────────────────────────── */
const Beeper = (() => {
  const VOLUME = 0.72;
  const FADE_S = 0.012;      // 12ms 페이드아웃 — 클릭 잡음 방지 (원본과 동일)

  let ctx = null;
  let master = null;
  let enabled = true;
  let unlocked = false;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  }

  /* 자동재생 정책 해제 — 사용자 제스처 핸들러 안에서 불러야 한다. */
  function unlock() {
    const c = ensureCtx();
    if (!c) return false;
    if (c.state === 'suspended') c.resume();
    unlocked = c.state === 'running';
    return unlocked;
  }

  function isUnlocked() {
    return !!ctx && ctx.state === 'running';
  }

  /* beeps: [[freqHz, durMs], ...] — 순서대로 이어 붙여 재생.
   * 원본의 우선순위 큐는 필요 없다. Web Audio는 샘플 단위로 미리 스케줄되므로
   * 큐가 밀리지도, 워커 스레드가 필요하지도 않다. */
  function play(beeps) {
    if (!enabled) return;
    const c = ensureCtx();
    if (!c || c.state !== 'running') return;

    let t = c.currentTime + 0.001;
    for (const [freq, durMs] of beeps) {
      const dur = durMs / 1000;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      /* 원본 파형: 처음부터 최대 볼륨, 끝 12ms만 선형 페이드아웃.
       * 시작에도 3ms 램프를 준다 — 사인파를 진폭 0이 아닌 지점에서
       * 끊어 시작하면 브라우저에서 딱 소리가 난다. */
      const fadeOut = Math.min(FADE_S, dur * 0.5);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOLUME, t + Math.min(0.003, dur * 0.2));
      gain.gain.setValueAtTime(VOLUME, t + dur - fadeOut);
      gain.gain.linearRampToValueAtTime(0, t + dur);

      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + dur + 0.01);
      t += dur;
    }
  }

  return {
    play, unlock, isUnlocked,
    setEnabled(v) { enabled = !!v; },
    get enabled() { return enabled; },
  };
})();

/* ── 원본과 동일한 비프 패턴 ───────────────────────────────────────────── */
const SFX = {
  /* 공 포획: 1~6번째마다 음이 올라간다 (도-레-미-파-솔-라) */
  capture(index, isLast) {
    const scale = [523, 587, 659, 698, 784, 880];
    const freq = scale[Math.max(0, Math.min(index - 1, 5))];
    Beeper.play(isLast
      ? [[freq, 180], [880, 120], [1047, 300], [1319, 400]]
      : [[freq, 160]]);
  },
  /* 오버레이 번호 발표 */
  reveal(idx) {
    const scale = [440, 494, 523, 587, 659, 784];
    const freq = scale[idx % scale.length];
    Beeper.play(idx === 5
      ? [[freq, 100], [freq + 50, 100], [1047, 200], [1319, 350]]
      : [[freq, 110]]);
  },
  start() { Beeper.play([[440, 80], [523, 80], [659, 120]]); },
  countdownTick(sec) { Beeper.play(sec <= 3 ? [[880, 80]] : [[440, 60]]); },
  complete() {
    Beeper.play([[523, 150], [659, 150], [784, 150], [1047, 150],
                 [784, 100], [1047, 100], [1319, 400]]);
  },
  /* 조건 필터가 조합을 기각했을 때 — 짧고 낮은 두 음 (실패 느낌, 거슬리지 않게) */
  reject() { Beeper.play([[330, 70], [262, 90]]); },
};

/* ── 한자어 수사 변환 ──────────────────────────────────────────────────────
 * 음성합성 엔진에 "1번"을 그대로 주면 "한 번"(고유어)으로 읽는다.
 * 로또 번호는 "일 번"이라야 하므로 한글로 풀어서 넘긴다. (원본 _num_to_korean) */
const KO_ONES = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const KO_TENS = ['', '십', '이십', '삼십', '사십', '오십', '육십', '칠십', '팔십', '구십'];

function numToKorean(n) {
  n = Math.trunc(n);
  if (n <= 0 || n > 99) return String(n);
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return KO_TENS[tens] + KO_ONES[ones];
}

/* ── 음성안내 엔진 ─────────────────────────────────────────────────────────
 * 원본은 edge-tts로 mp3를 51개 미리 만들어 캐시했다. 브라우저에는 음성합성이
 * 내장돼 있으니 캐시도, 네트워크도, 재시도 로직도 전부 사라진다.
 *
 * 대신 브라우저 쪽 함정이 세 개 있다.
 *   ① voices 목록이 비동기로 늦게 채워진다 (voiceschanged 이벤트 대기).
 *   ② 한국어 음성이 아예 없는 환경이 있다 (리눅스, 일부 OBS 내장 브라우저).
 *      → available=false 로 두고 토글을 비활성화한다. 원본의 silent 폴백과 같다.
 *   ③ 크롬은 발화가 15초를 넘기면 엔진이 멈춘다. 여기 문구는 전부 짧아 무해.
 *
 * 원본의 is_busy() 기반 "발음 끝나면 다음 번호" 체인을 그대로 살리기 위해
 * pending 카운터를 유지한다. 이게 발표 오버레이의 리듬을 만든다. */
const Speaker = (() => {
  const RATE = 1.4;          // 원본 edge-tts "+40%" 에 대응하는 방송용 페이스
  const PITCH = 1.0;

  const FIXED_TEXTS = {
    start: '추첨을 시작합니다',
    announce: '당첨 번호를 발표합니다',
    last: '마지막 번호',
    complete: '추첨이 완료되었습니다',
    congrats: '축하합니다',
  };

  const synth = window.speechSynthesis || null;
  let voice = null;
  let enabled = false;
  let available = false;
  let pending = 0;
  const listeners = new Set();

  function pickVoice() {
    if (!synth) return null;
    const voices = synth.getVoices();
    if (!voices || !voices.length) return null;
    const ko = voices.filter(v => /^ko/i.test(v.lang));
    if (!ko.length) return null;
    /* 원본은 수희(SunHi) 목소리를 썼다. 이름이 맞는 게 있으면 그걸,
     * 없으면 로컬 음성(네트워크 불필요)을, 그것도 없으면 첫 한국어 음성. */
    return ko.find(v => /sun-?hi|수희|heami|yuna/i.test(v.name))
        || ko.find(v => v.localService)
        || ko[0];
  }

  function refreshVoices() {
    voice = pickVoice();
    const was = available;
    available = !!voice;
    if (was !== available) listeners.forEach(fn => fn(available));
  }

  if (synth) {
    refreshVoices();
    synth.addEventListener?.('voiceschanged', refreshVoices);
    /* 일부 브라우저는 voiceschanged를 안 쏜다 — 잠깐 폴링해서 보완. */
    let tries = 0;
    const iv = setInterval(() => {
      if (available || ++tries > 20) { clearInterval(iv); return; }
      refreshVoices();
    }, 250);
  }

  function speak(text) {
    if (!enabled || !available || !synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang || 'ko-KR';
    u.rate = RATE;
    u.pitch = PITCH;
    pending++;
    /* 한 발화당 정확히 한 번만 깎아야 한다.
     * onend 와 안전망 타이머가 둘 다 깎으면, 정상 종료한 발화에서 카운터가
     * 두 번 줄어 다음 번호의 몫까지 미리 까먹는다 — 발표 체인이 앞 번호가
     * 아직 나오고 있는데 다음 번호로 넘어가버린다. */
    let counted = false;
    const done = () => {
      if (counted) return;
      counted = true;
      pending = Math.max(0, pending - 1);
      clearTimeout(guard);
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
    /* 안전망: onend를 못 받는 브라우저가 있다. 문구 길이로 상한을 잡는다.
     * 이게 없으면 발표 체인이 영원히 다음 번호로 못 넘어간다. */
    const guard = setTimeout(done, 1200 + text.length * 220);
  }

  return {
    speakNumber(n) { speak(numToKorean(n) + '번'); },
    speakFixed(key) { const t = FIXED_TEXTS[key]; if (t) speak(t); },
    speakNumbers(nums) {
      speak('당첨 번호는 ' + nums.map(n => numToKorean(n) + '번').join(', ') + ' 입니다');
    },
    /* 발표 체인이 "음성 끝날 때까지 대기"하는 근거 */
    isBusy() { return pending > 0 || (!!synth && (synth.speaking || synth.pending)); },
    cancel() { try { synth?.cancel(); } catch (_) {} pending = 0; },
    setEnabled(v) { enabled = !!v && available; if (!enabled) this.cancel(); return enabled; },
    get enabled() { return enabled; },
    get available() { return available; },
    get voiceName() { return voice ? voice.name : '(없음)'; },
    onAvailabilityChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
