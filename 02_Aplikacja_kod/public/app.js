import { mediaRoom } from './rtc.js';

const main = document.querySelector('#main');
const alertBox = document.querySelector('#alert');
const identity = document.querySelector('#identity');
const labels = {
  subjective: 'Wywiad', objective: 'Obserwacje', assessment: 'Ocena lekarza',
  plan: 'Plan', patientSummary: 'Podsumowanie dla pacjenta',
};
const statuses = { scheduled: 'Oczekuje', in_progress: 'W trakcie', review: 'Do weryfikacji', finalized: 'Zatwierdzona' };
const roles = { doctor: 'Lekarz', patient: 'Pacjent', admin: 'Audyt' };
const sources = { typed: 'Wpis ręczny', dictated: 'Dyktowanie', demo: 'Przykład' };
const summaryMessages = {
  not_requested: 'Możesz przygotować podsumowanie AI z zapisanego planu.',
  generating: 'AI przygotowuje podsumowanie z planu wizyty…',
  generated: 'Szkic przygotował model AI. Porównaj treść z planem przed zatwierdzeniem.',
  needs_plan: 'Dodaj i zapisz plan, aby model mógł przygotować podsumowanie.',
  too_long: 'Plan jest za długi dla modelu. Skróć go do 6500 znaków lub popraw podsumowanie ręcznie.',
  failed: 'Model lokalny nie zwrócił podsumowania. Możesz ponowić próbę lub poprawić szkic ręcznie.',
  cancelled: 'Przerwano generowanie. Możesz poprawić szkic ręcznie.',
  disabled: 'AI wyłączono w konfiguracji. Podsumowanie możesz poprawić ręcznie.',
};
const time = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
const visitLink = id => `#visit/${id}`;
const visitPath = id => `/visits/${id}`;
let user;
let renderId = 0;
let disposeRoom;
let summaryTimer;
let formChanged = false;

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatDate(value) {
  return value ? time.format(new Date(value)) : '—';
}

function notify(message = '') {
  alertBox.textContent = message;
  alertBox.hidden = !message;
  if (message) alertBox.scrollIntoView({ block: 'nearest' });
}

async function api(path, method = 'GET', data) {
  const response = await fetch('/api/v1' + path, {
    method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error?.message || 'Nie udało się wykonać operacji.');
    error.status = response.status;
    throw error;
  }
  return value;
}

function signedOut() {
  user = undefined;
  if (location.hash === '#home') void render();
  else location.hash = '#home';
}

function handleError(error) {
  if (error.status === 401 && user) signedOut();
  else notify(error.message || 'Sprawdź połączenie z serwerem.');
}

