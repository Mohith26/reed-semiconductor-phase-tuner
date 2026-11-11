// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PT = require('../src/phasetuner.js');
const { build } = require('../scripts/gen-data.js');

const r = PT.rail();
const ds = PT.defaultStatic(r);

function loadData() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'traces.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}

test('no step: output sits on the load line with the full window as margin', () => {
  const x = PT.simulateStep(r, { I0: 400, I1: 400, slew: 1000 }, 9, ds, { wave: true });
  assert.ok(Math.abs(x.margin - r.TOB) < 1e-9);
  const last = x.wave[x.wave.length - 1];
  assert.ok(Math.abs(last[1] - (r.Vref - r.RLL * 400)) < 1e-6);
});

test('settles to the new load-line point after a step', () => {
  const x = PT.simulateStep(r, { I0: 200, I1: 700, slew: 800 }, 16, ds, { wave: true, tailUs: 40 });
  const last = x.wave[x.wave.length - 1];
  assert.ok(Math.abs(last[1] - (r.Vref - r.RLL * 700)) < 0.5e-3, 'Vout ' + last[1]);
  assert.ok(Math.abs(last[2] - 700) < 2, 'IL ' + last[2]);
});

test('inductor current slew never exceeds n*(Vin-Vout)/L and respects the per-phase limit', () => {
  const noAdd = { addTarget: () => 1, dropTarget: () => 1 };
  const rr = PT.rail({ vUsr: 10 });            // disable USR so n stays fixed
  const x = PT.simulateStep(rr, { I0: 100, I1: 900, slew: 3000 }, 4, noAdd, { wave: true, wavePoints: 100000 });
  for (let i = 1; i < x.wave.length; i++) {
    const dI = x.wave[i][2] - x.wave[i - 1][2];
    const dt = (x.wave[i][0] - x.wave[i - 1][0]) * 1e-6;
    assert.ok(dI / dt <= 4 * rr.Vin / rr.L * 1.0001);
    assert.ok(x.wave[i][2] <= 4 * rr.IpkPh + 1e-9);
  }
  assert.ok(x.margin < 0, 'four phases with no undershoot reduction cannot hold 100->900 A');
});

test('requiredPhases = smallest n that is safe for every count in [n, N]', () => {
  const evs = [
    { I0: 110, I1: 950, slew: 2500 }, { I0: 160, I1: 820, slew: 1200 },
    { I0: 300, I1: 900, slew: 1800 }, { I0: 520, I1: 980, slew: 3000 }, { I0: 120, I1: 400, slew: 600 }
  ];
  for (const e of evs) {
    const ok = [];
    for (let n = 1; n <= r.N; n++) ok[n] = PT.simulateStep(r, e, n, ds).margin >= 0;
    let want = r.N + 1;
    for (let n = r.N; n >= 1 && ok[n]; n--) want = n;
    assert.equal(PT.requiredPhases(r, e, ds), want);
    // more phases is never much worse: the non-monotone wiggle is < 2.5 mV
    let prev = -Infinity;
    for (let n = 1; n <= r.N; n++) {
      const m = PT.simulateStep(r, e, n, ds).margin;
      assert.ok(m >= prev - 2.5e-3, 'n=' + n);
      prev = Math.max(prev, m);
    }
  }
});

test('3 us tail captures the undershoot minimum (same margin as a 30 us tail)', () => {
  const data = loadData();
  const tr = PT.fromCompact(data.traces[0]);
  const evs = PT.extractEvents(tr).slice(0, 300);
  for (const e of evs) for (const n of [2, 6, 16]) {
    const a = PT.simulateStep(r, e, n, ds).margin;
    const b = PT.simulateStep(r, e, n, ds, { tailUs: 30 }).margin;
    assert.ok(Math.abs(a - b) < 1e-12);
  }
});

test('loss model: peak-efficiency current minimises loss per amp; shedding helps at light load', () => {
  const ip = PT.peakEffCurrent(r);
  const perAmp = (i) => PT.phaseLoss(r, i) / i;
  assert.ok(perAmp(ip) <= perAmp(ip * 0.9) && perAmp(ip) <= perAmp(ip * 1.1));
  assert.ok(PT.railLoss(r, 120, 3) < PT.railLoss(r, 120, 16));
  assert.ok(PT.railLoss(r, 900, 16) < PT.railLoss(r, 900, 8));
});

test('datasheet policy adds a phase at the peak-efficiency point + 6 A and drops with hysteresis', () => {
  const th = PT.peakEffCurrent(r) + 6;
  assert.equal(ds.addTarget(th * 3 - 0.1), 3);
  assert.equal(ds.addTarget(th * 3 + 0.1), 4);
  assert.ok(ds.dropTarget(th * 3 - 5) >= ds.addTarget(th * 3 - 5));
  assert.equal(PT.allOnPolicy(r).addTarget(1), r.N);
});

