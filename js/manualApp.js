// Contrôleur de la Notice de Montage façon LEGO (Vue interactive + Export Livret A4 / PDF)

import {
  MANUAL_PROGRESS_KEY,
  loadPlanData,
  buildAssemblyManual
} from './manualSteps.js';
import { LegoManualRenderer3D } from './manualRenderer3d.js';
import { THICKNESS_COLORS } from './templeGenerator.js';
import { snapToAllowedThickness } from './platePacker.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Formate **gras**, *italique* et `code` dans nos consignes sans HTML dangereux.
 */
function formatInlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function getPartSvgIcon(part) {
  if (part.kind === 'supply') return `<span>${part.icon || '🛠️'}</span>`;
  const fill = part.kind === 'plastic' ? '#f8fafc' : (THICKNESS_COLORS[part.thickness] || '#f59e0b');
  if (part.shape === 'prism_z') {
    return `<svg viewBox="0 0 32 24" width="28" height="22"><polygon points="3,21 29,21 16,3" fill="${fill}" fill-opacity="0.7" stroke="#0f172a" stroke-width="2"/></svg>`;
  }
  if (part.shape === 'stairs') {
    return `<svg viewBox="0 0 32 24" width="28" height="22"><path d="M3,21 L29,21 L29,16 L22,16 L22,11 L15,11 L15,6 L3,6 Z" fill="${fill}" fill-opacity="0.7" stroke="#0f172a" stroke-width="1.8"/></svg>`;
  }
  if (part.shape === 'cylinder_y') {
    return `<svg viewBox="0 0 28 26" width="24" height="22"><rect x="6" y="2" width="16" height="4" fill="#e2e8f0" stroke="#0f172a" stroke-width="1.6"/><rect x="9" y="6" width="10" height="14" fill="#f8fafc" stroke="#0f172a" stroke-width="1.6"/><rect x="6" y="20" width="16" height="4" fill="#e2e8f0" stroke="#0f172a" stroke-width="1.6"/></svg>`;
  }
  if (part.shape === 'roof_slope') {
    return `<svg viewBox="0 0 32 24" width="28" height="22"><polygon points="4,19 24,5 28,9 8,23" fill="${fill}" fill-opacity="0.7" stroke="#0f172a" stroke-width="1.8"/></svg>`;
  }
  return `<svg viewBox="0 0 32 24" width="28" height="22"><rect x="3" y="4" width="26" height="16" rx="1.5" fill="${fill}" fill-opacity="0.65" stroke="#0f172a" stroke-width="1.8"/></svg>`;
}

class LegoManualApp {
  constructor() {
    this.planData = loadPlanData();
    this.manual = buildAssemblyManual(this.planData);
    this.currentIndex = 0;
    this.doneSteps = this._loadDoneSteps();
    this.printMode = 'single'; // 'single' (1 étape/page) | 'double' (2 étapes/page)

    const canvasWrap = document.getElementById('lego-3d-stage');
    const assetBasePath = document.body.dataset.assetsPath || './assets_cases';
    this.renderer3d = new LegoManualRenderer3D(canvasWrap, { assetBasePath });
    this.renderer3d.setManual(this.manual);

    this._bindEvents();
    this._updatePlanSourceBadge();
    this._renderTOC();

    const urlParams = new URLSearchParams(window.location.search);
    const reqStep = Number(urlParams.get('step'));
    const startIdx = Number.isInteger(reqStep) && reqStep >= 1 && reqStep <= this.manual.steps.length ? reqStep - 1 : 0;
    this.goToStep(startIdx);

    const reqPrint = urlParams.get('print');
    if (reqPrint === 'single' || reqPrint === 'double') {
      this.printMode = reqPrint;
      const sel = document.getElementById('sel-print-layout');
      if (sel) sel.value = reqPrint;
      setTimeout(() => this._openAndRenderPrintBooklet(reqPrint), 250);
    }

    window.addEventListener('resize', () => this.renderer3d.resize());
  }

