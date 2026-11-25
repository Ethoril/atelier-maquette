// Visualiseur Volume 3D (Three.js) avec extrusion temps réel, vue éclatée,
// ouverture des bouchons 1..25, arêtes techniques et sélection synchronisée avec le plan 2D.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { THICKNESS_COLORS, GROUP_META } from './templeGenerator.js';

export class Viewer3D {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks; // { onSelect }

    this.pieces = [];
    this.selectedId = null;
    this.colorMode = 'group'; // 'group' | 'thickness'
    this.explodeFactor = 0; // 0.0 -> 1.0
    this.plugsOpen = false; // Ouvre/écarte les 25 bouchons
    this.openedPlugIds = new Set(); // Bouchons ouverts individuellement au double-clic
    this.xrayMode = false;
    this.showFloatingLabels = false;
    this.visibleGroups = new Set(Object.keys(GROUP_META));

    this.meshMap = new Map(); // piece.id -> THREE.Object3D
    this.spriteMap = new Map(); // piece.id -> THREE.Sprite
    this.numberTextureCache = new Map();
    this.spriteTextureCache = new Map();

    this._initThree();
    this._initInteraction();
    this._animate();
  }

  _initThree() {
    const rect = this.container.getBoundingClientRect();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1120');

    this.camera = new THREE.PerspectiveCamera(42, Math.max(1, rect.width) / Math.max(1, rect.height), 1, 5000);
    this.camera.position.set(520, 390, 560);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(Math.max(300, rect.width), Math.max(250, rect.height));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(200, 120, 105);

    // Éclairage atelier maquette
    const hemi = new THREE.HemisphereLight(0xf8fafc, 0x334155, 0.85);
    this.scene.add(hemi);

    const dir1 = new THREE.DirectionalLight(0xffffff, 1.05);
    dir1.position.set(450, 650, 500);
    dir1.castShadow = true;
    dir1.shadow.mapSize.width = 2048;
    dir1.shadow.mapSize.height = 2048;
    this.scene.add(dir1);

    const dir2 = new THREE.DirectionalLight(0x93c5fd, 0.45);
    dir2.position.set(-380, 280, -350);
    this.scene.add(dir2);

    // Grille de sol en millimètres (600 x 600 mm, graduée tous les 10 mm / 50 mm)
    const grid = new THREE.GridHelper(700, 70, 0x38bdf8, 0x1e293b);
    grid.position.set(200, -0.5, 110);
    this.scene.add(grid);

    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);
  }

  _initInteraction() {
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };
    const activePointers = new Set();
    let hadMultiTouch = false;
    let lastTap = { time: 0, x: 0, y: 0, pieceId: null };
    let lastTouchToggleTime = 0;

    const togglePlugById = (pieceId) => {
      if (!pieceId) return;
      const piece = this.pieces.find((p) => p.id === pieceId);
      if (piece && piece.adventNum) {
        if (this.openedPlugIds.has(piece.id)) {
          this.openedPlugIds.delete(piece.id);
        } else {
          this.openedPlugIds.add(piece.id);
        }
        this.applyTransforms();
      }
    };

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      activePointers.add(e.pointerId);
      if (activePointers.size > 1) {
        hadMultiTouch = true;
      }
      downPos = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('pointercancel', (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) hadMultiTouch = false;
    });

    this.renderer.domElement.addEventListener('pointerup', (e) => {
      activePointers.delete(e.pointerId);
      if (hadMultiTouch) {
        if (activePointers.size === 0) hadMultiTouch = false;
        return;
      }

      const maxMove = e.pointerType === 'touch' ? 12 : 5;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > maxMove) return;

      const hitPieceId = this._raycastPiece(e);
      this.selectedId = hitPieceId;
      this.callbacks.onSelect?.(hitPieceId);
      this.updateSelectionHighlight();

      // Détection fiable du double-tap sur une case (#1-#25) en tactile (iOS/Android)
      if (e.pointerType === 'touch' && hitPieceId) {
        const now = Date.now();
        if (
          now - lastTap.time < 360 &&
          lastTap.pieceId === hitPieceId &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 34
        ) {
          togglePlugById(hitPieceId);
          lastTap = { time: 0, x: 0, y: 0, pieceId: null };
          lastTouchToggleTime = now;
        } else {
          lastTap = { time: now, x: e.clientX, y: e.clientY, pieceId: hitPieceId };
        }
      }
    });

    // Double-clic souris sur un bouchon en 3D -> l'ouvrir ou le refermer individuellement
    this.renderer.domElement.addEventListener('dblclick', (e) => {
      if (Date.now() - lastTouchToggleTime < 450) return;
      const hitPieceId = this._raycastPiece(e);
      togglePlugById(hitPieceId);
    });
  }

  _raycastPiece(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const pickables = [];
    for (const [id, obj] of this.meshMap.entries()) {
      if (obj.visible) {
        obj.traverse((child) => {
          if (child.isMesh) {
            child.userData.pieceId = id;
            pickables.push(child);
          }
        });
      }
    }

    const intersects = this.raycaster.intersectObjects(pickables, false);
    if (intersects.length > 0) {
      return intersects[0].object.userData.pieceId || null;
    }
    return null;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const w = Math.max(250, rect.width);
    const h = Math.max(220, rect.height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  resetCamera(view = 'iso') {
    const center = this._getSceneCenter();
    this.controls.target.copy(center);
    if (view === 'front') {
      this.camera.position.set(center.x + 560, center.y + 40, center.z);
    } else if (view === 'side') {
      this.camera.position.set(center.x, center.y + 40, center.z + 560);
    } else if (view === 'top') {
      this.camera.position.set(center.x, center.y + 620, center.z + 1);
    } else {
      this.camera.position.set(center.x + 430, center.y + 310, center.z + 440);
    }
    this.controls.update();
  }

  _getSceneCenter() {
    if (!this.pieces || this.pieces.length === 0) {
      return new THREE.Vector3(200, 120, 105);
    }
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
    return new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  }

  setPieces(pieces) {
    this.pieces = pieces;
    this.rebuildScene();
  }

  setSelectedId(id) {
    this.selectedId = id;
    this.updateSelectionHighlight();
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.rebuildScene();
  }

  setExplodeFactor(val) {
    this.explodeFactor = val;
    this.applyTransforms();
  }

  setPlugsOpen(open) {
    this.plugsOpen = open;
    if (!open) this.openedPlugIds.clear();
    this.applyTransforms();
  }

  setXrayMode(enabled) {
    this.xrayMode = enabled;
    this.rebuildScene();
  }

  setShowFloatingLabels(enabled) {
    this.showFloatingLabels = enabled;
    this.updateSelectionHighlight();
  }

  getPieceColorHex(p) {
    if (this.colorMode === 'thickness') {
      return THICKNESS_COLORS[p.thickness] || '#a78bfa';
    }
    return GROUP_META[p.group]?.color || '#cbd5e1';
  }

  _getNumberTexture(adventNum, pieceNum, bgColor) {
    const key = `plug_${adventNum}_${pieceNum || 0}_${bgColor}`;
    if (this.numberTextureCache.has(key)) return this.numberTextureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 128, 128);

    // Cadre mouluré style pierre romaine
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 108, 108);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 44px Inter, Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${adventNum}`, 64, pieceNum ? 56 : 66);

    if (pieceNum) {
      ctx.fillStyle = '#0369a1';
      ctx.font = '800 22px ui-monospace, Consolas, monospace';
      ctx.fillText(`P${pieceNum}`, 64, 98);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.numberTextureCache.set(key, tex);
    return tex;
  }

  _getPieceFaceTexture(pieceNum, bgColor) {
    const key = `face_${pieceNum}_${bgColor}`;
    if (this.numberTextureCache.has(key)) return this.numberTextureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 128, 128);

    // Numéro de pièce gravé proprement au centre de la face
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.font = '800 34px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`P${pieceNum}`, 64, 64);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.numberTextureCache.set(key, tex);
    return tex;
  }

  _getBadgeSpriteTexture(text, highlighted = false) {
    const key = `badge_${text}_${highlighted ? 1 : 0}`;
    if (this.spriteTextureCache.has(key)) return this.spriteTextureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = highlighted ? '#38bdf8' : 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = highlighted ? '#f8fafc' : '#38bdf8';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(6, 6, 116, 52, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = highlighted ? '#090d16' : '#f8fafc';
    ctx.font = '800 30px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 34);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.spriteTextureCache.set(key, tex);
    return tex;
  }

  rebuildScene() {
    while (this.rootGroup.children.length > 0) {
      const child = this.rootGroup.children[0];
      this.rootGroup.remove(child);
    }
    this.meshMap.clear();
    this.spriteMap.clear();

    for (const p of this.pieces) {
      const obj = this._buildPieceObject(p);
      this.rootGroup.add(obj);
      this.meshMap.set(p.id, obj);
    }

    this.applyTransforms();
    this.updateSelectionHighlight();
  }

  _buildPieceObject(p) {
    const group = new THREE.Group();
    const colorHex = this.getPieceColorHex(p);
    const isPlug = Boolean(p.adventNum);
    const isTransparent = this.xrayMode && p.group !== 'grid';

    const baseMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.65,
      metalness: 0.05,
      transparent: isTransparent,
      opacity: isTransparent ? 0.32 : 1.0,
    });

    if (p.shape === 'cylinder_y') {
      // Colonne romaine avec socle carré (ex: 30x30 mm), fût cylindrique et chapiteau carré (hauteur totale = p.dy = 170 mm)
      const baseH = Math.min(12, p.dy * 0.07);
      const capH = Math.min(12, p.dy * 0.07);
      const shaftH = Math.max(10, p.dy - baseH - capH);
      const shaftRadius = (Math.min(p.dx, p.dz) / 2) * 0.78;

      // Socle carré 30x30 mm
      const plinthGeom = new THREE.BoxGeometry(p.dx, baseH, p.dz);
      const plinthMesh = new THREE.Mesh(plinthGeom, baseMat);
      plinthMesh.position.y = -p.dy / 2 + baseH / 2;
      plinthMesh.castShadow = true;
      plinthMesh.receiveShadow = true;

      // Chapiteau carré 30x30 mm
      const capGeom = new THREE.BoxGeometry(p.dx, capH, p.dz);
      const capMesh = new THREE.Mesh(capGeom, baseMat);
      capMesh.position.y = p.dy / 2 - capH / 2;
      capMesh.castShadow = true;
      capMesh.receiveShadow = true;

      // Fût cylindrique cannelé
      const shaftGeom = new THREE.CylinderGeometry(shaftRadius * 0.92, shaftRadius, shaftH, 20);
      const shaftMesh = new THREE.Mesh(shaftGeom, baseMat);
      shaftMesh.castShadow = true;
      shaftMesh.receiveShadow = true;

      group.add(plinthMesh, capMesh, shaftMesh);

      const lineMat = new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.55 });
      const plinthEdges = new THREE.LineSegments(new THREE.EdgesGeometry(plinthGeom), lineMat);
      plinthEdges.position.copy(plinthMesh.position);
      const capEdges = new THREE.LineSegments(new THREE.EdgesGeometry(capGeom), lineMat);
      capEdges.position.copy(capMesh.position);
      group.add(plinthEdges, capEdges);
    } else if (p.shape === 'prism_z') {
      // Triangle isocèle dans son plan de coupe (ZY par défaut, XY ou XZ selon cutPlane)
      const plane = p.cutPlane || 'ZY';
      let baseW = p.dz;
      let triH = p.dy;
      let depth = p.dx;
      if (plane === 'XY') {
        baseW = p.dx;
        triH = p.dy;
        depth = p.dz;
      } else if (plane === 'XZ') {
        baseW = p.dx;
        triH = p.dz;
        depth = p.dy;
      }

      const shape = new THREE.Shape();
      shape.moveTo(-baseW / 2, -triH / 2);
      shape.lineTo(baseW / 2, -triH / 2);
      shape.lineTo(0, triH / 2);
      shape.closePath();

      const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      extrudeGeom.translate(0, 0, -depth / 2);
      if (plane === 'ZY') {
        extrudeGeom.rotateY(Math.PI / 2);
      } else if (plane === 'XZ') {
        extrudeGeom.rotateX(Math.PI / 2);
      }

      const mesh = new THREE.Mesh(extrudeGeom, baseMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(extrudeGeom),
        new THREE.LineBasicMaterial({ color: 0x0f172a })
      );
      group.add(edges);
    } else if (p.shape === 'roof_slope') {
      // Plaque inclinée du toit : longueur dx, largeur rampante hypot(dz, dy), épaisseur p.thickness
      const slopeLen = Math.hypot(p.dz, p.dy);
      const angle = Math.atan2(p.dy, p.dz);
      const t = p.thickness || 10;
      const geom = new THREE.BoxGeometry(p.dx, t, slopeLen);
      let mat = baseMat;
      if (p.pieceNum) {
        const faceTex = this._getPieceFaceTexture(p.pieceNum, colorHex);
        const faceMat = new THREE.MeshStandardMaterial({
          map: faceTex,
          roughness: 0.65,
          transparent: isTransparent,
          opacity: isTransparent ? 0.36 : 1.0
        });
        mat = [baseMat, baseMat, faceMat, faceMat, baseMat, baseMat];
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = p.slopeSide === 'left' ? -angle : angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0x0f172a })
      );
      edges.rotation.copy(mesh.rotation);
      group.add(mesh, edges);
    } else if (p.shape === 'stairs') {
      // Bloc d'escalier amovible (Case #25) composé de 5 marches
      const steps = 5;
      const stepDx = p.dx / steps;
      const stepDy = p.dy / steps;
      for (let s = 0; s < steps; s++) {
        const curH = p.dy - s * stepDy;
        const stepGeom = new THREE.BoxGeometry(stepDx, curH, p.dz);
        const isFrontStep = s === steps - 1;
        let mat = baseMat;
        if (isFrontStep && p.adventNum) {
          const numTex = this._getNumberTexture(p.adventNum, p.pieceNum, colorHex);
          const numMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.6 });
          mat = [numMat, baseMat, baseMat, baseMat, baseMat, baseMat];
        }
        const stepMesh = new THREE.Mesh(stepGeom, mat);
        stepMesh.position.set(
          -p.dx / 2 + stepDx * (s + 0.5),
          -p.dy / 2 + curH / 2,
          0
        );
        stepMesh.castShadow = true;
        stepMesh.receiveShadow = true;
        group.add(stepMesh);

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(stepGeom),
          new THREE.LineBasicMaterial({ color: 0x0f172a })
        );
        edges.position.copy(stepMesh.position);
        group.add(edges);
      }
    } else {
      // Boîte rectangulaire standard (murs, planchers, cloisons, bouchons 1..24)
      const geom = new THREE.BoxGeometry(p.dx, p.dy, p.dz);
      let mat = baseMat;
      if (isPlug) {
        const numTex = this._getNumberTexture(p.adventNum, p.pieceNum, colorHex);
        const numMat = new THREE.MeshStandardMaterial({
          map: numTex,
          roughness: 0.55,
          transparent: isTransparent,
          opacity: isTransparent ? 0.45 : 1.0
        });
        // Ordre des faces BoxGeometry : +X, -X, +Y, -Y, +Z (droite), -Z (gauche)
        mat = [baseMat, baseMat, baseMat, baseMat, numMat, numMat];
      } else if (p.pieceNum) {
        const faceTex = this._getPieceFaceTexture(p.pieceNum, colorHex);
        const faceMat = new THREE.MeshStandardMaterial({
          map: faceTex,
          roughness: 0.65,
          transparent: isTransparent,
          opacity: isTransparent ? 0.36 : 1.0
        });
        const plane = p.cutPlane || (p.dx <= p.dy && p.dx <= p.dz ? 'ZY' : p.dy <= p.dx && p.dy <= p.dz ? 'XZ' : 'XY');
        if (plane === 'ZY') mat = [faceMat, faceMat, baseMat, baseMat, baseMat, baseMat];
        else if (plane === 'XZ') mat = [baseMat, baseMat, faceMat, faceMat, baseMat, baseMat];
        else mat = [baseMat, baseMat, baseMat, baseMat, faceMat, faceMat];
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.75 })
      );
      edges.name = 'outline';
      group.add(edges);
    }

    // Badge flottant P# (affiché sur la pièce sélectionnée, ou sur toutes quand "🏷️ N° 3D" est activé)
    if (p.pieceNum) {
      const spriteMat = new THREE.SpriteMaterial({
        map: this._getBadgeSpriteTexture(`P${p.pieceNum}`, false),
        depthTest: false,
        depthWrite: false,
        transparent: true
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(24, 12, 1);
      sprite.renderOrder = 999;
      sprite.userData.pieceNum = p.pieceNum;
      sprite.visible = this.showFloatingLabels;
      group.add(sprite);
      this.spriteMap.set(p.id, sprite);
    }

    return group;
  }

  // Met à jour la position 3D de chaque pièce (en tenant compte de la vue éclatée et de l'ouverture des bouchons)
  applyTransforms() {
    const center = this._getSceneCenter();

    for (const p of this.pieces) {
      const obj = this.meshMap.get(p.id);
      if (!obj) continue;

      obj.visible = !p.hidden && this.visibleGroups.has(p.group);

      // Centre géométrique nominal de la pièce
      let cx = p.x + p.dx / 2;
      let cy = p.y + p.dy / 2;
      let cz = p.z + p.dz / 2;

      // Décalage de "Vue Éclatée"
      if (this.explodeFactor > 0) {
        const ex = (cx - center.x) * this.explodeFactor * 0.65;
        const ey = (cy - center.y) * this.explodeFactor * 0.85;
        const ez = (cz - center.z) * this.explodeFactor * 0.95;
        cx += ex;
        cy += ey + (p.group === 'roof' ? this.explodeFactor * 55 : 0);
        cz += ez;
      }

      // Ouverture des bouchons (1..25)
      const isPlugOpen = this.plugsOpen || this.openedPlugIds.has(p.id);
      if (p.adventNum && isPlugOpen) {
        if (p.adventNum === 25) {
          cx += 65; // L'escalier #25 coulisse vers l'avant (+X)
        } else if (p.plugSide === 'left') {
          cz -= 48; // Les bouchons 1..12 sortent vers la gauche (-Z)
        } else {
          cz += 48; // Les bouchons 13..24 sortent vers la droite (+Z)
        }
      }

      obj.position.set(cx, cy, cz);
    }
  }

  updatePieceGeometry(piece) {
    // Reconstruit uniquement l'objet 3D de la pièce modifiée en 2D pour une fluidité maximale
    const oldObj = this.meshMap.get(piece.id);
    if (oldObj) {
      this.rootGroup.remove(oldObj);
    }
    const newObj = this._buildPieceObject(piece);
    this.rootGroup.add(newObj);
    this.meshMap.set(piece.id, newObj);
    this.applyTransforms();
    this.updateSelectionHighlight();
  }

  updateSelectionHighlight() {
    for (const [id, obj] of this.meshMap.entries()) {
      const isSel = id === this.selectedId;
      obj.traverse((child) => {
        if (child.isLineSegments) {
          child.material.color.setHex(isSel ? 0x38bdf8 : 0x0f172a);
          child.material.opacity = isSel ? 1.0 : 0.75;
        }
        if (child.isMesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m && m.emissive) {
              m.emissive.setHex(isSel ? 0x0ea5e9 : 0x000000);
              if (m.emissiveIntensity !== undefined) {
                m.emissiveIntensity = isSel ? 0.35 : 0;
              }
            }
          }
        }
      });

      const sprite = this.spriteMap.get(id);
      if (sprite) {
        sprite.visible = this.showFloatingLabels || isSel;
        sprite.material.map = this._getBadgeSpriteTexture(`P${sprite.userData.pieceNum}`, isSel);
        sprite.scale.set(isSel ? 30 : 22, isSel ? 15 : 11, 1);
      }
    }
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
