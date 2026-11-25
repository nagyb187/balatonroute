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

// --- Downwind: committed behaviour, no run in polarActions ---
(function () {
  const actsA = polarActions(A, { spd: 12, dir: 0 });
  const actsE = polarActions(E, { spd: 12, dir: 0 });
  const runLikeA = actsA.filter(a => a.twa > 150);
  const runLikeE = actsE.filter(a => a.twa > 150);
  if (runLikeA.length === 0 && runLikeE.length === 0 && actsA.length === 2 + 8 * 2)
    ok('polarActions: beat + table angles only, no bőszeles/run gybes (Aiolos and Elan 310)');
  else fail('polarActions run', JSON.stringify({ nA: actsA.length, runA: runLikeA, nE: actsE.length }));

  // Linear interpolation 135-150 and extrapolation after 150 (Elan, no run used)
  const s135 = getBoatSpeed(E, 10, 135).speed;
  const s150 = getBoatSpeed(E, 10, 150).speed;
  const s165 = getBoatSpeed(E, 10, 165).speed;
  const exp = s150 + (165 - 150) / (150 - 135) * (s150 - s135);
  if (almost(s150, 6.12) && almost(s165, exp, 1e-9))
    ok('Elan 310 (and Aiolos) after 150°: linear extrapolation from 135° and 150°');
  else fail('extrap 150', JSON.stringify({ s135, s150, s165, exp }));

  // Aiolos 12 kt 150 is official 6.68, not replaced by run point
  if (almost(getBoatSpeed(A, 12, 150).speed, 6.68))
    ok('Aiolos 12 kt 150° stays the table speed 6.68 (run data unused)');
  else fail('aiolos 150 unused run', getBoatSpeed(A, 12, 150).speed);
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  errors.forEach(e => console.log(' -', e));
  process.exit(1);
}
