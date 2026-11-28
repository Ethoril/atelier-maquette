// Calepinage automatique (2D Bin-Packing) sur plaques de polystyrène 300 × 200 mm,
// support des pièces triangulaires (tête-bêche + rendu polygone), et redécoupage auto > 300 × 200 mm.

import { nextPieceId, recomputeCutDimensions, getThicknessProp, computeStairLayers } from './templeGenerator.js';

export const PLATE_WIDTH = 300;
export const PLATE_HEIGHT = 200;
export const DEFAULT_KERF = 1; // Perte de découpe par défaut (trait de fil chaud / lame = 1 mm)
export const ALLOWED_THICKNESSES = [6, 10, 20];

/**
 * Ramène toute épaisseur de polystyrène à l'une des 3 épaisseurs disponibles : 6, 10 ou 20 mm.
 */
export function snapToAllowedThickness(t) {
  if (t <= 7) return 6;
  if (t <= 14) return 10;
  return 20;
}

/**
 * Vérifie si une pièce de dimensions à plat (w, h) rentre dans une plaque 300 × 200 mm.
 */
export function fitsInPlate(w, h, plateW = PLATE_WIDTH, plateH = PLATE_HEIGHT) {
  const maxD = Math.max(w, h);
  const minD = Math.min(w, h);
  return maxD <= plateW && minD <= plateH;
}

/**
 * Parcourt toutes les pièces du modèle :
 * 1. Recalcule proprement les cotes de coupe (cutW, cutH, thickness) en respectant cutPlane (notamment pour les triangles).
 * 2. Normalise les épaisseurs sur {6, 10, 20} mm (ex: murets d'échiffre -> 20 mm).
 * 3. Redécoupe automatiquement en 2 (ou N) morceaux toute pièce dont les dimensions à plat
 *    dépassent le format d'une plaque 300 × 200 mm, en préservant l'assemblage 3D.
 */