  _loadDoneSteps() {
    try {
      const raw = localStorage.getItem(MANUAL_PROGRESS_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch (e) {}
    return new Set();
  }

  _saveDoneSteps() {
    try {
      localStorage.setItem(MANUAL_PROGRESS_KEY, JSON.stringify(Array.from(this.doneSteps)));
    } catch (e) {}
  }

  _updatePlanSourceBadge() {
    const el = document.getElementById('plan-source-pill');
    if (!el) return;
    const count = this.manual.pieces.length;
    if (this.manual.source === 'localStorage') {
      el.className = 'plan-source-pill';
      el.textContent = `🟢 Plan atelier synchronisé (${count} pcs • tes vrais P#)`;
    } else if (this.manual.source === 'json') {
      el.className = 'plan-source-pill';
      el.textContent = `📂 Plan JSON importé (${count} pcs • tes vrais P#)`;
    } else {
      el.className = 'plan-source-pill is-default';
      el.textContent = `📄 Plan par défaut (${count} pcs — importe ton JSON pour tes P#)`;
    }
  }

  _updateProgressUI() {
    const total = this.manual.steps.length;
    const done = this.manual.steps.filter((s) => this.doneSteps.has(s.stepNum)).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const lbl = document.getElementById('progress-text');
    const fill = document.getElementById('progress-fill');
    if (lbl) lbl.textContent = `${done}/${total}`;
    if (fill) fill.style.width = `${pct}%`;
  }

  _renderTOC() {
    const toc = document.getElementById('toc-list');
    if (!toc) return;

    const html = this.manual.phases.map((phase) => {
      const pSteps = this.manual.steps.filter((s) => s.phaseId === phase.id);
      if (pSteps.length === 0) return '';
      return `
        <div class="toc-phase-group">
          <div class="toc-phase-head" style="background:${phase.bg};color:${phase.color};">
            <span class="toc-bag-num" style="background:${phase.color};">${phase.bag}</span>
            <span>${escapeHtml(phase.label)}</span>
          </div>
          ${pSteps.map((s) => {
            const idx = this.manual.steps.indexOf(s);
            const isActive = idx === this.currentIndex;
            const isDone = this.doneSteps.has(s.stepNum);
            return `
              <button class="toc-step-btn ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}" data-step-idx="${idx}">
                <span class="toc-step-num">${isDone ? '✓' : String(s.stepNum).padStart(2, '0')}</span>
                <div class="toc-step-info">
                  <div class="toc-step-title">${escapeHtml(s.title)}</div>
                  <div class="toc-step-badge">${escapeHtml(s.badge)}${s.dryTime ? ` • ⏱️ ${escapeHtml(s.dryTime)}` : ''}</div>
                </div>
              </button>
            `;
          }).join('')}
        </div>
      `;
    }).join('');

    toc.innerHTML = html;
    toc.querySelectorAll('[data-step-idx]').forEach((btn) => {
      btn.addEventListener('click', () => this.goToStep(Number(btn.dataset.stepIdx)));
    });
    this._updateProgressUI();
  }

  goToStep(index) {
    const total = this.manual.steps.length;
    this.currentIndex = Math.max(0, Math.min(total - 1, index));
    const step = this.manual.steps[this.currentIndex];
    const phase = this.manual.phases.find((p) => p.id === step.phaseId) || this.manual.phases[0];

    // Mettre à jour le tampon numéro d'étape LEGO
    const numEl = document.getElementById('lego-step-number');
    const phaseEl = document.getElementById('lego-step-phase-chip');
    if (numEl) numEl.textContent = String(step.stepNum).padStart(2, '0');
    if (phaseEl) {
      phaseEl.textContent = `Sachet ${phase.bag} • ${step.badge}`;
      phaseEl.style.background = phase.color;
    }

    // Encart Pièces LEGO (haut gauche)
    this._renderPartsBox(step);

    // Panneau consignes (droite)
    this._renderGuidePanel(step, phase);

    // Recalculer la taille du canvas (au cas où l'encart Pièces haut change de hauteur) puis rendre la 3D
    this.renderer3d.resize();
    this.renderer3d.renderStep(step, true);

    // Mettre à jour l'état actif du sommaire
    this._renderTOC();
    const activeBtn = document.querySelector(`.toc-step-btn[data-step-idx="${this.currentIndex}"]`);
    activeBtn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  _renderPartsBox(step) {
    const listEl = document.getElementById('lego-parts-list');
    const countEl = document.getElementById('lego-parts-count');
    if (!listEl) return;

    const parts = step.parts || [];
    if (countEl) countEl.textContent = `${parts.length} élément${parts.length > 1 ? 's' : ''}`;

    listEl.innerHTML = parts.map((pt) => {
      const pills = [];
      if (pt.nums && pt.nums.length > 0) {
        const shown = pt.nums.slice(0, 6);
        for (const n of shown) pills.push(`<span class="pnum-chip">${escapeHtml(n)}</span>`);
        if (pt.nums.length > 6) pills.push(`<span class="pnum-chip">+${pt.nums.length - 6}</span>`);
      }
      if (pt.kind === 'xps') {
        const col = THICKNESS_COLORS[pt.thickness] || '#94a3b8';
        pills.push(`<span class="thick-chip" style="background:${col};">${pt.thickness} mm</span>`);
      } else if (pt.kind === 'plastic') {
        pills.push(`<span class="thick-chip" style="background:#e2e8f0;">Plastique</span>`);
      } else if (pt.badge) {
        pills.push(`<span class="thick-chip" style="background:${pt.color || '#64748b'};color:#ffffff;">${escapeHtml(pt.badge)}</span>`);
      }

      return `
        <div class="lego-part-row">
          <div class="part-icon-box">${getPartSvgIcon(pt)}</div>
          ${pt.kind !== 'supply' ? `<div class="part-qty">${pt.qty}×</div>` : ''}
          <div class="part-meta">
            <div class="part-name">${escapeHtml(pt.label)}</div>
            <div class="part-dims">${escapeHtml(pt.dimText)}</div>
            <div class="part-pills">${pills.join('')}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  _renderGuidePanel(step, phase) {
    const scrollEl = document.getElementById('guide-scroll');
    if (!scrollEl) return;

    const tagsHtml = (step.tags || []).map((t) =>
      `<span class="action-tag kind-${escapeHtml(t.kind || 'info')}">${t.icon} ${escapeHtml(t.label)}</span>`
    ).join('');

    const instrHtml = (step.instructions || []).map((txt, i) => `
      <li>
        <span class="instr-bullet">${i + 1}</span>
        <div>${formatInlineMd(txt)}</div>
      </li>
    `).join('');

    const tipHtml = step.tips ? `
      <div class="tip-callout ${step.tips.kind === 'warning' ? 'warning' : ''}">
        <div class="tip-callout-title">${step.tips.kind === 'warning' ? '⚠️' : '💡'} ${escapeHtml(step.tips.title)}</div>
        <div>${formatInlineMd(step.tips.text)}</div>
      </div>
    ` : '';

    const specsHtml = (step.specs && step.specs.length > 0) ? `
      <div class="specs-card">
        <div class="specs-card-head">📏 Repères & cotes exactes de ton plan</div>
        ${step.specs.map((sp) => `
          <div class="specs-row">
            <span>${escapeHtml(sp.k)}</span>
            <strong>${escapeHtml(sp.v)}</strong>
          </div>
        `).join('')}
      </div>
    ` : '';

    scrollEl.innerHTML = `
      <div class="guide-step-kicker">
        <span class="kicker-badge" style="background:${phase.bg};color:${phase.color};">Étape ${step.stepNum} / ${this.manual.steps.length} • ${escapeHtml(step.badge)}</span>
        <div class="time-badges">
          ${step.duration ? `<span>⏳ ${escapeHtml(step.duration)}</span>` : ''}
          ${step.dryTime ? `<span class="dry-pill">⏱️ ${escapeHtml(step.dryTime)}</span>` : ''}
        </div>
      </div>
      <h2 class="guide-title">${escapeHtml(step.title)}</h2>
      <p class="guide-subtitle">${escapeHtml(step.subtitle)}</p>
      <div class="action-tags-row">${tagsHtml}</div>
      <ol class="instructions-list">${instrHtml}</ol>
      ${tipHtml}
      ${specsHtml}
    `;
    scrollEl.scrollTop = 0;

    // Boutons footer
    const isDone = this.doneSteps.has(step.stepNum);
    const btnDone = document.getElementById('btn-mark-done');
    if (btnDone) {
      btnDone.classList.toggle('is-done', isDone);
      btnDone.textContent = isDone ? '✅ Étape terminée (cliquer pour annuler)' : '☐ Marquer cette étape terminée';
    }
    const btnPrev = document.getElementById('btn-prev-step');
    const btnNext = document.getElementById('btn-next-step');
    if (btnPrev) btnPrev.disabled = this.currentIndex === 0;
    if (btnNext) {
      btnNext.disabled = this.currentIndex >= this.manual.steps.length - 1;
      btnNext.textContent = this.currentIndex >= this.manual.steps.length - 1 ? '🎉 Fin du manuel' : 'Étape suivante →';
    }
  }

  _bindEvents() {
    document.getElementById('btn-prev-step')?.addEventListener('click', () => this.goToStep(this.currentIndex - 1));
    document.getElementById('btn-next-step')?.addEventListener('click', () => this.goToStep(this.currentIndex + 1));

    document.getElementById('btn-mark-done')?.addEventListener('click', () => {
      const step = this.manual.steps[this.currentIndex];
      if (!step) return;
      if (this.doneSteps.has(step.stepNum)) {
        this.doneSteps.delete(step.stepNum);
      } else {
        this.doneSteps.add(step.stepNum);
        if (this.currentIndex < this.manual.steps.length - 1) {
          this._saveDoneSteps();
          this.goToStep(this.currentIndex + 1);
          return;
        }
      }
      this._saveDoneSteps();
      this.goToStep(this.currentIndex);
    });

    // Raccourcis clavier flèches gauche/droite
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (!document.getElementById('print-booklet-overlay')?.classList.contains('hidden')) {
        if (e.key === 'Escape') this._closePrintOverlay();
        return;
      }
      if (e.key === 'ArrowRight') this.goToStep(this.currentIndex + 1);
      else if (e.key === 'ArrowLeft') this.goToStep(this.currentIndex - 1);
    });

    // Contrôles 3D
    const rngExp = document.getElementById('rng-step-explode');
    const lblExp = document.getElementById('lbl-step-explode');
    rngExp?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (lblExp) lblExp.textContent = `${v}%`;
      this.renderer3d.setExplodeFactor(v / 100);
    });

    const btnLabels = document.getElementById('btn-toggle-labels');
    btnLabels?.addEventListener('click', () => {
      const next = !this.renderer3d.showLabels;
      this.renderer3d.setShowLabels(next);
      btnLabels.classList.toggle('active', next);
    });

    const btnFull = document.getElementById('btn-toggle-full');
    btnFull?.addEventListener('click', () => {
      const next = !this.renderer3d.forceFullTemple;
      this.renderer3d.setForceFullTemple(next);
      btnFull.classList.toggle('active', next);
      btnFull.textContent = next ? '🔍 Vue étape' : '🏛️ Temple entier';
    });

    document.querySelectorAll('[data-cam]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.cam;
        if (preset === 'reset') {
          const step = this.manual.steps[this.currentIndex];
          this.renderer3d.setCameraPreset(step?.scene?.camera?.preset || 'iso-front-right', step?.scene?.camera?.zoomPad || 1.22);
        } else {
          this.renderer3d.setCameraPreset(preset, 1.2);
        }
      });
    });

    // Import JSON d'un plan personnalisé
    const inpJson = document.getElementById('input-manual-json');
    document.getElementById('btn-manual-import')?.addEventListener('click', () => inpJson?.click());
    inpJson?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!Array.isArray(parsed.pieces) || parsed.pieces.length === 0) {
            alert('Ce fichier JSON ne contient pas de pièces de temple valides.');
            return;
          }
          this.planData = loadPlanData(parsed);
          this.manual = buildAssemblyManual(this.planData);
          this.renderer3d.setManual(this.manual);
          this._updatePlanSourceBadge();
          this.goToStep(0);
        } catch (err) {
          alert('Fichier JSON invalide.');
        }
      };
      reader.readAsText(file);
      inpJson.value = '';
    });

    // Livret A4 imprimable / PDF
    document.getElementById('btn-open-print-booklet')?.addEventListener('click', () => {
      this._openAndRenderPrintBooklet(this.printMode);
    });
    document.getElementById('btn-close-print-overlay')?.addEventListener('click', () => {
      this._closePrintOverlay();
    });
    document.getElementById('btn-launch-print')?.addEventListener('click', () => {
      window.print();
    });
    document.getElementById('sel-print-layout')?.addEventListener('change', (e) => {
      this.printMode = e.target.value;
      this._openAndRenderPrintBooklet(this.printMode);
    });
  }

  _closePrintOverlay() {
    document.getElementById('print-booklet-overlay')?.classList.add('hidden');
  }

  /**
   * Génère toutes les pages A4 Paysage du livret façon LEGO avec captures 3D HD à la volée.
   */
  async _openAndRenderPrintBooklet(mode = 'single') {
    const overlay = document.getElementById('print-booklet-overlay');
    const progBanner = document.getElementById('print-progress-banner');
    const pagesWrap = document.getElementById('print-pages-container');
    if (!overlay || !pagesWrap) return;

    overlay.classList.remove('hidden');
    pagesWrap.innerHTML = '';
    if (progBanner) {
      progBanner.classList.remove('hidden');
      progBanner.textContent = '⏳ Préparation du livret A4 façon LEGO (rendu 3D de la couverture)…';
    }

    await new Promise((r) => setTimeout(r, 30));

    // 1. Capture de la couverture (temple fini)
    const coverImg = this.renderer3d.captureStepImage(this.manual.steps[0], 1120, 720, {
      explodeFactor: 0,
      showLabels: false,
      cameraPreset: 'iso-front-right',
      zoomPad: 0.90,
    });

    // 2. Capture de chaque étape
    const captures = [];
    const total = this.manual.steps.length;
    for (let i = 0; i < total; i++) {
      const st = this.manual.steps[i];
      if (progBanner) {
        progBanner.textContent = `⏳ Rendu 3D isométrique de l’étape ${st.stepNum} / ${total} — ${st.title}…`;
      }
      await new Promise((r) => setTimeout(r, 12));
      const imgUrl = this.renderer3d.captureStepImage(st, 960, 600, {
        explodeFactor: st.stepNum === total ? 0.55 : 0.65,
        showLabels: true,
      });
      captures.push(imgUrl);
    }

    if (progBanner) progBanner.classList.add('hidden');

    // Construire toutes les pages A4
    const sheetsHtml = [];
    sheetsHtml.push(this._buildCoverSheetHtml(coverImg));
    sheetsHtml.push(this._buildInventorySheetHtml());

    if (mode === 'double') {
      for (let i = 0; i < total; i += 2) {
        const s1 = this.manual.steps[i];
        const s2 = this.manual.steps[i + 1] || null;
        sheetsHtml.push(this._buildCompactTwoStepSheetHtml(s1, captures[i], s2, s2 ? captures[i + 1] : null));
      }
    } else {
      for (let i = 0; i < total; i++) {
        sheetsHtml.push(this._buildSingleStepSheetHtml(this.manual.steps[i], captures[i]));
      }
    }

    pagesWrap.innerHTML = sheetsHtml.join('\n');
  }

  _buildCoverSheetHtml(coverImg) {
    const b = this.manual.geom.bounds.bAll;
    const totalPcs = this.manual.pieces.length;
    const phasesHtml = this.manual.phases.map((ph) => {
      const pSteps = this.manual.steps.filter((s) => s.phaseId === ph.id);
      if (pSteps.length === 0) return '';
      const range = pSteps.length === 1
        ? `Étape ${pSteps[0].stepNum}`
        : `Étapes ${pSteps[0].stepNum} à ${pSteps[pSteps.length - 1].stepNum}`;
      return `
        <div class="cover-phase-item">
          <span class="toc-bag-num" style="background:${ph.color};">${ph.bag}</span>
          <div style="flex:1;"><strong>${escapeHtml(ph.label)}</strong></div>
          <span style="font-size:8pt;font-weight:700;color:#475569;">${range}</span>
        </div>
      `;
    }).join('');

    return `
      <section class="a4-sheet a4-cover">
        <div class="cover-top">
          <div class="cover-title-block">
            <div style="display:inline-block;background:#facc15;color:#0f172a;font-weight:900;font-size:8.5pt;padding:1mm 3mm;border-radius:1.5mm;margin-bottom:2mm;">NOTICE DE MONTAGE • FAÇON LEGO</div>
            <h2>TEMPLE ROMAIN — CALENDRIER 25 CASES</h2>
            <div class="cover-dedication">MORGANAE · OPTIMAE · MAXIMAE — DAVID · FECIT · ET · D · D · L · M</div>
          </div>
          <div style="text-align:right;font-size:9pt;">
            <div><strong>${totalPcs} pièces</strong> (${this.manual.steps.length} étapes)</div>
            <div>Gabarit : <strong>${(b.dx / 10).toFixed(1)} × ${(b.dz / 10).toFixed(1)} × H ${(b.dy / 10).toFixed(1)} cm</strong></div>
            <div>Échelle ≈ <strong>1:50</strong> • Polystyrène XPS 6/10/20 mm</div>
          </div>
        </div>

        <div class="cover-mid">
          <img class="cover-hero-img" src="${coverImg}" alt="Vue 3D du Temple Romain fini" />
          <div class="cover-phases-grid">
            <div style="font-size:9.5pt;font-weight:900;text-transform:uppercase;color:#0f172a;margin-bottom:1mm;">📦 Sommaire des 6 Phases de montage</div>
            ${phasesHtml}
            <div style="margin-top:2mm;padding:2.5mm;background:#fef2f2;border:1px solid #fecaca;border-radius:2mm;font-size:8pt;color:#7f1d1d;">
              <strong>⚠️ Règle d’or :</strong> Coller toute la structure XPS <strong>mousse-sur-mousse AVANT peinture</strong> (colle à bois prise rapide). Réserver le <strong>Mod Podge mat</strong> au mélange sous-couche 50/50 et aux fresques papier.
            </div>
          </div>
        </div>

        <div class="cover-bottom">
          <span>🏛️ Atelier Temple Romain — Livret généré avec tes vrais numéros P# (${this.manual.source === 'default' ? 'plan par défaut' : 'plan personnalisé'})</span>
          <span>Format A4 Paysage • Imprimer à 100 %</span>
        </div>
      </section>
    `;
  }

  _buildInventorySheetHtml() {
    const byGroup = { 20: [], 10: [], 6: [], plastic: [] };
    for (const p of this.manual.pieces) {
      if (p.material === 'plastic' || p.shape === 'cylinder_y') {
        byGroup.plastic.push(p);
      } else {
        const t = snapToAllowedThickness(p.thickness || 10);
        byGroup[t].push(p);
      }
    }

    const renderGroupRows = (list) => {
      const map = new Map();
      for (const p of list) {
        const label = p.name.replace(/\s*\(Partie\s+\d+\/\d+\)/gi, '').replace(/\s*N°\d+|\s*#\d+/g, '').trim();
        const dim = p.shape === 'cylinder_y'
          ? `${Math.round(p.dx)}×${Math.round(p.dz)}×${Math.round(p.dy)}`
          : p.shape === 'prism_z'
            ? `△ ${Math.round(p.cutW)}×${Math.round(p.cutH)}`
            : p.shape === 'stairs'
              ? `6 tranches L ${Math.round(p.dz)}`
              : `${Math.round(Math.max(p.cutW, p.cutH))}×${Math.round(Math.min(p.cutW, p.cutH))}`;
        const key = `${label}__${dim}`;
        if (!map.has(key)) map.set(key, { label, dim, qty: 0, nums: [] });
        const e = map.get(key);
        e.qty += 1;
        if (p.pieceNum) e.nums.push(`P${p.pieceNum}`);
      }
      return Array.from(map.values()).map((e) => `
        <tr>
          <td style="font-weight:800;white-space:nowrap;">☐ ${e.qty}×</td>
          <td><strong>${escapeHtml(e.label)}</strong><div style="color:#0369a1;font-family:monospace;font-size:6.8pt;">${escapeHtml(e.nums.join(', '))}</div></td>
          <td style="text-align:right;white-space:nowrap;font-weight:700;">${escapeHtml(e.dim)}</td>
        </tr>
      `).join('');
    };

    return `
      <section class="a4-sheet">
        <div class="a4-step-head">
          <div>
            <strong style="font-size:14pt;">📋 INVENTAIRE DES PIÈCES & MATÉRIEL (TES VRAIS N° P#)</strong>
            <div style="font-size:8.5pt;color:#475569;">Contrôle complet avant démarrage — toutes dimensions en millimètres</div>
          </div>
          <span style="font-size:9pt;font-weight:800;background:#facc15;padding:1.5mm 3.5mm;border-radius:1.5mm;">${this.manual.pieces.length} pièces</span>
        </div>

        <div class="inv-grid">
          <div class="inv-col">
            <h4>🟧 Polystyrène XPS 10 mm (${byGroup[10].length} pcs)</h4>
            <table class="inv-table"><tbody>${renderGroupRows(byGroup[10])}</tbody></table>
          </div>
          <div class="inv-col">
            <h4>🟦 Polystyrène XPS 6 mm (${byGroup[6].length} pcs)</h4>
            <table class="inv-table"><tbody>${renderGroupRows(byGroup[6])}</tbody></table>
            <h4 style="margin-top:4mm;">🟥 XPS 20 mm (${byGroup[20].length} pcs) &amp; 🏛️ Plastique (${byGroup.plastic.length})</h4>
            <table class="inv-table"><tbody>${renderGroupRows([...byGroup[20], ...byGroup.plastic])}</tbody></table>
          </div>
          <div class="inv-col">
            <h4>🧰 Consommables &amp; Quincaillerie</h4>
            <table class="inv-table">
              <tbody>
                <tr><td>☐</td><td><strong>Colle à bois prise rapide (PVA)</strong></td><td style="text-align:right;">Structure XPS</td></tr>
                <tr><td>☐</td><td><strong>Colle polymère sans solvant / Époxy</strong></td><td style="text-align:right;">Colonnes, tuiles, métal</td></tr>
                <tr><td>☐</td><td><strong>Enduit rebouchage allégé Axton</strong></td><td style="text-align:right;">Fresques figurines + joints</td></tr>
                <tr><td>☐</td><td><strong>Mod Podge mat</strong></td><td style="text-align:right;">Sous-couche 50/50 + papier</td></tr>
                <tr><td>☐</td><td><strong>Acryliques &amp; Vernis mat</strong></td><td style="text-align:right;">Gris, travertin, ombre, terracotta</td></tr>
                <tr><td>☐</td><td><strong>48× Mini-charnières 8×10 mm</strong></td><td style="text-align:right;">B08BFNM9ZQ + clous 15–20 mm</td></tr>
                <tr><td>☐</td><td><strong>24× Boutons bronze + rondelles</strong></td><td style="text-align:right;">B08J7D5C9R (Ø12×11 mm)</td></tr>
                <tr><td>☐</td><td><strong>3–4× Plaques tuiles 250×125 mm</strong></td><td style="text-align:right;">Couverture 2 versants</td></tr>
                <tr><td>☐</td><td><strong>Impressions A4 1:1 (160–200 g/m²)</strong></td><td style="text-align:right;">24 cases + 2 pages Façade</td></tr>
                <tr><td>☐</td><td><strong>Boîte-tiroir #25 (carton/XPS 6 mm)</strong></td><td style="text-align:right;">${this.manual.geom.metrics.drawerW}×${this.manual.geom.metrics.drawerD}×${this.manual.geom.metrics.drawerH}</td></tr>
                <tr><td>☐</td><td><strong>Scotch de masquage + papier sulfurisé</strong></td><td style="text-align:right;">Protections collage</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="a4-foot">
          <span>Inventaire complet — Temple Romain Calendrier 25 Cases</span>
          <span>Page 2</span>
        </div>
      </section>
    `;
  }

  _buildSingleStepSheetHtml(step, imgUrl) {
    const phase = this.manual.phases.find((p) => p.id === step.phaseId) || this.manual.phases[0];
    const partsHtml = (step.parts || []).map((pt) => {
      const nums = pt.nums && pt.nums.length > 0
        ? `<span class="pnum-chip">${escapeHtml(pt.nums.slice(0, 6).join(', '))}${pt.nums.length > 6 ? ` +${pt.nums.length - 6}` : ''}</span>`
        : '';
      return `
        <div class="a4-part-pill">
          <strong>${pt.kind !== 'supply' ? `${pt.qty}×` : (pt.icon || '🛠️')}</strong>
          <span>${escapeHtml(pt.label)}</span>
          ${nums}
          <span style="color:#475569;">(${escapeHtml(pt.dimText)})</span>
        </div>
      `;
    }).join('');

    const tagsHtml = (step.tags || []).map((t) =>
      `<span class="action-tag kind-${escapeHtml(t.kind || 'info')}" style="font-size:7.5pt;padding:1mm 2mm;">${t.icon} ${escapeHtml(t.label)}</span>`
    ).join('');

    const instrHtml = (step.instructions || []).map((txt, i) => `
      <li>
        <span class="a4-instr-num">${i + 1}</span>
        <div>${formatInlineMd(txt)}</div>
      </li>
    `).join('');

    const tipHtml = step.tips ? `
      <div class="a4-tip-box ${step.tips.kind === 'warning' ? 'warning' : ''}">
        <strong>${step.tips.kind === 'warning' ? '⚠️' : '💡'} ${escapeHtml(step.tips.title)} :</strong>
        ${formatInlineMd(step.tips.text)}
      </div>
    ` : '';

    return `
      <section class="a4-sheet">
        <div class="a4-step-head">
          <div style="display:flex;align-items:center;gap:4mm;">
            <div class="a4-step-num-big">${String(step.stepNum).padStart(2, '0')}</div>
            <div>
              <div style="display:flex;align-items:center;gap:2.5mm;margin-bottom:0.8mm;">
                <span style="background:${phase.color};color:#fff;font-size:7.5pt;font-weight:800;padding:0.6mm 2.2mm;border-radius:1.2mm;">Sachet ${phase.bag} • ${escapeHtml(phase.label)}</span>
                ${step.duration ? `<span style="font-size:8pt;font-weight:700;color:#475569;">⏳ ${escapeHtml(step.duration)}</span>` : ''}
                ${step.dryTime ? `<span style="font-size:8pt;font-weight:700;color:#92400e;background:#fef3c7;padding:0.4mm 2mm;border-radius:1mm;">⏱️ Séchage : ${escapeHtml(step.dryTime)}</span>` : ''}
              </div>
              <div style="font-size:13pt;font-weight:900;">${escapeHtml(step.title)}</div>
            </div>
          </div>
          <div style="font-size:10pt;font-weight:800;border:1.5px solid #0f172a;padding:1.2mm 3mm;border-radius:1.5mm;">☐ FAIT</div>
        </div>

        <div class="a4-step-body">
          <div class="a4-visual-col">
            <div class="a4-render-frame">
              <img src="${imgUrl}" alt="Étape ${step.stepNum}" />
            </div>
            <div class="a4-parts-strip">${partsHtml}</div>
          </div>
          <div class="a4-text-col">
            <div style="display:flex;flex-wrap:wrap;gap:1.5mm;">${tagsHtml}</div>
            <ol class="a4-instr-list">${instrHtml}</ol>
            ${tipHtml}
            ${(step.specs && step.specs.length > 0) ? `
              <div style="margin-top:auto;border:1px solid #cbd5e1;border-radius:2mm;padding:2mm 2.5mm;background:#f8fafc;font-size:7.8pt;">
                ${step.specs.map((sp) => `<div style="display:flex;justify-content:space-between;gap:2mm;"><span>${escapeHtml(sp.k)}</span><strong>${escapeHtml(sp.v)}</strong></div>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>

        <div class="a4-foot">
          <span>🏛️ Notice de Montage — Temple de Morgane (${escapeHtml(step.subtitle)})</span>
          <span>Étape ${step.stepNum} / ${this.manual.steps.length}</span>
        </div>
      </section>
    `;
  }

  _buildCompactTwoStepSheetHtml(s1, img1, s2, img2) {
    const renderHalf = (step, imgUrl) => {
      if (!step) return `<div></div>`;
      const phase = this.manual.phases.find((p) => p.id === step.phaseId) || this.manual.phases[0];
      const partsShort = (step.parts || []).slice(0, 4).map((pt) =>
        `<span class="a4-part-pill" style="font-size:6.8pt;padding:0.6mm 1.5mm;"><strong>${pt.kind !== 'supply' ? `${pt.qty}×` : (pt.icon || '•')}</strong> ${escapeHtml(pt.label)}${pt.nums?.length ? ` <span class="pnum-chip" style="font-size:6.5pt;">${escapeHtml(pt.nums.slice(0, 4).join(','))}</span>` : ''}</span>`
      ).join('');
      const instrShort = (step.instructions || []).map((txt, i) => `
        <li style="font-size:7.4pt;line-height:1.28;">
          <span class="a4-instr-num" style="width:4mm;height:4mm;font-size:6.5pt;">${i + 1}</span>
          <div>${formatInlineMd(txt)}</div>
        </li>
      `).join('');

      return `
        <div class="a4-half-step">
          <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1.5px solid #0f172a;padding-bottom:1.2mm;margin-bottom:2mm;">
            <div style="display:flex;align-items:center;gap:2.5mm;">
              <strong style="font-size:17pt;line-height:1;">${String(step.stepNum).padStart(2, '0')}</strong>
              <span style="background:${phase.color};color:#fff;font-size:6.8pt;font-weight:800;padding:0.5mm 1.8mm;border-radius:1mm;">Sachet ${phase.bag}</span>
              <strong style="font-size:10pt;">${escapeHtml(step.title)}</strong>
            </div>
            <span style="font-size:8pt;font-weight:800;">${step.dryTime ? `⏱️ ${escapeHtml(step.dryTime)} • ` : ''}☐ FAIT</span>
          </div>
          <div class="a4-half-body">
            <div style="display:flex;flex-direction:column;gap:1.5mm;min-height:0;">
              <div class="a4-render-frame" style="flex:1;"><img src="${imgUrl}" alt="Étape ${step.stepNum}" /></div>
              <div style="display:flex;flex-wrap:wrap;gap:1.2mm;">${partsShort}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:1.5mm;overflow:hidden;">
              <ol class="a4-instr-list" style="gap:1.3mm;">${instrShort}</ol>
              ${step.tips ? `<div class="a4-tip-box ${step.tips.kind === 'warning' ? 'warning' : ''}" style="font-size:7pt;padding:1.2mm 2mm;margin-top:auto;"><strong>${step.tips.kind === 'warning' ? '⚠️' : '💡'} ${escapeHtml(step.tips.title)} :</strong> ${formatInlineMd(step.tips.text)}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    };

    return `
      <section class="a4-sheet compact-two">
        ${renderHalf(s1, img1)}
        ${renderHalf(s2, img2)}
      </section>
    `;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.legoManualApp = new LegoManualApp();
});
