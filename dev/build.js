/* ============================================================================
 * build.js — src/ 를 dist/index.html 한 파일로 합친다.
 *
 *   node build.js
 *
 * 왜 빌드를 두는가
 *   배포는 index.html 한 개를 GitHub에 올리는 것으로 끝나야 한다 (사용자가
 *   쓰는 방식). 그렇다고 4천 줄을 한 파일에서 편집하고 싶지는 않다.
 *   그래서 개발은 src/ 에서 나눠 하고, 배포물만 합친다.
 *
 * 핵심 제약
 *   물리·필터·검정 코드는 결과물 안에 정확히 한 벌만 들어가야 한다.
 *   메인 스레드와 워커가 같은 <script> 텍스트를 공유하기 때문이다.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT = path.join(OUT_DIR, 'index.html');

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

/* 워커와 공유되는 코어 — 이 순서가 곧 의존 순서다 */
const CORE_FILES = ['01-physics.js', '03-state.js', '04-filter.js', '05-selftest.js'];
/* 메인 스레드 전용 */
const APP_FILES = ['02-audio.js', '06-render.js', '08-app.js'];

const banner = (name) =>
  `\n/* ${'═'.repeat(72)}\n * ${name}\n * ${'═'.repeat(72)} */\n`;

const core = CORE_FILES.map(f => banner(f) + read(f)).join('\n');
const app = APP_FILES.map(f => banner(f) + read(f)).join('\n');
const glue = read('09-worker-glue.js');
const css = read('07-styles.css');

let html = read('00-index.template.html');

/* 치환 문자열이 코드 안에 우연히 들어 있으면 조용히 망가진다 — 미리 막는다. */
for (const [token, body] of [['/*__CSS__*/', css], ['/*__CORE__*/', core],
                             ['/*__GLUE__*/', glue], ['/*__APP__*/', app]]) {
  if (!html.includes(token)) throw new Error(`템플릿에 ${token} 자리가 없습니다`);
  if (body.includes(token)) throw new Error(`${token} 문자열이 소스 안에 들어 있습니다`);
}

/* </script> 가 문자열 리터럴 안에 있으면 브라우저가 거기서 스크립트를 끊는다.
 * 실제로 있으면 빌드를 실패시킨다 — 조용히 깨진 파일을 내보내는 것보다 낫다. */
for (const [name, body] of [['core', core], ['glue', glue], ['app', app]]) {
  if (/<\/script/i.test(body)) throw new Error(`${name} 에 </script 문자열이 있습니다`);
}

html = html
  .replace('/*__CSS__*/', () => css)
  .replace('/*__CORE__*/', () => core)
  .replace('/*__GLUE__*/', () => glue)
  .replace('/*__APP__*/', () => app);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + 'KB';
console.log(`빌드 완료 → ${path.relative(process.cwd(), OUT)}`);
console.log(`  CSS  ${kb(css).padStart(8)}`);
console.log(`  코어 ${kb(core).padStart(8)}  (메인 + 워커 공유)`);
console.log(`  글루 ${kb(glue).padStart(8)}`);
console.log(`  앱   ${kb(app).padStart(8)}`);
console.log(`  합계 ${kb(html).padStart(8)}`);
