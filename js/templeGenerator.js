// Générateur paramétrique du Temple Romain - Calendrier de l'Avent (24 cases latérales + 25e case podium)
// Système de coordonnées (en millimètres) :
// X : Longueur (0 = Arrière du temple -> X+ = Avant / Escalier)
// Y : Hauteur  (0 = Sol / Base du podium -> Y+ = Sommet du fronton)
// Z : Largeur  (0 = Flanc Gauche -> Z+ = Flanc Droit)

export const THICKNESS_COLORS = {
  6: '#38bdf8',   // 6 mm : Bleu ciel (cloisons fines, étagères)
  5: '#38bdf8',   // alias rétrocompatibilité
  10: '#f59e0b',  // 10 mm : Ambre (murs porteurs, planchers, bouchons)
  15: '#a855f7',  // 15 mm : Violet
  20: '#f43f5e',  // 20 mm : Corail (gros blocs, marches)
  30: '#10b981',  // 30 mm : Émeraude / Colonnes plastique 30x30
};

export const GROUP_META = {
  podium: { label: 'Podium & Case #25', color: '#d6d3d1', badge: '#78716c' },
  cella: { label: 'Murs Cella (Structure)', color: '#e7e5e4', badge: '#a8a29e' },
  grid: { label: 'Casier 24 Cases (Cloisons)', color: '#bae6fd', badge: '#0284c7' },
  plugs: { label: 'Bouchons #1 à #25', color: '#fde68a', badge: '#d97706' },
  pronaos: { label: 'Colonnes Plastique (30×30×170)', color: '#f8fafc', badge: '#475569' },
  roof: { label: 'Plafond, Fronton & Toit', color: '#fca5a5', badge: '#dc2626' },
  custom: { label: 'Pièces Personnalisées', color: '#c4b5fd', badge: '#7c3aed' },
};

export const DEFAULT_TEMPLE_PARAMS = {
  cols: 4,            // Nombre de cases par ligne sur un flanc (4 x 3 = 12 par côté)
  rows: 3,            // Nombre d'étages de cases
  caseL: 60,          // Largeur d'une case (axe X, en mm)
  caseH: 53,          // Hauteur nominale d'une case (ajustée auto sur les 170 mm des colonnes)
  caseD: 90,          // Profondeur utile d'une case (axe Z, en mm) — 90 mm sans cloison centrale, 85 mm avec cloison centrale
  colH: 170,          // Hauteur figée des colonnes en plastique (170 mm) -> impose la hauteur de la cella
  colDiam: 30,        // Emprise de la base carrée des colonnes en plastique (30 x 30 mm)
  tStruct: 10,        // Épaisseur structurelle (murs, planchers, cloison centrale) en mm
  tGrid: 6,           // Épaisseur des cloisons internes du casier en mm (6 mm)
  tPlug: 10,          // Épaisseur des bouchons de cases en mm
  podiumH: 50,        // Hauteur utile intérieure du podium (case #25) en mm
  podiumMargin: 15,   // Débord latéral et arrière du podium par rapport à la cella en mm
  pronaosL: 90,       // Profondeur du porche avant (pronaos) en mm (adaptée aux bases 30x30)
  stairL: 55,         // Longueur de l'escalier avant (bouchon case #25) en mm
  frontCols: 4,       // Nombre de colonnes en façade
  pedimentH: 55,      // Hauteur du fronton triangulaire en mm
  mergedBays: true,   // Trames gauche/droite fusionnées sur toute la largeur (sans cloison centrale)
};

let idCounter = 1;
export function nextPieceId(prefix = 'p') {
  return `${prefix}_${idCounter++}`;
}

/**
 * Formate le numéro persistant d'une pièce (ex: P12).
 */
export function formatPieceNum(piece) {
  return piece && Number.isInteger(piece.pieceNum) && piece.pieceNum > 0
    ? `P${piece.pieceNum}`
    : '';
}