function bind(id, action, event = 'click') {
  const element = document.getElementById(id);
  if (!element) return;
  element.addEventListener(event, async e => {
    e.preventDefault();
    const button = event === 'submit' ? (e.submitter || element.querySelector('button[type="submit"]')) : element;
    if (button?.disabled) return;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    notify();
    try {
      await action(e);
    } catch (error) {
      handleError(error);
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  });
}

function intro(title, subtitle, back = false) {
  return `<div class="intro">
    ${back ? '<a class="back no-print" href="#home">← Lista wizyt</a>' : ''}
    <h1>${html(title)}</h1><p>${html(subtitle)}</p>
  </div>`;
}

function badge(status) {
  return `<span class="badge ${html(status)}">${html(statuses[status])}</span>`;
}

function renderIdentity() {
  identity.innerHTML = user ? `<div><strong>${html(user.name)}</strong><span class="identity-role">${roles[user.role]}</span></div>
    <button id="logout" class="secondary" type="button">Wyloguj</button>` : '';
  bind('logout', async () => {
    await api('/sessions/current', 'DELETE');
    signedOut();
  });
}

function renderLogin() {
  main.innerHTML = `<div class="split login">
    <section class="panel banner">
      <h1>Gabinet<br>wideo</h1>
      <p>Połącz się na teleporadę. Po wizycie wróć do ustaleń zatwierdzonych przez lekarza.</p>
      <ol class="visit-steps"><li>Rozmowa wideo</li><li>Weryfikacja protokołu</li><li>Podsumowanie</li></ol>
    </section>
    <section class="panel">
      <h2>Zaloguj się</h2>
      <form id="login-form" class="form">
        <label>Login<input name="username" autocomplete="username" maxlength="64" required></label>
        <label>Hasło<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
        <button type="submit">Przejdź do gabinetu</button>
      </form>
      <details><summary>Konta demonstracyjne</summary>
        <dl class="credentials">
          <dt>lekarz</dt><dd>DemoLekarz!2026</dd>
          <dt>pacjent</dt><dd>DemoPacjent!2026</dd>
          <dt>pacjent2</dt><dd>DemoPacjent2!2026</dd>
          <dt>audyt</dt><dd>DemoAudyt!2026</dd>
        </dl>
      </details>
    </section>
  </div>`;
  bind('login-form', async event => {
    user = await api('/sessions', 'POST', Object.fromEntries(new FormData(event.target)));
    if (location.hash === '#home') await render();
    else location.hash = '#home';
  }, 'submit');
}

function navigation(offset, nextOffset) {
  return `<div class="actions">
    ${offset ? '<button id="previous" class="secondary" type="button">Poprzednia strona</button>' : ''}
    ${nextOffset === null ? '' : '<button id="next" class="secondary" type="button">Następna strona</button>'}
  </div>`;
}

function bindNavigation(offset, nextOffset, renderer) {
  bind('previous', () => renderer(Math.max(0, offset - 20)));
  bind('next', () => renderer(nextOffset));
}

async function renderVisits(offset = 0) {
  const id = renderId;
  const doctor = user.role === 'doctor';
  const [page, patients] = await Promise.all([
    api(`/visits?offset=${offset}`), doctor ? api('/patients') : null,
  ]);
  if (id !== renderId) return;
  main.innerHTML = intro('Moje wizyty',
    doctor ? 'Rozpocznij rozmowę, zweryfikuj szkic lub wróć do protokołu.' : 'Otwórz swoją wizytę, aby dołączyć lub przeczytać podsumowanie.') +
    `<div class="${doctor ? 'split' : 'grid'}"><section class="panel grid">
      <div class="row"><h2>Lista wizyt</h2><button class="secondary" id="refresh" type="button">Odśwież</button></div>
      ${page.items.length ? `<ul class="list">${page.items.map(visit => `<li class="row">
        <div><h3>${html(visit.topic)}</h3><span class="quiet">${html(doctor ? visit.patient : visit.doctor)} · ${formatDate(visit.createdAt)}</span></div>
        <div class="actions">${badge(visit.status)}<a class="button secondary" href="${visitLink(visit.id)}">Otwórz</a></div>
      </li>`).join('')}</ul>` : '<p class="muted">Brak wizyt na tej stronie.</p>'}
      ${navigation(offset, page.nextOffset)}
    </section>
    ${doctor ? `<section class="panel"><h2>Nowa wizyta</h2><p class="quiet">Utwórz pozycję na liście wybranego pacjenta.</p>
      <form id="new-visit" class="form">
        <div><label for="visit-patient">Pacjent</label><select required id="visit-patient" name="patientId"><option value="">Wybierz pacjenta</option>
        ${patients.items.map(person => `<option value="${person.id}">${html(person.name)}</option>`).join('')}</select></div>
        <label>Temat<input required name="topic" maxlength="120" placeholder="Np. wizyta kontrolna"></label>
        <button type="submit">Utwórz wizytę</button>
      </form></section>` : ''}</div>`;
  bind('refresh', () => renderVisits(offset));
  bindNavigation(offset, page.nextOffset, renderVisits);
  bind('new-visit', async event => {
    const visit = await api('/visits', 'POST', Object.fromEntries(new FormData(event.target)));
    if (id === renderId) location.hash = visitLink(visit.id);
  }, 'submit');
}

function noteList(notes) {
  return notes.length ? notes.map(note => `<li><span class="badge">${labels[note.section]}</span>
    <span class="quiet">${sources[note.source]}</span><p>${html(note.text)}</p></li>`).reverse().join('')
    : '<li class="quiet">Brak notatek.</li>';
}

async function dictate(textarea) {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech || !('processLocally' in Speech.prototype) || !Speech.available) {
    throw new Error('Rozpoznawanie mowy na urządzeniu jest niedostępne. Wpisz notatkę ręcznie.');
  }
  const options = { langs: ['pl-PL'], processLocally: true };
  if (await Speech.available(options) !== 'available') {
    throw new Error('Brak lokalnego pakietu języka polskiego. Wpisz notatkę ręcznie.');
  }
  await new Promise((resolve, reject) => {
    const recognition = new Speech();
    recognition.lang = 'pl-PL';
    recognition.processLocally = true;
    recognition.onresult = event => {
      if (textarea.isConnected) {
        textarea.value = [textarea.value.trim(), event.results[0][0].transcript].filter(Boolean).join(' ').slice(0, 400);
        textarea.dataset.source = 'dictated';
      }
    };
    recognition.onerror = () => reject(new Error('Nie udało się rozpoznać mowy. Sprawdź mikrofon lub wpisz notatkę.'));
    recognition.onend = resolve;
    recognition.start();
  });
}

