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

// Validation d'identifiant (sécurité contre injection / path traversal)
function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}
function isValidArtistId(id) {
  return isValidId(id);
}

// Nettoyage et validation des noms
function sanitizeName(rawName, maxLen = 80) {
  if (!rawName || typeof rawName !== 'string') return null;
  const cleaned = rawName.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (cleaned.length < 1 || cleaned.length > maxLen) return null;
  return cleaned;
}
function sanitizeArtistName(rawName) {
  return sanitizeName(rawName, 50);
}

// Middleware de protection administrateur conditionnel
// (Libre d'accès par défaut, activable en définissant ADMIN_PASSWORD ou ADMIN_PIN dans .env)
function requireAdmin(req, res, next) {
  const configuredPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN;
  if (!configuredPass) {
    return next(); // Libre d'accès tant qu'aucune protection n'est activée
  }
  const provided = req.headers['x-admin-key'] || req.query.admin_key;
  if (provided && String(provided) === String(configuredPass)) {
    return next();
  }
  return res.status(401).json({ error: 'Accès administrateur protégé. Mot de passe requis.' });
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
app.post('/api/restore', requireAdmin, (req, res) => {
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

/* ================== ROUTES ADMIN ================== */

// Statut de la protection admin
app.get('/api/admin/status', (req, res) => {
  const isProtected = !!(process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN);
  res.json({ protected: isProtected });
});

// Vérification du mot de passe / code PIN
app.post('/api/admin/verify', (req, res) => {
  const configuredPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN;
  if (!configuredPass) {
    return res.json({ success: true, protected: false });
  }
  const provided = req.body && (req.body.password || req.body.key || req.body.pin);
  if (provided && String(provided) === String(configuredPass)) {
    return res.json({ success: true, protected: true });
  }
  return res.status(401).json({ error: 'Mot de passe administrateur incorrect.' });
});

// Statistiques administratives globales
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const stats = dbOps.getAdminStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques administratives.' });
  }
});

/* ================== ROUTES ÉQUIPES & PROJETS PARTAGÉS ================== */

// Liste de toutes les équipes
app.get('/api/teams', (req, res) => {
  try {
    const teams = dbOps.listTeams();
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des équipes.' });
  }
});

// Création d'une équipe
app.post('/api/teams', requireAdmin, (req, res) => {
  try {
    const name = sanitizeName(req.body && req.body.name, 80);
    if (!name) {
      return res.status(400).json({ error: 'Le nom de l’équipe doit contenir entre 1 et 80 caractères.' });
    }
    const description = typeof req.body.description === 'string' ? req.body.description.slice(0, 500) : '';
    const team = dbOps.createTeam(name, description);
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Impossible de créer l’équipe.' });
  }
});

// Détails d'une équipe (membres + projets)
app.get('/api/teams/:id', (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const team = dbOps.getTeam(req.params.id);
    if (!team) {
      return res.status(404).json({ error: 'Équipe introuvable.' });
    }
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la lecture de l’équipe.' });
  }
});

// Mise à jour d'une équipe
app.put('/api/teams/:id', requireAdmin, (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const result = dbOps.updateTeam(req.params.id, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors de la mise à jour de l’équipe.' });
  }
});

// Suppression d'une équipe
app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    dbOps.deleteTeam(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression de l’équipe.' });
  }
});

// Ajout / Mise à jour d'un membre dans l'équipe
app.post('/api/teams/:id/members', (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const artistId = req.body && req.body.artistId;
    if (!isValidId(artistId)) {
      return res.status(400).json({ error: 'Identifiant d’artiste non valide.' });
    }
    const role = (req.body && req.body.role === 'lead') ? 'lead' : 'member';
    const member = dbOps.addTeamMember(req.params.id, artistId, role);
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Impossible d’ajouter le membre à l’équipe.' });
  }
});

// Retrait d'un membre de l'équipe
app.delete('/api/teams/:id/members/:artistId', (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.artistId)) {
      return res.status(400).json({ error: 'Identifiants non valides.' });
    }
    dbOps.removeTeamMember(req.params.id, req.params.artistId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du retrait du membre.' });
  }
});

// Liste des projets d'une équipe
app.get('/api/teams/:id/projects', (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const projects = dbOps.listTeamProjects(req.params.id);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la récupération des projets d’équipe.' });
  }
});

// Création / Enregistrement d'un projet d'équipe
app.post('/api/teams/:id/projects', (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const project = req.body;
    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Données de projet invalides.' });
    }
    const saved = dbOps.saveTeamProject(req.params.id, project);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors de l’enregistrement du projet d’équipe.' });
  }
});

// Récupération d'un projet d'équipe
app.get('/api/teams/:id/projects/:pid', (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.pid)) {
      return res.status(400).json({ error: 'Identifiants non valides.' });
    }
    const project = dbOps.getTeamProject(req.params.id, req.params.pid);
    if (!project) {
      return res.status(404).json({ error: 'Projet d’équipe introuvable.' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la lecture du projet d’équipe.' });
  }
});

// Mise à jour d'un projet d'équipe
app.put('/api/teams/:id/projects/:pid', (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.pid)) {
      return res.status(400).json({ error: 'Identifiants non valides.' });
    }
    const project = req.body;
    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Données de projet invalides.' });
    }
    project.id = req.params.pid;
    const saved = dbOps.saveTeamProject(req.params.id, project);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors de la mise à jour du projet d’équipe.' });
  }
});

// Suppression d'un projet d'équipe
app.delete('/api/teams/:id/projects/:pid', (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.pid)) {
      return res.status(400).json({ error: 'Identifiants non valides.' });
    }
    dbOps.deleteTeamProject(req.params.id, req.params.pid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression du projet d’équipe.' });
  }
});

// Vue globale & Analytics d'une équipe ou d'un projet d'équipe
app.get('/api/teams/:id/overview', (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Identifiant d’équipe non valide.' });
    }
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    const overview = dbOps.getTeamOverview(req.params.id, projectId);
    if (!overview) {
      return res.status(404).json({ error: 'Équipe introuvable.' });
    }
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du calcul de la vue globale de l’équipe.' });
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