export function enforcePlateConstraintsAndSplit(pieces) {
  const result = [];

  // Ajuster d'abord les murets d'échiffre s'ils étaient à 25 mm pour les passer en 20 mm (et ajuster la largeur de l'escalier #25)
  const leftCheek = pieces.find((p) => p.name.includes('Muret d’Échiffre Gauche'));
  const rightCheek = pieces.find((p) => p.name.includes('Muret d’Échiffre Droit'));
  const stairPlug = pieces.find((p) => p.adventNum === 25 || p.shape === 'stairs');
  const podiumBaseParts = pieces.filter((p) => p.name.includes('Semelle basse du Podium'));
  const podiumTopParts = pieces.filter((p) => p.name.includes('Plancher haut Podium'));
  const podiumBase = podiumBaseParts[0];

  // Migration unique de l'ancien escalier (tranches de 20 mm / arrondi 80 mm / collision stylobate)
  // vers un escalier en tranches égales de 10 mm posé au sol (y = 0) sous le stylobate.
  if (stairPlug && stairPlug.shape === 'stairs' && stairPlug.plugDepth === undefined) {
    const baseTopY = podiumBase ? Math.round(podiumBase.y + podiumBase.dy) : 10;
    const topBottomY = podiumTopParts.length > 0 ? Math.round(podiumTopParts[0].y) : 60;
    const podiumTotalH = podiumTopParts.length > 0
      ? Math.round(podiumTopParts[0].y + podiumTopParts[0].dy)
      : topBottomY + 10;
    const podiumFrontX = podiumBaseParts.length > 0
      ? Math.round(Math.max(...podiumBaseParts.map((b) => b.x + b.dx)))
      : (leftCheek ? Math.round(leftCheek.x) : Math.round(stairPlug.x + 10));
    const cheekDx = leftCheek ? Math.round(leftCheek.dx) : Math.max(20, Math.round(stairPlug.dx - 10));
    const plugD = 10;

    stairPlug.thickness = 10;
    stairPlug.y = 0;
    stairPlug.dy = Math.max(20, topBottomY);
    stairPlug.x = podiumFrontX - plugD;
    stairPlug.dx = cheekDx + plugD;
    stairPlug.plugDepth = plugD;
    stairPlug.baseStopH = baseTopY;
    stairPlug._migratedStairsV2 = true;
    const spec = computeStairLayers(stairPlug);
    stairPlug.notes = `Escalier amovible en ${spec.numLayers} tranches de ${spec.stepH} mm empilées à plat (marches égales de ${spec.stepH} mm jusqu'au podium à ${podiumTotalH} mm ; tranche 1 au sol en butée contre la semelle, tranches 2 à ${spec.numLayers} encastrées de ${spec.plugDepth} mm dans la Case #25)`;
    recomputeCutDimensions(stairPlug);
  } else if (stairPlug && stairPlug.dy < 40) {
    stairPlug.dy = 60;
  }

  if (leftCheek && rightCheek && leftCheek.dz !== 20) {
    const podiumW = podiumBase ? podiumBase.dz : (rightCheek.z + rightCheek.dz);
    leftCheek.dz = 20;
    leftCheek.thickness = 20;
    recomputeCutDimensions(leftCheek);

    rightCheek.dz = 20;
    rightCheek.z = podiumW - 20;
    rightCheek.thickness = 20;
    recomputeCutDimensions(rightCheek);

    if (stairPlug) {
      stairPlug.z = 20;
      stairPlug.dz = podiumW - 40;
      recomputeCutDimensions(stairPlug);
    }
  }

  for (const p of pieces) {
    if (p.material === 'plastic' || p.shape === 'cylinder_y') {
      result.push(p);
      continue;
    }

    // Si l'utilisateur avait modifié p.thickness manuellement (ex: 20 mm dans l'inspecteur)
    // sans que l'axe d'épaisseur géométrique n'ait suivi, synchroniser l'axe avant recomputeCutDimensions.
    if (p.shape !== 'stairs' && p.shape !== 'roof_slope') {
      const tProp = getThicknessProp(p);
      const declaredT = Number(p.thickness);
      const geomT = Math.round(p[tProp]);
      if (ALLOWED_THICKNESSES.includes(declaredT) && declaredT !== geomT && geomT <= 30) {
        p[tProp] = declaredT;
      }
    }

    recomputeCutDimensions(p);

    // Normaliser l'épaisseur sur 6, 10 ou 20 mm
    const targetT = snapToAllowedThickness(p.thickness || 10);
    if (p.thickness !== targetT) {
      if (p.shape !== 'stairs' && p.shape !== 'roof_slope') {
        const tProp = getThicknessProp(p);
        p[tProp] = targetT;
      }
      p.thickness = targetT;
      recomputeCutDimensions(p);
    }

    // Si la pièce rentre déjà dans 300 × 200 mm, on la garde telle quelle
    if (fitsInPlate(p.cutW, p.cutH)) {
      result.push(p);
      continue;
    }

    // Sinon, il faut redécouper la pièce en sous-morceaux qui rentrent chacun dans 300 × 200 mm
    const subPieces = splitSingleOversizedPiece(p);
    result.push(...subPieces);
  }

  return result;
}

/**
 * Découpe une pièce trop grande (ex: Semelle 380×210, Plafond 355×210, Flanc Podium 380×50, Toit 355×119)
 * en morceaux égaux (Partie 1/2, Partie 2/2...) qui rentrent chacun dans 300 × 200 mm.
 */
