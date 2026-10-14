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

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, artist_id),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS team_projects (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    brief TEXT DEFAULT '',
    status TEXT DEFAULT 'plan',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_artists_last_active ON artists(last_active DESC);
  CREATE INDEX IF NOT EXISTS idx_team_members_artist ON team_members(artist_id);
  CREATE INDEX IF NOT EXISTS idx_team_projects_team ON team_projects(team_id);
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

  // --- ÉQUIPES ---
  listTeams() {
    const stmt = db.prepare(`
      SELECT t.id, t.name, t.description, t.created_at,
             COUNT(DISTINCT tm.artist_id) as member_count,
             COUNT(DISTINCT tp.id) as project_count
      FROM teams t
      LEFT JOIN team_members tm ON t.id = tm.team_id
      LEFT JOIN team_projects tp ON t.id = tp.team_id
      GROUP BY t.id
      ORDER BY t.name ASC
    `);
    const rows = stmt.all();

    // Membres par équipe
    const membersStmt = db.prepare(`
      SELECT tm.team_id, tm.artist_id, tm.role, tm.joined_at, a.name as artist_name
      FROM team_members tm
      JOIN artists a ON tm.artist_id = a.id
      ORDER BY tm.role DESC, a.name ASC
    `);
    const allMembers = membersStmt.all();
    const membersByTeam = {};
    for (const m of allMembers) {
      if (!membersByTeam[m.team_id]) membersByTeam[m.team_id] = [];
      membersByTeam[m.team_id].push({
        artistId: m.artist_id,
        artistName: m.artist_name,
        role: m.role,
        joinedAt: m.joined_at
      });
    }

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      createdAt: r.created_at,
      memberCount: Number(r.member_count) || 0,
      projectCount: Number(r.project_count) || 0,
      members: membersByTeam[r.id] || []
    }));
  },

  getTeam(teamId) {
    const team = db.prepare('SELECT id, name, description, created_at FROM teams WHERE id = ?').get(teamId);
    if (!team) return null;

    const members = db.prepare(`
      SELECT tm.artist_id, tm.role, tm.joined_at, a.name as artist_name
      FROM team_members tm
      JOIN artists a ON tm.artist_id = a.id
      WHERE tm.team_id = ?
      ORDER BY tm.role DESC, a.name ASC
    `).all(teamId);

    const projects = db.prepare(`
      SELECT id, team_id, name, brief, status, created_at, updated_at
      FROM team_projects
      WHERE team_id = ?
      ORDER BY updated_at DESC
    `).all(teamId);

    return {
      id: team.id,
      name: team.name,
      description: team.description || '',
      createdAt: team.created_at,
      members: members.map(m => ({
        artistId: m.artist_id,
        artistName: m.artist_name,
        role: m.role,
        joinedAt: m.joined_at
      })),
      projects
    };
  },

  createTeam(rawName, rawDesc) {
    const name = String(rawName || '').trim();
    if (!name) throw new Error('Le nom de l’équipe ne peut pas être vide.');
    const desc = String(rawDesc || '').trim();

    let id = slug(name);
    const checkId = db.prepare('SELECT id FROM teams WHERE id = ?');
    if (checkId.get(id)) {
      id = `${id}-${uid().slice(0, 4)}`;
    }

    const now = Date.now();
    db.prepare('INSERT INTO teams (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name, desc, now);
    return { id, name, description: desc, createdAt: now, members: [], projects: [] };
  },

  updateTeam(teamId, { name, description }) {
    const existing = db.prepare('SELECT id, name, description FROM teams WHERE id = ?').get(teamId);
    if (!existing) throw new Error('Équipe introuvable.');

    const newName = name !== undefined ? String(name).trim() : existing.name;
    const newDesc = description !== undefined ? String(description).trim() : (existing.description || '');
    if (!newName) throw new Error('Le nom de l’équipe ne peut pas être vide.');

    db.prepare('UPDATE teams SET name = ?, description = ? WHERE id = ?').run(newName, newDesc, teamId);
    return { id: teamId, name: newName, description: newDesc };
  },

  deleteTeam(teamId) {
    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare('DELETE FROM team_projects WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
    return { success: true };
  },

  // --- MEMBRES D'ÉQUIPE ---
  addTeamMember(teamId, artistId, role = 'member') {
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) throw new Error('Équipe introuvable.');
    const artist = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(artistId);
    if (!artist) throw new Error('Artiste introuvable.');

    const validRole = role === 'lead' ? 'lead' : 'member';
    const now = Date.now();
    db.prepare(`
      INSERT INTO team_members (team_id, artist_id, role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, artist_id) DO UPDATE SET role = excluded.role
    `).run(teamId, artistId, validRole, now);

    return { teamId, artistId, artistName: artist.name, role: validRole, joinedAt: now };
  },

  removeTeamMember(teamId, artistId) {
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND artist_id = ?').run(teamId, artistId);
    return { success: true };
  },

  updateTeamMemberRole(teamId, artistId, role) {
    const validRole = role === 'lead' ? 'lead' : 'member';
    db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND artist_id = ?').run(validRole, teamId, artistId);
    return { success: true, role: validRole };
  },

  // --- PROJETS D'ÉQUIPE ---
  listTeamProjects(teamId) {
    const rows = db.prepare(`
      SELECT id, team_id, name, brief, status, created_at, updated_at, data
      FROM team_projects
      WHERE team_id = ?
      ORDER BY updated_at DESC
    `).all(teamId);

    return rows.map(r => {
      let data = {};
      try { data = JSON.parse(r.data); } catch (_) {}
      return {
        id: r.id,
        teamId: r.team_id,
        name: r.name,
        brief: r.brief || '',
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tasksCount: Array.isArray(data.tasks) ? data.tasks.length : 0,
        data
      };
    });
  },

  getTeamProject(teamId, projectId) {
    const row = db.prepare(`
      SELECT id, team_id, name, brief, status, created_at, updated_at, data
      FROM team_projects
      WHERE team_id = ? AND id = ?
    `).get(teamId, projectId);
    if (!row) return null;

    let data = {};
    try { data = JSON.parse(row.data); } catch (_) {}
    return {
      id: row.id,
      teamId: row.team_id,
      name: row.name,
      brief: row.brief || '',
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...data
    };
  },

  saveTeamProject(teamId, projectObj) {
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) throw new Error('Équipe introuvable.');

    const name = String(projectObj.name || 'Projet d’équipe sans titre').trim();
    const brief = String(projectObj.brief || '').trim();
    const status = projectObj.status || 'plan';
    const now = Date.now();
    let id = projectObj.id ? String(projectObj.id).trim() : null;

    if (!id) {
      id = `tp-${uid()}`;
    }

    const dataObj = {
      brief,
      available: projectObj.available != null ? projectObj.available : null,
      startedAt: projectObj.startedAt || null,
      finishedAt: projectObj.finishedAt || null,
      categories: Array.isArray(projectObj.categories) ? projectObj.categories : [],
      tasks: Array.isArray(projectObj.tasks) ? projectObj.tasks : []
    };

    const jsonStr = JSON.stringify(dataObj);

    db.prepare(`
      INSERT INTO team_projects (id, team_id, name, brief, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        brief = excluded.brief,
        status = excluded.status,
        updated_at = excluded.updated_at,
        data = excluded.data
    `).run(id, teamId, name, brief, status, projectObj.createdAt || now, now, jsonStr);

    return {
      id,
      teamId,
      name,
      brief,
      status,
      createdAt: projectObj.createdAt || now,
      updatedAt: now,
      ...dataObj
    };
  },

  deleteTeamProject(teamId, projectId) {
    db.prepare('DELETE FROM team_projects WHERE team_id = ? AND id = ?').run(teamId, projectId);
    return { success: true };
  },

  getAllGroupTasks() {
    const teams = db.prepare('SELECT id, name FROM teams').all();
    const allTasks = [];
    for (const team of teams) {
      const projects = db.prepare('SELECT id, name, data FROM team_projects WHERE team_id = ?').all(team.id);
      for (const p of projects) {
        let data = {};
        try { data = JSON.parse(p.data); } catch (_) {}
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        for (const t of tasks) {
          allTasks.push({
            ...t,
            teamId: team.id,
            teamName: team.name,
            groupId: team.id,
            groupName: team.name,
            projectId: p.id,
            projectName: p.name,
            sprint: t.sprint || 'Sprint Beta',
            story: t.story || 'HUD'
          });
        }
      }
    }
    return allTasks;
  },

  getTeamTasks(teamId) {
    const team = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(teamId);
    const teamName = team ? team.name : 'Groupe';
    const projects = db.prepare('SELECT id, name, data FROM team_projects WHERE team_id = ?').all(teamId);
    const allTasks = [];
    for (const p of projects) {
      let data = {};
      try { data = JSON.parse(p.data); } catch (_) {}
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      for (const t of tasks) {
        allTasks.push({
          ...t,
          teamId,
          teamName,
          groupId: teamId,
          groupName: teamName,
          projectId: p.id,
          projectName: p.name,
          sprint: t.sprint || 'Sprint Beta',
          story: t.story || 'HUD'
        });
      }
    }
    return allTasks;
  },

  addTeamTask(teamId, projectId, taskObj) {
    const p = this.getTeamProject(teamId, projectId);
    if (!p) throw new Error('Projet de groupe introuvable.');
    const newTask = {
      id: taskObj.id || `t-${uid()}`,
      name: String(taskObj.name || 'Tâche sans titre').trim(),
      sprint: String(taskObj.sprint || 'Sprint Beta').trim(),
      story: String(taskObj.story || 'HUD').trim(),
      cat: taskObj.cat || 'autre',
      est: Number(taskObj.est) || 60,
      conf: Number(taskObj.conf) || 3,
      spent: Number(taskObj.spent) || 0,
      status: taskObj.status || 'todo',
      assigneeId: taskObj.assigneeId || null,
      assigneeName: taskObj.assigneeName || null,
      assignees: Array.isArray(taskObj.assignees) ? taskObj.assignees : (taskObj.assigneeId ? [{ artistId: taskObj.assigneeId, artistName: taskObj.assigneeName }] : []),
      planned: taskObj.planned !== undefined ? !!taskObj.planned : (p.status === 'plan'),
      reasons: Array.isArray(taskObj.reasons) ? taskObj.reasons : [],
      doneAt: taskObj.status === 'done' ? (taskObj.doneAt || Date.now()) : null,
      createdAt: taskObj.createdAt || Date.now()
    };
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
    p.tasks.push(newTask);
    this.saveTeamProject(teamId, p);
    return { task: newTask, project: p };
  },

  updateTeamTask(teamId, projectId, taskId, updates) {
    const p = this.getTeamProject(teamId, projectId);
    if (!p) throw new Error('Projet de groupe introuvable.');
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
    const t = p.tasks.find(x => x.id === taskId);
    if (!t) throw new Error('Tâche introuvable.');
    if (updates.name !== undefined) t.name = String(updates.name).trim();
    if (updates.sprint !== undefined) t.sprint = String(updates.sprint).trim();
    if (updates.story !== undefined) t.story = String(updates.story).trim();
    if (updates.cat !== undefined) t.cat = updates.cat;
    if (updates.est !== undefined) t.est = Number(updates.est);
    if (updates.conf !== undefined) t.conf = Number(updates.conf);
    if (updates.spent !== undefined) t.spent = Number(updates.spent);
    if (updates.status !== undefined) {
      t.status = updates.status;
      if (updates.status === 'done' && !t.doneAt) t.doneAt = Date.now();
      else if (updates.status !== 'done') t.doneAt = null;
    }
    if (updates.assigneeId !== undefined) {
      t.assigneeId = updates.assigneeId || null;
      if (updates.assigneeName !== undefined) {
        t.assigneeName = updates.assigneeName;
      } else if (!t.assigneeId) {
        t.assigneeName = null;
      }
    }
    if (updates.assignees !== undefined) {
      t.assignees = Array.isArray(updates.assignees) ? updates.assignees : [];
      if (t.assignees.length > 0 && !updates.assigneeId) {
        t.assigneeId = t.assignees[0].artistId;
        t.assigneeName = t.assignees[0].artistName;
      }
    }
    if (updates.reasons !== undefined) t.reasons = updates.reasons;
    this.saveTeamProject(teamId, p);
    return { task: t, project: p };
  },

  // --- VUE GLOBALE & ANALYTICS DU PROJET D'ÉQUIPE ---
  getTeamOverview(teamId, projectId = null) {
    const team = db.prepare('SELECT id, name, description, created_at FROM teams WHERE id = ?').get(teamId);
    if (!team) return null;

    const members = db.prepare(`
      SELECT tm.artist_id, tm.role, a.name as artist_name, a.last_active
      FROM team_members tm
      JOIN artists a ON tm.artist_id = a.id
      WHERE tm.team_id = ?
    `).all(teamId);

    let projectsQuery = 'SELECT id, team_id, name, status, created_at, updated_at, data FROM team_projects WHERE team_id = ?';
    const params = [teamId];
    if (projectId) {
      projectsQuery += ' AND id = ?';
      params.push(projectId);
    }
    const projects = db.prepare(projectsQuery).all(...params);

    const memberStats = {};
    for (const m of members) {
      memberStats[m.artist_id] = {
        artistId: m.artist_id,
        artistName: m.artist_name,
        role: m.role,
        lastActive: m.last_active,
        totalTasks: 0,
        doneTasks: 0,
        wipTasks: 0,
        todoTasks: 0,
        plannedMin: 0,
        actualSpentMs: 0,
        actualSpentMin: 0,
        progressPct: 0,
        ratio: null
      };
    }

    const unassignedStats = {
      artistId: null,
      artistName: 'Non assigné(e)',
      role: 'none',
      totalTasks: 0,
      doneTasks: 0,
      wipTasks: 0,
      todoTasks: 0,
      plannedMin: 0,
      actualSpentMs: 0,
      actualSpentMin: 0,
      progressPct: 0,
      ratio: null
    };

    let totalTasksCount = 0;
    let totalDoneCount = 0;
    let totalPlannedMin = 0;
    let totalActualSpentMs = 0;
    const catStats = {};

    const projectOverviews = projects.map(p => {
      let data = {};
      try { data = JSON.parse(p.data); } catch (_) {}
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];

      let pPlannedMin = 0;
      let pSpentMs = 0;
      let pDone = 0;

      for (const t of tasks) {
        const estMin = Number(t.est) || 0;
        const spentMs = Number(t.spent) || 0;
        const status = t.status || 'todo';
        const assignee = t.assigneeId;

        pPlannedMin += estMin;
        pSpentMs += spentMs;
        totalPlannedMin += estMin;
        totalActualSpentMs += spentMs;
        totalTasksCount++;

        if (status === 'done') {
          pDone++;
          totalDoneCount++;
        }

        const cat = t.cat || 'autre';
        if (!catStats[cat]) {
          catStats[cat] = { cat, plannedMin: 0, spentMin: 0, tasksCount: 0 };
        }
        catStats[cat].plannedMin += estMin;
        catStats[cat].spentMin += Math.round(spentMs / 60000);
        catStats[cat].tasksCount++;

        const target = (assignee && memberStats[assignee]) ? memberStats[assignee] : unassignedStats;
        target.totalTasks++;
        target.plannedMin += estMin;
        target.actualSpentMs += spentMs;
        if (status === 'done') target.doneTasks++;
        else if (status === 'wip') target.wipTasks++;
        else target.todoTasks++;
      }

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        tasksCount: tasks.length,
        doneTasks: pDone,
        progressPct: tasks.length ? Math.round((pDone / tasks.length) * 100) : 0,
        plannedMin: pPlannedMin,
        actualSpentMin: Math.round(pSpentMs / 60000)
      };
    });

    for (const key of Object.keys(memberStats)) {
      const ms = memberStats[key];
      ms.actualSpentMin = Math.round(ms.actualSpentMs / 60000);
      if (ms.plannedMin > 0 && ms.actualSpentMin > 0) {
        ms.ratio = +(ms.actualSpentMin / ms.plannedMin).toFixed(2);
      }
      ms.progressPct = ms.totalTasks ? Math.round((ms.doneTasks / ms.totalTasks) * 100) : 0;
    }
    unassignedStats.actualSpentMin = Math.round(unassignedStats.actualSpentMs / 60000);
    unassignedStats.progressPct = unassignedStats.totalTasks ? Math.round((unassignedStats.doneTasks / unassignedStats.totalTasks) * 100) : 0;

    const membersList = Object.values(memberStats);
    if (unassignedStats.totalTasks > 0) {
      membersList.push(unassignedStats);
    }

    const totalActualSpentMin = Math.round(totalActualSpentMs / 60000);
    const globalRatio = (totalPlannedMin > 0 && totalActualSpentMin > 0)
      ? +(totalActualSpentMin / totalPlannedMin).toFixed(2)
      : null;

    return {
      team: {
        id: team.id,
        name: team.name,
        description: team.description || '',
        createdAt: team.created_at
      },
      summary: {
        totalProjects: projects.length,
        totalMembers: members.length,
        totalTasks: totalTasksCount,
        doneTasks: totalDoneCount,
        progressPct: totalTasksCount ? Math.round((totalDoneCount / totalTasksCount) * 100) : 0,
        totalPlannedMin,
        totalActualSpentMin,
        globalRatio
      },
      members: membersList,
      projects: projectOverviews,
      categories: Object.values(catStats)
    };
  },

  getAdminStats() {
    const artistsCount = db.prepare('SELECT COUNT(*) as count FROM artists').get().count;
    const teamsCount = db.prepare('SELECT COUNT(*) as count FROM teams').get().count;
    const teamProjectsCount = db.prepare('SELECT COUNT(*) as count FROM team_projects').get().count;
    const active7Days = db.prepare(`
      SELECT COUNT(*) as count FROM artists
      WHERE last_active >= ?
    `).get(Date.now() - 7 * 24 * 3600 * 1000).count;

    return {
      artistsCount: Number(artistsCount),
      teamsCount: Number(teamsCount),
      teamProjectsCount: Number(teamProjectsCount),
      active7Days: Number(active7Days),
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now()
    };
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

    const teams = db.prepare('SELECT * FROM teams ORDER BY name ASC').all();
    const teamMembers = db.prepare('SELECT * FROM team_members').all();
    const teamProjects = db.prepare('SELECT * FROM team_projects').all().map(tp => {
      let parsed = {};
      try { parsed = JSON.parse(tp.data); } catch (_) {}
      return { ...tp, data: parsed };
    });

    return {
      version: 2,
      exportedAt: Date.now(),
      artists: artists.map(a => ({
        ...a,
        state: stateMap[a.id] || null
      })),
      teams,
      teamMembers,
      teamProjects
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

      if (Array.isArray(backup.teams)) {
        for (const t of backup.teams) {
          if (!t.id || !t.name) continue;
          db.prepare(`
            INSERT INTO teams (id, name, description, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description
          `).run(t.id, t.name, t.description || '', t.created_at || Date.now());
        }
      }

      if (Array.isArray(backup.teamMembers)) {
        for (const m of backup.teamMembers) {
          if (!m.team_id || !m.artist_id) continue;
          db.prepare(`
            INSERT INTO team_members (team_id, artist_id, role, joined_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(team_id, artist_id) DO UPDATE SET role = excluded.role
          `).run(m.team_id, m.artist_id, m.role || 'member', m.joined_at || Date.now());
        }
      }

      if (Array.isArray(backup.teamProjects)) {
        for (const tp of backup.teamProjects) {
          if (!tp.id || !tp.team_id || !tp.name) continue;
          const dataStr = typeof tp.data === 'string' ? tp.data : JSON.stringify(tp.data || {});
          db.prepare(`
            INSERT INTO team_projects (id, team_id, name, brief, status, created_at, updated_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              brief = excluded.brief,
              status = excluded.status,
              updated_at = excluded.updated_at,
              data = excluded.data
          `).run(tp.id, tp.team_id, tp.name, tp.brief || '', tp.status || 'plan', tp.created_at || Date.now(), tp.updated_at || Date.now(), dataStr);
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
