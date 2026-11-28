// Éditeur de plans 2D multi-vues (Dessus XZ, Côté XY, Face ZY) avec cotes en mm,
// déplacement/redimensionnement par poignées et outils de création de pièces 2D -> 3D.

import { THICKNESS_COLORS, GROUP_META, nextPieceId, recomputeCutDimensions, computeStairLayers } from './templeGenerator.js';

export class Editor2D {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks; // { onSelect, onPiecesChange, onCommitHistory }

    this.viewMode = 'XY'; // 'XZ' (Dessus), 'XY' (Côté), 'ZY' (Face)
    this.colorMode = 'group'; // 'group' | 'thickness'
    this.activeTool = 'select'; // 'select' | 'draw_box' | 'draw_prism' | 'draw_cyl' | 'pan'
    this.snapStep = 5; // Magnétisme en mm (1 ou 5)
    this.defaultThickness = 10; // Épaisseur de plaque pour les nouvelles pièces (mm)
    this.showDimensions = true;

    // Caméra 2D : pan (en pixels écran) et zoom (pixels par mm)
    this.zoom = 1.45;
    this.panX = 110;
    this.panY = 80;

    // État des données pointé depuis l'application
    this.pieces = [];
    this.selectedId = null;
    this.hoveredId = null;
    this.visibleGroups = new Set(Object.keys(GROUP_META));

    // Filtre de coupe (tranche sur le 3e axe)
    this.sliceEnabled = false;
    this.sliceMin = 0;
    this.sliceMax = 500;

    // État d'interaction souris & tactile
    this.dragState = null; // { type: 'move'|'resize'|'pan'|'create'|'pinch'|'touch_pan_or_deselect', ... }
    this.spacePressed = false;
    this.lastInputWasTouch = false;