function splitSingleOversizedPiece(p) {
  const baseName = p.name.replace(/\s*\(Partie\s+\d+\/\d+\)/gi, '').trim();
  const savedNums = Array.isArray(p._savedPartNums) ? p._savedPartNums : null;

  const assignClonePieceNum = (clone, idx) => {
    delete clone._savedPartNums;
    if (savedNums && Number.isInteger(savedNums[idx])) {
      clone.pieceNum = savedNums[idx];
    } else if (idx > 0) {
      delete clone.pieceNum; // Recevra le prochain numéro incrémenté (sans renuméroter les autres)
    }
  };

  // Cas 1 : Pan de toit incliné ('roof_slope') -> la pente est sur ZY (cutH), la longueur est sur X (dx = cutW)
  if (p.shape === 'roof_slope') {
    const slopeLen = Math.round(Math.hypot(p.dz, p.dy));
    const maxAllowedDx = slopeLen <= PLATE_HEIGHT ? PLATE_WIDTH : PLATE_HEIGHT;
    const numPartsX = Math.max(2, Math.ceil(p.dx / maxAllowedDx));
    const parts = [];
    let curX = p.x;
    let remDx = p.dx;

    for (let i = 0; i < numPartsX; i++) {
      const partDx = i === numPartsX - 1 ? remDx : Math.round(p.dx / numPartsX);
      const clone = {
        ...p,
        id: i === 0 ? p.id : nextPieceId('split'),
        name: `${baseName} (Partie ${i + 1}/${numPartsX})`,
        x: curX,
        dx: partDx,
      };
      assignClonePieceNum(clone, i);
      recomputeCutDimensions(clone);
      clone.notes = `Morceau ${i + 1}/${numPartsX} (redécoupé pour tenir dans une plaque ${PLATE_WIDTH}×${PLATE_HEIGHT} mm)`;
      parts.push(clone);
      curX += partDx;
      remDx -= partDx;
    }
    return parts;
  }

  // Cas 2 : Triangle ('prism_z') si sa base dépasse 300 mm (ou > 200 mm quand hauteur > 200 mm)
  if (p.shape === 'prism_z') {
    const plane = p.cutPlane || 'ZY';
    const baseAxis = plane === 'ZY' ? 'z' : 'x';
    const baseDProp = plane === 'ZY' ? 'dz' : 'dx';
    const heightLen = plane === 'XZ' ? p.dz : p.dy;
    const baseLen = p[baseDProp];

    const maxAllowedBase = heightLen <= PLATE_HEIGHT ? PLATE_WIDTH : PLATE_HEIGHT;
    const numParts = Math.max(2, Math.ceil(baseLen / maxAllowedBase));
    const parts = [];
    let curBase = p[baseAxis];
    let remBase = baseLen;
    for (let i = 0; i < numParts; i++) {
      const partBase = i === numParts - 1 ? remBase : Math.round(baseLen / numParts);
      const clone = {
        ...p,
        id: i === 0 ? p.id : nextPieceId('split'),
        name: `${baseName} (Partie ${i + 1}/${numParts})`,
      };
      assignClonePieceNum(clone, i);
      clone[baseAxis] = curBase;
      clone[baseDProp] = partBase;
      recomputeCutDimensions(clone);
      parts.push(clone);
      curBase += partBase;
      remBase -= partBase;
    }
    return parts;
  }

  // Cas 3 : Plaque rectangulaire ('box' ou 'stairs')
  const tProp = getThicknessProp(p);
  const flatAxes = [
    { axis: 'x', dProp: 'dx', len: p.dx },
    { axis: 'y', dProp: 'dy', len: p.dy },
    { axis: 'z', dProp: 'dz', len: p.dz },
  ].filter((a) => a.dProp !== tProp).sort((a, b) => a.len - b.len);

  const midAxis = flatAxes[0];
  const longAxis = flatAxes[1];

  let splitsLong = 1;
  let splitsMid = 1;

  if (midAxis.len <= PLATE_HEIGHT) {
    splitsLong = Math.ceil(longAxis.len / PLATE_WIDTH);
  } else if (midAxis.len <= PLATE_WIDTH) {
    splitsLong = Math.ceil(longAxis.len / PLATE_HEIGHT);
  } else {
    splitsMid = Math.ceil(midAxis.len / PLATE_HEIGHT);
    splitsLong = Math.ceil(longAxis.len / PLATE_WIDTH);
  }

  const totalParts = splitsLong * splitsMid;
  const parts = [];
  let partIndex = 1;

  let curMid = p[midAxis.axis];
  let remMid = midAxis.len;

  for (let im = 0; im < splitsMid; im++) {
    const stepMid = im === splitsMid - 1 ? remMid : Math.round(midAxis.len / splitsMid);
    let curLong = p[longAxis.axis];
    let remLong = longAxis.len;

    for (let il = 0; il < splitsLong; il++) {
      const stepLong = il === splitsLong - 1 ? remLong : Math.round(longAxis.len / splitsLong);
      const clone = {
        ...p,
        id: partIndex === 1 ? p.id : nextPieceId('split'),
        name: totalParts > 1 ? `${baseName} (Partie ${partIndex}/${totalParts})` : baseName,
      };
      assignClonePieceNum(clone, partIndex - 1);
      clone[longAxis.axis] = curLong;
      clone[longAxis.dProp] = stepLong;
      clone[midAxis.axis] = curMid;
      clone[midAxis.dProp] = stepMid;

      recomputeCutDimensions(clone);
      clone.notes = `Morceau ${partIndex}/${totalParts} (${clone.cutW} × ${clone.cutH} mm — adapté aux plaques ${PLATE_WIDTH}×${PLATE_HEIGHT} mm)`;
      parts.push(clone);

      curLong += stepLong;
      remLong -= stepLong;
      partIndex++;
    }
    curMid += stepMid;
    remMid -= stepMid;
  }

  return parts;
}

