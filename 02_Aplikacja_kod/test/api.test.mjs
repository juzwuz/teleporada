import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('API sprawdza role, generuje szkic AI i udostępnia właściwy zakres dokumentu', { timeout: 15000 }, async t => {
  const modelCalls = [];
  let modelMode = 'ok';
  const model = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    modelCalls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    if (modelMode === 'pending') return;
    res.writeHead(modelMode === 'error' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ summary: 'Ustalono rozmowę kontrolną.' }) } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(resolve => {
    model.close(resolve);
    model.closeAllConnections();
  }));
  const dir = await mkdtemp(join(tmpdir(), 'teleporada-test-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env, DB_PATH: join(dir, 'test.sqlite'), PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: origin,
      ICE_SERVERS: '[]', AI_SUMMARY_MODEL: 'qwen3:1.7b', AI_SUMMARY_PORT: String(model.address().port),
    },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('Serwer nie wystartował.'); }),
  ]);

  async function request(path, { cookie, method = 'GET', data, source = origin, status = 200 } = {}) {
    const headers = { Origin: source };
    if (cookie) headers.Cookie = cookie;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/api/v1' + path, { method, headers, body: JSON.stringify(data) });
    assert.equal(response.status, status, `${method} ${path}`);
    return { value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  const post = (path, cookie, data = {}, status = 200) => request(path, { cookie, method: 'POST', data, status });
  async function login(username, password) {
    return (await post('/sessions', undefined, { username, password }, 201)).cookie;
  }
  async function completed(path, doctor) {
    for (let tries = 0; tries < 50; tries++) {
      const { value } = await request(path + '/summary', { cookie: doctor });
      if (value.summaryStatus !== 'generating') return (await request(path, { cookie: doctor })).value;
      await delay(20);
    }
    assert.fail('Generowanie nie zakończyło się.');
  }
  await request('/visits', { status: 401 });
  await request('/sessions', { method: 'POST', source: 'http://example.invalid', data: {}, status: 403 });
  await post('/sessions', undefined, { username: 'lekarz', password: 'złe hasło' }, 401);
  const doctor = await login('lekarz', 'DemoLekarz!2026');
  const patient = await login('pacjent', 'DemoPacjent!2026');
  const outsider = await login('pacjent2', 'DemoPacjent2!2026');
  const admin = await login('audyt', 'DemoAudyt!2026');
  const { value: people } = await request('/patients', { cookie: doctor });
  await post('/visits', doctor, { topic: 'x'.repeat(384 * 1024) }, 413);
  const { value: created } = await post('/visits', doctor, { patientId: people.items[0].id, topic: 'Kontrola testowa' }, 201);
  const path = '/visits/' + created.id;

  await request(path, { cookie: outsider, status: 404 });
  await request(path, { cookie: admin, status: 404 });
  await post(path + '/start', patient, {}, 403);
  await post(path + '/start', doctor);
  await post(path + '/start', doctor, {}, 409);
  await post(path + '/signal', outsider, {}, 404);
  await post(path + '/notes', doctor, { section: 'invalid', text: 'test', source: 'typed' }, 400);
  await post(path + '/notes', doctor, { section: 'subjective', text: 'Prywatna treść wywiadu', source: 'typed' });
  await post(path + '/notes', doctor, { section: 'plan', text: 'Ustalenia testowe', source: 'typed' });
  const { value: review } = await post(path + '/end', doctor);
  assert.equal(review.status, 'review');
  assert.equal(review.summaryStatus, 'generating');
  assert.match(review.draft.patientSummary, /Ustalenia testowe/);
  const { value: patientVisit } = await request(path, { cookie: patient });
  assert.ok(!('draft' in patientVisit) && !('notes' in patientVisit));
  await request(path + '/summary', { cookie: patient, status: 403 });
  await request(path + '/document', { cookie: patient, status: 404 });

  const generated = await completed(path, doctor);
  assert.equal(generated.summaryStatus, 'generated');
  assert.equal(generated.draft.patientSummary, 'Ustalono rozmowę kontrolną.');
  assert.equal(modelCalls[0].url, '/api/chat');
  assert.deepEqual(JSON.parse(modelCalls[0].body.messages[1].content), { plan: 'Ustalenia testowe' });
  assert.doesNotMatch(JSON.stringify(modelCalls[0]), /Prywatna treść|Ada Testowa/);
  const { value: saved } = await request(path + '/draft', {
    cookie: doctor, method: 'PUT', data: { ...generated.draft, version: generated.version, code: 'Z09' },
  });
  await post(path + '/finalize', doctor, { version: review.version }, 409);
  await post(path + '/finalize', doctor, { version: saved.version });
  await post(path + '/finalize', doctor, { version: saved.version }, 409);
  const { value: summary } = await request(path + '/document', { cookie: patient });
  assert.equal(summary.patientSummary, 'Ustalono rozmowę kontrolną.');
  assert.doesNotMatch(JSON.stringify(summary), /Prywatna treść/);
  await request(path + '/fhir', { cookie: patient, status: 403 });
  const { value: bundle } = await request(path + '/fhir', { cookie: doctor });
  assert.deepEqual(bundle.entry.map(entry => entry.resource.resourceType), ['Patient', 'Practitioner', 'Encounter', 'DocumentReference']);
  const { value: log } = await request('/audit-events', { cookie: admin });
  assert.ok(log.items.some(event => event.action === 'visit.finalize'));
  assert.doesNotMatch(JSON.stringify(log), /Prywatna treść/);
  await request('/audit-events', { cookie: patient, status: 403 });

  modelMode = 'pending';
  const { value: second } = await post('/visits', doctor, { patientId: people.items[0].id, topic: 'Próba przerwania AI' }, 201);
  const nextPath = '/visits/' + second.id;
  await post(nextPath + '/start', doctor);
  await post(nextPath + '/notes', doctor, { section: 'plan', text: 'Plan zapasowy', source: 'typed' });
  const pending = (await post(nextPath + '/end', doctor)).value;
  await post(nextPath + '/finalize', doctor, { version: pending.version }, 409);
  const cancelled = (await post(nextPath + '/cancel-summary', doctor, { version: pending.version })).value;
  assert.equal(cancelled.summaryStatus, 'cancelled');
  assert.match(cancelled.draft.patientSummary, /Plan zapasowy/);
  modelMode = 'error';
  await post(nextPath + '/summary', doctor, { version: cancelled.version });
  const fallback = await completed(nextPath, doctor);
  assert.equal(fallback.summaryStatus, 'failed');
  assert.match(fallback.draft.patientSummary, /Plan zapasowy/);

  await request('/sessions/current', { cookie: doctor, method: 'DELETE' });
  await request('/visits', { cookie: doctor, status: 401 });
});
