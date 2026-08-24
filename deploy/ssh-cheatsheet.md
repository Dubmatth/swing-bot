# SSH pour les nuls — les commandes qu'on utilise, expliquées

## C'est quoi, SSH ?

SSH (Secure Shell) permet de se connecter à un ordinateur distant (ici, le
VPS Hetzner) et d'y exécuter des commandes comme si on était assis devant
— mais depuis le Mac, via une connexion chiffrée. Pas de mot de passe :
une paire de clés fait le travail (voir plus bas).

## Petit lexique

| Terme | Ça veut dire |
|---|---|
| IP | L'adresse du serveur sur internet — `<VPS_IP>` dans notre cas. |
| Port | Une « porte » numérotée sur laquelle un programme écoute (22 pour SSH, 8080 pour le tableau de bord). |
| root | L'utilisateur administrateur, tous les droits — nécessaire pour installer des choses, à ne pas utiliser pour faire tourner le bot lui-même (voir `swingbot`, l'utilisateur sans privilège créé par `setup-vps.sh`). |
| Clé SSH | Une paire de fichiers (une publique, une privée) qui remplace un mot de passe pour se connecter. |

## Les commandes, une par une

### 1. Créer une paire de clés (déjà fait, pour référence)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
```

Crée deux fichiers : `id_ed25519` (la clé **privée**, reste secrète sur le
Mac, jamais partagée avec personne) et `id_ed25519.pub` (la clé
**publique**, sans risque à donner — à Hetzner, à GitHub — elle permet
seulement de vérifier qu'on possède bien la clé privée correspondante,
jamais de la deviner ou de s'en servir pour usurper).

### 2. Déverrouiller la clé pour la session en cours

```bash
ssh-add ~/.ssh/id_ed25519
```

La clé privée est protégée par une phrase de passe. Cette commande la
déverrouille et la garde en mémoire (dans l'« agent SSH ») pour ne pas
avoir à retaper la phrase de passe à chaque connexion pendant la session
de terminal en cours.

### 3. Se connecter au serveur (session interactive)

```bash
ssh root@<VPS_IP>
```

Ouvre une session : à partir de là, tout ce qui est tapé s'exécute **sur
le serveur**, pas sur le Mac — jusqu'à taper `exit` pour revenir.

### 4. Exécuter une seule commande à distance

```bash
ssh root@<VPS_IP> 'systemctl status swing-bot'
```

Lance une commande sur le serveur et revient immédiatement sur le Mac,
sans ouvrir de session interactive. C'est la forme utilisée la plupart du
temps pour vérifier l'état du bot sans avoir à s'y « déplacer ».

### 5. Le tunnel — voir le tableau de bord dans un navigateur

```bash
ssh -N -L 8080:localhost:8080 root@<VPS_IP>
```

Ne donne pas accès à un terminal — redirige un port à la place. Tout ce
qui est envoyé à `localhost:8080` sur le Mac est transporté, chiffré,
jusqu'au port 8080 du serveur. C'est ce qui permet de voir le tableau de
bord dans le navigateur sans jamais l'exposer publiquement sur internet.

- `-N` : pas de commande à exécuter, juste le tunnel.
- `-L 8080:localhost:8080` : « Local » — le port 8080 du Mac pointe vers
  le port 8080 du serveur.

Cette commande tourne indéfiniment tant que le terminal reste ouvert.
`Ctrl+C` pour fermer le tunnel (le bot, lui, continue de tourner sur le
serveur — fermer le tunnel n'arrête que la possibilité de le consulter).

## Une fois connecté (via 3 ou 4) : ce n'est plus du SSH

Ces commandes sont du Linux normal, exécutées sur le serveur lui-même :

| Commande | Effet |
|---|---|
| `systemctl status swing-bot` | Affiche si le bot tourne, depuis quand, sa consommation mémoire. |
| `systemctl restart swing-bot` | Arrête puis relance le bot (après une mise à jour du code, par exemple). |
| `journalctl -u swing-bot -f` | Logs **en direct** (`-f` = « follow », comme `tail -f`). `Ctrl+C` pour arrêter de suivre — n'arrête pas le bot. |
| `git pull` | Récupère les derniers changements de code depuis GitHub. |

## La commande à retenir pour un contrôle rapide au quotidien

```bash
ssh root@<VPS_IP> "cd /opt/swing-bot && sudo -u swingbot npm run status"
```

Donne l'état du portefeuille (cash, positions, derniers trades) sans
ouvrir de session ni de tunnel — la façon la plus rapide de vérifier que
tout va bien.
