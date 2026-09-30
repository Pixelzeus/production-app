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
  await wait(1500); // Laisse le serveur démarrer

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
