import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDraft, fhirBundle, openDatabase, transaction } from '../model.mjs';

test('składanie szkicu zachowuje kolejność i nie przekazuje wywiadu do podsumowania', () => {
  const draft = generateDraft({ topic: 'Kontrola' }, [
    { section: 'subjective', text: 'Dane wywiadu' },
    { section: 'plan', text: 'Punkt pierwszy' },
    { section: 'plan', text: 'Punkt drugi' },
  ]);
  assert.equal(draft.plan, 'Punkt pierwszy\nPunkt drugi');
  assert.equal(draft.objective, '');
  assert.equal(draft.code, '');
  assert.match(draft.patientSummary, /Punkt pierwszy/);
  assert.doesNotMatch(draft.patientSummary, /Dane wywiadu/);
});

test('pakiet FHIR zawiera rozwiązywalne odwołania i treść UTF-8', () => {
  const visit = { id: 'visit', patient_id: 'patient', doctor_id: 'doctor', started_at: '2026-01-01T12:00:00Z', ended_at: '2026-01-01T12:05:00Z' };
  const fields = generateDraft({ topic: 'Wizyta' }, [{ section: 'plan', text: 'Żółć' }]);
  const bundle = fhirBundle(visit, {
    id: 'doc', approvedAt: '2026-01-01T12:06:00Z', doctor: 'Lekarz', patient: 'Pacjent', topic: 'Wizyta', fields,
  });
  const urls = new Set(bundle.entry.map(item => item.fullUrl));
  const document = bundle.entry[3].resource;
  assert.equal(bundle.type, 'collection');
  assert.equal(document.docStatus, 'final');
  for (const { reference } of [document.subject, ...document.author, ...document.context]) assert.ok(urls.has(reference));
  assert.match(Buffer.from(document.content[0].attachment.data, 'base64').toString('utf8'), /Żółć/);
});

test('nieudana transakcja nie utrwala częściowej zmiany', () => {
  const db = openDatabase(':memory:');
  try {
    const before = db.prepare('SELECT topic FROM visits').get().topic;
    assert.throws(() => transaction(db, () => {
      db.prepare("UPDATE visits SET topic = 'zmiana'").run();
      throw new Error('przerwanie');
    }), /przerwanie/);
    assert.equal(db.prepare('SELECT topic FROM visits').get().topic, before);
  } finally {
    db.close();
  }
});
