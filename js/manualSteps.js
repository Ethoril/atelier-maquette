// Générateur dynamique des étapes du Manuel de Montage façon LEGO
// Résout automatiquement les vrais numéros P#, dimensions (mm) et sous-ensembles
// depuis le plan local sauvegardé (localStorage), un JSON importé ou le plan par défaut.

import {
  DEFAULT_TEMPLE_PARAMS,
  generateRomanTemple,
  ensurePieceNumbers,
  computeStairLayers,
  formatPieceNum
} from './templeGenerator.js';
import {
  enforcePlateConstraintsAndSplit,
  snapToAllowedThickness
} from './platePacker.js';

export const STORAGE_KEY = 'temple_advent_v2_170mm_30x30';
export const MANUAL_PROGRESS_KEY = 'temple_lego_manual_progress_v1';

export const PHASES = [
  { id: 'prep',   bag: '0', label: 'Préparation & Matériel',        color: '#64748b', bg: '#f1f5f9' },
  { id: 'podium', bag: '1', label: 'Podium, Fresques & Case #25',   color: '#d97706', bg: '#fef3c7' },
  { id: 'cella',  bag: '2', label: 'Cella, Casier 24 Cases & Porche', color: '#0284c7', bg: '#e0f2fe' },
  { id: 'paint',  bag: '3', label: 'Sous-couche, Peinture & Porte Bronze', color: '#7c3aed', bg: '#ede9fe' },
  { id: 'fresco', bag: '4', label: 'Fresques & Mosaïques (24 Cases)', color: '#059669', bg: '#d1fae5' },
  { id: 'doors',  bag: '5', label: 'Portes, Charnières & Numéros',  color: '#ea580c', bg: '#ffedd5' },
  { id: 'roof',   bag: '6', label: 'Architrave, Frontons & Toit Tuiles', color: '#dc2626', bg: '#fee2e2' },
];

/**
 * Charge le plan actif : JSON fourni > localStorage de l'atelier > plan par défaut.
 */
export function loadPlanData(overrideJson = null) {
  let source = 'default';
  let params = { ...DEFAULT_TEMPLE_PARAMS };
  let pieces = [];
  let cutDoneIds = new Set();

  const tryParse = (parsed, srcName) => {
    if (parsed && Array.isArray(parsed.pieces) && parsed.pieces.length > 0) {
      params = { ...DEFAULT_TEMPLE_PARAMS, ...(parsed.params || {}) };
      pieces = parsed.pieces.map((p) => ({ ...p }));
      ensurePieceNumbers(pieces, parsed.nextPieceNum || 1);
      if (Array.isArray(parsed.cutDoneIds)) {
        cutDoneIds = new Set(parsed.cutDoneIds);
      }
      source = srcName;
      return true;
    }
    return false;
  };

  if (overrideJson) {
    tryParse(overrideJson, 'json');
  } else {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        tryParse(JSON.parse(saved), 'localStorage');
      }
    } catch (e) {
      console.warn('Lecture localStorage impossible :', e);
    }
  }

  if (pieces.length === 0) {
    pieces = generateRomanTemple(params);
    ensurePieceNumbers(pieces, 1);
    pieces = enforcePlateConstraintsAndSplit(pieces);
    ensurePieceNumbers(pieces, 1);
    source = 'default';
  }

  // Filtrer les pièces masquées
  pieces = pieces.filter((p) => !p.hidden);

  return { source, params, pieces, cutDoneIds };
}

/**
 * Calcule les métriques géométriques réelles du plan chargé (mm).
 */
export function computePlanGeometry(pieces, params) {
  const byMatch = (fn) => pieces.filter(fn).sort((a, b) => (a.x - b.x) || (a.y - b.y) || (a.z - b.z) || ((a.pieceNum || 0) - (b.pieceNum || 0)));

  const semelle = byMatch((p) => p.name.includes('Semelle basse'));
  const stylobate = byMatch((p) => p.name.includes('Plancher haut Podium'));
  const flancG = byMatch((p) => p.name.includes('Flanc Gauche du Podium'));
  const flancD = byMatch((p) => p.name.includes('Flanc Droit du Podium'));
  const murArrPodium = byMatch((p) => p.name.includes('Mur Arrière du Podium'));
  const fondCase25 = byMatch((p) => p.name.includes('Cloison Fond Case #25'));
  const muretG = byMatch((p) => p.name.includes('Muret d’Échiffre Gauche') || p.name.includes("Muret d'Échiffre Gauche"));
  const muretD = byMatch((p) => p.name.includes('Muret d’Échiffre Droit') || p.name.includes("Muret d'Échiffre Droit"));
  const stairs = byMatch((p) => p.shape === 'stairs' || p.adventNum === 25);

  const murArrCella = byMatch((p) => p.name.includes('Mur Arrière de la Cella'));
  const murAvCella = byMatch((p) => p.name.includes('Mur Avant de la Cella'));
  const spineCella = byMatch((p) => p.name.includes('Cloison Centrale Cella'));
  const shelves = byMatch((p) => p.name.includes('Étagère Horizontale')).sort((a, b) => a.y - b.y || a.z - b.z);
  const dividers = byMatch((p) => p.name.includes('Cloison Verticale Case')).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);

  const plugsLeft = byMatch((p) => p.adventNum >= 1 && p.adventNum <= 24 && (p.plugSide === 'left' || p.adventNum <= 12))
    .sort((a, b) => a.adventNum - b.adventNum);
  const plugsRight = byMatch((p) => p.adventNum >= 1 && p.adventNum <= 24 && (p.plugSide === 'right' || p.adventNum >= 13))
    .sort((a, b) => a.adventNum - b.adventNum);
  const allPlugs24 = [...plugsLeft, ...plugsRight].sort((a, b) => a.adventNum - b.adventNum);

  const colsFront = byMatch((p) => (p.material === 'plastic' || p.shape === 'cylinder_y') && p.name.includes('Frontale'))
    .sort((a, b) => a.z - b.z);
  const colsLat = byMatch((p) => (p.material === 'plastic' || p.shape === 'cylinder_y') && !p.name.includes('Frontale'))
    .sort((a, b) => a.z - b.z);
  const allColumns = [...colsFront, ...colsLat];

  const plafond = byMatch((p) => p.name.includes('Plafond & Architrave') || p.name.includes('Architrave Supérieure'));
  const fronton = byMatch((p) => p.name.includes('Fronton Triangulaire Avant'));
  const pignon = byMatch((p) => p.name.includes('Pignon Triangulaire Arrière'));
  const roofLeft = byMatch((p) => p.name.includes('Versant de Toit Gauche'));
  const roofRight = byMatch((p) => p.name.includes('Versant de Toit Droit'));

  const standardIds = new Set([
    ...semelle, ...stylobate, ...flancG, ...flancD, ...murArrPodium, ...fondCase25,
    ...muretG, ...muretD, ...stairs, ...murArrCella, ...murAvCella, ...spineCella,
    ...shelves, ...dividers, ...allPlugs24, ...allColumns, ...plafond, ...fronton,
    ...pignon, ...roofLeft, ...roofRight
  ].map((p) => p.id));

  const customPieces = pieces.filter((p) => !standardIds.has(p.id));

  // Bornes globales
  const boundsOf = (list, fallback = { minX: 0, maxX: 383, minY: 0, maxY: 70, minZ: 0, maxZ: 210 }) => {
    if (!list || list.length === 0) return fallback;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of list) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.dx);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y + p.dy);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z + p.dz);
    }
    return {
      minX: Math.round(minX), maxX: Math.round(maxX),
      minY: Math.round(minY), maxY: Math.round(maxY),
      minZ: Math.round(minZ), maxZ: Math.round(maxZ),
      dx: Math.round(maxX - minX),
      dy: Math.round(maxY - minY),
      dz: Math.round(maxZ - minZ),
    };
  };

  const bAll = boundsOf(pieces);
  const bPodium = boundsOf([...semelle, ...stylobate]);
  const bFlancG = boundsOf(flancG, { minX: 0, maxX: 383, minY: 10, maxY: 60, minZ: 0, maxZ: 10, dx: 383, dy: 50, dz: 10 });
  const bFlancD = boundsOf(flancD, { minX: 0, maxX: 383, minY: 10, maxY: 60, minZ: 200, maxZ: 210, dx: 383, dy: 50, dz: 10 });
  const bCella = boundsOf([...murArrCella, ...murAvCella], { minX: 15, maxX: 293, minY: 70, maxY: 240, minZ: 15, maxZ: 195, dx: 278, dy: 170, dz: 180 });
  const bPlafond = boundsOf(plafond, { minX: 15, maxX: 383, minY: 240, maxY: 250, minZ: 0, maxZ: 210, dx: 368, dy: 10, dz: 210 });
  const bRoof = boundsOf([...plafond, ...fronton, ...pignon, ...roofLeft, ...roofRight]);

  const stairPiece = stairs[0] || null;
  const stairSpec = stairPiece ? computeStairLayers(stairPiece) : null;

  const fond25X = fondCase25[0] ? Math.round(fondCase25[0].x + fondCase25[0].dx) : Math.max(10, bPodium.maxX - 140);
  const case25ClearDepth = Math.max(40, (stairPiece ? Math.round(stairPiece.x) : bPodium.maxX - 10) - fond25X);
  const case25OpeningW = stairPiece ? Math.round(stairPiece.dz) : Math.max(100, bPodium.dz - 40);
  const podiumInnerH = Math.max(20, bFlancG.dy || params.podiumH || 50);

  // Dimensions du tiroir Case #25 (avec 2 mm de jeu de chaque côté et 2-3 mm en hauteur/profondeur)
  const drawerW = Math.max(60, case25OpeningW - 4);
  const drawerH = Math.max(20, podiumInnerH - 3);
  const drawerD = Math.max(40, case25ClearDepth - 2);

  // Cotes de toiture & tuiles 250x125 mm
  const roofL = bPlafond.dx || 368;
  const roofSlopeLen = roofLeft[0] ? Math.round(Math.hypot(roofLeft[0].dz, roofLeft[0].dy)) : 119;
  const tileRemainder = Math.max(10, roofL - 250);
  const tileSheetsNeeded = roofL <= 375 ? 3 : 4;

  // Hauteurs d'étages de cases & largeurs
  const caseW = allPlugs24[0] ? Math.round(allPlugs24[0].dx) : (params.caseL || 60);
  const rowHeights = Array.from(new Set(allPlugs24.map((p) => Math.round(p.dy)))).sort((a, b) => b - a);
  const cellaW = bCella.dz || 180;
  const mergedBays = spineCella.length === 0;
  const caseDepthHalf = mergedBays ? Math.round(cellaW / 2) : Math.round((cellaW - (spineCella[0]?.dz || 10)) / 2);

  // Dividers groupés par étage Y (1, 2, 3)
  const uniqueDivYs = [];
  for (const d of dividers) {
    if (!uniqueDivYs.some((y) => Math.abs(y - d.y) <= 3)) uniqueDivYs.push(d.y);
  }
  uniqueDivYs.sort((a, b) => a - b);
  const dividersByRow = uniqueDivYs.map((y) => dividers.filter((d) => Math.abs(d.y - y) <= 3));

  return {
    groups: {
      semelle, stylobate, flancG, flancD, murArrPodium, fondCase25,
      muretG, muretD, stairs, murArrCella, murAvCella, spineCella,
      shelves, dividers, dividersByRow, plugsLeft, plugsRight, allPlugs24,
      colsFront, colsLat, allColumns, plafond, fronton, pignon,
      roofLeft, roofRight, customPieces
    },
    bounds: { bAll, bPodium, bFlancG, bFlancD, bCella, bPlafond, bRoof },
    metrics: {
      podiumL: bPodium.dx,
      podiumW: bPodium.dz,
      podiumH: bPodium.dy,
      podiumInnerH,
      flancL: bFlancG.dx,
      flancH: bFlancG.dy,
      cellaL: bCella.dx,
      cellaH: bCella.dy,
      cellaW,
      mergedBays,
      caseW,
      rowHeights,
      caseDepthHalf,
      stairPiece,
      stairSpec,
      case25OpeningW,
      case25ClearDepth,
      drawerW,
      drawerH,
      drawerD,
      roofL,
      roofSlopeLen,
      tileRemainder,
      tileSheetsNeeded,
      pedimentW: fronton[0] ? Math.round(fronton[0].cutW || fronton[0].dz) : bPlafond.dz,
      pedimentH: fronton[0] ? Math.round(fronton[0].cutH || fronton[0].dy) : (params.pedimentH || 55),
    }
  };
}

/**
 * Formate une liste de pièces physiques en entrées d'encart « Pièces LEGO ».
 */
