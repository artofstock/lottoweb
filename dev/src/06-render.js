/* ============================================================================
 * 06-render.js — 캔버스 렌더러
 *
 * 원본: LottoUI._build_canvas / add_ball / update_ball_positions / update_hole_glow
 *
 * Tkinter는 공 하나마다 oval 아이템 + text 아이템을 만들어 두고 매 프레임
 * coords()로 옮겼다. 웹에서는 매 프레임 전부 다시 그린다 — 45개 원과 숫자는
 * 요즘 브라우저에서 부담이 아니고, 잔상·발광 같은 걸 얹기도 훨씬 쉽다.
 *
 * 좌표계
 *   물리는 언제나 1430 x 1050 논리 픽셀 위에서 돈다.
 *   화면 크기가 얼마든 그 무대를 비율 유지로 letterbox 해서 얹는다.
 *   → 창을 줄여도 추첨 결과가 달라지지 않는다.
 * ========================================================================== */
'use strict';

const HOLE_GLOW_COLORS = ['#FF4444', '#FF6B20', '#FFB300', '#FFD700'];

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scale = 1;
    this.offX = 0;
    this.offY = 0;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.reduceMotion = false;
    this.transparent = false;    // OBS 오버레이 합성용 (배경을 안 칠한다)
    this.title = '';
    this.holeCount = 1;
    this.holeGlow = [0, 0, 0, 0];   // 구멍별 발광 단계 0~3
    this._sprites = null;           // 1~45번 공을 미리 그려둔 스프라이트
    this._spriteDpr = 0;
    this._spriteReduced = null;
  }

  /* ── 공 스프라이트 시트 ──────────────────────────────────────────────────
   * 매 프레임 45개 공마다 방사형 그라디언트를 새로 만들고 텍스트를 그리면
   * 중급 폰에서 프레임이 무너진다. 공은 45가지 모습밖에 없고 회전도 하지
   * 않으므로, 한 번만 그려두고 매 프레임에는 drawImage만 한다.
   * → 프레임당 그라디언트 45회 + 텍스트 90회  →  drawImage 45회 */
  _buildSprites() {
    const dpr = this.dpr;
    const size = Math.ceil(BALL_R * 2.4 * dpr);   // 그림자 여유 포함
    const c = BALL_R * 1.2 * dpr;                 // 스프라이트 안에서의 공 중심
    const r = BALL_R * dpr;

    this._sprites = [];
    for (let n = 1; n <= 45; n++) {
      const off = document.createElement('canvas');
      off.width = size; off.height = size;
      const g = off.getContext('2d');
      const color = ballColor(n);

      if (!this.reduceMotion) {
        g.beginPath();
        g.arc(c + 3 * dpr, c + 4 * dpr, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.34)';
        g.fill();
      }

      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      if (this.reduceMotion) {
        g.fillStyle = color;
      } else {
        const grd = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
        grd.addColorStop(0, mix(color, '#ffffff', 0.55));
        grd.addColorStop(0.55, color);
        grd.addColorStop(1, mix(color, '#000000', 0.34));
        g.fillStyle = grd;
      }
      g.fill();
      g.lineWidth = 3 * dpr;
      g.strokeStyle = 'rgba(255,255,255,0.92)';
      g.stroke();

      g.font = `800 ${30 * dpr}px "Pretendard Variable", Pretendard, "Malgun Gothic", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.fillText(String(n), c, c + 2.5 * dpr);
      g.fillStyle = '#ffffff';
      g.fillText(String(n), c, c + 1 * dpr);

      this._sprites.push(off);
    }
    this._spriteDpr = dpr;
    this._spriteReduced = this.reduceMotion;
    this._spriteHalf = BALL_R * 1.2;   // 무대 좌표 기준 반쪽 크기
  }

  _ensureSprites() {
    if (!this._sprites || this._spriteDpr !== this.dpr || this._spriteReduced !== this.reduceMotion) {
      this._buildSprites();
    }
  }

  /* 컨테이너 크기에 맞춰 백버퍼와 변환을 다시 잡는다.
   * devicePricelRatio를 반영하지 않으면 고해상도 화면에서 글씨가 뭉갠다. */
  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return;
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;

    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    this.scale = Math.min(cssW / STAGE_W, cssH / STAGE_H);
    this.offX = (cssW - STAGE_W * this.scale) / 2;
    this.offY = (cssH - STAGE_H * this.scale) / 2;
  }

  _begin() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.transparent) {
      ctx.clearRect(0, 0, this.cssW, this.cssH);
    } else {
      ctx.fillStyle = '#03070f';           // 무대 바깥 여백 (letterbox 띠)
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    ctx.translate(this.offX, this.offY);
    ctx.scale(this.scale, this.scale);
  }

  /* 화면 좌표 → 무대 좌표 (마우스로 공을 짚을 때 쓴다) */
  toStage(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.offX) / this.scale,
      y: (clientY - r.top - this.offY) / this.scale,
    };
  }

  /* alpha: 직전 물리 틱과 현재 틱 사이의 보간 비율 (0~1).
   * 물리는 35.7Hz로 도는데 화면은 60~120Hz라 이게 없으면 눈에 띄게 끊긴다. */
  draw(balls, alpha, opts = {}) {
    const ctx = this.ctx;
    this._ensureSprites();
    this._begin();

    // ── 무대 바닥 ──
    if (!this.transparent) {
      ctx.fillStyle = '#050d1a';
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      this._drawFloorGrid(ctx);
    }

    // ── 구멍 (공보다 아래) ──
    this._drawHoles(ctx);

    // ── 제목 ──
    if (this.title && !this.transparent) {
      ctx.save();
      ctx.font = '700 46px "Pretendard Variable", Pretendard, "Malgun Gothic", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,215,0,0.20)';
      ctx.fillText(this.title, STAGE_W / 2, 52);
      ctx.restore();
    }

    // ── 공 ──
    for (const b of balls) {
      const x = b.rx + (b.x - b.rx) * alpha;
      const y = b.ry + (b.y - b.ry) * alpha;
      this._drawBall(ctx, b, x, y);
    }

    // ── 외곽 테두리 ──
    if (!this.transparent) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = opts.borderColor || '#FFD700';
      ctx.strokeRect(3, 3, STAGE_W - 6, STAGE_H - 6);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* 아주 옅은 격자 — 공의 속도감이 눈에 들어오게 하는 참조선.
   * 원본의 민무늬 배경은 공이 빠를 때 오히려 느려 보였다. */
  _drawFloorGrid(ctx) {
    if (this.reduceMotion) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,180,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= STAGE_W; x += 110) { ctx.moveTo(x, 0); ctx.lineTo(x, STAGE_H); }
    for (let y = 0; y <= STAGE_H; y += 110) { ctx.moveTo(0, y); ctx.lineTo(STAGE_W, y); }
    ctx.stroke();
    ctx.restore();
  }

  _drawHoles(ctx) {
    const active = HOLE_INDICES[this.holeCount] || [1];
    for (const i of active) {
      const [hx, hy] = HOLE_CENTERS_4[i];
      const tier = Math.max(0, Math.min(3, this.holeGlow[i] | 0));
      const glow = HOLE_GLOW_COLORS[tier];

      // 발광 후광 — 공이 가까울수록 세진다
      if (!this.reduceMotion && tier > 0) {
        const g = ctx.createRadialGradient(hx, hy, HOLE_R * 0.6, hx, hy, HOLE_R * (2.2 + tier * 0.9));
        g.addColorStop(0, hexA(glow, 0.42));
        g.addColorStop(1, hexA(glow, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(hx, hy, HOLE_R * (2.2 + tier * 0.9), 0, Math.PI * 2);
        ctx.fill();
      }

      // 구멍 안쪽 — 원본 #85819A (살짝 보라빛 회색)
      ctx.beginPath();
      ctx.arc(hx, hy, HOLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#85819A';
      ctx.fill();

      // 점선 테두리
      ctx.save();
      ctx.setLineDash([7, 4]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = glow;
      ctx.stroke();
      ctx.restore();

      if (!this.transparent) {
        const below = hy < STAGE_H / 2;
        ctx.font = '700 22px "Pretendard Variable", Pretendard, "Malgun Gothic", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = glow;
        ctx.fillText('당첨 구멍', hx, hy + (below ? HOLE_R + 24 : -HOLE_R - 24));
      }
    }
  }

  _drawBall(ctx, b, x, y) {
    const sp = this._sprites[b.number - 1];
    const h = this._spriteHalf;
    ctx.drawImage(sp, x - h, y - h, h * 2, h * 2);
  }
}

/* ── 색 도우미 ─────────────────────────────────────────────────────────── */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? h.split('').map(c => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return v;
}
function hexA(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mix(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

/* 발광 단계: 가장 가까운 공까지의 거리 → 0(멀다) ~ 3(코앞).
 * 원본 update_hole_glow의 구간을 그대로 옮겼다. */
function glowTier(dist) {
  if (!isFinite(dist)) return 0;
  if (dist < 60) return 3;
  if (dist < 110) return 2;
  if (dist < 180) return 1;
  return 0;
}