/**
 * Source de vérité unique pour la Liste de Découpe ET le Calepinage 2D :
 * Convertit l'ensemble des pièces du modèle en morceaux élémentaires à découper,
 * classés dans les 3 épaisseurs disponibles (6, 10, 20 mm) + pièces fournies (plastique).
 */
export function expandPiecesToCutItems(pieces) {
  const byThickness = {
    6: [],
    10: [],
    20: []
  };
  const plastic = [];

  for (const p of pieces) {
    if (p.hidden) continue;

    if (p.material === 'plastic' || p.shape === 'cylinder_y') {
      plastic.push({
        id: p.id,
        pieceNum: p.pieceNum,
        name: p.name,
        shape: p.shape,
        dimsText: `Base ${Math.round(p.dx)}×${Math.round(p.dz)} × H ${Math.round(p.dy)}`,
        material: p.material || 'cylinder'
      });
      continue;
    }

    // S'assurer que cutW, cutH et thickness sont à jour (notamment pour les triangles prism_z)
    const rawT = Number(p.thickness) || 10;
    const t = snapToAllowedThickness(rawT);

    // Bloc d'escalier #25 : décomposé en tranches horizontales empilées identiques au plan 2D/3D
    if (p.shape === 'stairs') {
      const spec = computeStairLayers(p);
      const sliceT = spec.stepH;
      for (const layer of spec.layers) {
        const w = Math.max(Math.round(layer.dz), Math.round(layer.dx));
        const h = Math.min(Math.round(layer.dz), Math.round(layer.dx));
        const role = layer.index === 0 && !layer.hasPlug
          ? 'bas, au sol, butée semelle'
          : layer.index === spec.numLayers - 1
            ? (layer.hasPlug ? `haut + bouchon ${layer.plugDepth} mm` : 'haut')
            : (layer.hasPlug ? `marche ${layer.index + 1} + bouchon ${layer.plugDepth} mm` : `marche ${layer.index + 1}`);
        byThickness[sliceT].push({
          id: p.id,
          pieceNum: p.pieceNum,
          sliceLabel: layer.label,
          name: `Escalier #25 — Tranche ${layer.label} (${role})`,
          shape: 'stairs_slice',
          kind: 'rect',
          w,
          h,
          areaMm2: w * h,
          group: p.group,
          adventNum: p.adventNum,
          snappedFrom: null
        });
      }
      continue;
    }

    // Pièce triangulaire (fronton, pignon ou triangle personnalisé)
    if (p.shape === 'prism_z') {
      const triBase = Math.max(2, Math.round(p.cutW));
      const triHeight = Math.max(2, Math.round(p.cutH));
      byThickness[t].push({
        id: p.id,
        pieceNum: p.pieceNum,
        name: p.name,
        shape: 'prism_z',
        kind: 'triangle',
        triBase,
        triHeight,
        w: triBase,
        h: triHeight,
        areaMm2: (triBase * triHeight) / 2,
        group: p.group,
        adventNum: p.adventNum,
        snappedFrom: rawT !== t ? rawT : null
      });
      continue;
    }

    // Plaque rectangulaire ou versant de toit incliné
    const w = Math.max(2, Math.round(Math.max(p.cutW, p.cutH)));
    const h = Math.max(2, Math.round(Math.min(p.cutW, p.cutH)));
    byThickness[t].push({
      id: p.id,
      pieceNum: p.pieceNum,
      name: p.name,
      shape: p.shape,
      kind: 'rect',
      w,
      h,
      areaMm2: w * h,
      group: p.group,
      adventNum: p.adventNum,
      snappedFrom: rawT !== t ? rawT : null
    });
  }

  return { byThickness, plastic };
}

