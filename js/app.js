// Contrôleur principal : synchronisation Plan 2D <-> Volume 3D, Inspecteur de pièce,
// Générateur paramétrique du Temple-Calendrier et Liste de Découpe (Cut-List).

import {
  DEFAULT_TEMPLE_PARAMS,
  GROUP_META,
  THICKNESS_COLORS,
  generateRomanTemple,
  nextPieceId,
  recomputeCutDimensions,
  getThicknessProp,
  computeStairLayers,
  ensurePieceNumbers,
  formatPieceNum
} from './templeGenerator.js';
import {
  PLATE_WIDTH,
  PLATE_HEIGHT,
  DEFAULT_KERF,
  ALLOWED_THICKNESSES,
  snapToAllowedThickness,
  enforcePlateConstraintsAndSplit,
  packPiecesIntoPlates
} from './platePacker.js';
import { Editor2D } from './editor2d.js';
import { Viewer3D } from './viewer3d.js';
import { FrescoStudio } from './frescoStudio.js';

const STORAGE_KEY = 'temple_advent_v2_170mm_30x30';

class TemplePlannerApp {
  constructor() {
    this.params = { ...DEFAULT_TEMPLE_PARAMS };
    this.pieces = [];
    this.nextPieceNum = 1;
    this.migratedMergedBays = false;
    this.cutDoneIds = new Set();
    this.cutKerf = DEFAULT_KERF; // Perte de découpe (1 mm par défaut)
    this.hideDoneFromPlates = false;
    this.checklistFilter = 'all'; // 'all' | 'todo' | 'done'
    this.checklistThickness = 'all'; // 'all' | '20' | '10' | '6'
    this.checklistSort = 'num'; // 'num' | 'thickness'
    this.selectedId = null;
    this.history = [];
    this.redoStack = [];
    this.layoutMode = 'split'; // 'split' | '2d' | '3d'
    this.mobileQuery = window.matchMedia('(max-width: 900px)');
    this.mobileView = '3d'; // '3d' | '2d' | 'panel'
    this.activeSidebarTab = 'inspector';
    this._mobile2dFitted = false;

    this._loadInitialState();
    this._initComponents();
    this._bindUI();
    // Si l'utilisateur avait des pièces en 5 mm ou a modifié la longueur de la Cella, migrer en 6 mm et ajuster les 24 ouvertures
    this._upgrade5mmTo6mmAndSync();
    // Migration unique vers les trames fusionnées (180 mm, sans cloison centrale) en préservant les numéros P#
    this._migrateToMergedBays();
    this._refreshAll();
  }

