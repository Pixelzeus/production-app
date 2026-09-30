const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('node:path');
const { dbOps } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Masquer l'en-tête Express (sécurité par obscurité minimale)
app.disable('x-powered-by');

// En-têtes de sécurité HTTP (Protection XSS, Clickjacking, MIME sniffing)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});

// Middlewares d'optimisation
app.use(compression());
app.use(cors());

// Limite de taille de payload raisonnable pour éviter l'épuisement mémoire (DoS)
app.use(express.json({ limit: '10mb' }));

// Journalisation minimale en production (sans exposer de données sensibles)
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[${req.method}] ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
  }
  next();
});

// Validation d'identifiant d'artiste (sécurité contre injection / path traversal)
function isValidArtistId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

// Nettoyage et validation du nom d'artiste
function sanitizeArtistName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  // Suppression des caractères de contrôle invisibles
  const cleaned = rawName.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (cleaned.length < 1 || cleaned.length > 50) return null;
  return cleaned;
}

/* ================== ROUTES API ================== */

// Healthcheck pour Docker et Reverse Proxy (pas de fuite de chemins internes)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    database: 'connected'
  });
});

// Liste des artistes
app.get('/api/artists', (req, res) => {
  try {
    const artists = dbOps.listArtists();
    res.json(artists);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des artistes.' });
  }
});

// Connexion / Création d'un profil artiste
app.post('/api/artists', (req, res) => {
  try {
    const name = sanitizeArtistName(req.body && req.body.name);
    if (!name) {
      return res.status(400).json({ error: 'Le prénom ou pseudo doit contenir entre 1 et 50 caractères valides.' });
    }
    const artist = dbOps.getOrCreateArtist(name);
    const state = dbOps.getArtistState(artist.id);
    res.json({ artist, state });
  } catch (err) {
    res.status(500).json({ error: 'Impossible de créer ou charger le profil artiste.' });
  }
});

// Récupération de l'état d'un artiste
app.get('/api/artists/:id/state', (req, res) => {
  try {
    if (!isValidArtistId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’artiste non valide.' });
    }
    const state = dbOps.getArtistState(req.params.id);
    if (!state) {
      return res.status(404).json({ error: 'Aucun projet trouvé pour cet artiste.' });
    }
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la lecture des données.' });
  }
});

// Sauvegarde de l'état d'un artiste
app.put('/api/artists/:id/state', (req, res) => {
  try {
    if (!isValidArtistId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’artiste non valide.' });
    }
    const state = req.body;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'Structure de données invalide.' });
    }
    const result = dbOps.saveArtistState(req.params.id, state);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde sur le serveur.' });
  }
});

// Suppression d'un profil artiste
app.delete('/api/artists/:id', (req, res) => {
  try {
    if (!isValidArtistId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’artiste non valide.' });
    }
    dbOps.deleteArtist(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression du profil.' });
  }
});

// Sauvegarde globale complète (admin / enseignant)
app.get('/api/backup', (req, res) => {
  try {
    const backup = dbOps.exportAll();
    const filename = `carnet-de-prod-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la génération de la sauvegarde.' });
  }
});

// Restauration globale
app.post('/api/restore', (req, res) => {
  try {
    if (!req.body || !Array.isArray(req.body.artists)) {
      return res.status(400).json({ error: 'Format de fichier de restauration invalide.' });
    }
    if (req.body.artists.length > 500) {
      return res.status(400).json({ error: 'Trop grand nombre d’artistes dans ce fichier (maximum 500).' });
    }
    const result = dbOps.importAll(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la restauration des données.' });
  }
});

/* ================== FICHIERS STATIQUES (FRONTEND) ================== */
const PUBLIC_DIR = path.join(__dirname, '../public');

// Sert les fichiers statiques avec cache et sans divulgation de répertoires
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true,
  dotfiles: 'ignore'
}));

// 404 spécifique aux routes /api/* (évite de renvoyer index.html en cas d'URL API erronée)
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint API introuvable.' });
});

// Route fallback SPA pour l'interface client (uniquement pour les requêtes GET non-API)
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Gestionnaire d'erreur global (évite les fuites de stack traces)
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: 'Une erreur interne est survenue.' });
});

// Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`🎨 Carnet de Prod démarré avec succès !`);
  console.log(`🌐 Port d'écoute : ${PORT}`);
  console.log(`🔒 Mode sécurisé : En-têtes HTTP & validation stricts`);
  console.log(`==================================================\n`);
});

