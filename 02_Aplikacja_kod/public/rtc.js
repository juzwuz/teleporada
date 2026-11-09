export function mediaRoom({ visit, role, api, status, local, remote, ended, expired }) {
  let stream;
  let peer;
  let events;
  let generation;
  let candidates = [];
  let audioEnabled = true;
  let videoEnabled = true;
  let closed = false;
  let mediaRequest;
  let requestVersion = 0;
  let signalQueue = Promise.resolve();
  const clientId = crypto.randomUUID();
  const path = `/visits/${visit.id}`;

  function disconnectPeer() {
    generation = undefined;
    candidates = [];
    if (peer) {
      peer.onconnectionstatechange = null;
      peer.close();
      peer = undefined;
    }
    remote.srcObject = null;
  }

  function leave() {
    requestVersion++;
    mediaRequest = undefined;
    events?.close();
    events = undefined;
    disconnectPeer();
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    local.srcObject = null;
    status('Rozłączono.');
  }

  async function preview() {
    if (stream) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error('Użyj aktualnej przeglądarki pod adresem localhost lub HTTPS.');
    }
    if (mediaRequest) return mediaRequest;
    const version = requestVersion;
    mediaRequest = requestMedia(version);
    try {
      await mediaRequest;
    } finally {
      if (requestVersion === version) mediaRequest = undefined;
    }
  }

  async function requestMedia(version) {
    let requested;
    try {
      requested = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (error) {
      if (error.name === 'NotAllowedError') throw new Error('Zezwól przeglądarce na użycie kamery i mikrofonu.');
      throw new Error('Sprawdź, czy kamera i mikrofon są dostępne.');
    }
    if (closed || requestVersion !== version) {
      requested.getTracks().forEach(track => track.stop());
      return;
    }
    stream = requested;
    for (const track of stream.getTracks()) track.enabled = track.kind === 'audio' ? audioEnabled : videoEnabled;
    local.srcObject = stream;
    status('Podgląd lokalny jest gotowy.');
  }

  async function send(expectedGeneration, type, payload) {
    if (generation !== expectedGeneration) return;
    try {
      await api(path + '/signal', 'POST', { clientId, generation: expectedGeneration, type, payload });
    } catch (error) {
      if (error.status !== 409 && generation === expectedGeneration) status(error.message);
    }
  }

  async function present({ ready, generation: next }) {
    if (!ready) {
      disconnectPeer();
      status('Oczekiwanie na drugą osobę…');
      return;
    }
    if (generation === next || !events || !stream) return;
    disconnectPeer();
    generation = next;
    const connection = new RTCPeerConnection({ iceServers: visit.iceServers });
    peer = connection;
    status('Nawiązywanie połączenia…');
    for (const track of stream.getTracks()) connection.addTrack(track, stream);
    connection.ontrack = event => {
      if (peer !== connection) return;
      remote.srcObject = event.streams[0];
      remote.play().catch(() => status('Włącz dźwięk rozmówcy przyciskiem pod obrazem.'));
    };
    connection.onicecandidate = event => {
      if (event.candidate) void send(next, 'candidate', event.candidate.toJSON());
    };
    connection.onconnectionstatechange = () => {
      const labels = {
        connected: 'Połączono przez WebRTC.',
        disconnected: 'Połączenie chwilowo przerwane.',
        failed: 'Nie udało się połączyć. Rozłącz się i dołącz ponownie.',
      };
      if (labels[connection.connectionState]) status(labels[connection.connectionState]);
    };
    if (role === 'doctor') {
      await connection.setLocalDescription(await connection.createOffer());
      await send(next, 'offer', connection.localDescription.toJSON());
    }
  }

  async function receive({ type, payload, generation: current }) {
    if (generation !== current || !peer) return;
    const connection = peer;
    if (type === 'candidate') {
      if (connection.remoteDescription) await connection.addIceCandidate(payload);
      else candidates.push(payload);
      return;
    }
    await connection.setRemoteDescription(payload);
    for (const candidate of candidates.splice(0)) await connection.addIceCandidate(candidate);
    if (type === 'offer') {
      await connection.setLocalDescription(await connection.createAnswer());
      await send(current, 'answer', connection.localDescription.toJSON());
    }
  }

  function enqueue(handler, event) {
    signalQueue = signalQueue.then(() => {
      if (event.target === events) return handler(JSON.parse(event.data));
    }).catch(() => {
      if (event.target === events) status('Nie udało się negocjować połączenia. Dołącz ponownie.');
    });
  }

  async function join() {
    if (events) return;
    const version = requestVersion;
    await preview();
    if (closed || !stream || events || requestVersion !== version) return;
    events = new EventSource(`/api/v1${path}/events?clientId=${clientId}`);
    status('Łączenie z pokojem…');
    events.addEventListener('presence', event => enqueue(present, event));
    events.addEventListener('signal', event => enqueue(receive, event));
    events.addEventListener('ended', ended);
    events.addEventListener('session-ended', expired);
    events.onerror = () => {
      disconnectPeer();
      status(events?.readyState === EventSource.CLOSED
        ? 'Pokój niedostępny. Sprawdź status wizyty i zamknij inne karty tego konta.'
        : 'Utracono sygnalizację. Trwa ponowne łączenie…');
      if (events?.readyState === EventSource.CLOSED) {
        events = undefined;
        void api(path).then(updated => {
          if (!closed && updated.status !== 'in_progress') ended();
        }).catch(error => {
          if (!closed && error.status === 401) expired();
        });
      }
    };
  }

  function toggle(kind) {
    const enabled = kind === 'audio' ? (audioEnabled = !audioEnabled) : (videoEnabled = !videoEnabled);
    stream?.getTracks().filter(track => track.kind === kind).forEach(track => { track.enabled = enabled; });
    return enabled;
  }

  return { preview, join, leave, toggle, destroy() { closed = true; leave(); } };
}