/**
 * Regroupe par paires tête-bêche (emboîtement en parallélogramme de 1.5×Base + jeu de coupe × Hauteur)
 * les triangles isocèles identiques lorsque la paire tient dans une plaque 300 × 200 mm.
 */
function buildPackingUnits(items, plateW, plateH, kerf = 0) {
  const units = [];
  const trianglesByDim = new Map();

  for (const it of items) {
    if (it.kind === 'triangle') {
      const key = `${it.triBase}x${it.triHeight}`;
      if (!trianglesByDim.has(key)) trianglesByDim.set(key, []);
      trianglesByDim.get(key).push(it);
    } else {
      units.push(it);
    }
  }

  for (const list of trianglesByDim.values()) {
    let i = 0;
    while (i < list.length) {
      const triA = list[i];
      // Jeu horizontal nécessaire pour ménager un trait de coupe perpendiculaire de `kerf` mm sur l'arête oblique
      const triGapX = kerf > 0
        ? Math.ceil((kerf * Math.hypot(triA.triBase / 2, triA.triHeight)) / triA.triHeight)
        : 0;
      const pairW = Math.ceil(triA.triBase * 1.5 + triGapX);
      const pairH = triA.triHeight;

      if (i + 1 < list.length && fitsInPlate(pairW, pairH, plateW, plateH)) {
        const triB = list[i + 1];
        units.push({
          id: triA.id,
          secondId: triB.id,
          name: `${triA.name} + ${triB.name}`,
          firstItem: triA,
          secondItem: triB,
          shape: 'prism_z',
          kind: 'triangle_pair',
          triBase: triA.triBase,
          triHeight: triA.triHeight,
          triGapX,
          w: pairW,
          h: pairH,
          pieceCount: 2,
          areaMm2: triA.areaMm2 + triB.areaMm2,
          group: triA.group
        });
        i += 2;
      } else {
        units.push({
          ...triA,
          pieceCount: 1
        });
        i += 1;
      }
    }
  }

  return units;
}

/**
 * Calcule le calepinage optimal (2D Bin-Packing MaxRects) de toutes les pièces
 * dans des plaques de 300 × 200 mm pour les épaisseurs 6 mm, 10 mm et 20 mm,
 * en réservant exactement `kerf` mm de trait de coupe entre deux pièces adjacentes
 * (sans perte inutile sur les bords extérieurs de la plaque).
 */
export function packPiecesIntoPlates(pieces, plateW = PLATE_WIDTH, plateH = PLATE_HEIGHT, kerfOrOpts = DEFAULT_KERF) {
  const kerf = typeof kerfOrOpts === 'object' && kerfOrOpts !== null
    ? Math.max(0, Number(kerfOrOpts.kerf ?? DEFAULT_KERF))
    : Math.max(0, Number(kerfOrOpts ?? DEFAULT_KERF));
  const excludeIds = typeof kerfOrOpts === 'object' && kerfOrOpts?.excludeIds instanceof Set
    ? kerfOrOpts.excludeIds
    : null;

  const filteredPieces = excludeIds
    ? pieces.filter((p) => !excludeIds.has(p.id))
    : pieces;

  const { byThickness, plastic } = expandPiecesToCutItems(filteredPieces);

  const summary = { _plastic: plastic, _byThickness: byThickness, _kerf: kerf };
  for (const t of ALLOWED_THICKNESSES) {
    const items = byThickness[t];
    const units = buildPackingUnits(items, plateW, plateH, kerf);
    const plates = packMaxRects(units, plateW, plateH, kerf);
    const totalPlateArea = plates.length * plateW * plateH;
    const usedArea = items.reduce((acc, it) => acc + it.areaMm2, 0);
    const placedPieceCount = plates.reduce(
      (acc, bin) => acc + bin.placedItems.reduce((s, it) => s + (it.pieceCount || 1), 0),
      0
    );
    const hasOversized = plates.some((bin) => bin.placedItems.some((it) => it.oversized));

    summary[t] = {
      thickness: t,
      kerf,
      plateCount: plates.length,
      pieceCount: items.length,
      placedPieceCount,
      hasOversized,
      usedAreaMm2: usedArea,
      efficiency: totalPlateArea > 0 ? Math.min(100, Math.round((usedArea / totalPlateArea) * 100)) : 0,
      plates
    };
  }

  return summary;
}