/**
 * Garantit que chaque pièce possède un numéro unique persistant (pieceNum = 1, 2, 3...).
 * Les pièces existantes ne sont JAMAIS renumérotées ; toute nouvelle pièce incrémente nextNum.
 */
export function ensurePieceNumbers(pieces, currentNextNum = 1) {
  let maxExisting = 0;
  for (const p of pieces) {
    if (Number.isInteger(p.pieceNum) && p.pieceNum > maxExisting) {
      maxExisting = p.pieceNum;
    }
  }
  let nextNum = Math.max(Number(currentNextNum) || 1, maxExisting + 1);
  const seen = new Set();

  for (const p of pieces) {
    if (Number.isInteger(p.pieceNum) && p.pieceNum > 0 && !seen.has(p.pieceNum)) {
      seen.add(p.pieceNum);
    } else {
      p.pieceNum = nextNum++;
      seen.add(p.pieceNum);
    }
  }

  return nextNum;
}

/**
 * Génère toutes les pièces du temple en calant la hauteur de la Cella (et des 3 étages de cases)
 * sur la hauteur exacte des colonnes en plastique (colH = 170 mm) et leurs bases de 30x30 mm.
 */
export function generateRomanTemple(params = DEFAULT_TEMPLE_PARAMS) {
  idCounter = 1;
  const p = { ...DEFAULT_TEMPLE_PARAMS, ...params };
  const pieces = [];

  const {
    cols, rows, caseL, caseD,
    colH, colDiam,
    tStruct, tGrid, tPlug,
    podiumH, podiumMargin, pronaosL, stairL,
    frontCols, pedimentH,
    mergedBays = true
  } = p;

  // --- ALIGNEMENT SUR LES COLONNES PLASTIQUE (H = 170 mm, Base = 30×30 mm) ---
  // La hauteur totale de la cella DOIT être strictement égale à colH (170 mm)
  // pour que l'architrave/plafond repose parfaitement à plat sur la cella et sur les colonnes.
  const cellaH = colH;
  const totalShelvesH = (rows - 1) * tGrid;
  const availableCasesH = Math.max(rows * 10, cellaH - totalShelvesH);

  // Répartition entière au millimètre près de la hauteur de chaque étage de cases
  // Exemple pour 170 mm avec 2 étagères de 5 mm (reste 160 mm pour 3 étages) : [53, 54, 53] mm -> somme = 170 mm exact !
  const baseRowH = Math.floor(availableCasesH / rows);
  const remainderH = availableCasesH - baseRowH * rows;
  const rowHeights = [];
  const rowYOffsets = [];
  let accY = 0;
  for (let r = 0; r < rows; r++) {
    // Distribuer le reste (ex: +1 mm) sur l'étage du milieu ou du haut
    const extra = r < remainderH ? 1 : 0;
    const h = baseRowH + extra;
    rowYOffsets.push(accY);
    rowHeights.push(h);
    accY += h + tGrid;
  }

  // --- CALCULS GÉOMÉTRIQUES GLOBAUX ---
  const innerCellaL = cols * caseL + (cols - 1) * tGrid;
  const cellaL = tStruct + innerCellaL + tStruct;

  // Largeur de la cella (axe Z) :
  // - en mode trames fusionnées (sans cloison centrale) : 2 × caseD (ex: 2 × 90 = 180 mm)
  // - en mode 2 trames séparées (avec cloison centrale tStruct) : caseD + tStruct + caseD (ex: 85 + 10 + 85 = 180 mm)
  const cellaW = mergedBays ? caseD * 2 : caseD * 2 + tStruct;

  // Podium : déborde de podiumMargin à l'arrière, à gauche et à droite, et inclut le pronaos à l'avant
  const podiumL = podiumMargin + cellaL + pronaosL;
  const podiumW = cellaW + podiumMargin * 2;
  const podiumTotalH = tStruct + podiumH + tStruct;

  const cellaStartX = podiumMargin;
  const cellaStartZ = podiumMargin;
  const cellaStartY = podiumTotalH;

  // ============================================================================
  // 1. PODIUM & CASE #25 (SOUBASSEMENT + ESCALIER AMOVIBLE)
  // ============================================================================
  pieces.push({
    id: nextPieceId('pod'),
    name: 'Semelle basse du Podium',
    group: 'podium',
    shape: 'box',
    x: 0,
    y: 0,
    z: 0,
    dx: podiumL,
    dy: tStruct,
    dz: podiumW,
    thickness: tStruct,
    cutPlane: 'XZ',
    cutW: podiumL,
    cutH: podiumW,
    notes: 'Base générale posée sur la table'
  });

  pieces.push({
    id: nextPieceId('pod'),
    name: 'Plancher haut Podium (Stylobate)',
    group: 'podium',
    shape: 'box',
    x: 0,
    y: tStruct + podiumH,
    z: 0,
    dx: podiumL,
    dy: tStruct,
    dz: podiumW,
    thickness: tStruct,
    cutPlane: 'XZ',
    cutW: podiumL,
    cutH: podiumW,
    notes: 'Ferme le dessus de la 25e case et porte la cella + les colonnes 30×30 mm'
  });

  pieces.push({
    id: nextPieceId('pod'),
    name: 'Flanc Gauche du Podium',
    group: 'podium',
    shape: 'box',
    x: 0,
    y: tStruct,
    z: 0,
    dx: podiumL,
    dy: podiumH,
    dz: tStruct,
    thickness: tStruct,
    cutPlane: 'XY',
    cutW: podiumL,
    cutH: podiumH,
    notes: 'Collé entre la semelle et le plancher haut (côté gauche)'
  });

  pieces.push({
    id: nextPieceId('pod'),
    name: 'Flanc Droit du Podium',
    group: 'podium',
    shape: 'box',
    x: 0,
    y: tStruct,
    z: podiumW - tStruct,
    dx: podiumL,
    dy: podiumH,
    dz: tStruct,
    thickness: tStruct,
    cutPlane: 'XY',
    cutW: podiumL,
    cutH: podiumH,
    notes: 'Collé entre la semelle et le plancher haut (côté droit)'
  });

  const podiumInnerW = podiumW - 2 * tStruct;
  pieces.push({
    id: nextPieceId('pod'),
    name: 'Mur Arrière du Podium',
    group: 'podium',
    shape: 'box',
    x: 0,
    y: tStruct,
    z: tStruct,
    dx: tStruct,
    dy: podiumH,
    dz: podiumInnerW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: podiumInnerW,
    cutH: podiumH,
    notes: 'Encastré entre les deux flancs du podium à l’arrière'
  });

  const case25Depth = Math.min(140, podiumL - tStruct * 2);
  const case25BackX = podiumL - case25Depth - tStruct;
  pieces.push({
    id: nextPieceId('pod'),
    name: 'Cloison Fond Case #25 (Renfort Podium)',
    group: 'podium',
    shape: 'box',
    x: case25BackX,
    y: tStruct,
    z: tStruct,
    dx: tStruct,
    dy: podiumH,
    dz: podiumInnerW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: podiumInnerW,
    cutH: podiumH,
    notes: `Délimite la profondeur (${case25Depth} mm) de la grande case #25 et soutient le centre du temple`
  });

  const stairWallW = Math.max(tStruct, podiumMargin + tStruct);
  const stairOpeningW = podiumW - 2 * stairWallW;

  pieces.push({
    id: nextPieceId('pod'),
    name: 'Muret d’Échiffre Gauche (Cadre Escalier)',
    group: 'podium',
    shape: 'box',
    x: podiumL,
    y: 0,
    z: 0,
    dx: stairL,
    dy: podiumTotalH,
    dz: stairWallW,
    thickness: stairWallW,
    cutPlane: 'XY',
    cutW: stairL,
    cutH: podiumTotalH,
    notes: 'Flanc gauche encadrant l’escalier amovible'
  });

  pieces.push({
    id: nextPieceId('pod'),
    name: 'Muret d’Échiffre Droit (Cadre Escalier)',
    group: 'podium',
    shape: 'box',
    x: podiumL,
    y: 0,
    z: podiumW - stairWallW,
    dx: stairL,
    dy: podiumTotalH,
    dz: stairWallW,
    thickness: stairWallW,
    cutPlane: 'XY',
    cutW: stairL,
    cutH: podiumTotalH,
    notes: 'Flanc droit encadrant l’escalier amovible'
  });

  pieces.push({
    id: nextPieceId('plug25'),
    name: 'Case #25 — Escalier Frontal Amovible',
    group: 'plugs',
    shape: 'stairs',
    x: podiumL - tPlug,
    y: tStruct,
    z: stairWallW,
    dx: stairL + tPlug,
    dy: podiumH + tStruct,
    dz: stairOpeningW,
    thickness: 20,
    cutPlane: 'XZ',
    cutW: stairOpeningW,
    cutH: stairL + tPlug,
    adventNum: 25,
    notes: `Bloc d'escalier amovible qui ferme l'ouverture de la Case #25 (${stairOpeningW} × ${podiumH} mm)`
  });

  // ============================================================================
  // 2. STRUCTURE DE LA CELLA (CALÉE SUR LA HAUTEUR DES COLONNES = 170 MM)
  // ============================================================================
  pieces.push({
    id: nextPieceId('cel'),
    name: 'Mur Arrière de la Cella',
    group: 'cella',
    shape: 'box',
    x: cellaStartX,
    y: cellaStartY,
    z: cellaStartZ,
    dx: tStruct,
    dy: cellaH,
    dz: cellaW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: cellaW,
    cutH: cellaH,
    notes: `Mur porteur arrière (H = ${cellaH} mm, aligné pile sur les colonnes plastique)`
  });

  pieces.push({
    id: nextPieceId('cel'),
    name: 'Mur Avant de la Cella (Façade interne)',
    group: 'cella',
    shape: 'box',
    x: cellaStartX + tStruct + innerCellaL,
    y: cellaStartY,
    z: cellaStartZ,
    dx: tStruct,
    dy: cellaH,
    dz: cellaW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: cellaW,
    cutH: cellaH,
    notes: `Mur avant sous le porche (H = ${cellaH} mm, aligné sur les colonnes plastique)`
  });

  if (!mergedBays) {
    pieces.push({
      id: nextPieceId('cel'),
      name: 'Cloison Centrale Cella (Séparation Gauche/Droite)',
      group: 'cella',
      shape: 'box',
      x: cellaStartX + tStruct,
      y: cellaStartY,
      z: cellaStartZ + caseD,
      dx: innerCellaL,
      dy: cellaH,
      dz: tStruct,
      thickness: tStruct,
      cutPlane: 'XY',
      cutW: innerCellaL,
      cutH: cellaH,
      notes: `Épine dorsale centrale (${innerCellaL} × ${cellaH} mm)`
    });
  }

  // ============================================================================
  // 3. CASIER INTERNE DES 24 CASES (ÉTAGÈRES & CLOISONS VERTICALES)
  // ============================================================================
  const gridStartX = cellaStartX + tStruct;
  const leftStartZ = cellaStartZ;
  const rightStartZ = cellaStartZ + caseD + tStruct;

  // 3.1 Étagères Horizontales continues
  for (let r = 1; r < rows; r++) {
    const shelfY = cellaStartY + rowYOffsets[r] - tGrid;

    if (mergedBays) {
      pieces.push({
        id: nextPieceId('sh'),
        name: `Étagère Horizontale N°${r}`,
        group: 'grid',
        shape: 'box',
        x: gridStartX,
        y: shelfY,
        z: cellaStartZ,
        dx: innerCellaL,
        dy: tGrid,
        dz: cellaW,
        thickness: tGrid,
        cutPlane: 'XZ',
        cutW: innerCellaL,
        cutH: cellaW,
        notes: `Plaque horizontale traversante (${innerCellaL} × ${cellaW} mm — trames fusionnées sans cloison centrale)`
      });
    } else {
      pieces.push({
        id: nextPieceId('shL'),
        name: `Étagère Horizontale Gauche N°${r}`,
        group: 'grid',
        shape: 'box',
        x: gridStartX,
        y: shelfY,
        z: leftStartZ,
        dx: innerCellaL,
        dy: tGrid,
        dz: caseD,
        thickness: tGrid,
        cutPlane: 'XZ',
        cutW: innerCellaL,
        cutH: caseD,
        notes: 'Plaque horizontale continue séparant les étages de cases à gauche'
      });

      pieces.push({
        id: nextPieceId('shR'),
        name: `Étagère Horizontale Droite N°${r}`,
        group: 'grid',
        shape: 'box',
        x: gridStartX,
        y: shelfY,
        z: rightStartZ,
        dx: innerCellaL,
        dy: tGrid,
        dz: caseD,
        thickness: tGrid,
        cutPlane: 'XZ',
        cutW: innerCellaL,
        cutH: caseD,
        notes: 'Plaque horizontale continue séparant les étages de cases à droite'
      });
    }
  }

  // 3.2 Cloisons Verticales inter-cases
  for (let r = 0; r < rows; r++) {
    const rowY = cellaStartY + rowYOffsets[r];
    const rH = rowHeights[r];
    for (let c = 1; c < cols; c++) {
      const divX = gridStartX + c * caseL + (c - 1) * tGrid;

      if (mergedBays) {
        pieces.push({
          id: nextPieceId('div'),
          name: `Cloison Verticale Case (Étage ${r + 1}, Col ${c})`,
          group: 'grid',
          shape: 'box',
          x: divX,
          y: rowY,
          z: cellaStartZ,
          dx: tGrid,
          dy: rH,
          dz: cellaW,
          thickness: tGrid,
          cutPlane: 'ZY',
          cutW: cellaW,
          cutH: rH,
          notes: `Cloison verticale traversante étage ${r + 1} (${cellaW} × ${rH} mm — ép. ${tGrid} mm)`
        });
      } else {
        pieces.push({
          id: nextPieceId('divL'),
          name: `Cloison Verticale Case (G - Étage ${r + 1}, Col ${c})`,
          group: 'grid',
          shape: 'box',
          x: divX,
          y: rowY,
          z: leftStartZ,
          dx: tGrid,
          dy: rH,
          dz: caseD,
          thickness: tGrid,
          cutPlane: 'ZY',
          cutW: caseD,
          cutH: rH,
          notes: `Cloison verticale étage ${r + 1} (${caseD} × ${rH} mm)`
        });

        pieces.push({
          id: nextPieceId('divR'),
          name: `Cloison Verticale Case (D - Étage ${r + 1}, Col ${c})`,
          group: 'grid',
          shape: 'box',
          x: divX,
          y: rowY,
          z: rightStartZ,
          dx: tGrid,
          dy: rH,
          dz: caseD,
          thickness: tGrid,
          cutPlane: 'ZY',
          cutW: caseD,
          cutH: rH,
          notes: `Cloison verticale étage ${r + 1} (${caseD} × ${rH} mm)`
        });
      }
    }
  }

  // ============================================================================
  // 4. LES 24 BOUCHONS / FAÇADES DE CASES (1..12 À GAUCHE, 13..24 À DROITE)
  // ============================================================================
  let adventIndex = 1;
  for (let r = rows - 1; r >= 0; r--) {
    const rowY = cellaStartY + rowYOffsets[r];
    const rH = rowHeights[r];
    for (let c = 0; c < cols; c++) {
      const cellX = gridStartX + c * (caseL + tGrid);
      pieces.push({
        id: nextPieceId('plugL'),
        name: `Bouchon Case #${adventIndex} (Flanc Gauche)`,
        group: 'plugs',
        shape: 'box',
        x: cellX,
        y: rowY,
        z: leftStartZ,
        dx: caseL,
        dy: rH,
        dz: tPlug,
        thickness: tPlug,
        cutPlane: 'XY',
        cutW: caseL,
        cutH: rH,
        adventNum: adventIndex,
        plugSide: 'left',
        notes: `Façade/bouchon encastrable de la case N°${adventIndex} (${caseL} × ${rH} mm)`
      });
      adventIndex++;
    }
  }

  for (let r = rows - 1; r >= 0; r--) {
    const rowY = cellaStartY + rowYOffsets[r];
    const rH = rowHeights[r];
    for (let c = 0; c < cols; c++) {
      const cellX = gridStartX + c * (caseL + tGrid);
      pieces.push({
        id: nextPieceId('plugR'),
        name: `Bouchon Case #${adventIndex} (Flanc Droit)`,
        group: 'plugs',
        shape: 'box',
        x: cellX,
        y: rowY,
        z: cellaStartZ + cellaW - tPlug,
        dx: caseL,
        dy: rH,
        dz: tPlug,
        thickness: tPlug,
        cutPlane: 'XY',
        cutW: caseL,
        cutH: rH,
        adventNum: adventIndex,
        plugSide: 'right',
        notes: `Façade/bouchon encastrable de la case N°${adventIndex} (${caseL} × ${rH} mm)`
      });
      adventIndex++;
    }
  }

  // ============================================================================
  // 5. PRONAOS & COLONNES EN PLASTIQUE FIGÉES (Base 30×30 mm, Hauteur 170 mm)
  // ============================================================================
  const colFrontX = podiumL - podiumMargin - colDiam;
  const usableColSpanZ = cellaW - colDiam;
  const colCount = Math.max(2, frontCols);

  for (let i = 0; i < colCount; i++) {
    const ratio = colCount === 1 ? 0.5 : i / (colCount - 1);
    const colZ = Math.round(cellaStartZ + ratio * usableColSpanZ);
    pieces.push({
      id: nextPieceId('col'),
      name: `Colonne Plastique Frontale N°${i + 1}`,
      group: 'pronaos',
      shape: 'cylinder_y',
      material: 'plastic',
      x: colFrontX,
      y: cellaStartY,
      z: colZ,
      dx: colDiam,
      dy: colH,
      dz: colDiam,
      thickness: colDiam,
      cutPlane: 'CYL',
      cutW: colDiam,
      cutH: colH,
      notes: `Pièce plastique fournie — Base carrée ${colDiam}×${colDiam} mm, Hauteur ${colH} mm`
    });
  }

  // Deux colonnes latérales de retour du Pronaos (si l'espace entre le mur avant de la cella et la rangée avant >= 40 mm)
  const clearPronaosGap = colFrontX - (cellaStartX + cellaL);
  if (clearPronaosGap >= colDiam + 6) {
    const midPronaosX = Math.round(cellaStartX + cellaL + (clearPronaosGap - colDiam) / 2);
    pieces.push({
      id: nextPieceId('col'),
      name: 'Colonne Plastique Latérale (Gauche)',
      group: 'pronaos',
      shape: 'cylinder_y',
      material: 'plastic',
      x: midPronaosX,
      y: cellaStartY,
      z: cellaStartZ,
      dx: colDiam,
      dy: colH,
      dz: colDiam,
      thickness: colDiam,
      cutPlane: 'CYL',
      cutW: colDiam,
      cutH: colH,
      notes: `Pièce plastique fournie — Base carrée ${colDiam}×${colDiam} mm, Hauteur ${colH} mm`
    });

    pieces.push({
      id: nextPieceId('col'),
      name: 'Colonne Plastique Latérale (Droite)',
      group: 'pronaos',
      shape: 'cylinder_y',
      material: 'plastic',
      x: midPronaosX,
      y: cellaStartY,
      z: cellaStartZ + cellaW - colDiam,
      dx: colDiam,
      dy: colH,
      dz: colDiam,
      thickness: colDiam,
      cutPlane: 'CYL',
      cutW: colDiam,
      cutH: colH,
      notes: `Pièce plastique fournie — Base carrée ${colDiam}×${colDiam} mm, Hauteur ${colH} mm`
    });
  }

  // ============================================================================
  // 6. PLAFOND / ARCHITRAVE, FRONTONS TRIANGULAIRES & PANS DE TOIT
  // ============================================================================
  const roofBaseY = cellaStartY + cellaH;
  const roofL = cellaL + pronaosL;
  const roofW = podiumW;

  pieces.push({
    id: nextPieceId('roof'),
    name: 'Plafond & Architrave Supérieure',
    group: 'roof',
    shape: 'box',
    x: cellaStartX,
    y: roofBaseY,
    z: 0,
    dx: roofL,
    dy: tStruct,
    dz: roofW,
    thickness: tStruct,
    cutPlane: 'XZ',
    cutW: roofL,
    cutH: roofW,
    notes: 'Grande plaque horizontale reposant à la fois sur la cella (170 mm) et les colonnes (170 mm)'
  });

  const pedimentBaseY = roofBaseY + tStruct;

  pieces.push({
    id: nextPieceId('roof'),
    name: 'Fronton Triangulaire Avant (Tympan)',
    group: 'roof',
    shape: 'prism_z',
    x: cellaStartX + roofL - tStruct,
    y: pedimentBaseY,
    z: 0,
    dx: tStruct,
    dy: pedimentH,
    dz: roofW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: roofW,
    cutH: pedimentH,
    notes: `Triangle isocèle de base ${roofW} mm et hauteur ${pedimentH} mm`
  });

  pieces.push({
    id: nextPieceId('roof'),
    name: 'Pignon Triangulaire Arrière',
    group: 'roof',
    shape: 'prism_z',
    x: cellaStartX,
    y: pedimentBaseY,
    z: 0,
    dx: tStruct,
    dy: pedimentH,
    dz: roofW,
    thickness: tStruct,
    cutPlane: 'ZY',
    cutW: roofW,
    cutH: pedimentH,
    notes: `Triangle isocèle arrière de base ${roofW} mm et hauteur ${pedimentH} mm`
  });

  const halfRoofW = roofW / 2;
  const slopeLength = Math.round(Math.hypot(halfRoofW, pedimentH));

  pieces.push({
    id: nextPieceId('roof'),
    name: 'Versant de Toit Gauche (Incliné)',
    group: 'roof',
    shape: 'roof_slope',
    slopeSide: 'left',
    x: cellaStartX,
    y: pedimentBaseY,
    z: 0,
    dx: roofL,
    dy: pedimentH,
    dz: halfRoofW,
    thickness: tStruct,
    cutPlane: 'SLOPE',
    cutW: roofL,
    cutH: slopeLength,
    notes: `Pan de toit incliné gauche — Découpe à plat : ${roofL} × ${slopeLength} mm (ép. ${tStruct} mm)`
  });

  pieces.push({
    id: nextPieceId('roof'),
    name: 'Versant de Toit Droit (Incliné)',
    group: 'roof',
    shape: 'roof_slope',
    slopeSide: 'right',
    x: cellaStartX,
    y: pedimentBaseY,
    z: halfRoofW,
    dx: roofL,
    dy: pedimentH,
    dz: halfRoofW,
    thickness: tStruct,
    cutPlane: 'SLOPE',
    cutW: roofL,
    cutH: slopeLength,
    notes: `Pan de toit incliné droit — Découpe à plat : ${roofL} × ${slopeLength} mm (ép. ${tStruct} mm)`
  });

  return pieces;
}

