/* Phase Tuner page: every number below is computed here from data/traces.js by src/phasetuner.js. */
(function () {
  'use strict';
  const PT = window.PhaseTuner;
  const data = window.PHASE_TRACES;
  const r = PT.rail();
  const ALPHAS = [0.02, 0.01, 0.005, 0.002];
  const S = { alpha: 0.005, cache: {}, sweep: null, traceIdx: null };
  // deep links: ?alpha=0.01&trace=4 (same code path as the controls)
  const Q = new URLSearchParams(location.search);
  if (ALPHAS.includes(+Q.get('alpha'))) S.alpha = +Q.get('alpha');
  const $ = (id) => document.getElementById(id);
  const tick = () => new Promise((res) => setTimeout(res, 0));
  const fmt = (x, d) => x.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const pct = (x, d) => fmt(100 * x, d == null ? 0 : d) + '%';
  const mv = (v) => (v < 0 ? '\u2212' : '+') + fmt(Math.abs(v * 1e3), 1) + ' mV';
  const NS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------ svg kit ---
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function frame(svg, o) {
    svg.innerHTML = '';
    const W = 520, H = 290, m = Object.assign({ l: 46, r: 16, t: 12, b: 38 }, o.m || {});
    const X = (v) => m.l + (v - o.x[0]) / (o.x[1] - o.x[0]) * (W - m.l - m.r);
    const Y = (v) => H - m.b - (v - o.y[0]) / (o.y[1] - o.y[0]) * (H - m.t - m.b);
    const g = el('g', { class: 'ax' }, svg);
    for (const v of o.yt) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, g);
      const t = el('text', { x: m.l - 7, y: Y(v) + 3.5, 'text-anchor': 'end' }, g); t.textContent = o.yf ? o.yf(v) : v;
    }
    for (const v of o.xt) {
      const t = el('text', { x: X(v), y: H - m.b + 15, 'text-anchor': 'middle' }, g); t.textContent = o.xf ? o.xf(v) : v;
    }
    el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, style: 'stroke:#bdbdbd' }, g);
    const xl = el('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axt' }, svg); xl.textContent = o.xl;
    const yl = el('text', { x: 12, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'axt', transform: 'rotate(-90 12 ' + (m.t + H - m.b) / 2 + ')' }, svg); yl.textContent = o.yl;
    return { X, Y, W, H, m };
  }
  function line(svg, pts, style) {
    if (!pts.length) return;
    el('path', Object.assign({ d: 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L'), fill: 'none' }, style), svg);
  }

  // --------------------------------------------------------- computation ---
  const sp = PT.splitTraces(data);
  const calEv = sp.cal.flatMap(PT.extractEvents);
  const pAll = PT.allOnPolicy(r), pDs = PT.defaultStatic(r);

  async function scoreAll() {
    const out = [];
    for (let i = 0; i < calEv.length; i += 1500) {
      out.push(...PT.scoreEvents(r, calEv.slice(i, i + 1500)));
      $('frontBusy').textContent = 'Calibrating ' + fmt(Math.min(calEv.length, i + 1500)) + ' / ' + fmt(calEv.length) + ' steps';
      await tick();
    }
    return out;
  }
  async function forAlpha(a) {
    if (S.cache[a]) return S.cache[a];
    const floor = PT.calibrateFloor(r, S.scored, a, PT.BIN_EDGES);
    const pol = PT.floorPolicy(r, floor, 'Phase Tuner');
    await tick();
    const res = PT.runMany(r, sp.test, pol);
    S.cache[a] = { floor, pol, res };
    return S.cache[a];
  }

  // ------------------------------------------------------------- render ---
  function renderSpec() {
    const rows = [
      ['Phases', r.N + ' smart power stages'],
      ['Power stage class', '45 A TDC / ' + r.IpkPh + ' A peak'],
      ['V<sub>IN</sub> \u2192 V<sub>OUT</sub>', fmt(r.Vin, 0) + ' V \u2192 ' + fmt(r.Vref, 2) + ' V'],
      ['DC load line', fmt(r.RLL * 1e6, 0) + ' \u00b5\u03a9'],
      ['Output capacitance', fmt(r.C * 1e3, 1) + ' mF, ' + fmt(r.ESR * 1e6, 0) + ' \u00b5\u03a9 ESR'],
      ['Inductance', fmt(r.L * 1e9, 0) + ' nH / phase'],
      ['Undershoot window', fmt(r.TOB * 1e3, 0) + ' mV below load line'],
      ['Undershoot reduction', fmt(r.vUsr * 1e3, 0) + ' mV trip, ' + fmt(r.tUsr * 1e6, 1) + ' \u00b5s'],
      ['Phase-drop delay', fmt(r.tDropUs, 0) + ' \u00b5s'],
      ['Datasheet add threshold', fmt(PT.peakEffCurrent(r) + 6, 1) + ' A / phase']
    ];
    $('spec').innerHTML = rows.map((x) => '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td></tr>').join('');
    const nCal = sp.cal.length, nTest = sp.test.length;
    const ms = (data.durationUs / 1000).toFixed(0);
    const testEv = sp.test.reduce((a, t) => a + PT.extractEvents(t).length, 0);
    $('dataNote').innerHTML = 'Calibration: ' + nCal + ' traces (' + ms + ' ms each), ' + fmt(calEv.length) + ' load steps. Held out: ' + nTest +
      ' traces, ' + fmt(testEv) + ' steps. Synthetic LLM training, LLM inference and HPC core-current traces.';
    $('alphaSeg').innerHTML = ALPHAS.map((a) => '<button data-a="' + a + '"' + (a === S.alpha ? ' class="on"' : '') + '>' + pct(a, a < 0.01 ? 1 : 0) + '</button>').join('');
    $('alphaSeg').onclick = (e) => { const a = +e.target.getAttribute('data-a'); if (a && a !== S.alpha) { S.alpha = a; [...$('alphaSeg').children].forEach((b) => b.classList.toggle('on', +b.dataset.a === a)); update(); } };
    $('traceSel').innerHTML = sp.test.map((t, i) => '<option value="' + i + '">' + t.label + ', run ' + (t.seed % 100 - 2) + '</option>').join('');
    $('traceSel').onchange = () => { S.traceIdx = +$('traceSel').value; S.focusT = null; renderTimeline(); };
  }

  function renderKpis(C) {
    const all = S.all, ds = S.ds, fl = C.res;
    const saving = all.avgLossW - ds.avgLossW;
    const kept = (all.avgLossW - fl.avgLossW) / saving;
    let matched = '<span class="busy">uniform-threshold comparison running\u2026</span>';
    if (S.sweep) {
      const m = PT.matchedStatic(S.sweep, fl.violations);
      matched = m ? 'A uniform ' + fmt(m.iTh, 0) + ' A/phase threshold with no more violations keeps ' + pct((all.avgLossW - m.avgLossW) / saving) + '.' : 'No uniform threshold reaches this violation count.';
    }
    $('kpis').innerHTML = [
      ['Out-of-spec load steps (held out)', '<span class="bad">' + fmt(ds.violations) + '</span><span class="arr">\u2192</span><span class="good">' + fmt(fl.violations) + '</span>',
        'of ' + fmt(fl.events) + ' steps: datasheet thresholds \u2192 Phase Tuner at \u03b1 = ' + pct(S.alpha, S.alpha < 0.01 ? 1 : 0) + '.'],
      ['Shedding savings kept', pct(kept), 'Datasheet shedding saves ' + fmt(saving, 2) + ' W vs. all phases on. ' + matched],
      ['Average VR loss', fmt(fl.avgLossW, 2) + ' W', 'All phases on ' + fmt(all.avgLossW, 2) + ' W, datasheet ' + fmt(ds.avgLossW, 2) + ' W; efficiency ' + pct(fl.efficiency, 2) + '.'],
      ['Worst undershoot margin', mv(fl.worst.margin), 'Datasheet ' + mv(ds.worst.margin) + ', all on ' + mv(all.worst.margin) + ' against the ' + fmt(r.TOB * 1e3, 0) + ' mV window.']
    ].map((k) => '<div class="kpi"><div class="k">' + k[0] + '</div><div class="v">' + k[1] + '</div><div class="s">' + k[2] + '</div></div>').join('');
  }

  function stepPath(fn, X, Y, x0, x1) {
    const pts = [];
    let prev = null;
    for (let I = x0; I <= x1; I += 1) {
      const n = fn(I);
      if (prev !== null && n !== prev) pts.push([X(I), Y(prev)]);
      pts.push([X(I), Y(n)]);
      prev = n;
    }
    return pts;
  }

  function renderFloor(C) {
    const svg = $('chFloor');
    const f = frame(svg, { x: [0, 1000], y: [0, 17], xt: [0, 200, 400, 600, 800, 1000], yt: [0, 4, 8, 12, 16], xl: 'Load before step (A)', yl: 'Active phases' });
    const g = el('g', {}, svg);
    const rng = PT.mulberry32(5);
    const step = Math.max(1, Math.floor(S.scored.length / 2200));
    for (let i = 0; i < S.scored.length; i += step) {
      const e = S.scored[i];
      if (e.nReq > r.N) continue;
      el('circle', { cx: f.X(e.I0), cy: f.Y(e.nReq + (rng() - 0.5) * 0.55), r: 1.6, fill: 'rgba(46,125,50,.28)' }, g);
    }
    line(svg, stepPath(pDs.dropTarget, f.X, f.Y, 0, 1000), { stroke: '#8a8a8a', 'stroke-width': 2.2, 'stroke-dasharray': '6 4' });
    line(svg, stepPath(C.pol.dropTarget, f.X, f.Y, 0, 1000), { stroke: '#00913a', 'stroke-width': 3 });
    for (const x of PT.BIN_EDGES) el('line', { x1: f.X(x), x2: f.X(x), y1: f.Y(0), y2: f.Y(17), stroke: '#f0f0f0' }, svg).parentNode.insertBefore(svg.lastChild, svg.childNodes[1]);
  }

  function renderFront() {
    const svg = $('chFront');
    const pts = [];
    if (S.sweep) for (const x of S.sweep) pts.push([x.violations, x.avgLossW]);
    pts.push([S.ds.violations, S.ds.avgLossW], [S.all.violations, S.all.avgLossW]);
    const tun = ALPHAS.filter((a) => S.cache[a]).map((a) => [S.cache[a].res.violations, S.cache[a].res.avgLossW, a]);
    const ys = pts.concat(tun).map((p) => p[1]);
    const y0 = Math.floor(Math.min(...ys) * 2) / 2 - 0.25, y1 = Math.ceil(Math.max(...ys) * 2) / 2 + 0.25;
    const vmax = Math.max(...pts.map((p) => p[0]));
    const xtv = [0, 1, 5, 10, 25, 50, 100, 200, 400].filter((v) => v <= vmax * 1.2 + 1);
    const yt = []; for (let v = Math.ceil(y0 * 2) / 2; v <= y1; v += 0.5) yt.push(v);
    const sq = (v) => Math.sqrt(v);
    const f0 = frame(svg, { x: [-0.25, sq(Math.max(vmax * 1.12, 12))], y: [y0, y1], xt: xtv.map(sq), xf: (v) => fmt(v * v), yt, yf: (v) => v.toFixed(1), xl: 'Out-of-spec held-out steps (square-root scale)', yl: 'Average VR loss (W)' });
    const f = { X: (v) => f0.X(sq(v)), Y: f0.Y };
    if (S.sweep) {
      const sw = S.sweep.slice().sort((a, b) => a.iTh - b.iTh).concat([{ iTh: PT.peakEffCurrent(r) + 6, violations: S.ds.violations, avgLossW: S.ds.avgLossW }]);
      line(svg, sw.map((x) => [f.X(x.violations), f.Y(x.avgLossW)]), { stroke: '#9e9e9e', 'stroke-width': 1.8 });
      for (const x of sw) {
        el('circle', { cx: f.X(x.violations), cy: f.Y(x.avgLossW), r: 3, fill: '#fff', stroke: '#9e9e9e', 'stroke-width': 1.5 }, svg);
        if ([10, 14, 20, 30, 40].includes(x.iTh)) { const t = el('text', { x: f.X(x.violations) + 6, y: f.Y(x.avgLossW) - 6, class: 'axt', style: 'font-size:10.5px;fill:#8a8a8a' }, svg); t.textContent = x.iTh + ' A'; }
      }
    }
    const tn = tun.slice().sort((a, b) => a[2] - b[2]);
    line(svg, tn.map((p) => [f.X(p[0]), f.Y(p[1])]), { stroke: '#00913a', 'stroke-width': 2.6 });
    for (const p of tn) {
      const on = p[2] === S.alpha;
      el('circle', { cx: f.X(p[0]), cy: f.Y(p[1]), r: on ? 5.5 : 4, fill: on ? '#00913a' : '#fff', stroke: '#00913a', 'stroke-width': 2 }, svg);
      if (on) { const t = el('text', { x: f.X(p[0]) + 2, y: f.Y(p[1]) + 20, 'text-anchor': 'start', class: 'axt', style: 'font-size:11px;fill:#2e7d32;font-weight:600' }, svg); t.textContent = 'Phase Tuner, \u03b1 ' + pct(p[2], p[2] < 0.01 ? 1 : 0); }
    }
    const lab = (x, y, s, dx, dy) => { el('circle', { cx: f.X(x), cy: f.Y(y), r: 4.5, fill: '#252525' }, svg); const t = el('text', { x: f.X(x) + dx, y: f.Y(y) + dy, class: 'axt', style: 'font-size:11px;fill:#252525', 'text-anchor': dx < 0 ? 'end' : 'start' }, svg); t.textContent = s; };
    lab(S.all.violations, S.all.avgLossW, 'All phases on', 8, -6);
    lab(S.ds.violations, S.ds.avgLossW, 'Datasheet', -8, -8);
  }

  function findEvent(list, t) { return list.find((e) => Math.abs(e.t - t) < 1e-6); }

  function renderScope(C) {
    const w = S.ds.worst;
    const tr = sp.test.find((t) => t.profile === w.profile && t.seed === w.seed);
    const runF = PT.runTrace(r, tr, C.pol, { events: true });
    const evF = findEvent(runF.eventsList, w.t);
    const ev = { I0: w.I0, I1: w.I1, slew: w.slew };
    const a = PT.simulateStep(r, ev, w.nBefore, pDs, { wave: true, wavePoints: 600, tailUs: 3 });
    const b = PT.simulateStep(r, ev, evF.nBefore, C.pol, { wave: true, wavePoints: 600, tailUs: 3 });
    const vMin = r.Vref - r.RLL * w.I1 - r.TOB;
    const vs = a.wave.concat(b.wave).map((p) => p[1] * 1e3);
    const y0 = Math.floor((Math.min(...vs, vMin * 1e3) - 6) / 10) * 10, y1 = Math.ceil((Math.max(...vs) + 4) / 10) * 10;
    const tEnd = a.wave[a.wave.length - 1][0];
    const yt = []; for (let v = y0; v <= y1; v += 20) yt.push(v);
    const xt = []; for (let v = 0; v <= tEnd; v += 0.5) xt.push(+v.toFixed(1));
    const f = frame(svg0(), { x: [0, tEnd], y: [y0, y1], xt, yt, xl: 'Time after step starts (\u00b5s)', yl: 'V\u2092\u1d64\u209c (mV)' });
    function svg0() { return $('chScope'); }
    const svg = $('chScope');
    // load current as light area on its own scale
    const iMax = w.I1 * 1.15;
    const area = a.wave.map((p) => [f.X(p[0]), f.Y(y0 + (p[3] / iMax) * (y1 - y0) * 0.38)]);
    el('path', { d: 'M' + f.X(0) + ',' + f.Y(y0) + 'L' + area.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'L' + f.X(tEnd) + ',' + f.Y(y0) + 'Z', fill: '#f1f1f1' }, svg);
    line(svg, [[f.X(0), f.Y(vMin * 1e3)], [f.X(tEnd), f.Y(vMin * 1e3)]], { stroke: '#c62828', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' });
    line(svg, a.wave.map((p) => [f.X(p[0]), f.Y(p[1] * 1e3)]), { stroke: '#9e9e9e', 'stroke-width': 2.2 });
    line(svg, b.wave.map((p) => [f.X(p[0]), f.Y(p[1] * 1e3)]), { stroke: '#00913a', 'stroke-width': 2.6 });
    const t1 = el('text', { x: f.X(tEnd) - 4, y: f.Y(vMin * 1e3) + 14, 'text-anchor': 'end', class: 'axt', style: 'fill:#c62828;font-size:10.5px' }, svg); t1.textContent = 'window ' + fmt(vMin * 1e3, 1) + ' mV';
    const t2 = el('text', { x: f.X(tEnd) - 4, y: f.Y(y0) - 6, 'text-anchor': 'end', class: 'axt', style: 'fill:#9a9a9a;font-size:10.5px' }, svg); t2.textContent = 'load current (shaded) ' + fmt(w.I0) + ' \u2192 ' + fmt(w.I1) + ' A';
    $('scopeCap').innerHTML = tr.label + ', ' + fmt(w.I0) + ' \u2192 ' + fmt(w.I1) + ' A at ' + fmt(w.slew) + ' A/\u00b5s. Datasheet thresholds had ' + w.nBefore +
      ' phases on and fell ' + fmt(-a.margin * 1e3, 1) + ' mV below the window; Phase Tuner had ' + evF.nBefore + ' on' + (b.margin < 0 ? ' and still missed by ' + fmt(-b.margin * 1e3, 1) + ' mV (one of its ' + C.res.violations + ' held-out misses).' : ' and stayed ' + fmt(b.margin * 1e3, 1) + ' mV inside it.');
  }

  function renderTimeline() {
    const C = S.cache[S.alpha];
    const tr = sp.test[S.traceIdx];
    const rd = PT.runTrace(r, tr, pDs, { timeline: true, events: true });
    const rf = PT.runTrace(r, tr, C.pol, { timeline: true, events: true });
    let center = S.focusT;
    if (center == null) {
      const bad = rd.eventsList.filter((e) => e.margin < 0);
      center = bad.length ? bad.reduce((a, b) => (b.margin < a.margin ? b : a)).t : tr.durationUs / 2;
    }
    const span = 3000;
    const t0 = Math.max(0, Math.min(tr.durationUs - span, center - span / 2)), t1 = t0 + span;
    const svg = $('chTl');
    const f = frame(svg, { x: [t0, t1], y: [0, 1100], xt: [0, 1, 2, 3].map((k) => t0 + k * 1000), xf: (v) => (v / 1000).toFixed(1), yt: [0, 250, 500, 750, 1000], xl: 'Time in trace (ms)', yl: 'Load (A)', m: { r: 40 } });
    // load current area
    const segs = tr.segments; const pts = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i].t, b = segs[i + 1].t;
      if (b < t0 || a > t1) continue;
      pts.push([f.X(Math.max(a, t0)), f.Y(segs[i].I)], [f.X(Math.min(b, t1)), f.Y(segs[i].I)]);
    }
    el('path', { d: 'M' + pts[0][0] + ',' + f.Y(0) + 'L' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'L' + pts[pts.length - 1][0] + ',' + f.Y(0) + 'Z', fill: '#e2e2e2' }, svg);
    // phases on right axis 0..16
    const PY = (n) => f.Y(n / 16 * 1000);
    const g = el('g', { class: 'ax' }, svg);
    for (const n of [0, 4, 8, 12, 16]) { const t = el('text', { x: f.W - f.m.r + 7, y: PY(n) + 3.5 }, g); t.textContent = n; }
    const yl = el('text', { x: f.W - 8, y: 140, 'text-anchor': 'middle', class: 'axt', transform: 'rotate(90 ' + (f.W - 8) + ' 140)' }, svg); yl.textContent = 'Active phases';
    const stepLine = (tl, style) => {
      const p = [];
      for (let i = 0; i < tl.length; i++) {
        const t = tl[i][0], n = tl[i][2], tn = i + 1 < tl.length ? tl[i + 1][0] : tr.durationUs;
        if (tn < t0 || t > t1) continue;
        p.push([f.X(Math.max(t, t0)), PY(n)], [f.X(Math.min(tn, t1)), PY(n)]);
      }
      line(svg, p, style);
    };
    stepLine(rd.timeline, { stroke: '#9e9e9e', 'stroke-width': 1.8 });
    stepLine(rf.timeline, { stroke: '#00913a', 'stroke-width': 2.4 });
    let nd = 0, nf = 0;
    for (const e of rd.eventsList) if (e.margin < 0 && e.t >= t0 && e.t <= t1) { nd++; el('circle', { cx: f.X(e.t), cy: PY(e.nBefore), r: 4.5, fill: '#c62828', stroke: '#fff', 'stroke-width': 1.2 }, svg); }
    for (const e of rf.eventsList) if (e.margin < 0 && e.t >= t0 && e.t <= t1) { nf++; el('circle', { cx: f.X(e.t), cy: PY(e.nBefore), r: 4.5, fill: '#c62828', stroke: '#00913a', 'stroke-width': 2 }, svg); }
    $('tlCap').innerHTML = tr.label + ', ' + fmt(t0 / 1000, 1) + '\u2013' + fmt(t1 / 1000, 1) + ' ms. Whole trace: datasheet ' + rd.violations + ' out-of-spec of ' + fmt(rd.events) +
      ' steps, Phase Tuner ' + rf.violations + '; average loss ' + fmt(rd.avgLossW, 2) + ' W vs ' + fmt(rf.avgLossW, 2) + ' W.';
  }

  function renderTable(C) {
    const info = C.floor.info;
    const rows = info.map((b) => {
      const lo = b.lo, hi = b.hi;
      const dsLo = pDs.dropTarget(lo), dsHi = pDs.dropTarget(Math.min(hi, 1000) - 1);
      const band = hi === Infinity ? '\u2265 ' + fmt(lo) + ' A' : fmt(lo) + '\u2013' + fmt(hi) + ' A';
      const viol = S.scored.filter((e) => e.I0 >= lo && e.I0 < hi && e.nReq > b.floor).length;
      const bind = b.floor > dsLo;
      return '<tr' + (bind ? ' class="bind"' : '') + '><td>' + band + '</td><td>' + fmt(b.m) + '</td><td>' + (dsLo === dsHi ? dsLo : dsLo + '\u2013' + dsHi) +
        '</td><td class="fl">' + b.floor + '</td><td>' + (b.maxReq == null ? '\u2013' : b.maxReq) + '</td><td>' + fmt(viol) + ' (' + pct(b.m ? viol / b.m : 0, 2) + ')</td></tr>';
    }).join('');
    $('tbl').innerHTML = '<tr><th>Load before step</th><th>Calibration steps</th><th>Datasheet phases</th><th>Phase floor</th><th>Most phases any step needed</th><th>Calibration steps above floor</th></tr>' + rows;
    $('method').innerHTML = 'Method: each calibration step is replayed through an averaged ' + r.N + '-phase model (current loop limited by n\u00b7(V<sub>IN</sub>\u2212V<sub>OUT</sub>)/L and the per-phase current limit, current-threshold phase add after ' +
      fmt(r.tAdd * 1e6, 1) + ' \u00b5s, undershoot reduction firing all phases) to find the fewest phases that must already be on. The floor for a band is the \u2308(m+1)(1\u2212\u03b1)\u2309-th smallest of its m requirements (split conformal, per band), so a new step exchangeable with that band\u2019s calibration steps needs more than the floor with probability at most \u03b1. Held-out traces then replay the full controller, including the ' +
      fmt(r.tDropUs, 0) + ' \u00b5s drop delay. Loss per phase: ' + r.P0 + ' W + ' + r.a + '\u00b7i + ' + fmt(r.b * 1e3, 2) + ' m\u03a9\u00b7i\u00b2 (assumed).';
  }

  async function update() {
    const C = await forAlpha(S.alpha);
    renderKpis(C); renderFloor(C); renderScope(C); renderTable(C);
    if (S.traceIdx == null && Q.get('trace') != null && sp.test[+Q.get('trace')]) S.traceIdx = +Q.get('trace');
    if (S.traceIdx == null) {
      const w = S.ds.worst;
      S.traceIdx = sp.test.findIndex((t) => t.profile === w.profile && t.seed === w.seed);
      $('traceSel').value = String(S.traceIdx);
    }
    $('traceSel').value = String(S.traceIdx);
    renderTimeline();
    renderFront();
  }

  async function main() {
    renderSpec();
    S.scored = await scoreAll();
    $('frontBusy').textContent = 'Replaying held-out traces\u2026'; await tick();
    S.all = PT.runMany(r, sp.test, pAll); await tick();
    S.ds = PT.runMany(r, sp.test, pDs); await tick();
    await update();
    for (const a of ALPHAS) { await forAlpha(a); }
    renderFront();
    const sweep = [];
    for (let i = 0; i < PT.STATIC_GRID.length; i++) {
      $('frontBusy').textContent = 'Uniform thresholds ' + (i + 1) + ' / ' + PT.STATIC_GRID.length;
      await tick();
      const x = PT.runMany(r, sp.test, PT.staticPolicy(r, PT.STATIC_GRID[i])); x.iTh = PT.STATIC_GRID[i];
      sweep.push(x);
    }
    S.sweep = sweep;
    $('frontBusy').textContent = '';
    renderFront(); renderKpis(S.cache[S.alpha]);
    document.body.setAttribute('data-ready', '1');
  }
  main();
})();
