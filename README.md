# drakar.tech — un monde, calculé par ceux qui le regardent

Page d'accueil de la holding. Aucune vocation. Un seul monde, persistant, commun à tous les
visiteurs : chaque navigateur qui ouvre la page reçoit une région, y simule 240 saisons, et renvoie
le résultat. Le monde n'avance que si quelqu'un le regarde.

## Lancer

    cp .env.example .env      # puis FINNHUB_KEY=… (optionnel)
    npm start                 # Node ≥ 22, aucune dépendance (node:sqlite et WebSocket intégrés)
    # → http://localhost:8787

Variables : `PORT` (8787), `DB` (./monde.db), `SEED` (graine du terrain, ne change rien une fois la base créée).

Ouvrir `demo.html` directement (sans serveur) ou `/?demo` : le monde vit dans l'onglet, avec un passé pré-calculé.

## Architecture

- `public/sim.js` — simulation déterministe partagée serveur/navigateur (agents, génome, unités de travail,
  classe `World` : bail / intégration / chronique). Le terrain est chargé, pas généré (`loadTerrain`).
- `tools/build-terre.mjs` — fabrique les données Terre, une fois (`npm run build:terre -- --etopo … --bmng …
  --land …` ; dépendances de dev : jpeg-js, pngjs, d3-contour) : ETOPO1 (altitude, via la rampe de
  couleurs), Blue Marble (humidité, indice de végétation) et Natural Earth 1:50m (côtes). Entrées :
  `etopo1.jpg` et `bmng.jpg` du paquet PyPI `basemap-data` (simple zip à ouvrir), `land-50m.json` du paquet
  npm `world-atlas`. Sorties versionnées dans `public/` :
  `terre.bin` (grille 384 × 192 : type + fertilité, 147 Ko), `fond.png` (1536 × 768, type et niveau
  d'altitude, 88 Ko), `terres.bin` (1 419 anneaux déroulés, 163 Ko), `cotes.bin` (1 424 arcs, 161 Ko), `niveaux.bin` (courbes 500 / 1000 / 2000 / 3000 /
  4000 m, 182 Ko). Total ~740 Ko, mis en cache par le navigateur.
- `server.js` — HTTP statique + API de lecture (`/api/world`, `/api/market`, `/api/stats`), WebSocket
  `/ws` pour tout le reste, persistance SQLite (état courant, snapshots horaires, journal des unités).
- `market.js` — l'indice comme climat. Avec `FINNHUB_KEY` : cotation SPY (ETF répliquant le S&P 500,
  l'indice lui-même étant payant) en REST au démarrage et toutes les 10 min, puis **trades en direct par
  WebSocket** (`wss://ws.finnhub.io`) — le climat respire pendant la séance, diffusé au plus une fois par
  seconde. Sans clé : Stooq → Yahoo → FRED, puis marche aléatoire datée. Cache SQLite.
- `ws-mini.js` — serveur WebSocket RFC 6455 minimal (texte, fragmentation, ping/pong), sans dépendance.
- `public/index.html` — tout le géographique est rendu par le GPU dans une seule passe WebGL : le disque et
  les classes de terrain (`fond.png`), les **terres** (anneaux Natural Earth remplis par parité de stencil
  dans une texture 4096 × 2048, une fois au chargement), les **côtes et courbes de niveau** (quads extrudés
  dans le vertex shader, indices 16 bits par blocs). Le canvas 2D ne porte que la vie : groupes, comptoirs,
  routes en arcs de grand cercle, régions. Puis HUD, chronique, boucle de calcul. Glisser pour tourner, molette / pincement pour zoomer
  (confiné au globe : la page ne zoome jamais). Après 6 s sans manipulation, la caméra glisse d'elle-même
  vers la région en cours de calcul — la vôtre, sinon celle d'un autre témoin.

### Protocole (WebSocket `/ws`)

