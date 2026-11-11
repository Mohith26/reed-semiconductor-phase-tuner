// Prints every headline number the page shows, computed by src/phasetuner.js
// from data/traces.js.   node scripts/report.js [alpha]
const fs = require('fs');
const path = require('path');
const PT = require('../src/phasetuner.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'traces.js'), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
const alpha = +(process.argv[2] || 0.005);
const r = PT.rail();
const t0 = Date.now();
const A = PT.analyze(r, data, alpha);
const f = (x, d = 2) => x.toFixed(d);
console.log('peak-efficiency current per phase:', f(PT.peakEffCurrent(r), 1), 'A; datasheet threshold', f(PT.peakEffCurrent(r) + 6, 1), 'A');
console.log('calibration steps:', A.calEvents.length, ' held-out steps:', A.all.events);
console.log('floor (alpha=' + alpha + '):', A.floor.table.join(','), ' m per bin:', A.floor.info.map((b) => b.m).join(','));
for (const k of ['all', 'ds', 'fl']) {
  const x = A[k];
  console.log(k.padEnd(4), 'avg VR loss', f(x.avgLossW, 3), 'W  eff', f(100 * x.efficiency, 2) + '%', ' out-of-spec', x.violations, '/', x.events,
    ' worst margin', f(1e3 * x.worst.margin, 1), 'mV');
}
console.log('shedding saving (all-on minus datasheet):', f(A.saving, 3), 'W; calibrated keeps', f(100 * A.keptFloor, 1) + '%');
const sweep = PT.staticSweep(r, A.split.test);
const m = PT.matchedStatic(sweep, A.fl.violations);
console.log('best uniform threshold with <=', A.fl.violations, 'violations:', m ? (m.iTh + ' A/phase, loss ' + f(m.avgLossW, 3) + ' W, keeps ' + f(100 * (A.all.avgLossW - m.avgLossW) / A.saving, 1) + '%') : 'none');
console.log('sweep:', sweep.map((x) => x.iTh + ':' + f(x.avgLossW, 3) + 'W/' + x.violations).join(' '));
for (const a of [0.02, 0.01, 0.005, 0.002]) {
  const fl = PT.calibrateFloor(r, A.scored, a, PT.BIN_EDGES);
  const x = PT.runMany(r, A.split.test, PT.floorPolicy(r, fl));
  console.log('alpha', a, 'floor', fl.table.join(','), 'loss', f(x.avgLossW, 3), 'viol', x.violations, 'kept', f(100 * (A.all.avgLossW - x.avgLossW) / A.saving, 1) + '%');
}
console.log('ms', Date.now() - t0);