test('conformal floor is the ceil((m+1)(1-alpha))-th order statistic per bin', () => {
  const edges = [100];
  const scores = [];
  for (let i = 0; i < 99; i++) scores.push({ I0: 50, nReq: (i % 10) + 1 });  // bin 0, m=99
  for (let i = 0; i < 5; i++) scores.push({ I0: 500, nReq: 2 });             // bin 1, m=5
  const f = PT.calibrateFloor(r, scores, 0.1, edges);
  const sorted = scores.filter((s) => s.I0 < 100).map((s) => s.nReq).sort((a, b) => a - b);
  assert.equal(f.table[0], sorted[Math.ceil(100 * 0.9) - 1]);
  assert.equal(f.table[1], r.N, 'too few calibration points -> all phases');
  assert.equal(f.info[0].m, 99);
});

test('conformal floor covers fresh exchangeable steps at rate >= 1 - alpha', () => {
  const rng = PT.mulberry32(7);
  const draw = () => Math.min(16, 1 + Math.floor(-Math.log(rng()) * 2.2)); // skewed integer scores
  const alpha = 0.05;
  let miss = 0, total = 0;
  for (let rep = 0; rep < 200; rep++) {
    const cal = Array.from({ length: 200 }, () => ({ I0: 10, nReq: draw() }));
    const f = PT.calibrateFloor(r, cal, alpha, [1000]);
    for (let k = 0; k < 50; k++) { total++; if (draw() > f.table[0]) miss++; }
  }
  assert.ok(miss / total <= alpha + 0.01, 'miscoverage ' + miss / total);
});

test('trace generator is deterministic and data/traces.js is exactly what scripts/gen-data.js builds', () => {
  const a = PT.generateTrace('training', 42, 3000), b = PT.generateTrace('training', 42, 3000);
  assert.deepEqual(a, b);
  const committed = loadData();
  assert.deepEqual(JSON.parse(JSON.stringify(build())), committed);
});

test('replay: energy bookkeeping and phase-drop delay', () => {
  const tr = { profile: 'x', seed: 0, durationUs: 300, segments: [
    { t: 0, I: 800, slew: 0 }, { t: 100, I: 120, slew: 0 }, { t: 300, I: 120, slew: 0, end: true }] };
  const x = PT.runTrace(r, tr, ds, { timeline: true });
  // 0-100 us: 16 phases at 800 A; 100-150 us: still 16 (drop delay); 150-300 us: dropTarget(120)
  const nLow = ds.dropTarget(120);
  const expect = 100e-6 * PT.railLoss(r, 800, 16) + 50e-6 * PT.railLoss(r, 120, 16) + 150e-6 * PT.railLoss(r, 120, nLow);
  assert.ok(Math.abs(x.lossJ - expect) < 1e-12);
  const out = 100e-6 * (r.Vref - r.RLL * 800) * 800 + 200e-6 * (r.Vref - r.RLL * 120) * 120;
  assert.ok(Math.abs(x.outJ - out) < 1e-12);
  assert.deepEqual(x.timeline[x.timeline.length - 1], [150, 120, nLow]);
});

test('calibrated floor policy never runs fewer phases than the datasheet policy', () => {
  const data = loadData();
  const sp = PT.splitTraces(data);
  const ev = PT.extractEvents(sp.cal[0]).slice(0, 400);
  const sc = PT.scoreEvents(r, ev);
  const fl = PT.floorPolicy(r, PT.calibrateFloor(r, sc, 0.05, PT.BIN_EDGES));
  for (let I = 0; I <= 1100; I += 7) {
    assert.ok(fl.addTarget(I) >= ds.addTarget(I));
    assert.ok(fl.dropTarget(I) >= ds.dropTarget(I));
  }
});

test('damped current command: no recovery overshoot above the pre-step voltage, even after a deep undershoot', () => {
  for (const n of [2, 3, 8, 16]) {
    const x = PT.simulateStep(r, { I0: 103, I1: 936, slew: 2882 }, n, ds, { wave: true, wavePoints: 2000, tailUs: 12 });
    const vmax = Math.max(...x.wave.map((p) => p[1]));
    assert.ok(vmax <= r.Vref - r.RLL * 103 + 1e-4, 'n=' + n + ' vmax ' + vmax);
  }
});

test('10 ns step is within 2.5 mV of a 2 ns reference on real calibration steps', () => {
  const data = loadData();
  const evs = PT.extractEvents(PT.fromCompact(data.traces[1])).slice(0, 150);
  const fine = PT.rail({ dt: 2e-9 });
  for (const e of evs) for (const n of [3, 8, 16]) {
    const a = PT.simulateStep(r, e, n, ds).margin, b = PT.simulateStep(fine, e, n, PT.defaultStatic(fine)).margin;
    assert.ok(Math.abs(a - b) < 2.5e-3);
  }
});
