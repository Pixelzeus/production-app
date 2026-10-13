# 🎨 Carnet de Prod — Serveur Docker & Multi-Artistes

Application de gestion de production, découpage de tâches, estimation avec indice de confiance et chronométrage conçue pour les **Game Artists** (écoles, cours, studios, freelances).

---

## ⚡ Caractéristiques Techniques

- **Stockage serveur optimisé** : Moteur de base de données **SQLite** avec journalisation **WAL (Write-Ahead Logging)** pour des lectures/écritures ultra-rapides (< 1 ms), sans latence et sans consommer de mémoire inutile.
- **Persistance garantie** : Toutes les données sont conservées sur le volume Docker `carnet_de_prod_data`. Vos projets restent intacts lors des redémarrages et des mises à jour.
- **Profils nomades sans friction** : Chaque étudiant ou artiste choisit son profil en 1 clic ou entre son pseudo. Il retrouve ses projets, chronos et bilans depuis n'importe quel poste (salles de cours, domicile, studio).
- **Mode hybride résilient** : Enregistrement temps réel sur le serveur avec mise en cache locale de secours si le réseau coupe temporairement.
- **Léger & économe** : Image Docker basée sur Alpine Linux (< 150 Mo), consommation mémoire inférieure à 35 Mo de RAM.
- **Gestion d'équipes & Projets multi-artistes** : Regroupement d'artistes en équipes, rôles Leads / Membres, projets collectifs et vision globale de la production.
- **Sécurité et protection admin à la carte** : Libre par défaut, ou protégée par mot de passe/PIN activable simplement via `.env`.

---

## 👥 Gestion d'Équipes & Projets Multi-Artistes

L'espace **Équipes & Admin** (`#/equipes`) permet de coordonner plusieurs artistes sur des productions d'envergure :

1. **Espaces d'Équipes Dédiés** :
   - Créez des équipes (ex. *Équipe Mech Arena*, *Groupe Environnement Stylisé*...).
   - Désignez des **Leads d'équipe 👑** et des **Artistes membres 🎨**.
   - Ajoutez des artistes existants ou créez-en de nouveaux directement depuis la modale.

2. **Projets Collaboratifs & Baromètre Global** :
   - **Avancement général** : Pourcentage global de complétion calculé en temps réel sur toutes les tâches partagées.
   - **Temps cumulé vs Estimé** : Comparaison instantanée entre heures prévues et heures réelles passées par l'ensemble de l'équipe.
   - **Diagnostic de production** : Ratio d'effort global qualifiant immédiatement la cadence (*« Dans les clous »*, *« Dépassement (+X %) »*, *« En avance (-X %) »*).

3. **Distribution de la Charge (Workload) & Filtrage 1-clic** :
   - Cartes individuelles par artiste affichant sa jauge de progression, ses tâches terminées et son ratio prévisionnel.
   - Cliquez sur la carte d'un artiste pour filtrer instantanément le tableau des tâches sur son périmètre.

4. **Tâches Collaboratives & Chronométrage Partagé** :
   - **Réassignation en direct** : Changez l'artiste assigné en un clic via un menu déroulant, sauvegardé immédiatement sur le serveur.
   - **Chronomètre en direct** : Chaque membre peut lancer son chronomètre sur n'importe quelle tâche collaborative ; le temps tourne en direct dans le bandeau supérieur et sur la tâche, avec synchronisation continue.
   - **Ajustement rapide** : Bouton `+15m` pour créditer du temps sans ouvrir de menu.

---

## 🔐 Sécurité & Configuration Administrateur

### Accès Libre par défaut
Par défaut, l'espace d'administration et la gestion des équipes sont **libres d'accès** sans mot de passe, idéal pour une utilisation fluide en classe ou en studio fermé.

### Activer la protection par mot de passe ou code PIN
Pour protéger l'espace d'administration (ex. en déploiement sur Internet ou sur un serveur mutualisé), configurez simplement dans votre fichier `.env` :

```env
# Protéger avec un mot de passe fort :
ADMIN_PASSWORD=mon_mot_de_passe_secret

# OU protéger avec un code PIN rapide :
ADMIN_PIN=4826
```

Dès activation :
- L'interface affiche l'état de verrouillage et propose une modale de déverrouillage sécurisée.
- Les requêtes d'administration exigent l'en-tête `x-admin-key`.
- L'audit de sécurité réseau automatique vérifie en permanence les en-têtes HTTP (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, masquage de `x-powered-by`, et validation anti-injection).

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

Ce fichier exporte l'intégralité de la base de données : artistes, projets individuels, chronos, équipes, rôles, membres et projets collaboratifs.

Vous pouvez aussi télécharger le dump complet directement via l'URL :
`GET http://votre-serveur:3030/api/backup`

### 2. Sauvegarde du fichier de base de données SQLite
Le fichier de base de données est localisé dans le volume Docker `/data/carnet.db`. Pour en faire une copie directe :

```bash
# Copier le fichier SQLite hors du conteneur
docker cp carnet_de_prod:/data/carnet.db ./backup-carnet-$(date +%F).db
```

---

## 🧪 Suite d'Audit & Tests Automatisés

Pour vérifier l'intégrité de la sécurité, des en-têtes HTTP, de la base de données SQLite, des calculs de ratios et des flux collaboratifs :

```bash
node test_suite.js
```
Tous les tests (64/64) s'exécutent en isolation sans impacter la base de données de production.

---

## 🛠️ Développement local sans Docker

Vous pouvez également lancer le serveur directement avec Node.js (version 22+) :

```bash
npm install
npm start
```
Accès local : `http://localhost:3000`

