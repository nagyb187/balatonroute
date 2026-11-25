#!/usr/bin/env node
// Unit tests for getBoatSpeed / polarActions, extracted from index.html.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extract(re, label) {
  const m = html.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}

const polarsSrc = extract(
  /const polarElan310 = \{[\s\S]*?\};\s*const polarAiolos = \{[\s\S]*?\};\s*const polars = \{[^;]+\};/,
  'polars'
);
const helpersSrc = extract(
  /const NO_GO_TWA = \d+;[\s\S]*?function polarActions\(polar, wind\) \{[\s\S]*?\n    \}\n/,
  'helpers'
);

const ctx = { Math, console };
vm.createContext(ctx);
vm.runInContext(
  polarsSrc + '\n' + helpersSrc +
  '\nthis.__P = { polarElan310, polarAiolos, polars, NO_GO_TWA, getBoatSpeed, beatAngleAt, polarActions, polarWindIdx };',
  ctx
);
const {
  polarAiolos: A, polarElan310: E, getBoatSpeed, beatAngleAt,
  polarActions, polarWindIdx, NO_GO_TWA
} = ctx.__P;
if (!A || !E || typeof getBoatSpeed !== 'function') {
  throw new Error('extraction failed: ' + Object.keys(ctx.__P || {}));
}

