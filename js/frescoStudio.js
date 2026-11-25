// Studio Fresques Intérieures (Cases #1 à #24) :
// - Calcul exact des cotes papier (mm, ratio et pixels à 300 DPI) depuis la géométrie réelle du temple
// - Stockage persistant des images dans IndexedDB (supporte des dizaines d'images haute résolution)
// - Modes "1 Panorama continu en U" ou "3 Volets séparés (Côté G + Fond + Côté D)" + Plancher & Plafond
// - Générateur de planches A4 paysage imprimables à l'échelle 1:1 exacte (mm) avec traits de coupe,
//   traits de pliage, languettes anti-jour et règle de calibration 50 mm.

const DB_NAME = 'temple_fresques_db_v1';
const STORE_NAME = 'images';
const SETTINGS_KEY = 'temple_fresques_settings_v1';

export const DEFAULT_FRESCO_SETTINGS = {
  depthMm: 88,        // Profondeur habillée (ex: 88 mm sans cloison centrale avec 2 mm de retrait, ou 75 mm derrière bouchon)
  clearanceMm: 1,     // Jeu anti-gondolement retiré en hauteur/largeur (1 mm par défaut)
  tabMm: 6,           // Languettes anti-jour en haut et en bas du volet central (fond), 0 = désactivé
  defaultWallMode: 'triple', // 'triple' (3 images : Côté G + Fond + Côté D) | 'pano' (1 panorama continu)
  caseModes: {},      // { [adventNum]: 'triple' | 'pano' }
};

