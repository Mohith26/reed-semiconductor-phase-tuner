// Generates the synthetic accelerator core-current traces used by the demo.
// Deterministic: same seeds -> byte-identical data/traces.js.
//   node scripts/gen-data.js
const fs = require('fs');
const path = require('path');
const PT = require('../src/phasetuner.js');

const DURATION_US = 40000;               // 40 ms per trace
const PROFILES = ['training', 'inference', 'hpc'];
const SEED_BASE = { training: 1100, inference: 2300, hpc: 3700 };
const CAL = [0, 1, 2], TEST = [3, 4, 5];  // calibration vs held-out runs

function compact(tr, split) {
  return {
    profile: tr.profile, label: tr.label, seed: tr.seed, split,
    durationUs: +tr.durationUs.toFixed(3),
    // [t_us, I_A, slew_A_per_us]; last row is the end marker
    seg: tr.segments.map((s) => [s.t, s.I, s.slew])
  };
}

function build() {
  const traces = [];
  for (const p of PROFILES) {
    for (const s of CAL) traces.push(compact(PT.generateTrace(p, SEED_BASE[p] + s, DURATION_US), 'cal'));
    for (const s of TEST) traces.push(compact(PT.generateTrace(p, SEED_BASE[p] + s, DURATION_US), 'test'));
  }
  return { generated: 'scripts/gen-data.js', durationUs: DURATION_US, traces };
}

if (require.main === module) {
  const data = build();
  const out = path.join(__dirname, '..', 'data', 'traces.js');
  fs.writeFileSync(out, 'window.PHASE_TRACES = ' + JSON.stringify(data) + ';\n');
  const nseg = data.traces.reduce((a, t) => a + t.seg.length, 0);
  console.log('wrote', out, data.traces.length, 'traces,', nseg, 'segments');
}
module.exports = { build };