function makePartEntries(pieceList, customLabel = null) {
  if (!pieceList || pieceList.length === 0) return [];
  const map = new Map();
  for (const p of pieceList) {
    const isPlastic = p.material === 'plastic' || p.shape === 'cylinder_y';
    const t = isPlastic ? 30 : snapToAllowedThickness(p.thickness || 10);
    const dimText = isPlastic
      ? `Base ${Math.round(p.dx)}×${Math.round(p.dz)} • H ${Math.round(p.dy)} mm`
      : p.shape === 'prism_z'
        ? `△ ${Math.round(p.cutW)} × ${Math.round(p.cutH)} mm`
        : p.shape === 'stairs'
          ? `${computeStairLayers(p).numLayers} tranches × ${computeStairLayers(p).stepH} mm (L ${Math.round(p.dz)})`
          : `${Math.round(Math.max(p.cutW, p.cutH))} × ${Math.round(Math.min(p.cutW, p.cutH))} mm`;

    const baseName = customLabel || p.name.replace(/\s*\(Partie\s+\d+\/\d+\)/gi, '').replace(/\s*N°\d+|\s*#\d+/g, '').trim();
    const key = `${baseName}__${t}__${dimText}__${p.shape}`;
    if (!map.has(key)) {
      map.set(key, {
        kind: isPlastic ? 'plastic' : 'xps',
        label: baseName,
        qty: 0,
        nums: [],
        pieceIds: [],
        thickness: t,
        dimText,
        shape: p.shape || 'box',
      });
    }
    const entry = map.get(key);
    entry.qty += 1;
    if (p.pieceNum) entry.nums.push(`P${p.pieceNum}`);
    entry.pieceIds.push(p.id);
  }
  return Array.from(map.values());
}

function numsLabel(list) {
  const tags = (list || []).map((p) => formatPieceNum(p)).filter(Boolean);
  return tags.length > 0 ? tags.join(' + ') : 'pièces correspondantes';
}

function makeSupply(icon, label, detail, badge = 'Matériel', color = '#475569') {
  return { kind: 'supply', icon, label, dimText: detail, badge, color, qty: 1, nums: [] };
}

/**
 * Construit la séquence complète du Manuel de Montage façon LEGO.
 */
export function buildAssemblyManual(planData) {
  const { pieces, params, source, cutDoneIds } = planData;
  const geom = computePlanGeometry(pieces, params);
  const { groups: g, bounds: b, metrics: m } = geom;

  const ids = (list) => (list || []).map((p) => p.id);
  const built = new Set();
  const addBuilt = (list) => { for (const p of (list || [])) built.add(p.id); };

  const steps = [];
  const pushStep = (cfg) => {
    steps.push({
      stepNum: steps.length + 1,
      ...cfg,
    });
  };

  // =========================================================================
  // PHASE 0 — PRÉPARATION & CONTRÔLE DU CHANTIER
  // =========================================================================
  pushStep({
    phaseId: 'prep',
    badge: 'Préparation',
    title: 'Contrôle des pièces, outils & règle d’or du XPS',
    subtitle: `Vue d’ensemble du Temple de Morgane (${pieces.length} pièces • ${(b.bAll.dx / 10).toFixed(1)} × ${(b.bAll.dz / 10).toFixed(1)} × H ${(b.bAll.dy / 10).toFixed(1)} cm)`,
    duration: '15 min',
    dryTime: null,
    tags: [
      { icon: '📋', label: 'Tri par P#', kind: 'info' },
      { icon: '🧴', label: 'Colle PVA / Polymère sans solvant', kind: 'glue' },
      { icon: '⚠️', label: 'Coller AVANT peinture', kind: 'warning' },
    ],
    parts: [
      makeSupply('🧴', 'Colle à bois prise rapide (PVA)', 'Collage structurel mousse-sur-mousse (+ 2 pts colle chaude basse T°)', 'Colle', '#0284c7'),
      makeSupply('🏺', 'Enduit de rebouchage allégé Axton', 'Fresques à figurines (flancs podium) + rebouchage des joints XPS', 'Enduit', '#d97706'),
      makeSupply('🛡️', 'Mod Podge mat', 'Sous-couche blindée 50/50 acrylique + collage des fresques papier', 'Finition', '#7c3aed'),
      makeSupply('🔩', 'Quincaillerie portes (24 cases)', '48× mini-charnières 8×10 mm + 24× boutons bronze + clous fins 15–20 mm', 'Métal', '#ea580c'),
      makeSupply('🏛️', 'Décors & Toiture', 'Planches A4 1:1 (24 cases + Frontispice) + 3–4× plaques tuiles 250×125 mm', 'Décor', '#059669'),
    ],
    instructions: [
      'Rassemble tes pièces découpées par épaisseur (**20 mm**, **10 mm**, **6 mm**) et vérifie que chaque pièce porte son numéro **P#** au crayon sur une face cachée.',
      'Prépare un plan de travail protégé par une feuille de **papier sulfurisé** (la colle PVA et l’enduit n’y adhèrent pas) et une équerre pour contrôler les angles à 90°.',
      '**Règle d’or du XPS :** on colle toujours **mousse nue contre mousse nue AVANT de peindre** (la peinture sur XPS s’arracherait sous le poids). Si une zone doit être peinte avant collage final, protège la tranche avec du **scotch de masquage**.',
      '**Astuce adhérence :** griffe très légèrement les surfaces XPS à encoller avec un bout de papier de verre ou la pointe d’un cutter pour que la colle morde deux fois mieux.',
    ],
    tips: {
      kind: 'tip',
      title: 'Astuce Maître Constructeur — Mod Podge vs Colle à bois',
      text: 'Garde le **Mod Podge mat** exclusivement pour la sous-couche blindée (50 % Mod Podge + 50 % acrylique) et le collage du papier. Pour coller les plaques XPS entre elles, utilise de la **colle à bois prise rapide** (éventuellement aidée de 2 minuscules points de colle chaude basse T° au centre pour bloquer en 10 s).'
    },
    specs: [
      { k: 'Hors-tout', v: `${b.bAll.dx} × ${b.bAll.dz} × H ${b.bAll.dy} mm` },
      { k: 'Échelle', v: '≈ 1:50 (figurines 28–32 mm)' },
      { k: 'Cases', v: '24 cases latérales + Case #25 tiroir' },
      { k: 'Colonnes', v: `${g.allColumns.length}× plastique 30×30×170 mm` },
    ],
    scene: {
      visibleIds: ids(pieces),
      activeIds: [],
      isolateSubassembly: false,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'iso-front-right', zoomPad: 1.18 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true, paintedRoof: true,
        showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true, showInteriorFrescoes: true,
        showHardware: 'all', showDoorNumbers: true, showArchitraveText: true, showTiles: true, showFrontons: true,
        openStairs: 38, openDemoDoors: [14, 19],
      }
    }
  });

  // =========================================================================
  // PHASE 1 — LE PODIUM, LES FRESQUES À FIGURINES & LA CASE #25
  // =========================================================================

  // ÉTAPE 2 : Semelle basse + Stylobate (collage à plat bout à bout)
  addBuilt([...g.semelle, ...g.stylobate]);
  {
    const explodeMap = {};
    const arrows = [];
    if (g.semelle.length >= 2) {
      const p1 = g.semelle[0], p2 = g.semelle[1];
      explodeMap[p2.id] = { dx: 38, dy: 0, dz: 0 };
      arrows.push({
        from: [p2.x + 34, p2.y + p2.dy / 2, p2.z + p2.dz / 2],
        to: [p1.x + p1.dx + 4, p1.y + p1.dy / 2, p1.z + p1.dz / 2]
      });
    }
    if (g.stylobate.length >= 2) {
      const p1 = g.stylobate[0], p2 = g.stylobate[1];
      explodeMap[p1.id] = { dx: 0, dy: 30, dz: 0 };
      explodeMap[p2.id] = { dx: 38, dy: 30, dz: 0 };
      arrows.push({
        from: [p2.x + 34, p2.y + 30 + p2.dy / 2, p2.z + p2.dz / 2],
        to: [p1.x + p1.dx + 4, p1.y + 30 + p1.dy / 2, p1.z + p1.dz / 2]
      });
    }

    pushStep({
      phaseId: 'podium',
      badge: 'Sous-assemblage',
      title: 'Assembler les 2 grands plateaux du Podium (à plat)',
      subtitle: `Semelle basse (${numsLabel(g.semelle)}) et Stylobate (${numsLabel(g.stylobate)})`,
      duration: '15 min',
      dryTime: '1–2 h sous poids',
      tags: [
        { icon: '🔄', label: 'Collage à plat', kind: 'subbuild' },
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
        { icon: '⏱️', label: 'Séchage 1–2 h sous livres', kind: 'dry' },
      ],
      parts: [
        ...makePartEntries(g.semelle, 'Semelle basse du Podium (1/2 + 2/2)'),
        ...makePartEntries(g.stylobate, 'Plancher haut Podium / Stylobate (1/2 + 2/2)'),
      ],
      instructions: [
        `Sur du papier sulfurisé bien plat, colle bout à bout les 2 morceaux de la **Semelle basse** (**${numsLabel(g.semelle)}**) pour obtenir un plateau rigide de **${m.podiumL} × ${m.podiumW} mm**.`,
        `Fais exactement pareil avec les 2 morceaux du **Plancher haut / Stylobate** (**${numsLabel(g.stylobate)}**).`,
        'Aligne les grands côtés contre une règle métallique pour qu’ils soient parfaitement droits, essuie l’excédent de colle, puis pose **2 gros livres lourds** à plat le temps de la prise.',
        '*(Option solidité)* : tu peux glisser 2 cure-dents coupés en guise de mini-tourillons dans la tranche de 10 mm au niveau du raccord central.',
      ],
      tips: {
        kind: 'tip',
        title: 'Repérage propre',
        text: `Inscris **« BAS (Semelle) »** et **« HAUT (Stylobate) »** au crayon au centre des deux plateaux : ils ont exactement les mêmes dimensions (${m.podiumL} × ${m.podiumW} mm).`
      },
      specs: [
        { k: 'Dimensions finales', v: `${m.podiumL} × ${m.podiumW} × 10 mm (×2)` },
        { k: 'Alignement', v: 'Joint central bord à bord sur règle' },
      ],
      scene: {
        visibleIds: ids([...g.semelle, ...g.stylobate]),
        activeIds: ids([...g.semelle, ...g.stylobate]),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: {}
      }
    });
  }

  // ÉTAPE 3 : Sous-ensemble Flancs Gauche & Droit du Podium (supports des fresques à figurines)
  {
    const explodeMap = {};
    const arrows = [];
    if (g.flancG.length >= 2) {
      explodeMap[g.flancG[1].id] = { dx: 36, dy: 0, dz: 0 };
      arrows.push({
        from: [g.flancG[1].x + 32, g.flancG[1].y + g.flancG[1].dy / 2, g.flancG[1].z + 5],
        to: [g.flancG[0].x + g.flancG[0].dx + 4, g.flancG[0].y + g.flancG[0].dy / 2, g.flancG[0].z + 5],
      });
    }
    if (g.flancD.length >= 2) {
      explodeMap[g.flancD[1].id] = { dx: 36, dy: 0, dz: 0 };
      arrows.push({
        from: [g.flancD[1].x + 32, g.flancD[1].y + g.flancD[1].dy / 2, g.flancD[1].z + 5],
        to: [g.flancD[0].x + g.flancD[0].dx + 4, g.flancD[0].y + g.flancD[0].dy / 2, g.flancD[0].z + 5],
      });
    }

    pushStep({
      phaseId: 'podium',
      badge: 'Sous-assemblage',
      title: 'Assembler les 2 Flancs du Podium (supports des fresques)',
      subtitle: `Flanc Gauche (${numsLabel(g.flancG)}) & Flanc Droit (${numsLabel(g.flancD)}) — préparés à plat`,
      duration: '15 min',
      dryTime: '1 h à plat',
      tags: [
        { icon: '🔄', label: 'Sous-assemblage ×2', kind: 'subbuild' },
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
        { icon: '⚠️', label: 'Masquer tranches haut/bas', kind: 'warning' },
      ],
      parts: [
        ...makePartEntries(g.flancG, 'Flanc Gauche du Podium (1/2 + 2/2)'),
        ...makePartEntries(g.flancD, 'Flanc Droit du Podium (1/2 + 2/2)'),
        makeSupply('🟨', 'Scotch de masquage', 'Protège les tranches de 10 mm (haut, bas, arrière) avant l’enduit', 'Masquage', '#ca8a04'),
      ],
      instructions: [
        `Colle bout à bout les 2 parties du **Flanc Gauche** (**${numsLabel(g.flancG)}**) pour former un bandeau continu de **${m.flancL} × ${m.flancH} mm**.`,
        `Fais la même chose de l’autre côté avec le **Flanc Droit** (**${numsLabel(g.flancD)}**).`,
        'Renforce discrètement le **dos (face intérieure)** du joint central avec une fine bande de scotch de masquage ou papier collé pour éviter toute flexion pendant la sculpture.',
        '**Protection cruciale :** pose une bande de **scotch de masquage** sur les **tranches haute et basse de 10 mm** de chaque flanc — elles resteront propres et 100 % planes pour le collage entre la Semelle et le Stylobate.',
      ],
      tips: {
        kind: 'warning',
        title: 'Pourquoi préparer les 2 flancs AVANT de monter le caisson ?',
        text: 'Sculpter tes figurines dans l’enduit allégé **à plat sur la table** est infiniment plus simple et évite que les figurines ne glissent sous l’effet de la gravité (et tu ne risques pas d’écraser la 1re fresque en retournant le podium pour faire la 2e !).'
      },
      specs: [
        { k: 'Flanc Gauche', v: `${numsLabel(g.flancG)} → ${m.flancL} × ${m.flancH} × 10 mm` },
        { k: 'Flanc Droit', v: `${numsLabel(g.flancD)} → ${m.flancL} × ${m.flancH} × 10 mm` },
      ],
      scene: {
        visibleIds: ids([...g.flancG, ...g.flancD]),
        activeIds: ids([...g.flancG, ...g.flancD]),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: { showMaskingZones: 'flanks' }
      }
    });
  }

  // ÉTAPE 4 : Sculpture des 2 Fresques à Figurines sur les Flancs (Axton Allégé)
  pushStep({
    phaseId: 'podium',
    badge: 'Bas-relief',
    title: 'Sculpter les 2 Fresques à Figurines (Enduit allégé Axton)',
    subtitle: `Sur ${numsLabel(g.flancG)} (Gauche) et ${numsLabel(g.flancD)} (Droit) — posés à plat`,
    duration: '45–60 min',
    dryTime: '12 à 24 h (séchage complet !)',
    tags: [
      { icon: '🏺', label: 'Enduit allégé Axton', kind: 'filler' },
      { icon: '🗿', label: 'Incrustation figurines', kind: 'subbuild' },
      { icon: '⏱️', label: 'Séchage 12–24 h', kind: 'dry' },
    ],
    parts: [
      ...makePartEntries(g.flancG, 'Flanc Gauche assemblé (fresque 1)'),
      ...makePartEntries(g.flancD, 'Flanc Droit assemblé (fresque 2)'),
      makeSupply('🏺', 'Enduit de rebouchage allégé Axton', 'Lit de 5–8 mm (accepte jusqu’à 15 mm sans fissurer ni rétrécir)', 'Enduit', '#d97706'),
      makeSupply('🗿', 'Figurines romaines / bas-relief', 'Testées à blanc, dégraissées (+ 1 goutte de colle sous les plus lourdes)', 'Relief', '#9333ea'),
    ],
    instructions: [
      `Pose les deux bandeaux (**${numsLabel(g.flancG)}** et **${numsLabel(g.flancD)}**) **face extérieure vers le haut** sur ta table, et dispose tes figurines **à blanc** pour composer ta scène de procession romaine (en gardant **2–3 mm de marge libre** en haut, en bas et aux bouts).`,
      'Étends une couche régulière d’**enduit de rebouchage allégé Axton** (5 à 8 mm d’épaisseur) à la spatule — le joint central entre Partie 1/2 et Partie 2/2 disparaît totalement dessous !',
      'Enfonce chaque figurine délicatement dans l’enduit frais (ajoute **1 petit point de colle PVA ou gel** au dos des figurines un peu lourdes pour un ancrage définitif) et ramène un peu d’enduit autour des contours au pinceau humide / cure-dent pour les fondre dans la pierre.',
      'Lisse proprement le fond ou donne une légère texture minérale talochée, biseaute les bords haut/bas à 2 mm des tranches masquées, puis laisse sécher **12 à 24 h complètes à plat** sans y toucher.',
    ],
    tips: {
      kind: 'warning',
      title: 'Attention : fragile tant que non blindé !',
      text: 'Une fois sec, l’enduit allégé Axton reste légèrement tendre sous l’ongle. Il deviendra **dur comme de la coquille** à l’Étape 12 grâce à la sous-couche **50 % Mod Podge + 50 % acrylique**. Manipule les deux flancs par les tranches d’ici là !'
    },
    specs: [
      { k: 'Zone sculptable', v: `~${m.flancL - 10} × ${m.flancH - 6} mm par côté` },
      { k: 'Épaisseur enduit', v: '5 à 8 mm (max 15 mm sans fissure)' },
      { k: 'Séchage', v: '12–24 h à plat avant montage du caisson' },
    ],
    scene: {
      visibleIds: ids([...g.flancG, ...g.flancD]),
      activeIds: ids([...g.flancG, ...g.flancD]),
      isolateSubassembly: true,
      explodeMap: {},
      arrows: [
        { from: [b.bFlancD.minX + b.bFlancD.dx * 0.5, b.bFlancD.minY + b.bFlancD.dy / 2, b.bFlancD.maxZ + 42], to: [b.bFlancD.minX + b.bFlancD.dx * 0.5, b.bFlancD.minY + b.bFlancD.dy / 2, b.bFlancD.maxZ + 8] },
        { from: [b.bFlancG.minX + b.bFlancG.dx * 0.5, b.bFlancG.minY + b.bFlancG.dy / 2, b.bFlancG.minZ - 42], to: [b.bFlancG.minX + b.bFlancG.dx * 0.5, b.bFlancG.minY + b.bFlancG.dy / 2, b.bFlancG.minZ - 8] },
      ],
      camera: { preset: 'iso-front-right', zoomPad: 1.2 },
      visualState: { showFriezes: 'sculpting', showMaskingZones: 'flanks' }
    }
  });

  // ÉTAPE 5 : Montage du caisson du Podium (Case #25)
  addBuilt([...g.flancG, ...g.flancD, ...g.murArrPodium, ...g.fondCase25]);
  {
    const newWalls = [...g.murArrPodium, ...g.fondCase25, ...g.flancG, ...g.flancD];
    const explodeMap = {};
    for (const p of g.flancG) explodeMap[p.id] = { dx: 0, dy: 0, dz: -35 };
    for (const p of g.flancD) explodeMap[p.id] = { dx: 0, dy: 0, dz: 35 };
    for (const p of g.murArrPodium) explodeMap[p.id] = { dx: -30, dy: 20, dz: 0 };
    for (const p of g.fondCase25) explodeMap[p.id] = { dx: 0, dy: 32, dz: 0 };
    for (const p of g.stylobate) explodeMap[p.id] = { dx: 0, dy: 62, dz: 0 };

    const arrows = [
      { from: [b.bPodium.dx / 2, b.bPodium.maxY + 55, b.bPodium.dz / 2], to: [b.bPodium.dx / 2, b.bPodium.maxY + 12, b.bPodium.dz / 2] },
      { from: [b.bFlancD.dx / 2, 35, b.bFlancD.maxZ + 38], to: [b.bFlancD.dx / 2, 35, b.bFlancD.maxZ + 6] },
      { from: [b.bFlancG.dx / 2, 35, b.bFlancG.minZ - 38], to: [b.bFlancG.dx / 2, 35, b.bFlancG.minZ - 6] },
    ];

    pushStep({
      phaseId: 'podium',
      badge: 'Collage',
      title: 'Monter le caisson du Podium & fermer le Stylobate',
      subtitle: 'Assemblage de la cavité de la Case #25 avec les 2 flancs sculptés',
      duration: '25 min',
      dryTime: '2 h',
      tags: [
        { icon: '🧴', label: 'Colle PVA prise rapide', kind: 'glue' },
        { icon: '📐', label: 'Équerrage 90°', kind: 'info' },
        { icon: '⚠️', label: 'Retirer scotchs des tranches', kind: 'warning' },
      ],
      parts: [
        ...makePartEntries(g.murArrPodium, 'Mur Arrière du Podium'),
        ...makePartEntries(g.fondCase25, 'Cloison Fond Case #25 (Renfort)'),
        ...makePartEntries(g.flancG, 'Flanc Gauche sculpté'),
        ...makePartEntries(g.flancD, 'Flanc Droit sculpté'),
        ...makePartEntries(g.stylobate, 'Stylobate (Plancher haut)'),
      ],
      instructions: [
        '**Retire le scotch de masquage** sur les tranches haute, basse et arrière des deux flancs sculptés (leur XPS nu est impeccablement propre !).',
        `Pose la **Semelle basse** (${numsLabel(g.semelle)}) à plat. Colle le **Mur Arrière du Podium** (**${numsLabel(g.murArrPodium)}**) à \`x = 0\` (en retrait de 10 mm de chaque bord gauche/droit) puis la **Cloison Fond Case #25** (**${numsLabel(g.fondCase25)}**) à **${m.case25ClearDepth + 10} mm** du bord avant.`,
        `Colle ensuite les deux **Flancs sculptés** (**${numsLabel(g.flancG)}** à gauche, **${numsLabel(g.flancD)}** à droite) le long des grands bords de la Semelle et contre les tranches du Mur Arrière et du Fond #25.`,
        `Encolle tout le dessus des 4 parois et pose le **Stylobate** (**${numsLabel(g.stylobate)}**) bien aligné bord à bord. Laisse prendre sous un poids réparti **sans appuyer sur les figurines**.`,
      ],
      tips: {
        kind: 'tip',
        title: 'Vérification Case #25',
        text: `Avant que la colle ne fige, vérifie l’ouverture avant de la cavité Case #25 : **${m.podiumInnerH} mm** de haut libre et **${m.case25ClearDepth + 10} mm** de profondeur jusqu’à la cloison de fond.`
      },
      specs: [
        { k: 'Hauteur totale Podium', v: `${m.podiumH} mm (10 + ${m.podiumInnerH} + 10)` },
        { k: 'Profondeur brute #25', v: `${m.case25ClearDepth + 10} mm` },
      ],
      scene: {
        visibleIds: ids([...g.semelle, ...g.stylobate, ...newWalls]),
        activeIds: ids([...newWalls, ...g.stylobate]),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: { showFriezes: 'sculpting' }
      }
    });
  }

  // ÉTAPE 6 : Murets d'Échiffre (20 mm) & Rebouchage des joints du Podium
  addBuilt([...g.muretG, ...g.muretD]);
  {
    const murets = [...g.muretG, ...g.muretD];
    const explodeMap = {};
    for (const p of murets) explodeMap[p.id] = { dx: 36, dy: 0, dz: 0 };
    const arrows = murets.map((p) => ({
      from: [p.x + p.dx + 32, p.y + p.dy / 2, p.z + p.dz / 2],
      to: [p.x + p.dx + 4, p.y + p.dy / 2, p.z + p.dz / 2],
    }));

    pushStep({
      phaseId: 'podium',
      badge: 'Collage + Enduit',
      title: 'Poser les 2 Murets d’Échiffre (20 mm) & lisser les joints',
      subtitle: `Encadrement de l’escalier #25 (${numsLabel(murets)}) + finition Axton`,
      duration: '20 min',
      dryTime: '2–3 h',
      tags: [
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
        { icon: '🏺', label: 'Rebouchage joints Axton', kind: 'filler' },
        { icon: '📏', label: `Passage libre ${m.case25OpeningW} mm`, kind: 'info' },
      ],
      parts: [
        ...makePartEntries(g.muretG, 'Muret d’Échiffre Gauche (20 mm)'),
        ...makePartEntries(g.muretD, 'Muret d’Échiffre Droit (20 mm)'),
        makeSupply('🏺', 'Enduit allégé Axton', 'Fine passe au doigt humide sur les joints Semelle / Flanc / Stylobate', 'Joints', '#d97706'),
      ],
      instructions: [
        `Colle le **Muret d’Échiffre Gauche** (**${numsLabel(g.muretG)}**) et le **Muret d’Échiffre Droit** (**${numsLabel(g.muretD)}**) bien plaqués contre la façade avant du Podium, alignés à fleur sur les côtés extérieurs et sur le dessus du Stylobate (**${m.podiumH} mm**).`,
        `Contrôle immédiatement au réglet que l’écartement libre entre les deux murets fait exactement **${m.case25OpeningW} mm** (sur toute la hauteur !) pour que l’escalier-tiroir coulisse sans coincer.`,
        'Rebouche proprement les micro-joints de jonction visibles (raccords Semelle/Flancs/Stylobate, raccord arrière et murets) avec une noisette d’**enduit allégé Axton** lissé au doigt légèrement humide.',
      ],
      tips: {
        kind: 'tip',
        title: 'Effet blocs de pierre taillée',
        text: 'Avant la sous-couche, tu peux graver au dos d’un cutter / stylo bille quelques **joints de pierre rectangulaires** sur les murets d’échiffre, le mur arrière du podium et la tranche avant du Stylobate.'
      },
      specs: [
        { k: 'Épaisseur murets', v: '20 mm (×2)' },
        { k: 'Largeur passage escalier', v: `${m.case25OpeningW} mm exact` },
      ],
      scene: {
        visibleIds: Array.from(built),
        activeIds: ids(murets),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.2 },
        visualState: { showFriezes: 'sculpting' }
      }
    });
  }

  // ÉTAPE 7 : Sous-ensemble Case #25 — Escalier (6 tranches 10 mm) + Boîte-tiroir
  addBuilt(g.stairs);
  {
    const st = m.stairPiece;
    const spec = m.stairSpec;
    const explodeMap = {};
    if (st) explodeMap[st.id] = { dx: 0, dy: 0, dz: 0 };
    const layerLines = spec
      ? spec.layers.map((l) => `Tranche **${l.label}** : \`${l.dz} × ${l.dx} mm\` (${l.index === 0 ? 'bas au sol, butée semelle' : `alignée dos +${l.plugDepth} mm`})`)
      : [];

    pushStep({
      phaseId: 'podium',
      badge: 'Sous-assemblage',
      title: 'Construire l’Escalier #25 (6 tranches 10 mm) + Boîte-tiroir',
      subtitle: `Sous-assemblage amovible (${numsLabel(g.stairs)}) qui révèle le cadeau du 25 décembre`,
      duration: '30 min',
      dryTime: '1–2 h',
      tags: [
        { icon: '🔄', label: 'Sous-assemblage amovible', kind: 'subbuild' },
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
        { icon: '🎁', label: 'Tiroir Case #25', kind: 'info' },
      ],
      parts: [
        ...makePartEntries(g.stairs, `Escalier #25 (${spec ? spec.numLayers : 6} tranches empilées 10 mm)`),
        makeSupply('📦', 'Boîte-tiroir amovible (à découper)', `Ext. ${m.drawerW} × ${m.drawerD} × H ${m.drawerH} mm (chutes XPS 6 mm ou carton gris 2–3 mm)`, 'Tiroir', '#0284c7'),
      ],
      instructions: [
        `**Bloc supérieur (5 tranches) :** empile et colle à plat les tranches **2/6 à 6/6** (du plus profond \`${spec?.layers[1]?.dx || 56} mm\` en bas au plus étroit \`${spec?.layers[spec.layers.length - 1]?.dx || 19} mm\` en haut), **toutes alignées bord à bord à l’arrière**.`,
        `**Tranche de base (1/6) :** pose ce bloc sur la tranche **1/6** (\`${spec?.layers[0]?.dz || 170} × ${spec?.layers[0]?.dx || 55} mm\`) en laissant les 5 tranches du haut **dépasser de ${spec?.plugDepth || 10} mm vers l’arrière** — c’est le tenon qui s’emboîte sous le Stylobate !`,
        `**Boîte-tiroir Case #25 :** fabrique une boîte ouverte sur le dessus de **${m.drawerW} mm de large** (2 mm de jeu de chaque côté dans les ${m.case25OpeningW} mm), **${m.drawerD} mm de profondeur** et **${m.drawerH} mm de haut** (3 mm sous le Stylobate).`,
        'Colle la boîte-tiroir bien centrée au dos des tranches **2/6 à 6/6**, puis fais un **test de coulissement à blanc** dans le Podium (l’escalier doit glisser sans forcer et la 7e montée de 10 mm arrive pile au niveau du Stylobate !).',
      ],
      tips: {
        kind: 'tip',
        title: 'Détail des 6 tranches + prise discrète',
        text: `${layerLines.join(' • ')}. Astuce : tu peux coller une minuscule languette de ruban (ou un mini anneau bronze discret sur la 1re contremarche) pour tirer le tiroir facilement le 25 décembre !`
      },
      specs: [
        { k: 'Hauteur escalier', v: `${spec ? spec.stackedHeight : 60} mm (+ 10 mm Stylobate = ${m.podiumH} mm)` },
        { k: 'Boîte-tiroir ext.', v: `${m.drawerW} × ${m.drawerD} × H ${m.drawerH} mm` },
        { k: 'Jeu de coulissement', v: '2 mm gauche/droite • 3 mm haut' },
      ],
      scene: {
        visibleIds: Array.from(built),
        activeIds: ids(g.stairs),
        isolateSubassembly: true,
        explodeMap,
        arrows: st ? [
          { from: [st.x + st.dx + 42, st.y + 30, st.z + st.dz / 2], to: [st.x + st.dx + 6, st.y + 30, st.z + st.dz / 2] },
        ] : [],
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: { showFriezes: 'sculpting', showDrawerBox: true, openStairs: 58 }
      }
    });
  }

  // =========================================================================
  // PHASE 2 — LA CELLA, LE CASIER 24 CASES & LES COLONNES
  // =========================================================================

  // ÉTAPE 8 : Ajustage à blanc des 24 portes (#1-#24)
  pushStep({
    phaseId: 'cella',
    badge: 'Préparation',
    title: 'Ajuster à blanc les 24 portes (#1 à #24) & les numéroter',
    subtitle: 'Ponçage du jeu de peinture (~0,5–1 mm) avant le collage du casier',
    duration: '20 min',
    dryTime: null,
    tags: [
      { icon: '📏', label: 'Jeu peinture 0,5–1 mm', kind: 'info' },
      { icon: '✏️', label: 'Repérage #1 à #24 au dos', kind: 'info' },
    ],
    parts: [
      ...makePartEntries(g.allPlugs24, 'Bouchons / Portes Cases #1 à #24 (10 mm)'),
    ],
    instructions: [
      `Regroupe tes **${g.allPlugs24.length} bouchons de 10 mm** (**${numsLabel(g.allPlugs24.slice(0, 3))} … ${formatPieceNum(g.allPlugs24[g.allPlugs24.length - 1])}**). Attention : l’étage du haut peut avoir **1 mm de différence** en hauteur (\`${m.rowHeights.join(' / ')} mm\`), ne les mélange pas !`,
      'Inscris au crayon au **dos** de chaque porte son numéro de case (**#1 à #12** pour le flanc gauche, **#13 à #24** pour le flanc droit, avec une flèche vers le haut).',
      'Passe un coup de **papier de verre fin (grain 240)** sur les 4 tranches de chaque porte pour retirer **~0,5 mm sur le pourtour** : la sous-couche Mod Podge + peinture ajoutera ~0,3–0,5 mm, ce jeu garantit qu’aucune porte ne frottera jamais.',
      'Mets les 24 portes de côté dans une petite boîte : elles seront peintes à part en Phase 3 et montées sur charnières en Phase 5.',
    ],
    tips: {
      kind: 'tip',
      title: 'Attention aux 2 hauteurs d’étages',
      text: `Sur la hauteur totale de **${m.cellaH} mm** (imposée par tes colonnes de 170 mm) moins 2 étagères de 6 mm (= 158 mm), les étages mesurent **${m.rowHeights.join(' / ')} mm**. Vérifie bien l’appairage par rangée !`
    },
    specs: [
      { k: 'Portes Gauche (#1–#12)', v: `${g.plugsLeft.length} pièces (ép. 10 mm)` },
      { k: 'Portes Droite (#13–#24)', v: `${g.plugsRight.length} pièces (ép. 10 mm)` },
      { k: 'Dimensions nominales', v: `${m.caseW} × ${m.rowHeights.join('/')} mm` },
    ],
    scene: {
      visibleIds: ids(g.allPlugs24),
      activeIds: ids(g.allPlugs24),
      isolateSubassembly: true,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'iso-front-right', zoomPad: 1.25 },
      visualState: { showDoorNumbers: true }
    }
  });

  // ÉTAPE 9 : Assemblage du Casier 24 Cases (Murs Cella + 2 Étagères + 9 Cloisons)
  const cellaStructure = [...g.murArrCella, ...g.murAvCella, ...g.spineCella, ...g.shelves, ...g.dividers];
  addBuilt(cellaStructure);
  {
    const explodeMap = {};
    for (const p of g.murArrCella) explodeMap[p.id] = { dx: -32, dy: 0, dz: 0 };
    for (const p of g.murAvCella) explodeMap[p.id] = { dx: 32, dy: 0, dz: 0 };
    g.shelves.forEach((p, idx) => {
      explodeMap[p.id] = { dx: 0, dy: (idx + 1) * 18, dz: 0 };
    });
    g.dividersByRow.forEach((rowList, rIdx) => {
      for (const p of rowList) {
        explodeMap[p.id] = { dx: 0, dy: rIdx * 22 + 8, dz: 0 };
      }
    });

    const arrows = [
      { from: [b.bCella.minX - 38, b.bCella.minY + 85, b.bCella.minZ + 90], to: [b.bCella.minX - 4, b.bCella.minY + 85, b.bCella.minZ + 90] },
      { from: [b.bCella.maxX + 38, b.bCella.minY + 85, b.bCella.minZ + 90], to: [b.bCella.maxX + 4, b.bCella.minY + 85, b.bCella.minZ + 90] },
      { from: [b.bCella.minX + b.bCella.dx / 2, b.bCella.maxY + 55, b.bCella.minZ + 90], to: [b.bCella.minX + b.bCella.dx / 2, b.bCella.maxY + 12, b.bCella.minZ + 90] },
    ];

    pushStep({
      phaseId: 'cella',
      badge: 'Collage',
      title: 'Assembler le Casier des 24 Cases (Trames fusionnées 180 mm)',
      subtitle: `Étagères traversantes (${numsLabel(g.shelves)}) + 9 cloisons 6 mm + 2 murs Cella 10 mm`,
      duration: '40 min',
      dryTime: '2–3 h',
      tags: [
        { icon: '🧴', label: 'Colle PVA prise rapide', kind: 'glue' },
        { icon: '📏', label: `Hauteur exacte ${m.cellaH} mm`, kind: 'info' },
        { icon: '📐', label: 'Cale gabarit = 1 porte', kind: 'subbuild' },
      ],
      parts: [
        ...makePartEntries(g.murArrCella, 'Mur Arrière de la Cella (10 mm)'),
        ...makePartEntries(g.murAvCella, 'Mur Avant de la Cella (10 mm)'),
        ...makePartEntries(g.shelves, 'Étagères Horizontales traversantes (6 mm)'),
        ...makePartEntries(g.dividers, 'Cloisons Verticales inter-cases (6 mm)'),
        ...(g.spineCella.length > 0 ? makePartEntries(g.spineCella, 'Cloison Centrale Cella (10 mm)') : []),
      ],
      instructions: [
        `Sur les faces intérieures des **Murs Arrière (${numsLabel(g.murArrCella)})** et **Avant (${numsLabel(g.murAvCella)})**, trace au crayon deux traits horizontaux précis pour situer les **2 Étagères de 6 mm** (en partant du bas : 1er étage \`${m.rowHeights[0] || 53} mm\` → Étagère N°1 → 2e étage \`${m.rowHeights[0] || 53} mm\` → Étagère N°2 → 3e étage \`${m.rowHeights[m.rowHeights.length - 1] || 52} mm\`).`,
        `**Astuce infaillible (gabarit) :** utilise une **porte non poncée (ou une cale de ${m.caseW} mm)** comme entretoise temporaire entre chaque cloison verticale !`,
        `Colle d’abord les **3 cloisons verticales de l’étage 2** sous l’**Étagère N°1** (${formatPieceNum(g.shelves[0])}) et l’**Étagère N°2** (${formatPieceNum(g.shelves[1])}), puis les 3 cloisons du haut et les 3 du bas, bien alignées bord à bord sur les **${m.cellaW} mm** de profondeur.`,
        `Referme les deux extrémités en collant le **Mur Arrière** et le **Mur Avant de la Cella**. Vérifie avec une colonne plastique à côté que l’ensemble tombe **pile à ${m.cellaH} mm** de haut (0 mm de marche !).`,
      ],
      tips: {
        kind: 'warning',
        title: 'Équerrage & alignement des tranches',
        text: 'Pose le casier sur le dos (sur une surface bien plane) pendant le collage pour que les deux flancs ouverts soient **parfaitement coplanaires** : tes 24 portes et leurs 48 mini-charnières reposeront exactement à plat !'
      },
      specs: [
        { k: 'Cella hors-tout', v: `${m.cellaL} × ${m.cellaW} × H ${m.cellaH} mm` },
        { k: 'Ouvertures utiles', v: `4 cols × 3 étages = 12 par côté (${m.caseW} mm)` },
        { k: 'Mode casier', v: m.mergedBays ? `Traversant ${m.cellaW} mm (sans cloison centrale)` : '2 trames séparées' },
      ],
      scene: {
        visibleIds: ids(cellaStructure),
        activeIds: ids(cellaStructure),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: {}
      }
    });
  }

  // ÉTAPE 10 : Collage de la Cella sur le Stylobate + Masquage des 6 colonnes
  {
    const explodeMap = {};
    for (const p of cellaStructure) explodeMap[p.id] = { dx: 0, dy: 45, dz: 0 };
    const arrows = [
      { from: [b.bCella.minX + 60, b.bCella.minY + 42, b.bCella.minZ + 90], to: [b.bCella.minX + 60, b.bCella.minY + 4, b.bCella.minZ + 90] },
      { from: [b.bCella.maxX - 60, b.bCella.minY + 42, b.bCella.minZ + 90], to: [b.bCella.maxX - 60, b.bCella.minY + 4, b.bCella.minZ + 90] },
    ];

    pushStep({
      phaseId: 'cella',
      badge: 'Collage',
      title: 'Coller la Cella sur le Stylobate & masquer les bases de colonnes',
      subtitle: 'Positionnement centré (15 mm de débord arrière/côtés • 90 mm pour le porche avant)',
      duration: '20 min',
      dryTime: '2 h',
      tags: [
        { icon: '🧴', label: 'Colle PVA mousse/mousse', kind: 'glue' },
        { icon: '🟨', label: 'Masquage 6 bases 30×30', kind: 'warning' },
      ],
      parts: [
        makeSupply('🧱', 'Bloc Cella assemblé (Étape 9)', `${m.cellaL} × ${m.cellaW} × H ${m.cellaH} mm`, 'Bloc', '#0284c7'),
        makeSupply('🏛️', 'Bloc Podium assemblé (Étape 6)', `${m.podiumL} × ${m.podiumW} × H ${m.podiumH} mm`, 'Bloc', '#d97706'),
        makeSupply('🟨', 'Scotch de masquage', '6 carrés de 26×26 mm sur les emplacements des colonnes + haut de Cella', 'Masquage', '#ca8a04'),
      ],
      instructions: [
        `Sur le dessus du **Stylobate**, trace au crayon l’empreinte de la Cella : **15 mm de marge** à l’arrière, **15 mm à gauche** et **15 mm à droite** (il reste exactement **${m.podiumL - b.bCella.maxX} mm** devant pour le porche / Pronaos).`,
        'Encolle généreusement la base des Murs Avant/Arrière et des 3 cloisons basses de la Cella (colle à bois prise rapide) et pose-la bien calée sur tes repères.',
        '**Avant de passer à la peinture :** trace au crayon les **6 carrés de `30 × 30 mm`** des colonnes sur le Pronaos (4 en façade avant à 15 mm du bord, 2 latérales centrées entre la façade et la Cella) et colle un carré de **scotch de masquage de ~26 × 26 mm** au centre de chacun (et une bande sur la tranche haute des 2 murs de la Cella) pour garder un collage brut ultra-solide !',
      ],
      tips: {
        kind: 'tip',
        title: 'Pourquoi masquer 26 × 26 mm pour une base de 30 × 30 mm ?',
        text: 'En laissant 2 mm de bord peint tout autour du scotch, aucun trait de mousse grise ne dépassera autour du socle des colonnes, tout en conservant un noyau brut collé à la perfection !'
      },
      specs: [
        { k: 'Débord Podium (G / D / Arr)', v: '15 mm exacts' },
        { k: 'Profondeur Pronaos', v: `${m.podiumL - b.bCella.maxX} mm` },
      ],
      scene: {
        visibleIds: Array.from(built),
        activeIds: ids(cellaStructure),
        isolateSubassembly: false,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.2 },
        visualState: { showFriezes: 'sculpting', showMaskingZones: 'columns' }
      }
    });
  }

  // ÉTAPE 11 : Préparation des 6 Colonnes Plastique (30×30×170 mm)
  pushStep({
    phaseId: 'cella',
    badge: 'Préparation',
    title: 'Préparer les 6 Colonnes Plastique (sans les coller encore !)',
    subtitle: `${numsLabel(g.allColumns)} — dégraissage, ponçage léger & test à blanc`,
    duration: '15 min',
    dryTime: null,
    tags: [
      { icon: '🧼', label: 'Dégraissage savon', kind: 'info' },
      { icon: '📄', label: 'Ponçage fin 400–600', kind: 'info' },
      { icon: '⚠️', label: 'Ne pas coller avant la porte bronze', kind: 'warning' },
    ],
    parts: [
      ...makePartEntries(g.colsFront, 'Colonnes Plastique Frontales (30×30×170)'),
      ...makePartEntries(g.colsLat, 'Colonnes Plastique Latérales (30×30×170)'),
    ],
    instructions: [
      'Lave les **6 colonnes plastique** à l’eau tiède + liquide vaisselle (retire les résidus de démoulage qui font glisser la peinture), puis rince et sèche parfaitement.',
      'Passe un léger coup de **papier de verre fin (grain 400–600)** ou d’éponge abrasive sur les fûts, socles et chapiteaux pour créer une micro-accroche mécanique.',
      'Pose-les **à blanc (sans colle)** sur les 6 repères du Pronaos et vérifie avec une règle posée en travers que les chapiteaux affleurent **pile à la même hauteur (`170 mm`)** que les murs de la Cella.',
      '**Retire les colonnes** pour la phase peinture : on les peindra séparément et on ne les collera qu’à l’Étape 14, juste **après** avoir posé la Porte en Bronze sur le Mur Avant de la Cella !',
    ],
    tips: {
      kind: 'warning',
      title: 'Ne colle surtout pas les colonnes maintenant !',
      text: 'Une fois les 6 colonnes collées devant la Cella, il deviendra très difficile de peindre proprement le mur avant et surtout de centrer la **Porte monumentale en bronze** en relief derrière elles.'
    },
    specs: [
      { k: 'Hauteur figée', v: '170 mm (alignée sur la Cella)' },
      { k: 'Passage entre latérales', v: `${Math.max(80, m.cellaW - 60)} mm (porte 114 mm passe avec 3 mm/côté)` },
    ],
    scene: {
      visibleIds: [...built, ...ids(g.allColumns)],
      activeIds: ids(g.allColumns),
      isolateSubassembly: false,
      explodeMap: Object.fromEntries(g.allColumns.map((c) => [c.id, { dx: 0, dy: 28, dz: 0 }])),
      arrows: g.colsFront.slice(0, 2).map((c) => ({
        from: [c.x + 15, c.y + c.dy + 34, c.z + 15],
        to: [c.x + 15, c.y + c.dy + 6, c.z + 15],
      })),
      camera: { preset: 'iso-front-right', zoomPad: 1.2 },
      visualState: { showFriezes: 'sculpting', showMaskingZones: 'columns' }
    }
  });

  // =========================================================================
  // PHASE 3 — SOUS-COUCHE BLINDÉE, PEINTURE PIERRE & FAÇADE BRONZE
  // =========================================================================

  // ÉTAPE 12 : Sous-couche blindée Mod Podge + Acrylique
  pushStep({
    phaseId: 'paint',
    badge: 'Sous-couche',
    title: 'Sous-couche blindée (50 % Mod Podge mat + 50 % Acrylique)',
    subtitle: 'Durcit le XPS + les 2 fresques Axton et donne l’accroche parfaite',
    duration: '40 min',
    dryTime: '4–6 h (idéalement 1 nuit)',
    tags: [
      { icon: '🛡️', label: 'Mod Podge 50/50', kind: 'primer' },
      { icon: '🖌️', label: 'Pinceau brosse', kind: 'paint' },
      { icon: '⏱️', label: 'Séchage 4–6 h', kind: 'dry' },
    ],
    parts: [
      makeSupply('🛡️', 'Mélange 50 % Mod Podge mat + 50 % Acrylique', 'Gris pierre / gris-brun foncé (méthode Black Magic Craft)', 'Sous-couche', '#7c3aed'),
      makeSupply('🏛️', 'À sous-coucher en un lot', 'Podium + 2 fresques figurines + Cella + 24 portes + Escalier #25 + 6 colonnes', 'Lot complet', '#475569'),
    ],
    instructions: [
      'Prépare dans un pot un mélange homogène **50 % Mod Podge mat + 50 % peinture acrylique gris pierre foncé** (ou gris-brun).',
      '**Podium & Fresques à figurines :** passe une couche bien couvrante (sans noyer les petits détails des figurines !) sur tout le Podium et les deux bas-reliefs Axton secs — en séchant, la résine PVA du Mod Podge va **blinder l’enduit allégé** !',
      '**Cella & Casier :** peins le mur arrière, le mur avant (façade Pronaos), toutes les **tranches extérieures de 6 mm** et les **15 premiers millimètres à l’intérieur de chaque case** (inutile de peindre le fond profond qui sera recouvert par les fresques papier).',
      '**Pièces à part :** sous-couche également les **24 portes** (faces + 4 tranches), **l’escalier #25** (hors glissières trop épaisses de la boîte-tiroir) et les **6 colonnes plastique** (2 couches fines bien tirées). Laisse sécher **1 nuit complète** !',
    ],
    tips: {
      kind: 'warning',
      title: 'Ne bouche pas les détails des figurines ni le jeu des portes',
      text: 'Avec un vieux pinceau sec, chasse tout excès de mélange dans les creux des figurines avant qu’il ne sèche. Pour l’escalier #25, veille à ne pas surcharger les deux côtés qui coulissent contre les murets.'
    },
    specs: [
      { k: 'Dosage', v: '1 vol. Mod Podge mat + 1 vol. acrylique' },
      { k: 'Zones protégées', v: 'Garder les 6 scotchs colonnes en place' },
    ],
    scene: {
      visibleIds: [...built, ...ids(g.allColumns), ...ids(g.allPlugs24)],
      activeIds: ids([...g.flancG, ...g.flancD, ...g.murAvCella]),
      isolateSubassembly: false,
      explodeMap: Object.fromEntries(g.allPlugs24.map((p) => [p.id, { dx: 0, dy: 0, dz: p.plugSide === 'left' ? -36 : 36 }])),
      arrows: [],
      camera: { preset: 'iso-front-right', zoomPad: 1.2 },
      visualState: {
        primedOnly: true,
        showFriezes: 'primed',
        showDrawerBox: true,
        showMaskingZones: 'columns',
        openStairs: 30,
      }
    }
  });

  // ÉTAPE 13 : Peinture Pierre / Travertin Antique Patiné
  pushStep({
    phaseId: 'paint',
    badge: 'Peinture',
    title: 'Peinture « Pierre & Travertin Romains » (Base + Lavis + Brossage)',
    subtitle: 'Unifie le Podium, les fresques à figurines, la Cella, les 24 portes et les 6 colonnes',
    duration: '1 h 30',
    dryTime: '2–3 h (+ vernis mat)',
    tags: [
      { icon: '🖌️', label: 'Éponge + Lavis + Drybrush', kind: 'paint' },
      { icon: '🗿', label: 'Mise en relief figurines', kind: 'subbuild' },
      { icon: '✨', label: 'Vernis mat final', kind: 'primer' },
    ],
    parts: [
      makeSupply('🎨', 'Base Travertin (acrylique)', 'Beige calcaire chaud (sable + pointe d’ocre + gris chaud), tamponnée à l’éponge', 'Étape A', '#ca8a04'),
      makeSupply('💧', 'Lavis d’ombrage (Wash)', 'Terre d’ombre brûlée + pointe de noir très diluée à l’eau + 1 mini goutte de savon', 'Étape B', '#78350f'),
      makeSupply('🖌️', 'Brossage à sec (Drybrush)', 'Ivoire / blanc cassé très essuyé sur les arêtes & reliefs des figurines', 'Étape C', '#d6d3d1'),
    ],
    instructions: [
      '**A — Couche de base minérale :** applique ton beige travertin chaud sur le Podium, les **2 fresques à figurines**, la Cella, l’Escalier #25, les **24 portes** et les **6 colonnes**. Tapote légèrement à l’éponge naturelle pour casser l’effet plat et imiter le grain du calcaire romain.',
      '**B — Lavis antique (*Wash*) :** passe un jus sombre très fluide (*terre d’ombre brûlée + pointe de noir*) dans tous les creux : joints de pierre, marches, cannelures des colonnes, et surtout **autour de chaque figurine sur les 2 flancs du podium** pour faire jaillir la profondeur du bas-relief !',
      '**C — Brossage à sec (*Drybrush*) :** essuie un pinceau plat chargé d’ivoire / sable très clair sur de l’essuie-tout jusqu’à ce qu’il soit presque sec, puis effleure les arêtes, les chapiteaux et **les volumes saillants des figurines** : effet marbre sculpté immédiat !',
      '**D — Protection :** passe un voile de **vernis mat acrylique** (au pinceau ou en bombe acrylique sans solvant — *jamais de bombe solvantée sur XPS nu*) avant de manipuler les papiers.',
    ],
    tips: {
      kind: 'tip',
      title: 'Harmonie avec tes frontons patinés',
      text: 'Garde une nuance **pierre calcaire chaude un peu vécue** (légèrement patinée ocre/gris dans les coins) : elle se fondra parfaitement avec les bas-reliefs patinés du Fronton Saturnales et de la Porte en bronze.'
    },
    specs: [
      { k: 'Palette pierre', v: 'Gris foncé → Travertin → Lavis ombre → Ivoire' },
      { k: 'Portes #1–#24', v: 'Peindre façade + 4 tranches (dos optionnel)' },
    ],
    scene: {
      visibleIds: [...built, ...ids(g.allColumns)],
      activeIds: [],
      isolateSubassembly: false,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'iso-front-right', zoomPad: 1.2 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedColumns: true,
        showFriezes: 'painted', showDrawerBox: true, showMaskingZones: 'columns',
      }
    }
  });

  // ÉTAPE 14 : Porte Monumentale en Bronze (Embrasure 3D) + Collage des 6 Colonnes
  addBuilt(g.allColumns);
  {
    const explodeMap = Object.fromEntries(g.allColumns.map((c) => [c.id, { dx: 0, dy: 34, dz: 0 }]));
    const arrows = [
      { from: [b.bCella.maxX + 35, b.bCella.minY + 85, b.bCella.minZ + 90], to: [b.bCella.maxX + 6, b.bCella.minY + 85, b.bCella.minZ + 90] },
      ...g.colsFront.slice(0, 2).map((c) => ({
        from: [c.x + 15, c.y + c.dy + 40, c.z + 15],
        to: [c.x + 15, c.y + c.dy + 8, c.z + 15],
      })),
    ];

    pushStep({
      phaseId: 'paint',
      badge: 'Façade 3D',
      title: 'Poser la Porte en Bronze (embrasure 3D) & coller les 6 Colonnes',
      subtitle: 'La grande porte derrière le porche AVANT que les colonnes ne ferment l’accès',
      duration: '35 min',
      dryTime: '1–2 h',
      tags: [
        { icon: '✂️', label: 'Page 2 Frontispice A4 1:1', kind: 'paper' },
        { icon: '🚪', label: 'Embrasure relief 3–5 mm', kind: 'subbuild' },
        { icon: '🧴', label: 'Polymère sans solvant / Époxy', kind: 'glue' },
      ],
      parts: [
        makeSupply('🚪', 'Porte monumentale en bronze (Page 2 A4 1:1)', 'Vantaux 70×117 mm + Cadre marbre & corniche 114×157 mm (imprimer ×2 pour embrasure)', 'Papier 1:1', '#059669'),
        makeSupply('📐', 'Plaque support relief (3 à 5 mm)', 'Carton gris, carton plume ou fine chute XPS évidée au centre', 'Relief', '#d97706'),
        ...makePartEntries(g.allColumns, 'Colonnes Plastique peintes (6×)'),
      ],
      instructions: [
        '**1 — Imprimer & découper la Porte (Page 2 Frontispice A4 1:1, échelle 100 %) :** découpe proprement les **vantaux en bronze + imposte (`70 × 117 mm`)** et colle-les à plat au **Mod Podge mat**, pile au centre du Mur Avant de la Cella (alignés sur le sol du Stylobate).',
        '**2 — Créer la vraie embrasure en creux :** colle le **cadre en marbre + frise bleue + corniche (`114 × 157 mm`)** sur une plaque rigide de **3 à 5 mm**, évide l’intérieur au cutter, peins les tranches coupées en beige travertin patiné, puis colle le cadre par-dessus la porte !',
        '**3 — Retirer les 6 scotchs de masquage** sur les emplacements des colonnes sur le Stylobate.',
        `**4 — Coller les 6 colonnes peintes (${numsLabel(g.allColumns)}) :** utilise une **colle polymère sans solvant ou époxy** (mieux adaptée au duo plastique/XPS que la PVA seule). Vérifie leur parfaite verticalité (la corniche de 114 mm passe entre les colonnes latérales avec 3 mm de jeu de chaque côté !).`,
      ],
      tips: {
        kind: 'tip',
        title: 'Pourquoi cet effet d’embrasure est magique',
        text: 'Dès que la lumière traverse le porche entre les colonnes, le cadre en relief de 3–5 mm projette de **vraies ombres portées** sur les vantaux de bronze patiné !'
      },
      specs: [
        { k: 'Porte bronze (vantaux)', v: '70 × 117 mm (à plat)' },
        { k: 'Cadre + corniche relief', v: '114 × 157 mm (sur 3–5 mm évidé)' },
        { k: 'Espace libre au-dessus', v: '13 mm sous l’architrave' },
      ],
      scene: {
        visibleIds: Array.from(built),
        activeIds: ids(g.allColumns),
        isolateSubassembly: false,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.18 },
        visualState: {
          paintedPodium: true, paintedCella: true, paintedColumns: true,
          showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
        }
      }
    });
  }

  // =========================================================================
  // PHASE 4 — HABILLAGE INTÉRIEUR DES 24 CASES (FRESQUES & MOSAÏQUES)
  // =========================================================================

  // ÉTAPE 15 : Découpe, rainage & pliage des 24 kits papier A4 1:1
  pushStep({
    phaseId: 'fresco',
    badge: 'Papier A4 1:1',
    title: 'Imprimer, découper & pré-plier les 24 kits Fresques + Mosaïques',
    subtitle: '24 bandes murales en U + 24 sols mosaïques + 24 plafonds (300 DPI)',
    duration: '1 h',
    dryTime: null,
    tags: [
      { icon: '🖨️', label: 'A4 Paysage 100 %', kind: 'paper' },
      { icon: '📏', label: 'Vérifier règle 50 mm', kind: 'warning' },
      { icon: '📐', label: 'Rainage + pliage en U', kind: 'subbuild' },
    ],
    parts: [
      makeSupply('🖨️', 'Planches 24 Cases (onglet 🎨 Fresques)', 'Papier mat 160–200 g/m² • Échelle 100 % / Marges Aucune', 'Impression', '#059669'),
      makeSupply('📐', 'Outils papier', 'Règle métallique + cutter lame neuve + plioir (ou dos de cutter)', 'Outils', '#475569'),
    ],
    instructions: [
      'Ouvre l’onglet **🎨 Fresques** de l’atelier, clique sur **🖨️ Toutes les 24 cases** et imprime en **A4 Paysage, Échelle 100 % (Taille réelle), Marges : Aucune** sur papier mat épais (**160 à 200 g/m²**). **Contrôle la règle de 50 mm** sur la page 1 avant d’imprimer le reste !',
      'Découpe proprement sur les traits noirs les **24 bandes murales en U** (avec leurs 2 languettes trapézoïdales en haut et en bas du fond), les **24 mosaïques de sol** et les **24 plafonds communs**.',
      '**Rainage net sans abîmer l’image :** pose ta règle en alignant les **4 repères rouges extérieurs** (aucun trait n’est imprimé sur la fresque !), passe délicatement le dos d’un cutter ou un plioir, puis plie chaque bande à 90° en forme de **U** (fresque à l’intérieur) et replie les 2 languettes vers l’intérieur.',
      'Note au crayon au dos de chaque morceau son numéro **#1 à #24** et regroupe-les par **paires dos-à-dos** (`#1/#13`, `#2/#14` … `#12/#24`).',
    ],
    tips: {
      kind: 'warning',
      title: 'Profondeur 88 mm vs 80 mm derrière les portes',
      text: `Dans les couloirs traversants de **${m.cellaW} mm** (soit **${m.caseDepthHalf} mm** par côté), trace au crayon un discret trait d’arrêt à **${m.caseDepthHalf} mm** (axe central exact) sur chaque étagère : ainsi chaque paire Gauche/Droite se rencontre pile au milieu !`
    },
    specs: [
      { k: 'Bande murale en U', v: '236 × 51 mm (plis à 88 & 148 mm)' },
      { k: 'Sol & Plafond', v: '60 × 88 mm (×24 chacun)' },
      { k: 'Axe médian casier', v: `${m.caseDepthHalf} mm depuis chaque bord` },
    ],
    scene: {
      visibleIds: ids(cellaStructure),
      activeIds: ids([...g.shelves, ...g.dividers]),
      isolateSubassembly: true,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'flank-right', zoomPad: 1.2 },
      visualState: { paintedCella: true, showBronzeDoor: true }
    }
  });

  // ÉTAPE 16 : Collage dos-à-dos des 24 cases (Gauche #1–#12 & Droite #13–#24)
  pushStep({
    phaseId: 'fresco',
    badge: 'Collage papier',
    title: 'Coller les 24 Fresques, Mosaïques & Plafonds (dos-à-dos)',
    subtitle: 'Couloir par couloir : Cases #1–#12 (Gauche) en miroir de #13–#24 (Droite)',
    duration: '1 h 30',
    dryTime: '1 h',
    tags: [
      { icon: '🛡️', label: 'Mod Podge mat (fine couche)', kind: 'primer' },
      { icon: '🖼️', label: '12 paires dos-à-dos', kind: 'paper' },
    ],
    parts: [
      makeSupply('🖼️', '24 kits pré-pliés (Étape 15)', 'Gauche : #1–#12 • Droite : #13–#24 (Finale #24 = Saturnales !)', '24 cases', '#059669'),
      makeSupply('🛡️', 'Mod Podge mat + colle en bâton', 'Mod Podge très fin sur le XPS • Colle en bâton entre les 2 fonds dos-à-dos', 'Colle', '#7c3aed'),
    ],
    instructions: [
      '**Travaille couloir par couloir** (ex. Case **#1** à gauche puis sa jumelle **#13** à droite) pour former une cloison centrale rigide à deux épaisseurs de papier !',
      '**1er côté (ex. Case #1) :** applique une **très fine couche** de Mod Podge mat sur les deux parois latérales XPS + les 2 languettes de la bande en U. Glisse la bande jusqu’au **repère central de 90 mm** et maroufle bien les angles avec un plioir ou une règle.',
      '**Verrouillage sol & plafond :** encolle la **Mosaïque de sol** et plaque-la par-dessus la languette inférieure ; fais pareil avec le **Plafond commun** par-dessus la languette supérieure (zéro jour blanc possible dans les coins !).',
      '**2e côté (Case jumelle #13) :** passe un peu de **colle en bâton** au dos du mur de fond déjà posé (ou sur le dos de la nouvelle fresque), glisse la bande en U de #13 jusqu’à venir plaquer **dos-à-dos** contre #1, puis pose sa mosaïque et son plafond. Répète pour les 12 couloirs !',
    ],
    tips: {
      kind: 'tip',
      title: 'Zéro gondole sur le papier',
      text: 'Utilise le Mod Podge en **couche très fine et tirée** (jamais trempée) et presse 15 secondes avec un chiffon doux sec. Sur du papier 160–200 g/m², le rendu reste tendu comme une vraie fresque murale !'
    },
    specs: [
      { k: 'Flanc Gauche', v: 'Haut : #1–#4 • Milieu : #5–#8 • Bas : #9–#12' },
      { k: 'Flanc Droit', v: 'Haut : #13–#16 • Milieu : #17–#20 • Bas : #21–#24' },
      { k: 'Case Finale #24', v: 'La Fête des Saturnales (Flanc Droit, bas avant)' },
    ],
    scene: {
      visibleIds: Array.from(built),
      activeIds: ids([...g.shelves, ...g.dividers]),
      isolateSubassembly: false,
      explodeMap: {},
      arrows: [
        { from: [b.bCella.minX + 135, b.bCella.minY + 95, b.bCella.maxZ + 52], to: [b.bCella.minX + 135, b.bCella.minY + 95, b.bCella.maxZ + 6] },
        { from: [b.bCella.minX + 135, b.bCella.minY + 95, b.bCella.minZ - 52], to: [b.bCella.minX + 135, b.bCella.minY + 95, b.bCella.minZ - 6] },
      ],
      camera: { preset: 'iso-front-right', zoomPad: 1.18 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedColumns: true,
        showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
        showInteriorFrescoes: true,
      }
    }
  });

  // =========================================================================
  // PHASE 5 — QUINCAILLERIE, CAMOUFLAGE & POSE DES 24 PORTES
  // =========================================================================

  // ÉTAPE 17 : Boutons Bronze + Butées intérieures
  pushStep({
    phaseId: 'doors',
    badge: 'Quincaillerie',
    title: 'Monter les 24 Boutons Bronze & les mini-butées de porte',
    subtitle: 'Fixation renforcée dans l’XPS 10 mm + arrêt net à fleur',
    duration: '45 min',
    dryTime: '30 min',
    tags: [
      { icon: '🔩', label: '24× Boutons bronze B08J7D5C9R', kind: 'hardware' },
      { icon: '⚠️', label: 'Rondelle / cale au dos', kind: 'warning' },
    ],
    parts: [
      ...makePartEntries(g.allPlugs24, '24 Portes peintes (#1 à #24)'),
      makeSupply('🔩', '24× Mini boutons bronze antique', 'Ø 12 × H 11 mm + vis M3 + 24 rondelles/cales carton au dos', 'Quincaillerie', '#ea580c'),
      makeSupply('🧱', '24–48× Mini-butées (chutes XPS)', 'Petits dés 5×5 mm peints, collés à 10 mm de profondeur côté bouton', 'Butées', '#64748b'),
    ],
    instructions: [
      '**Choisis le sens d’ouverture (symétrique « doubles portes de temple » recommandé) :** sur chaque rangée de 4 cases, **Col. 1 & 2** ont les charnières à gauche et le bouton à droite ; **Col. 3 & 4** ont les charnières à droite et le bouton à gauche (les boutons centraux de Col. 2 & 3 se font face !).',
      '**Pose solide des boutons :** perce un trou propre de **Ø 3 mm** côté ouverture (à ~10–12 mm du bord libre, centré en hauteur). Glisse une **petite rondelle ou carré de plastique/carton (12×12 mm)** côté intérieur pour que la tête de vis ne traverse jamais la mousse, ajoute 1 goutte de colle dans le trou et serre délicatement sans écraser l’XPS.',
      '**Pose des mini-butées :** à l’intérieur de chaque case, colle 1 ou 2 minuscules cales peintes (`5 × 5 mm`) à exactement **10 mm du bord extérieur** (côté bouton, en haut ou en bas) : chaque porte fermera **pile à fleur** sans jamais pouvoir s’enfoncer dans les fresques !',
    ],
    tips: {
      kind: 'tip',
      title: 'Si une porte baille légèrement',
      text: 'Normalement le léger frottement de la porte dans son cadre suffit. Si l’une des portes a tendance à s’entrouvrir, encastre un **mini-aimant néodyme 3×1 mm** sur la tranche de la porte et une tête de minuscule clou/aimant en face dans la butée !'
    },
    specs: [
      { k: 'Position bouton', v: '~10–12 mm du bord libre, mi-hauteur' },
      { k: 'Profondeur butée', v: '10 mm exacts (épaisseur de la porte)' },
    ],
    scene: {
      visibleIds: [...built, ...ids(g.allPlugs24)],
      activeIds: ids(g.allPlugs24),
      isolateSubassembly: false,
      explodeMap: Object.fromEntries(g.allPlugs24.map((p) => [p.id, { dx: 0, dy: 0, dz: p.plugSide === 'left' ? -36 : 36 }])),
      arrows: [
        { from: [b.bCella.minX + 135, b.bCella.minY + 115, b.bCella.maxZ + 52], to: [b.bCella.minX + 135, b.bCella.minY + 115, b.bCella.maxZ + 12] },
        { from: [b.bCella.minX + 135, b.bCella.minY + 115, b.bCella.minZ - 52], to: [b.bCella.minX + 135, b.bCella.minY + 115, b.bCella.minZ - 12] },
      ],
      camera: { preset: 'iso-front-right', zoomPad: 1.2 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true,
        showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
        showInteriorFrescoes: true, showHardware: 'knobs',
      }
    }
  });

  // ÉTAPE 18 : Pose & Camouflage Pierre des 48 Mini-Charnières (8×10 mm)
  addBuilt(g.allPlugs24);
  pushStep({
    phaseId: 'doors',
    badge: 'Charnières',
    title: 'Poser & camoufler les 48 Mini-Charnières (8 × 10 mm)',
    subtitle: '2 charnières par porte, tassées à fleur dans l’XPS puis camouflées couleur pierre',
    duration: '1 h 30',
    dryTime: '2 h (époxy)',
    tags: [
      { icon: '🔩', label: '48× Charnières 8×10 mm', kind: 'hardware' },
      { icon: '⚠️', label: 'Jamais 2 sur la même cloison 6 mm', kind: 'warning' },
      { icon: '🖌️', label: 'Camouflage pierre (axe libre !)', kind: 'paint' },
    ],
    parts: [
      makeSupply('🔩', '48× Mini-charnières laiton 8×10 mm', 'Ref. B08BFNM9ZQ (2 par porte, à ~8 mm du haut et du bas)', 'Quincaillerie', '#ea580c'),
      makeSupply('📌', 'Clous fins / épingles 15–20 mm + Époxy', 'Remplace les clous trop courts de 5 mm pour un ancrage béton dans l’XPS', 'Fixation', '#0284c7'),
    ],
    instructions: [
      '**Règle géométrique absolue (cloisons de 6 mm) :** une charnière ouverte occupe `1 mm (demi-axe) + 4 mm (ailette) = 5 mm` sur la tranche de `6 mm`. **Ne mets JAMAIS deux charnières côte à côte sur la même cloison !** Respecte la disposition symétrique (Col 1 & 2 à gauche, Col 3 & 4 à droite → 0 charnière sur la cloison centrale).',
      '**Préparation métal & camouflage à fleur :** raye légèrement les ailettes laiton au papier de verre fin (sinon l’acrylique perle). Place chaque porte fermée dans sa case, repère les 2 charnières à **~8 mm du haut et du bas**, et **tasse très légèrement l’XPS sur ~0,5 mm** au dos d’un cutter sous les 2 ailettes pour qu’elles s’assoient **pile à fleur** !',
      '**Fixation béton :** colle les ailettes à l’**époxy sans solvant** et enfonce de fins **clous/épingles de 15–20 mm en léger biais** dans les cloisons de 6 mm et les portes de 10 mm (coupe/plie si besoin, rien ne doit ressortir dans la case).',
      '**Camouflage couleur pierre :** une fois l’époxy prise, tamponne **uniquement les 2 ailettes plates** avec ta peinture travertin + lavis. **Zéro enduit ni peinture épaisse sur le petit cylindre central de 2 mm** (passe juste un jus brun foncé dessus pour le fondre dans l’ombre du joint !).',
    ],
    tips: {
      kind: 'warning',
      title: 'Test d’ouverture immédiat',
      text: 'Ouvre et referme doucement chaque porte dès la prise pour vérifier que le gond tourne librement sans frotter et sans arracher la peinture.'
    },
    specs: [
      { k: 'Disposition Col. 1–4', v: 'G · G · [boutons] · D · D (ou toutes même sens)' },
      { k: 'Emprise sur 6 mm', v: '5 mm (reste 1 mm de marge)' },
      { k: 'Hauteur de pose', v: '~8 mm du haut et ~8 mm du bas' },
    ],
    scene: {
      visibleIds: Array.from(built),
      activeIds: [],
      isolateSubassembly: false,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'flank-right', zoomPad: 1.15 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true,
        showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
        showInteriorFrescoes: true, showHardware: 'all', openDemoDoors: [14, 19],
      }
    }
  });

  // ÉTAPE 19 : Numérotation des 24 Portes (1 à 24)
  pushStep({
    phaseId: 'doors',
    badge: 'Finition portes',
    title: 'Peindre ou poser les numéros 1 à 24 sur les façades',
    subtitle: 'Chiffres romains (I–XXIV) ou arabes (1–24) en or antique ou rouge pompéien',
    duration: '30 min',
    dryTime: '30 min',
    tags: [
      { icon: '🖌️', label: 'Pinceau fin / Pochoir', kind: 'paint' },
      { icon: '🎄', label: 'Ordre mélangé ou séquentiel', kind: 'info' },
    ],
    parts: [
      makeSupply('🖌️', 'Peinture Or antique / Rouge pompéien / Ombre', 'Ou petits chiffres bois/laiton collés au centre de chaque porte', 'Numéros', '#d97706'),
    ],
    instructions: [
      'Décide si tu veux afficher les dates **dans l’ordre** (1 à 12 d’un côté, 13 à 24 de l’autre) ou **mélangées** façon vrai calendrier de l’Avent pour que Morgane cherche sa case chaque matin *(en veillant à garder la date **24** sur la porte de la case **La Fête des Saturnales** !)*',
      'Repère légèrement au crayon le centre optique de chaque porte (en tenant compte du bouton sur le côté).',
      'Peins les chiffres au pinceau fin / feutre peinture acrylique 0,7 mm (ou colle tes chiffres découpés), puis passe un minuscule lavis vieillissant pour qu’ils aient la même patine antique que le temple.',
    ],
    tips: {
      kind: 'tip',
      title: 'L’esprit romain jusqu’au bout',
      text: 'Des chiffres **or vieilli** ou **rouge pompéien délavé** ressortent magnifiquement sur le travertin clair — et tu peux réserver le **XXV** (ou **25**) très discret sur la première contremarche de l’escalier !'
    },
    specs: [
      { k: 'Cases latérales', v: '1 à 24 (12 à gauche + 12 à droite)' },
      { k: 'Case bonus', v: '25 — Escalier frontal amovible' },
    ],
    scene: {
      visibleIds: Array.from(built),
      activeIds: [],
      isolateSubassembly: false,
      explodeMap: {},
      arrows: [],
      camera: { preset: 'iso-front-right', zoomPad: 1.15 },
      visualState: {
        paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true,
        showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
        showInteriorFrescoes: true, showHardware: 'all', showDoorNumbers: true,
        openDemoDoors: [14],
      }
    }
  });

  // =========================================================================
  // PHASE 6 — ENTABLEMENT, DÉDICACE LATINE, FRONTONS & TOIT EN TUILES
  // =========================================================================

  // ÉTAPE 20 : Sous-ensemble Architrave + Gravure de la Dédicace Latine
  const roofPlafond = [...g.plafond];
  {
    const explodeMap = {};
    const arrows = [];
    if (roofPlafond.length >= 2) {
      explodeMap[roofPlafond[1].id] = { dx: 36, dy: 0, dz: 0 };
      arrows.push({
        from: [roofPlafond[1].x + 32, roofPlafond[1].y + 5, roofPlafond[1].z + 105],
        to: [roofPlafond[0].x + roofPlafond[0].dx + 4, roofPlafond[0].y + 5, roofPlafond[0].z + 105],
      });
    }

    pushStep({
      phaseId: 'roof',
      badge: 'Gravure 1:1',
      title: 'Assembler l’Architrave & graver la Dédicace Latine',
      subtitle: `${numsLabel(roofPlafond)} — « MORGANAE·OPTIMAE·MAXIMAE / DAVID·FECIT·ET·D·D·L·M »`,
      duration: '35 min',
      dryTime: '2 h',
      tags: [
        { icon: '🔄', label: 'Sous-assemblage à plat', kind: 'subbuild' },
        { icon: '✍️', label: 'Gravure au stylo bille', kind: 'paper' },
        { icon: '🛡️', label: 'Sous-couche fine !', kind: 'primer' },
      ],
      parts: [
        ...makePartEntries(roofPlafond, 'Plafond & Architrave Supérieure (1/2 + 2/2)'),
        makeSupply('✍️', 'Gabarit Architrave 210 × 10 mm (Page 1 Frontispice)', 'Bande contour creux à décalquer, avec repère central rouge', 'Gabarit 1:1', '#059669'),
      ],
      instructions: [
        `Colle bout à bout à plat les 2 parties du **Plafond & Architrave** (**${numsLabel(roofPlafond)}**) pour former une plaque de **${m.roofL} × ${m.podiumW} mm**, puis lisse le joint au papier de verre fin / Axton.`,
        '**Gravure de la dédicace (AVANT sous-couche !) :** découpe le gabarit contour creux (`210 × 10 mm`, Page 1 *Frontispice & Façade*), scotche-le centré (repère rouge à 105 mm) sur la **tranche avant de 10 mm**, puis repasse chaque lettre fermement au **stylo bille** : le texte se grave directement en creux dans le XPS !',
        'Retire le gabarit, passe une couche **fine** de Mod Podge + acrylique (pour durcir les lettres sans les combler), peins l’architrave et le dessous du plafond en **travertin patiné**.',
        'Fais couler un **jus brun-noir** (ou repasse au pinceau fin / feutre peinture 0,5 mm) dans les sillons gravés, puis essuie très légèrement la surface au chiffon humide pour un effet **inscription lapidaire antique** !',
      ],
      tips: {
        kind: 'tip',
        title: 'Sens de l’inscription',
        text: '**MORGANAE·OPTIMAE·MAXIMAE** (clin d’œil à *Jupiter Optimus Maximus*) / **DAVID·FECIT·ET·D·D·L·M** (*David l’a fait et l’a offert de bon gré, à juste titre*). Prends 2 minutes pour faire un essai de pression au stylo bille sur une chute de 10 mm avant !'
      },
      specs: [
        { k: 'Plateau Architrave', v: `${m.roofL} × ${m.podiumW} × 10 mm` },
        { k: 'Tranche gravée', v: `${m.podiumW} × 10 mm (lettres ~3,5 / 3,0 mm)` },
      ],
      scene: {
        visibleIds: ids(roofPlafond),
        activeIds: [],
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.05 },
        visualState: { paintedRoof: true, showArchitraveText: true }
      }
    });
  }

  // ÉTAPE 21 : Sous-ensemble Toiture (Fronton Avant + Pignon Arrière + 2 Versants)
  const roofPartsAll = [...g.plafond, ...g.fronton, ...g.pignon, ...g.roofLeft, ...g.roofRight];
  {
    const newRoof = [...g.fronton, ...g.pignon, ...g.roofLeft, ...g.roofRight];
    const explodeMap = {};
    for (const p of g.fronton) explodeMap[p.id] = { dx: 26, dy: 24, dz: 0 };
    for (const p of g.pignon) explodeMap[p.id] = { dx: -26, dy: 24, dz: 0 };
    for (const p of g.roofLeft) explodeMap[p.id] = { dx: 0, dy: 48, dz: -24 };
    for (const p of g.roofRight) explodeMap[p.id] = { dx: 0, dy: 48, dz: 24 };

    const arrows = [
      { from: [b.bRoof.minX + b.bRoof.dx / 2, b.bRoof.maxY + 56, b.bRoof.minZ + 45], to: [b.bRoof.minX + b.bRoof.dx / 2, b.bRoof.maxY + 12, b.bRoof.minZ + 52] },
      { from: [b.bRoof.minX + b.bRoof.dx / 2, b.bRoof.maxY + 56, b.bRoof.maxZ - 45], to: [b.bRoof.minX + b.bRoof.dx / 2, b.bRoof.maxY + 12, b.bRoof.maxZ - 52] },
    ];

    pushStep({
      phaseId: 'roof',
      badge: 'Sous-assemblage',
      title: 'Monter la charpente du Toit (Frontons + 2 Versants inclinés)',
      subtitle: `${numsLabel(g.fronton)} + ${numsLabel(g.pignon)} + versants (${numsLabel([...g.roofLeft, ...g.roofRight])})`,
      duration: '30 min',
      dryTime: '2 h',
      tags: [
        { icon: '🔄', label: 'Bloc toit autonome', kind: 'subbuild' },
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
        { icon: '🏺', label: 'Joint faîtage Axton', kind: 'filler' },
      ],
      parts: [
        ...makePartEntries(g.fronton, 'Fronton Triangulaire Avant (10 mm)'),
        ...makePartEntries(g.pignon, 'Pignon Triangulaire Arrière (10 mm)'),
        ...makePartEntries(g.roofLeft, 'Versant de Toit Gauche (1/2 + 2/2)'),
        ...makePartEntries(g.roofRight, 'Versant de Toit Droit (1/2 + 2/2)'),
      ],
      instructions: [
        `Colle bout à bout à plat les 2 morceaux du **Versant Gauche** (**${numsLabel(g.roofLeft)}**) et ceux du **Versant Droit** (**${numsLabel(g.roofRight)}**) pour obtenir 2 pans de **${m.roofL} × ${m.roofSlopeLen} mm**.`,
        `Colle le **Fronton Avant** (**${numsLabel(g.fronton)}**) à l’avant de l’Architrave (juste au-dessus de ta dédicace latine) et le **Pignon Arrière** (**${numsLabel(g.pignon)}**) à l’extrémité arrière, bien d’équerre.`,
        'Biseaute légèrement au cutter/papier de verre l’arête supérieure (côté faîtage) de chaque versant pour qu’ils s’épousent proprement au sommet, puis colle les 2 versants sur les pentes des triangles.',
        'Rebouche le sillon central du faîtage à l’**enduit allégé Axton**, puis sous-couche et peins en **travertin patiné** toutes les tranches visibles des rampants et les bords des frontons.',
      ],
      tips: {
        kind: 'tip',
        title: 'Pourquoi garder le toit en un bloc séparé jusqu’au bout ?',
        text: 'Poser les plaques de tuiles, peindre la terre cuite et coller les 2 frontons papier sur un bloc-toit posé à plat devant toi est beaucoup plus précis et sans risque de goutte de peinture sur le temple !'
      },
      specs: [
        { k: 'Triangles Fronton/Pignon', v: `Base ${m.pedimentW} × H ${m.pedimentH} mm (ép. 10 mm)` },
        { k: 'Pans inclinés (×2)', v: `${m.roofL} × ${m.roofSlopeLen} mm` },
      ],
      scene: {
        visibleIds: ids(roofPartsAll),
        activeIds: ids(newRoof),
        isolateSubassembly: true,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.25 },
        visualState: { paintedRoof: true, showArchitraveText: true }
      }
    });
  }

  // ÉTAPE 22 : Pose & Peinture des Plaques de Tuiles 250×125 mm + Frontons Patinés
  pushStep({
    phaseId: 'roof',
    badge: 'Toiture & Frontons',
    title: 'Poser les Tuiles (250 × 125 mm) & coller les 2 Frontons patinés',
    subtitle: 'Couverture terre cuite romaine vieillie + Saturnales (avant) & Lune (arrière)',
    duration: '1 h 15',
    dryTime: '2–3 h',
    tags: [
      { icon: '🧱', label: `${m.tileSheetsNeeded}× plaques tuiles 250×125`, kind: 'subbuild' },
      { icon: '🖌️', label: 'Peinture terre cuite', kind: 'paint' },
      { icon: '✂️', label: 'Page 1 Frontispice A4 1:1', kind: 'paper' },
    ],
    parts: [
      makeSupply('🏠', `${m.tileSheetsNeeded}× Plaques de tuiles 250 × 125 mm`, `125 mm couvre toute la pente (${m.roofSlopeLen} mm + 6 mm débord) • 250 + ${m.tileRemainder} mm/versant`, 'Toiture', '#dc2626'),
      makeSupply('☀️', 'Fronton Avant & Pignon Arrière (Page 1 A4 1:1)', `2 triangles isocèles ${m.pedimentW} × ${m.pedimentH} mm (300 DPI patinés)`, 'Papier 1:1', '#059669'),
    ],
    instructions: [
      `**1 — Découpe & collage des tuiles :** sur chaque versant (${m.roofL} × ${m.roofSlopeLen} mm), la largeur de **125 mm** couvre toute la pente en laissant un joli **débord de gouttière de ~6 mm** en bas ! Colle 1 plaque entière de \`250 mm\` + 1 rallonge de \`~${m.tileRemainder} mm\` bien alignée sur les nervures (colle polymère sans solvant).`,
      '**2 — Faîtage (tuiles faîtières) :** recouvre l’arête sommitale avec une bande de chutes de tuiles coupées en demi-tubes (ou façonne un cordon de tuiles faîtières à l’enduit allégé Axton).',
      '**3 — Peinture terre cuite antique :** sous-couche Mod Podge + acrylique brun-rouge, couche de base **terracotta / terre de Sienne brûlée** (en variant quelques tuiles vers l’ocre et le rouge brique), **lavis brun-noir** dans les creux, puis léger **brossage à sec ocre clair / poussière calcaire** + vernis mat.',
      '**4 — Pose des 2 Frontons papier (APRÈS séchage complet de la peinture !) :** découpe les deux triangles 1:1 (Page 1 *Frontispice & Façade*), colle **Saturnales (Soleil d’hiver)** à l’avant et **Lune & Rinceaux** à l’arrière au Mod Podge mat bien lissé, et fonds délicatement la tranche blanche du papier avec une touche de lavis pierre.',
    ],
    tips: {
      kind: 'tip',
      title: 'Raccord invisible entre les plaques de tuiles',
      text: `Place la jonction \`250 + ${m.tileRemainder} mm\` côté arrière (ou recouvre d’une tuile superposée) et joue avec les nuances d’ocre/mousse dans le lavis : le raccord devient 100 % indétectable !`
    },
    specs: [
      { k: 'Pente réelle', v: `${m.roofSlopeLen} mm (plaques 125 mm → +6 mm débord)` },
      { k: 'Longueur par versant', v: `250 mm + ${m.tileRemainder} mm = ${m.roofL} mm` },
      { k: 'Frontons A4 1:1', v: `△ ${m.pedimentW} × ${m.pedimentH} mm (×2)` },
    ],
    scene: {
      visibleIds: ids(roofPartsAll),
      activeIds: [],
      isolateSubassembly: true,
      explodeMap: {},
      arrows: [
        { from: [b.bRoof.maxX + 42, b.bRoof.minY + 35, b.bRoof.minZ + b.bRoof.dz / 2], to: [b.bRoof.maxX + 6, b.bRoof.minY + 35, b.bRoof.minZ + b.bRoof.dz / 2] },
      ],
      camera: { preset: 'iso-front-right', zoomPad: 1.14 },
      visualState: { paintedRoof: true, showArchitraveText: true, showTiles: true, showFrontons: true }
    }
  });

  // ÉTAPE OPTIONNELLE AUTOMATIQUE : Si le plan local contient des pièces personnalisées (ex. 4 triangles 20 mm)
  if (g.customPieces.length > 0) {
    addBuilt(g.customPieces);
    pushStep({
      phaseId: 'roof',
      badge: 'Pièces perso',
      title: `Poser tes ${g.customPieces.length} pièces personnalisées ajoutées au plan`,
      subtitle: `${numsLabel(g.customPieces)} — détectées automatiquement dans ton plan sauvegardé`,
      duration: '15 min',
      dryTime: '1 h',
      tags: [
        { icon: '✨', label: 'Pièces sur-mesure', kind: 'subbuild' },
        { icon: '🧴', label: 'Colle PVA', kind: 'glue' },
      ],
      parts: makePartEntries(g.customPieces),
      instructions: [
        `Ton plan personnalisé comporte **${g.customPieces.length} pièce(s) supplémentaire(s)** (**${numsLabel(g.customPieces)}**) mises en évidence en couleur vive sur la vue 3D ci-contre.`,
        'Contrôle leur position exacte en faisant pivoter la vue 3D, puis colle-les mousse-sur-mousse avant leur finition peinture/patine assortie au temple.',
      ],
      tips: {
        kind: 'tip',
        title: 'Synchronisation automatique',
        text: 'Toutes les pièces que tu ajoutes dans l’Atelier 2D/3D sont reprises automatiquement ici avec leurs vrais numéros P# et leurs cotes réelles.'
      },
      specs: [
        { k: 'Nombre de pièces', v: `${g.customPieces.length} pièce(s)` },
      ],
      scene: {
        visibleIds: [...built, ...ids(roofPartsAll)],
        activeIds: ids(g.customPieces),
        isolateSubassembly: false,
        explodeMap: Object.fromEntries(g.customPieces.map((p) => [p.id, { dx: 0, dy: 28, dz: 0 }])),
        arrows: [],
        camera: { preset: 'iso-front-right', zoomPad: 1.2 },
        visualState: {
          paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true, paintedRoof: true,
          showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
          showInteriorFrescoes: true, showHardware: 'all', showDoorNumbers: true,
          showArchitraveText: true, showTiles: true, showFrontons: true,
        }
      }
    });
  }

  // ÉTAPE FINALE : Assemblage Final du Toit, Insertion du Tiroir #25 & Vérification
  addBuilt(roofPartsAll);
  {
    const explodeMap = Object.fromEntries(roofPartsAll.map((p) => [p.id, { dx: 0, dy: 44, dz: 0 }]));
    const arrows = [
      { from: [b.bRoof.minX + 80, b.bRoof.maxY + 58, b.bRoof.minZ + 105], to: [b.bRoof.minX + 80, b.bRoof.maxY + 12, b.bRoof.minZ + 105] },
      { from: [b.bRoof.maxX - 70, b.bRoof.maxY + 58, b.bRoof.minZ + 105], to: [b.bRoof.maxX - 70, b.bRoof.maxY + 12, b.bRoof.minZ + 105] },
    ];
    if (m.stairPiece) {
      arrows.push({
        from: [m.stairPiece.x + m.stairPiece.dx + 68, 30, m.stairPiece.z + m.stairPiece.dz / 2],
        to: [m.stairPiece.x + m.stairPiece.dx + 14, 30, m.stairPiece.z + m.stairPiece.dz / 2],
      });
    }

    pushStep({
      phaseId: 'roof',
      badge: 'Finalisation',
      title: 'Assemblage final : Pose du Toit, Tiroir #25 & Temple terminé !',
      subtitle: 'MORGANAE·OPTIMAE·MAXIMAE — Prêt à garnir des 25 surprises',
      duration: '20 min',
      dryTime: '1 h (si toit collé)',
      tags: [
        { icon: '🏛️', label: 'Pose finale', kind: 'subbuild' },
        { icon: '🎁', label: '25 cases prêtes !', kind: 'paper' },
        { icon: '🎉', label: 'Terminé !', kind: 'info' },
      ],
      parts: [
        makeSupply('🏛️', 'Bloc Toiture complet (Étape 22)', `${m.roofL} × ${m.podiumW} mm — tuiles + frontons + dédicace`, 'Toit', '#dc2626'),
        makeSupply('🪜', `Escalier + Tiroir Case #25 (${numsLabel(g.stairs)})`, 'Glissé entre les 2 murets d’échiffre', 'Case #25', '#d97706'),
      ],
      instructions: [
        '**Pose du Toit (2 options) :** retire le scotch de masquage sur le haut de la Cella. Tu peux soit **coller le bloc Toiture définitivement** sur la Cella et les 6 chapiteaux (PVA sur Cella + époxy/polymère sur les 6 colonnes), soit le laisser **amovible avec 4 petits pions de centrage** (demi-cure-dents plantés dans le haut des murs de la Cella).',
        '**Insertion du Tiroir #25 :** glisse doucement l’ensemble **Escalier + Boîte-tiroir** entre les deux Murets d’Échiffre jusqu’en butée contre la semelle.',
        '**Contrôle qualité final :** ouvre et referme une dernière fois les **24 portes** et le **tiroir #25**, dépoussière d’un coup de pinceau sec, puis passe si besoin un ultime voile de vernis mat sur les retouches.',
        '**Il ne reste plus qu’à remplir les 25 cases** (et garder le plus beau cadeau pour le grand tiroir sous l’escalier du 25 décembre) ! 🎉',
      ],
      tips: {
        kind: 'tip',
        title: 'Félicitations, Architecte !',
        text: 'Tu peux faire glisser le curseur **« 💥 Éclaté étape »** à **0 %** ci-contre pour admirer le Temple de Morgane totalement fermé et fini sous tous les angles !'
      },
      specs: [
        { k: 'Dimensions finales', v: `${(b.bAll.dx / 10).toFixed(1)} × ${(b.bAll.dz / 10).toFixed(1)} × H ${(b.bAll.dy / 10).toFixed(1)} cm` },
        { k: 'Capacité Calendrier', v: '24 niches fresquées + 1 tiroir secret (1,1 L)' },
      ],
      scene: {
        visibleIds: ids(pieces),
        activeIds: ids(roofPartsAll),
        isolateSubassembly: false,
        explodeMap,
        arrows,
        camera: { preset: 'iso-front-right', zoomPad: 1.18 },
        visualState: {
          paintedPodium: true, paintedCella: true, paintedDoors: true, paintedColumns: true, paintedRoof: true,
          showFriezes: 'painted', showDrawerBox: true, showBronzeDoor: true,
          showInteriorFrescoes: true, showHardware: 'all', showDoorNumbers: true,
          showArchitraveText: true, showTiles: true, showFrontons: true,
          openStairs: 45, openDemoDoors: [14, 19],
        }
      }
    });
  }

  return {
    source,
    params,
    pieces,
    cutDoneIds,
    geom,
    phases: PHASES,
    steps,
  };
}