let passed = 0, failed = 0;
const errors = [];
function ok(name) { passed++; console.log('ok  ', name); }
function fail(name, msg) { failed++; errors.push(name + ': ' + msg); console.log('FAIL', name, msg); }
function almost(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

function nExp(beat) {
  return (beat - NO_GO_TWA) * Math.tan(beat * Math.PI / 180) * Math.PI / 180;
}

// --- NO_GO is 10 ---
if (NO_GO_TWA === 10) ok('NO_GO_TWA is 10');
else fail('NO_GO_TWA', String(NO_GO_TWA));

// --- Official 4 and 24 kt columns present and used ---
if (A.winds[0] === 4 && A.winds[A.winds.length - 1] === 24 && A.winds.includes(24))
  ok('polarAiolos winds include 4 and 24 kt; last column is 24');
else fail('aiolos winds', JSON.stringify(A.winds));

if (almost(getBoatSpeed(A, 4, 90).speed, 3.87) && almost(getBoatSpeed(A, 24, 90).speed, 7.67))
  ok('Aiolos uses 4 kt (90°=3.87) and 24 kt (90°=7.67) columns');
else fail('4/24 table speeds', JSON.stringify({ s4: getBoatSpeed(A, 4, 90).speed, s24: getBoatSpeed(A, 24, 90).speed }));

// 22 kt interpolates between 20 and 24
(function () {
  const s20 = getBoatSpeed(A, 20, 90).speed;
  const s24 = getBoatSpeed(A, 24, 90).speed;
  const s22 = getBoatSpeed(A, 22, 90).speed;
  const exp = (s20 + s24) / 2;
  if (almost(s20, 7.55) && almost(s24, 7.67) && almost(s22, exp, 1e-9))
    ok('Aiolos 22 kt 90° interpolates between 20 and 24 kt columns (' + s22.toFixed(4) + ')');
  else fail('22 kt interp', JSON.stringify({ s20, s22, s24, exp }));

  const b20 = beatAngleAt(A, 20), b24 = beatAngleAt(A, 24), b22 = beatAngleAt(A, 22);
  if (almost(b22, (b20 + b24) / 2, 1e-9))
    ok('Aiolos 22 kt beat angle interpolates 20 and 24 kt (' + b22.toFixed(3) + '°)');
  else fail('22 kt beat interp', JSON.stringify({ b20, b22, b24 }));
})();

// Above max: always the polar's OWN last column, no extrapolation
(function () {
  const s24 = getBoatSpeed(A, 24, 90).speed;
  const s30 = getBoatSpeed(A, 30, 90).speed;
  const s40 = getBoatSpeed(A, 40, 135).speed;
  const s24_135 = getBoatSpeed(A, 24, 135).speed;
  if (almost(s30, s24, 1e-9) && almost(s40, s24_135, 1e-9) && almost(beatAngleAt(A, 30), beatAngleAt(A, 24)))
    ok('Aiolos 30 kt (and 40 kt) uses the 24 kt column; no speed-up above max');
  else fail('aiolos above max', JSON.stringify({ s24, s30, s40, s24_135, beat30: beatAngleAt(A, 30) }));

  const s20e = getBoatSpeed(E, 20, 90).speed;
  const s30e = getBoatSpeed(E, 30, 90).speed;
  if (almost(s20e, 8.00) && almost(s30e, s20e, 1e-9) && almost(beatAngleAt(E, 30), E.beatAngles[E.beatAngles.length - 1]))
    ok('Elan 310 30 kt uses its own 20 kt column (not 24, not extrapolated)');
  else fail('elan above max', JSON.stringify({ s20e, s30e, beat: beatAngleAt(E, 30) }));

  // Synthetic polar whose last column is 16 kt
  const slim = {
    winds: [6, 10, 16],
    beatAngles: [43, 40, 39],
    angles: [52, 90, 150],
    speeds: { 6: [4.0, 5.0, 3.0], 10: [6.0, 7.0, 5.0], 16: [7.0, 8.0, 6.0] },
    beatVMG: [3.0, 4.0, 4.5]
  };
  const s16 = getBoatSpeed(slim, 16, 90).speed;
  const s25 = getBoatSpeed(slim, 25, 90).speed;
  const s25_52 = getBoatSpeed(slim, 25, 52).speed;
  const w = polarWindIdx(slim, 25);
  if (almost(s16, 8.0) && almost(s25, 8.0, 1e-9) && almost(s25_52, 7.0, 1e-9)
      && w.i1 === 2 && w.i2 === 2 && w.scale === 1 && almost(beatAngleAt(slim, 25), 39))
    ok('synthetic polar max 16 kt: 25 kt uses the 16 kt column, no extrapolation');
  else fail('slim max 16', JSON.stringify({ s16, s25, s25_52, w, beat: beatAngleAt(slim, 25) }));
})();

// --- Speed 0 at/under 10° for every table wind, both boats ---
(function () {
  let bad = [];
  for (const [name, P] of [['Aiolos', A], ['Elan 310', E]]) {
    for (const w of P.winds) {
      for (const twa of [0, 5, 10]) {
        const s = getBoatSpeed(P, w, twa).speed;
        if (s !== 0) bad.push(name + ' ' + w + 'kt TWA ' + twa + ' → ' + s);
      }
      const just = getBoatSpeed(P, w, 10.01).speed;
      if (!(just > 0)) bad.push(name + ' ' + w + 'kt TWA 10.01 not > 0');
    }
  }
  if (!bad.length) ok('speed is 0 at TWA ≤ 10° for every wind, both boats; >0 just above 10°');
  else fail('no-go 10°', bad.join('; '));
})();

// --- VMG max exactly at beat for every wind, both boats ---
(function () {
  const elanN = [];
  const aiolosN = [];
  let bad = [];
  for (const [name, P, collect] of [['Aiolos', A, aiolosN], ['Elan 310', E, elanN]]) {
    for (const w of P.winds) {
      const beat = beatAngleAt(P, w);
      const atBeat = getBoatSpeed(P, w, beat);
      const n = nExp(beat);
      collect.push({ w, beat, n, vmg: atBeat.vmg });
      // Continuity at beat: approach from below and from above
      const below = getBoatSpeed(P, w, beat - 1e-6);
      const above = getBoatSpeed(P, w, beat + 1e-6);
      if (!almost(below.speed, atBeat.speed, 2e-5) || !almost(above.speed, atBeat.speed, 2e-5))
        bad.push(name + ' ' + w + 'kt discontinuity at beat: ' + JSON.stringify({ below: below.speed, at: atBeat.speed, above: above.speed }));
      // Sample upwind VMG; max at beat ±0.5°, equals cert beat VMG
      const idx = P.winds.indexOf(w);
      const certVmg = P.beatVMG[idx];
      if (!almost(atBeat.vmg, certVmg, 1e-9))
        bad.push(name + ' ' + w + 'kt beat VMG ' + atBeat.vmg + ' != cert ' + certVmg);
      let maxV = -1, maxT = null;
      for (let twa = NO_GO_TWA + 0.05; twa <= 90; twa += 0.05) {
        const v = getBoatSpeed(P, w, twa).vmg;
        if (v > maxV + 1e-12) { maxV = v; maxT = twa; }
      }
      if (Math.abs(maxT - beat) > 0.5 || !almost(maxV, certVmg, 5e-4))
        bad.push(name + ' ' + w + 'kt VMG max at ' + maxT + '° / ' + maxV.toFixed(4) + ' (beat ' + beat + ' / ' + certVmg + ')');
    }
  }
  if (!bad.length) ok('upwind VMG max is at beat (±0.5°) and equals cert beat VMG, every wind, both boats; continuous at beat');
  else fail('VMG max / continuity', bad.join(' | '));

  console.log('Elan 310 n values (n = (beat-10)·tan(beat)·π/180):');
  elanN.forEach(r => console.log('  ' + r.w + ' kt  beat ' + r.beat.toFixed(1) + '°  n=' + r.n.toFixed(4) + '  beatVMG=' + r.vmg.toFixed(3)));
  console.log('Aiolos n values:');
  aiolosN.forEach(r => console.log('  ' + r.w + ' kt  beat ' + r.beat.toFixed(1) + '°  n=' + r.n.toFixed(4) + '  beatVMG=' + r.vmg.toFixed(3)));
  globalThis.__elanN = elanN;
  globalThis.__aiolosN = aiolosN;
})();

// --- Downwind: Elan (no run data) keeps 135–150 linear extrapolation ---
(function () {
  const actsE = polarActions(E, { spd: 12, dir: 0 });
  const runLikeE = actsE.filter(a => a.twa > 150);
  if (runLikeE.length === 0 && actsE.length === 2 + 8 * 2)
    ok('polarActions Elan 310: beat + table angles only (no run data, no bőszeles gybes)');
  else fail('polarActions Elan', JSON.stringify({ nE: actsE.length, runE: runLikeE }));

  const s135 = getBoatSpeed(E, 10, 135).speed;
  const s150 = getBoatSpeed(E, 10, 150).speed;
  const s165 = getBoatSpeed(E, 10, 165).speed;
  const exp = s150 + (165 - 150) / (150 - 135) * (s150 - s135);
  if (almost(s150, 6.12) && almost(s165, exp, 1e-9))
    ok('Elan 310 after 150°: linear extrapolation from 135° and 150° (no run data)');
  else fail('extrap 150', JSON.stringify({ s135, s150, s165, exp }));
})();

// --- Downwind C2: Aiolos uses certificate run TWA/VMG ---
(function () {
  // 12 kt run is 160.0°; 150° is the nearer table anchor, table speed stays
  if (almost(getBoatSpeed(A, 12, 150).speed, 6.68))
    ok('Aiolos 12 kt 150° stays the table speed 6.68 (C2 anchor)');
  else fail('aiolos 12 kt 150', getBoatSpeed(A, 12, 150).speed);

  const actsA12 = polarActions(A, { spd: 12, dir: 0 });
  const runLike = actsA12.filter(a => Math.abs(a.twa - 160) < 1e-9);
  if (actsA12.length === 2 + 8 * 2 + 2 && runLike.length === 2)
    ok('polarActions Aiolos 12 kt includes the certificate run TWA (160°) on both tacks');
  else fail('polarActions Aiolos run', JSON.stringify({ n: actsA12.length, runLike }));

  // 6 kt: run is before 150°, so 150° is on the C2 parabola, not the table value 3.97
  const s6_150 = getBoatSpeed(A, 6, 150).speed;
  if (almost(s6_150, 3.953, 5e-3) && !almost(s6_150, 3.97, 1e-3))
    ok('Aiolos 6 kt 150° is C2 (' + s6_150.toFixed(3) + '), not the unused table 3.97');
  else fail('aiolos 6 kt 150 C2', s6_150);

  // C2 opt TWA/VMG must match the demo table at 6/10/16/20/24 kn
  const demo = [
    { w: 6,  twaLo: 145.5, twaHi: 146.1, vmg: 3.440, v180: 2.342 },
    { w: 10, twaLo: 151.9, twaHi: 152.1, vmg: 5.210, v180: 4.193 },
    { w: 16, twaLo: 175.0, twaHi: 175.8, vmg: 6.870, v180: 6.856 },
    { w: 20, twaLo: 175.3, twaHi: 176.1, vmg: 7.560, v180: 7.550 },
    { w: 24, twaLo: 164.5, twaHi: 165.3, vmg: 8.370, v180: 8.223 }
  ];
  let bad = [];
  const rows = [];
  for (const d of demo) {
    const idx = A.winds.indexOf(d.w);
    const certTwa = A.runAngles[idx];
    const certVmg = A.runVMG[idx];
    const atRun = getBoatSpeed(A, d.w, certTwa);
    const dwAtRun = atRun.speed * Math.abs(Math.cos(certTwa * Math.PI / 180));
    if (!almost(dwAtRun, certVmg, 1e-9))
      bad.push(d.w + ' kt at cert run VMG ' + dwAtRun + ' != ' + certVmg);

    let maxV = -1, maxT = null;
    for (let twa = 90; twa <= 180 + 1e-12; twa += 0.05) {
      const r = getBoatSpeed(A, d.w, twa);
      const v = r.speed * Math.abs(Math.cos(twa * Math.PI / 180));
      if (v > maxV + 1e-12) { maxV = v; maxT = twa; }
    }
    const inRange = maxT >= d.twaLo - 1e-9 && maxT <= d.twaHi + 1e-9;
    if (!inRange || !almost(maxV, d.vmg, 5e-4) || !almost(maxV, certVmg, 5e-4))
      bad.push(d.w + ' kt opt ' + maxT + '° / ' + maxV.toFixed(4) +
        ' (expected ' + d.twaLo + '–' + d.twaHi + ' / ' + d.vmg + ', cert ' + certTwa + ' / ' + certVmg + ')');

    const v180 = getBoatSpeed(A, d.w, 180).speed; // at 180, speed == |VMG|
    if (!almost(v180, d.v180, 5e-3))
      bad.push(d.w + ' kt V(180) ' + v180 + ' != demo ' + d.v180);

    // After run, VMG must not beat the certificate peak
    let afterBetter = false;
    for (let twa = certTwa + 0.05; twa <= 180 + 1e-12; twa += 0.25) {
      const r = getBoatSpeed(A, d.w, twa);
      const v = r.speed * Math.abs(Math.cos(twa * Math.PI / 180));
      if (v > certVmg + 1e-4) { afterBetter = true; break; }
    }
    if (afterBetter) bad.push(d.w + ' kt VMG after run exceeds cert');

    // Above max wind: 30 kt uses the 24 kt C2 column
    if (d.w === 24) {
      const v30 = getBoatSpeed(A, 30, certTwa).speed * Math.abs(Math.cos(certTwa * Math.PI / 180));
      if (!almost(v30, certVmg, 1e-9))
        bad.push('30 kt run VMG ' + v30 + ' != 24 kt column ' + certVmg);
    }

    rows.push({ w: d.w, optTwa: maxT, optVmg: maxV, v180, certTwa, certVmg });
  }
  if (!bad.length)
    ok('Aiolos C2 opt TWA/VMG matches demo at 6/10/16/20/24 kn; VMG does not improve after run; 30 kt uses 24 kt column');
  else fail('C2 demo table', bad.join(' | '));
  rows.forEach(r => console.log(
    '  C2 ' + r.w + ' kn  opt ' + r.optTwa.toFixed(1) + '° / ' + r.optVmg.toFixed(3) +
    '  cert ' + r.certTwa.toFixed(1) + '° / ' + r.certVmg.toFixed(2) +
    '  V180=' + r.v180.toFixed(3)
  ));
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  errors.forEach(e => console.log(' -', e));
  process.exit(1);
}
