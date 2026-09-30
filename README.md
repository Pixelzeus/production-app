# 🎨 Carnet de Prod — Serveur Docker & Multi-Artistes

Application de gestion de production, découpage de tâches, estimation avec indice de confiance et chronométrage conçue pour les **Game Artists** (écoles, cours, studios, freelances).

---

## ⚡ Caractéristiques Techniques

- **Stockage serveur optimisé** : Moteur de base de données **SQLite** avec journalisation **WAL (Write-Ahead Logging)** pour des lectures/écritures ultra-rapides (< 1 ms), sans latence et sans consommer de mémoire inutile.
- **Persistance garantie** : Toutes les données sont conservées sur le volume Docker `carnet_de_prod_data`. Vos projets restent intacts lors des redémarrages et des mises à jour.
- **Profils nomades sans friction** : Chaque étudiant ou artiste choisit son profil en 1 clic ou entre son pseudo. Il retrouve ses projets, chronos et bilans depuis n'importe quel poste (salles de cours, domicile, studio).
- **Mode hybride résilient** : Enregistrement temps réel sur le serveur avec mise en cache locale de secours si le réseau coupe temporairement.
- **Léger & économe** : Image Docker basée sur Alpine Linux (< 150 Mo), consommation mémoire inférieure à 35 Mo de RAM.

---

## 🚀 Lancement Rapide avec Docker

### 1. Démarrer le conteneur
Dans le dossier du projet, exécutez simplement :

```bash
docker compose up -d --build
```

L'application est immédiatement accessible sur le port **3030** :
👉 **`http://localhost:3030`** ou **`http://IP_DE_VOTRE_SERVEUR:3030`**

### 2. Arrêter le conteneur
```bash
docker compose down
```

---

## 🌐 Rendre l'application accessible via une URL publique

Pour accéder à Carnet de Prod depuis l'extérieur (ex: `https://carnet.mon-ecole.fr` ou `https://prod.mon-studio.com`), connectez le conteneur à votre reverse proxy habituel :

### Option A — Reverse Proxy (Nginx Proxy Manager / Traefik / Caddy)
Configurez un nouveau Proxy Host pointant vers :
- **Forward Hostname / IP** : `carnet_de_prod` (si dans le même réseau Docker) ou l'IP locale de votre serveur
- **Forward Port** : `3030` (ou le port défini dans votre `.env`)
- **Websockets Support** : Activé
- **SSL** : Cocher Let's Encrypt (Force SSL)

### Option B — Cloudflare Tunnel (Idéal sans ouvrir de ports sur la box / pare-feu)
Si votre serveur est hébergé localement (dans une école ou chez vous) :
1. Créez un tunnel Cloudflare via le dashboard Cloudflare Zero Trust.
2. Définissez le service : `HTTP -> localhost:3030`.
3. Votre application est immédiatement accessible en `https://carnet.votre-domaine.com` avec certificat SSL géré automatiquement.

---

## 💾 Sauvegarde & Restauration des données

### 1. Sauvegarde en un clic via l'interface
Depuis l'application, ouvrez le menu **Réglages** ⚙️ et cliquez sur :
> **« Sauvegarde complète de tous les artistes (.json) »**

Vous pouvez aussi télécharger le dump complet directement via l'URL :
`GET http://votre-serveur:3030/api/backup`

### 2. Sauvegarde du fichier de base de données SQLite
Le fichier de base de données est localisé dans le volume Docker `/data/carnet.db`. Pour en faire une copie directe :

```bash
# Copier le fichier SQLite hors du conteneur
docker cp carnet_de_prod:/data/carnet.db ./backup-carnet-$(date +%F).db
```

---

## 🛠️ Développement local sans Docker

Vous pouvez également lancer le serveur directement avec Node.js (version 22+) :

```bash
npm install
npm start
```
Accès local : `http://localhost:3000`
