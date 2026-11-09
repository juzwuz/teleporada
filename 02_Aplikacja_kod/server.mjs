import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPassword, codes, digest, fhirBundle, generateDraft, hashPassword, now, openDatabase, sections, transaction } from './model.mjs';
import { createSummaryAI } from './summary-ai.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const origin = new URL(process.env.APP_ORIGIN || `http://localhost:${port}`).origin;
const iceServers = JSON.parse(process.env.ICE_SERVERS || '[]');
const summaryAI = createSummaryAI({
  model: process.env.AI_SUMMARY_MODEL,
  port: Number(process.env.AI_SUMMARY_PORT || 11434),
});
const directory = dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.DB_PATH || resolve(directory, 'data', 'teleporada.sqlite');
mkdirSync(dirname(dataFile), { recursive: true });
const db = openDatabase(dataFile);
db.exec("UPDATE visits SET summary_ai_status = 'failed' WHERE summary_ai_status = 'generating'");
const sessions = new Map();
const rooms = new Map();
const summaryJobs = new Map();
const loginAttempts = new Map();
const dummyPassword = hashPassword('invalid-placeholder');
const sessionMs = 8 * 60 * 60 * 1000;
const jsonLimit = 384 * 1024;
const cookieSecurity = origin.startsWith('https:') ? '; Secure' : '';
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/rtc.js': ['rtc.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = message => new HttpError(400, 'invalid_request', message);
const forbidden = () => new HttpError(403, 'forbidden', 'Brak uprawnień do tej operacji.');
const conflict = message => new HttpError(409, 'conflict', message);
const notFound = () => new HttpError(404, 'not_found', 'Zasób jest niedostępny.');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Wyślij dane w formacie JSON.');
  }
  const tooLarge = () => new HttpError(413, 'payload_too_large', 'Przekroczono dopuszczalną wielkość żądania.');
  if (Number(req.headers['content-length']) > jsonLimit) {
    req.resume();
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > jsonLimit) {
      req.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw invalid('Treść musi być obiektem JSON.');
  }
}

function string(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw invalid(`Pole „${label}” wymaga ${required ? '1' : '0'}–${max} znaków.`);
  }
  return value.trim();
}

function audit(actor, visitId, action) {
  db.prepare('INSERT INTO audit(actor_id, visit_id, action, created_at) VALUES (?, ?, ?, ?)')
    .run(actor.id, visitId, action, now());
}