/**
 * Algorithme MaxRects 2D Bin-Packing multi-heuristiques avec gestion exacte du trait de coupe (kerf).
 * Astuce exacte : on emballe des boîtes virtuelles (w + kerf) × (h + kerf) dans une plaque virtuelle
 * (binW + kerf) × (binH + kerf). Ainsi, il y a toujours au moins `kerf` mm entre deux pièces voisines,
 * et 0 mm gaspillé contre les 4 bords extérieurs de la plaque 300 × 200 mm.
 */
function packMaxRects(units, binW, binH, kerf = 0) {
  if (units.length === 0) return [];

  const sorters = [
    (a, b) => (b.w * b.h - a.w * a.h) || (Math.max(b.w, b.h) - Math.max(a.w, a.h)),
    (a, b) => (Math.max(b.w, b.h) - Math.max(a.w, a.h)) || (b.w * b.h - a.w * a.h),
    (a, b) => (Math.min(b.w, b.h) - Math.min(a.w, a.h)) || (b.w * b.h - a.w * a.h),
    (a, b) => ((b.w + b.h) - (a.w + a.h)) || (b.w * b.h - a.w * a.h),
  ];
  const heuristics = ['BSSF', 'BLSF', 'BAF', 'BL'];

  let bestBins = null;
  let bestScore = Infinity;

  for (const sortFn of sorters) {
    const sorted = [...units].sort(sortFn);
    for (const heuristic of heuristics) {
      const bins = runSingleMaxRectsPass(sorted, binW, binH, heuristic, kerf);
      const lastBin = bins[bins.length - 1];
      const lastUsed = lastBin ? lastBin.placedItems.reduce((s, it) => s + it.placedW * it.placedH, 0) : 0;
      const score = bins.length * (binW * binH * 2) + lastUsed;
      if (score < bestScore) {
        bestScore = score;
        bestBins = bins;
      }
    }
  }

  return bestBins || [];
}

function runSingleMaxRectsPass(sorted, binW, binH, heuristic, kerf = 0) {
  const bins = [];
  const vBinW = binW + kerf;
  const vBinH = binH + kerf;

  for (const item of sorted) {
    const vw = item.w + kerf;
    const vh = item.h + kerf;

    let bestBin = null;
    let bestPos = null;
    let bestRank1 = Infinity;
    let bestRank2 = Infinity;

    for (const bin of bins) {
      const candidate = findPositionForNewNode(bin.freeRects, vw, vh, heuristic);
      if (candidate && (candidate.rank1 < bestRank1 || (candidate.rank1 === bestRank1 && candidate.rank2 < bestRank2))) {
        bestBin = bin;
        bestPos = candidate;
        bestRank1 = candidate.rank1;
        bestRank2 = candidate.rank2;
      }
    }

    if (bestBin && bestPos) {
      placeRect(bestBin, item, bestPos, kerf);
    } else {
      const newBin = {
        index: bins.length + 1,
        w: binW,
        h: binH,
        kerf,
        freeRects: [{ x: 0, y: 0, w: vBinW, h: vBinH }],
        placedItems: []
      };
      const pos = findPositionForNewNode(newBin.freeRects, vw, vh, heuristic);
      if (pos) {
        placeRect(newBin, item, pos, kerf);
      } else {
        newBin.placedItems.push({
          ...item,
          x: 0,
          y: 0,
          placedW: Math.min(binW, item.w),
          placedH: Math.min(binH, item.h),
          rotated: false,
          oversized: true
        });
        newBin.freeRects = [];
      }
      bins.push(newBin);
    }
  }

  return bins;
}

