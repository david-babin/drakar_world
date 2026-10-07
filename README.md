# drakar.tech — un monde, calculé par ceux qui le regardent

Page d'accueil de la holding. Aucune vocation. Un seul monde, persistant, commun à tous les
visiteurs : chaque navigateur qui ouvre la page reçoit une région, y simule 240 saisons, et renvoie
le résultat. Le monde n'avance que si quelqu'un le regarde.

## Lancer

    node server.js            # Node ≥ 22, aucune dépendance (node:sqlite intégré)
    # → http://localhost:8787

Variables : `PORT` (8787), `DB` (./monde.db), `SEED` (graine du terrain, ne change rien une fois la base créée).

Ouvrir `demo.html` directement (sans serveur) ou `/?demo` : le monde vit dans l'onglet, avec un passé pré-calculé.

## Architecture

- `public/sim.js` — simulation déterministe partagée serveur/navigateur (terrain, agents, génome,
  unités de travail, classe `World` : bail / intégration / chronique).
- `server.js` — HTTP statique + API (`/api/world`, `/api/lease`, `/api/result`, `/api/events` en SSE,
  `/api/stats`), persistance SQLite (état courant, snapshots horaires, journal des unités).
- `public/index.html` — carte canvas, HUD télémétrie, chronique, boucle de calcul.

### Protocole

1. `POST /api/lease {sigil}` → `{unit, verify}` : la région la plus en retard, ses groupes, une graine dérivée
   de (graine monde, région, tick). Bail de 90 s.
2. Le navigateur exécute `simulateUnitGen` en l'animant (budget ~8 ms/frame, ~4 s par unité).
3. `POST /api/result {sigil, result, hash}` : le serveur intègre, horodate la chronique, diffuse le nouvel
   état à tous les onglets. Une unité sur 7 est recalculée côté serveur (déterminisme → même hash,
   sinon rejet).

### Règles de vie (v0)

- La terre produit, pas les bras : `vivres += fertilité × 2 × min(pop, capacité) − pop`. Une cellule se partage.
- Un comptoir (fondé après 24 saisons de sédentarité sur une terre fertile) multiplie la production par 1,6.
- Génome 8 octets : seuil de faim, attrait de la fertilité, agressivité, errance, seuil de fondation,
  taille de scission, goût du littoral, taux de mutation. Hérité à la scission, muté.
- Pas de sélection explicite : ce qui survit se transmet.

### Pistes

- Grille plus fine + WebGL si le monde doit grossir ; régions 4×3 → 8×6.
- Climat piloté par la télémétrie des visiteurs (batterie faible = hiver, mobile = sécheresse).
- Export snapshot → PNG daté chaque semaine, pour une « frise » publique.
- Le sigle du visiteur est dérivé de sa machine côté client ; l'option serveur (IP + UA) existe en repli.