/**
 * Retourne l'axe d'épaisseur ('dx' | 'dy' | 'dz') d'une pièce en respectant son plan de coupe (cutPlane).
 */
export function getThicknessProp(piece) {
  if (piece.cutPlane === 'XY') return 'dz';
  if (piece.cutPlane === 'XZ') return 'dy';
  if (piece.cutPlane === 'ZY') return 'dx';
  // Par défaut pour un fronton/pignon triangulaire
  if (piece.shape === 'prism_z') return 'dx';
  // Sinon, plus petite dimension
  if (piece.dx <= piece.dy && piece.dx <= piece.dz) return 'dx';
  if (piece.dy <= piece.dx && piece.dy <= piece.dz) return 'dy';
  return 'dz';
}

export function recomputeCutDimensions(piece) {
  if (piece.shape === 'stairs') {
    piece.thickness = 20;
    piece.cutW = Math.round(piece.dz);
    piece.cutH = Math.round(piece.dx);
    return;
  }
  if (piece.shape === 'cylinder_y') {
    piece.cutW = Math.round(piece.dx);
    piece.cutH = Math.round(piece.dy);
    piece.thickness = Math.round(piece.dx);
    return;
  }
  if (piece.shape === 'roof_slope') {
    const slopeLen = Math.round(Math.hypot(piece.dz, piece.dy));
    piece.cutW = Math.round(piece.dx);
    piece.cutH = slopeLen;
    return;
  }
  if (piece.shape === 'prism_z') {
    const plane = piece.cutPlane || 'ZY';
    if (plane === 'XY') {
      piece.cutW = Math.round(piece.dx);
      piece.cutH = Math.round(piece.dy);
      piece.thickness = Math.round(piece.dz);
    } else if (plane === 'XZ') {
      piece.cutW = Math.round(piece.dx);
      piece.cutH = Math.round(piece.dz);
      piece.thickness = Math.round(piece.dy);
    } else {
      piece.cutPlane = 'ZY';
      piece.cutW = Math.round(piece.dz);
      piece.cutH = Math.round(piece.dy);
      piece.thickness = Math.round(piece.dx);
    }
    return;
  }

  // Pour les boîtes rectangulaires ('box') : utiliser cutPlane s'il correspond à une épaisseur réaliste (<= 30 mm),
  // sinon déduire depuis la plus petite dimension et mettre à jour cutPlane.
  const tProp = piece.cutPlane === 'XY' ? 'dz' : piece.cutPlane === 'XZ' ? 'dy' : piece.cutPlane === 'ZY' ? 'dx' : null;
  const minVal = Math.min(piece.dx, piece.dy, piece.dz);

  if (tProp && (piece[tProp] <= 30 || piece[tProp] === minVal)) {
    piece.thickness = Math.round(piece[tProp]);
    if (piece.cutPlane === 'XZ') {
      piece.cutW = Math.round(piece.dx);
      piece.cutH = Math.round(piece.dz);
    } else if (piece.cutPlane === 'XY') {
      piece.cutW = Math.round(piece.dx);
      piece.cutH = Math.round(piece.dy);
    } else {
      piece.cutW = Math.round(piece.dz);
      piece.cutH = Math.round(piece.dy);
    }
    return;
  }

  const dims = [
    { axis: 'X', plane: 'ZY', val: piece.dx },
    { axis: 'Y', plane: 'XZ', val: piece.dy },
    { axis: 'Z', plane: 'XY', val: piece.dz }
  ].sort((a, b) => a.val - b.val);

  piece.cutPlane = dims[0].plane;
  piece.thickness = Math.round(dims[0].val);
  piece.cutW = Math.round(dims[2].val);
  piece.cutH = Math.round(dims[1].val);
}
