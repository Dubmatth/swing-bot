# Déploiement sur VPS (Hetzner)

Runner de trading papier tournant en continu, indépendamment du Mac, via
un service `systemd` qui redémarre automatiquement (crash, reboot du
serveur).

## 1. Créer le serveur (Hetzner Cloud Console)

- Emplacement : Falkenstein ou Nuremberg (Allemagne).
- Image : Ubuntu 24.04 LTS.
- Type : CX22 (2 vCPU / 4 Go, le moins cher — largement suffisant).
- Clé SSH : ajouter ta clé publique (`~/.ssh/id_ed25519.pub`), jamais de
  mot de passe.
- Cloud Firewall Hetzner : n'autoriser que le port 22 (SSH) en entrée.

Noter l'adresse IP donnée à la création.

## 2. Pousser le code sur GitHub (si pas déjà fait)

Le script d'installation clone le dépôt depuis GitHub. Vérifier que
`master` est poussé :

```bash
git push origin master
```

Si le dépôt est privé, soit le rendre accessible en lecture au VPS (clé de
déploiement GitHub), soit adapter `REPO_URL` dans `setup-vps.sh` pour
utiliser une URL avec jeton d'accès, soit copier le code directement avec
`scp -r . root@<IP>:/opt/swing-bot` à la place de l'étape `git clone`.

## 3. Lancer l'installation

```bash
ssh root@<IP>
curl -fsSL https://raw.githubusercontent.com/Dubmatth/swing-bot/master/deploy/setup-vps.sh -o setup-vps.sh
bash setup-vps.sh
```

(Ou copier `setup-vps.sh` sur le serveur manuellement si le dépôt est
privé, avant que `git clone` ne soit possible.)

Le script installe Node 22, crée un utilisateur dédié `swingbot` sans
privilège, clone le dépôt, configure le pare-feu local et les mises à jour
automatiques, puis démarre le service `systemd`.

## 4. Vérifier que ça tourne

```bash
systemctl status swing-bot       # état du service
journalctl -u swing-bot -f       # logs en direct
```

## 5. Consulter le statut du portefeuille à distance

```bash
ssh root@<IP> "cd /opt/swing-bot && sudo -u swingbot npm run status"
```

## 6. Mettre à jour le code après un nouveau commit

```bash
ssh root@<IP>
cd /opt/swing-bot
git pull
systemctl restart swing-bot
```

## 7. Arrêter / redémarrer le service

```bash
systemctl stop swing-bot
systemctl restart swing-bot
```

## Hors périmètre pour l'instant

- Gestion des clés API réelles (voir
  `docs/superpowers/specs/2026-08-24-real-order-api-key-security-notes.md`) —
  le fichier `/etc/swing-bot/.env` est prévu par le service `systemd` mais
  reste vide, aucune clé n'est nécessaire pour le trading papier.
- Sauvegardes automatiques de `data/live-state/` — Hetzner propose des
  snapshots payants du disque si besoin plus tard.
- Alerting/notifications sur trade ou erreur.
