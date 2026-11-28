// Moteur 3D Isométrique façon LEGO (Three.js OrthographicCamera)
// - Projection orthographique isométrique sans déformation (comme une vraie notice LEGO)
// - Rendu progressif des états de chantier : XPS brut -> Sous-couche Mod Podge -> Travertin patiné
// - Props 3D dédiés : Fresques à figurines en bas-relief, Boîte-tiroir #25, Porte bronze en embrasure,
//   Fresques intérieures, 24 boutons bronze + 48 mini-charnières, Dédicace latine gravée, Tuiles & Frontons
// - Capture PNG haute définition pour le livret A4 imprimable / PDF.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { THICKNESS_COLORS, computeStairLayers } from './templeGenerator.js';
import { snapToAllowedThickness } from './platePacker.js';

const RAW_XPS_COLORS = {
  6: '#bae6fd',   // XPS 6 mm : bleu ciel pâle
  10: '#f5e6cc',  // XPS 10 mm : sable XPS doux
  20: '#fecdd3',  // XPS 20 mm : rose corail doux
  30: '#f8fafc',  // Colonnes plastique blanc cassé
};

const ACTIVE_HIGHLIGHT_COLOR = '#fbbf24'; // Ambre LEGO bien lisible
const ACTIVE_OUTLINE_HEX = 0xdc2626;      // Rouge LEGO vif
const BUILT_OUTLINE_HEX = 0x1e293b;       // Encre technique foncée

export class LegoManualRenderer3D {
  constructor(container, opts = {}) {
    this.container = container;
    this.assetBasePath = opts.assetBasePath || './assets_cases';
    this.manual = null;
    this.currentStep = null;
    this.explodeFactor = 0.65;
    this.showLabels = true;
    this.forceFullTemple = false;

    this.textureCache = new Map();
    this.externalImages = {}; // fronton, pignon, porte

    this._initThree();
    this._preloadExternalFacadeImages();
    this._animate();
  }

  _initThree() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(320, rect.width || 800);
    const h = Math.max(260, rect.height || 540);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eef5fc');