  _loadInitialState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.pieces) && parsed.pieces.length > 0) {
          this.pieces = parsed.pieces;
          this.params = { ...DEFAULT_TEMPLE_PARAMS, ...(parsed.params || {}) };
          this.nextPieceNum = ensurePieceNumbers(this.pieces, parsed.nextPieceNum || 1);
          this.migratedMergedBays = Boolean(parsed.migratedMergedBays);
          if (Array.isArray(parsed.cutDoneIds)) {
            this.cutDoneIds = new Set(parsed.cutDoneIds);
          }
          if (Number.isFinite(parsed.cutKerf) && parsed.cutKerf >= 0) {
            this.cutKerf = parsed.cutKerf;
          }
          if (typeof parsed.hideDoneFromPlates === 'boolean') {
            this.hideDoneFromPlates = parsed.hideDoneFromPlates;
          }
          return;
        }
      }
    } catch (e) {
      console.warn('Impossible de relire la sauvegarde locale :', e);
    }
    this.pieces = generateRomanTemple(this.params);
    this.nextPieceNum = ensurePieceNumbers(this.pieces, 1);
    this.migratedMergedBays = true;
  }

  _upgrade5mmTo6mmAndSync() {
    let had5mm = false;
    if (this.params.tGrid === 5) {
      this.params.tGrid = 6;
      had5mm = true;
    }

    // Mesurer la longueur actuelle de la Cella (telle que modifiée par l'utilisateur) AVANT de toucher aux épaisseurs
    const rearWall = this.pieces.find((p) => p.name.includes('Mur Arrière de la Cella'));
    const frontWall = this.pieces.find((p) => p.name.includes('Mur Avant de la Cella'));
    const spine = this.pieces.find((p) => p.name.includes('Cloison Centrale Cella'));
    const shelves = this.pieces.filter((p) => p.name.includes('Étagère Horizontale'));

    let preservedTotalCellaL = null;
    const tRear = rearWall ? rearWall.dx : (this.params.tStruct || 10);
    const tFront = frontWall ? frontWall.dx : (this.params.tStruct || 10);

    if (rearWall && frontWall) {
      preservedTotalCellaL = Math.round((frontWall.x + frontWall.dx) - rearWall.x);
    } else if (spine) {
      preservedTotalCellaL = Math.round(tRear + spine.dx + tFront);
    } else if (shelves.length > 0) {
      preservedTotalCellaL = Math.round(tRear + shelves[0].dx + tFront);
    }

    // Convertir toute pièce de 5 mm d'épaisseur en 6 mm d'épaisseur
    for (const p of this.pieces) {
      if (p.thickness === 5 || p.dx === 5 || p.dy === 5 || p.dz === 5) {
        had5mm = true;
        if (p.thickness === 5) p.thickness = 6;
        if (p.name.includes('Étagère Horizontale') || p.dy === 5) {
          p.dy = 6;
        } else if (p.name.includes('Cloison Verticale') || p.dx === 5) {
          p.dx = 6;
        } else if (p.dz === 5) {
          p.dz = 6;
        }
        recomputeCutDimensions(p);
      }
    }

    if (had5mm) {
      this._syncGeneratorInputs();
      this.recalculateOpeningsToFitCella(preservedTotalCellaL, false, true);
    } else {
      this.recalculateOpeningsToFitCella(null, true, true);
    }
    // Redécouper automatiquement en morceaux toutes les pièces qui dépassent une plaque 300 × 200 mm
    this.pieces = enforcePlateConstraintsAndSplit(this.pieces);
    for (const p of this.pieces) {
      if (p._migratedStairsV2) {
        delete p._migratedStairsV2;
        this.cutDoneIds.delete(p.id);
      }
    }
  }

  _recombineSplitCellaPieces() {
    const groups = new Map();
    for (const p of this.pieces) {
      if (p.name.includes('Cloison Centrale Cella') || p.name.includes('Étagère Horizontale')) {
        const baseName = p.name.replace(/\s*\(Partie\s+\d+\/\d+\)/gi, '').trim();
        if (!groups.has(baseName)) groups.set(baseName, []);
        groups.get(baseName).push(p);
      }
    }
    for (const [baseName, parts] of groups.entries()) {
      if (parts.length > 1) {
        const minX = Math.min(...parts.map((p) => p.x));
        const maxX = Math.max(...parts.map((p) => p.x + p.dx));
        const minZ = Math.min(...parts.map((p) => p.z));
        const maxZ = Math.max(...parts.map((p) => p.z + p.dz));
        const first = parts[0];
        first._savedPartNums = parts.map((p) => p.pieceNum);
        first.name = baseName;
        first.x = minX;
        first.dx = maxX - minX;
        first.z = minZ;
        first.dz = maxZ - minZ;
        recomputeCutDimensions(first);
        const removeIds = new Set(parts.slice(1).map((p) => p.id));
        this.pieces = this.pieces.filter((p) => !removeIds.has(p.id));
      }
    }
  }

  _getCellaZBounds() {
    const rearWall = this.pieces.find((p) => p.name.includes('Mur Arrière de la Cella'));
    const frontWall = this.pieces.find((p) => p.name.includes('Mur Avant de la Cella'));
    const wall = rearWall || frontWall;
    if (wall && wall.dz > 20) {
      return { cellaStartZ: Math.round(wall.z), cellaW: Math.round(wall.dz) };
    }
    const gridPieces = this.pieces.filter((p) =>
      p.name.includes('Étagère Horizontale') || p.name.includes('Cloison Verticale Case')
    );
    if (gridPieces.length > 0) {
      const minZ = Math.min(...gridPieces.map((p) => p.z));
      const maxZ = Math.max(...gridPieces.map((p) => p.z + p.dz));
      if (maxZ - minZ > 20) {
        return { cellaStartZ: Math.round(minZ), cellaW: Math.round(maxZ - minZ) };
      }
    }
    const tStruct = this.params.tStruct || 10;
    const caseD = this.params.caseD || 90;
    const cellaW = this.params.mergedBays === false ? caseD * 2 + tStruct : caseD * 2;
    return { cellaStartZ: this.params.podiumMargin || 15, cellaW };
  }

  _hasSeparatedCellaBays() {
    const { cellaW } = this._getCellaZBounds();
    const hasSpine = this.pieces.some((p) => p.name.includes('Cloison Centrale Cella'));
    if (hasSpine) return true;
    const hasSplitShelf = this.pieces.some((p) =>
      p.name.includes('Étagère Horizontale') &&
      (p.name.includes('Gauche') || p.name.includes('Droite') || Math.round(p.dz) < cellaW - 1)
    );
    if (hasSplitShelf) return true;
    return this.pieces.some((p) =>
      p.name.includes('Cloison Verticale Case') &&
      (p.name.includes('(G') || p.name.includes('(D') || Math.round(p.dz) < cellaW - 1)
    );
  }

  /**
   * Fusionne les deux trames gauche/droite (étagères + cloisons verticales) sur toute la largeur
   * de la Cella (ex: 180 mm) et retire la cloison centrale de 10 mm, tout en conservant les
   * numéros P# des pièces gardées (ex: P16 + P17 -> P16, sans jamais renuméroter les autres pièces).
   */
  mergeCellaBays(skipHistory = false) {
    this._recombineSplitCellaPieces();
    const { cellaStartZ, cellaW } = this._getCellaZBounds();

    if (!this._hasSeparatedCellaBays()) {
      this.params.mergedBays = true;
      this.params.caseD = Math.round(cellaW / 2);
      this.migratedMergedBays = true;
      return false;
    }

    if (!skipHistory) {
      this.commitHistory();
    }

    const removeIds = new Set();
    const redirectedSelection = new Map();

    // 1. Retirer l'éventuelle cloison centrale de 10 mm
    for (const p of this.pieces) {
      if (p.name.includes('Cloison Centrale Cella')) {
        removeIds.add(p.id);
        this.cutDoneIds.delete(p.id);
      }
    }

    // 2. Fusionner les étagères horizontales par niveau Y
    const shelves = this.pieces
      .filter((p) => p.name.includes('Étagère Horizontale'))
      .sort((a, b) => a.y - b.y || (a.pieceNum || 0) - (b.pieceNum || 0));

    const shelfClusters = [];
    for (const sh of shelves) {
      const cluster = shelfClusters.find((cl) => Math.abs(cl[0].y - sh.y) <= 2);
      if (cluster) cluster.push(sh);
      else shelfClusters.push([sh]);
    }

    shelfClusters.forEach((cluster, idx) => {
      const levelNum = idx + 1;
      const keep = cluster.find((p) => p.name.includes('Gauche'))
        || [...cluster].sort((a, b) => (a.pieceNum || Infinity) - (b.pieceNum || Infinity))[0];

      const minX = Math.min(...cluster.map((p) => p.x));
      const maxX = Math.max(...cluster.map((p) => p.x + p.dx));
      const sizeChanged = Math.round(keep.dz) !== cellaW || Math.round(keep.z) !== cellaStartZ;

      keep.name = `Étagère Horizontale N°${levelNum}`;
      keep.x = minX;
      keep.dx = maxX - minX;
      keep.z = cellaStartZ;
      keep.dz = cellaW;
      keep.notes = `Plaque horizontale traversante (${Math.round(keep.dx)} × ${cellaW} mm — trames fusionnées sans cloison centrale)`;
      recomputeCutDimensions(keep);
      if (sizeChanged) this.cutDoneIds.delete(keep.id);

      for (const other of cluster) {
        if (other.id !== keep.id) {
          removeIds.add(other.id);
          this.cutDoneIds.delete(other.id);
          redirectedSelection.set(other.id, keep.id);
        }
      }
    });

    // 3. Fusionner les cloisons verticales par position (X, Y)
    const divs = this.pieces
      .filter((p) => p.name.includes('Cloison Verticale Case'))
      .sort((a, b) => (Math.round(a.y / 4) - Math.round(b.y / 4)) || (a.x - b.x) || (a.pieceNum || 0) - (b.pieceNum || 0));

    const divClusters = [];
    for (const d of divs) {
      const cluster = divClusters.find((cl) => Math.abs(cl[0].x - d.x) <= 2 && Math.abs(cl[0].y - d.y) <= 2);
      if (cluster) cluster.push(d);
      else divClusters.push([d]);
    }

    // Déterminer rangs Y et X de secours pour nommer proprement (Étage r, Col c)
    const uniqueYs = [];
    const uniqueXs = [];
    for (const cl of divClusters) {
      if (!uniqueYs.some((y) => Math.abs(y - cl[0].y) <= 2)) uniqueYs.push(cl[0].y);
      if (!uniqueXs.some((x) => Math.abs(x - cl[0].x) <= 2)) uniqueXs.push(cl[0].x);
    }
    uniqueYs.sort((a, b) => a - b);
    uniqueXs.sort((a, b) => a - b);

    for (const cluster of divClusters) {
      const keep = cluster.find((p) => p.name.includes('(G'))
        || [...cluster].sort((a, b) => (a.pieceNum || Infinity) - (b.pieceNum || Infinity))[0];

      const match = keep.name.match(/Étage\s+(\d+),\s*Col\s+(\d+)/i);
      const rowNum = match ? Number(match[1]) : (uniqueYs.findIndex((y) => Math.abs(y - keep.y) <= 2) + 1);
      const colNum = match ? Number(match[2]) : (uniqueXs.findIndex((x) => Math.abs(x - keep.x) <= 2) + 1);
      const sizeChanged = Math.round(keep.dz) !== cellaW || Math.round(keep.z) !== cellaStartZ;

      keep.name = `Cloison Verticale Case (Étage ${rowNum}, Col ${colNum})`;
      keep.z = cellaStartZ;
      keep.dz = cellaW;
      keep.notes = `Cloison verticale traversante étage ${rowNum} (${cellaW} × ${Math.round(keep.dy)} mm — ép. ${keep.thickness} mm)`;
      recomputeCutDimensions(keep);
      if (sizeChanged) this.cutDoneIds.delete(keep.id);

      for (const other of cluster) {
        if (other.id !== keep.id) {
          removeIds.add(other.id);
          this.cutDoneIds.delete(other.id);
          redirectedSelection.set(other.id, keep.id);
        }
      }
    }

    this.pieces = this.pieces.filter((p) => !removeIds.has(p.id));
    if (this.selectedId && redirectedSelection.has(this.selectedId)) {
      this.selectedId = redirectedSelection.get(this.selectedId);
    } else if (this.selectedId && removeIds.has(this.selectedId)) {
      this.selectedId = null;
    }

    this.params.mergedBays = true;
    this.params.caseD = Math.round(cellaW / 2);
    this.migratedMergedBays = true;

    this.pieces = enforcePlateConstraintsAndSplit(this.pieces);
    this.nextPieceNum = ensurePieceNumbers(this.pieces, this.nextPieceNum);
    this._syncGeneratorInputs();

    if (!skipHistory) {
      this._refreshAll();
    }
    return true;
  }

  _migrateToMergedBays() {
    if (this.migratedMergedBays || this.params.mergedBays === false) return;
    this.mergeCellaBays(true);
    this.migratedMergedBays = true;
  }

  _saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        params: this.params,
        pieces: this.pieces,
        nextPieceNum: this.nextPieceNum,
        migratedMergedBays: this.migratedMergedBays,
        cutDoneIds: Array.from(this.cutDoneIds),
        cutKerf: this.cutKerf,
        hideDoneFromPlates: this.hideDoneFromPlates
      }));
    } catch (e) {
      // ignore quota errors
    }
  }

  commitHistory() {
    this.history.push(JSON.stringify(this.pieces));
    if (this.history.length > 40) this.history.shift();
    this.redoStack = [];
    this._updateHistoryButtons();
  }

  undo() {
    if (this.history.length === 0) return;
    this.redoStack.push(JSON.stringify(this.pieces));
    this.pieces = JSON.parse(this.history.pop());
    this._refreshAll();
    this._updateHistoryButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    this.history.push(JSON.stringify(this.pieces));
    this.pieces = JSON.parse(this.redoStack.pop());
    this._refreshAll();
    this._updateHistoryButtons();
  }

  _updateHistoryButtons() {
    const undoDisabled = this.history.length === 0;
    const redoDisabled = this.redoStack.length === 0;
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const btnMobileUndo = document.getElementById('btn-mobile-undo');
    const btnMobileRedo = document.getElementById('btn-mobile-redo');
    if (btnUndo) btnUndo.disabled = undoDisabled;
    if (btnRedo) btnRedo.disabled = redoDisabled;
    if (btnMobileUndo) btnMobileUndo.disabled = undoDisabled;
    if (btnMobileRedo) btnMobileRedo.disabled = redoDisabled;
  }

  _initComponents() {
    const canvas2d = document.getElementById('canvas-2d');
    const container3d = document.getElementById('viewport-3d');

    this.editor2d = new Editor2D(canvas2d, {
      onSelect: (id) => this.selectPiece(id, '2d'),
      onPiecesChange: (piece, fullRebuild = false) => {
        this.nextPieceNum = ensurePieceNumbers(this.pieces, this.nextPieceNum);
        if (fullRebuild) {
          this.editor2d.render();
          this.viewer3d.setPieces(this.pieces);
          this._syncToolButtons();
        } else if (piece) {
          this.viewer3d.updatePieceGeometry(piece);
        }
        this._renderInspector();
        this._renderCutList();
        this._renderChecklist();
        this.frescoStudio?.render();
        this._updateGlobalStats();
        this._renderMobileSelectionBar();
        this._saveState();
      },
      onCommitHistory: () => this.commitHistory(),
    });

    this.viewer3d = new Viewer3D(container3d, {
      onSelect: (id) => this.selectPiece(id, '3d'),
    });

    this.frescoStudio = new FrescoStudio(this);

    window.addEventListener('resize', () => {
      this.editor2d.resize();
      this.viewer3d.resize();
    });
  }

  selectPiece(id, source = '') {
    this.selectedId = id;
    if (source !== '2d') this.editor2d.setSelectedId(id);
    if (source !== '3d') this.viewer3d.setSelectedId(id);
    const selPiece = this.pieces.find((p) => p.id === id);
    if (selPiece && selPiece.adventNum >= 1 && selPiece.adventNum <= 24 && this.frescoStudio) {
      if (this.frescoStudio.selectedCase !== selPiece.adventNum) {
        this.frescoStudio.selectedCase = selPiece.adventNum;
        this.frescoStudio.render();
      }
    }
    this._renderInspector();
    this._highlightCutListRow();
    this._renderMobileSelectionBar();
  }

  _refreshAll() {
    this.nextPieceNum = ensurePieceNumbers(this.pieces, this.nextPieceNum);
    this.editor2d.setPieces(this.pieces);
    this.viewer3d.setPieces(this.pieces);
    this._renderGroupFilters();
    this._renderInspector();
    this._renderCutList();
    this._renderChecklist();
    this.frescoStudio?.render();
    this._updateGlobalStats();
    this._renderMobileSelectionBar();
    this._saveState();
  }

  _bindUI() {
    // 1. Vues 2D (Dessus XZ, Côté XY, Face ZY)
    document.querySelectorAll('[data-view2d]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-view2d]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.editor2d.setViewMode(btn.dataset.view2d);
      });
    });

    document.getElementById('btn-fit-2d')?.addEventListener('click', () => {
      this.editor2d.fitView();
    });

    // 2. Outils 2D (Sélection, Plaque, Triangle, Colonne, Pan)
    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        this.editor2d.setTool(tool);
        this._syncToolButtons();
      });
    });

    // Épaisseur par défaut pour les nouvelles pièces
    const selThick = document.getElementById('select-new-thickness');
    selThick?.addEventListener('change', (e) => {
      this.editor2d.defaultThickness = Number(e.target.value) || 10;
    });

    // Magnétisme de la grille (1 mm / 5 mm / 10 mm)
    const selSnap = document.getElementById('select-snap');
    selSnap?.addEventListener('change', (e) => {
      this.editor2d.snapStep = Number(e.target.value);
    });

    // 3. Filtre par Coupe / Tranche 2D
    const chkSlice = document.getElementById('chk-slice');
    const sliceControls = document.getElementById('slice-controls');
    const rngSliceMin = document.getElementById('rng-slice-min');
    const rngSliceMax = document.getElementById('rng-slice-max');
    const lblSlice = document.getElementById('lbl-slice-range');

    const updateSlice = () => {
      this.editor2d.sliceEnabled = chkSlice.checked;
      sliceControls.classList.toggle('hidden', !chkSlice.checked);
      let v1 = Number(rngSliceMin.value);
      let v2 = Number(rngSliceMax.value);
      if (v1 > v2) [v1, v2] = [v2, v1];
      this.editor2d.sliceMin = v1;
      this.editor2d.sliceMax = v2;
      if (lblSlice) lblSlice.textContent = `${v1} à ${v2} mm`;
      this.editor2d.render();
    };
    chkSlice?.addEventListener('change', updateSlice);
    rngSliceMin?.addEventListener('input', updateSlice);
    rngSliceMax?.addEventListener('input', updateSlice);

    // 4. Contrôles 3D (Vue Éclatée, Ouvrir Bouchons 1-25, Rayons X, Caméra)
    const rngExplode = document.getElementById('rng-explode');
    const lblExplode = document.getElementById('lbl-explode');
    rngExplode?.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 100;
      if (lblExplode) lblExplode.textContent = `${e.target.value}%`;
      this.viewer3d.setExplodeFactor(val);
    });

    const btnPlugs = document.getElementById('btn-toggle-plugs');
    btnPlugs?.addEventListener('click', () => {
      const next = !this.viewer3d.plugsOpen;
      this.viewer3d.setPlugsOpen(next);
      btnPlugs.classList.toggle('active', next);
      btnPlugs.textContent = next ? 'Fermer les 25 Cases' : 'Ouvrir les 25 Cases';
    });

    const btnXray = document.getElementById('btn-xray');
    btnXray?.addEventListener('click', () => {
      const next = !this.viewer3d.xrayMode;
      this.viewer3d.setXrayMode(next);
      btnXray.classList.toggle('active', next);
    });

    const btnLabels3d = document.getElementById('btn-labels-3d');
    btnLabels3d?.addEventListener('click', () => {
      const next = !this.viewer3d.showFloatingLabels;
      this.viewer3d.setShowFloatingLabels(next);
      btnLabels3d.classList.toggle('active', next);
    });

    document.querySelectorAll('[data-cam3d]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.viewer3d.resetCamera(btn.dataset.cam3d);
      });
    });

    // 5. Mode de coloration (Par Zone Architecturale vs Par Épaisseur de Polystyrène)
    const selColorMode = document.getElementById('select-color-mode');
    selColorMode?.addEventListener('change', (e) => {
      const mode = e.target.value;
      this.editor2d.setColorMode(mode);
      this.viewer3d.setColorMode(mode);
      this._renderLegend(mode);
    });
    this._renderLegend('group');

    // 6. Mode d'affichage Split (2D + 3D côte à côte / 2D seul / 3D seul)
    document.querySelectorAll('[data-layout]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-layout]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.layout;
        const workspace = document.getElementById('workspace-split');
        workspace.dataset.layout = mode;
        setTimeout(() => {
          this.editor2d.resize();
          this.viewer3d.resize();
        }, 40);
      });
    });

    // 7. Undo / Redo & Recalcul des 24 ouvertures
    document.getElementById('btn-recalc-openings')?.addEventListener('click', () => {
      this.recalculateOpeningsToFitCella(null, false);
    });
    document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());

    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.duplicateSelectedPiece();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedId) {
          e.preventDefault();
          this.deleteSelectedPiece();
        }
      }
    });

    // 8. Onglets du panneau droit (Inspecteur Pièce / Paramètres Temple / Liste de Découpe)
    document.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activateSidebarTab(btn.dataset.tab);
      });
    });

    // 8bis. Redimensionnement & Agrandissement (Normal / Large / Plein écran) du panneau droit
    this._bindSidebarResize();

    // 8ter. Interface Mobile (navigation basse, tiroir outils/filtres & barre flottante pièce)
    this._bindMobileUI();

    // 9. Formulaire du Générateur Paramétrique
    this._bindGeneratorForm();

    // 10. Export / Import JSON
    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({
        params: this.params,
        pieces: this.pieces,
        nextPieceNum: this.nextPieceNum,
        migratedMergedBays: this.migratedMergedBays,
        cutDoneIds: Array.from(this.cutDoneIds),
        cutKerf: this.cutKerf
      }, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plan_temple_calendrier_avent.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    const fileInput = document.getElementById('input-import-json');
    document.getElementById('btn-import-json')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (Array.isArray(data.pieces)) {
            this.commitHistory();
            this.pieces = data.pieces;
            if (data.params) {
              this.params = { ...DEFAULT_TEMPLE_PARAMS, ...data.params };
              if (data.params.mergedBays === undefined) {
                this.params.mergedBays = !this._hasSeparatedCellaBays();
              }
            }
            this.migratedMergedBays = true;
            this.nextPieceNum = ensurePieceNumbers(this.pieces, data.nextPieceNum || 1);
            this.cutDoneIds = new Set(Array.isArray(data.cutDoneIds) ? data.cutDoneIds : []);
            if (Number.isFinite(data.cutKerf) && data.cutKerf >= 0) this.cutKerf = data.cutKerf;
            this._syncGeneratorInputs();
            this._refreshAll();
            this.editor2d.fitView();
          }
        } catch (err) {
          alert('Fichier JSON invalide.');
        }
      };
      reader.readAsText(file);
    });

    setTimeout(() => {
      if (this.mobileQuery.matches) {
        this.setMobileView('3d');
        this.viewer3d.resetCamera('iso');
      } else {
        this.editor2d.fitView();
        this.viewer3d.resetCamera('iso');
      }
    }, 60);
  }

  activateSidebarTab(tabName) {
    if (!tabName) return;
    this.activeSidebarTab = tabName;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.sidebar-pane').forEach((p) => {
      p.classList.toggle('active', p.id === `pane-${tabName}`);
    });
    if (this.mobileView === 'panel') {
      this._syncMobileNavActive();
      this._renderMobileSelectionBar();
    }
  }

  _syncMobileNavActive() {
    const activeKey = this.mobileView === 'panel' ? this.activeSidebarTab : this.mobileView;
    document.querySelectorAll('#mobile-bottom-nav [data-mobile-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mobileView === activeKey);
    });
  }

  setMobileView(view, targetTab = null) {
    this.mobileView = view;
    document.querySelector('.main-layout')?.classList.remove('sidebar-fullscreen');
    document.body.dataset.mobileView = view;
    if (targetTab) {
      this.activateSidebarTab(targetTab);
    }
    this._syncMobileNavActive();
    this._renderMobileSelectionBar();

    requestAnimationFrame(() => {
      if (view === '3d') {
        this.viewer3d.resize();
      } else if (view === '2d') {
        this.editor2d.resize();
        if (!this._mobile2dFitted) {
          this.editor2d.fitView();
          this._mobile2dFitted = true;
        }
      }
    });
  }

  _setMobileSheetOpen(open) {
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (!backdrop) return;
    backdrop.classList.toggle('hidden', !open);
  }

  _bindMobileUI() {
    // 1. Navigation basse fixe (3D / 2D / Découpes / Suivi / Fresques)
    document.querySelectorAll('#mobile-bottom-nav [data-mobile-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.mobileView;
        if (target === '3d' || target === '2d') {
          this.setMobileView(target);
        } else {
          this.setMobileView('panel', target);
        }
      });
    });

    // 2. Boutons rapides en-tête mobile (Annuler / Rétablir / Outils & Filtres)
    document.getElementById('btn-mobile-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('btn-mobile-redo')?.addEventListener('click', () => this.redo());
    document.getElementById('btn-mobile-sheet')?.addEventListener('click', () => this._setMobileSheetOpen(true));
    document.getElementById('btn-close-mobile-sheet')?.addEventListener('click', () => this._setMobileSheetOpen(false));

    const backdrop = document.getElementById('mobile-sheet-backdrop');
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) this._setMobileSheetOpen(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._setMobileSheetOpen(false);
    });

    // 3. Mode de coloration dans le tiroir mobile
    document.querySelectorAll('[data-mobile-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mobileColor;
        const sel = document.getElementById('select-color-mode');
        if (sel) sel.value = mode;
        this.editor2d.setColorMode(mode);
        this.viewer3d.setColorMode(mode);
        this._renderLegend(mode);
      });
    });

    // 4. Tout afficher (réinitialiser les filtres de groupes)
    document.getElementById('btn-mobile-show-all-groups')?.addEventListener('click', () => {
      for (const k of Object.keys(GROUP_META)) {
        this.editor2d.visibleGroups.add(k);
        this.viewer3d.visibleGroups.add(k);
      }
      this._renderGroupFilters();
      this.editor2d.render();
      this.viewer3d.applyTransforms();
    });

    // 5. Actions rapides dans le tiroir mobile
    document.getElementById('btn-mobile-recalc')?.addEventListener('click', () => {
      this.recalculateOpeningsToFitCella(null, false);
      this._setMobileSheetOpen(false);
    });
    document.getElementById('btn-mobile-open-generator')?.addEventListener('click', () => {
      this._setMobileSheetOpen(false);
      this.setMobileView('panel', 'generator');
    });
    document.getElementById('btn-mobile-export')?.addEventListener('click', () => {
      this._setMobileSheetOpen(false);
      document.getElementById('btn-export-json')?.click();
    });
    document.getElementById('btn-mobile-import')?.addEventListener('click', () => {
      this._setMobileSheetOpen(false);
      document.getElementById('input-import-json')?.click();
    });

    // 6. Réadaptation propre lors du passage portrait/paysage ou mobile<->desktop
    this.mobileQuery.addEventListener('change', (e) => {
      if (e.matches) {
        this.setMobileView(this.mobileView || '3d');
      } else {
        requestAnimationFrame(() => {
          this.editor2d.resize();
          this.viewer3d.resize();
        });
      }
    });
  }

  _renderMobileSelectionBar() {
    const bar = document.getElementById('mobile-selection-bar');
    if (!bar) return;

    const p = this.pieces.find((item) => item.id === this.selectedId);
    if (!p) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      document.body.classList.remove('has-mobile-selection');
      return;
    }

    const isCuttable = p.material !== 'plastic' && p.shape !== 'cylinder_y';
    const isDone = this.cutDoneIds.has(p.id);
    const dimsTxt = p.material === 'plastic'
      ? `Plastique • ${Math.round(p.dx)}×${Math.round(p.dz)}×H${Math.round(p.dy)} mm`
      : p.shape === 'prism_z'
        ? `△ ${Math.round(p.cutW)}×${Math.round(p.cutH)} mm • ép. ${p.thickness} mm`
        : `${Math.round(p.cutW)}×${Math.round(p.cutH)} mm • ép. ${p.thickness} mm`;

    const onInspector = this.mobileView === 'panel' && this.activeSidebarTab === 'inspector';
    const show3dBtn = this.mobileView !== '3d';
    const show2dBtn = this.mobileView !== '2d';
    const showInspBtn = !onInspector;

    bar.classList.remove('hidden');
    document.body.classList.add('has-mobile-selection');
    bar.innerHTML = `
      <div class="msb-info">
        <div class="msb-title-row">
          ${p.pieceNum ? `<span class="piece-num-badge">${formatPieceNum(p)}</span>` : ''}
          <span class="msb-name">${p.name}</span>
        </div>
        <div class="msb-dims">${dimsTxt}</div>
      </div>
      <div class="msb-actions">
        ${isCuttable ? `<button class="msb-btn ${isDone ? 'done' : ''}" data-msb="toggle-done" title="Marquer comme découpée">${isDone ? '✓' : '○'}</button>` : ''}
        ${show3dBtn ? `<button class="msb-btn" data-msb="go-3d" title="Localiser en 3D">🧊</button>` : ''}
        ${show2dBtn && !showInspBtn ? `<button class="msb-btn" data-msb="go-2d" title="Localiser en 2D">✏️</button>` : ''}
        ${showInspBtn ? `<button class="msb-btn primary" data-msb="go-inspector" title="Inspecter &amp; éditer les cotes">📐</button>` : ''}
        <button class="msb-btn" data-msb="clear" title="Désélectionner">✕</button>
      </div>
    `;

    bar.querySelector('[data-msb="toggle-done"]')?.addEventListener('click', () => {
      if (this.cutDoneIds.has(p.id)) this.cutDoneIds.delete(p.id);
      else this.cutDoneIds.add(p.id);
      this._saveState();
      this._renderChecklist();
      this._renderCutList();
      this._renderMobileSelectionBar();
    });
    bar.querySelector('[data-msb="go-3d"]')?.addEventListener('click', () => {
      this.setMobileView('3d');
    });
    bar.querySelector('[data-msb="go-2d"]')?.addEventListener('click', () => {
      this.setMobileView('2d');
    });
    bar.querySelector('[data-msb="go-inspector"]')?.addEventListener('click', () => {
      this.setMobileView('panel', 'inspector');
    });
    bar.querySelector('[data-msb="clear"]')?.addEventListener('click', () => {
      this.selectPiece(null);
    });
  }

  _syncToolButtons() {
    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === this.editor2d.activeTool);
    });
  }

  _bindSidebarResize() {
    const mainLayout = document.querySelector('.main-layout');
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    const btnWide = document.getElementById('btn-sidebar-wide');
    const btnFull = document.getElementById('btn-sidebar-full');
    if (!mainLayout || !sidebar || !resizer) return;

    const DEFAULT_W = 340;
    const WIDE_W = Math.min(720, Math.max(580, Math.round(window.innerWidth * 0.48)));

    const refreshViewports = () => {
      requestAnimationFrame(() => {
        if (!mainLayout.classList.contains('sidebar-fullscreen')) {
          this.editor2d.resize();
          this.viewer3d.resize();
        }
      });
    };

    const updateButtons = () => {
      const isFull = mainLayout.classList.contains('sidebar-fullscreen');
      const curW = parseInt(sidebar.style.width, 10) || DEFAULT_W;
      const isWide = !isFull && curW >= 500;
      btnWide?.classList.toggle('active', isWide);
      btnFull?.classList.toggle('active', isFull);
      if (btnFull) {
        btnFull.textContent = isFull ? '⤡' : '⤢';
        btnFull.title = isFull ? 'Revenir à la vue partagée 2D/3D' : 'Afficher en Plein Écran';
      }
      if (btnWide) {
        btnWide.title = isWide ? 'Revenir à la largeur normale (340 px)' : 'Élargir le panneau (mode Large)';
      }
    };

    // Bouton Large <-> Normal
    btnWide?.addEventListener('click', () => {
      mainLayout.classList.remove('sidebar-fullscreen');
      const curW = parseInt(sidebar.style.width, 10) || DEFAULT_W;
      sidebar.style.width = curW >= 500 ? `${DEFAULT_W}px` : `${WIDE_W}px`;
      updateButtons();
      refreshViewports();
    });

    // Bouton Plein écran <-> Normal/Précédent
    btnFull?.addEventListener('click', () => {
      mainLayout.classList.toggle('sidebar-fullscreen');
      updateButtons();
      refreshViewports();
    });

    // Glisser-déposer de la poignée gauche du panneau
    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const newW = Math.max(290, Math.min(window.innerWidth - 220, window.innerWidth - e.clientX));
      sidebar.style.width = `${Math.round(newW)}px`;
      updateButtons();
      refreshViewports();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      refreshViewports();
    });

    // Double-clic sur la poignée -> réinitialiser à 340 px
    resizer.addEventListener('dblclick', () => {
      mainLayout.classList.remove('sidebar-fullscreen');
      sidebar.style.width = `${DEFAULT_W}px`;
      updateButtons();
      refreshViewports();
    });

    updateButtons();
  }

  _bindGeneratorForm() {
    this._syncGeneratorInputs();

    const updateAutoCaseH = () => {
      const colH = Number(document.getElementById('param-colH')?.value) || 170;
      const rows = Number(document.getElementById('param-rows')?.value) || 3;
      const tGrid = Number(document.getElementById('param-tGrid')?.value) || 6;
      const elCaseH = document.getElementById('param-caseH');
      if (elCaseH) {
        elCaseH.value = Math.floor((colH - (rows - 1) * tGrid) / rows);
      }
    };

    ['param-colH', 'param-rows', 'param-tGrid'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', updateAutoCaseH);
    });
    updateAutoCaseH();

    // Ajuster automatiquement caseD (± tStruct/2) lors du basculement trames fusionnées / séparées
    // pour conserver la largeur extérieure de la Cella (ex: 180 mm -> 90 mm sans cloison / 85 mm avec cloison)
    const chkMerged = document.getElementById('param-mergedBays');
    chkMerged?.addEventListener('change', () => {
      const elCaseD = document.getElementById('param-caseD');
      const tStruct = Number(document.getElementById('param-tStruct')?.value) || 10;
      if (!elCaseD) return;
      const curD = Number(elCaseD.value) || 90;
      const halfSpine = Math.round(tStruct / 2);
      elCaseD.value = chkMerged.checked ? curD + halfSpine : Math.max(25, curD - halfSpine);
    });

    const btnRegen = document.getElementById('btn-regenerate-temple');
    btnRegen?.addEventListener('click', () => {
      const readNum = (id, fallback) => {
        const el = document.getElementById(id);
        const v = Number(el?.value);
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };
      const colH = readNum('param-colH', 170);
      const rows = readNum('param-rows', 3);
      const tGrid = readNum('param-tGrid', 6);
      const mergedBays = document.getElementById('param-mergedBays')?.checked ?? true;
      this.params = {
        cols: readNum('param-cols', 4),
        rows,
        caseL: readNum('param-caseL', 60),
        caseH: Math.floor((colH - (rows - 1) * tGrid) / rows),
        caseD: readNum('param-caseD', mergedBays ? 90 : 85),
        colH,
        colDiam: readNum('param-colDiam', 30),
        tStruct: readNum('param-tStruct', 10),
        tGrid,
        tPlug: readNum('param-tPlug', 10),
        podiumH: readNum('param-podiumH', 50),
        podiumMargin: readNum('param-podiumMargin', 15),
        pronaosL: readNum('param-pronaosL', 90),
        stairL: readNum('param-stairL', 55),
        frontCols: readNum('param-frontCols', 4),
        pedimentH: readNum('param-pedimentH', 55),
        mergedBays,
      };
      this.commitHistory();
      this.selectedId = null;
      this.migratedMergedBays = true;
      this.pieces = enforcePlateConstraintsAndSplit(generateRomanTemple(this.params));
      this._refreshAll();
      this.editor2d.fitView();
    });
  }

  _syncGeneratorInputs() {
    for (const [key, val] of Object.entries(this.params)) {
      const el = document.getElementById(`param-${key}`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val;
    }
  }

  _renderGroupFilters() {
    const targets = [
      document.getElementById('group-filters'),
      document.getElementById('mobile-group-filters'),
    ].filter(Boolean);

    let hiddenCount = 0;
    for (const [groupKey] of Object.entries(GROUP_META)) {
      const count = this.pieces.filter((p) => p.group === groupKey).length;
      if (count === 0 && groupKey === 'custom') continue;
      if (!this.editor2d.visibleGroups.has(groupKey)) hiddenCount++;
    }

    const badge = document.getElementById('mobile-filter-badge');
    if (badge) {
      badge.textContent = hiddenCount > 0 ? String(hiddenCount) : '';
      badge.classList.toggle('hidden', hiddenCount === 0);
    }

    for (const container of targets) {
      container.innerHTML = '';

      for (const [groupKey, meta] of Object.entries(GROUP_META)) {
        const count = this.pieces.filter((p) => p.group === groupKey).length;
        if (count === 0 && groupKey === 'custom') continue;

        const active = this.editor2d.visibleGroups.has(groupKey);
        const chip = document.createElement('button');
        chip.className = `group-chip ${active ? 'active' : ''}`;
        chip.innerHTML = `
          <span class="dot" style="background:${meta.color}"></span>
          <span>${meta.label}</span>
          <span class="count">${count}</span>
        `;
        chip.addEventListener('click', () => {
          if (this.editor2d.visibleGroups.has(groupKey)) {
            this.editor2d.visibleGroups.delete(groupKey);
            this.viewer3d.visibleGroups.delete(groupKey);
          } else {
            this.editor2d.visibleGroups.add(groupKey);
            this.viewer3d.visibleGroups.add(groupKey);
          }
          this._renderGroupFilters();
          this.editor2d.render();
          this.viewer3d.applyTransforms();
        });
        container.appendChild(chip);
      }
    }
  }

  _renderLegend(mode) {
    const html = mode === 'thickness'
      ? Object.entries(THICKNESS_COLORS)
          .filter(([t]) => Number(t) !== 5)
          .map(([t, col]) => `<span class="legend-item"><i style="background:${col}"></i>Plaque ${t} mm</span>`)
          .join('')
      : Object.values(GROUP_META)
          .map((m) => `<span class="legend-item"><i style="background:${m.color}"></i>${m.label}</span>`)
          .join('');

    const el = document.getElementById('color-legend');
    if (el) el.innerHTML = html;
    const mobileEl = document.getElementById('mobile-color-legend');
    if (mobileEl) mobileEl.innerHTML = html;

    document.querySelectorAll('[data-mobile-color]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mobileColor === mode);
    });
  }

  // ============================================================================
  // RECALCUL AUTOMATIQUE DES 24 OUVERTURES SELON LA LONGUEUR & ÉPAISSEUR (6 MM)
  // ============================================================================
  getCellaOpeningMetrics() {
    const rearWall = this.pieces.find((p) => p.name.includes('Mur Arrière de la Cella'));
    const frontWall = this.pieces.find((p) => p.name.includes('Mur Avant de la Cella'));
    const spine = this.pieces.find((p) => p.name.includes('Cloison Centrale Cella'));
    const shelves = this.pieces.filter((p) => p.name.includes('Étagère Horizontale'));
    const sidePlugs = this.pieces.filter((p) => p.adventNum && p.adventNum <= 24);

    const cols = this.params.cols || 4;
    const rows = this.params.rows || 3;
    const tGrid = this.params.tGrid || 6;
    const tRear = rearWall ? rearWall.dx : (this.params.tStruct || 10);
    const tFront = frontWall ? frontWall.dx : (this.params.tStruct || 10);
    const cellaH = rearWall ? rearWall.dy : (this.params.colH || 170);
    const cellaStartY = rearWall ? rearWall.y : (spine ? spine.y : 70);

    // Calcul vertical sur Y (3 étages + 2 étagères de 6 mm dans 170 mm)
    const totalShelvesH = (rows - 1) * tGrid;
    const availableCasesH = Math.max(rows * 10, cellaH - totalShelvesH);
    const baseRowH = Math.floor(availableCasesH / rows);
    const remainderH = availableCasesH - baseRowH * rows;
    const rowHeights = [];
    const rowYOffsets = [];
    let accY = 0;
    for (let r = 0; r < rows; r++) {
      const h = baseRowH + (r < remainderH ? 1 : 0);
      rowYOffsets.push(accY);
      rowHeights.push(h);
      accY += h + tGrid;
    }

    // Longueur intérieure actuelle déduite des bouchons existants d'un étage
    const firstRowPlugs = sidePlugs.filter((p) => p.plugSide === 'left').slice(0, cols);
    const oldInnerL = firstRowPlugs.length === cols
      ? Math.round(firstRowPlugs.reduce((s, p) => s + p.dx, 0) + (cols - 1) * tGrid)
      : (spine ? Math.round(spine.dx) : 255);

    // Examiner les pièces du corps de la cella qui ont pu être redimensionnées ou déplacées
    const candidates = [];
    if (rearWall && frontWall) {
      candidates.push(Math.round(frontWall.x - (rearWall.x + rearWall.dx)));
    }
    const spineParts = this.pieces.filter((p) => p.name.includes('Cloison Centrale Cella'));
    if (spineParts.length > 0) {
      candidates.push(Math.round(spineParts.reduce((s, p) => s + p.dx, 0)));
    }
    const shelf1Parts = this.pieces.filter((p) =>
      p.name.startsWith('Étagère Horizontale N°1') ||
      p.name.startsWith('Étagère Horizontale Gauche N°1')
    );
    if (shelf1Parts.length > 0) {
      candidates.push(Math.round(shelf1Parts.reduce((s, p) => s + p.dx, 0)));
    }

    const modifiedCandidate = candidates.find((val) => Math.abs(val - oldInnerL) >= 1 && val > 30);
    const innerL = modifiedCandidate !== undefined ? modifiedCandidate : (candidates[0] || oldInnerL);
    const totalCellaL = tRear + innerL + tFront;
    const { cellaW } = this._getCellaZBounds();
    const hasSeparatedBays = this._hasSeparatedCellaBays();

    const totalDividersW = (cols - 1) * tGrid;
    const availableOpeningsW = Math.max(cols * 10, innerL - totalDividersW);
    const exactCaseL = availableOpeningsW / cols;
    const baseCaseL = Math.floor(availableOpeningsW / cols);
    const remainder = availableOpeningsW - baseCaseL * cols;

    const colWidths = [];
    for (let c = 0; c < cols; c++) {
      colWidths.push(baseCaseL + (c < remainder ? 1 : 0));
    }

    return {
      cols,
      rows,
      tGrid,
      tRear,
      tFront,
      cellaH,
      cellaW,
      cellaStartY,
      hasSeparatedBays,
      rowHeights,
      rowYOffsets,
      oldInnerL,
      innerL,
      totalCellaL,
      totalDividersW,
      availableOpeningsW,
      exactCaseL,
      colWidths,
      needsSync: modifiedCandidate !== undefined
    };
  }

  recalculateOpeningsToFitCella(forcedTotalCellaL = null, onlyIfOutOfSync = false, skipHistory = false) {
    this._recombineSplitCellaPieces();
    const m = this.getCellaOpeningMetrics();
    if (onlyIfOutOfSync && !m.needsSync && forcedTotalCellaL === null) {
      this.pieces = enforcePlateConstraintsAndSplit(this.pieces);
      return;
    }

    const sortDivs = (list) => [...list].sort((a, b) => (Math.round(a.y / 4) - Math.round(b.y / 4)) || (a.x - b.x));

    const rearWall = this.pieces.find((p) => p.name.includes('Mur Arrière de la Cella'));
    const frontWall = this.pieces.find((p) => p.name.includes('Mur Avant de la Cella'));
    const spine = this.pieces.find((p) => p.name.includes('Cloison Centrale Cella'));
    const mergedShelves = this.pieces
      .filter((p) => p.name.includes('Étagère Horizontale') && !p.name.includes('Gauche') && !p.name.includes('Droite'))
      .sort((a, b) => a.y - b.y);
    const leftShelves = this.pieces.filter((p) => p.name.includes('Étagère Horizontale Gauche')).sort((a, b) => a.y - b.y);
    const rightShelves = this.pieces.filter((p) => p.name.includes('Étagère Horizontale Droite')).sort((a, b) => a.y - b.y);
    const mergedDivs = sortDivs(this.pieces.filter((p) => p.name.includes('Cloison Verticale Case') && !p.name.includes('(G') && !p.name.includes('(D')));
    const leftDivs = sortDivs(this.pieces.filter((p) => p.name.includes('Cloison Verticale Case (G')));
    const rightDivs = sortDivs(this.pieces.filter((p) => p.name.includes('Cloison Verticale Case (D')));
    const leftPlugs = this.pieces.filter((p) => p.adventNum && p.plugSide === 'left').sort((a, b) => a.adventNum - b.adventNum);
    const rightPlugs = this.pieces.filter((p) => p.adventNum && p.plugSide === 'right').sort((a, b) => a.adventNum - b.adventNum);

    const targetTotalL = Number.isFinite(forcedTotalCellaL) && forcedTotalCellaL > 60
      ? Math.round(forcedTotalCellaL)
      : m.totalCellaL;
    const innerL = targetTotalL - m.tRear - m.tFront;

    if (!onlyIfOutOfSync && !skipHistory) {
      this.commitHistory();
    }

    const startX = rearWall ? (rearWall.x + rearWall.dx) : (spine ? spine.x : 15);

    // 1. Aligner la cloison centrale (si présente), les étagères (ép. 6 mm) et le mur avant de la cella sur innerL et sur les étages Y
    if (spine) {
      spine.x = startX;
      spine.dx = innerL;
      recomputeCutDimensions(spine);
    }
    const updateShelfList = (list, isMerged = false) => {
      list.forEach((sh, idx) => {
        const r = idx + 1;
        sh.x = startX;
        sh.dx = innerL;
        sh.dy = m.tGrid;
        sh.thickness = m.tGrid;
        if (m.rowYOffsets[r] !== undefined) {
          sh.y = m.cellaStartY + m.rowYOffsets[r] - m.tGrid;
        }
        if (isMerged) {
          sh.notes = `Plaque horizontale traversante (${Math.round(sh.dx)} × ${Math.round(sh.dz)} mm — trames fusionnées sans cloison centrale)`;
        }
        recomputeCutDimensions(sh);
      });
    };
    updateShelfList(mergedShelves, true);
    updateShelfList(leftShelves, false);
    updateShelfList(rightShelves, false);
    if (frontWall) {
      frontWall.x = startX + innerL;
      recomputeCutDimensions(frontWall);
    }

    // 2. Calculer la largeur et l'abscisse X de chacune des colonnes de cases (avec cloisons de 6 mm)
    const totalDividersW = (m.cols - 1) * m.tGrid;
    const availableW = Math.max(m.cols * 10, innerL - totalDividersW);
    const baseCaseL = Math.floor(availableW / m.cols);
    const remainder = availableW - baseCaseL * m.cols;

    const colWidths = [];
    const colStartX = [];
    let curX = startX;
    for (let c = 0; c < m.cols; c++) {
      const w = baseCaseL + (c < remainder ? 1 : 0);
      colStartX.push(curX);
      colWidths.push(w);
      curX += w + m.tGrid;
    }

    // 3. Repositionner et redimensionner toutes les cloisons verticales (traversantes ou gauche/droite) en 6 mm
    const dividersPerRow = m.cols - 1;
    const updateDivList = (list, isMerged = false) => {
      list.forEach((div, idx) => {
        const r = Math.floor(idx / dividersPerRow);
        const colIdx = (idx % dividersPerRow) + 1;
        div.x = colStartX[colIdx] - m.tGrid;
        div.dx = m.tGrid;
        div.thickness = m.tGrid;
        if (m.rowHeights[r] !== undefined) {
          div.y = m.cellaStartY + m.rowYOffsets[r];
          div.dy = m.rowHeights[r];
        }
        div.notes = isMerged
          ? `Cloison verticale traversante étage ${r + 1} (${Math.round(div.dz)} × ${div.dy} mm — ép. ${m.tGrid} mm)`
          : `Cloison verticale étage ${r + 1} (${Math.round(div.dz)} × ${div.dy} mm — ép. ${m.tGrid} mm)`;
        recomputeCutDimensions(div);
      });
    };
    updateDivList(mergedDivs, true);
    updateDivList(leftDivs, false);
    updateDivList(rightDivs, false);

    // 4. Redimensionner et repositionner les 24 bouchons/ouvertures (1..12 et 13..24) sur X et sur Y
    leftPlugs.forEach((plug, idx) => {
      const r = (m.rows - 1) - Math.floor(idx / m.cols);
      const colIdx = idx % m.cols;
      plug.x = colStartX[colIdx];
      plug.dx = colWidths[colIdx];
      if (m.rowHeights[r] !== undefined) {
        plug.y = m.cellaStartY + m.rowYOffsets[r];
        plug.dy = m.rowHeights[r];
      }
      plug.notes = `Façade/bouchon encastrable de la case N°${plug.adventNum} (${plug.dx} × ${plug.dy} mm)`;
      recomputeCutDimensions(plug);
    });
    rightPlugs.forEach((plug, idx) => {
      const r = (m.rows - 1) - Math.floor(idx / m.cols);
      const colIdx = idx % m.cols;
      plug.x = colStartX[colIdx];
      plug.dx = colWidths[colIdx];
      if (m.rowHeights[r] !== undefined) {
        plug.y = m.cellaStartY + m.rowYOffsets[r];
        plug.dy = m.rowHeights[r];
      }
      plug.notes = `Façade/bouchon encastrable de la case N°${plug.adventNum} (${plug.dx} × ${plug.dy} mm)`;
      recomputeCutDimensions(plug);
    });

    this.params.caseL = baseCaseL;
    this.params.caseH = m.rowHeights[0] || 53;
    this.pieces = enforcePlateConstraintsAndSplit(this.pieces);
    this._syncGeneratorInputs();
    this._refreshAll();
  }

  _getPackOptions() {
    return {
      kerf: this.cutKerf,
      excludeIds: this.hideDoneFromPlates ? this.cutDoneIds : null
    };
  }

  _buildPlateSummaryCardHTML(withControls = false) {
    const pack = packPiecesIntoPlates(this.pieces, PLATE_WIDTH, PLATE_HEIGHT, this._getPackOptions());
    const rows = [20, 10, 6].map((t) => {
      const info = pack[t];
      const col = THICKNESS_COLORS[t] || '#38bdf8';
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(51,65,85,0.4);">
          <span><i class="dot" style="background:${col};margin-right:6px;"></i><strong>300 × 200 × ${t} mm</strong></span>
          <span style="font-weight:800;color:#fbbf24;font-size:13px;">${info.plateCount} plaque${info.plateCount > 1 ? 's' : ''} <span style="font-weight:400;color:#94a3b8;font-size:11px;">(${info.efficiency}% utilisé)</span></span>
        </div>
      `;
    }).join('');

    const kerfControlsHtml = withControls ? `
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid rgba(51,65,85,0.5);display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;font-size:11px;color:#cbd5e1;">
        <label style="display:inline-flex;align-items:center;gap:5px;">
          <span>Trait de coupe (perte) :</span>
          <select id="sel-cut-kerf" class="select-compact">
            <option value="0" ${this.cutKerf === 0 ? 'selected' : ''}>0 mm</option>
            <option value="1" ${this.cutKerf === 1 ? 'selected' : ''}>1 mm</option>
            <option value="1.5" ${this.cutKerf === 1.5 ? 'selected' : ''}>1.5 mm</option>
            <option value="2" ${this.cutKerf === 2 ? 'selected' : ''}>2 mm</option>
            <option value="3" ${this.cutKerf === 3 ? 'selected' : ''}>3 mm</option>
          </select>
        </label>
        ${this.cutDoneIds.size > 0 ? `
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:#6ee7b7;">
            <input type="checkbox" id="chk-hide-done-plates" ${this.hideDoneFromPlates ? 'checked' : ''} />
            <span>Uniquement ce qu'il reste à couper</span>
          </label>
        ` : ''}
      </div>
    ` : '';

    return `
      <div class="cut-highlight-box" style="margin-bottom:12px; text-align:left; border-color:rgba(245,158,11,0.45); background:rgba(245,158,11,0.08);">
        <div class="cut-title" style="color:#fbbf24;display:flex;justify-content:space-between;">
          <span>📦 PLAQUES 300 × 200 MM ${this.hideDoneFromPlates ? 'RESTANTES' : 'REQUISES'}</span>
          <span>Trait coupe : ${this.cutKerf} mm</span>
        </div>
        <div style="font-size:12px; color:#f8fafc; margin-top:6px;">
          ${rows}
        </div>
        ${kerfControlsHtml}
      </div>
    `;
  }

  // ============================================================================
  // INSPECTEUR DE PIÈCE (ÉDITION PRÉCISE AU MILLIMÈTRE)
  // ============================================================================
  _renderInspector() {
    const container = document.getElementById('inspector-content');
    if (!container) return;

    const m = this.getCellaOpeningMetrics();
    const uniqueWidths = Array.from(new Set(m.colWidths));
    const widthSummary = uniqueWidths.length === 1
      ? `<strong>${uniqueWidths[0]} mm</strong> (${m.cols}× identiques)`
      : `<strong>${m.colWidths.join(' / ')} mm</strong> (moy. ${m.exactCaseL.toFixed(1)} mm)`;
    const heightSummary = `<strong>${m.rowHeights.join(' / ')} mm</strong> (+ ${m.rows - 1}×${m.tGrid} mm = ${m.cellaH} mm)`;

    const cellaSummaryCard = `
      <div class="cut-highlight-box" style="margin-bottom:12px; text-align:left;">
        <div class="cut-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>📏 CALCUL DES 24 OUVERTURES (CELLA)</span>
          <span>Cloisons ${m.tGrid} mm</span>
        </div>
        <div style="font-size:12px; color:#e2e8f0; margin-top:6px; line-height:1.5;">
          <div>• Longueur ext. Cella : <strong>${m.totalCellaL} mm</strong> (int. <strong>${m.innerL} mm</strong>)</div>
          <div>• Casier : <strong>${m.hasSeparatedBays ? '2 trames séparées' : `Trames fusionnées (${m.cellaW} mm)`}</strong></div>
          <div>• Cloisons verticales : <strong>${m.cols - 1} × ${m.tGrid} mm = ${m.totalDividersW} mm</strong></div>
          <div>• Largeur par ouverture : ${widthSummary}</div>
          <div>• Hauteur par étage : ${heightSummary}</div>
        </div>
        <div style="display:flex; gap:6px; margin-top:8px; align-items:center;">
          <input type="number" id="quick-cella-total-l" value="${m.totalCellaL}" step="1" title="Longueur extérieure totale de la Cella (mm)" style="background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:5px;padding:4px 7px;width:85px;font-weight:700;" />
          <button id="btn-apply-cella-l" class="btn-compact accent" style="flex:1;">Recalculer pour cette longueur</button>
        </div>
        ${m.hasSeparatedBays ? `
          <button id="btn-merge-bays" class="btn-compact" style="width:100%;margin-top:6px;color:#7dd3fc;border-color:rgba(56,189,248,0.4);">
            🔗 Fusionner les 2 trames (${m.cellaW} mm, sans cloison centrale)
          </button>
        ` : ''}
      </div>
    `;

    const plateSummaryCard = this._buildPlateSummaryCardHTML();

    const p = this.pieces.find((item) => item.id === this.selectedId);
    if (!p) {
      container.innerHTML = `
        ${plateSummaryCard}
        ${cellaSummaryCard}
        <div class="empty-state">
          <p><strong>Aucune pièce sélectionnée</strong></p>
          <p>Clique sur une pièce dans le <strong>Plan 2D</strong> ou dans le <strong>Volume 3D</strong> pour inspecter ses cotes exactes de découpe, la redimensionner ou la déplacer.</p>
          <div class="hint-box">
            <div><strong>Astuces rapides :</strong></div>
            <ul>
              <li>Si tu étires la longueur de la Cella en 2D, clique sur <strong>📏 Recalculer les 24 Ouvertures</strong> en haut pour ajuster automatiquement toutes les cases et cloisons !</li>
              <li>Double-clique sur un <strong>bouchon (#1 à #25)</strong> en 3D pour ouvrir/fermer sa case.</li>
            </ul>
          </div>
        </div>
      `;
      this._bindQuickCellaCard();
      return;
    }

    const groupOptions = Object.entries(GROUP_META)
      .map(([k, v]) => `<option value="${k}" ${p.group === k ? 'selected' : ''}>${v.label}</option>`)
      .join('');

    const stairSpec = p.shape === 'stairs' ? computeStairLayers(p) : null;
    const stairGuideHtml = stairSpec ? `
      <div class="cut-highlight-box" style="margin-top:8px;text-align:left;border-color:rgba(56,189,248,0.45);background:rgba(56,189,248,0.08);">
        <div class="cut-title" style="color:#7dd3fc;display:flex;justify-content:space-between;">
          <span>🪜 MONTAGE ESCALIER (${stairSpec.numLayers} TRANCHES × ${stairSpec.stepH} MM)</span>
          <span>H = ${stairSpec.stackedHeight} mm</span>
        </div>
        ${stairSpec.heightMismatch ? `
          <div style="font-size:11px;color:#fca5a5;margin:5px 0;font-weight:600;">
            ⚠️ ${stairSpec.numLayers} × ${stairSpec.stepH} mm = ${stairSpec.stackedHeight} mm (≠ ${stairSpec.targetHeight} mm demandés). Passe l'épaisseur en 10 mm pour tomber juste !
          </div>
        ` : ''}
        <div style="font-size:11px;color:#e2e8f0;margin-top:5px;line-height:1.45;">
          ${stairSpec.layers.map((l) => {
            const role = l.index === 0 && !l.hasPlug
              ? 'bas au sol (butée semelle)'
              : (l.hasPlug ? `alignée dos +${l.plugDepth} mm (bouchon #25)` : `marche ${l.index + 1}`);
            return `<div>• <strong>${l.label}</strong> : <strong>${l.dz} × ${l.dx} mm</strong> <span style="color:#94a3b8;">(${role})</span></div>`;
          }).join('')}
        </div>
        <div style="font-size:10.5px;color:#94a3b8;margin-top:6px;border-top:1px solid rgba(51,65,85,0.5);padding-top:5px;">
          Astuce collage : empile les tranches avec bouchon bord à bord à l'arrière, puis pose-les sur la tranche 1/N en laissant dépasser ${stairSpec.plugDepth} mm derrière (le tenon qui rentre dans la Case #25). Le dessus du podium forme la dernière marche (+${stairSpec.stepH} mm).
        </div>
      </div>
    ` : '';

    container.innerHTML = `
      ${plateSummaryCard}
      ${cellaSummaryCard}
      <div class="inspector-card">
        <div class="inspector-header">
          <div style="display:flex;align-items:center;gap:6px;">
            ${p.pieceNum ? `<span class="piece-num-badge">${formatPieceNum(p)}</span>` : ''}
            <span class="badge" style="background:${GROUP_META[p.group]?.badge || '#475569'}">${GROUP_META[p.group]?.label || p.group}</span>
          </div>
          ${p.adventNum ? `<span class="badge advent-badge">Case #${p.adventNum}</span>` : ''}
        </div>

        <label class="field-label">Nom de la pièce
          <input type="text" id="insp-name" value="${p.name}" />
        </label>

        <div class="field-row">
          <label class="field-label">Groupe
            <select id="insp-group">${groupOptions}</select>
          </label>
          <label class="field-label">Épaisseur plaque (mm)
            <input type="number" id="insp-thickness" value="${p.thickness}" min="1" max="100" step="1" />
          </label>
        </div>

        <div class="cut-highlight-box">
          <div class="cut-title">${p.material === 'plastic' ? 'PIÈCE EN PLASTIQUE FOURNIE (DIMENSIONS FIGÉES)' : stairSpec ? `ESCALIER EN ${stairSpec.numLayers} TRANCHES (POLYSTYRÈNE ${stairSpec.stepH} MM)` : `DÉCOUPE À PLAT (POLYSTYRÈNE ${p.thickness} MM)`}</div>
          <div class="cut-dims">${p.material === 'plastic' ? `Base ${p.dx}×${p.dz} mm • Haut. ${p.dy} mm` : stairSpec ? `${stairSpec.numLayers}× à plat • Larg. ${stairSpec.dz} mm <span class="cm-sub">(prof. ${stairSpec.layers[0].dx} → ${stairSpec.layers[stairSpec.numLayers - 1].dx} mm)</span>` : `${p.cutW} × ${p.cutH} mm <span class="cm-sub">(${(p.cutW / 10).toFixed(1)} × ${(p.cutH / 10).toFixed(1)} cm)</span>`}</div>
        </div>
        ${stairGuideHtml}

        <div class="section-subtitle">Dimensions 3D dans l'espace (mm)</div>
        <div class="field-grid-3">
          <label class="field-label">Long. X (dx)
            <input type="number" id="insp-dx" value="${Math.round(p.dx)}" min="2" step="1" />
          </label>
          <label class="field-label">Haut. Y (dy)
            <input type="number" id="insp-dy" value="${Math.round(p.dy)}" min="2" step="1" />
          </label>
          <label class="field-label">Larg. Z (dz)
            <input type="number" id="insp-dz" value="${Math.round(p.dz)}" min="2" step="1" />
          </label>
        </div>

        <div class="section-subtitle">Position d'assemblage (mm)</div>
        <div class="field-grid-3">
          <label class="field-label">Pos X (Arrière→Av)
            <input type="number" id="insp-x" value="${Math.round(p.x)}" step="1" />
          </label>
          <label class="field-label">Pos Y (Altitude)
            <input type="number" id="insp-y" value="${Math.round(p.y)}" step="1" />
          </label>
          <label class="field-label">Pos Z (Gauche→Dr)
            <input type="number" id="insp-z" value="${Math.round(p.z)}" step="1" />
          </label>
        </div>

        ${p.notes ? `<div class="piece-notes">${p.notes}</div>` : ''}

        <div class="inspector-actions">
          <button id="btn-dup-piece" class="btn-secondary">Dupliquer (Ctrl+D)</button>
          <button id="btn-del-piece" class="btn-danger">Supprimer (Suppr)</button>
        </div>
      </div>
    `;

    const bindInput = (id, prop, isNumeric = true) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        this.commitHistory();
        const nextVal = isNumeric ? Number(el.value) : el.value;
        p[prop] = nextVal;
        if (prop === 'thickness' && p.shape !== 'stairs' && p.shape !== 'roof_slope' && p.shape !== 'cylinder_y') {
          const tProp = getThicknessProp(p);
          p[tProp] = Math.max(2, nextVal);
          recomputeCutDimensions(p);
        } else if (prop === 'thickness' && p.shape === 'stairs') {
          recomputeCutDimensions(p);
        } else if (['dx', 'dy', 'dz'].includes(prop)) {
          recomputeCutDimensions(p);
        }
        this.editor2d.render();
        this.viewer3d.updatePieceGeometry(p);
        this._renderInspector();
        this._renderCutList();
        this._renderChecklist();
        this._updateGlobalStats();
        this._renderMobileSelectionBar();
        this._saveState();
      });
    };

    bindInput('insp-name', 'name', false);
    bindInput('insp-group', 'group', false);
    bindInput('insp-thickness', 'thickness', true);
    bindInput('insp-dx', 'dx', true);
    bindInput('insp-dy', 'dy', true);
    bindInput('insp-dz', 'dz', true);
    bindInput('insp-x', 'x', true);
    bindInput('insp-y', 'y', true);
    bindInput('insp-z', 'z', true);

    document.getElementById('btn-dup-piece')?.addEventListener('click', () => this.duplicateSelectedPiece());
    document.getElementById('btn-del-piece')?.addEventListener('click', () => this.deleteSelectedPiece());
    this._bindQuickCellaCard();
  }

  _bindQuickCellaCard() {
    const btnApply = document.getElementById('btn-apply-cella-l');
    const inpL = document.getElementById('quick-cella-total-l');
    btnApply?.addEventListener('click', () => {
      const val = Number(inpL?.value);
      if (Number.isFinite(val) && val > 60) {
        this.recalculateOpeningsToFitCella(val, false);
      } else {
        this.recalculateOpeningsToFitCella(null, false);
      }
    });
    document.getElementById('btn-merge-bays')?.addEventListener('click', () => {
      this.mergeCellaBays(false);
    });
  }

  duplicateSelectedPiece() {
    const orig = this.pieces.find((p) => p.id === this.selectedId);
    if (!orig) return;
    this.commitHistory();
    const copy = {
      ...orig,
      id: nextPieceId('dup'),
      name: `${orig.name} (Copie)`,
      x: orig.x + 15,
      z: orig.z + 15,
    };
    delete copy.pieceNum; // La copie reçoit le prochain numéro incrémenté (jamais le même)
    this.pieces.push(copy);
    this.selectedId = copy.id;
    this._refreshAll();
  }

  deleteSelectedPiece() {
    if (!this.selectedId) return;
    this.commitHistory();
    this.pieces = this.pieces.filter((p) => p.id !== this.selectedId);
    this.selectedId = null;
    this._refreshAll();
  }

  // ============================================================================
  // LISTE DE DÉCOUPE & CALEPINAGE 2D (SOURCE DE VÉRITÉ UNIQUE PAR ÉPAISSEUR)
  // ============================================================================
  _renderPlateItemSVG(it, color) {
    const isSelPrimary = it.id === this.selectedId;
    const isSelSecond = it.secondId && it.secondId === this.selectedId;
    const isDonePrimary = this.cutDoneIds.has(it.id);
    const isDoneSecond = Boolean(it.secondId && this.cutDoneIds.has(it.secondId));
    const strokeMain = it.oversized ? '#ef4444' : '#0f172a';

    // 1. Paire de 2 triangles isocèles emboîtés tête-bêche (parallélogramme exact avec jeu de coupe)
    if (it.kind === 'triangle_pair') {
      const B = it.triBase;
      const H = it.triHeight;
      const gap = it.triGapX || 0;
      let ptsA, ptsB, lblA, lblB;

      if (!it.rotated) {
        ptsA = `${it.x},${it.y + H} ${it.x + B},${it.y + H} ${it.x + B / 2},${it.y}`;
        ptsB = `${it.x + B / 2 + gap},${it.y} ${it.x + B * 1.5 + gap},${it.y} ${it.x + B + gap},${it.y + H}`;
        lblA = { x: it.x + B / 2, y: it.y + H * 0.68 };
        lblB = { x: it.x + B + gap, y: it.y + H * 0.34 };
      } else {
        ptsA = `${it.x},${it.y} ${it.x},${it.y + B} ${it.x + H},${it.y + B / 2}`;
        ptsB = `${it.x + H},${it.y + B / 2 + gap} ${it.x + H},${it.y + B * 1.5 + gap} ${it.x},${it.y + B + gap}`;
        lblA = { x: it.x + H * 0.36, y: it.y + B / 2 };
        lblB = { x: it.x + H * 0.66, y: it.y + B + gap };
      }

      const fillA = isSelPrimary ? '#38bdf8' : isDonePrimary ? '#10b981' : color;
      const fillB = isSelSecond ? '#38bdf8' : isDoneSecond ? '#10b981' : color;
      const numA = `${isDonePrimary ? '✓' : ''}${it.firstItem?.pieceNum ? `P${it.firstItem.pieceNum}` : '△'}`;
      const numB = `${isDoneSecond ? '✓' : ''}${it.secondItem?.pieceNum ? `P${it.secondItem.pieceNum}` : '△'}`;
      const showNum = B >= 26 && H >= 16;
      const showDim = B >= 54 && H >= 34;

      return `
        <rect x="${it.x}" y="${it.y}" width="${it.placedW}" height="${it.placedH}" fill="none" stroke="#334155" stroke-width="0.7" stroke-dasharray="3,2" />
        <g class="plate-svg-piece" data-piece-id="${it.id}" style="cursor:pointer;">
          <polygon points="${ptsA}" fill="${fillA}" fill-opacity="${isSelPrimary ? 0.88 : isDonePrimary ? 0.28 : 0.48}" stroke="${strokeMain}" stroke-width="1.5" />
          ${showNum ? `<text x="${lblA.x}" y="${showDim ? lblA.y - 4.5 : lblA.y}" fill="${isDonePrimary ? '#6ee7b7' : '#ffffff'}" font-size="9" font-weight="800" text-anchor="middle" dominant-baseline="middle">${numA}</text>` : ''}
          ${showDim ? `<text x="${lblA.x}" y="${lblA.y + 5.5}" fill="#e2e8f0" font-size="7.5" font-weight="600" text-anchor="middle" dominant-baseline="middle">${B}×${H}</text>` : ''}
          <title>${numA} — △ ${it.firstItem?.name || it.name} (Base ${B} × H ${H} mm — emboîté tête-bêche${isDonePrimary ? ' • DÉCOUPÉE' : ''})</title>
        </g>
        <g class="plate-svg-piece" data-piece-id="${it.secondId}" style="cursor:pointer;">
          <polygon points="${ptsB}" fill="${fillB}" fill-opacity="${isSelSecond ? 0.88 : isDoneSecond ? 0.24 : 0.36}" stroke="${strokeMain}" stroke-width="1.5" />
          ${showNum ? `<text x="${lblB.x}" y="${showDim ? lblB.y - 4.5 : lblB.y}" fill="${isDoneSecond ? '#6ee7b7' : '#ffffff'}" font-size="9" font-weight="800" text-anchor="middle" dominant-baseline="middle">${numB}</text>` : ''}
          ${showDim ? `<text x="${lblB.x}" y="${lblB.y + 5.5}" fill="#e2e8f0" font-size="7.5" font-weight="600" text-anchor="middle" dominant-baseline="middle">${B}×${H}</text>` : ''}
          <title>${numB} — △ ${it.secondItem?.name || it.name} (Base ${B} × H ${H} mm — emboîté tête-bêche${isDoneSecond ? ' • DÉCOUPÉE' : ''})</title>
        </g>
      `;
    }

    // 2. Triangle isocèle isolé
    if (it.kind === 'triangle') {
      let pts, lbl;
      if (!it.rotated) {
        pts = `${it.x},${it.y + it.placedH} ${it.x + it.placedW},${it.y + it.placedH} ${it.x + it.placedW / 2},${it.y}`;
        lbl = { x: it.x + it.placedW / 2, y: it.y + it.placedH * 0.66 };
      } else {
        pts = `${it.x},${it.y} ${it.x},${it.y + it.placedH} ${it.x + it.placedW},${it.y + it.placedH / 2}`;
        lbl = { x: it.x + it.placedW * 0.38, y: it.y + it.placedH / 2 };
      }
      const fill = isSelPrimary ? '#38bdf8' : isDonePrimary ? '#10b981' : color;
      const pTag = `${isDonePrimary ? '✓' : ''}${it.pieceNum ? `P${it.pieceNum}` : '△'}`;
      const showNum = it.triBase >= 24 && it.triHeight >= 16;
      const showDim = it.triBase >= 56 && it.triHeight >= 30;

      return `
        <g class="plate-svg-piece" data-piece-id="${it.id}" style="cursor:pointer;">
          <rect x="${it.x}" y="${it.y}" width="${it.placedW}" height="${it.placedH}" fill="none" stroke="#334155" stroke-width="0.7" stroke-dasharray="3,2" />
          <polygon points="${pts}" fill="${fill}" fill-opacity="${isSelPrimary ? 0.88 : isDonePrimary ? 0.28 : 0.48}" stroke="${strokeMain}" stroke-width="1.6" />
          ${showNum ? `<text x="${lbl.x}" y="${showDim ? lbl.y - 5 : lbl.y}" fill="${isDonePrimary ? '#6ee7b7' : '#ffffff'}" font-size="9.5" font-weight="800" text-anchor="middle" dominant-baseline="middle">${pTag}</text>` : ''}
          ${showDim ? `<text x="${lbl.x}" y="${lbl.y + 6}" fill="#e2e8f0" font-size="8" font-weight="600" text-anchor="middle" dominant-baseline="middle">△${it.triBase}×${it.triHeight}</text>` : ''}
          <title>${pTag} — △ ${it.name} (Triangle Base ${it.triBase} × Haut. ${it.triHeight} mm${isDonePrimary ? ' • DÉCOUPÉE' : ''}${it.oversized ? ' — DÉPASSE 300×200 !' : ''})</title>
        </g>
      `;
    }

    // 3. Plaque rectangulaire standard / tranche d'escalier / pan de toit
    const fill = isSelPrimary ? '#38bdf8' : isDonePrimary ? '#10b981' : color;
    const opacity = isSelPrimary ? 0.85 : isDonePrimary ? 0.24 : 0.42;
    const rawTag = it.pieceNum ? (it.sliceLabel ? `P${it.pieceNum} (${it.sliceLabel})` : `P${it.pieceNum}`) : '';
    const pTag = `${isDonePrimary ? '✓' : ''}${rawTag}`;
    const dimLabel = `${it.placedW}×${it.placedH}`;
    const cx = it.x + it.placedW / 2;
    const cy = it.y + it.placedH / 2;
    const canShowTwoLines = Boolean(pTag) && it.placedW >= 36 && it.placedH >= 28;
    const canShowOneLine = it.placedW >= 18 && it.placedH >= 13;

    let textSvg = '';
    if (canShowTwoLines) {
      textSvg = `
        <text x="${cx}" y="${cy - 5.5}" fill="${isDonePrimary ? '#6ee7b7' : '#ffffff'}" font-size="9.5" font-weight="800" text-anchor="middle" dominant-baseline="middle">${pTag}</text>
        <text x="${cx}" y="${cy + 6}" fill="#e2e8f0" font-size="8" font-weight="600" text-anchor="middle" dominant-baseline="middle">${dimLabel}</text>
      `;
    } else if (canShowOneLine) {
      const singleTxt = pTag || dimLabel;
      const fontSize = it.placedW >= 28 ? 8.5 : 7;
      textSvg = `<text x="${cx}" y="${cy}" fill="${isDonePrimary ? '#6ee7b7' : '#ffffff'}" font-size="${fontSize}" font-weight="800" text-anchor="middle" dominant-baseline="middle">${singleTxt}</text>`;
    }

    return `
      <g class="plate-svg-piece" data-piece-id="${it.id}" style="cursor:pointer;">
        <rect x="${it.x}" y="${it.y}" width="${it.placedW}" height="${it.placedH}" fill="${fill}" fill-opacity="${opacity}" stroke="${strokeMain}" stroke-width="1.5" />
        ${textSvg}
        <title>${pTag ? `${pTag} — ` : ''}${it.name} (${it.placedW} × ${it.placedH} mm${isDonePrimary ? ' • DÉCOUPÉE' : ''}${it.oversized ? ' — DÉPASSE 300×200 !' : ''})</title>
      </g>
    `;
  }

  _renderCutList() {
    const container = document.getElementById('cutlist-content');
    if (!container) return;

    // Mémoriser quels panneaux de calepinage étaient ouverts avant de rafraîchir le DOM
    const openDetails = new Set();
    container.querySelectorAll('details[data-plate-t]').forEach((d) => {
      if (d.open) openDetails.add(Number(d.dataset.plateT));
    });
    const isFirstRender = !container.dataset.initialized;
    container.dataset.initialized = '1';

    const packSummary = packPiecesIntoPlates(this.pieces, PLATE_WIDTH, PLATE_HEIGHT, this._getPackOptions());
    const plasticItems = packSummary._plastic || [];
    const byThicknessItems = packSummary._byThickness || { 6: [], 10: [], 20: [] };
    const anyOversized = ALLOWED_THICKNESSES.some((t) => packSummary[t]?.hasOversized);

    let html = this._buildPlateSummaryCardHTML(true);

    if (anyOversized) {
      html += `
        <div class="cut-highlight-box" style="margin-bottom:12px;border-color:rgba(239,68,68,0.65);background:rgba(239,68,68,0.12);text-align:left;">
          <div style="font-size:11.5px;color:#fca5a5;margin-bottom:6px;">
            ⚠️ Une ou plusieurs pièces dépassent le format de plaque <strong>300 × 200 mm</strong>.
          </div>
          <button id="btn-split-oversized" class="btn-compact accent" style="width:100%;">✂️ Redécouper automatiquement les pièces &gt; 300×200</button>
        </div>
      `;
    }

    const renderPills = (refs) => {
      if (!refs || refs.length === 0) return '';
      return `<div class="piece-pills-wrap">${refs.map((r) => {
        const isDone = this.cutDoneIds.has(r.id);
        return `
        <span class="piece-pill ${r.id === this.selectedId ? 'active' : ''} ${isDone ? 'done' : ''}" data-pill-id="${r.id}" title="Localiser ${r.tag}${isDone ? ' (déjà découpée)' : ''}">${isDone ? '✓ ' : ''}${r.tag}</span>
      `;
      }).join('')}</div>`;
    };

    if (plasticItems.length > 0) {
      const plasticGroups = new Map();
      for (const it of plasticItems) {
        const cleanLabel = it.name.replace(/\s*\([^)]*\)|\s*N°\d+|\s*#\d+/g, '').trim();
        const key = `${cleanLabel}__${it.dimsText}`;
        if (!plasticGroups.has(key)) {
          plasticGroups.set(key, { label: cleanLabel, dimsText: it.dimsText, qty: 0, ids: [], refs: [], sampleId: it.id });
        }
        const entry = plasticGroups.get(key);
        entry.qty += 1;
        entry.ids.push(it.id);
        if (it.pieceNum) entry.refs.push({ id: it.id, tag: `P${it.pieceNum}` });
      }
      const pList = Array.from(plasticGroups.values());
      html += `
        <div class="cut-section">
          <div class="cut-section-header">
            <span><i class="dot" style="background:#f8fafc"></i><strong>Pièces Plastique / Colonnes</strong></span>
            <span class="area-tag">Hors découpe</span>
          </div>
          <table class="cut-table">
            <thead>
              <tr>
                <th>Qté</th>
                <th>Élément & N°</th>
                <th>Dimensions (mm)</th>
              </tr>
            </thead>
            <tbody>
              ${pList.map((e) => `
                <tr class="cut-row" data-sample-id="${e.sampleId}" data-ids="${e.ids.join(',')}">
                  <td class="qty-cell">${e.qty}×</td>
                  <td>${e.label}${renderPills(e.refs)}</td>
                  <td class="dim-cell">${e.dimsText}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    const thicknessesDesc = [...ALLOWED_THICKNESSES].sort((a, b) => b - a);

    for (const t of thicknessesDesc) {
      const items = byThicknessItems[t] || [];
      if (items.length === 0) continue;

      const color = THICKNESS_COLORS[t] || '#a78bfa';
      const packInfo = packSummary[t];

      // Regrouper les morceaux identiques pour le tableau récapitulatif (100% cohérent avec le calepinage SVG)
      const groupMap = new Map();
      for (const it of items) {
        const isTri = it.kind === 'triangle';
        const dimLabel = isTri ? `△ ${it.triBase} × ${it.triHeight}` : `${it.w} × ${it.h}`;
        const cleanLabel = it.shape === 'stairs_slice'
          ? it.name
          : it.name.replace(/\s*\([^)]*\)|\s*N°\d+|\s*#\d+/g, '').trim();
        const key = `${cleanLabel}__${it.shape}__${dimLabel}`;
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            label: isTri ? `△ ${cleanLabel}` : cleanLabel,
            dimLabel,
            qty: 0,
            ids: [],
            refs: [],
            sampleId: it.id
          });
        }
        const entry = groupMap.get(key);
        entry.qty += 1;
        entry.ids.push(it.id);
        if (it.pieceNum) {
          const tag = it.sliceLabel ? `P${it.pieceNum} (${it.sliceLabel})` : `P${it.pieceNum}`;
          entry.refs.push({ id: it.id, tag });
        }
      }
      const entries = Array.from(groupMap.values());

      const platesSvgHtml = packInfo.plates.map((bin) => {
        const binPieceCount = bin.placedItems.reduce((acc, it) => acc + (it.pieceCount || 1), 0);
        const shapesSvg = bin.placedItems.map((it) => this._renderPlateItemSVG(it, color)).join('');
        return `
          <div>
            <div style="font-size:10.5px;color:#94a3b8;margin-bottom:4px;display:flex;justify-content:space-between;">
              <span>Plaque ${t} mm — N°${bin.index}/${packInfo.plateCount} (300 × 200 mm)</span>
              <span>${binPieceCount} morceau${binPieceCount > 1 ? 'x' : ''}</span>
            </div>
            <svg viewBox="0 0 ${PLATE_WIDTH} ${PLATE_HEIGHT}" style="width:100%;height:auto;background:#090d16;border:1px solid #334155;border-radius:4px;display:block;">
              ${shapesSvg}
            </svg>
          </div>
        `;
      }).join('');

      const shouldBeOpen = isFirstRender ? t === 20 : openDetails.has(t);

      html += `
        <div class="cut-section">
          <div class="cut-section-header">
            <span><i class="dot" style="background:${color}"></i>Plaques <strong>300×200×${t} mm</strong></span>
            <span class="area-tag">${packInfo.plateCount} plaque${packInfo.plateCount > 1 ? 's' : ''} • ${packInfo.placedPieceCount}/${packInfo.pieceCount} pcs (${packInfo.efficiency}%)</span>
          </div>
          <table class="cut-table">
            <thead>
              <tr>
                <th>Qté</th>
                <th>Pièce & N°</th>
                <th>Découpe (mm)</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map((e) => `
                <tr class="cut-row" data-sample-id="${e.sampleId}" data-ids="${e.ids.join(',')}">
                  <td class="qty-cell">${e.qty}×</td>
                  <td>${e.label}${renderPills(e.refs)}</td>
                  <td class="dim-cell">${e.dimLabel}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <details data-plate-t="${t}" ${shouldBeOpen ? 'open' : ''} style="padding:8px 10px;border-top:1px solid rgba(51,65,85,0.4);background:rgba(15,23,42,0.4);">
            <summary style="font-size:11.5px;color:#38bdf8;cursor:pointer;font-weight:600;">Voir le plan de calepinage des ${packInfo.plateCount} plaque(s) de ${t} mm</summary>
            <div class="plates-grid">
              ${platesSvgHtml}
            </div>
          </details>
        </div>
      `;
    }

    container.innerHTML = html;

    document.getElementById('sel-cut-kerf')?.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      if (Number.isFinite(val) && val >= 0) {
        this.cutKerf = val;
        this._saveState();
        this._renderInspector();
        this._renderCutList();
      }
    });

    document.getElementById('chk-hide-done-plates')?.addEventListener('change', (e) => {
      this.hideDoneFromPlates = e.target.checked;
      this._saveState();
      this._renderInspector();
      this._renderCutList();
    });

    document.getElementById('btn-split-oversized')?.addEventListener('click', () => {
      this.commitHistory();
      this.pieces = enforcePlateConstraintsAndSplit(this.pieces);
      this._refreshAll();
    });

    container.querySelectorAll('.piece-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = pill.dataset.pillId;
        if (id) this.selectPiece(id);
      });
    });

    container.querySelectorAll('.cut-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.sampleId;
        this.selectPiece(id);
      });
    });

    container.querySelectorAll('.plate-svg-piece').forEach((g) => {
      g.addEventListener('click', () => {
        const id = g.dataset.pieceId;
        if (id) this.selectPiece(id);
      });
    });

    this._highlightCutListRow();
  }

  // ============================================================================
  // ONGLET SUIVI DES PIÈCES DÉCOUPÉES (CHECKLIST COCHABLE PERSISTANTE)
  // ============================================================================
  _renderChecklist() {
    const container = document.getElementById('checklist-content');
    if (!container) return;

    // Pièces en polystyrène à découper (hors colonnes plastique fournies)
    const cuttablePieces = this.pieces.filter((p) => !p.hidden && p.material !== 'plastic' && p.shape !== 'cylinder_y');
    const validIds = new Set(cuttablePieces.map((p) => p.id));
    // Nettoyer les éventuels IDs supprimés du Set
    for (const id of Array.from(this.cutDoneIds)) {
      if (!validIds.has(id)) this.cutDoneIds.delete(id);
    }

    const totalCount = cuttablePieces.length;
    const doneCount = cuttablePieces.filter((p) => this.cutDoneIds.has(p.id)).length;
    const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    // Mettre à jour le petit compteur sur l'onglet "✅ Suivi" (desktop + mobile)
    const tabBtn = document.getElementById('tab-btn-checklist');
    if (tabBtn) {
      tabBtn.innerHTML = doneCount > 0 ? `<span>✅</span><span>${doneCount}/${totalCount}</span>` : `<span>✅</span><span>Suivi</span>`;
    }
    const mobileChkLbl = document.getElementById('mobile-nav-checklist-lbl');
    if (mobileChkLbl) {
      mobileChkLbl.textContent = doneCount > 0 ? `${doneCount}/${totalCount}` : 'Suivi';
    }

    // Filtrage & tri
    let list = cuttablePieces.filter((p) => {
      const isDone = this.cutDoneIds.has(p.id);
      if (this.checklistFilter === 'todo' && isDone) return false;
      if (this.checklistFilter === 'done' && !isDone) return false;
      if (this.checklistThickness !== 'all') {
        const snapped = snapToAllowedThickness(p.thickness || 10);
        if (String(snapped) !== this.checklistThickness) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      if (this.checklistSort === 'thickness') {
        const ta = snapToAllowedThickness(a.thickness || 10);
        const tb = snapToAllowedThickness(b.thickness || 10);
        if (tb !== ta) return tb - ta;
      }
      return (a.pieceNum || 0) - (b.pieceNum || 0);
    });

    const itemsHtml = list.length === 0
      ? `<div class="empty-state" style="padding:12px 4px;text-align:center;">Aucune pièce dans ce filtre.</div>`
      : list.map((p) => {
          const isDone = this.cutDoneIds.has(p.id);
          const isSel = p.id === this.selectedId;
          const t = snapToAllowedThickness(p.thickness || 10);
          const col = THICKNESS_COLORS[t] || '#a78bfa';
          const isTri = p.shape === 'prism_z';
          let dimsDesc = `${Math.max(p.cutW, p.cutH)} × ${Math.min(p.cutW, p.cutH)} mm`;
          if (isTri) dimsDesc = `△ ${p.cutW} × ${p.cutH} mm`;
          if (p.shape === 'stairs') {
            const stairSpec = computeStairLayers(p);
            dimsDesc = `${stairSpec.numLayers} tranches × ${stairSpec.stepH} mm (larg. ${stairSpec.dz} mm)`;
          }

          return `
            <div class="checklist-item ${isDone ? 'done' : ''} ${isSel ? 'selected' : ''}" data-check-row-id="${p.id}">
              <input type="checkbox" data-check-id="${p.id}" ${isDone ? 'checked' : ''} title="Marquer P${p.pieceNum} comme découpée" />
              <span class="checklist-num">P${p.pieceNum}</span>
              <div class="checklist-item-body">
                <div class="checklist-item-top">
                  <i class="dot" style="background:${col};flex-shrink:0;" title="Épaisseur ${t} mm"></i>
                  <span class="checklist-item-name" title="${p.name}">${p.name}</span>
                </div>
                <div class="checklist-item-meta">
                  <span>Ép. ${t} mm</span>
                  <span>•</span>
                  <span>${dimsDesc}</span>
                </div>
              </div>
            </div>
          `;
        }).join('');

    container.innerHTML = `
      <div class="checklist-progress-card">
        <div class="checklist-progress-head">
          <span><strong>${doneCount} / ${totalCount}</strong> pièces découpées</span>
          <strong style="color:${pct === 100 ? '#34d399' : '#38bdf8'};">${pct}%</strong>
        </div>
        <div class="checklist-bar-track">
          <div class="checklist-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>

      <div class="checklist-controls">
        <div class="segmented">
          <button data-chk-filter="all" class="${this.checklistFilter === 'all' ? 'active' : ''}">Toutes</button>
          <button data-chk-filter="todo" class="${this.checklistFilter === 'todo' ? 'active' : ''}">À faire (${totalCount - doneCount})</button>
          <button data-chk-filter="done" class="${this.checklistFilter === 'done' ? 'active' : ''}">Faites (${doneCount})</button>
        </div>

        <select id="sel-chk-thickness" class="select-compact" title="Filtrer par épaisseur de plaque">
          <option value="all" ${this.checklistThickness === 'all' ? 'selected' : ''}>Toutes ép.</option>
          <option value="20" ${this.checklistThickness === '20' ? 'selected' : ''}>20 mm</option>
          <option value="10" ${this.checklistThickness === '10' ? 'selected' : ''}>10 mm</option>
          <option value="6" ${this.checklistThickness === '6' ? 'selected' : ''}>6 mm</option>
        </select>

        <select id="sel-chk-sort" class="select-compact" title="Ordre d'affichage">
          <option value="num" ${this.checklistSort === 'num' ? 'selected' : ''}>Tri : N° P1→P${totalCount}</option>
          <option value="thickness" ${this.checklistSort === 'thickness' ? 'selected' : ''}>Tri : Épaisseur</option>
        </select>

        ${doneCount > 0 ? `<button id="btn-chk-reset" class="btn-compact" title="Tout décocher">↺ Raz</button>` : ''}
      </div>

      <div class="checklist-list">
        ${itemsHtml}
      </div>
    `;

    // Événements de filtres / tri / réinitialisation
    container.querySelectorAll('[data-chk-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.checklistFilter = btn.dataset.chkFilter;
        this._renderChecklist();
      });
    });

    document.getElementById('sel-chk-thickness')?.addEventListener('change', (e) => {
      this.checklistThickness = e.target.value;
      this._renderChecklist();
    });

    document.getElementById('sel-chk-sort')?.addEventListener('change', (e) => {
      this.checklistSort = e.target.value;
      this._renderChecklist();
    });

    document.getElementById('btn-chk-reset')?.addEventListener('click', () => {
      if (confirm('Décocher toutes les pièces déjà marquées comme découpées ?')) {
        this.cutDoneIds.clear();
        this._saveState();
        this._renderChecklist();
        this._renderCutList();
        this._renderMobileSelectionBar();
      }
    });

    // Cases à cocher individuelles
    container.querySelectorAll('input[data-check-id]').forEach((chk) => {
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => {
        const id = chk.dataset.checkId;
        if (chk.checked) this.cutDoneIds.add(id);
        else this.cutDoneIds.delete(id);
        this._saveState();
        this._renderChecklist();
        this._renderCutList();
        this._renderMobileSelectionBar();
      });
    });

    // Clic sur une ligne -> localiser la pièce en 2D/3D
    container.querySelectorAll('.checklist-item').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.checkRowId;
        if (id) this.selectPiece(id);
      });
    });
  }

  _highlightCutListRow() {
    document.querySelectorAll('.cut-row').forEach((row) => {
      const ids = (row.dataset.ids || '').split(',');
      row.classList.toggle('selected', Boolean(this.selectedId && ids.includes(this.selectedId)));
    });
    document.querySelectorAll('.piece-pill').forEach((pill) => {
      pill.classList.toggle('active', Boolean(this.selectedId && pill.dataset.pillId === this.selectedId));
    });
    document.querySelectorAll('.checklist-item').forEach((item) => {
      item.classList.toggle('selected', Boolean(this.selectedId && item.dataset.checkRowId === this.selectedId));
    });
    document.querySelectorAll('.plate-svg-piece').forEach((g) => {
      const isSel = Boolean(this.selectedId && g.dataset.pieceId === this.selectedId);
      const shape = g.querySelector('polygon, rect');
      if (shape) {
        shape.setAttribute('stroke', isSel ? '#38bdf8' : '#0f172a');
        shape.setAttribute('stroke-width', isSel ? '2.6' : '1.5');
      }
    });
  }

  _updateGlobalStats() {
    const el = document.getElementById('global-dimensions-badge');
    if (!el || this.pieces.length === 0) return;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of this.pieces) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x + p.dx);
      maxY = Math.max(maxY, p.y + p.dy);
      maxZ = Math.max(maxZ, p.z + p.dz);
    }
    const L = Math.round(maxX - minX);
    const H = Math.round(maxY - minY);
    const W = Math.round(maxZ - minZ);
    const plugsCount = this.pieces.filter((p) => p.adventNum).length;

    el.innerHTML = `
      <span><strong>${this.pieces.length}</strong> pièces</span>
      <span class="sep">•</span>
      <span><strong>${plugsCount}</strong> cases</span>
      <span class="sep">•</span>
      <span>Gabarit hors-tout : <strong>${(L / 10).toFixed(1)} × ${(W / 10).toFixed(1)} × H ${(H / 10).toFixed(1)} cm</strong> (${L}×${W}×${H} mm)</span>
    `;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new TemplePlannerApp();
});