function renderRoom(visit, doctor) {
  const id = renderId;
  main.innerHTML += `<div class="${doctor ? 'split' : 'grid'}"><section class="panel">
    <div class="row"><h2>Pokój wideo</h2>${badge(visit.status)}</div>
    <p id="rtc-status" class="callout" role="status">Włącz podgląd lub dołącz do rozmowy.</p>
    <div class="video-grid">
      <div class="video"><video id="remote-video" autoplay playsinline aria-label="Obraz rozmówcy"></video><span>Rozmówca</span></div>
      <div class="video"><video id="local-video" autoplay muted playsinline aria-label="Twój podgląd"></video><span>Ty · podgląd lokalny</span></div>
    </div>
    <div class="actions">
      <button type="button" id="join">Dołącz do rozmowy</button>
      <button type="button" id="preview" class="secondary">Sprawdź kamerę</button>
      <button type="button" id="leave" class="secondary">Rozłącz</button>
    </div>
    <div class="actions">
      <button type="button" id="mic" class="secondary" aria-pressed="true">Mikrofon włączony</button>
      <button type="button" id="camera" class="secondary" aria-pressed="true">Kamera włączona</button>
      <button type="button" id="sound" class="secondary">Włącz dźwięk rozmówcy</button>
      ${doctor ? '<button type="button" id="end" class="danger">Zakończ wizytę</button>' : ''}
    </div>
  </section>
  ${doctor ? `<section class="panel grid"><div><h2>Notatki do protokołu</h2>
    <p class="quiet">Wybierz sekcję SOAP dla notatki. Po zakończeniu wizyty system złoży z nich szkic i podsumowanie.</p></div>
    <form id="note-form" class="form">
      <div><label for="note-section">Sekcja</label><select id="note-section" name="section">${Object.entries(labels).slice(0, 4).map(([key, label]) =>
        `<option value="${key}">${label}</option>`).join('')}</select></div>
      <label>Treść notatki<textarea id="note-text" name="text" maxlength="400" rows="3" required></textarea></label>
      <div class="actions"><button type="submit">Dodaj notatkę</button><button type="button" id="dictate" class="secondary">Dyktuj</button></div>
    </form>
    <button type="button" class="secondary" id="demo-notes">Dodaj przykładowe notatki</button>
    <p id="note-count" class="quiet" role="status">${visit.notes.length} / 40 notatek</p>
    <ul id="notes" class="list notes">${noteList(visit.notes)}</ul>
  </section>` : ''}</div>`;
  const local = document.querySelector('#local-video');
  const remote = document.querySelector('#remote-video');
  const status = document.querySelector('#rtc-status');
  const room = mediaRoom({
    visit, role: user.role, api, local, remote, status: text => { status.textContent = text; },
    ended: () => { if (id === renderId) void render(); }, expired: signedOut,
  });
  disposeRoom = room.destroy;
  bind('join', room.join);
  bind('preview', room.preview);
  bind('leave', room.leave);
  bind('sound', async () => {
    if (!remote.srcObject) throw new Error('Obraz rozmówcy pojawi się po nawiązaniu połączenia.');
    await remote.play();
  });
  for (const [button, kind, title] of [['mic', 'audio', 'Mikrofon'], ['camera', 'video', 'Kamera']]) {
    bind(button, event => {
      const enabled = room.toggle(kind);
      event.currentTarget.setAttribute('aria-pressed', enabled);
      event.currentTarget.textContent = title + (kind === 'audio' ? (enabled ? ' włączony' : ' wyłączony') : (enabled ? ' włączona' : ' wyłączona'));
    });
  }
  const path = visitPath(visit.id);
  const textarea = document.querySelector('#note-text');
  function updateNotes(next) {
    if (id !== renderId) return;
    document.querySelector('#notes').innerHTML = noteList(next.notes);
    document.querySelector('#note-count').textContent = `${next.notes.length} / 40 notatek`;
  }
  bind('dictate', () => dictate(textarea));
  bind('note-form', async event => {
    const data = Object.fromEntries(new FormData(event.target));
    data.source = textarea.dataset.source || 'typed';
    updateNotes(await api(path + '/notes', 'POST', data));
    textarea.value = '';
    delete textarea.dataset.source;
    if (textarea.isConnected) textarea.focus();
  }, 'submit');
  bind('demo-notes', async () => updateNotes(await api(path + '/demo-notes', 'POST', {})));
  bind('end', async () => {
    if (!confirm('Zakończyć rozmowę i przygotować szkic protokołu oraz podsumowanie?')) return;
    await api(path + '/end', 'POST', {});
    if (id === renderId) await render();
  });
}