Client → serveur : `hello {sigil}` · `lease` · `progress {region, step, agents}` (toutes les 400 ms pendant
le calcul) · `result {result, hash, ms, verify}`.
Serveur → client : `hello {world, peers}` · `unit {unit, verify}` · `ack` / `nack` · `world` · `chronicle` ·
`market {market, climate}` · `online` · `lease` / `progress` / `release` (les autres visiteurs).

1. Le serveur attribue la région la plus en retard, ses groupes, une graine dérivée de
   (graine monde, région, tick) et le climat du moment. Bail de 90 s.
2. Le navigateur exécute `simulateUnitGen` en l'animant (~4 s par unité) et diffuse sa progression :
   **les autres visiteurs voient sa région, son pourcentage et ses groupes bouger en direct**.
3. Le serveur intègre, horodate la chronique, diffuse le nouvel état. Une unité sur 7 est recalculée
   côté serveur (déterminisme → même hash, sinon rejet).

### Reprise après veille / coupure

Le serveur envoie un battement toutes les 20 s. Côté client, 45 s sans message = connexion morte : fermeture
forcée, reconnexion avec backoff (1 → 15 s). Le retour de veille, le retour en ligne, le retour au premier
plan (`pageshow`, `online`, `focus`, `visibilitychange`) déclenchent une vérification immédiate et remettent
le backoff à 1 s. Un bail demandé sans réponse pendant 20 s ferme aussi la connexion. Une unité dont le calcul
a été interrompu plus de 80 s (onglet caché, veille) n'est pas renvoyée : son bail a expiré, la région a été
réattribuée. Côté serveur, le flux Finnhub muet depuis 3 min est fermé et rouvert.

### Climat = marché

Le serveur lit la variation de l'indice depuis la clôture précédente (en direct pendant la séance avec
Finnhub) et la convertit en `climate ∈ [-1, 1]` (`variation % / 1,5`). Quand le régime change
(abondance / ordinaire / disette, seuils ±0,25), la chronique l'annonce : « Les vents tournent ». Cette valeur est **embarquée dans chaque unité de travail**, donc la
simulation reste déterministe et vérifiable. Effets : rendement des terres × (1 + 0,45 climat),
famine plus douce ou plus dure, scissions facilitées en expansion, razzias plus fréquentes en
contraction, portée des routes ± 25 %. Le halo du globe vire à l'ambre en hausse, au bleu en baisse.

### Routes

Un comptoir vieux de 40 saisons s'ouvre vers le comptoir non relié le plus proche, dans une portée qui
grandit avec l'âge du monde (14 → 70 cellules). Entre lignées différentes, seulement après 200 saisons.
Une route qui traverse la mer est « maritime » (pointillés). Chaque route ajoute +12 % de rendement
au comptoir (max 4).

### Règles de vie (v0)

- La terre produit, pas les bras : `vivres += fertilité × 2 × min(pop, capacité) − pop`. Une cellule se partage.
- Un comptoir (fondé après 24 saisons de sédentarité sur une terre fertile) multiplie la production par 1,6.
- La Terre : grille 384 × 192 (0,94° par cellule), 24 régions, calottes gelées (Antarctique, Groenland).
  Fertilité = végétation Blue Marble × altitude × latitude (froid au-delà de 45°). Les seize drakkars accostent
  sur des côtes fertiles de vraies masses continentales (pas d'îlots), entre 58° S et 58° N.
- Génome 8 octets : seuil de faim, attrait de la fertilité, agressivité, errance, seuil de fondation,
  taille de scission, goût du littoral, taux de mutation. Hérité à la scission, muté.
- Pas de sélection explicite : ce qui survit se transmet.

### Pistes

- Grille plus fine + WebGL si le monde doit grossir ; régions 4×3 → 8×6.
- Climat piloté par la télémétrie des visiteurs (batterie faible = hiver, mobile = sécheresse).
- Export snapshot → PNG daté chaque semaine, pour une « frise » publique.
- Le sigle du visiteur est dérivé de sa machine côté client ; l'option serveur (IP + UA) existe en repli.
