# drakar.tech — un monde, calculé par ceux qui le regardent

Page d'accueil de la holding. Aucune vocation. Un seul monde, persistant, commun à tous les
visiteurs : chaque navigateur qui ouvre la page reçoit une région, y simule 240 saisons, et renvoie
le résultat. Le monde n'avance que si quelqu'un le regarde.

## Lancer

    cp .env.example .env      # puis FINNHUB_KEY=… (optionnel)
    npm start                 # Node ≥ 22, aucune dépendance (node:sqlite et WebSocket intégrés)
    # → http://localhost:8787

Variables : `PORT` (8787), `DB` (./monde.db), `SEED` (graine du terrain, ne change rien une fois la base créée).

### Production (Coolify)

Build Pack « Dockerfile » (Node 22, aucune dépendance). Port exposé : `8787`.
Variables : `FINNHUB_KEY` (secret), éventuellement `MARKET_SYMBOL`. `DB` vaut `/app/data/monde.db` dans
l'image : monter un **volume persistant sur `/app/data`**, sinon le monde repart de zéro à chaque déploiement.
Une seule instance (état partagé en mémoire + SQLite).

Ouvrir `demo.html` directement (sans serveur) ou `/?demo` : le monde vit dans l'onglet, avec un passé pré-calculé.

## Architecture

- `public/sim.js` — simulation déterministe partagée serveur/navigateur (agents, génome, unités de travail,
  classe `World` : bail / intégration / chronique). Le terrain est chargé, pas généré (`loadTerrain`).