function renderDraft(visit) {
  const id = renderId;
  const path = visitPath(visit.id);
  const generating = visit.summaryStatus === 'generating';
  main.innerHTML += `<div class="split"><section class="panel">
    <h2>Szkic protokołu SOAP</h2><p class="quiet">Sprawdź treść utworzoną z notatek. Plan i podsumowanie są wymagane do zatwierdzenia.</p>
    <form id="draft-form">
      <fieldset class="form draft-fields" ${generating ? 'disabled' : ''} aria-label="Pola protokołu">
      ${Object.entries(labels).map(([key, label]) => `<div><label for="draft-${key}">${label}</label>
        <textarea id="draft-${key}" name="${key}" rows="3" maxlength="18000">${html(visit.draft[key])}</textarea></div>`).join('')}
      <div><label for="draft-code">Kod ICD-10 (opcjonalny)</label><select id="draft-code" name="code"><option value="">Bez kodu</option>
        <option value="Z09" ${visit.draft.code === 'Z09' ? 'selected' : ''}>Z09 · Badanie kontrolne po leczeniu</option>
        <option value="Z71" ${visit.draft.code === 'Z71' ? 'selected' : ''}>Z71 · Inne porady i konsultacje</option>
      </select></div>
      <div class="actions">
        <button type="submit" value="save" class="secondary">Zapisz szkic</button>
        <button type="submit" value="approve">Zapisz i zatwierdź</button>
      </div>
      </fieldset>
    </form></section><aside class="grid">
      <section class="panel">
        <h2>Podsumowanie AI</h2>
        <p class="callout" id="summary-status" role="status">${summaryMessages[visit.summaryStatus]}</p>
        ${generating ? '<button id="cancel-summary" class="secondary" type="button">Przerwij generowanie</button>'
          : visit.summaryStatus === 'disabled' ? '' : '<button id="generate-summary" class="secondary" type="button">Wygeneruj z planu</button>'}
      </section>
      <section class="panel grid">
        <div><h2>Notatki źródłowe</h2><p class="quiet">Widoczne wyłącznie dla lekarza prowadzącego.</p></div>
        <ul class="list notes">${noteList(visit.notes)}</ul>
        <button id="regenerate" class="secondary" type="button" ${generating ? 'disabled' : ''}>Utwórz szkic ponownie</button>
      </section>
    </aside></div>`;
  const form = document.querySelector('#draft-form');
  form.addEventListener('input', () => { formChanged = true; });
  bind('draft-form', async event => {
    const approve = event.submitter?.value === 'approve';
    if (approve && !confirm('Zatwierdzić dokument i udostępnić podsumowanie pacjentowi?')) return;
    const data = Object.fromEntries(new FormData(form));
    const saved = await api(path + '/draft', 'PUT', { ...data, version: visit.version });
    if (id !== renderId) return;
    formChanged = false;
    visit.version = saved.version;
    if (approve) {
      await api(path + '/finalize', 'POST', { version: saved.version });
      if (id === renderId) await render();
    } else {
      const result = document.createElement('p');
      result.setAttribute('role', 'status');
      result.className = 'callout';
      result.textContent = 'Szkic zapisany.';
      form.querySelector('[role="status"]')?.remove();
      form.append(result);
    }
  }, 'submit');
  bind('regenerate', async () => {
    if (!confirm('Utworzyć szkic z notatek? Bieżące poprawki zostaną zastąpione.')) return;
    await api(path + '/regenerate', 'POST', { version: visit.version });
    if (id === renderId) await render();
  });
  bind('generate-summary', async () => {
    if (formChanged) throw new Error('Zapisz zmiany w szkicu przed generowaniem z planu.');
    if (!confirm('Wygenerować podsumowanie z zapisanego planu? Wynik zastąpi obecną treść podsumowania.')) return;
    await api(path + '/summary', 'POST', { version: visit.version });
    if (id === renderId) await render();
  });
  bind('cancel-summary', async () => {
    await api(path + '/cancel-summary', 'POST', { version: visit.version });
    if (id === renderId) await render();
  });
  if (generating) {
    const poll = async () => {
      try {
        const state = await api(path + '/summary');
        if (id !== renderId) return;
        if (state.summaryStatus !== 'generating') {
          await render();
          return;
        }
      } catch (error) {
        if (id !== renderId) return;
        if (error.status === 401) return signedOut();
        document.querySelector('#summary-status').textContent = 'Sprawdzam ponownie status generowania…';
      }
      summaryTimer = setTimeout(poll, 1000);
    };
    summaryTimer = setTimeout(poll, 1000);
  }
}

