const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Dossier de données persistant (configurable via variable d'environnement)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'carnet.db');
const db = new DatabaseSync(DB_PATH);

// Optimisation SQLite : Journal en mode WAL (Write-Ahead Logging) pour performances maximales
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artist_data (
    artist_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_artists_last_active ON artists(last_active DESC);
`);

function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'artiste';
}

function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

const dbOps = {
  // Liste tous les artistes avec statistiques rapides
  listArtists() {
    const stmt = db.prepare(`
      SELECT a.id, a.name, a.created_at, a.last_active,
             d.updated_at,
             LENGTH(d.state) as state_size
      FROM artists a
      LEFT JOIN artist_data d ON a.id = d.artist_id
      ORDER BY a.last_active DESC
    `);
    const rows = stmt.all();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastActive: r.last_active,
      updatedAt: r.updated_at,
      hasData: !!r.state_size
    }));
  },

  // Trouve ou crée un artiste à partir de son nom
  getOrCreateArtist(rawName) {
    const name = String(rawName || '').trim();
    if (!name) throw new Error('Le nom de l’artiste ne peut pas être vide.');

    const findStmt = db.prepare('SELECT id, name, created_at, last_active FROM artists WHERE name = ? COLLATE NOCASE');
    const existing = findStmt.get(name);

    const now = Date.now();
    if (existing) {
      db.prepare('UPDATE artists SET last_active = ? WHERE id = ?').run(now, existing.id);
      return {
        id: existing.id,
        name: existing.name,
        createdAt: existing.created_at,
        lastActive: now
      };
    }

    // Nouvel artiste
    let id = slug(name);
    const checkId = db.prepare('SELECT id FROM artists WHERE id = ?');
    if (checkId.get(id)) {
      id = `${id}-${uid().slice(0, 4)}`;
    }

    db.prepare('INSERT INTO artists (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    return { id, name, createdAt: now, lastActive: now };
  },

  // Récupère l'état d'un artiste
  getArtistState(artistId) {
    const stmt = db.prepare('SELECT state, updated_at FROM artist_data WHERE artist_id = ?');
    const row = stmt.get(artistId);
    if (!row) return null;
    try {
      return JSON.parse(row.state);
    } catch (e) {
      console.error(`Erreur de parsing de l'état pour ${artistId}:`, e);
      return null;
    }
  },

  // Sauvegarde l'état d'un artiste (Upsert)
  saveArtistState(artistId, stateObj) {
    const now = Date.now();
    const jsonStr = JSON.stringify(stateObj);

    // Transaction atomique
    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare(`
        INSERT INTO artist_data (artist_id, state, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(artist_id) DO UPDATE SET
          state = excluded.state,
          updated_at = excluded.updated_at
      `).run(artistId, jsonStr, now);

      db.prepare('UPDATE artists SET last_active = ? WHERE id = ?').run(now, artistId);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return { success: true, updatedAt: now };
  },

  // Supprime un artiste et ses données
  deleteArtist(artistId) {
    db.prepare('DELETE FROM artists WHERE id = ?').run(artistId);
    return { success: true };
  },

  // Exporte toutes les données pour sauvegarde serveur
  exportAll() {
    const artists = db.prepare('SELECT * FROM artists ORDER BY name ASC').all();
    const data = db.prepare('SELECT * FROM artist_data').all();
    const stateMap = {};
    for (const d of data) {
      try {
        stateMap[d.artist_id] = JSON.parse(d.state);
      } catch (_) {}
    }

    return {
      version: 1,
      exportedAt: Date.now(),
      artists: artists.map(a => ({
        ...a,
        state: stateMap[a.id] || null
      }))
    };
  },

  // Importe une sauvegarde globale
  importAll(backup) {
    if (!backup || !Array.isArray(backup.artists)) {
      throw new Error('Format de sauvegarde invalide.');
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      for (const item of backup.artists) {
        if (!item.id || !item.name) continue;
        db.prepare(`
          INSERT INTO artists (id, name, created_at, last_active)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            last_active = excluded.last_active
        `).run(item.id, item.name, item.created_at || Date.now(), item.last_active || Date.now());

        if (item.state) {
          db.prepare(`
            INSERT INTO artist_data (artist_id, state, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(artist_id) DO UPDATE SET
              state = excluded.state,
              updated_at = excluded.updated_at
          `).run(item.id, JSON.stringify(item.state), Date.now());
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
    return { success: true, count: backup.artists.length };
  }
};

module.exports = { db, dbOps, DB_PATH };
