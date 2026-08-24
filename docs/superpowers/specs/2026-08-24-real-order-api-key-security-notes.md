# Notes de sécurité — clés API Kraken pour l'exécution d'ordres réels

Statut : **différé**. Aucun code d'exécution d'ordres réels n'existe dans ce
projet — le runner (`scripts/run-paper.ts`, `src/live/paperRunner.ts`) est
strictement du trading papier (voir README, section « Hors périmètre »).
Ce document capture l'analyse de sécurité faite en amont, pour ne pas la
perdre, mais **ne doit pas être implémenté avant qu'une décision explicite
de passer aux ordres réels soit prise** — construire ce mécanisme
maintenant serait de l'infrastructure spéculative pour une fonctionnalité
qui n'existe pas (violerait YAGNI).

## 1. Permissions de la clé API (le contrôle le plus important)

- **Ne jamais activer la permission « Withdraw Funds » (retrait de fonds)**
  sur une clé utilisée par le bot. C'est la protection la plus importante :
  si la clé fuite, un attaquant peut trader avec les fonds du compte mais
  jamais les en sortir.
- Activer uniquement : consultation du solde, consultation des
  ordres/trades, création et annulation d'ordres.
- Kraken permet de **restreindre une clé à une adresse IP précise** —
  celle du VPS. Une clé volée devient inutilisable depuis n'importe quel
  autre réseau.

## 2. Stockage sur le serveur

- Jamais dans git, même dans un fichier par ailleurs ignoré — le risque
  existe toujours (historique, erreur d'ajout, fork, etc.).
- Un fichier `.env` **situé hors du dépôt cloné** (ex. `/etc/swing-bot/.env`
  sur le VPS), permissions `600`, appartenant à l'utilisateur système
  dédié au service (voir §3).
- Le service `systemd` référence ce fichier via `EnvironmentFile=`, jamais
  de clé en dur dans le code, un commit, ou l'unité `systemd` elle-même.

## 3. Durcissement du système hôte

- Utilisateur Linux dédié, sans privilège, pour faire tourner le bot —
  jamais `root`.
- SSH par clé uniquement (mot de passe désactivé).
- Pare-feu (`ufw` ou équivalent) : seul SSH autorisé en entrée — le bot ne
  fait que des connexions sortantes (REST/WebSocket Kraken), rien à ouvrir
  côté serveur.
- Mises à jour de sécurité automatiques (`unattended-upgrades` sous
  Debian/Ubuntu).
- `fail2ban` en option contre le brute-force SSH.

## 4. Garde-fous côté application (défense en profondeur)

- Les plafonds déjà en place (`maxConcurrentPositions`, `riskPerTradePct`,
  `sizeBuyOrder` — voir `src/backtest/runner.ts`) restent la première
  ligne de défense : même avec une clé compromise ou un bug, l'exposition
  reste bornée par le code, pas par la confiance placée dans la clé.
- Un interrupteur explicite (ex. variable d'environnement
  `ALLOW_REAL_ORDERS=true`), absent par défaut, à activer volontairement —
  pour qu'un passage au réel ne puisse jamais arriver par accident (mauvaise
  config, mauvais déploiement, régression).
- Alerte immédiate (email, Telegram, etc.) sur chaque ordre réel exécuté,
  et sur toute erreur du runner — le silence coûte bien plus cher avec de
  l'argent réel qu'en papier, où une anomalie n'est qu'un chiffre faux dans
  un fichier local.

## 5. Réaction en cas de doute

- Savoir révoquer/régénérer une clé API en un clic depuis l'interface
  Kraken.
- Surveiller occasionnellement le journal d'activité du compte Kraken.

## À faire au moment (et seulement au moment) de construire l'exécution réelle

- Créer la clé API avec les permissions minimales ci-dessus, avant
  d'écrire la moindre ligne de code d'exécution.
- Mettre en place l'utilisateur dédié, le pare-feu et le fichier `.env`
  hors dépôt sur le VPS en même temps que le déploiement du code
  d'exécution réelle — pas avant (rien à protéger avant).
- Concevoir l'interrupteur `ALLOW_REAL_ORDERS` et le système d'alerte
  comme partie du brainstorming de cette fonctionnalité, pas comme un
  ajout après coup.
