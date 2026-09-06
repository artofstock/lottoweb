/* ============================================================================
 * 09-worker-glue.js — 워커 진입점
 *
 * 이 파일은 메인 스레드에서 실행되지 않는다. core-src의 텍스트 뒤에 이어 붙여
 * Blob 워커로만 실행된다. 따라서 여기서는 LottoEngine·makeRng·filterAccepts·
 * runSelfTest 를 전부 쓸 수 있다.
 * ========================================================================== */
'use strict';

self.onmessage = (ev) => {
  const m = ev.data;

  /* ── 조건을 만족하는 시드 찾기 ────────────────────────────────────────
   * 워커마다 자기 난수원으로 시드를 뽑는다. 여러 워커가 같은 시드를 볼 확률은
   * 2^32 공간에서 무시할 수준이고, 겹치더라도 결과가 틀리지는 않는다
   * (같은 조합을 두 번 확인할 뿐). */
  if (m.cmd === 'search') {
    const f = normalizeFilter(m.filter);
    const engine = new LottoEngine({ holeCount: m.holeCount });
    const seedRng = makeRng();
    let since = 0;

    for (let i = 0; i < m.maxAttempts; i++) {
      const seed = seedRng.nextUint32();
      engine.rng = makeRng(seed);
      const r = engine.runHeadless();
      since++;

      if (!r.timeout && filterAccepts(r.numbers, f)) {
        self.postMessage({ type: 'found', seed, numbers: r.numbers, delta: since });
        return;
      }
      /* 진행 보고는 200판마다 — 매 판 보내면 postMessage가 탐색보다 비싸진다. */
      if (since >= 200) { self.postMessage({ type: 'progress', delta: since }); since = 0; }
    }
    self.postMessage({ type: 'exhausted', delta: since });
    return;
  }

  /* ── 공정성 셀프테스트 ─────────────────────────────────────────────── */
  if (m.cmd === 'selftest') {
    let last = 0;
    const data = runSelfTest({
      nDraws: m.nDraws,
      holeCount: m.holeCount,
      seed: m.seed,
      onProgress: (done) => {
        const delta = done - last;
        if (delta > 0) { last = done; self.postMessage({ type: 'progress', delta }); }
      },
    });
    self.postMessage({ type: 'partial', data });
    return;
  }

  /* ── 조건 통과율 분석 (메인 스레드를 멈추지 않게 여기서) ───────────── */
  if (m.cmd === 'analyze') {
    self.postMessage({ type: 'analysis', result: analyzeFilter(m.filter) });
  }
};
