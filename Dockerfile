# Image officielle Node.js 22 Alpine (légère, sécurisée et avec SQLite natif ultra-rapide)
FROM node:22-alpine

# Métadonnées
LABEL maintainer="Carnet de Prod"
LABEL description="Interface de production et chronométrage pour Game Artists"

# Répertoire de travail de l'application
WORKDIR /app

# Variables d'environnement
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# Création du dossier persistant et attribution des droits à l'utilisateur non-root 'node'
RUN mkdir -p /data && chown -R node:node /data /app

# Copie des fichiers de dépendances
COPY package*.json ./

# Installation des dépendances de production uniquement
RUN npm ci --omit=dev

# Copie du code source et des fichiers statiques
COPY server/ ./server/
COPY public/ ./public/

# Attribution des droits sur les fichiers copiés
RUN chown -R node:node /app

# Bascule sur l'utilisateur non-root pour la sécurité
USER node

# Déclaration du volume persistant SQLite
VOLUME ["/data"]

# Exposition du port interne
EXPOSE 3000

# Healthcheck Docker pour superviser la santé du conteneur
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Commande de démarrage
CMD ["node", "--no-warnings", "server/index.js"]