function renderDocument(visit, document, doctor) {
  const summary = doctor ? document.fields.patientSummary : document.patientSummary;
  main.innerHTML += `<div class="grid">
    <section class="panel"><div class="row"><h2>Podsumowanie dla pacjenta</h2>${badge(visit.status)}</div>
    <p class="quiet">${html(document.doctor)} · zatwierdzono ${formatDate(document.approvedAt)}</p>
    <p class="report-copy">${html(summary)}</p>
    <div class="actions no-print"><button id="print" type="button">Drukuj / zapisz jako PDF</button>
      ${doctor ? `<a class="button secondary" href="/api/v1${visitPath(visit.id)}/fhir">Pobierz FHIR JSON</a>` : ''}
    </div></section>
    ${doctor ? `<section class="panel no-print">
      <h2>Protokół wizyty</h2><div class="grid-two">${Object.entries(labels).slice(0, 4).map(([key, label]) =>
        `<div><h3>${label}</h3><p class="section-note">${html(document.fields[key] || '—')}</p></div>`).join('')}</div>
      <p>Kod ICD-10: ${html(document.fields.code || '—')}</p>
      <p class="quiet hash">SHA-256 · <code>${html(document.sha256)}</code></p>
    </section>` : ''}</div>`;
  documentPrint();
}

function documentPrint() {
  document.body.classList.add('print-report');
  bind('print', () => window.print());
}