function token(req) {
  return req.headers.cookie?.match(/(?:^|;\s*)teleporada=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function userFor(req) {
  const session = sessions.get(token(req));
  if (!session || session.expires <= Date.now()) {
    throw new HttpError(401, 'unauthorized', 'Zaloguj się, aby kontynuować.');
  }
  return session.user;
}

function requireRole(user, role) {
  if (user.role !== role) throw forbidden();
}

function publicUser({ id, name, role }) {
  return { id, name, role };
}

const selectVisit = `SELECT v.*, d.name AS doctor, p.name AS patient FROM visits v
  JOIN users d ON d.id = v.doctor_id JOIN users p ON p.id = v.patient_id`;

function findVisit(id, user) {
  const visit = db.prepare(`${selectVisit} WHERE v.id = ?`).get(id);
  if (!visit || ![visit.doctor_id, visit.patient_id].includes(user.id)) throw notFound();
  return visit;
}

function visitView(v) {
  return {
    id: v.id, doctor: v.doctor, patient: v.patient, topic: v.topic, status: v.status,
    createdAt: v.created_at, startedAt: v.started_at, endedAt: v.ended_at, version: v.version,
  };
}

function notesFor(visitId) {
  return db.prepare('SELECT id, section, text, source, created_at AS createdAt FROM notes WHERE visit_id = ? ORDER BY id')
    .all(visitId);
}

function getDocument(visitId) {
  const row = db.prepare('SELECT content_json, sha256 FROM documents WHERE visit_id = ?').get(visitId);
  if (!row) throw notFound();
  if (digest(row.content_json) !== row.sha256) {
    throw new HttpError(500, 'integrity_error', 'Weryfikacja integralności dokumentu nie powiodła się.');
  }
  return { ...JSON.parse(row.content_json), sha256: row.sha256 };
}

function page(url) {
  const raw = url.searchParams.get('offset') ?? '0';
  if (!/^\d{1,6}$/.test(raw)) throw invalid('Offset musi być liczbą od 0 do 999999.');
  return Number(raw);
}

function writeEvent(peer, event, data) {
  if (peer && !peer.res.destroyed && !peer.res.writableEnded) {
    if (peer.res.writableLength > 256 * 1024) return peer.res.destroy();
    peer.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function presence(room) {
  const data = { ready: room.peers.size === 2, generation: room.generation };
  for (const peer of room.peers.values()) writeEvent(peer, 'presence', data);
}

function removePeer(id, room, role, peer) {
  if (room.peers.get(role) !== peer) return;
  room.peers.delete(role);
  room.generation = randomUUID();
  if (!room.peers.size) rooms.delete(id);
  presence(room);
}

function openEvents(req, res, visit, user, clientId) {
  if (visit.status !== 'in_progress') throw conflict('Pokój nie jest teraz otwarty.');
  if (!/^[a-f0-9-]{36}$/.test(clientId || '')) throw invalid('Nieprawidłowy identyfikator karty.');
  const room = rooms.get(visit.id) || { generation: randomUUID(), peers: new Map() };
  const previous = room.peers.get(user.role);
  if (previous && previous.clientId !== clientId) throw conflict('Pokój jest już otwarty w innej karcie.');
  const peer = { res, clientId, token: token(req), userId: user.id };
  audit(user, visit.id, 'room.join');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  rooms.set(visit.id, room);
  room.peers.set(user.role, peer);
  room.generation = randomUUID();
  previous?.res.end();
  presence(room);
  res.on('close', () => removePeer(visit.id, room, user.role, peer));
}

function closeRoom(id) {
  const room = rooms.get(id);
  if (!room) return;
  for (const peer of room.peers.values()) {
    writeEvent(peer, 'ended', {});
    peer.res.end();
  }
  rooms.delete(id);
}

const signalTypes = ['offer', 'answer', 'candidate'];

function sendSignal(req, visit, user, body) {
  if (visit.status !== 'in_progress') throw conflict('Pokój jest zamknięty.');
  const room = rooms.get(visit.id);
  const own = room?.peers.get(user.role);
  const other = room?.peers.get(user.role === 'doctor' ? 'patient' : 'doctor');
  if (!own || own.clientId !== body.clientId || own.token !== token(req)
    || !other || room.generation !== body.generation) {
    throw conflict('Połączenie sygnalizacyjne zmieniło się.');
  }
  const { type, payload } = body;
  if (!signalTypes.includes(type) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid('Niepoprawny komunikat sygnalizacji.');
  }
  if (type === 'candidate') {
    if (typeof payload.candidate !== 'string' || payload.candidate.length > 2048
      || (payload.sdpMid != null && typeof payload.sdpMid !== 'string')
      || (payload.sdpMLineIndex != null && !Number.isInteger(payload.sdpMLineIndex))) {
      throw invalid('Niepoprawny kandydat ICE.');
    }
  } else if (type !== (user.role === 'doctor' ? 'offer' : 'answer')
    || payload.type !== type || typeof payload.sdp !== 'string' || payload.sdp.length > 65536) {
    throw invalid('Niepoprawny opis sesji.');
  }
  writeEvent(other, 'signal', { generation: room.generation, type, payload });
}

const demoNotes = [
  ['subjective', 'Pacjent zgłosił, że czuje się lepiej niż podczas poprzedniej wizyty.'],
  ['objective', 'Rozmowa wideo. Nie wykonano badania fizykalnego.'],
  ['assessment', 'Wizyta kontrolna w scenariuszu demonstracyjnym.'],
  ['plan', 'Rozmowę kontrolną ustalono na piątek o godz. 10:00. Pacjent przygotuje listę pytań.'],
];

function insertNote(visitId, section, text, source) {
  db.prepare('INSERT INTO notes(visit_id, section, text, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(visitId, section, text, source, now());
}

function ensureVersion(visit, body) {
  if (visit.status !== 'review') throw conflict('Edycja jest dostępna tylko na etapie weryfikacji.');
  if (body.version !== visit.version) throw conflict('Szkic zmienił się w innej karcie. Otwórz wizytę ponownie.');
}

function doctorDetails(visit) {
  return {
    notes: notesFor(visit.id),
    draft: visit.draft_json ? JSON.parse(visit.draft_json) : null,
    summaryStatus: visit.summary_ai_status,
  };
}

async function runSummary(visit, user) {
  const controller = new AbortController();
  summaryJobs.set(visit.id, controller);
  const draft = JSON.parse(visit.draft_json);
  try {
    let summary;
    try {
      summary = await summaryAI.summarize(draft.plan, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
    }
    if (controller.signal.aborted) return;
    transaction(db, () => {
      const status = summary ? 'generated' : 'failed';
      const updated = db.prepare(`UPDATE visits SET draft_json = ?, summary_ai_status = ?, version = version + 1
        WHERE id = ? AND status = 'review' AND summary_ai_status = 'generating' AND version = ?`)
        .run(summary ? JSON.stringify({ ...draft, patientSummary: summary }) : visit.draft_json, status, visit.id, visit.version);
      if (updated.changes) audit(user, visit.id, `summary.${status}`);
    });
  } finally {
    if (summaryJobs.get(visit.id) === controller) summaryJobs.delete(visit.id);
  }
}

async function visitRoute(req, res, url, user, id, action) {
  let visit = findVisit(id, user);
  if (req.method === 'GET') {
    if (action === 'events') return openEvents(req, res, visit, user, url.searchParams.get('clientId'));
    if (action === 'summary') {
      requireRole(user, 'doctor');
      return json(res, 200, { summaryStatus: visit.summary_ai_status });
    }
    if (action === 'document' || action === 'fhir') {
      if (action === 'fhir') requireRole(user, 'doctor');
      const document = getDocument(id);
      audit(user, id, action === 'fhir' ? 'fhir.export' : 'document.read');
      if (action === 'fhir') {
        res.setHeader('Content-Disposition', `attachment; filename="teleporada-${id}.fhir.json"`);
        return json(res, 200, fhirBundle(visit, document));
      }
      const { fields, sha256, ...metadata } = document;
      return json(res, 200, user.role === 'doctor' ? document : { ...metadata, patientSummary: fields.patientSummary });
    }
    if (action) throw notFound();
    audit(user, id, 'visit.read');
    const details = user.role === 'doctor' ? doctorDetails(visit) : {};
    return json(res, 200, { ...visitView(visit), ...details, iceServers });
  }

  const validActions = ['signal', 'start', 'notes', 'demo-notes', 'end', 'draft', 'regenerate', 'finalize', 'summary', 'cancel-summary'];
  if (!validActions.includes(action)) throw notFound();
  if (req.method !== (action === 'draft' ? 'PUT' : 'POST')) throw notFound();
  if (action !== 'signal') requireRole(user, 'doctor');
  const body = await readJson(req);
  userFor(req);
  visit = findVisit(id, user);
  if (action === 'signal') {
    sendSignal(req, visit, user, body);
    return json(res, 200, { ok: true });
  }

  transaction(db, () => {
    if (action === 'start') {
      if (visit.status !== 'scheduled') throw conflict('Można rozpocząć tylko oczekującą wizytę.');
      db.prepare("UPDATE visits SET status = 'in_progress', started_at = ? WHERE id = ?").run(now(), id);
    } else if (action === 'notes' || action === 'demo-notes') {
      if (visit.status !== 'in_progress') throw conflict('Notatki można dodawać podczas wizyty.');
      const count = db.prepare('SELECT count(*) AS count FROM notes WHERE visit_id = ?').get(id).count;
      const added = action === 'demo-notes' ? demoNotes.length : 1;
      if (count + added > 40) throw conflict('Osiągnięto limit 40 notatek na wizytę.');
      if (action === 'demo-notes') {
        if (notesFor(id).some(note => note.source === 'demo')) throw conflict('Dodano już notatki demonstracyjne.');
        for (const [section, text] of demoNotes) insertNote(id, section, text, 'demo');
      } else {
        if (!Object.keys(sections).slice(0, 4).includes(body.section)) throw invalid('Wybierz sekcję SOAP.');
        if (!['typed', 'dictated'].includes(body.source)) throw invalid('Nieprawidłowe źródło notatki.');
        insertNote(id, body.section, string(body.text, 'notatka', 400), body.source);
      }
    } else if (action === 'end') {
      if (visit.status !== 'in_progress') throw conflict('Można zakończyć tylko trwającą wizytę.');
      const draft = generateDraft(visit, notesFor(id));
      db.prepare(`UPDATE visits SET status = 'review', ended_at = ?, draft_json = ?, summary_ai_status = ?,
        version = version + 1 WHERE id = ?`).run(now(), JSON.stringify(draft), summaryAI.initialStatus(draft.plan), id);
    } else {
      ensureVersion(visit, body);
      const generating = visit.summary_ai_status === 'generating';
      if (generating && action !== 'cancel-summary') throw conflict('Trwa generowanie podsumowania AI.');
      let draft;
      if (action === 'cancel-summary') {
        if (!generating) throw conflict('Generowanie zostało już zakończone.');
        db.prepare("UPDATE visits SET summary_ai_status = 'cancelled', version = version + 1 WHERE id = ?").run(id);
      } else if (action === 'summary') {
        const currentDraft = JSON.parse(visit.draft_json);
        const status = summaryAI.initialStatus(currentDraft.plan);
        if (status === 'needs_plan') throw invalid('Uzupełnij i zapisz plan przed generowaniem.');
        if (status === 'too_long') throw invalid('Skróć plan do 6500 znaków i zapisz szkic.');
        if (status === 'disabled') throw conflict('Podsumowania AI są wyłączone w konfiguracji.');
        db.prepare("UPDATE visits SET summary_ai_status = 'generating', version = version + 1 WHERE id = ?").run(id);
      } else if (action === 'regenerate') {
        draft = generateDraft(visit, notesFor(id));
        db.prepare("UPDATE visits SET summary_ai_status = 'not_requested' WHERE id = ?").run(id);
      } else if (action === 'draft') {
        draft = Object.fromEntries(Object.entries(sections).map(([key, label]) =>
          [key, string(body[key], label, 18000, false)]));
        if (body.code !== '' && !Object.hasOwn(codes, body.code)) throw invalid('Wybierz kod z listy.');
        draft.code = body.code;
      } else {
        const fields = JSON.parse(visit.draft_json);
        if (!fields.patientSummary.trim() || !fields.plan.trim()) {
          throw invalid('Uzupełnij plan oraz podsumowanie dla pacjenta i zapisz szkic.');
        }
        const document = {
          id: randomUUID(), visitId: id, topic: visit.topic, doctor: visit.doctor, patient: visit.patient,
          approvedAt: now(), fields,
        };
        const content = JSON.stringify(document);
        db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?)').run(document.id, id, content, digest(content));
        db.prepare("UPDATE visits SET status = 'finalized' WHERE id = ?").run(id);
      }
      if (draft) {
        db.prepare('UPDATE visits SET draft_json = ?, version = version + 1 WHERE id = ?')
          .run(JSON.stringify(draft), id);
      }
    }
    audit(user, id, `visit.${action}`);
  });
  if (action === 'end') closeRoom(id);
  if (action === 'cancel-summary') summaryJobs.get(id)?.abort();
  const updated = findVisit(id, user);
  if (['end', 'summary'].includes(action) && updated.summary_ai_status === 'generating') {
    void runSummary(updated, user).catch(error => {
      console.error(JSON.stringify({ level: 'error', event: 'summary.write_failed', kind: error.name }));
    });
  }
  return json(res, 200, { ...visitView(updated), ...doctorDetails(updated), iceServers });
}

async function api(req, res, url) {
  const path = url.pathname.slice('/api/v1'.length);
  if (req.method !== 'GET' && req.headers.origin !== origin) throw forbidden();
  if (path === '/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    const username = string(body.username, 'login', 64).toLowerCase();
    const password = string(body.password, 'hasło', 128);
    const address = req.socket.remoteAddress;
    const current = Date.now();
    let attempts = loginAttempts.get(address);
    if (!attempts || current >= attempts.until) {
      attempts = { count: 0, until: current + 60_000 };
      loginAttempts.set(address, attempts);
    }
    if (attempts.count >= 8) throw new HttpError(429, 'rate_limited', 'Za dużo prób logowania. Odczekaj minutę.');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!checkPassword(password, user?.password_hash ?? dummyPassword) || !user) {
      attempts.count++;
      throw new HttpError(401, 'invalid_credentials', 'Błędny login lub hasło.');
    }
    audit(user, null, 'session.login');
    endSession(token(req));
    const key = randomBytes(32).toString('hex');
    sessions.set(key, { user: publicUser(user), expires: current + sessionMs });
    res.setHeader('Set-Cookie', `teleporada=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${cookieSecurity}`);
    return json(res, 201, publicUser(user));
  }

  const user = userFor(req);
  if (path === '/sessions/current' && req.method === 'DELETE') {
    audit(user, null, 'session.logout');
    endSession(token(req));
    res.setHeader('Set-Cookie', `teleporada=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecurity}`);
    return json(res, 200, { ok: true });
  }
  if (path === '/sessions/current' && req.method === 'GET') return json(res, 200, user);
  if (path === '/audit-events' && req.method === 'GET') {
    requireRole(user, 'admin');
    const offset = page(url);
    const items = db.prepare(`SELECT a.id, u.username AS actor, u.role, a.visit_id AS visitId,
      a.action, a.created_at AS createdAt FROM audit a JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 21 OFFSET ?`).all(offset);
    return json(res, 200, { items: items.slice(0, 20), nextOffset: items.length > 20 ? offset + 20 : null });
  }
  if (path === '/patients' && req.method === 'GET') {
    requireRole(user, 'doctor');
    return json(res, 200, { items: db.prepare("SELECT id, name FROM users WHERE role = 'patient' ORDER BY name").all() });
  }
  if (path === '/visits') {
    if (user.role === 'admin') throw forbidden();
    if (req.method === 'GET') {
      const offset = page(url);
      const column = user.role === 'doctor' ? 'doctor_id' : 'patient_id';
      const items = db.prepare(`${selectVisit} WHERE v.${column} = ? ORDER BY v.created_at DESC, v.id DESC LIMIT 21 OFFSET ?`)
        .all(user.id, offset);
      return json(res, 200, { items: items.slice(0, 20).map(visitView), nextOffset: items.length > 20 ? offset + 20 : null });
    }
    if (req.method === 'POST') {
      requireRole(user, 'doctor');
      const body = await readJson(req);
      userFor(req);
      const patientId = string(body.patientId, 'pacjent', 36);
      const topic = string(body.topic, 'temat', 120);
      if (!db.prepare("SELECT id FROM users WHERE id = ? AND role = 'patient'").get(patientId)) {
        throw invalid('Wybierz pacjenta z listy.');
      }
      const id = randomUUID();
      transaction(db, () => {
        db.prepare(`INSERT INTO visits(id, doctor_id, patient_id, topic, status, created_at)
          VALUES (?, ?, ?, ?, 'scheduled', ?)`).run(id, user.id, patientId, topic, now());
        audit(user, id, 'visit.create');
      });
      res.setHeader('Location', `/api/v1/visits/${id}`);
      return json(res, 201, visitView(findVisit(id, user)));
    }
  }
  const visitPath = /^\/visits\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/.exec(path);
  if (visitPath) return visitRoute(req, res, url, user, visitPath[1], visitPath[2]);
  throw notFound();
}

function endSession(key) {
  sessions.delete(key);
  if (!key) return;
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.token === key) {
        writeEvent(peer, 'session-ended', {});
        peer.res.end();
      }
    }
  }
}

setInterval(() => {
  const time = Date.now();
  for (const [key, session] of sessions) if (session.expires <= time) endSession(key);
  for (const [key, record] of loginAttempts) if (record.until <= time) loginAttempts.delete(key);
  for (const room of rooms.values()) for (const peer of room.peers.values()) writeEvent(peer, 'heartbeat', {});
}, 15_000).unref();

const assets = Object.fromEntries(Object.entries(staticFiles).map(([url, [file, mime]]) =>
  [url, { content: readFileSync(resolve(directory, 'public', file)), mime }]));

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/v1/')) return await api(req, res, url);
    if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      const { content, mime } = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(content);
    }
    throw notFound();
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(JSON.stringify({ level: 'error', event: 'request.failed', method: req.method, kind: error.name }));
    }
    if (!res.headersSent && !res.destroyed) {
      json(res, error.status || 500, { error: {
        code: error.code && error instanceof HttpError ? error.code : 'internal_error',
        message: error instanceof HttpError ? error.message : 'Nie udało się wykonać operacji.',
      } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}).listen(port, host, () => console.log(`Teleporada • ${origin} • dane demonstracyjne`));

function stop() {
  server.close(() => db.close());
  for (const controller of summaryJobs.values()) controller.abort();
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) peer.res.end();
  }
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