- `tools/build-terre.mjs` — fabrique les données Terre, une fois (`npm run build:terre -- --etopo … --bmng …
  --land …` ; dépendances de dev : jpeg-js, pngjs, d3-contour) : ETOPO1 (altitude, via la rampe de
  couleurs), Blue Marble (humidité, indice de végétation) et Natural Earth 1:50m (côtes). Entrées :
  `etopo1.jpg` et `bmng.jpg` du paquet PyPI `basemap-data` (simple zip à ouvrir), `land-50m.json` du paquet
  npm `world-atlas`. Sorties versionnées dans `public/` :
  `terre.bin` (grille 384 × 192 : type + fertilité, 147 Ko, 19 en brotli), `fond.png` (768 × 384, classes et
  niveau d'altitude, 35 Ko), `terres.bin` (1 419 anneaux déroulés, 84 Ko), `cotes.bin` (1 424 arcs, 86 Ko),
  `niveaux.bin` (courbes 500 / 1000 / 2000 / 3000 / 4000 m, 107 Ko). Lignes en delta zigzag-varint.
- `server.js` — HTTP statique + API de lecture (`/api/world`, `/api/market`, `/api/stats`), WebSocket
  `/ws` pour tout le reste, persistance SQLite (état courant, snapshots horaires, journal des unités).
- `market.js` — l'indice comme climat. Avec `FINNHUB_KEY` : cotation SPY (ETF répliquant le S&P 500,
  l'indice lui-même étant payant) en REST au démarrage et toutes les 10 min, puis **trades en direct par
  WebSocket** (`wss://ws.finnhub.io`) — le climat respire pendant la séance, diffusé au plus une fois par
  seconde. Sans clé : Stooq → Yahoo → FRED, puis marche aléatoire datée. Cache SQLite.
- `tools/build-icons.mjs` — rend `public/icons/icon.svg` en PNG 32 / 180 / 192 / 512 (`npm run build:icons`, nécessite
  `playwright` installé globalement ou en dev). `favicon.svg` est la variante sans fond pour l'onglet ;
  `manifest.webmanifest` permet l'ajout à l'écran d'accueil en plein écran.
- `ws-mini.js` — serveur WebSocket RFC 6455 minimal (texte, fragmentation, ping/pong), sans dépendance.
- `public/index.html` — tout le géographique est rendu par le GPU dans une seule passe WebGL : le disque et
  les classes de terrain (`fond.png`), les **terres** (anneaux Natural Earth remplis par parité de stencil
  dans une texture 4096 × 2048, une fois au chargement), les **côtes et courbes de niveau** (quads extrudés
  dans le vertex shader, indices 16 bits par blocs). Le canvas 2D ne porte que la vie : groupes, comptoirs,
  routes en arcs de grand cercle, régions. Puis HUD, chronique, boucle de calcul. Glisser pour tourner, molette / pincement pour zoomer
  (confiné au globe : la page ne zoome jamais). Après 6 s sans manipulation, la caméra glisse d'elle-même
  vers la région en cours de calcul — la vôtre, sinon celle d'un autre témoin.

### Protocole (WebSocket `/ws`)

Tout le dynamique passe par un WebSocket texte JSON avec `permessage-deflate` (négocié, sans contexte partagé,
zlib intégré ; `ws-mini.js`). Les objets voyagent en **tableaux positionnels** (`packAgent`, `packSettlement`,
`packRoute`, `packEntry` dans `sim.js`) et l'état ne circule en entier qu'au `hello` : ensuite, **des deltas**.

Client → serveur : `hello {sigil}` · `lease` · `progress {region, step, agents, gone, full?}` (toutes les 500 ms
pendant le calcul, **différentiel** : seuls les groupes qui ont bougé) · `result {result, hash, ms, verify}`
(groupes finaux, nouveautés, et seulement les événements que le serveur retient) · `resync` (trou de séquence).
Serveur → client : `hello {world, peers}` · `unit {unit, verify}` (groupes de la région + comptoirs et routes du
voisinage à ±80 cellules) · `ack` / `nack` · `delta {seq, region, removed, agents, settlements, routes, dead,
regions, totals}` · `chronicle` · `market` · `online` / `tick` · `lease` / `progress` / `release` (les autres).

Mesuré sur un monde à l'an 1 400 (300 groupes, 45 comptoirs, 130 routes), compressé : `hello` 8 Ko, `unit`
1,9 Ko, `result` 0,8 Ko, `delta` 0,9 Ko, progression 1,7 Ko par unité. Soit ~5 Ko par unité (5 s) pour un
visiteur seul, et ~2,6 Ko par unité des autres reçus par chacun — contre 60 Ko d'état complet par unité avant.

1. Le serveur attribue la région la plus en retard, ses groupes, une graine dérivée de
   (graine monde, région, tick) et le climat du moment. Bail de 90 s.
2. Le navigateur exécute `simulateUnitGen` en l'animant (~4 s par unité) et diffuse sa progression :
   **les autres visiteurs voient sa région, son pourcentage et ses groupes bouger en direct**.
3. Le serveur intègre, horodate la chronique, diffuse le delta numéroté. Une unité sur 7 est recalculée
   côté serveur (déterminisme → même hash, sinon rejet). Un client qui voit un trou de séquence redemande
   l'état complet.

### Statique

Lu une fois au démarrage, précompressé en **brotli** (q11) et gzip, servi avec `ETag` (304 si inchangé) et
`Vary: Accept-Encoding`. Première visite ≈ 290 Ko (page 14, sim 8, terre 19, terres 60, côtes 68, niveaux 80,
fond 35, polices à part) ; visites suivantes ≈ 22 Ko puis des 304. Les fichiers de lignes sont en
**delta zigzag-varint** (1 à 2 octets par coordonnée). En dev, le dossier est rechargé à chaud.

### Ce que voit le visiteur

Rien n'explique la page. En haut à gauche, l'ère ; en haut à droite, le témoin (nom de code, indice, climat) ;
en bas à gauche, la région en calcul ; en bas à droite, la chronique, atténuée. Après cinq secondes, un halo
respire derrière le bloc du témoin (animation CSS composée, `opacity` + `transform` seulement, aucun coût
CPU) ; au contact, un murmure de trois secondes — et, une fois seulement, ce que la page fait de la machine.
Au survol, seuls les comptoirs se nomment.

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