    const aspect = w / h;
    this.frustumSize = 460;
    this.camera = new THREE.OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      -2000,
      4000
    );
    this.camera.position.set(520, 420, 540);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true, // Permet les captures PNG nettes pour le livret A4
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.target.set(200, 120, 105);

    // Éclairage studio façon notice LEGO (lumière douce, très lisible, zéro zone noire)
    const hemi = new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.05);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 0.95);
    keyLight.position.set(500, 720, 560);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.left = -450;
    keyLight.shadow.camera.right = 450;
    keyLight.shadow.camera.top = 450;
    keyLight.shadow.camera.bottom = -450;
    keyLight.shadow.bias = -0.0005;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.55);
    fillLight.position.set(-450, 320, -400);
    this.scene.add(fillLight);

    // Plan de sol doux récepteur d'ombres
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1800, 1800),
      new THREE.ShadowMaterial({ opacity: 0.14 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.set(200, -0.5, 105);
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);

    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);
  }

  _preloadExternalFacadeImages() {
    const loader = new THREE.TextureLoader();
    const files = {
      fronton: `${this.assetBasePath}/facade_fronton_avant_2480x650.png`,
      pignon: `${this.assetBasePath}/facade_pignon_arriere_2480x650.png`,
      porte: `${this.assetBasePath}/facade_porte_cella_2126x2008.png`,
    };
    for (const [key, url] of Object.entries(files)) {
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          this.externalImages[key] = tex;
          if (this.currentStep) this.renderStep(this.currentStep, false);
        },
        undefined,
        () => {
          // Fallback procédural automatique (ex: dans dist/ sans assets_cases)
        }
      );
    }
  }

  setManual(manual) {
    this.manual = manual;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(300, rect.width || 800);
    const h = Math.max(240, rect.height || 520);
    const aspect = w / h;
    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setExplodeFactor(val) {
    this.explodeFactor = Math.max(0, Math.min(1, Number(val) || 0));
    if (this.currentStep) this.renderStep(this.currentStep, false);
  }

  setShowLabels(enabled) {
    this.showLabels = Boolean(enabled);
    if (this.currentStep) this.renderStep(this.currentStep, false);
  }

  setForceFullTemple(enabled) {
    this.forceFullTemple = Boolean(enabled);
    if (this.currentStep) this.renderStep(this.currentStep, true);
  }

  /**
   * Construit toute la scène 3D pour l'étape LEGO courante.
   */
  renderStep(step, resetCam = true) {
    if (!this.manual || !step) return;
    this.currentStep = step;

    // Nettoyer l'ancien arbre
    while (this.rootGroup.children.length > 0) {
      const child = this.rootGroup.children[0];
      this.rootGroup.remove(child);
    }

    const { pieces, geom } = this.manual;
    const sc = step.scene || {};
    const vs = sc.visualState || {};
    const activeSet = new Set(sc.activeIds || []);
    const visibleSet = new Set(this.forceFullTemple ? pieces.map((p) => p.id) : (sc.visibleIds || []));

    const visiblePieces = pieces.filter((p) => visibleSet.has(p.id));
    const openDoorNums = new Set(vs.openDemoDoors || []);
    const openStairsShift = (vs.openStairs || 0) * (this.explodeFactor > 0.05 ? Math.max(0.45, this.explodeFactor) : 0);

    // 1. Construire chaque pièce visible
    for (const p of visiblePieces) {
      const isActive = activeSet.has(p.id);
      const isGhost = this.forceFullTemple && !(sc.visibleIds || []).includes(p.id);
      const obj = this._buildPieceMesh(p, { isActive, isGhost, vs });

      // Position nominale
      let cx = p.x + p.dx / 2;
      let cy = p.y + p.dy / 2;
      let cz = p.z + p.dz / 2;

      // Décalage éclaté d'étape
      const exp = sc.explodeMap?.[p.id];
      if (exp && this.explodeFactor > 0) {
        cx += (exp.dx || 0) * this.explodeFactor;
        cy += (exp.dy || 0) * this.explodeFactor;
        cz += (exp.dz || 0) * this.explodeFactor;
      }

      // Ouverture escalier #25
      if (p.shape === 'stairs' && openStairsShift > 0) {
        cx += openStairsShift;
      }

      // Porte battante ouverte sur ses charnières (démo visuelle)
      if (p.adventNum >= 1 && p.adventNum <= 24 && openDoorNums.has(p.adventNum) && !exp) {
        this._applyDoorSwing(obj, p, cx, cy, cz, geom);
      } else {
        obj.position.set(cx, cy, cz);
      }

      this.rootGroup.add(obj);

      // Badge flottant P# sur les pièces actives (ou si showLabels)
      if (this.showLabels && p.pieceNum && (isActive || visiblePieces.length <= 10)) {
        const sprite = this._createLabelSprite(`P${p.pieceNum}`, isActive);
        sprite.position.set(cx, cy + p.dy / 2 + 12, cz);
        this.rootGroup.add(sprite);
      }
    }

    // 2. Ajouter les props diorama 3D spécifiques à l'étape
    this._addDioramaProps(step, visibleSet, activeSet, vs, geom, openStairsShift);

    // 3. Ajouter les flèches rouges LEGO (si éclaté > 15 %)
    if (Array.isArray(sc.arrows) && sc.arrows.length > 0 && this.explodeFactor >= 0.12) {
      for (const a of sc.arrows) {
        this.rootGroup.add(this._buildLegoArrow(a.from, a.to));
      }
    }

    if (resetCam) {
      this.setCameraPreset(sc.camera?.preset || 'iso-front-right', sc.camera?.zoomPad || 1.22);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _applyDoorSwing(obj, p, cx, cy, cz, geom) {
    // Symétrie doubles portes : Col 0 & 1 articulées côté -X, Col 2 & 3 articulées côté +X
    const bCella = geom.bounds.bCella;
    const cellaMidX = (bCella.minX + bCella.maxX) / 2;
    const hingeAtNegX = (p.x + p.dx / 2) < cellaMidX;
    const isLeftFlank = p.plugSide === 'left' || p.adventNum <= 12;

    const pivot = new THREE.Group();
    const hingeX = hingeAtNegX ? p.x : (p.x + p.dx);
    const hingeZ = isLeftFlank ? p.z : (p.z + p.dz);
    pivot.position.set(hingeX, cy, hingeZ);

    obj.position.set(cx - hingeX, 0, cz - hingeZ);
    pivot.add(obj);

    const openAngle = 1.18; // ~68° ouvert vers l'extérieur (règle main droite : z' = -x sin θ)
    if (isLeftFlank) {
      pivot.rotation.y = hingeAtNegX ? openAngle : -openAngle;
    } else {
      pivot.rotation.y = hingeAtNegX ? -openAngle : openAngle;
    }

    // Retourne le pivot en déplaçant son contenu dans obj's parent via remplacement
    obj.position.set(0, 0, 0);
    // On remplace simplement la transform sur obj en le reparentant dans pivot
    // (Mais renderStep fait rootGroup.add(obj), donc on copie les enfants dans pivot !)
    const children = [...obj.children];
    obj.clear();
    const inner = new THREE.Group();
    for (const ch of children) inner.add(ch);
    inner.position.set(cx - hingeX, 0, cz - hingeZ);
    obj.position.set(hingeX, cy, hingeZ);
    obj.rotation.y = pivot.rotation.y;
    obj.add(inner);
  }

  _getPieceFillHex(p, { isActive, isGhost, vs }) {
    if (isGhost) return '#cbd5e1';
    if (isActive && !vs.paintedRoof && !vs.paintedPodium) {
      return ACTIVE_HIGHLIGHT_COLOR;
    }
    if (vs.primedOnly) return '#4b5563';

    const isPainted =
      (p.group === 'podium' && vs.paintedPodium) ||
      ((p.group === 'cella' || p.group === 'grid') && vs.paintedCella) ||
      (p.group === 'plugs' && p.shape === 'stairs' && vs.paintedPodium) ||
      (p.group === 'plugs' && p.shape !== 'stairs' && vs.paintedDoors) ||
      (p.group === 'pronaos' && vs.paintedColumns) ||
      (p.group === 'roof' && vs.paintedRoof);

    if (isActive) return '#f59e0b';

    if (isPainted) {
      if (p.group === 'roof' && p.shape === 'roof_slope' && vs.showTiles) return '#b4533a';
      if (p.group === 'grid') return '#d6cfc2';
      if (p.group === 'pronaos') return '#e7dfd0';
      return '#dfd5c3'; // Travertin romain chaud patiné
    }

    const t = (p.material === 'plastic' || p.shape === 'cylinder_y')
      ? 30
      : snapToAllowedThickness(p.thickness || 10);
    return RAW_XPS_COLORS[t] || THICKNESS_COLORS[t] || '#e2e8f0';
  }

  _buildPieceMesh(p, { isActive, isGhost, vs }) {
    const group = new THREE.Group();
    const colorHex = this._getPieceFillHex(p, { isActive, isGhost, vs });
    const edgeColor = isActive ? ACTIVE_OUTLINE_HEX : BUILT_OUTLINE_HEX;
    const edgeOpacity = isGhost ? 0.18 : (isActive ? 1.0 : 0.72);

    const baseMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.78,
      metalness: 0.04,
      transparent: isGhost,
      opacity: isGhost ? 0.22 : 1.0,
    });

    const addEdges = (geom, targetMesh = null) => {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom, 20),
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: edgeOpacity })
      );
      if (targetMesh) {
        edges.position.copy(targetMesh.position);
        edges.rotation.copy(targetMesh.rotation);
      }
      group.add(edges);
    };

    if (p.shape === 'cylinder_y') {
      const baseH = Math.min(12, p.dy * 0.07);
      const capH = Math.min(12, p.dy * 0.07);
      const shaftH = Math.max(10, p.dy - baseH - capH);
      const shaftR = (Math.min(p.dx, p.dz) / 2) * 0.76;

      const plinthG = new THREE.BoxGeometry(p.dx, baseH, p.dz);
      const plinthM = new THREE.Mesh(plinthG, baseMat);
      plinthM.position.y = -p.dy / 2 + baseH / 2;
      plinthM.castShadow = !isGhost;
      plinthM.receiveShadow = true;
      group.add(plinthM);
      addEdges(plinthG, plinthM);

      const capG = new THREE.BoxGeometry(p.dx, capH, p.dz);
      const capM = new THREE.Mesh(capG, baseMat);
      capM.position.y = p.dy / 2 - capH / 2;
      capM.castShadow = !isGhost;
      capM.receiveShadow = true;
      group.add(capM);
      addEdges(capG, capM);

      const shaftG = new THREE.CylinderGeometry(shaftR * 0.91, shaftR, shaftH, 16);
      const shaftM = new THREE.Mesh(shaftG, baseMat);
      shaftM.castShadow = !isGhost;
      shaftM.receiveShadow = true;
      group.add(shaftM);
      addEdges(shaftG, shaftM);
    } else if (p.shape === 'prism_z') {
      const plane = p.cutPlane || 'ZY';
      let baseW = p.dz, triH = p.dy, depth = p.dx;
      if (plane === 'XY') { baseW = p.dx; triH = p.dy; depth = p.dz; }
      else if (plane === 'XZ') { baseW = p.dx; triH = p.dz; depth = p.dy; }

      const shape = new THREE.Shape();
      shape.moveTo(-baseW / 2, -triH / 2);
      shape.lineTo(baseW / 2, -triH / 2);
      shape.lineTo(0, triH / 2);
      shape.closePath();

      const extrudeG = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      extrudeG.translate(0, 0, -depth / 2);
      if (plane === 'ZY') extrudeG.rotateY(Math.PI / 2);
      else if (plane === 'XZ') extrudeG.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(extrudeG, baseMat);
      mesh.castShadow = !isGhost;
      mesh.receiveShadow = true;
      group.add(mesh);
      addEdges(extrudeG, mesh);

      // Décor de Fronton / Pignon 300 DPI (ou fallback procédural)
      if (vs.showFrontons && !isGhost && plane === 'ZY') {
        const isFront = p.name.includes('Fronton');
        const tex = this._getFrontonTexture(isFront);
        const triShape = new THREE.Shape();
        triShape.moveTo(-baseW / 2 + 1, -triH / 2 + 1);
        triShape.lineTo(baseW / 2 - 1, -triH / 2 + 1);
        triShape.lineTo(0, triH / 2 - 1);
        triShape.closePath();
        const triGeom = new THREE.ShapeGeometry(triShape);
        // Normaliser UV sur [0..1]
        const pos = triGeom.attributes.position;
        const uvs = [];
        for (let i = 0; i < pos.count; i++) {
          const ux = (pos.getX(i) + baseW / 2) / baseW;
          const uy = (pos.getY(i) + triH / 2) / triH;
          uvs.push(ux, uy);
        }
        triGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        const decalMat = new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.72,
          side: THREE.DoubleSide,
        });
        const decal = new THREE.Mesh(triGeom, decalMat);
        if (isFront) {
          decal.rotation.y = Math.PI / 2;
          decal.position.x = depth / 2 + 0.6;
        } else {
          decal.rotation.y = -Math.PI / 2;
          decal.position.x = -depth / 2 - 0.6;
        }
        group.add(decal);
      }
    } else if (p.shape === 'roof_slope') {
      const slopeLen = Math.hypot(p.dz, p.dy);
      const angle = Math.atan2(p.dy, p.dz);
      const t = p.thickness || 10;
      const geom = new THREE.BoxGeometry(p.dx, t, slopeLen);
      let mat = baseMat;

      if (vs.showTiles && !isGhost) {
        const tileMat = new THREE.MeshStandardMaterial({
          map: this._getTileTexture(),
          roughness: 0.82,
        });
        mat = [baseMat, baseMat, tileMat, baseMat, baseMat, baseMat];
      }

      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = p.slopeSide === 'left' ? -angle : angle;
      mesh.castShadow = !isGhost;
      mesh.receiveShadow = true;
      group.add(mesh);
      addEdges(geom, mesh);
    } else if (p.shape === 'stairs') {
      const spec = computeStairLayers(p);
      for (const layer of spec.layers) {
        const stepG = new THREE.BoxGeometry(layer.dx, layer.dy, p.dz);
        const stepM = new THREE.Mesh(stepG, baseMat);
        stepM.position.set(
          -p.dx / 2 + layer.xOffset + layer.dx / 2,
          -p.dy / 2 + layer.yOffset + layer.dy / 2,
          0
        );
        stepM.castShadow = !isGhost;
        stepM.receiveShadow = true;
        group.add(stepM);
        addEdges(stepG, stepM);
      }
    } else {
      const geom = new THREE.BoxGeometry(p.dx, p.dy, p.dz);
      let mat = baseMat;

      // Numéros 1..24 sur les portes
      if (p.adventNum >= 1 && p.adventNum <= 24 && vs.showDoorNumbers && !isGhost) {
        const numMat = new THREE.MeshStandardMaterial({
          map: this._getDoorNumberTexture(p.adventNum, colorHex),
          roughness: 0.72,
        });
        mat = [baseMat, baseMat, baseMat, baseMat, numMat, numMat];
      }

      // Inscription latine gravée sur la face avant (+X) de l'Architrave
      if (vs.showArchitraveText && !isGhost && (p.name.includes('Architrave') || p.name.includes('Plafond'))) {
        const bPlaf = this.manual.geom.bounds.bPlafond;
        if (Math.abs((p.x + p.dx) - bPlaf.maxX) <= 2) {
          const archMat = new THREE.MeshStandardMaterial({
            map: this._getArchitraveTexture(colorHex),
            roughness: 0.75,
          });
          mat = [archMat, baseMat, baseMat, baseMat, baseMat, baseMat];
        }
      }

      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = !isGhost;
      mesh.receiveShadow = true;
      group.add(mesh);
      addEdges(geom, mesh);

      // Quincaillerie directe sur les portes (boutons bronze + mini-charnières 8×10 mm)
      if (p.adventNum >= 1 && p.adventNum <= 24 && vs.showHardware && !isGhost) {
        this._attachDoorHardware(group, p, vs);
      }
    }

    return group;
  }

  _attachDoorHardware(doorGroup, p, vs) {
    const bCella = this.manual.geom.bounds.bCella;
    const cellaMidX = (bCella.minX + bCella.maxX) / 2;
    const hingeAtNegX = (p.x + p.dx / 2) < cellaMidX;
    const isLeft = p.plugSide === 'left' || p.adventNum <= 12;
    const faceZ = isLeft ? (-p.dz / 2) : (p.dz / 2);
    const outDir = isLeft ? -1 : 1;

    // Bouton bronze antique (Ø 12 × H 11 mm)
    if (vs.showHardware === 'knobs' || vs.showHardware === 'all') {
      const knobX = hingeAtNegX ? (p.dx / 2 - 11) : (-p.dx / 2 + 11);
      const bronzeMat = new THREE.MeshStandardMaterial({
        color: 0x78552b,
        roughness: 0.42,
        metalness: 0.68,
      });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 5, 3, 12), bronzeMat);
      base.rotation.x = Math.PI / 2;
      base.position.set(knobX, 0, faceZ + outDir * 1.5);

      const head = new THREE.Mesh(new THREE.SphereGeometry(5.5, 14, 10), bronzeMat);
      head.scale.set(1, 1, 0.72);
      head.position.set(knobX, 0, faceZ + outDir * 6.5);

      doorGroup.add(base, head);
    }

    // 2 Mini-charnières 8×10 mm camouflées couleur pierre (gond de 2 mm sombre au bord)
    if (vs.showHardware === 'hinges' || vs.showHardware === 'all') {
      const hingeX = hingeAtNegX ? (-p.dx / 2) : (p.dx / 2);
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0xd4c8b4, // Camouflé couleur pierre
        roughness: 0.8,
      });
      const pinMat = new THREE.MeshStandardMaterial({
        color: 0x453524, // Cylindre central fondu dans l'ombre du joint
        roughness: 0.5,
        metalness: 0.5,
      });
      for (const yOff of [-p.dy / 2 + 10, p.dy / 2 - 10]) {
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 8, 8), pinMat);
        pin.position.set(hingeX, yOff, faceZ + outDir * 0.9);
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(4.5, 8, 0.8), leafMat);
        leaf.position.set(hingeX + (hingeAtNegX ? 2.5 : -2.5), yOff, faceZ + outDir * 0.4);
        doorGroup.add(pin, leaf);
      }
    }
  }

  _addDioramaProps(step, visibleSet, activeSet, vs, geom, openStairsShift) {
    const { groups: g, bounds: b, metrics: m } = geom;

    // 1. Fresques à figurines en bas-relief sur les 2 Flancs du Podium
    if (vs.showFriezes) {
      const friezeColor = vs.showFriezes === 'sculpting'
        ? '#f8fafc' // Blanc enduit allégé Axton frais
        : vs.showFriezes === 'primed'
          ? '#4b5563'
          : '#d9ceb8'; // Travertin patiné unifié
      const figColor = vs.showFriezes === 'sculpting'
        ? '#94a3b8' // Figurines grises/plastique enfoncées dans l'enduit blanc
        : vs.showFriezes === 'primed'
          ? '#374151'
          : '#efe6d5'; // Reliefs éclaircis au drybrush

      const buildFriezeOnFlank = (flankList, side) => {
        if (!flankList.some((p) => visibleSet.has(p.id))) return;
        const bf = side === 'left' ? b.bFlancG : b.bFlancD;
        const exp = step.scene?.explodeMap?.[flankList[0].id] || { dx: 0, dy: 0, dz: 0 };
        const ex = (exp.dx || 0) * this.explodeFactor;
        const ey = (exp.dy || 0) * this.explodeFactor;
        const ez = (exp.dz || 0) * this.explodeFactor;

        const outSign = side === 'left' ? -1 : 1;
        const baseZ = (side === 'left' ? bf.minZ : bf.maxZ) + ez;

        const group = new THREE.Group();
        const bedL = Math.max(40, bf.dx - 12);
        const bedH = Math.max(20, bf.dy - 8);
        const bedMat = new THREE.MeshStandardMaterial({ color: friezeColor, roughness: 0.88 });
        const bedG = new THREE.BoxGeometry(bedL, bedH, 4.5);
        const bedM = new THREE.Mesh(bedG, bedMat);
        bedM.position.set(bf.minX + bf.dx / 2 + ex, bf.minY + bf.dy / 2 + ey, baseZ + outSign * 2.2);
        bedM.castShadow = true;
        bedM.receiveShadow = true;
        group.add(bedM);
        const bedEd = new THREE.LineSegments(
          new THREE.EdgesGeometry(bedG),
          new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.45 })
        );
        bedEd.position.copy(bedM.position);
        group.add(bedEd);

        // Procession de mini-figurines romaines en bas-relief le long du flanc
        const figMat = new THREE.MeshStandardMaterial({ color: figColor, roughness: 0.72 });
        const count = Math.max(6, Math.floor(bedL / 30));
        const startX = bf.minX + 24 + ex;
        const stepX = (bedL - 36) / Math.max(1, count - 1);
        const midY = bf.minY + bf.dy / 2 + ey;

        for (let i = 0; i < count; i++) {
          const fx = startX + i * stepX;
          const fz = baseZ + outSign * 4.8;
          // Torse / tunique drapé
          const body = new THREE.Mesh(new THREE.CapsuleGeometry(4.2, 13, 4, 8), figMat);
          body.scale.set(1, 1, 0.55);
          body.position.set(fx, midY - 3, fz);
          // Tête
          const head = new THREE.Mesh(new THREE.SphereGeometry(3.4, 8, 8), figMat);
          head.scale.set(1, 1, 0.65);
          head.position.set(fx, midY + 9.5, fz + outSign * 0.4);
          // Bouclier / attribut en relief alterné
          const prop = new THREE.Mesh(
            i % 2 === 0 ? new THREE.CylinderGeometry(4.5, 4.5, 2.2, 10) : new THREE.BoxGeometry(2.4, 22, 2.2),
            figMat
          );
          if (i % 2 === 0) prop.rotation.x = Math.PI / 2;
          prop.position.set(fx + 5.5, midY - 1, fz + outSign * 0.8);

          group.add(body, head, prop);
        }

        this.rootGroup.add(group);
      };

      buildFriezeOnFlank(g.flancG, 'left');
      buildFriezeOnFlank(g.flancD, 'right');
    }

    // 2. Boîte-tiroir amovible collée derrière l'Escalier #25
    if (vs.showDrawerBox && m.stairPiece && visibleSet.has(m.stairPiece.id)) {
      const st = m.stairPiece;
      const wallT = 5;
      const dW = m.drawerW;
      const dH = m.drawerH;
      const dD = m.drawerD;
      const boxGroup = new THREE.Group();
      const boxMat = new THREE.MeshStandardMaterial({
        color: vs.paintedPodium ? 0xcabca5 : 0x93c5fd,
        roughness: 0.8,
      });
      const addWall = (w, h, d, lx, ly, lz) => {
        const gBox = new THREE.BoxGeometry(w, h, d);
        const mesh = new THREE.Mesh(gBox, boxMat);
        mesh.position.set(lx, ly, lz);
        mesh.castShadow = true;
        boxGroup.add(mesh);
        const ed = new THREE.LineSegments(new THREE.EdgesGeometry(gBox), new THREE.LineBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.65 }));
        ed.position.copy(mesh.position);
        boxGroup.add(ed);
      };
      // Fond bas, fond arrière, flanc G, flanc D
      addWall(dD, wallT, dW, 0, -dH / 2 + wallT / 2, 0);
      addWall(wallT, dH, dW, -dD / 2 + wallT / 2, 0, 0);
      addWall(dD, dH, wallT, 0, 0, -dW / 2 + wallT / 2);
      addWall(dD, dH, wallT, 0, 0, dW / 2 - wallT / 2);

      // Placé juste derrière le tenon des tranches 2/6..6/6 (y = 10..57)
      boxGroup.position.set(
        st.x - dD / 2 + openStairsShift,
        10 + dH / 2 + 1,
        st.z + st.dz / 2
      );
      this.rootGroup.add(boxGroup);
    }

    // 3. Bandes de scotch de masquage jaunes (zones à garder nues avant peinture)
    if (vs.showMaskingZones) {
      const tapeMat = new THREE.MeshStandardMaterial({ color: 0xfde047, roughness: 0.6 });
      if (vs.showMaskingZones === 'flanks') {
        for (const fl of [b.bFlancG, b.bFlancD]) {
          for (const yPos of [fl.minY - 0.3, fl.maxY + 0.3]) {
            const tape = new THREE.Mesh(new THREE.BoxGeometry(fl.dx, 0.8, fl.dz + 0.4), tapeMat);
            tape.position.set(fl.minX + fl.dx / 2, yPos, fl.minZ + fl.dz / 2);
            this.rootGroup.add(tape);
          }
        }
      } else if (vs.showMaskingZones === 'columns') {
        for (const col of g.allColumns) {
          const pad = new THREE.Mesh(new THREE.BoxGeometry(col.dx - 4, 0.8, col.dz - 4), tapeMat);
          pad.position.set(col.x + col.dx / 2, col.y + 0.5, col.z + col.dz / 2);
          this.rootGroup.add(pad);
        }
      }
    }

    // 4. Porte Monumentale en Bronze (Embrasure 3D sur le Mur Avant de la Cella)
    if (vs.showBronzeDoor && g.murAvCella[0] && visibleSet.has(g.murAvCella[0].id)) {
      const wall = g.murAvCella[0];
      const doorGroup = new THREE.Group();
      const frontX = wall.x + wall.dx;
      const midZ = wall.z + wall.dz / 2;
      const baseY = wall.y;

      // Vantaux en bronze à plat (70 × 117 mm)
      const doorTex = this._getBronzeDoorTexture();
      const bronzePanel = new THREE.Mesh(
        new THREE.PlaneGeometry(72, 118),
        new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.55, metalness: 0.35 })
      );
      bronzePanel.rotation.y = Math.PI / 2;
      bronzePanel.position.set(frontX + 0.6, baseY + 60, midZ);
      doorGroup.add(bronzePanel);

      // Cadre en marbre en relief de 4 mm (embrasure réelle)
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xe6dcc8, roughness: 0.7 });
      const friezeBlueMat = new THREE.MeshStandardMaterial({ color: 0x3b6e8c, roughness: 0.78 });
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.6 });
      const addRelief = (wZ, hY, dX, yCenter, zCenter, mat = frameMat) => {
        const gR = new THREE.BoxGeometry(dX, hY, wZ);
        const mR = new THREE.Mesh(gR, mat);
        mR.position.set(frontX + dX / 2, yCenter, zCenter);
        mR.castShadow = true;
        doorGroup.add(mR);
        const ed = new THREE.LineSegments(new THREE.EdgesGeometry(gR), edgeMat);
        ed.position.copy(mR.position);
        doorGroup.add(ed);
      };
      // Seuil, Montant gauche, Montant droit, Frise bleue, Corniche 114 mm
      addRelief(100, 6, 4.5, baseY + 3, midZ);
      addRelief(11, 126, 4.5, baseY + 68, midZ - 41);
      addRelief(11, 126, 4.5, baseY + 68, midZ + 41);
      addRelief(92, 14, 4.5, baseY + 136, midZ, friezeBlueMat);
      addRelief(114, 11, 6.5, baseY + 150, midZ);

      this.rootGroup.add(doorGroup);
    }

    // 5. Intérieurs fresqués pompéiens des 24 cases (visibles quand les portes sont absentes ou ouvertes)
    if (vs.showInteriorFrescoes && g.allPlugs24.length > 0) {
      const palette = [0x993322, 0x2c5e7a, 0xb87d2e, 0x3f6b4b, 0x8a3d3d, 0x334e68];
      const depth = m.caseDepthHalf - 2;
      for (const plug of g.allPlugs24) {
        const isLeft = plug.plugSide === 'left' || plug.adventNum <= 12;
        const col = palette[(plug.adventNum - 1) % palette.length];
        const fMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.88, side: THREE.DoubleSide });
        const floorMat = new THREE.MeshStandardMaterial({ color: 0xd6c3a1, roughness: 0.9, side: THREE.DoubleSide });

        // Mur de fond au centre (z = 15 + 90 = 105)
        const backZ = isLeft ? (plug.z + depth) : (plug.z + plug.dz - depth);
        const backMesh = new THREE.Mesh(new THREE.PlaneGeometry(plug.dx - 2, plug.dy - 2), fMat);
        backMesh.position.set(plug.x + plug.dx / 2, plug.y + plug.dy / 2, backZ);
        this.rootGroup.add(backMesh);

        // Sol mosaïque
        const floorZ = isLeft ? (plug.z + depth / 2 + 2) : (plug.z + plug.dz - depth / 2 - 2);
        const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(plug.dx - 2, depth - 4), floorMat);
        floorMesh.rotation.x = -Math.PI / 2;
        floorMesh.position.set(plug.x + plug.dx / 2, plug.y + 0.6, floorZ);
        this.rootGroup.add(floorMesh);

        // Deux parois latérales de la bande en U (fresque continue)
        const sideW = depth - 4;
        const sideL = new THREE.Mesh(new THREE.PlaneGeometry(sideW, plug.dy - 2), fMat);
        sideL.rotation.y = Math.PI / 2;
        sideL.position.set(plug.x + 0.6, plug.y + plug.dy / 2, floorZ);
        const sideR = new THREE.Mesh(new THREE.PlaneGeometry(sideW, plug.dy - 2), fMat);
        sideR.rotation.y = -Math.PI / 2;
        sideR.position.set(plug.x + plug.dx - 0.6, plug.y + plug.dy / 2, floorZ);
        this.rootGroup.add(sideL, sideR);
      }
    }

    // 6. Faîtage (tuiles faîtières) au sommet du toit
    if (vs.showTiles && g.roofLeft[0] && visibleSet.has(g.roofLeft[0].id)) {
      const bR = b.bRoof;
      const exp = step.scene?.explodeMap?.[g.roofLeft[0].id] || { dx: 0, dy: 0, dz: 0 };
      const ridgeG = new THREE.CylinderGeometry(7, 7, bR.dx + 4, 10, 1, false, 0, Math.PI);
      ridgeG.rotateZ(Math.PI / 2);
      ridgeG.rotateX(-Math.PI / 2);
      const ridgeM = new THREE.Mesh(
        ridgeG,
        new THREE.MeshStandardMaterial({ color: 0xa4442b, roughness: 0.82 })
      );
      ridgeM.position.set(
        bR.minX + bR.dx / 2 + (exp.dx || 0) * this.explodeFactor,
        bR.maxY + 4 + (exp.dy || 0) * this.explodeFactor,
        bR.minZ + bR.dz / 2
      );
      ridgeM.castShadow = true;
      this.rootGroup.add(ridgeM);
    }
  }

  _buildLegoArrow(fromArr, toArr) {
    const from = new THREE.Vector3(...fromArr);
    const to = new THREE.Vector3(...toArr);
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = Math.max(12, dir.length());
    const headLen = Math.min(14, len * 0.42);
    const shaftLen = Math.max(4, len - headLen);

    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x991b1b,
      emissiveIntensity: 0.25,
      roughness: 0.35,
    });

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, shaftLen, 12), mat);
    shaft.position.y = shaftLen / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(6.8, headLen, 14), mat);
    head.position.y = shaftLen + headLen / 2;

    group.add(shaft, head);
    group.position.copy(from);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return group;
  }

  _createLabelSprite(text, isActive) {
    const key = `lbl_${text}_${isActive ? 1 : 0}`;
    if (!this.textureCache.has(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = isActive ? '#dc2626' : '#0f172a';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.roundRect(8, 8, 112, 48, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 28px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 33);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textureCache.set(key, tex);
    }
    const mat = new THREE.SpriteMaterial({
      map: this.textureCache.get(key),
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(isActive ? 34 : 24, isActive ? 17 : 12, 1);
    sp.renderOrder = 999;
    return sp;
  }

  _getDoorNumberTexture(num, bgHex) {
    const key = `doornum_${num}_${bgHex}`;
    if (this.textureCache.has(key)) return this.textureCache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bgHex;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(69, 53, 36, 0.35)';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, 112, 112);

    ctx.fillStyle = '#7c2d12';
    ctx.font = '800 50px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 64, 66);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set(key, tex);
    return tex;
  }

  _getArchitraveTexture(bgHex) {
    const key = `arch_${bgHex}`;
    if (this.textureCache.has(key)) return this.textureCache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bgHex;
    ctx.fillRect(0, 0, 1024, 64);

    ctx.fillStyle = '#1c1917';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 23px Georgia, "Times New Roman", serif';
    ctx.fillText('M O R G A N A E · O P T I M A E · M A X I M A E', 512, 21);
    ctx.font = '800 19px Georgia, "Times New Roman", serif';
    ctx.fillText('D A V I D · F E C I T · E T · D · D · L · M', 512, 46);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set(key, tex);
    return tex;
  }

  _getTileTexture() {
    if (this.textureCache.has('tiles')) return this.textureCache.get('tiles');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#b4533a';
    ctx.fillRect(0, 0, 512, 256);

    // Rangées de tuiles romaines (tegulae + imbrices)
    const cols = 16;
    const rows = 6;
    const cw = 512 / cols;
    const rh = 256 / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const shade = ((r * 7 + c * 13) % 5) * 6 - 12;
        ctx.fillStyle = `rgb(${182 + shade}, ${84 + Math.round(shade * 0.6)}, ${58 + Math.round(shade * 0.5)})`;
        ctx.fillRect(c * cw + 1, r * rh + 1, cw - 2, rh - 2);
        // Nervure imbrex
        ctx.fillStyle = 'rgba(255, 228, 196, 0.22)';
        ctx.fillRect(c * cw, r * rh, 4, rh);
        ctx.fillStyle = 'rgba(40, 15, 10, 0.35)';
        ctx.fillRect(c * cw + 4, r * rh, 3, rh);
      }
      // Ombre de chevauchement horizontal
      ctx.fillStyle = 'rgba(30, 12, 8, 0.38)';
      ctx.fillRect(0, (r + 1) * rh - 3, 512, 3);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set('tiles', tex);
    return tex;
  }

  _getBronzeDoorTexture() {
    if (this.externalImages.porte) return this.externalImages.porte;
    if (this.textureCache.has('porte_fallback')) return this.textureCache.get('porte_fallback');

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 384;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#435b52'; // Bronze vert-de-gris patiné
    ctx.fillRect(0, 0, 256, 384);
    ctx.strokeStyle = '#24302b';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 236, 364);
    ctx.beginPath();
    ctx.moveTo(128, 10);
    ctx.lineTo(128, 374);
    ctx.stroke();

    // Caissons & anneaux de bronze
    ctx.strokeStyle = '#6f8574';
    ctx.lineWidth = 4;
    for (const x of [24, 140]) {
      ctx.strokeRect(x, 30, 92, 65);
      ctx.strokeRect(x, 115, 92, 115);
      ctx.strokeRect(x, 250, 92, 105);
      ctx.beginPath();
      ctx.arc(x + 46, 172, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set('porte_fallback', tex);
    return tex;
  }

  _getFrontonTexture(isFront) {
    const extKey = isFront ? 'fronton' : 'pignon';
    if (this.externalImages[extKey]) return this.externalImages[extKey];

    const cacheKey = `tri_fallback_${extKey}`;
    if (this.textureCache.has(cacheKey)) return this.textureCache.get(cacheKey);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#365e78'; // Bleu égyptien patiné
    ctx.fillRect(0, 0, 512, 160);

    // Motif doré central (Soleil Saturnales ou Lune d'hiver)
    ctx.fillStyle = '#d4a648';
    ctx.strokeStyle = '#e7d5a8';
    ctx.lineWidth = 5;
    if (isFront) {
      ctx.beginPath();
      ctx.arc(256, 100, 28, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI * 2) / 12;
        ctx.beginPath();
        ctx.moveTo(256 + Math.cos(a) * 32, 100 + Math.sin(a) * 32);
        ctx.lineTo(256 + Math.cos(a) * 48, 100 + Math.sin(a) * 48);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(256, 102, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#365e78';
      ctx.beginPath();
      ctx.arc(268, 96, 22, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set(cacheKey, tex);
    return tex;
  }

  /**
   * Calcule la boîte englobante actuelle du rootGroup et place la caméra isométrique proprement.
   */
  setCameraPreset(preset = 'iso-front-right', zoomPad = 1.22) {
    const box = new THREE.Box3().setFromObject(this.rootGroup);
    if (box.isEmpty()) {
      box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(380, 280, 210));
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxSpan = Math.max(size.x, size.y, size.z, 120);
    const dist = maxSpan * 2.2;

    const dirs = {
      'iso-front-right': new THREE.Vector3(1.05, 0.72, 1.05),
      'iso-front-left':  new THREE.Vector3(1.05, 0.72, -1.05),
      'iso-back':        new THREE.Vector3(-1.05, 0.75, 1.0),
      'front':           new THREE.Vector3(1.4, 0.2, 0.01),
      'flank-right':     new THREE.Vector3(0.22, 0.28, 1.4),
      'flank-left':      new THREE.Vector3(0.22, 0.28, -1.4),
      'top':             new THREE.Vector3(0.05, 1.6, 0.25),
    };
    const d = (dirs[preset] || dirs['iso-front-right']).clone().normalize();

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.camera.lookAt(center);

    // Ajuster exactement le frustum orthographique pour que tout tienne sans rognage
    const rect = this.container.getBoundingClientRect();
    const aspect = Math.max(0.5, (rect.width || 800) / Math.max(1, rect.height || 520));
    const projectedRadius = Math.hypot(size.x, size.y, size.z) * 0.56 * zoomPad;
    this.frustumSize = Math.max(150, projectedRadius * 2);

    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Capture une image PNG haute définition d'une étape (pour le livret A4 imprimable / PDF).
   */
  captureStepImage(step, width = 960, height = 600, opts = {}) {
    const prevStep = this.currentStep;
    const prevExplode = this.explodeFactor;
    const prevLabels = this.showLabels;
    const prevForce = this.forceFullTemple;

    const prevSize = new THREE.Vector2();
    this.renderer.getSize(prevSize);

    this.explodeFactor = opts.explodeFactor ?? 0.65;
    this.showLabels = opts.showLabels ?? true;
    this.forceFullTemple = opts.forceFullTemple ?? false;

    const aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.renderStep(step, false);

    // Recadrer la caméra sur le ratio exactement demandé (width/height)
    const box = new THREE.Box3().setFromObject(this.rootGroup);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const maxSpan = Math.max(size.x, size.y, size.z, 120);
    const dist = maxSpan * 2.2;
    const preset = opts.cameraPreset || step.scene?.camera?.preset || 'iso-front-right';
    const zoomPad = opts.zoomPad || step.scene?.camera?.zoomPad || 1.2;

    const dirs = {
      'iso-front-right': new THREE.Vector3(1.05, 0.72, 1.05),
      'iso-front-left':  new THREE.Vector3(1.05, 0.72, -1.05),
      'iso-back':        new THREE.Vector3(-1.05, 0.75, 1.0),
      'front':           new THREE.Vector3(1.4, 0.2, 0.01),
      'flank-right':     new THREE.Vector3(0.22, 0.28, 1.4),
      'flank-left':      new THREE.Vector3(0.22, 0.28, -1.4),
      'top':             new THREE.Vector3(0.05, 1.6, 0.25),
    };
    const d = (dirs[preset] || dirs['iso-front-right']).clone().normalize();
    this.camera.position.copy(center).addScaledVector(d, dist);
    this.camera.lookAt(center);

    const projectedRadius = Math.hypot(size.x, size.y, size.z) * 0.54 * zoomPad;
    const fSize = Math.max(150, projectedRadius * 2);
    this.camera.left = (-fSize * aspect) / 2;
    this.camera.right = (fSize * aspect) / 2;
    this.camera.top = fSize / 2;
    this.camera.bottom = -fSize / 2;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL('image/png');

    // Restaurer l'état interactif précédent
    this.explodeFactor = prevExplode;
    this.showLabels = prevLabels;
    this.forceFullTemple = prevForce;
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.resize();
    if (prevStep) this.renderStep(prevStep, true);

    return dataUrl;
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
