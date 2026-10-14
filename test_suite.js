const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3333;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = path.join(__dirname, 'test_data');

// Prépare un dossier de test isolé
if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

console.log('🚀 Démarrage de la suite d’audit Sécurité & Fonctionnalités...\n');

// Lance le serveur en mode test
const serverProcess = spawn('node', ['--no-warnings', 'server/index.js'], {
  env: {
    ...process.env,
    PORT: TEST_PORT,
    DATA_DIR: TEST_DATA_DIR
  },
  stdio: 'pipe'
});

serverProcess.stdout.on('data', (d) => {
  // console.log('[LOG]', d.toString());
});
serverProcess.stderr.on('data', (d) => {
  console.error('[ERR]', d.toString());
});

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  // Attente résiliente du démarrage effectif du serveur (jusqu'à 10s)
  let serverReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const ping = await fetch(`${BASE_URL}/api/health`);
      if (ping.ok) {
        serverReady = true;
        break;
      }
    } catch (_) {}
    await wait(300);
  }
  if (!serverReady) {
    console.error('❌ Le serveur de test n’a pas démarré dans les temps impartis.');
    serverProcess.kill();
    process.exit(1);
  }

  try {
    console.log('--- 1. AUDIT SÉCURITÉ RÉSEAU & EN-TÊTES HTTP ---');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    assert(healthRes.status === 200, 'Endpoint /api/health retourne HTTP 200');
    assert(healthRes.headers.get('x-content-type-options') === 'nosniff', 'En-tête X-Content-Type-Options: nosniff présent');
    assert(healthRes.headers.get('x-frame-options') === 'SAMEORIGIN', 'En-tête X-Frame-Options: SAMEORIGIN présent (protection clickjacking)');
    assert(!healthRes.headers.has('x-powered-by'), 'En-tête x-powered-by masqué (pas de fuite Express)');
    
    const healthData = await healthRes.json();
    assert(healthData.status === 'ok', 'Health status est OK');
    assert(!healthData.db, 'Pas de fuite du chemin absolu du disque dans /api/health (CWE-200)');

    console.log('\n--- 2. AUDIT VALIDATION DES ENTRÉES & RÉSISTANCE AUX INJECTIONS ---');
    // Test rejet nom vide
    const emptyNameRes = await fetch(`${BASE_URL}/api/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' })
    });
    assert(emptyNameRes.status === 400, 'Rejet d’un nom vide ou composé uniquement d’espaces (HTTP 400)');

    // Test rejet nom trop long (> 50 caractères)
    const longNameRes = await fetch(`${BASE_URL}/api/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A'.repeat(51) })
    });
    assert(longNameRes.status === 400, 'Rejet d’un nom d’artiste > 50 caractères (protection DoS)');

    // Test tentative d’injection dans l’ID de route (URL encodée)
    const badIdRes = await fetch(`${BASE_URL}/api/artists/%2E%2E%2Fetc%2Fpasswd/state`);
    assert(badIdRes.status === 400 || badIdRes.status === 404, 'Protection contre path traversal sur :id (HTTP 400 ou 404)');

    const badCharsRes = await fetch(`${BASE_URL}/api/artists/${encodeURIComponent('<script>alert(1)</script>')}/state`);
    assert(badCharsRes.status === 400, 'Rejet des identifiants avec balises ou caractères invalides (HTTP 400)');

    const notFoundApiRes = await fetch(`${BASE_URL}/api/non_existent_route`);
    assert(notFoundApiRes.status === 404, 'Route API inconnue retourne HTTP 404 JSON (pas de page HTML renvoyée par erreur)');

    console.log('\n--- 3. TEST FONCTIONNEL : CYCLE COMPLET D’UN GAME ARTIST ---');
    // Création d’un artiste valide
    const createRes = await fetch(`${BASE_URL}/api/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Camille 3D' })
    });
    assert(createRes.status === 200, 'Création réussie de l’artiste "Camille 3D"');
    const createData = await createRes.json();
    const artistId = createData.artist.id;
    assert(artistId === 'camille-3d', 'Slug d’artiste correct ("camille-3d")');

    // Sauvegarde d’un projet pour cet artiste
    const projectState = {
      v: 1,
      student: 'Camille 3D',
      projects: [{
        id: 'proj-asset-1',
        name: 'Épée médiévale (Low-poly)',
        status: 'wip',
        tasks: [
          { id: 't1', name: 'High Poly Sculpt', cat: 'sculpt', est: 180, spent: 120, conf: 4, status: 'done' },
          { id: 't2', name: 'Retopo & UV', cat: 'retopo', est: 90, spent: 0, conf: 3, status: 'todo' }
        ]
      }]
    };

    const saveRes = await fetch(`${BASE_URL}/api/artists/${artistId}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectState)
    });
    assert(saveRes.status === 200, 'Sauvegarde de l’état du projet sur le serveur réussie');

    // Rechargement immédiat pour vérifier la persistance SQLite
    const loadRes = await fetch(`${BASE_URL}/api/artists/${artistId}/state`);
    assert(loadRes.status === 200, 'Récupération de l’état depuis SQLite réussie');
    const loadedData = await loadRes.json();
    assert(loadedData.projects.length === 1, 'Projet bien conservé');
    assert(loadedData.projects[0].name === 'Épée médiévale (Low-poly)', 'Nom du projet intact');
    assert(loadedData.projects[0].tasks.length === 2, '2 tâches persistées avec durées et chronos');

    console.log('\n--- 4. TEST SAUVEGARDE GLOBALE & RESTAURATION ---');
    const backupRes = await fetch(`${BASE_URL}/api/backup`);
    assert(backupRes.status === 200, 'Export de sauvegarde global réussi');
    const backupData = await backupRes.json();
    assert(Array.isArray(backupData.artists), 'Sauvegarde contient la liste des artistes');
    assert(backupData.artists.some(a => a.id === 'camille-3d'), 'L’artiste testé est bien présent dans la sauvegarde');

    console.log('\n--- 5. TEST DU SERVEUR STATIQUE & ROUTING SPA ---');
    const spaRes = await fetch(`${BASE_URL}/projet/proj-asset-1`);
    assert(spaRes.status === 200, 'Routing SPA : URL profonde /projet/... renvoie le code 200');
    const htmlText = await spaRes.text();
    assert(htmlText.includes('<!DOCTYPE html>'), 'Le document retourné est bien la page HTML');
    assert(htmlText.includes('Carnet de Prod'), 'Titre de l’application présent dans la page');
    assert(htmlText.includes('artistBtn'), 'Badge du sélecteur d’artiste présent dans l’en-tête');
    assert(htmlText.includes('data-page="teams"'), 'Lien de navigation Équipes & Admin présent dans l’en-tête');

    // Audit de validité syntaxique du code JavaScript client
    const scriptMatch = htmlText.match(/<script>([\s\S]*?)<\/script>/);
    assert(scriptMatch && scriptMatch[1], 'Balise script principale présente dans la page');
    let syntaxValid = false;
    try {
      new Function(scriptMatch[1]);
      syntaxValid = true;
    } catch (e) {
      console.error('Erreur de syntaxe JS client:', e.message);
    }
    assert(syntaxValid, 'Code JavaScript client 100 % valide (aucune erreur de syntaxe/await)');

    console.log('\n--- 6. TEST GESTION D’ÉQUIPES, PROJETS MULTI-ARTISTES & VUE GLOBALE ---');
    // Vérification du statut admin (libre par défaut)
    const adminStatusRes = await fetch(`${BASE_URL}/api/admin/status`);
    assert(adminStatusRes.status === 200, 'Endpoint /api/admin/status retourne HTTP 200');
    const adminStatus = await adminStatusRes.json();
    assert(adminStatus.protected === false, 'Protection admin désactivée par défaut');

    // Création d’une équipe
    const createTeamRes = await fetch(`${BASE_URL}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Équipe Cyberpunk', description: 'Projet de fin d’année' })
    });
    assert(createTeamRes.status === 200, 'Création réussie de l’équipe "Équipe Cyberpunk"');
    const teamData = await createTeamRes.json();
    const teamId = teamData.id;
    assert(teamId === 'equipe-cyberpunk', 'Slug d’équipe généré correctement ("equipe-cyberpunk")');

    // Création d'un second artiste
    const artist2Res = await fetch(`${BASE_URL}/api/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alex Texture' })
    });
    assert(artist2Res.status === 200, 'Création du 2e artiste "Alex Texture"');
    const artist2 = await artist2Res.json();

    // Ajout des artistes à l'équipe
    const addLeadRes = await fetch(`${BASE_URL}/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artistId: 'camille-3d', role: 'lead' })
    });
    assert(addLeadRes.status === 200, 'Camille ajoutée comme Lead de l’équipe');

    const addMemberRes = await fetch(`${BASE_URL}/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artistId: artist2.artist.id, role: 'member' })
    });
    assert(addMemberRes.status === 200, 'Alex ajouté comme Membre de l’équipe');

    // Vérification de la liste des membres dans l'équipe
    const getTeamRes = await fetch(`${BASE_URL}/api/teams/${teamId}`);
    assert(getTeamRes.status === 200, 'Récupération de l’équipe réussie');
    const fullTeam = await getTeamRes.json();
    assert(fullTeam.members.length === 2, 'L’équipe contient bien 2 membres');
    assert(fullTeam.members.some(m => m.artistId === 'camille-3d' && m.role === 'lead'), 'Camille est bien Lead');

    // Création d'un projet partagé multi-artistes
    const createProjectRes = await fetch(`${BASE_URL}/api/teams/${teamId}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Véhicule Blindé Sci-Fi',
        brief: 'Asset principal pour le jeu',
        status: 'wip',
        tasks: [
          { id: 't-sculpt', name: 'High Poly Carrosserie', cat: 'sculpt', est: 240, spent: 180 * 60000, conf: 4, status: 'done', assigneeId: 'camille-3d' },
          { id: 't-text', name: 'Textures PBR & Shaders', cat: 'texture', est: 180, spent: 60 * 60000, conf: 3, status: 'wip', assigneeId: artist2.artist.id },
          { id: 't-rig', name: 'Rigging des roues & suspensions', cat: 'rig', est: 120, spent: 0, conf: 2, status: 'todo', assigneeId: null }
        ]
      })
    });
    assert(createProjectRes.status === 200, 'Création du projet collaboratif d’équipe réussie');
    const teamProj = await createProjectRes.json();
    assert(teamProj.tasks.length === 3, 'Le projet d’équipe contient 3 tâches partagées');

    // Test de la Vue Globale du projet à plusieurs (/api/teams/:id/overview)
    const overviewRes = await fetch(`${BASE_URL}/api/teams/${teamId}/overview`);
    assert(overviewRes.status === 200, 'Endpoint de la vue globale /api/teams/:id/overview répond HTTP 200');
    const overview = await overviewRes.json();
    assert(overview.summary.totalTasks === 3, 'Vue globale : 3 tâches au total');
    assert(overview.summary.doneTasks === 1, 'Vue globale : 1 tâche terminée');
    assert(overview.summary.progressPct === 33, 'Vue globale : 33 % de progression');
    assert(overview.summary.totalPlannedMin === 540, 'Vue globale : 540 minutes prévues');
    assert(overview.summary.totalActualSpentMin === 240, 'Vue globale : 240 minutes passées');

    // Vérification des statistiques par membre
    const camilleStats = overview.members.find(m => m.artistId === 'camille-3d');
    assert(camilleStats && camilleStats.doneTasks === 1 && camilleStats.plannedMin === 240, 'Stats individuelles de Camille exactes');
    const alexStats = overview.members.find(m => m.artistId === artist2.artist.id);
    assert(alexStats && alexStats.wipTasks === 1 && alexStats.plannedMin === 180, 'Stats individuelles d’Alex exactes');

    // Test des statistiques admin globales
    const adminStatsRes = await fetch(`${BASE_URL}/api/admin/stats`);
    assert(adminStatsRes.status === 200, 'Endpoint /api/admin/stats répond HTTP 200');
    const adminStats = await adminStatsRes.json();
    assert(adminStats.teamsCount >= 1, 'Admin stats : au moins 1 équipe comptabilisée');
    assert(adminStats.teamProjectsCount >= 1, 'Admin stats : au moins 1 projet d’équipe comptabilisé');

    // Mise à jour du projet d'équipe (modification de tâche & statut)
    teamProj.tasks[1].status = 'done';
    teamProj.tasks[1].spent = 175 * 60000;
    const updateProjRes = await fetch(`${BASE_URL}/api/teams/${teamId}/projects/${teamProj.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamProj)
    });
    assert(updateProjRes.status === 200, 'Mise à jour du projet d’équipe (PUT) réussie');
    const updatedProj = await updateProjRes.json();
    assert(updatedProj.tasks[1].status === 'done', 'Tâche collaborative 2 marquée comme terminée');

    // Vérification de la mise à jour dans l'overview
    const updatedOverviewRes = await fetch(`${BASE_URL}/api/teams/${teamId}/overview`);
    const updatedOverview = await updatedOverviewRes.json();
    assert(updatedOverview.summary.doneTasks === 2, 'Overview actualisé : 2 tâches terminées');
    assert(updatedOverview.summary.progressPct === 67, 'Overview actualisé : 67 % de progression');

    // Test des nouveaux endpoints Kanban & Tâches d’équipe directes
    const teamTasksRes = await fetch(`${BASE_URL}/api/teams/${teamId}/tasks`);
    assert(teamTasksRes.status === 200, 'Endpoint /api/teams/:id/tasks répond HTTP 200');
    const teamTasks = await teamTasksRes.json();
    assert(Array.isArray(teamTasks) && teamTasks.length === 3, 'Récupération de toutes les tâches d’équipe (Kanban global) réussie (3 tâches)');

    // Ajout direct d'une tâche d'équipe (depuis la vue solo ou la vue équipe)
    const addTaskDirectRes = await fetch(`${BASE_URL}/api/teams/${teamId}/projects/${teamProj.id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Concept Art Props',
        cat: 'concept',
        est: 90,
        conf: 4,
        assigneeId: 'camille-3d',
        assigneeName: 'Camille 3D'
      })
    });
    assert(addTaskDirectRes.status === 200, 'Ajout direct d’une tâche d’équipe (POST .../tasks) réussi');
    const directTaskResult = await addTaskDirectRes.json();
    assert(directTaskResult.task && directTaskResult.task.name === 'Concept Art Props', 'Tâche d’équipe créée avec attributs valides');

    // Mise à jour de statut / Drag & Drop Kanban (PATCH .../tasks/:tid)
    const updateTaskDirectRes = await fetch(`${BASE_URL}/api/teams/${teamId}/projects/${teamProj.id}/tasks/${directTaskResult.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'wip',
        spent: 30 * 60000
      })
    });
    assert(updateTaskDirectRes.status === 200, 'Mise à jour statut Kanban (PATCH .../tasks/:tid) réussie');
    const patchedTaskResult = await updateTaskDirectRes.json();
    assert(patchedTaskResult.task.status === 'wip' && patchedTaskResult.task.spent === 1800000, 'Tâche d’équipe passée en cours avec temps enregistré');

    // Vérification de la présence des composants frontend collaboratifs dans le HTML
    assert(htmlText.includes('team-overview-hero'), 'UI: Baromètre Global présent dans le template');
    assert(htmlText.includes('team-members-workload'), 'UI: Grille de charge par artiste présente');
    assert(htmlText.includes('data-act="reassign-team-task"'), 'UI: Réassignation collaborative en 1-clic présente');
    assert(htmlText.includes('data-act="toggle-team-timer"'), 'UI: Chronométrage des tâches d’équipe présent');
    assert(htmlText.includes('data-form="add-team-task"'), 'UI: Formulaire d’ajout de tâche collaborative présent');
    assert(htmlText.includes('kanban-board'), 'UI: Tableau Kanban complet présent dans le template');
    assert(htmlText.includes('kanban-col'), 'UI: Colonnes Kanban (À faire, En cours, Terminé) présentes');
    assert(htmlText.includes('kanban-card'), 'UI: Cartes Kanban interactives présentes');
    assert(htmlText.includes('data-act="open-solo-to-team"'), 'UI: Bouton création vers équipe depuis le solo présent');
    assert(htmlText.includes('data-act="open-push-to-team"'), 'UI: Bouton transfert tâche solo vers équipe présent');
    assert(htmlText.includes('data-act="set-team-tab"'), 'UI: Onglets de navigation d’équipe présents');
    assert(htmlText.includes('data-act="open-create-team-task"'), 'UI: Bouton nouvelle tâche d’équipe présent');

    // Suppression d'un projet d'équipe
    const deleteProjRes = await fetch(`${BASE_URL}/api/teams/${teamId}/projects/${teamProj.id}`, {
      method: 'DELETE'
    });
    assert(deleteProjRes.status === 200, 'Suppression d’un projet d’équipe (DELETE) réussie');
    const checkTeamRes = await fetch(`${BASE_URL}/api/teams/${teamId}`);
    const checkTeam = await checkTeamRes.json();
    assert(checkTeam.projects.length === 0, 'Le projet a bien été retiré de l’équipe');

    // Test de sauvegarde et restauration incluant les équipes
    const backupFullRes = await fetch(`${BASE_URL}/api/backup`);
    const backupFull = await backupFullRes.json();
    assert(Array.isArray(backupFull.teams) && backupFull.teams.some(t => t.id === teamId), 'Sauvegarde globale contient l’équipe créée');
    assert(Array.isArray(backupFull.teamMembers) && backupFull.teamMembers.length >= 2, 'Sauvegarde globale contient les membres de l’équipe');

    const restoreRes = await fetch(`${BASE_URL}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backupFull)
    });
    assert(restoreRes.status === 200, 'Restauration complète de la base de données réussie');

    // Test de l'endpoint /api/admin/verify
    const verifyUnprotectedRes = await fetch(`${BASE_URL}/api/admin/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'anything' })
    });
    assert(verifyUnprotectedRes.status === 200, '/api/admin/verify accepte sans mot de passe quand non protégé');

  } catch (err) {
    console.error('Erreur inattendue durant les tests:', err);
    failed++;
  } finally {
    // Arrête le serveur de test
    serverProcess.kill();
    // Nettoie le dossier de test
    await wait(500);
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  }

  console.log(`\n========================================`);
  console.log(`RÉSULTAT DE L’AUDIT : ${passed} succès, ${failed} échec(s)`);
  console.log(`========================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
