# 🏛️ Atelier Maquette — Plan 2D, Volume 3D & Calepinage XPS

Application web **100 % autonome** (HTML / CSS / ES Modules + Three.js embarqué localement, zéro dépendance CDN et zéro serveur backend) pour concevoir, éditer et découper des maquettes en polystyrène extrudé (XPS) — incluant le générateur paramétrique du **Temple Romain Calendrier de l'Avent (25 cases)**.

🔗 **Application en ligne :** https://ethoril.github.io/atelier-maquette/

## ✨ Fonctionnalités

- **Plan 2D multi-vues (Côté XY, Dessus XZ, Face ZY)** avec grille aimantée, cotes automatiques en mm, coupe par tranche et outils de dessin de pièces.
- **Volume 3D interactif (Three.js embarqué)** avec vue éclatée, ouverture des 25 bouchons/cases (clic / double-clic), mode Rayons X et badges `P#`.
- **Calepinage automatique (2D Bin-Packing MaxRects)** sur plaques `300 × 200 mm` (6, 10 et 20 mm), emboîtement tête-bêche des triangles et gestion du trait de coupe (kerf).
- **Suivi de découpe persistant** (checklist cochable synchronisée avec les plaques restantes).
- **Studio Fresques (24 cases)** : calcul automatique des cotes 300 DPI, import/glisser-déposer d'images locales (stockées dans `IndexedDB`) et génération de planches **A4 Paysage à l'échelle 1:1** avec règle de calibration 50 mm.
- **Import / Export JSON** (`💾 Exporter` / `📂 Importer`) pour sauvegarder et transférer son plan entre appareils.

## 💾 Transférer un plan existant

Les sauvegardes navigateur (`localStorage`) étant liées au domaine (`localhost:8080` vs `github.io`) :
1. Sur ton instance locale, clique sur **💾 Exporter** pour télécharger `plan_temple_calendrier_avent.json`.
2. Sur https://ethoril.github.io/atelier-maquette/, clique sur **📂 Importer** et choisis ce fichier.

## 📄 Crédits

- [Three.js](https://threejs.org/) `r165` (`vendor/three/`, licence MIT — voir `vendor/three/LICENSE`).