    this._initEvents();
    this.resize();
  }

  setPieces(pieces) {
    this.pieces = pieces;
    this.render();
  }

  setSelectedId(id) {
    this.selectedId = id;
    this.render();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.fitView();
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.render();
  }

  setTool(tool) {
    this.activeTool = tool;
    this.canvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    this.render();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(300, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(250, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.render();
  }

  fitView() {
    if (!this.width || !this.height || this.width < 10 || this.height < 10) return;
    const bounds = this.getSceneBounds2D();
    const bw = Math.max(100, bounds.maxU - bounds.minU);
    const bh = Math.max(100, bounds.maxV - bounds.minV);
    const pad = this.width < 520 ? 48 : 90;
    const scaleX = (this.width - pad * 2) / bw;
    const scaleY = (this.height - pad * 2) / bh;
    this.zoom = Math.max(0.35, Math.min(4.0, Math.min(scaleX, scaleY)));

    const centerU = (bounds.minU + bounds.maxU) / 2;
    const centerV = (bounds.minV + bounds.maxV) / 2;

    this.panX = this.width / 2 - centerU * this.zoom;
    if (this._isVerticalUp()) {
      this.panY = this.height / 2 + centerV * this.zoom;
    } else {
      this.panY = this.height / 2 - centerV * this.zoom;
    }
    this.render();
  }

  // En vue de Côté (XY) et de Face (ZY), l'axe vertical V est Y (hauteur orientée vers le haut)
  _isVerticalUp() {
    return this.viewMode === 'XY' || this.viewMode === 'ZY';
  }

  // Convertit (u, v) en mm du plan 2D vers (screenX, screenY) en pixels
  worldToScreen(u, v) {
    const sx = this.panX + u * this.zoom;
    const sy = this._isVerticalUp()
      ? this.panY - v * this.zoom
      : this.panY + v * this.zoom;
    return { x: sx, y: sy };
  }

  // Convertit (screenX, screenY) en (u, v) en mm
  screenToWorld(sx, sy) {
    const u = (sx - this.panX) / this.zoom;
    const v = this._isVerticalUp()
      ? (this.panY - sy) / this.zoom
      : (sy - this.panY) / this.zoom;
    return { u, v };
  }

  snap(val) {
    if (!this.snapStep || this.snapStep <= 1) return Math.round(val);
    return Math.round(val / this.snapStep) * this.snapStep;
  }

  // Extrait les coordonnées 2D (u, v, du, dv) et la profondeur w (3e axe) d'une pièce selon la vue active
  getPieceRect2D(p) {
    if (this.viewMode === 'XZ') {
      // Vue de Dessus : U = X (Longueur), V = Z (Largeur), W = Y (Hauteur)
      return { u: p.x, v: p.z, du: p.dx, dv: p.dz, w: p.y, dw: p.dy };
    }
    if (this.viewMode === 'XY') {
      // Vue de Côté : U = X (Longueur), V = Y (Hauteur), W = Z (Largeur)
      return { u: p.x, v: p.y, du: p.dx, dv: p.dy, w: p.z, dw: p.dz };
    }
    // Vue de Face ('ZY') : U = Z (Largeur), V = Y (Hauteur), W = X (Longueur)
    return { u: p.z, v: p.y, du: p.dz, dv: p.dy, w: p.x, dw: p.dx };
  }

  // Applique les nouvelles coordonnées 2D (u, v, du, dv) à une pièce
  setPieceRect2D(p, u, v, du, dv) {
    const minSize = 2;
    du = Math.max(minSize, Math.round(du));
    dv = Math.max(minSize, Math.round(dv));
    u = Math.round(u);
    v = Math.round(v);

    if (this.viewMode === 'XZ') {
      p.x = u;
      p.z = v;
      p.dx = du;
      p.dz = dv;
      if (p.shape === 'cylinder_y') {
        p.dz = p.dx;
      }
    } else if (this.viewMode === 'XY') {
      p.x = u;
      p.y = v;
      p.dx = du;
      p.dy = dv;
      if (p.shape === 'cylinder_y') {
        p.dz = p.dx;
      }
    } else {
      p.z = u;
      p.y = v;
      p.dz = du;
      p.dy = dv;
      if (p.shape === 'cylinder_y') {
        p.dx = p.dz;
      }
    }
    recomputeCutDimensions(p);
  }

  isPieceVisible(p) {
    if (p.hidden) return false;
    if (!this.visibleGroups.has(p.group)) return false;
    if (this.sliceEnabled) {
      const r = this.getPieceRect2D(p);
      const wStart = r.w;
      const wEnd = r.w + r.dw;
      if (wEnd < this.sliceMin || wStart > this.sliceMax) return false;
    }
    return true;
  }

  getVisiblePieces() {
    const list = this.pieces.filter((p) => this.isPieceVisible(p));
    // Trier par profondeur sur le 3e axe pour dessiner les pièces de devant par-dessus,
    // et toujours mettre la pièce sélectionnée tout en haut.
    return list.sort((a, b) => {
      if (a.id === this.selectedId) return 1;
      if (b.id === this.selectedId) return -1;
      const ra = this.getPieceRect2D(a);
      const rb = this.getPieceRect2D(b);
      return (ra.w + ra.dw) - (rb.w + rb.dw);
    });
  }

  getSceneBounds2D() {
    const visible = this.getVisiblePieces();
    if (visible.length === 0) {
      return { minU: 0, minV: 0, maxU: 400, maxV: 300 };
    }
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const p of visible) {
      const r = this.getPieceRect2D(p);
      minU = Math.min(minU, r.u);
      minV = Math.min(minV, r.v);
      maxU = Math.max(maxU, r.u + r.du);
      maxV = Math.max(maxV, r.v + r.dv);
    }
    return { minU, minV, maxU, maxV };
  }

  getPieceColor(p) {
    if (this.colorMode === 'thickness') {
      return THICKNESS_COLORS[p.thickness] || '#a78bfa';
    }
    return GROUP_META[p.group]?.color || '#cbd5e1';
  }

  // Retourne les 8 poignées de redimensionnement (en coordonnées écran) de la pièce sélectionnée
  getResizeHandles(p) {
    const r = this.getPieceRect2D(p);
    const p1 = this.worldToScreen(r.u, r.v);
    const p2 = this.worldToScreen(r.u + r.du, r.v + r.dv);
    const left = Math.min(p1.x, p2.x);
    const right = Math.max(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const bottom = Math.max(p1.y, p2.y);
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    return [
      { id: 'nw', x: left, y: top, cursor: 'nwse-resize' },
      { id: 'n', x: midX, y: top, cursor: 'ns-resize' },
      { id: 'ne', x: right, y: top, cursor: 'nesw-resize' },
      { id: 'e', x: right, y: midY, cursor: 'ew-resize' },
      { id: 'se', x: right, y: bottom, cursor: 'nwse-resize' },
      { id: 's', x: midX, y: bottom, cursor: 'ns-resize' },
      { id: 'sw', x: left, y: bottom, cursor: 'nesw-resize' },
      { id: 'w', x: left, y: midY, cursor: 'ew-resize' },
    ];
  }

  hitTestHandle(sx, sy, isTouch = this.lastInputWasTouch) {
    if (!this.selectedId) return null;
    const sel = this.pieces.find((p) => p.id === this.selectedId);
    if (!sel || !this.isPieceVisible(sel)) return null;
    const handles = this.getResizeHandles(sel);
    const radius = isTouch ? 22 : 8;
    let best = null;
    let bestDist = Infinity;
    for (const h of handles) {
      const d = Math.hypot(sx - h.x, sy - h.y);
      if (d <= radius && d < bestDist) {
        best = h;
        bestDist = d;
      }
    }
    return best;
  }

  hitTestPiece(sx, sy) {
    const { u, v } = this.screenToWorld(sx, sy);
    const visible = this.getVisiblePieces();
    // Parcourir de haut en bas (la dernière dessinée est prioritaire)
    for (let i = visible.length - 1; i >= 0; i--) {
      const p = visible[i];
      const r = this.getPieceRect2D(p);
      if (u >= r.u && u <= r.u + r.du && v >= r.v && v <= r.v + r.dv) {
        return p;
      }
    }
    return null;
  }

  _initEvents() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
        this.spacePressed = true;
        this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spacePressed = false;
        this.setTool(this.activeTool);
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = this.screenToWorld(mx, my);

      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoom = Math.max(0.25, Math.min(8.0, this.zoom * factor));

      const after = this.worldToScreen(before.u, before.v);
      this.panX += mx - after.x;
      this.panY += my - after.y;
      this.render();
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      this.lastInputWasTouch = false;
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Clic molette, clic droit, barre espace ou outil Pan -> Déplacement de la caméra 2D
      if (e.button === 1 || e.button === 2 || this.spacePressed || this.activeTool === 'pan') {
        this.dragState = {
          type: 'pan',
          startX: sx,
          startY: sy,
          origPanX: this.panX,
          origPanY: this.panY
        };
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      // Outils de dessin d'une nouvelle pièce 2D -> 3D
      if (this.activeTool.startsWith('draw_')) {
        const w = this.screenToWorld(sx, sy);
        const su = this.snap(w.u);
        const sv = this.snap(w.v);
        this.dragState = {
          type: 'create',
          tool: this.activeTool,
          startU: su,
          startV: sv,
          currU: su + 30,
          currV: sv + 30
        };
        this.render();
        return;
      }

      // 1. Tester les poignées de redimensionnement de la pièce sélectionnée
      const handle = this.hitTestHandle(sx, sy);
      if (handle) {
        const sel = this.pieces.find((p) => p.id === this.selectedId);
        const r = this.getPieceRect2D(sel);
        this.callbacks.onCommitHistory?.();
        this.dragState = {
          type: 'resize',
          handle: handle.id,
          piece: sel,
          origRect: { ...r }
        };
        return;
      }

      // 2. Tester la sélection / déplacement d'une pièce
      const hit = this.hitTestPiece(sx, sy);
      if (hit) {
        this.selectedId = hit.id;
        this.callbacks.onSelect?.(hit.id);
        const w = this.screenToWorld(sx, sy);
        const r = this.getPieceRect2D(hit);
        this.callbacks.onCommitHistory?.();
        this.dragState = {
          type: 'move',
          piece: hit,
          startU: w.u,
          startV: w.v,
          origU: r.u,
          origV: r.v,
          moved: false
        };
      } else {
        this.selectedId = null;
        this.callbacks.onSelect?.(null);
      }
      this.render();
    });

    window.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (!this.dragState) {
        if (sx >= 0 && sy >= 0 && sx <= this.width && sy <= this.height) {
          const handle = this.hitTestHandle(sx, sy);
          if (handle) {
            this.canvas.style.cursor = handle.cursor;
            return;
          }
          const hit = this.hitTestPiece(sx, sy);
          if (hit?.id !== this.hoveredId) {
            this.hoveredId = hit ? hit.id : null;
            this.render();
          }
          if (this.activeTool === 'select') {
            this.canvas.style.cursor = hit ? 'move' : 'default';
          }
        }
        return;
      }

      if (this.dragState.type === 'pan') {
        this.panX = this.dragState.origPanX + (sx - this.dragState.startX);
        this.panY = this.dragState.origPanY + (sy - this.dragState.startY);
        this.render();
        return;
      }

      const w = this.screenToWorld(sx, sy);

      if (this.dragState.type === 'move') {
        const du = w.u - this.dragState.startU;
        const dv = w.v - this.dragState.startV;
        if (Math.abs(du) > 0.5 || Math.abs(dv) > 0.5) {
          this.dragState.moved = true;
        }
        const p = this.dragState.piece;
        const r = this.getPieceRect2D(p);
        const newU = this.snap(this.dragState.origU + du);
        const newV = this.snap(this.dragState.origV + dv);
        this.setPieceRect2D(p, newU, newV, r.du, r.dv);
        this.callbacks.onPiecesChange?.(p);
        this.render();
        return;
      }

      if (this.dragState.type === 'resize') {
        const { piece, handle, origRect } = this.dragState;
        const su = this.snap(w.u);
        const sv = this.snap(w.v);

        let u1 = origRect.u;
        let u2 = origRect.u + origRect.du;
        let v1 = origRect.v;
        let v2 = origRect.v + origRect.dv;

        const isUp = this._isVerticalUp();
        // En vue Y vers le haut, 'n' (haut de l'écran) correspond à v2 (max V), 's' correspond à v1 (min V)
        if (handle.includes('w')) u1 = Math.min(su, u2 - 2);
        if (handle.includes('e')) u2 = Math.max(su, u1 + 2);

        if (isUp) {
          if (handle.includes('n')) v2 = Math.max(sv, v1 + 2);
          if (handle.includes('s')) v1 = Math.min(sv, v2 - 2);
        } else {
          if (handle.includes('n')) v1 = Math.min(sv, v2 - 2);
          if (handle.includes('s')) v2 = Math.max(sv, v1 + 2);
        }

        this.setPieceRect2D(piece, u1, v1, u2 - u1, v2 - v1);
        this.callbacks.onPiecesChange?.(piece);
        this.render();
        return;
      }

      if (this.dragState.type === 'create') {
        this.dragState.currU = this.snap(w.u);
        this.dragState.currV = this.snap(w.v);
        this.render();
      }
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragState) return;
      if (this.dragState.type === 'create') {
        this._finalizeCreatePiece(this.dragState);
      }
      this.dragState = null;
      this.setTool(this.activeTool);
    });

    // ==================== GESTES TACTILES (MOBILE / TABLETTE) ====================
    const getTouchPoint = (touch) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };

    const startPinch = (t0, t1) => {
      const p0 = getTouchPoint(t0);
      const p1 = getTouchPoint(t1);
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      const startDist = Math.max(10, Math.hypot(p1.x - p0.x, p1.y - p0.y));
      this.dragState = {
        type: 'pinch',
        startDist,
        startZoom: this.zoom,
        startWorldMid: this.screenToWorld(midX, midY),
      };
    };

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.lastInputWasTouch = true;

      if (e.touches.length >= 2) {
        startPinch(e.touches[0], e.touches[1]);
        this.render();
        return;
      }

      if (e.touches.length !== 1) return;
      const pt = getTouchPoint(e.touches[0]);
      const sx = pt.x;
      const sy = pt.y;

      if (this.activeTool === 'pan') {
        this.dragState = {
          type: 'pan',
          startX: sx,
          startY: sy,
          origPanX: this.panX,
          origPanY: this.panY
        };
        return;
      }

      if (this.activeTool.startsWith('draw_')) {
        const w = this.screenToWorld(sx, sy);
        const su = this.snap(w.u);
        const sv = this.snap(w.v);
        this.dragState = {
          type: 'create',
          tool: this.activeTool,
          startU: su,
          startV: sv,
          currU: su,
          currV: sv,
          startX: sx,
          startY: sy,
          dragged: false
        };
        this.render();
        return;
      }

      // 1. Poignée de redimensionnement (zone élargie tactile 22 px)
      const handle = this.hitTestHandle(sx, sy, true);
      if (handle) {
        const sel = this.pieces.find((p) => p.id === this.selectedId);
        const r = this.getPieceRect2D(sel);
        this.dragState = {
          type: 'resize',
          handle: handle.id,
          piece: sel,
          origRect: { ...r },
          startX: sx,
          startY: sy,
          historyCommitted: false
        };
        return;
      }

      // 2. Sélection / déplacement d'une pièce (zone morte 7 px pour éviter tout décalage au tap)
      const hit = this.hitTestPiece(sx, sy);
      if (hit) {
        this.selectedId = hit.id;
        this.callbacks.onSelect?.(hit.id);
        const w = this.screenToWorld(sx, sy);
        const r = this.getPieceRect2D(hit);
        this.dragState = {
          type: 'move',
          piece: hit,
          startU: w.u,
          startV: w.v,
          startX: sx,
          startY: sy,
          origU: r.u,
          origV: r.v,
          moved: false,
          historyCommitted: false
        };
        this.render();
        return;
      }

      // 3. Fond vide en mode Éditer : glisser = panoramique fluide, tap simple = désélectionner
      this.dragState = {
        type: 'touch_pan_or_deselect',
        startX: sx,
        startY: sy,
        origPanX: this.panX,
        origPanY: this.panY,
        moved: false
      };
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!this.dragState) return;

      if (e.touches.length >= 2) {
        if (this.dragState.type !== 'pinch') {
          startPinch(e.touches[0], e.touches[1]);
        }
        const p0 = getTouchPoint(e.touches[0]);
        const p1 = getTouchPoint(e.touches[1]);
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const curDist = Math.max(10, Math.hypot(p1.x - p0.x, p1.y - p0.y));
        const nextZoom = Math.max(0.25, Math.min(8.0, this.dragState.startZoom * (curDist / this.dragState.startDist)));
        this.zoom = nextZoom;
        const wm = this.dragState.startWorldMid;
        this.panX = midX - wm.u * this.zoom;
        this.panY = this._isVerticalUp()
          ? midY + wm.v * this.zoom
          : midY - wm.v * this.zoom;
        this.render();
        return;
      }

      if (e.touches.length !== 1 || this.dragState.type === 'pinch') return;
      const pt = getTouchPoint(e.touches[0]);
      const sx = pt.x;
      const sy = pt.y;

      if (this.dragState.type === 'pan') {
        this.panX = this.dragState.origPanX + (sx - this.dragState.startX);
        this.panY = this.dragState.origPanY + (sy - this.dragState.startY);
        this.render();
        return;
      }

      if (this.dragState.type === 'touch_pan_or_deselect') {
        if (!this.dragState.moved && Math.hypot(sx - this.dragState.startX, sy - this.dragState.startY) > 6) {
          this.dragState.moved = true;
        }
        if (this.dragState.moved) {
          this.panX = this.dragState.origPanX + (sx - this.dragState.startX);
          this.panY = this.dragState.origPanY + (sy - this.dragState.startY);
          this.render();
        }
        return;
      }

      const w = this.screenToWorld(sx, sy);

      if (this.dragState.type === 'move') {
        if (!this.dragState.moved) {
          if (Math.hypot(sx - this.dragState.startX, sy - this.dragState.startY) < 7) return;
          this.dragState.moved = true;
          if (!this.dragState.historyCommitted) {
            this.callbacks.onCommitHistory?.();
            this.dragState.historyCommitted = true;
          }
        }
        const du = w.u - this.dragState.startU;
        const dv = w.v - this.dragState.startV;
        const p = this.dragState.piece;
        const r = this.getPieceRect2D(p);
        this.setPieceRect2D(p, this.snap(this.dragState.origU + du), this.snap(this.dragState.origV + dv), r.du, r.dv);
        this.callbacks.onPiecesChange?.(p);
        this.render();
        return;
      }

      if (this.dragState.type === 'resize') {
        if (!this.dragState.historyCommitted) {
          if (Math.hypot(sx - this.dragState.startX, sy - this.dragState.startY) < 3) return;
          this.callbacks.onCommitHistory?.();
          this.dragState.historyCommitted = true;
        }
        const { piece, handle, origRect } = this.dragState;
        const su = this.snap(w.u);
        const sv = this.snap(w.v);

        let u1 = origRect.u;
        let u2 = origRect.u + origRect.du;
        let v1 = origRect.v;
        let v2 = origRect.v + origRect.dv;
        const isUp = this._isVerticalUp();

        if (handle.includes('w')) u1 = Math.min(su, u2 - 2);
        if (handle.includes('e')) u2 = Math.max(su, u1 + 2);
        if (isUp) {
          if (handle.includes('n')) v2 = Math.max(sv, v1 + 2);
          if (handle.includes('s')) v1 = Math.min(sv, v2 - 2);
        } else {
          if (handle.includes('n')) v1 = Math.min(sv, v2 - 2);
          if (handle.includes('s')) v2 = Math.max(sv, v1 + 2);
        }

        this.setPieceRect2D(piece, u1, v1, u2 - u1, v2 - v1);
        this.callbacks.onPiecesChange?.(piece);
        this.render();
        return;
      }

      if (this.dragState.type === 'create') {
        if (Math.hypot(sx - this.dragState.startX, sy - this.dragState.startY) > 8) {
          this.dragState.dragged = true;
        }
        this.dragState.currU = this.snap(w.u);
        this.dragState.currV = this.snap(w.v);
        this.render();
      }
    }, { passive: false });

    const endTouch = (e) => {
      if (!this.dragState) return;
      if (this.dragState.type === 'pinch') {
        if (e.touches.length < 2) this.dragState = null;
        return;
      }
      if (this.dragState.type === 'touch_pan_or_deselect' && !this.dragState.moved) {
        this.selectedId = null;
        this.callbacks.onSelect?.(null);
        this.render();
      } else if (this.dragState.type === 'create' && this.dragState.dragged) {
        this._finalizeCreatePiece(this.dragState);
      }
      this.dragState = null;
    };

    this.canvas.addEventListener('touchend', endTouch, { passive: false });
    this.canvas.addEventListener('touchcancel', () => { this.dragState = null; }, { passive: false });
  }

  _finalizeCreatePiece(state) {
    const u = Math.min(state.startU, state.currU);
    const v = Math.min(state.startV, state.currV);
    const du = Math.max(10, Math.abs(state.currU - state.startU));
    const dv = Math.max(10, Math.abs(state.currV - state.startV));
    const t = this.defaultThickness || 10;

    let shape = 'box';
    let name = 'Plaque Polystyrène';
    if (state.tool === 'draw_prism') {
      shape = 'prism_z';
      name = 'Fronton / Pignon Triangulaire';
    } else if (state.tool === 'draw_cyl') {
      shape = 'cylinder_y';
      name = 'Colonne Cylindrique';
    }

    const newPiece = {
      id: nextPieceId('cust'),
      name,
      group: 'custom',
      shape,
      x: 0,
      y: 0,
      z: 0,
      dx: t,
      dy: t,
      dz: t,
      thickness: t,
      cutPlane: this.viewMode,
      cutW: du,
      cutH: dv,
      notes: 'Pièce créée sur le plan 2D'
    };

    if (this.viewMode === 'XZ') {
      newPiece.x = u;
      newPiece.z = v;
      newPiece.dx = du;
      newPiece.dz = shape === 'cylinder_y' ? du : dv;
      newPiece.dy = shape === 'cylinder_y' ? 150 : t;
    } else if (this.viewMode === 'XY') {
      newPiece.x = u;
      newPiece.y = v;
      newPiece.dx = du;
      newPiece.dy = dv;
      newPiece.dz = shape === 'cylinder_y' ? du : t;
    } else {
      newPiece.z = u;
      newPiece.y = v;
      newPiece.dz = du;
      newPiece.dy = dv;
      newPiece.dx = shape === 'cylinder_y' ? du : t;
    }

    recomputeCutDimensions(newPiece);
    this.callbacks.onCommitHistory?.();
    this.pieces.push(newPiece);
    this.selectedId = newPiece.id;
    this.activeTool = 'select';
    this.callbacks.onPiecesChange?.(newPiece, true);
    this.callbacks.onSelect?.(newPiece.id);
    this.render();
  }

  // ============================================================================
  // RENDU GRAPHIQUE 2D (GRILLE, PIÈCES, COTES EN MM, POIGNÉES)
  // ============================================================================
  render() {
    const ctx = this.ctx;
    if (!ctx || !this.width || !this.height) return;

    // 1. Fond blueprint sombre
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Grille millimétrique (10 mm et 50 mm)
    this._drawGrid(ctx);

    // 3. Dessin des pièces visibles
    const visible = this.getVisiblePieces();
    for (const p of visible) {
      this._drawPiece2D(ctx, p);
    }

    // 4. Aperçu en cours de création à la souris
    if (this.dragState?.type === 'create') {
      this._drawCreationPreview(ctx, this.dragState);
    }

    // 5. Lignes de cotes globales et cotes de la pièce sélectionnée
    if (this.showDimensions && visible.length > 0) {
      this._drawGlobalDimensions(ctx);
      if (this.selectedId) {
        const sel = this.pieces.find((p) => p.id === this.selectedId);
        if (sel && this.isPieceVisible(sel)) {
          this._drawSelectedPieceDimensions(ctx, sel);
        }
      }
    }

    // 6. Poignées de redimensionnement sur la pièce sélectionnée
    if (this.selectedId) {
      const sel = this.pieces.find((p) => p.id === this.selectedId);
      if (sel && this.isPieceVisible(sel)) {
        this._drawHandles(ctx, sel);
      }
    }

    // 7. Boussole d'axes en bas à gauche du canvas 2D
    this._drawAxisCompass(ctx);
  }

  _drawGrid(ctx) {
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.width, this.height);
    const minU = Math.floor(Math.min(topLeft.u, bottomRight.u) / 10) * 10;
    const maxU = Math.ceil(Math.max(topLeft.u, bottomRight.u) / 10) * 10;
    const minV = Math.floor(Math.min(topLeft.v, bottomRight.v) / 10) * 10;
    const maxV = Math.ceil(Math.max(topLeft.v, bottomRight.v) / 10) * 10;

    // Grille 10 mm (1 cm) si zoom suffisant
    if (this.zoom >= 0.7) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let u = minU; u <= maxU; u += 10) {
        const sx = Math.round(this.worldToScreen(u, 0).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, this.height);
      }
      for (let v = minV; v <= maxV; v += 10) {
        const sy = Math.round(this.worldToScreen(0, v).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(this.width, sy);
      }
      ctx.stroke();
    }

    // Grille 50 mm (5 cm)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const minU50 = Math.floor(minU / 50) * 50;
    const minV50 = Math.floor(minV / 50) * 50;
    for (let u = minU50; u <= maxU; u += 50) {
      const sx = Math.round(this.worldToScreen(u, 0).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.height);
    }
    for (let v = minV50; v <= maxV; v += 50) {
      const sy = Math.round(this.worldToScreen(0, v).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this.width, sy);
    }
    ctx.stroke();

    // Axes d'origine (0, 0)
    const orig = this.worldToScreen(0, 0);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(orig.x, 0);
    ctx.lineTo(orig.x, this.height);
    ctx.moveTo(0, orig.y);
    ctx.lineTo(this.width, orig.y);
    ctx.stroke();

    // Graduations en mm sur les bords
    ctx.fillStyle = '#64748b';
    ctx.font = '10px Inter, system-ui, sans-serif';
    for (let u = minU50; u <= maxU; u += 50) {
      const sx = this.worldToScreen(u, 0).x;
      if (sx > 35 && sx < this.width - 20) {
        ctx.fillText(`${u}`, sx + 3, 14);
      }
    }
    for (let v = minV50; v <= maxV; v += 50) {
      const sy = this.worldToScreen(0, v).y;
      if (sy > 20 && sy < this.height - 20) {
        ctx.fillText(`${v}`, 6, sy - 3);
      }
    }
  }

  _drawPiece2D(ctx, p) {
    const r = this.getPieceRect2D(p);
    const p1 = this.worldToScreen(r.u, r.v);
    const p2 = this.worldToScreen(r.u + r.du, r.v + r.dv);

    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);

    const isSelected = p.id === this.selectedId;
    const isHovered = p.id === this.hoveredId;
    const baseColor = this.getPieceColor(p);

    ctx.save();
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = isSelected ? 0.88 : isHovered ? 0.78 : p.group === 'plugs' ? 0.68 : 0.56;

    // Forme spécifique selon la projection 2D
    if (p.shape === 'prism_z' && this.viewMode === (p.cutPlane || 'ZY')) {
      // Triangle isocèle dans son plan de coupe (ZY, XY ou XZ)
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = isSelected ? 2.5 : 1.2;
      ctx.strokeStyle = isSelected ? '#38bdf8' : isHovered ? '#f8fafc' : '#1e293b';
      ctx.stroke();
    } else if (p.shape === 'roof_slope' && this.viewMode === 'ZY') {
      // Pan de toit incliné vu de face ZY
      ctx.beginPath();
      if (p.slopeSide === 'left') {
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + Math.max(4, p.thickness * this.zoom));
        ctx.lineTo(x, y + h + Math.max(4, p.thickness * this.zoom));
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x + w, y + h + Math.max(4, p.thickness * this.zoom));
        ctx.lineTo(x, y + Math.max(4, p.thickness * this.zoom));
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = isSelected ? 2.5 : 1.2;
      ctx.strokeStyle = isSelected ? '#38bdf8' : '#1e293b';
      ctx.stroke();
    } else if (p.shape === 'cylinder_y' && this.viewMode === 'XZ') {
      // Base carrée 30x30 mm + fût circulaire de la colonne en vue de dessus XZ
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = isSelected ? 2.5 : 1.2;
      ctx.strokeStyle = isSelected ? '#38bdf8' : '#1e293b';
      ctx.strokeRect(x, y, w, h);

      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, (Math.min(w, h) / 2) * 0.76, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.shape === 'stairs') {
      // Profil / dessus / face exact de l'escalier en tranches horizontales empilées
      const spec = computeStairLayers(p);
      const strokeCol = isSelected ? '#38bdf8' : isHovered ? '#f8fafc' : 'rgba(15, 23, 42, 0.85)';
      const baseAlpha = ctx.globalAlpha;

      if (this.viewMode === 'XY') {
        // Vue de Côté : dessiner chaque tranche horizontale à sa position et épaisseur exactes
        for (const layer of spec.layers) {
          const lp1 = this.worldToScreen(p.x + layer.xOffset, p.y + layer.yOffset);
          const lp2 = this.worldToScreen(p.x + layer.xOffset + layer.dx, p.y + layer.yOffset + layer.dy);
          const lx = Math.min(lp1.x, lp2.x);
          const ly = Math.min(lp1.y, lp2.y);
          const lw = Math.abs(lp2.x - lp1.x);
          const lh = Math.abs(lp2.y - lp1.y);

          ctx.globalAlpha = baseAlpha;
          ctx.fillStyle = baseColor;
          ctx.fillRect(lx, ly, lw, lh);

          ctx.globalAlpha = 1;
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.strokeStyle = strokeCol;
          ctx.strokeRect(lx, ly, lw, lh);
        }

        // Repère vertical pointillé entre la partie bouchon (dans Case #25) et les marches visibles
        if (spec.plugDepth > 0) {
          const seam = this.worldToScreen(p.x + spec.plugDepth, p.y);
          const seamTop = this.worldToScreen(p.x + spec.plugDepth, p.y + spec.stackedHeight);
          ctx.save();
          ctx.globalAlpha = 0.75;
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(seam.x, seam.y);
          ctx.lineTo(seamTop.x, seamTop.y);
          ctx.stroke();
          ctx.restore();
        }
      } else if (this.viewMode === 'XZ') {
        // Vue de Dessus : emprise + arêtes de chaque nez de marche
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const layer of spec.layers) {
          const sx = this.worldToScreen(p.x + layer.xOffset + layer.dx, p.z).x;
          ctx.moveTo(sx, y);
          ctx.lineTo(sx, y + h);
        }
        ctx.stroke();

        if (spec.plugDepth > 0) {
          const seamX = this.worldToScreen(p.x + spec.plugDepth, p.z).x;
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#0f172a';
          ctx.beginPath();
          ctx.moveTo(seamX, y);
          ctx.lineTo(seamX, y + h);
          ctx.stroke();
          ctx.restore();
        }

        ctx.lineWidth = isSelected ? 2.5 : isHovered ? 1.8 : 1;
        ctx.strokeStyle = strokeCol;
        ctx.strokeRect(x, y, w, h);
      } else {
        // Vue de Face (ZY) : chaque contremarche horizontale à sa hauteur réelle
        for (const layer of spec.layers) {
          const lp1 = this.worldToScreen(p.z, p.y + layer.yOffset);
          const lp2 = this.worldToScreen(p.z + p.dz, p.y + layer.yOffset + layer.dy);
          const lx = Math.min(lp1.x, lp2.x);
          const ly = Math.min(lp1.y, lp2.y);
          const lw = Math.abs(lp2.x - lp1.x);
          const lh = Math.abs(lp2.y - lp1.y);

          ctx.globalAlpha = baseAlpha;
          ctx.fillStyle = baseColor;
          ctx.fillRect(lx, ly, lw, lh);

          ctx.globalAlpha = 1;
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.strokeStyle = strokeCol;
          ctx.strokeRect(lx, ly, lw, lh);
        }
      }
    } else {
      // Rectangle standard
      ctx.fillRect(x, y, w, h);

      ctx.globalAlpha = 1;
      ctx.lineWidth = isSelected ? 2.5 : isHovered ? 1.8 : 1;
      ctx.strokeStyle = isSelected ? '#38bdf8' : isHovered ? '#f8fafc' : 'rgba(15, 23, 42, 0.85)';
      ctx.strokeRect(x, y, w, h);
    }

    // Numéro de pièce (P1, P2...) + numéro de case du calendrier (#1 à #25)
    const pTag = p.pieceNum ? `P${p.pieceNum}` : '';
    const centerY = (p.shape === 'prism_z' && this.viewMode === (p.cutPlane || 'ZY'))
      ? y + h * 0.65
      : y + h / 2;

    if (p.adventNum && w > 18 && h > 16) {
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold ${Math.min(13, Math.max(9, Math.floor(Math.min(w, h) * 0.28)))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`#${p.adventNum}`, x + w / 2, centerY - (h > 34 ? 7 : 0));

      if (pTag && w > 28 && h > 30) {
        ctx.font = '700 9.5px Inter, sans-serif';
        ctx.fillStyle = '#0369a1';
        ctx.fillText(pTag, x + w / 2, centerY + 6);
      }
      if (w > 48 && h > 48) {
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillText(`${Math.round(r.du)}×${Math.round(r.dv)}`, x + w / 2, centerY + 17);
      }
    } else if (pTag && w > 20 && h > 13) {
      ctx.fillStyle = '#0f172a';
      ctx.font = `800 ${Math.min(12, Math.max(8.5, Math.floor(Math.min(w, h) * 0.34)))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const showDims = w > 50 && h > 28;
      ctx.fillText(pTag, x + w / 2, showDims ? centerY - 6 : centerY);

      if (showDims) {
        ctx.font = '600 9.5px Inter, sans-serif';
        ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
        ctx.fillText(`${Math.round(r.du)} × ${Math.round(r.dv)}`, x + w / 2, centerY + 7);
      }
    }

    ctx.restore();
  }

  _drawCreationPreview(ctx, state) {
    const p1 = this.worldToScreen(state.startU, state.startV);
    const p2 = this.worldToScreen(state.currU, state.currV);
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    const du = Math.abs(state.currU - state.startU);
    const dv = Math.abs(state.currV - state.startV);

    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    if (state.tool === 'draw_prism') {
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.setLineDash([]);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${du} × ${dv} mm (ép. ${this.defaultThickness} mm)`, x + w / 2, y - 8);
    ctx.restore();
  }

  _drawGlobalDimensions(ctx) {
    const b = this.getSceneBounds2D();
    const pMin = this.worldToScreen(b.minU, b.minV);
    const pMax = this.worldToScreen(b.maxU, b.maxV);

    const left = Math.min(pMin.x, pMax.x);
    const right = Math.max(pMin.x, pMax.x);
    const top = Math.min(pMin.y, pMax.y);
    const bottom = Math.max(pMin.y, pMax.y);

    const totalU = Math.round(b.maxU - b.minU);
    const totalV = Math.round(b.maxV - b.minV);

    // Cote horizontale totale en bas
    this._drawDimensionLine(ctx, left, bottom + 28, right, bottom + 28, `Total : ${totalU} mm (${(totalU / 10).toFixed(1)} cm)`, '#94a3b8');
    // Cote verticale totale à gauche
    this._drawDimensionLine(ctx, left - 28, top, left - 28, bottom, `${totalV} mm (${(totalV / 10).toFixed(1)} cm)`, '#94a3b8', true);
  }

  _drawSelectedPieceDimensions(ctx, p) {
    const r = this.getPieceRect2D(p);
    const p1 = this.worldToScreen(r.u, r.v);
    const p2 = this.worldToScreen(r.u + r.du, r.v + r.dv);

    const left = Math.min(p1.x, p2.x);
    const right = Math.max(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const bottom = Math.max(p1.y, p2.y);

    this._drawDimensionLine(ctx, left, top - 16, right, top - 16, `${Math.round(r.du)} mm`, '#38bdf8');
    this._drawDimensionLine(ctx, right + 18, top, right + 18, bottom, `${Math.round(r.dv)} mm`, '#38bdf8', true);
  }

  _drawDimensionLine(ctx, x1, y1, x2, y2, label, color = '#38bdf8', vertical = false) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.3;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    // Petits traits d'arrêt aux extrémités
    if (!vertical) {
      ctx.moveTo(x1, y1 - 5);
      ctx.lineTo(x1, y1 + 5);
      ctx.moveTo(x2, y2 - 5);
      ctx.lineTo(x2, y2 + 5);
    } else {
      ctx.moveTo(x1 - 5, y1);
      ctx.lineTo(x1 + 5, y1);
      ctx.moveTo(x2 - 5, y2);
      ctx.lineTo(x2 + 5, y2);
    }
    ctx.stroke();

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const textW = ctx.measureText(label).width + 10;

    ctx.translate(midX, midY);
    if (vertical) ctx.rotate(-Math.PI / 2);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(-textW / 2, -9, textW, 18);
    ctx.strokeStyle = color;
    ctx.strokeRect(-textW / 2, -9, textW, 18);

    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  _drawHandles(ctx, p) {
    const handles = this.getResizeHandles(p);
    const half = this.lastInputWasTouch ? 6.5 : 4.5;
    const size = half * 2;
    ctx.save();
    for (const h of handles) {
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = this.lastInputWasTouch ? 2.4 : 2;
      ctx.beginPath();
      ctx.rect(h.x - half, h.y - half, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawAxisCompass(ctx) {
    const labels = {
      XZ: { u: 'X (Longueur Arrière→Avant)', v: 'Z (Largeur Gauche→Droite)', title: 'VUE DE DESSUS (Plan XZ)', short: 'Plan XZ (X × Z)' },
      XY: { u: 'X (Longueur Arrière→Avant)', v: 'Y (Hauteur Sol→Toit)', title: 'VUE DE CÔTÉ (Élévation XY)', short: 'Côté XY (X × Y)' },
      ZY: { u: 'Z (Largeur Gauche→Droite)', v: 'Y (Hauteur Sol→Toit)', title: 'VUE DE FACE (Façade ZY)', short: 'Face ZY (Z × Y)' },
    }[this.viewMode];

    ctx.save();
    if (this.width < 520) {
      const boxW = 128;
      const bx = this.width - boxW - 10;
      const by = 22;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, boxW, 24);
      ctx.strokeRect(bx, by, boxW, 24);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 10.5px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels.short, bx + boxW / 2, by + 12);
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.fillRect(12, this.height - 54, 245, 42);
    ctx.strokeRect(12, this.height - 54, 245, 42);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(labels.title, 20, this.height - 37);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`Horiz: ${labels.u} | Vert: ${labels.v}`, 20, this.height - 20);
    ctx.restore();
  }
}