function findPositionForNewNode(freeRects, w, h, heuristic) {
  let bestNode = null;
  let bestRank1 = Infinity;
  let bestRank2 = Infinity;

  const evalFit = (r, pw, ph, rotated) => {
    const remW = r.w - pw;
    const remH = r.h - ph;
    let rank1, rank2;
    if (heuristic === 'BSSF') {
      rank1 = Math.min(remW, remH);
      rank2 = Math.max(remW, remH);
    } else if (heuristic === 'BLSF') {
      rank1 = Math.max(remW, remH);
      rank2 = Math.min(remW, remH);
    } else if (heuristic === 'BL') {
      rank1 = r.y + ph;
      rank2 = r.x;
    } else {
      rank1 = r.w * r.h - pw * ph;
      rank2 = Math.min(remW, remH);
    }
    if (rank1 < bestRank1 || (rank1 === bestRank1 && rank2 < bestRank2)) {
      bestNode = { x: r.x, y: r.y, w: pw, h: ph, rotated, rank1, rank2 };
      bestRank1 = rank1;
      bestRank2 = rank2;
    }
  };

  for (const r of freeRects) {
    if (r.w >= w && r.h >= h) evalFit(r, w, h, false);
    if (w !== h && r.w >= h && r.h >= w) evalFit(r, h, w, true);
  }

  return bestNode;
}

function placeRect(bin, item, pos, kerf = 0) {
  // Stocker les dimensions PHYSIQUES exactes (pos.w - kerf, pos.h - kerf),
  // tout en consommant l'espace virtuel (pos.w, pos.h) dans bin.freeRects pour garantir le trait de coupe.
  bin.placedItems.push({
    ...item,
    x: pos.x,
    y: pos.y,
    placedW: pos.w - kerf,
    placedH: pos.h - kerf,
    rotated: pos.rotated
  });

  const newFree = [];
  for (const free of bin.freeRects) {
    if (
      pos.x >= free.x + free.w ||
      pos.x + pos.w <= free.x ||
      pos.y >= free.y + free.h ||
      pos.y + pos.h <= free.y
    ) {
      newFree.push(free);
      continue;
    }

    if (pos.x > free.x && pos.x < free.x + free.w) {
      newFree.push({ x: free.x, y: free.y, w: pos.x - free.x, h: free.h });
    }
    if (pos.x + pos.w < free.x + free.w) {
      newFree.push({ x: pos.x + pos.w, y: free.y, w: free.x + free.w - (pos.x + pos.w), h: free.h });
    }
    if (pos.y > free.y && pos.y < free.y + free.h) {
      newFree.push({ x: free.x, y: free.y, w: free.w, h: pos.y - free.y });
    }
    if (pos.y + pos.h < free.y + free.h) {
      newFree.push({ x: free.x, y: pos.y + pos.h, w: free.w, h: free.y + free.h - (pos.y + pos.h) });
    }
  }

  bin.freeRects = pruneFreeList(newFree);
}

function pruneFreeList(rects) {
  const out = [];
  for (let i = 0; i < rects.length; i++) {
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      if (
        rects[i].x >= rects[j].x &&
        rects[i].y >= rects[j].y &&
        rects[i].x + rects[i].w <= rects[j].x + rects[j].w &&
        rects[i].y + rects[i].h <= rects[j].y + rects[j].h
      ) {
        if (
          rects[i].x === rects[j].x &&
          rects[i].y === rects[j].y &&
          rects[i].w === rects[j].w &&
          rects[i].h === rects[j].h &&
          i < j
        ) {
          continue;
        }
        contained = true;
        break;
      }
    }
    if (!contained && rects[i].w >= 4 && rects[i].h >= 4) {
      out.push(rects[i]);
    }
  }
  return out;
}
