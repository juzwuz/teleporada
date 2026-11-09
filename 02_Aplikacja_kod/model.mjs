import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const sections = Object.freeze({
  subjective: 'Wywiad',
  objective: 'Obserwacje',
  assessment: 'Ocena lekarza',
  plan: 'Plan',
  patientSummary: 'Podsumowanie dla pacjenta',
});
export const codes = Object.freeze({ Z09: 'Badanie kontrolne po leczeniu', Z71: 'Inne porady i konsultacje' });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}

export function checkPassword(password, saved) {
  const [salt, hash] = saved.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('doctor','patient','admin')), password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES users(id),
      patient_id TEXT NOT NULL REFERENCES users(id), topic TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled','in_progress','review','finalized')),
      created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      draft_json TEXT, version INTEGER NOT NULL DEFAULT 0,
      summary_ai_status TEXT NOT NULL DEFAULT 'not_requested'
    ) STRICT;
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(id),
      section TEXT NOT NULL CHECK (section IN ('subjective','objective','assessment','plan')),
      text TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('typed','dictated','demo')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL UNIQUE REFERENCES visits(id),
      content_json TEXT NOT NULL, sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
      visit_id TEXT REFERENCES visits(id), action TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_visits_doctor ON visits(doctor_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notes_visit ON notes(visit_id, id);
    CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT;
  `);
  if (!db.prepare('PRAGMA table_info(visits)').all().some(column => column.name === 'summary_ai_status')) {
    db.exec("ALTER TABLE visits ADD COLUMN summary_ai_status TEXT NOT NULL DEFAULT 'not_requested'");
  }
  if (!db.prepare('SELECT id FROM setup').get()) {
    transaction(db, () => {
      const addUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)');
      const doctor = randomUUID();
      const patient = randomUUID();
      addUser.run(doctor, 'lekarz', 'dr Lena Przykładowa', 'doctor', hashPassword('DemoLekarz!2026'));
      addUser.run(patient, 'pacjent', 'Ada Testowa', 'patient', hashPassword('DemoPacjent!2026'));
      addUser.run(randomUUID(), 'pacjent2', 'Maks Testowy', 'patient', hashPassword('DemoPacjent2!2026'));
      addUser.run(randomUUID(), 'audyt', 'Operator demonstracyjny', 'admin', hashPassword('DemoAudyt!2026'));
      db.prepare(`INSERT INTO visits(id, doctor_id, patient_id, topic, status, created_at)
        VALUES (?, ?, ?, ?, 'scheduled', ?)`).run(randomUUID(), doctor, patient, 'Wizyta kontrolna', now());
      db.exec('INSERT INTO setup VALUES (1)');
    });
  }
  return db;
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function generateDraft(visit, notes) {
  const draft = {};
  for (const section of Object.keys(sections).slice(0, 4)) {
    draft[section] = notes.filter(note => note.section === section).map(note => note.text).join('\n');
  }
  draft.patientSummary = [`Temat wizyty: ${visit.topic}.`, draft.plan && `Ustalenia z wizyty:\n${draft.plan}`]
    .filter(Boolean).join('\n\n');
  draft.code = '';
  return draft;
}

export function fhirBundle(visit, document) {
  const { id, approvedAt, doctor, patient, topic, fields } = document;
  const reference = id => ({ reference: `urn:uuid:${id}` });
  const text = [topic, ...Object.entries(sections).map(([key, label]) => `${label}\n${fields[key]}`),
    fields.code && `ICD-10: ${fields.code}`].filter(Boolean).join('\n\n');
  const resources = [
    { resourceType: 'Patient', id: visit.patient_id, name: [{ text: patient }] },
    { resourceType: 'Practitioner', id: visit.doctor_id, name: [{ text: doctor }] },
    {
      resourceType: 'Encounter', id: visit.id, status: 'completed', subject: reference(visit.patient_id),
      actualPeriod: { start: visit.started_at, end: visit.ended_at },
      participant: [{ actor: reference(visit.doctor_id) }],
    },
    {
      resourceType: 'DocumentReference', id, status: 'current', docStatus: 'final', date: approvedAt,
      subject: reference(visit.patient_id), context: [reference(visit.id)], author: [reference(visit.doctor_id)],
      content: [{ attachment: {
        contentType: 'text/plain; charset=utf-8', title: 'Protokół teleporady', data: Buffer.from(text).toString('base64'),
      } }],
    },
  ];
  return {
    resourceType: 'Bundle', type: 'collection', timestamp: approvedAt,
    entry: resources.map(resource => ({ fullUrl: reference(resource.id).reference, resource })),
  };
}
