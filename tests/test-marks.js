const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '56980';
const OUT = process.argv[3] || '/workspace/br-marks-shots';
const BASE = `http://127.0.0.1:${PORT}/`;

fs.mkdirSync(OUT, { recursive: true });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitJson(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + url);
}

function startChrome(dbgPort, width, height, ua) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${dbgPort}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    'about:blank'
  ];
  if (ua) args.splice(-1, 0, `--user-agent=${ua}`);
  return spawn('google-chrome', args, { stdio: 'ignore' });
}

async function attach(dbgPort) {
  const tabs = await waitJson(`http://127.0.0.1:${dbgPort}/json`);
  const page = tabs.find(t => t.type === 'page') || tabs[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = {};
  const errs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') {
      const t = (d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description)
        || d.params.exceptionDetails.text || 'exception';
      errs.push('EXC ' + String(t).split('\n')[0]);
    }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      errs.push('CONSOLE ' + d.params.args.map(a => a.value || a.description || '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pend[i] = res;
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error('CDP timeout ' + method)); } }, 90000);
  });
  return { ws, send, errs };
}

async function ev(session, expression, awaitPromise = true) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || 'eval error');
  }
  return r.result.result.value;
}

async function screenshot(session, file) {
  const s = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
}

async function setupPage(session, width, height) {
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 600
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.alert = m => { (window.__alerts = window.__alerts || []).push(String(m)); };
      window.__geo = { mode: 'ok', lat: 46.94806, lon: 17.89710, accuracy: 12 };
      const geo = {
        getCurrentPosition(ok, err) {
          const g = window.__geo;
          setTimeout(() => {
            if (g.mode === 'denied') err({ code: 1, PERMISSION_DENIED: 1, message: 'User denied Geolocation' });
            else if (g.mode === 'unavailable') err({ code: 2, POSITION_UNAVAILABLE: 2, message: 'unavailable' });
            else if (g.mode === 'timeout') err({ code: 3, TIMEOUT: 3, message: 'timeout' });
            else ok({
              coords: { latitude: g.lat, longitude: g.lon, accuracy: g.accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
              timestamp: Date.now()
            });
          }, 20);
        }
      };
      try {
        Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geo });
      } catch (e) { navigator.geolocation.getCurrentPosition = geo.getCurrentPosition; }
    `
  });
}

async function goto(session, url) {
  await session.send('Page.navigate', { url });
  await sleep(400);
  await waitMarks(session);
}

async function waitMarks(session) {
  const ready = await ev(session, `(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (document.readyState === 'complete' && window.BalatonMarks && BalatonMarks.isReady()) return true;
      await new Promise(r => setTimeout(r, 80));
    }
    return {
      href: location.href,
      readyState: document.readyState,
      has: !!window.BalatonMarks,
      isReady: !!(window.BalatonMarks && BalatonMarks.isReady()),
      err: window.__marksInstallError || null
    };
  })()`);
  if (ready !== true) throw new Error('BalatonMarks not ready: ' + JSON.stringify(ready));
  return true;
}

const optionExpr = `(sel) => Array.from(document.getElementById(sel).options).map(o => o.value)`;

(async () => {
  const report = { tests: [] };
  const fail = (name, msg) => { report.tests.push({ name, ok: false, msg }); console.log('FAIL', name, msg); };
  const ok = (name, extra) => { report.tests.push({ name, ok: true, ...(extra ? { extra } : {}) }); console.log('OK  ', name); };

  const dport = 9331;
  const dch = startChrome(dport, 1200, 1600);
  const desk = await attach(dport);
  await setupPage(desk, 1200, 900);

  await goto(desk, BASE);
  const boot = await ev(desk, `({
    ready: BalatonMarks.isReady(),
    race: BalatonMarks.currentRaceId(),
    raceOptions: Array.from(document.getElementById('raceSelect').options).map(o => ({ id: o.value, label: o.textContent })),
    start: Array.from(document.getElementById('startSelect').options).map(o => o.value),
    target: Array.from(document.getElementById('targetSelect').options).map(o => o.value),
    geoBtn: document.getElementById('geoBtn') && document.getElementById('geoBtn').textContent.trim(),
    howto: !!document.querySelector('a[href="howto.html"]'),
    marks: document.querySelectorAll('.race-mark-dot').length
  })`);
  report.boot = boot;
  if (boot.ready && boot.race === 'byc-szolo' && boot.geoBtn === 'Jelenlegi pozíció' && boot.howto) ok('boot: default race, geo label, howto link');
  else fail('boot: default race, geo label, howto link', JSON.stringify(boot));

  const ids = (boot.raceOptions || []).map(o => o.id);
  const labels = (boot.raceOptions || []).map(o => o.label);
  const expectedIds = ['byc-szolo','kekszalag-2026','feher-szalag-2026','flexfleet-2026','ezustszalag-2025'];
  if (expectedIds.every(id => ids.includes(id))
      && labels.includes('BYC Szóló (jelenlegi pontok)')
      && labels.includes('Kékszalag 2026')
      && labels.includes('Fehér Szalag 2026')
      && labels.includes('Flexfleet Klasszikus Szóló 2026')
      && labels.includes('Ezüstszalag 2025 (2025-ös adat, ellenőrizendő)'))
    ok('race selector labels and ids');
  else fail('race selector labels and ids', JSON.stringify({ ids, labels, expectedIds }));

  const bycLists = (boot.start.includes('szolo_rajt') && boot.start.includes('fured')
    && boot.target.includes('szolo_aliga') && !boot.start.includes('kekszalag_1'));
  if (bycLists) ok('BYC lists keep existing presets only');
  else fail('BYC lists keep existing presets only', JSON.stringify({ start: boot.start, target: boot.target }));

  await ev(desk, `window.scrollTo(0,0)`);
  await sleep(200);
  await screenshot(desk, path.join(OUT, 'desktop-byc.png'));

  // Race switch: Kékszalag
  const ksz = await ev(desk, `(() => {
    BalatonMarks.selectRace('kekszalag-2026');
    const start = Array.from(document.getElementById('startSelect').options).map(o => o.value);
    const target = Array.from(document.getElementById('targetSelect').options).map(o => o.value);
    const meta = document.getElementById('raceMeta').innerHTML;
    const notes = (document.getElementById('raceNotes') || {}).innerText || '';
    const dots = Array.from(document.querySelectorAll('.leaflet-marker-icon.race-mark-icon'));
    return {
      race: BalatonMarks.currentRaceId(),
      start, target,
      meta, notes,
      sourceHref: (document.querySelector('#raceMeta a') || {}).href || '',
      year: /2026/.test(meta),
      nMarks: dots.length,
      invented: ['kekszalag_1a','1a','kekszalag_2p','2p','kekszalag_3a','3a'].filter(id => start.includes(id) || target.includes(id)),
      hasOfficial: ['kekszalag_rajt_cel','kekszalag_1','kekszalag_2s','kekszalag_3'].every(id => start.includes(id) && target.includes(id)),
      noByc: !start.includes('szolo_rajt') && !target.includes('szolo_aliga') && !start.includes('fured'),
      noUnpublished: !/nincs közölt GPS/i.test(notes) && !document.getElementById('raceNotes')
    };
  })()`);
  report.kekszalag = ksz;
  const kszFail = [];
  if (ksz.race !== 'kekszalag-2026') kszFail.push('race');
  if (!ksz.hasOfficial) kszFail.push('official marks missing');
  if (ksz.invented.length) kszFail.push('invented ' + ksz.invented.join(','));
  if (!ksz.noByc) kszFail.push('BYC still listed');
  if (!ksz.noUnpublished) kszFail.push('unpublished notes still shown');
  if (!ksz.year || !/mvszhirdetotabla.hu/.test(ksz.sourceHref)) kszFail.push('source/year');
  if (ksz.nMarks < 4) kszFail.push('map marks ' + ksz.nMarks);
  if (kszFail.length === 0) ok('Kékszalag 2026 switch, official marks only, source');
  else fail('Kékszalag 2026 switch, official marks only, source', kszFail.join('; ') + ' ' + JSON.stringify(ksz));

  await ev(desk, `document.getElementById('pointsCard').scrollIntoView({block:'start'})`);
  await sleep(250);
  await screenshot(desk, path.join(OUT, 'desktop-kekszalag.png'));

  // Other races quickly
  const others = await ev(desk, `(() => {
    function inspect(id) {
      BalatonMarks.selectRace(id);
      const start = Array.from(document.getElementById('startSelect').options).map(o => o.value).filter(Boolean);
      const notes = (document.getElementById('raceNotes') || {}).innerText || '';
      const meta = document.getElementById('raceMeta').innerText;
      return { id, start, notes, meta, href: (document.querySelector('#raceMeta a') || {}).href || '' };
    }
    return {
      feher: inspect('feher-szalag-2026'),
      flex: inspect('flexfleet-2026'),
      ezust: inspect('ezustszalag-2025')
    };
  })()`);
  report.others = others;
  const oFail = [];
  if (!others.feher.start.includes('feher_3') || others.feher.start.includes('kekszalag_3')) oFail.push('feher marks');
  if (!/mvszhirdetotabla.hu/.test(others.feher.href || '')) oFail.push('feher source');
  if (!others.flex.start.includes('flex_kapu_rev') || !others.flex.start.includes('flex_1') || !others.flex.start.includes('flex_3')) oFail.push('flex marks');
  if (others.flex.start.includes('flex_kapu_kardinalis') || others.flex.start.includes('flex_rajt')) oFail.push('flex extra marks');
  if (/nincs közölt GPS/i.test(others.flex.notes || '')) oFail.push('flex unpublished notes');
  if (others.ezust.start.filter(v => v && v !== 'manual').length !== 1 || !others.ezust.start.includes('ezust_gyorok')) oFail.push('ezust only gyorok');
  if (!/2025/.test(others.ezust.meta) || !/egyeztetni/.test(others.ezust.meta)) oFail.push('ezust year note');
  if (/nincs közölt GPS/i.test(others.ezust.notes || '')) oFail.push('ezust unpublished notes');
  if (oFail.length === 0) ok('Fehér, Flexfleet, Ezüst official marks only');
  else fail('Fehér, Flexfleet, Ezüst official marks only', oFail.join('; ') + ' ' + JSON.stringify(others));

  // Flexfleet: official published marks only, no north cardinal, share keys work
  const flex = await ev(desk, `(() => {
    BalatonMarks.selectRace('flexfleet-2026');
    const ids = Array.from(document.getElementById('startSelect').options).map(o => o.value).filter(Boolean);
    BalatonMarks.setStartFromKey('flex_1');
    BalatonMarks.setTargetFromKey('flex_3');
    const q = buildShareQuery({ fromKey: 'flex_1', toKey: 'flex_3', models: ['icon_d2'], mix: 2, nc: false, tms: Date.parse('2026-12-06T08:00:00Z') });
    const params = Object.fromEntries(new URLSearchParams(q));
    return {
      ids,
      hasCardinal: !!BalatonMarks.markById('flex_kapu_kardinalis') || ids.includes('flex_kapu_kardinalis'),
      nMarks: document.querySelectorAll('.race-mark-dot').length,
      share: params,
      currentPos,
      target: getTarget()
    };
  })()`);
  report.flex = flex;
  const fFail = [];
  if (flex.hasCardinal) fFail.push('cardinal still present');
  if (!flex.ids.includes('flex_kapu_rev') || flex.nMarks !== 3) fFail.push('flex marks ' + JSON.stringify({ids: flex.ids, n: flex.nMarks}));
  if (flex.share.from !== 'flex_1' || flex.share.to !== 'flex_3' || flex.share.race !== 'flexfleet-2026') fFail.push('share ' + JSON.stringify(flex.share));
  if (fFail.length === 0) ok('Flexfleet official marks only, share keys');
  else fail('Flexfleet official marks only, share keys', fFail.join('; ') + ' ' + JSON.stringify(flex));

  await ev(desk, `document.getElementById('pointsCard').scrollIntoView({block:'start'})`);
  await sleep(250);
  await screenshot(desk, path.join(OUT, 'desktop-flexfleet.png'));

  // Geolocation mocked
  const geoOk = await ev(desk, `(async () => {
    window.__alerts = [];
    window.__geo = { mode: 'ok', lat: 46.94806, lon: 17.89710, accuracy: 12 };
    document.getElementById('geoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      pos: currentPos,
      status: document.getElementById('locStatus').textContent,
      alerts: window.__alerts.slice()
    };
  })()`);
  if (geoOk.pos && Math.abs(geoOk.pos.lat - 46.94806) < 1e-4 && Math.abs(geoOk.pos.lon - 17.89710) < 1e-4
      && /Jelenlegi pozíció/.test(geoOk.status))
    ok('geolocation success on water', geoOk);
  else fail('geolocation success on water', JSON.stringify(geoOk));

  const geoDenied = await ev(desk, `(async () => {
    window.__alerts = [];
    window.__geo = { mode: 'denied', lat: 0, lon: 0, accuracy: 10 };
    const prev = currentPos && { lat: currentPos.lat, lon: currentPos.lon };
    document.getElementById('geoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      status: document.getElementById('locStatus').textContent,
      alerts: window.__alerts.slice(),
      pos: currentPos,
      prev
    };
  })()`);
  if (/elutasította|engedély/i.test(geoDenied.status) && geoDenied.alerts.length
      && geoDenied.pos && geoDenied.prev && Math.abs(geoDenied.pos.lat - geoDenied.prev.lat) < 1e-8)
    ok('geolocation denied keeps previous start', geoDenied);
  else fail('geolocation denied keeps previous start', JSON.stringify(geoDenied));

  const geoOut = await ev(desk, `(async () => {
    window.__alerts = [];
    window.__geo = { mode: 'ok', lat: 47.4979, lon: 19.0402, accuracy: 15 };
    const prev = currentPos && { lat: currentPos.lat, lon: currentPos.lon };
    document.getElementById('geoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      status: document.getElementById('locStatus').textContent,
      alerts: window.__alerts.slice(),
      pos: currentPos,
      same: currentPos && prev && Math.abs(currentPos.lat - prev.lat) < 1e-8
    };
  })()`);
  if (/nem a Balaton/i.test(geoOut.status) && geoOut.same) ok('geolocation out-of-lake refused', geoOut);
  else fail('geolocation out-of-lake refused', JSON.stringify(geoOut));

  const geoSoft = await ev(desk, `(async () => {
    window.__alerts = [];
    window.__geo = { mode: 'ok', lat: 46.94806, lon: 17.89710, accuracy: 250 };
    document.getElementById('geoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    return { status: document.getElementById('locStatus').textContent, pos: currentPos };
  })()`);
  if (geoSoft.pos && /pontosság|±\\s*250/i.test(geoSoft.status) && Math.abs(geoSoft.pos.lat - 46.94806) < 1e-4)
    ok('geolocation inaccurate-but-usable warning', geoSoft);
  else fail('geolocation inaccurate-but-usable warning', JSON.stringify(geoSoft));

  const geoHard = await ev(desk, `(async () => {
    window.__alerts = [];
    window.__geo = { mode: 'ok', lat: 46.94806, lon: 17.89710, accuracy: 2000 };
    const prev = { lat: currentPos.lat, lon: currentPos.lon };
    document.getElementById('geoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      status: document.getElementById('locStatus').textContent,
      alerts: window.__alerts.slice(),
      same: Math.abs(currentPos.lat - prev.lat) < 1e-8
    };
  })()`);
  if (/túl pontatlan/i.test(geoHard.status) && geoHard.same) ok('geolocation too inaccurate refused', geoHard);
  else fail('geolocation too inaccurate refused', JSON.stringify(geoHard));

  // Map tap popup
  const tap = await ev(desk, `(async () => {
    BalatonMarks.selectRace('byc-szolo');
    const ll = L.latLng(46.91000, 17.89000);
    map.fire('click', { latlng: ll });
    await new Promise(r => setTimeout(r, 80));
    const pop = document.querySelector('.map-pick-popup');
    const hasStart = !!document.getElementById('pickAsStart');
    const hasGoal = !!document.getElementById('pickAsGoal');
    document.getElementById('pickAsStart').click();
    await new Promise(r => setTimeout(r, 40));
    const start = currentPos && { lat: currentPos.lat, lon: currentPos.lon, name: currentPos.name, sel: document.getElementById('startSelect').value };
    map.fire('click', { latlng: L.latLng(46.75654, 17.26233) });
    await new Promise(r => setTimeout(r, 80));
    document.getElementById('pickAsGoal').click();
    await new Promise(r => setTimeout(r, 40));
    const t = getTarget();
    const q = buildShareQuery({ models: ['icon_d2'], mix: 2, nc: false, tms: Date.parse('2026-12-06T08:00:00Z') });
    const params = Object.fromEntries(new URLSearchParams(q));
    return { hasPop: !!pop, hasStart, hasGoal, start, target: t, share: params, manualLat: document.getElementById('manualLat').value, selTarget: document.getElementById('targetSelect').value };
  })()`);
  report.tap = tap;
  const tFail = [];
  if (!tap.hasPop || !tap.hasStart || !tap.hasGoal) tFail.push('popup');
  if (!tap.start || Math.abs(tap.start.lat - 46.91) > 1e-4 || tap.start.sel !== '') tFail.push('start');
  if (!tap.target || Math.abs(tap.target.lat - 46.75654) > 1e-4 || tap.selTarget !== 'manual') tFail.push('goal');
  if (!tap.share.from || !tap.share.from.startsWith('46.91000,17.89000')) tFail.push('share from ' + tap.share.from);
  if (!tap.share.to || !tap.share.to.startsWith('46.75654,17.26233')) tFail.push('share to ' + tap.share.to);
  if (tFail.length === 0) ok('map tap popup sets start/goal and share lat,lon', tap);
  else fail('map tap popup sets start/goal and share lat,lon', tFail.join('; ') + ' ' + JSON.stringify(tap));

  // Re-open popup for screenshot
  await ev(desk, `(() => {
    map.setView([46.91, 17.89], 11);
    map.fire('click', { latlng: L.latLng(46.91000, 17.89000) });
    const m = document.getElementById('map');
    if (m) m.scrollIntoView({block:'center'});
  })()`);
  await sleep(300);
  await screenshot(desk, path.join(OUT, 'desktop-map-pick.png'));

  // Saved points
  const saved = await ev(desk, `(() => {
    localStorage.removeItem(BalatonMarks.STORAGE_KEY);
    // reset in-memory by deleting existing
    BalatonMarks.savedPoints().forEach(p => BalatonMarks.deletePoint(p.id));
    document.getElementById('savePointName').value = 'Kikötő teszt';
    BalatonMarks.setStartFromLatLon(46.93878, 17.91093, 'Térkép');
    document.getElementById('savePointBtn').click();
    const list = BalatonMarks.savedPoints();
    const ui = document.getElementById('savedPointsList').innerText;
    const startOpts = Array.from(document.getElementById('startSelect').options).map(o => ({ v: o.value, t: o.text, group: o.parentElement.label || '' }));
    const stored = JSON.parse(localStorage.getItem(BalatonMarks.STORAGE_KEY) || '[]');
    return { list, ui, startOpts, stored };
  })()`);
  report.saved = saved;
  const svFail = [];
  if (!saved.list || saved.list.length !== 1 || saved.list[0].name !== 'Kikötő teszt') svFail.push('list');
  if (!/Kikötő teszt/.test(saved.ui)) svFail.push('ui');
  if (!saved.startOpts.some(o => o.group === 'Saját pontok' && o.t === 'Kikötő teszt')) svFail.push('optgroup');
  if (!saved.stored || saved.stored.length !== 1) svFail.push('localStorage');
  if (svFail.length === 0) ok('save named point to Saját pontok / localStorage', { id: saved.list[0].id });
  else fail('save named point to Saját pontok / localStorage', svFail.join('; ') + ' ' + JSON.stringify(saved));

  const deleted = await ev(desk, `(() => {
    const id = BalatonMarks.savedPoints()[0].id;
    const btn = Array.from(document.querySelectorAll('#savedPointsList button')).find(b => b.textContent === 'Törlés');
    btn.click();
    return {
      left: BalatonMarks.savedPoints().length,
      stored: JSON.parse(localStorage.getItem(BalatonMarks.STORAGE_KEY) || '[]').length,
      ui: document.getElementById('savedPointsList').innerText,
      stillInSelect: Array.from(document.getElementById('startSelect').options).some(o => o.value === id)
    };
  })()`);
  if (deleted.left === 0 && deleted.stored === 0 && /Még nincs mentett pont/.test(deleted.ui) && !deleted.stillInSelect)
    ok('delete saved point');
  else fail('delete saved point', JSON.stringify(deleted));

  // restore one for screenshot
  await ev(desk, `(() => {
    document.getElementById('savePointName').value = 'Kikötő teszt';
    BalatonMarks.setStartFromLatLon(46.93878, 17.91093, 'Térkép');
    document.getElementById('savePointBtn').click();
    document.getElementById('savedPointsBox').scrollIntoView({block:'center'});
  })()`);
  await sleep(250);
  await screenshot(desk, path.join(OUT, 'desktop-saved-points.png'));

  // Waypoint-save UX
  const ux = await ev(desk, `(() => {
    const btn = document.getElementById('savePointBtn');
    const hint = document.getElementById('savePointHint');
    const label = document.querySelector('label[for="savePointName"]');
    return {
      btn: btn && btn.textContent.trim(),
      hint: hint && hint.textContent,
      nameLabel: label && label.textContent.trim(),
      primary: !!(btn && btn.classList.contains('btn-primary'))
    };
  })()`);
  report.waypointUx = ux;
  if (ux.btn === 'Pont mentése' && ux.primary && /Mentés pontként/i.test(ux.hint) && ux.nameLabel === 'Pont neve')
    ok('save form uses Pont mentése button, name field and hint', ux);
  else fail('save form uses Pont mentése button, name field and hint', JSON.stringify(ux));

  const mapSaveEmpty = await ev(desk, `(async () => {
    BalatonMarks.savedPoints().forEach(p => BalatonMarks.deletePoint(p.id));
    window.__alerts = [];
    map.fire('click', { latlng: L.latLng(46.91000, 17.89000) });
    await new Promise(r => setTimeout(r, 80));
    const hasSave = !!document.getElementById('pickAsSaved');
    const hasName = !!document.getElementById('pickSaveName');
    const saveLabel = document.getElementById('pickAsSaved') && document.getElementById('pickAsSaved').textContent.trim();
    document.getElementById('pickSaveName').value = '';
    document.getElementById('pickAsSaved').click();
    await new Promise(r => setTimeout(r, 40));
    return {
      hasSave, hasName, saveLabel,
      left: BalatonMarks.savedPoints().length,
      alerts: window.__alerts.slice(),
      popupStill: !!document.querySelector('.map-pick-popup')
    };
  })()`);
  report.mapSaveEmpty = mapSaveEmpty;
  if (mapSaveEmpty.hasSave && mapSaveEmpty.hasName && mapSaveEmpty.saveLabel === 'Mentés pontként'
      && mapSaveEmpty.left === 0 && mapSaveEmpty.alerts.some(a => /nevet/i.test(a)) && mapSaveEmpty.popupStill)
    ok('map popup Mentés pontként requires a name', mapSaveEmpty);
  else fail('map popup Mentés pontként requires a name', JSON.stringify(mapSaveEmpty));

  const mapSaveOk = await ev(desk, `(async () => {
    document.getElementById('pickSaveName').value = 'Térkép próba';
    document.getElementById('pickAsSaved').click();
    await new Promise(r => setTimeout(r, 40));
    const list = BalatonMarks.savedPoints();
    const ui = document.getElementById('savedPointsList').innerText;
    const del = Array.from(document.querySelectorAll('#savedPointsList button')).some(b => b.textContent === 'Törlés');
    const status = document.getElementById('savePointStatus') && document.getElementById('savePointStatus').textContent;
    const stored = JSON.parse(localStorage.getItem(BalatonMarks.STORAGE_KEY) || '[]');
    return { list, ui, del, status, stored };
  })()`);
  report.mapSaveOk = mapSaveOk;
  const msFail = [];
  if (!mapSaveOk.list || mapSaveOk.list.length !== 1 || mapSaveOk.list[0].name !== 'Térkép próba') msFail.push('list');
  if (!mapSaveOk.list || Math.abs(mapSaveOk.list[0].lat - 46.91) > 1e-4 || Math.abs(mapSaveOk.list[0].lon - 17.89) > 1e-4) msFail.push('coords');
  if (!/Térkép próba/.test(mapSaveOk.ui) || !mapSaveOk.del) msFail.push('ui/delete');
  if (!mapSaveOk.stored || mapSaveOk.stored.length !== 1) msFail.push('localStorage');
  if (!/Elmentve: Térkép próba/.test(mapSaveOk.status || '')) msFail.push('status');
  if (msFail.length === 0) ok('map popup Mentés pontként saves named point with delete in list', { id: mapSaveOk.list[0].id });
  else fail('map popup Mentés pontként saves named point with delete in list', msFail.join('; ') + ' ' + JSON.stringify(mapSaveOk));

  await ev(desk, `(() => {
    const r = document.getElementById('result');
    if (r) { r.style.display = 'none'; r.innerHTML = ''; }
    document.getElementById('savePointBlock').scrollIntoView({block:'start'});
  })()`);
  await sleep(250);
  await screenshot(desk, path.join(OUT, 'waypoint-desktop-form.png'));
  await ev(desk, `document.getElementById('savedPointsBox').scrollIntoView({block:'center'})`);
  await sleep(200);
  await screenshot(desk, path.join(OUT, 'waypoint-desktop-list.png'));
  await ev(desk, `(() => {
    const r = document.getElementById('result');
    if (r) { r.style.display = 'none'; r.innerHTML = ''; }
    map.setView([46.91, 17.89], 11);
    map.fire('click', { latlng: L.latLng(46.91000, 17.89000) });
    const m = document.getElementById('map');
    if (m) m.scrollIntoView({block:'center'});
  })()`);
  await sleep(300);
  await screenshot(desk, path.join(OUT, 'waypoint-desktop-popup.png'));

  // Share link round-trip with race marks
  const shareUrl = BASE + 'index.html?from=kekszalag_1&to=kekszalag_3&race=kekszalag-2026&boat=aiolos&mix=1.25&m=d2&nc=0';
  await goto(desk, shareUrl);
  const rt = await ev(desk, `(() => {
    const start = document.getElementById('startSelect').value;
    const to = document.getElementById('targetSelect').value;
    const race = document.getElementById('raceSelect').value;
    const boat = document.getElementById('boat').value;
    const startOpts = Array.from(document.getElementById('startSelect').options).map(o => o.value);
    return {
      start, to, race, boat,
      pos: currentPos,
      target: getTarget(),
      hasKsz: startOpts.includes('kekszalag_1'),
      noByc: !startOpts.includes('szolo_rajt'),
      q: buildShareQuery({ models: ['icon_d2'], mix: 1.25, nc: false, tms: Date.parse('2026-12-06T08:00:00Z') })
    };
  })()`);
  report.roundTripKey = rt;
  const rtFail = [];
  if (rt.race !== 'kekszalag-2026' || rt.boat !== 'aiolos') rtFail.push('race/boat');
  if (rt.start !== 'kekszalag_1' || rt.to !== 'kekszalag_3') rtFail.push('selects');
  if (!rt.pos || Math.abs(rt.pos.lat - 47.0231667) > 1e-5) rtFail.push('start coord');
  if (!rt.target || Math.abs(rt.target.lat - 46.74755) > 1e-5) rtFail.push('target coord');
  if (!rt.hasKsz || !rt.noByc) rtFail.push('list filter');
  const rtParams = Object.fromEntries(new URLSearchParams(rt.q));
  if (rtParams.from !== 'kekszalag_1' || rtParams.to !== 'kekszalag_3' || rtParams.race !== 'kekszalag-2026')
    rtFail.push('rebuild query ' + rt.q);
  if (rtFail.length === 0) ok('share link round-trip with official race mark keys', rtParams);
  else fail('share link round-trip with official race mark keys', rtFail.join('; ') + ' ' + JSON.stringify(rt));

  // lat,lon share params still work (and coexist with race=)
  const llUrl = BASE + 'index.html?from=46.94827,17.89483&to=47.02317,18.10535&race=kekszalag-2026&boat=elan310';
  await goto(desk, llUrl);
  const ll = await ev(desk, `(() => {
    const q = buildShareQuery({ models: ['icon_d2'], mix: 2, nc: false, tms: Date.parse('2026-12-06T08:00:00Z') });
    return {
      race: document.getElementById('raceSelect').value,
      boat: document.getElementById('boat').value,
      startSel: document.getElementById('startSelect').value,
      toSel: document.getElementById('targetSelect').value,
      pos: currentPos,
      target: getTarget(),
      q
    };
  })()`);
  report.roundTripLL = ll;
  const llFail = [];
  if (ll.race !== 'kekszalag-2026' || ll.boat !== 'elan310') llFail.push('race/boat');
  if (!ll.pos || Math.abs(ll.pos.lat - 46.94827) > 1e-4 || ll.startSel !== '') llFail.push('from latlon');
  if (!ll.target || Math.abs(ll.target.lat - 47.02317) > 1e-4 || ll.toSel !== 'manual') llFail.push('to latlon');
  const llP = Object.fromEntries(new URLSearchParams(ll.q));
  if (!llP.from || !llP.from.startsWith('46.94827,17.89483')) llFail.push('share from ' + llP.from);
  if (!llP.to || !llP.to.startsWith('47.02317,18.10535')) llFail.push('share to ' + llP.to);
  if (llFail.length === 0) ok('share from/to lat,lon round-trip with race param', llP);
  else fail('share from/to lat,lon round-trip with race param', llFail.join('; ') + ' ' + JSON.stringify(ll));

  // Legacy BYC share still restores and switches race
  await goto(desk, BASE + 'index.html?from=szolo_rajt&to=szolo_aliga&boat=aiolos');
  const legacy = await ev(desk, `({
    race: document.getElementById('raceSelect').value,
    start: document.getElementById('startSelect').value,
    to: document.getElementById('targetSelect').value,
    boat: document.getElementById('boat').value,
    pos: currentPos
  })`);
  if (legacy.race === 'byc-szolo' && legacy.start === 'szolo_rajt' && legacy.to === 'szolo_aliga' && legacy.boat === 'aiolos')
    ok('legacy BYC share infers race and restores presets', legacy);
  else fail('legacy BYC share infers race and restores presets', JSON.stringify(legacy));

  if (desk.errs.length === 0) ok('desktop marks tests no JS errors');
  else fail('desktop marks tests no JS errors', desk.errs.join(' | '));

  // HowTo page
  await sessionGotoHowto(desk, BASE + 'howto.html');
  const howto = await ev(desk, `({
    title: document.title,
    h1: document.querySelector('.header h1') && document.querySelector('.header h1').textContent,
    elan: /Elan 310/.test(document.body.innerText) && !/Nautic 311/.test(document.body.innerText) && !/választó kulcsa/.test(document.body.innerText) && !/elan310/.test(document.body.innerText),
    aiolos: document.body.innerText.includes('Aiolos') && document.body.innerText.includes('Elan 295') && document.body.innerText.includes('HUN 295') && document.body.innerText.includes('ORC') && !/választó kulcsa/.test(document.body.innerText),
    svgs: document.querySelectorAll('svg').length,
    back: !!document.querySelector('a[href="index.html"]'),
    hasElan295: /Elan 295/.test(document.body.innerText),
    noStalker: !/Stalker/.test(document.body.innerText)
  })`);
  report.howto = howto;
  if (howto.elan && howto.aiolos && howto.svgs >= 2 && howto.back && howto.hasElan295 && howto.noStalker)
    ok('howto.html polar keys/labels and SVGs', howto);
  else fail('howto.html polar keys/labels and SVGs', JSON.stringify(howto));
  await ev(desk, `window.scrollTo(0,0)`);
  await sleep(200);
  await screenshot(desk, path.join(OUT, 'desktop-howto.png'));
  await ev(desk, `const h = document.querySelector('h2'); if (h && h.textContent.includes('polár')) h.scrollIntoView({block:'start'});`);
  await sleep(200);
  await screenshot(desk, path.join(OUT, 'desktop-howto-polar.png'));

  desk.ws.close();
  dch.kill();

  // Mobile screenshots + a couple of checks
  const mport = 9332;
  const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const mch = startChrome(mport, 390, 844, MOBILE_UA);
  const mob = await attach(mport);
  await setupPage(mob, 390, 844);
  await goto(mob, BASE);
  const mobBoot = await ev(mob, `(() => {
    BalatonMarks.selectRace('kekszalag-2026');
    const w = window.innerWidth;
    return {
      race: BalatonMarks.currentRaceId(),
      bodyScroll: document.documentElement.scrollWidth,
      inner: w,
      geo: document.getElementById('geoBtn').textContent.trim()
    };
  })()`);
  report.mobile = mobBoot;
  if (mobBoot.race === 'kekszalag-2026' && mobBoot.bodyScroll <= mobBoot.inner + 2 && mobBoot.geo === 'Jelenlegi pozíció')
    ok('mobile race switch no horizontal overflow', mobBoot);
  else fail('mobile race switch no horizontal overflow', JSON.stringify(mobBoot));

  await ev(mob, `window.scrollTo(0,0)`);
  await sleep(250);
  await screenshot(mob, path.join(OUT, 'mobile-kekszalag.png'));
  await ev(mob, `document.getElementById('pointsCard').scrollIntoView({block:'start'})`);
  await sleep(250);
  await screenshot(mob, path.join(OUT, 'mobile-points-card.png'));

  await ev(mob, `(() => {
    BalatonMarks.savedPoints().forEach(p => BalatonMarks.deletePoint(p.id));
    document.getElementById('savePointName').value = 'Kikötő teszt';
    BalatonMarks.setStartFromLatLon(46.93878, 17.91093, 'Térkép');
    document.getElementById('savePointBtn').click();
    document.getElementById('savePointBlock').scrollIntoView({block:'start'});
  })()`);
  await sleep(250);
  await screenshot(mob, path.join(OUT, 'waypoint-mobile-form.png'));
  await ev(mob, `document.getElementById('savedPointsBox').scrollIntoView({block:'center'})`);
  await sleep(200);
  await screenshot(mob, path.join(OUT, 'waypoint-mobile-list.png'));

  await ev(mob, `(() => {
    map.setView([46.91, 17.89], 11);
    map.fire('click', { latlng: L.latLng(46.91000, 17.89000) });
    document.getElementById('map').scrollIntoView({block:'center'});
  })()`);
  await sleep(300);
  await screenshot(mob, path.join(OUT, 'mobile-map-pick.png'));
  await screenshot(mob, path.join(OUT, 'waypoint-mobile-popup.png'));

  await sessionGotoHowto(mob, BASE + 'howto.html');
  await ev(mob, `window.scrollTo(0,0)`);
  await sleep(200);
  await screenshot(mob, path.join(OUT, 'mobile-howto.png'));

  if (mob.errs.length === 0) ok('mobile marks tests no JS errors');
  else fail('mobile marks tests no JS errors', mob.errs.join(' | '));
  mob.ws.close();
  mch.kill();

  const passed = report.tests.filter(t => t.ok).length;
  const failed = report.tests.filter(t => !t.ok);
  const summary = { passed, failed: failed.length, tests: report.tests };
  fs.writeFileSync(path.join(OUT, 'marks-test-report.json'), JSON.stringify({ summary, report }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

async function sessionGotoHowto(session, url) {
  await session.send('Page.navigate', { url });
  await session.send('Page.loadEventFired');
  await sleep(400);
}