async function renderVisit(id) {
  const view = renderId;
  const doctor = user.role === 'doctor';
  const path = visitPath(id);
  const visit = await api(path);
  const document = visit.status === 'finalized' ? await api(path + '/document') : null;
  if (view !== renderId) return;
  main.innerHTML = intro(visit.topic, `${visit.patient} · ${visit.doctor}`, true);
  if (visit.status === 'in_progress') return renderRoom(visit, doctor);
  if (visit.status === 'review' && doctor) return renderDraft(visit);
  if (document) return renderDocument(visit, document, doctor);
  const waiting = visit.status === 'scheduled';
  main.innerHTML += `<section class="panel"><div class="row"><h2>${waiting ? 'Przed rozmową' : 'Po rozmowie'}</h2>${badge(visit.status)}</div>
    <p>${waiting ? (doctor ? 'Otwarcie wizyty udostępni pokój przypisanemu pacjentowi.' : 'Lekarz otworzy pokój. Odśwież widok, gdy będzie gotowy.')
    : 'Lekarz sprawdza protokół. Podsumowanie pojawi się po zatwierdzeniu.'}</p>
    <button type="button" id="${doctor ? 'start' : 'refresh-visit'}">${doctor ? 'Otwórz pokój wideo' : 'Odśwież status'}</button>
  </section>`;
  bind('start', async () => {
    await api(path + '/start', 'POST', {});
    if (view === renderId) await render();
  });
  bind('refresh-visit', render);
}

async function renderAudit(offset = 0) {
  const id = renderId;
  const page = await api(`/audit-events?offset=${offset}`);
  if (id !== renderId) return;
  main.innerHTML = intro('Rejestr zdarzeń', 'Sprawdź, kto otworzył, zatwierdził lub odczytał wizytę.') +
    `<section class="panel grid"><div class="row"><h2>Ostatnie operacje</h2>
    <button class="secondary" id="refresh" type="button">Odśwież</button></div>
    <div class="table-wrap"><table aria-label="Zdarzenia audytu"><thead><tr>
      <th scope="col">Czas lokalny</th><th scope="col">Konto</th><th scope="col">Rola</th><th scope="col">Operacja</th><th scope="col">Wizyta</th>
    </tr></thead><tbody>
    ${page.items.map(row => `<tr><td>${formatDate(row.createdAt)}</td><td>${html(row.actor)}</td><td>${roles[row.role]}</td>
    <td><code>${html(row.action)}</code></td><td>${html(row.visitId || '—')}</td></tr>`).join('')}
    </tbody></table></div>${navigation(offset, page.nextOffset)}</section>`;
  bind('refresh', () => renderAudit(offset));
  bindNavigation(offset, page.nextOffset, renderAudit);
}

async function render() {
  const id = ++renderId;
  clearTimeout(summaryTimer);
  formChanged = false;
  disposeRoom?.();
  disposeRoom = undefined;
  document.body.classList.remove('print-report');
  notify();
  renderIdentity();
  main.innerHTML = '<p role="status" class="muted">Wczytywanie…</p>';
  try {
    const match = /^#visit\/([a-f0-9-]{36})$/.exec(location.hash);
    if (!user) renderLogin();
    else if (user.role === 'admin') await renderAudit();
    else if (match) await renderVisit(match[1]);
    else await renderVisits();
  } catch (error) {
    if (id !== renderId) return;
    main.innerHTML = user ? '<a class="back" href="#home">← Lista wizyt</a>' : '';
    handleError(error);
  }
  if (id === renderId && id > 1) main.focus({ preventScroll: true });
}

document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  main.focus();
});
document.addEventListener('click', event => {
  if (formChanged && event.target.closest('a[href="#home"]') && !confirm('Opuścić edytor bez zapisywania zmian?')) {
    event.preventDefault();
  }
});
window.addEventListener('beforeunload', event => {
  if (formChanged) event.preventDefault();
});
window.addEventListener('hashchange', () => void render());
try {
  user = await api('/sessions/current');
} catch (error) {
  if (error.status !== 401) console.error(error);
}
await render();