class FrescoImageDB {
  constructor() {
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async getAll() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const result = {};
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          result[cur.key] = cur.value;
          cur.continue();
        } else {
          resolve(result);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async set(key, dataUrl) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(dataUrl, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async setMany(entries) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const [key, dataUrl] of entries) {
        store.put(dataUrl, key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async del(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function mmToPx300(mm) {
  return Math.round((mm * 300) / 25.4);
}

export function formatRatio(w, h) {
  if (!w || !h) return '1:1';
  const r = w / h;
  // Repérer les ratios photo/IA classiques proches
  const presets = [
    { label: '1:1', val: 1 },
    { label: '4:3', val: 4 / 3 },
    { label: '3:4', val: 3 / 4 },
    { label: '3:2', val: 3 / 2 },
    { label: '2:3', val: 2 / 3 },
    { label: '16:9', val: 16 / 9 },
    { label: '9:16', val: 9 / 16 },
    { label: '21:9', val: 21 / 9 },
  ];
  let nearest = null;
  let minDiff = Infinity;
  for (const p of presets) {
    const diff = Math.abs(r - p.val) / p.val;
    if (diff < minDiff) {
      minDiff = diff;
      nearest = p;
    }
  }
  const exact = `${r.toFixed(2)}:1`;
  if (nearest && minDiff <= 0.14) {
    return `${exact} (≈ ${nearest.label})`;
  }
  return exact;
}

/**
 * Calcule les cotes exactes des 24 cases à partir des pièces actuelles du temple.
 */
export function computeCasesSpecs(pieces, params, settings) {
  const s = { ...DEFAULT_FRESCO_SETTINGS, ...settings };
  const plugs = pieces
    .filter((p) => p.adventNum && p.adventNum >= 1 && p.adventNum <= 24)
    .sort((a, b) => a.adventNum - b.adventNum);

  const P = Math.max(20, Number(s.depthMm) || 88);
  const gap = Math.max(0, Number(s.clearanceMm) || 0);
  const tab = Math.max(0, Number(s.tabMm) || 0);

  return plugs.map((plug) => {
    const rawL = Math.round(plug.dx);
    const rawH = Math.round(plug.dy);
    const L = Math.max(15, rawL - gap);
    const H = Math.max(15, rawH - gap);
    const wallTotalW = 2 * P + L;
    const mode = s.caseModes?.[plug.adventNum] || s.defaultWallMode || 'triple';

    return {
      adventNum: plug.adventNum,
      side: plug.plugSide === 'right' ? 'Droite' : 'Gauche',
      pieceId: plug.id,
      rawL,
      rawH,
      L,
      H,
      P,
      tab,
      wallTotalW,
      mode,
      // Tailles recommandées pour la génération d'images (300 DPI)
      specs: {
        pano: { wMm: wallTotalW, hMm: H, wPx: mmToPx300(wallTotalW), hPx: mmToPx300(H), ratio: formatRatio(wallTotalW, H) },
        sideWall: { wMm: P, hMm: H, wPx: mmToPx300(P), hPx: mmToPx300(H), ratio: formatRatio(P, H) },
        backWall: { wMm: L, hMm: H, wPx: mmToPx300(L), hPx: mmToPx300(H), ratio: formatRatio(L, H) },
        floorCeil: { wMm: L, hMm: P, wPx: mmToPx300(L), hPx: mmToPx300(P), ratio: formatRatio(L, P) },
      }
    };
  });
}

export class FrescoStudio {
  constructor(app) {
    this.app = app;
    this.db = new FrescoImageDB();
    this.images = {}; // key -> dataUrl
    this.selectedCase = 1;
    this.settings = this._loadSettings();
    this._ready = false;

    this._initDB();
  }

  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_FRESCO_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      // ignore
    }
    return { ...DEFAULT_FRESCO_SETTINGS };
  }

  _saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {
      // ignore
    }
  }

  async _initDB() {
    try {
      this.images = await this.db.getAll();
    } catch (e) {
      console.warn('IndexedDB indisponible pour les fresques :', e);
      this.images = {};
    }
    this._ready = true;
    this.render();
  }

  _imgKey(caseNum, slot) {
    return `c${caseNum}_${slot}`;
  }

  getCaseImageCount(caseNum, mode) {
    const slots = mode === 'pano' ? ['pano', 'floor', 'ceil'] : ['left', 'back', 'right', 'floor', 'ceil'];
    let count = 0;
    for (const s of slots) {
      if (this.images[this._imgKey(caseNum, s)]) count++;
    }
    return { count, total: slots.length };
  }

  async setImage(caseNum, slot, dataUrl) {
    const key = this._imgKey(caseNum, slot);
    this.images[key] = dataUrl;
    try {
      await this.db.set(key, dataUrl);
    } catch (e) {
      console.warn('Erreur sauvegarde image :', e);
    }
    this.render();
  }

  async clearImage(caseNum, slot) {
    const key = this._imgKey(caseNum, slot);
    delete this.images[key];
    try {
      await this.db.del(key);
    } catch (e) {
      // ignore
    }
    this.render();
  }

  async applySlotToAllCases(sourceCaseNum, slot) {
    const dataUrl = this.images[this._imgKey(sourceCaseNum, slot)];
    if (!dataUrl) return;
    const entries = [];
    for (let c = 1; c <= 24; c++) {
      const key = this._imgKey(c, slot);
      this.images[key] = dataUrl;
      entries.push([key, dataUrl]);
    }
    try {
      await this.db.setMany(entries);
    } catch (e) {
      console.warn('Erreur sauvegarde multiple :', e);
    }
    this.render();
  }

  _readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  render() {
    const container = document.getElementById('fresco-content');
    if (!container) return;

    const specsList = computeCasesSpecs(this.app.pieces, this.app.params, this.settings);
    if (specsList.length === 0) {
      container.innerHTML = `<div class="empty-state">Aucune case #1 à #24 détectée dans la maquette.</div>`;
      return;
    }

    const activeSpec = specsList.find((s) => s.adventNum === this.selectedCase) || specsList[0];
    this.selectedCase = activeSpec.adventNum;

    // Calcul du résumé global des cotes uniques (pour générer les images)
    const uniqueWallDims = Array.from(new Set(specsList.map((c) => `${c.wallTotalW}×${c.H} mm`)));
    const uniqueSideDims = Array.from(new Set(specsList.map((c) => `${c.P}×${c.H} mm`)));
    const uniqueBackDims = Array.from(new Set(specsList.map((c) => `${c.L}×${c.H} mm`)));
    const uniqueFloorDims = Array.from(new Set(specsList.map((c) => `${c.L}×${c.P} mm`)));

    const casesWithAnyImg = specsList.filter((c) => this.getCaseImageCount(c.adventNum, c.mode).count > 0).length;

    // Sélecteur de cases #1..#24 en grille compacte
    const caseGridHtml = specsList.map((c) => {
      const prog = this.getCaseImageCount(c.adventNum, c.mode);
      const isActive = c.adventNum === this.selectedCase;
      const statusCls = prog.count === prog.total ? 'complete' : prog.count > 0 ? 'partial' : '';
      return `
        <button class="fresco-case-btn ${isActive ? 'active' : ''} ${statusCls}" data-fresco-case="${c.adventNum}" title="Case #${c.adventNum} (${c.side}) — ${prog.count}/${prog.total} images">
          <span>#${c.adventNum}</span>
          <small>${prog.count}/${prog.total}</small>
        </button>
      `;
    }).join('');

    // Prévisualisation SVG de la bande murale en U + Plancher + Plafond pour la case active
    const previewSvg = this._buildCasePreviewSVG(activeSpec);

    // Cartes d'upload pour la case active
    const uploadCardsHtml = activeSpec.mode === 'pano'
      ? `
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'pano', '🖼️ Fresque Murale Panoramique (Côté G + Fond + Côté D)', `${activeSpec.specs.pano.wMm} × ${activeSpec.specs.pano.hMm} mm • ${activeSpec.specs.pano.wPx}×${activeSpec.specs.pano.hPx} px`, false)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'floor', '🟫 Plancher (Sol de la case)', `${activeSpec.specs.floorCeil.wMm} × ${activeSpec.specs.floorCeil.hMm} mm • ${activeSpec.specs.floorCeil.wPx}×${activeSpec.specs.floorCeil.hPx} px`, true)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'ceil', '🌌 Plafond (Dessous étagère)', `${activeSpec.specs.floorCeil.wMm} × ${activeSpec.specs.floorCeil.hMm} mm • ${activeSpec.specs.floorCeil.wPx}×${activeSpec.specs.floorCeil.hPx} px`, true)}
      `
      : `
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'left', '⬅️ Mur Côté Gauche', `${activeSpec.specs.sideWall.wMm} × ${activeSpec.specs.sideWall.hMm} mm • ${activeSpec.specs.sideWall.wPx}×${activeSpec.specs.sideWall.hPx} px`, true)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'back', '🏛️ Mur du Fond (Centre)', `${activeSpec.specs.backWall.wMm} × ${activeSpec.specs.backWall.hMm} mm • ${activeSpec.specs.backWall.wPx}×${activeSpec.specs.backWall.hPx} px`, false)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'right', '➡️ Mur Côté Droit', `${activeSpec.specs.sideWall.wMm} × ${activeSpec.specs.sideWall.hMm} mm • ${activeSpec.specs.sideWall.wPx}×${activeSpec.specs.sideWall.hPx} px`, true)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'floor', '🟫 Plancher (Sol de la case)', `${activeSpec.specs.floorCeil.wMm} × ${activeSpec.specs.floorCeil.hMm} mm • ${activeSpec.specs.floorCeil.wPx}×${activeSpec.specs.floorCeil.hPx} px`, true)}
        ${this._buildUploadSlotHTML(activeSpec.adventNum, 'ceil', '🌌 Plafond (Dessous étagère)', `${activeSpec.specs.floorCeil.wMm} × ${activeSpec.specs.floorCeil.hMm} mm • ${activeSpec.specs.floorCeil.wPx}×${activeSpec.specs.floorCeil.hPx} px`, true)}
      `;

    container.innerHTML = `
      <!-- 1. PARAMÈTRES GLOBAUX DES FRESQUES -->
      <div class="cut-section" style="padding:10px;">
        <div class="section-subtitle" style="margin-top:0;">⚙️ Réglages Papier &amp; Pliage (24 Cases)</div>
        <div class="field-grid-3" style="margin-top:6px;">
          <label class="field-label" title="Profondeur à habiller : 88 mm sans cloison centrale (2 mm retrait), ou 75 mm derrière le bouchon">Profondeur P (mm)
            <input type="number" id="fr-depth" value="${this.settings.depthMm}" min="30" max="150" step="1" />
          </label>
          <label class="field-label" title="Jeu retiré en largeur/hauteur pour éviter tout gondolement">Jeu montage (mm)
            <input type="number" id="fr-clearance" value="${this.settings.clearanceMm}" min="0" max="4" step="0.5" />
          </label>
          <label class="field-label" title="Languettes pliées en haut et en bas du fond, coincées sous le sol et le plafond">Languettes fond
            <input type="number" id="fr-tab" value="${this.settings.tabMm}" min="0" max="15" step="1" />
          </label>
        </div>

        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <button class="btn-compact" data-fr-preset-depth="88" title="Sans cloison centrale (90 mm - 2 mm retrait bord)">Prof. 88 mm (bord)</button>
          <button class="btn-compact" data-fr-preset-depth="80" title="Sans cloison centrale, démarre derrière le bouchon de 10 mm">Prof. 80 mm (hors bouchon)</button>
          <button class="btn-compact" data-fr-preset-depth="75" title="Avec cloison centrale de 10 mm, derrière le bouchon">Prof. 75 mm (cloison+bouchon)</button>
        </div>
      </div>

      <!-- 2. GUIDE DES TAILLES POUR GÉNÉRER TES IMAGES (300 DPI + RATIOS) -->
      <div class="cut-highlight-box" style="margin-bottom:12px;text-align:left;">
        <div class="cut-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>📐 TAILLES À GÉNÉRER (300 DPI • TES COTES RÉELLES)</span>
          <span>Case #${activeSpec.adventNum}</span>
        </div>
        <table class="fresco-spec-table">
          <thead>
            <tr>
              <th>Face</th>
              <th>Papier (mm)</th>
              <th>Image 300 DPI</th>
              <th>Ratio</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Murale en U</strong> (1 pano)</td>
              <td>${activeSpec.specs.pano.wMm} × ${activeSpec.specs.pano.hMm}</td>
              <td><strong>${activeSpec.specs.pano.wPx} × ${activeSpec.specs.pano.hPx}</strong> px</td>
              <td>${activeSpec.specs.pano.ratio}</td>
            </tr>
            <tr>
              <td><strong>Côté G / D</strong> (volet)</td>
              <td>${activeSpec.specs.sideWall.wMm} × ${activeSpec.specs.sideWall.hMm}</td>
              <td><strong>${activeSpec.specs.sideWall.wPx} × ${activeSpec.specs.sideWall.hPx}</strong> px</td>
              <td>${activeSpec.specs.sideWall.ratio}</td>
            </tr>
            <tr>
              <td><strong>Fond</strong> (centre)</td>
              <td>${activeSpec.specs.backWall.wMm} × ${activeSpec.specs.backWall.hMm}</td>
              <td><strong>${activeSpec.specs.backWall.wPx} × ${activeSpec.specs.backWall.hPx}</strong> px</td>
              <td>${activeSpec.specs.backWall.ratio}</td>
            </tr>
            <tr>
              <td><strong>Plancher / Plafond</strong></td>
              <td>${activeSpec.specs.floorCeil.wMm} × ${activeSpec.specs.floorCeil.hMm}</td>
              <td><strong>${activeSpec.specs.floorCeil.wPx} × ${activeSpec.specs.floorCeil.hPx}</strong> px</td>
              <td>${activeSpec.specs.floorCeil.ratio}</td>
            </tr>
          </tbody>
        </table>
        <div style="font-size:10.5px;color:#94a3b8;margin-top:6px;line-height:1.4;">
          Sur tes 24 cases — Murales : <strong>${uniqueWallDims.join(' / ')}</strong> • Côtés : <strong>${uniqueSideDims.join(' / ')}</strong> • Fonds : <strong>${uniqueBackDims.join(' / ')}</strong> • Sols/Plafonds : <strong>${uniqueFloorDims.join(' / ')}</strong>.
          <br/>💡 <em>En mode « 3 Volets », tu génères des images aux ratios classiques (16:9 / 4:3 / 3:4) et l'outil les assemble sur <strong>une seule bande pliée en U</strong> !</em>
        </div>
      </div>

      <!-- 3. BOUTONS D'IMPRESSION A4 À L'ÉCHELLE 1:1 -->
      <div class="fresco-print-bar">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;line-height:1.4;">
          💡 Importe ou glisse-dépose tes propres images sur chaque case ci-dessous (stockées localement dans ton navigateur).
        </div>
        <button id="btn-print-case" class="btn-primary-full" style="margin-top:0;">🖨️ Imprimer Case #${activeSpec.adventNum} (A4 1:1)</button>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
          <button id="btn-print-filled" class="btn-compact accent" ${casesWithAnyImg === 0 ? 'disabled' : ''}>🖨️ Cases illustrées (${casesWithAnyImg})</button>
          <button id="btn-print-all" class="btn-compact">🖨️ Toutes les 24 cases</button>
        </div>
      </div>

      <!-- 4. SÉLECTEUR DE CASE #1 À #24 -->
      <div class="section-subtitle" style="margin-top:12px;">Choisir une case à habiller (${casesWithAnyImg}/24 illustrées)</div>
      <div class="fresco-case-grid">${caseGridHtml}</div>

      <!-- 5. ATELIER DE LA CASE ACTIVE -->
      <div class="cut-section" style="padding:10px;margin-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <div>
            <strong style="font-size:13px;color:#fbbf24;">Case #${activeSpec.adventNum}</strong>
            <span style="font-size:11px;color:#94a3b8;">(Flanc ${activeSpec.side} • Int. ${activeSpec.rawL}×${activeSpec.rawH} mm)</span>
          </div>
          <div class="segmented">
            <button data-fr-wallmode="triple" class="${activeSpec.mode === 'triple' ? 'active' : ''}" title="3 images assemblées automatiquement sur 1 seule bande pliée en U">3 Volets (IA facile)</button>
            <button data-fr-wallmode="pano" class="${activeSpec.mode === 'pano' ? 'active' : ''}" title="1 seule image panoramique large couvrant les 3 murs">1 Panorama</button>
          </div>
        </div>

        <!-- Aperçu du patron de découpe & pliage en direct -->
        <div class="fresco-preview-box">
          ${previewSvg}
        </div>

        <!-- Emplacements d'insertion d'images -->
        <div class="fresco-uploads-grid">
          ${uploadCardsHtml}
        </div>
      </div>
    `;

    this._bindEvents(container, specsList, activeSpec);
  }

  _buildUploadSlotHTML(caseNum, slot, title, dimText, allowApplyAll) {
    const imgUrl = this.images[this._imgKey(caseNum, slot)];
    return `
      <div class="fresco-slot-card ${imgUrl ? 'has-img' : ''}" data-drop-case="${caseNum}" data-drop-slot="${slot}">
        <div class="fresco-slot-thumb">
          ${imgUrl ? `<img src="${imgUrl}" alt="${title}" />` : `<span class="fresco-slot-empty">+ Image</span>`}
        </div>
        <div class="fresco-slot-info">
          <div class="fresco-slot-title">${title}</div>
          <div class="fresco-slot-dims">${dimText}</div>
          <div class="fresco-slot-actions">
            <label class="btn-compact" style="cursor:pointer;">
              ${imgUrl ? 'Changer' : '📂 Choisir'}
              <input type="file" accept="image/*" class="hidden" data-upload-case="${caseNum}" data-upload-slot="${slot}" />
            </label>
            ${imgUrl && allowApplyAll ? `<button class="btn-compact" data-apply-all-case="${caseNum}" data-apply-all-slot="${slot}" title="Copier cette image sur les 24 cases">→ 24 cases</button>` : ''}
            ${imgUrl ? `<button class="btn-compact" style="color:#fca5a5;" data-clear-case="${caseNum}" data-clear-slot="${slot}" title="Retirer l'image">✕</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Génère le SVG exact (à l'échelle en mm) du patron complet d'une case :
   * Bande murale en U (avec languettes haut/bas sur le fond + repères de pliage) + Plancher + Plafond.
   */
  _buildCasePatternSVGContent(spec, offsetX = 0, offsetY = 0, forPrint = false) {
    const { adventNum, L, H, P, tab, wallTotalW, mode } = spec;
    const uid = `c${adventNum}_${Math.round(offsetX)}_${Math.round(offsetY)}`;
    const strokeCut = forPrint ? '#111827' : '#38bdf8';
    const strokeFold = forPrint ? '#dc2626' : '#f59e0b';
    const labelColor = forPrint ? '#374151' : '#94a3b8';

    const imgPano = this.images[this._imgKey(adventNum, 'pano')];
    const imgLeft = this.images[this._imgKey(adventNum, 'left')];
    const imgBack = this.images[this._imgKey(adventNum, 'back')];
    const imgRight = this.images[this._imgKey(adventNum, 'right')];
    const imgFloor = this.images[this._imgKey(adventNum, 'floor')];
    const imgCeil = this.images[this._imgKey(adventNum, 'ceil')];

    const wx = offsetX;
    const wy = offsetY + tab;

    // 1. Contenu graphique de la bande murale en U
    let wallImagesSvg = '';
    if (mode === 'pano') {
      wallImagesSvg = imgPano
        ? `<clipPath id="cp_pano_${uid}"><rect x="${wx}" y="${wy}" width="${wallTotalW}" height="${H}" /></clipPath>
           <image href="${imgPano}" x="${wx}" y="${wy}" width="${wallTotalW}" height="${H}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cp_pano_${uid})" />`
        : `<rect x="${wx}" y="${wy}" width="${wallTotalW}" height="${H}" fill="${forPrint ? '#ffffff' : '#1e293b'}" />`;
    } else {
      const panels = [
        { x: wx, w: P, img: imgLeft, name: 'Côté G', key: 'l' },
        { x: wx + P, w: L, img: imgBack, name: 'Fond', key: 'b' },
        { x: wx + P + L, w: P, img: imgRight, name: 'Côté D', key: 'r' },
      ];
      wallImagesSvg = panels.map((pan) => {
        if (pan.img) {
          return `
            <clipPath id="cp_${pan.key}_${uid}"><rect x="${pan.x}" y="${wy}" width="${pan.w}" height="${H}" /></clipPath>
            <image href="${pan.img}" x="${pan.x}" y="${wy}" width="${pan.w}" height="${H}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cp_${pan.key}_${uid})" />
          `;
        }
        return `
          <rect x="${pan.x}" y="${wy}" width="${pan.w}" height="${H}" fill="${forPrint ? '#ffffff' : '#1e293b'}" />
          <text x="${pan.x + pan.w / 2}" y="${wy + H / 2}" fill="${labelColor}" font-size="4.5" font-weight="600" text-anchor="middle" dominant-baseline="middle">${pan.name} (${pan.w}×${H})</text>
        `;
      }).join('');
    }

    // Languettes trapézoïdales anti-jour en haut et en bas du volet central (fond)
    let tabsSvg = '';
    const tx1 = wx + P;
    const tx2 = wx + P + L;
    if (tab > 0) {
      const bevel = Math.min(3, tab * 0.45);
      const topPts = `${tx1},${wy} ${tx1 + bevel},${wy - tab} ${tx2 - bevel},${wy - tab} ${tx2},${wy}`;
      const botPts = `${tx1},${wy + H} ${tx1 + bevel},${wy + H + tab} ${tx2 - bevel},${wy + H + tab} ${tx2},${wy + H}`;
      tabsSvg = `
        <polygon points="${topPts}" fill="${forPrint ? '#f8fafc' : 'rgba(148,163,184,0.12)'}" stroke="${forPrint ? 'none' : strokeCut}" stroke-width="0.35" />
        <polygon points="${botPts}" fill="${forPrint ? '#f8fafc' : 'rgba(148,163,184,0.12)'}" stroke="${forPrint ? 'none' : strokeCut}" stroke-width="0.35" />
        ${forPrint ? `
          <polyline points="${topPts}" fill="none" stroke="${strokeCut}" stroke-width="0.35" />
          <polyline points="${botPts}" fill="none" stroke="${strokeCut}" stroke-width="0.35" />
        ` : ''}
        <text x="${(tx1 + tx2) / 2}" y="${wy - tab / 2}" fill="${labelColor}" font-size="3.2" text-anchor="middle" dominant-baseline="middle">Case #${adventNum} — Coller sous plafond</text>
        <text x="${(tx1 + tx2) / 2}" y="${wy + H + tab / 2}" fill="${labelColor}" font-size="3.2" text-anchor="middle" dominant-baseline="middle">Case #${adventNum} — Coller sous plancher</text>
      `;
    }

    // Contour extérieur de découpe (en impression avec languettes, ne coupe pas les charnières des languettes)
    const cutPerimeterSvg = (forPrint && tab > 0)
      ? `
        <line x1="${wx}" y1="${wy}" x2="${wx}" y2="${wy + H}" stroke="${strokeCut}" stroke-width="0.4" />
        <line x1="${wx + wallTotalW}" y1="${wy}" x2="${wx + wallTotalW}" y2="${wy + H}" stroke="${strokeCut}" stroke-width="0.4" />
        <line x1="${wx}" y1="${wy}" x2="${tx1}" y2="${wy}" stroke="${strokeCut}" stroke-width="0.4" />
        <line x1="${tx2}" y1="${wy}" x2="${wx + wallTotalW}" y2="${wy}" stroke="${strokeCut}" stroke-width="0.4" />
        <line x1="${wx}" y1="${wy + H}" x2="${tx1}" y2="${wy + H}" stroke="${strokeCut}" stroke-width="0.4" />
        <line x1="${tx2}" y1="${wy + H}" x2="${wx + wallTotalW}" y2="${wy + H}" stroke="${strokeCut}" stroke-width="0.4" />
      `
      : `<rect x="${wx}" y="${wy}" width="${wallTotalW}" height="${H}" fill="none" stroke="${strokeCut}" stroke-width="0.4" />`;

    // Repères de pliage :
    // - En impression (forPrint=true) : 4 petits repères extérieurs dans la marge blanche (zéro trait sur la fresque !)
    //   + groupe optionnel .fold-lines-inside masqué par défaut.
    // - En aperçu écran (forPrint=false) : pointillés orange visibles sur la fresque pour visualiser les plis.
    const tickLen = Math.max(3.8, tab > 0 ? tab - 0.5 : 3.8);
    const foldMarksSvg = forPrint
      ? `
        <g class="fold-ticks-outside">
          <line x1="${tx1}" y1="${wy - tickLen}" x2="${tx1}" y2="${wy - 0.7}" stroke="${strokeFold}" stroke-width="0.45" />
          <line x1="${tx1}" y1="${wy + H + 0.7}" x2="${tx1}" y2="${wy + H + tickLen}" stroke="${strokeFold}" stroke-width="0.45" />
          <line x1="${tx2}" y1="${wy - tickLen}" x2="${tx2}" y2="${wy - 0.7}" stroke="${strokeFold}" stroke-width="0.45" />
          <line x1="${tx2}" y1="${wy + H + 0.7}" x2="${tx2}" y2="${wy + H + tickLen}" stroke="${strokeFold}" stroke-width="0.45" />
        </g>
        <g class="fold-lines-inside">
          <line x1="${tx1}" y1="${wy}" x2="${tx1}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.4" stroke-dasharray="2.5,1.8" />
          <line x1="${tx2}" y1="${wy}" x2="${tx2}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.4" stroke-dasharray="2.5,1.8" />
          ${tab > 0 ? `
            <line x1="${tx1}" y1="${wy}" x2="${tx2}" y2="${wy}" stroke="${strokeFold}" stroke-width="0.35" stroke-dasharray="2,1.5" />
            <line x1="${tx1}" y1="${wy + H}" x2="${tx2}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.35" stroke-dasharray="2,1.5" />
          ` : ''}
        </g>
      `
      : `
        <line x1="${tx1}" y1="${wy}" x2="${tx1}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.45" stroke-dasharray="2.5,1.8" />
        <line x1="${tx2}" y1="${wy}" x2="${tx2}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.45" stroke-dasharray="2.5,1.8" />
        ${tab > 0 ? `
          <line x1="${tx1}" y1="${wy}" x2="${tx2}" y2="${wy}" stroke="${strokeFold}" stroke-width="0.4" stroke-dasharray="2,1.5" />
          <line x1="${tx1}" y1="${wy + H}" x2="${tx2}" y2="${wy + H}" stroke="${strokeFold}" stroke-width="0.4" stroke-dasharray="2,1.5" />
        ` : ''}
      `;

    const wallOutlineSvg = `
      ${tabsSvg}
      ${wallImagesSvg}
      ${cutPerimeterSvg}
      ${foldMarksSvg}
      ${tab === 0 ? `<text x="${wx + 2}" y="${wy - 1.5}" fill="${labelColor}" font-size="3.5" font-weight="700">Case #${adventNum} — Murale en U (${wallTotalW}×${H} mm, plis à ${P} et ${P + L} mm)</text>` : ''}
    `;

    // 2. Plancher & Plafond (L × P)
    const buildFlatPanel = (px, py, img, label, key) => {
      const inner = img
        ? `<clipPath id="cp_${key}_${uid}"><rect x="${px}" y="${py}" width="${L}" height="${P}" /></clipPath>
           <image href="${img}" x="${px}" y="${py}" width="${L}" height="${P}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cp_${key}_${uid})" />`
        : `<rect x="${px}" y="${py}" width="${L}" height="${P}" fill="${forPrint ? '#ffffff' : '#1e293b'}" />
           <text x="${px + L / 2}" y="${py + P / 2}" fill="${labelColor}" font-size="4.5" font-weight="600" text-anchor="middle" dominant-baseline="middle">${label} (${L}×${P})</text>`;
      return `
        ${inner}
        <rect x="${px}" y="${py}" width="${L}" height="${P}" fill="none" stroke="${strokeCut}" stroke-width="0.4" />
        <text x="${px + L / 2}" y="${py + P + 3.8}" fill="${labelColor}" font-size="3.3" font-weight="700" text-anchor="middle">${label} #${adventNum} (${L}×${P} mm)</text>
      `;
    };

    return {
      wallSvg: wallOutlineSvg,
      wallBoxH: H + 2 * tab + (tab === 0 ? 5 : 2),
      buildFloorSvg: (px, py) => buildFlatPanel(px, py, imgFloor, 'Plancher', 'fl'),
      buildCeilSvg: (px, py) => buildFlatPanel(px, py, imgCeil, 'Plafond', 'cl'),
    };
  }

  _buildCasePreviewSVG(spec) {
    const pad = 6;
    const wallY = pad;
    const parts = this._buildCasePatternSVGContent(spec, pad, wallY, false);
    const flatY = wallY + parts.wallBoxH + 8;
    const totalW = Math.max(spec.wallTotalW + pad * 2, spec.L * 2 + 24);
    const totalH = flatY + spec.P + 10;

    const floorX = pad;
    const ceilX = pad + spec.L + 12;

    return `
      <svg viewBox="0 0 ${totalW} ${totalH}" style="width:100%;height:auto;background:#090d16;border-radius:6px;display:block;">
        ${parts.wallSvg}
        ${parts.buildFloorSvg(floorX, flatY)}
        ${parts.buildCeilSvg(ceilX, flatY)}
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-top:4px;">
        <span>🟦 Trait plein = Découpe</span>
        <span>🟧 Pointillés = Pliage (rainage)</span>
      </div>
    `;
  }

  /**
   * Génère et ouvre une fenêtre d'impression A4 Paysage (297 × 210 mm) à l'échelle 1:1 exacte !
   */
  openA4PrintWindow(casesToPrint) {
    if (!casesToPrint || casesToPrint.length === 0) {
      alert('Aucune case à imprimer.');
      return;
    }

    const PAGE_W = 297;
    const PAGE_H = 210;
    const MARGIN_X = 10;
    const MARGIN_Y = 10;
    const pages = []; // chaque page est une liste de fragments SVG

    // 1. Placer les bandes murales en U (empilées verticalement : ~3 bandes par A4 paysage)
    let curWallPage = [];
    let curY = MARGIN_Y + 9; // place pour la règle de calibration sur la page 1

    for (const spec of casesToPrint) {
      const stripH = spec.H + 2 * spec.tab + 6;
      if (curWallPage.length > 0 && curY + stripH > PAGE_H - MARGIN_Y) {
        pages.push({ title: 'Fresques Murales (Bandes en U)', svgItems: curWallPage });
        curWallPage = [];
        curY = MARGIN_Y + 4;
      }
      const startX = Math.max(MARGIN_X, (PAGE_W - spec.wallTotalW) / 2);
      const parts = this._buildCasePatternSVGContent(spec, startX, curY, true);
      curWallPage.push(parts.wallSvg);
      curY += stripH + 3;
    }
    if (curWallPage.length > 0) {
      pages.push({ title: 'Fresques Murales (Bandes en U)', svgItems: curWallPage });
    }

    // 2. Placer tous les Planchers et Plafonds en grille sur A4 paysage (jusqu'à 8 par page)
    const flatQueue = [];
    for (const spec of casesToPrint) {
      flatQueue.push({ spec, kind: 'floor' });
      flatQueue.push({ spec, kind: 'ceil' });
    }

    let curFlatPage = [];
    let fx = MARGIN_X;
    let fy = MARGIN_Y + 5;
    let rowMaxH = 0;

    for (const item of flatQueue) {
      const { spec, kind } = item;
      const cellW = spec.L + 6;
      const cellH = spec.P + 9;

      if (fx + spec.L > PAGE_W - MARGIN_X) {
        fx = MARGIN_X;
        fy += rowMaxH + 4;
        rowMaxH = 0;
      }
      if (fy + spec.P + 5 > PAGE_H - MARGIN_Y) {
        pages.push({ title: 'Planchers & Plafonds', svgItems: curFlatPage });
        curFlatPage = [];
        fx = MARGIN_X;
        fy = MARGIN_Y + 5;
        rowMaxH = 0;
      }

      const parts = this._buildCasePatternSVGContent(spec, 0, 0, true);
      curFlatPage.push(kind === 'floor' ? parts.buildFloorSvg(fx, fy) : parts.buildCeilSvg(fx, fy));
      fx += cellW;
      rowMaxH = Math.max(rowMaxH, cellH);
    }
    if (curFlatPage.length > 0) {
      pages.push({ title: 'Planchers & Plafonds', svgItems: curFlatPage });
    }

    // Règle de calibration 50 mm en haut de la première feuille
    const calibrationSvg = `
      <g transform="translate(10, 4)">
        <line x1="0" y1="3" x2="50" y2="3" stroke="#111827" stroke-width="0.4" />
        <line x1="0" y1="1" x2="0" y2="5" stroke="#111827" stroke-width="0.4" />
        <line x1="10" y1="1.8" x2="10" y2="4.2" stroke="#111827" stroke-width="0.3" />
        <line x1="20" y1="1.8" x2="20" y2="4.2" stroke="#111827" stroke-width="0.3" />
        <line x1="30" y1="1.8" x2="30" y2="4.2" stroke="#111827" stroke-width="0.3" />
        <line x1="40" y1="1.8" x2="40" y2="4.2" stroke="#111827" stroke-width="0.3" />
        <line x1="50" y1="1" x2="50" y2="5" stroke="#111827" stroke-width="0.4" />
        <text x="53" y="4.2" fill="#111827" font-size="3.4" font-weight="700">Contrôle échelle 1:1 = 50 mm (5,0 cm) • Imprimer à 100% / Taille réelle (A4 Paysage)</text>
      </g>
    `;

    const pagesHtml = pages.map((pg, idx) => `
      <div class="a4-page">
        <svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210">
          ${idx === 0 ? calibrationSvg : `<text x="10" y="7" fill="#4b5563" font-size="3.5" font-weight="700">Temple Romain — ${pg.title} • Page ${idx + 1}/${pages.length} (A4 Paysage 1:1)</text>`}
          <text x="287" y="206" fill="#6b7280" font-size="3" text-anchor="end">Trait plein noir : découpe • Repères rouges extérieurs : aligner la règle pour plier (aucun trait sur l'image) • Page ${idx + 1}/${pages.length}</text>
          ${pg.svgItems.join('\n')}
        </svg>
      </div>
    `).join('\n');

    const win = window.open('', '_blank');
    if (!win) {
      alert('Autorise les fenêtres pop-up pour ouvrir la planche d’impression A4.');
      return;
    }

    win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Patrons Fresques Temple Romain — A4 Échelle 1:1 (${pages.length} page${pages.length > 1 ? 's' : ''})</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1e293b; font-family: system-ui, sans-serif; color: #f8fafc; }
    .no-print {
      position: sticky; top: 0; z-index: 10;
      background: #0f172a; border-bottom: 1px solid #334155;
      padding: 10px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .no-print button {
      background: #38bdf8; color: #090d16; border: none; border-radius: 6px;
      padding: 8px 16px; font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .fold-lines-inside { display: none; }
    body.show-inside-folds .fold-lines-inside { display: inline; }
    .no-print label {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: #cbd5e1; cursor: pointer; user-select: none;
    }
    .a4-page {
      width: 297mm; height: 210mm;
      background: #ffffff;
      margin: 16px auto;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      page-break-after: always;
      overflow: hidden;
    }
    .a4-page:last-child { page-break-after: auto; }
    @media print {
      body { background: #ffffff; }
      .no-print { display: none !important; }
      .a4-page { margin: 0; box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <div>
      <strong>🏛️ Planches Fresques A4 Paysage (Échelle 1:1 exacte) — ${pages.length} feuille${pages.length > 1 ? 's' : ''}</strong>
      <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Dans la boîte d'impression, choisis <strong>Paysage</strong>, <strong>Marges : Aucune</strong> et <strong>Échelle : 100% (Taille réelle)</strong>, puis vérifie la règle 50 mm !</div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <label title="Décoché par défaut pour ne jamais imprimer de pointillés sur les fresques">
        <input type="checkbox" onchange="document.body.classList.toggle('show-inside-folds', this.checked)" />
        <span>Pointillés sur l'image</span>
      </label>
      <button onclick="window.print()">🖨️ Lancer l'impression A4</button>
    </div>
  </div>
  ${pagesHtml}
</body>
</html>`);
    win.document.close();
  }

  _bindEvents(container, specsList, activeSpec) {
    // Paramètres globaux (Profondeur, Jeu, Languettes)
    const bindSetting = (id, key) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= 0) {
          this.settings[key] = v;
          this._saveSettings();
          this.render();
        }
      });
    };
    bindSetting('fr-depth', 'depthMm');
    bindSetting('fr-clearance', 'clearanceMm');
    bindSetting('fr-tab', 'tabMm');

    container.querySelectorAll('[data-fr-preset-depth]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.settings.depthMm = Number(btn.dataset.frPresetDepth);
        this._saveSettings();
        this.render();
      });
    });

    // Sélection de case #1..#24 (et met en évidence le bouchon en 2D/3D)
    container.querySelectorAll('[data-fresco-case]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedCase = Number(btn.dataset.frescoCase);
        const match = specsList.find((s) => s.adventNum === this.selectedCase);
        if (match) this.app.selectPiece(match.pieceId);
        this.render();
      });
    });

    // Bascule 3 Volets / 1 Panorama pour la case active
    container.querySelectorAll('[data-fr-wallmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.frWallmode;
        if (!this.settings.caseModes) this.settings.caseModes = {};
        this.settings.caseModes[activeSpec.adventNum] = mode;
        this._saveSettings();
        this.render();
      });
    });

    // Upload d'images via sélecteur de fichier
    container.querySelectorAll('input[data-upload-case]').forEach((inp) => {
      inp.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const dataUrl = await this._readImageFile(file);
        await this.setImage(Number(inp.dataset.uploadCase), inp.dataset.uploadSlot, dataUrl);
      });
    });

    // Drag & Drop d'images directement sur les emplacements
    container.querySelectorAll('[data-drop-case]').forEach((card) => {
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (!file || !file.type.startsWith('image/')) return;
        const dataUrl = await this._readImageFile(file);
        await this.setImage(Number(card.dataset.dropCase), card.dataset.dropSlot, dataUrl);
      });
    });

    // Appliquer à toutes les 24 cases
    container.querySelectorAll('[data-apply-all-case]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.applySlotToAllCases(Number(btn.dataset.applyAllCase), btn.dataset.applyAllSlot);
      });
    });

    // Supprimer une image
    container.querySelectorAll('[data-clear-case]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.clearImage(Number(btn.dataset.clearCase), btn.dataset.clearSlot);
      });
    });

    // Impression A4 1:1
    document.getElementById('btn-print-case')?.addEventListener('click', () => {
      this.openA4PrintWindow([activeSpec]);
    });
    document.getElementById('btn-print-filled')?.addEventListener('click', () => {
      const filled = specsList.filter((c) => this.getCaseImageCount(c.adventNum, c.mode).count > 0);
      this.openA4PrintWindow(filled);
    });
    document.getElementById('btn-print-all')?.addEventListener('click', () => {
      this.openA4PrintWindow(specsList);
    });
  }
}
