/*
 * Workload-aware phase tuner (core module).
 *
 * Picks per-load-level phase floors for a multiphase buck controller's
 * automatic phase add/drop so that, on a captured accelerator current trace,
 * a load step that arrives while phases are shed undershoots the load-line
 * window with probability at most alpha (split conformal, per load bin),
 * while keeping as much of the light-load saving of phase shedding as possible.
 *
 * Works in the browser (window.PhaseTuner) and in Node (module.exports).
 * Unofficial concept by Mohith Gajjela. Not affiliated with Reed Semiconductor.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhaseTuner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- rail ---
  // Assumed GPU core rail: 16 phases of a 45 A TDC / 90 A peak smart power
  // stage on a 12 V bus, 0.80 V VID, 50 uOhm DC load line. Every value is an
  // assumption that a designer would replace with the real board.
  const DEFAULT_RAIL = {
    N: 16,             // phases available on the rail
    Vin: 12.0,         // V
    Vref: 0.80,        // V (VID)
    RLL: 50e-6,        // Ohm, DC load line
    L: 100e-9,         // H per phase (discrete inductors, no TLVR)
    C: 3.0e-3,         // F, effective output capacitance
    ESR: 25e-6,        // Ohm, effective ESR of the output bank
    k: 2 * Math.PI * 300e3, // 1/s, averaged current-loop gain (COT is fast)
    Kd: 1.0,           // capacitor-current damping in the current command (x C)
    Iod: 120,          // A, recharge overdrive above the observed load current
    tauObs: 50e-9,     // s, filter on the load-current observer
    IpkPh: 90,         // A, per-phase cycle-by-cycle current limit
    TOB: 0.025,        // V, undershoot window below the final load-line point
    vUsr: 0.012,       // V, undershoot-reduction trip (error vs. load line)
    tUsr: 0.5e-6,      // s, USR trip to shed phases switching (detect + wake)
    tAdd: 0.5e-6,      // s, latency of a current-threshold phase add
    tDropUs: 50,       // us, phase-drop delay (load must stay low this long)
    // Per-phase loss P(i) = P0 + a*i + b*i^2 (W), shaped like a 12 V to 0.8 V
    // smart power stage at 1 MHz including inductor DCR. Shed phase: Poff.
    P0: 1.10, a: 0.012, b: 0.70e-3, Poff: 0.03,
    dt: 10e-9,         // s, transient integration step
    nMin: 1,
    hyst: 10           // A, drop hysteresis
  };

  function rail(over) { return Object.assign({}, DEFAULT_RAIL, over || {}); }

  // ----------------------------------------------------------------- rng ---
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function lognormal(rng, median, sigma) { return median * Math.exp(sigma * gauss(rng)); }

  // ---------------------------------------------------------- loss model ---
  function phaseLoss(r, i) { return r.P0 + r.a * i + r.b * i * i; }
  function railLoss(r, I, n) {
    return n * phaseLoss(r, I / n) + (r.N - n) * r.Poff;
  }
  // Per-phase current with the lowest loss per amp (peak-efficiency point).
  function peakEffCurrent(r) { return Math.sqrt(r.P0 / r.b); }
  // Phase count with minimum total loss at load I (ignores transients).
  function lossOptimalPhases(r, I) {
    let best = r.nMin, bl = Infinity;
    for (let n = r.nMin; n <= r.N; n++) {
      if (I / n > r.IpkPh * 0.5 + 1e-9 && n < r.N) continue; // stay under TDC
      const l = railLoss(r, I, n);
      if (l < bl) { bl = l; best = n; }
    }
    return best;
  }

  // ------------------------------------------------------------ policies ---
  function clampN(r, n) { return Math.max(r.nMin, Math.min(r.N, n)); }

  // Datasheet-style shedding: add a phase when per-phase current would exceed
  // iTh; drop with hysteresis after tDrop. iTh = peak-eff point + offset.
  function staticPolicy(r, iTh, name) {
    return {
      name: name || ('static ' + iTh.toFixed(1) + ' A/phase'),
      kind: 'static',
      iTh: iTh,
      addTarget: (I) => clampN(r, Math.ceil(I / iTh - 1e-9)),
      dropTarget: (I) => clampN(r, Math.ceil((I + r.hyst) / iTh - 1e-9))
    };
  }
  function allOnPolicy(r) {
    return { name: 'all phases on', kind: 'allon', addTarget: () => r.N, dropTarget: () => r.N };
  }
  function defaultStatic(r) {
    return staticPolicy(r, peakEffCurrent(r) + 6, 'datasheet-style shedding');
  }
  // Workload-aware: datasheet thresholds, but never below the calibrated
  // floor for the current load bin.
  function floorPolicy(r, floor, name) {
    const base = defaultStatic(r);
    const f = (I) => floor.table[binIndex(floor.edges, I)];
    return {
      name: name || 'workload-aware floor',
      kind: 'floor',
      floor: floor,
      addTarget: (I) => Math.max(base.addTarget(I), f(I)),
      dropTarget: (I) => Math.max(base.dropTarget(I), f(I))
    };
  }

  // addTarget sampled per amp (exact for step-wise policies with integer
  // thresholds at 1 A resolution; cached on the policy object).
  function addTable(r, policy) {
    if (policy._tab && policy._tabN === r.N) return policy._tab;
    const max = Math.ceil(r.N * r.IpkPh) + 2;
    const t = new Int8Array(max + 1);
    for (let i = 0; i <= max; i++) t[i] = policy.addTarget(i + 0.999);
    policy._tab = t; policy._tabN = r.N;
    return t;
  }

  // --------------------------------------------------- transient simulator ---
  // Load steps from I0 to I1 at `slew` A/us with n0 phases active (and the rest
  // shed). The controller adds phases on its current threshold (policy
  // addTarget, after tAdd) and fires all phases on an undershoot-reduction trip
  // (after tUsr). Returns the worst margin to the window
  // Vmin = Vref - RLL*I1 - TOB (negative = violation).
  function simulateStep(r, ev, n0, policy, opts) {
    const o = opts || {};
    const I0 = ev.I0, I1 = ev.I1, slewAs = ev.slew * 1e6; // A/s
    const dt = r.dt;
    const tRise = Math.max(0, (I1 - I0) / slewAs);
    const tEnd = tRise + (o.tailUs != null ? o.tailUs : 3) * 1e-6;
    const vMin = r.Vref - r.RLL * I1 - r.TOB;
    const tab = addTable(r, policy);
    const tabMax = tab.length - 1;
    let IL = I0, Vc = r.Vref - r.RLL * I0, n = n0;
    let pendN = 0, pendT = Infinity, usrT = Infinity, usr = false;
    let vPrev = r.Vref - r.RLL * I0, dVf = 0;
    let minMargin = Infinity, tMin = 0;
    const wave = o.wave ? [] : null;
    const every = o.wave ? Math.max(1, Math.round((tEnd / dt) / (o.wavePoints || 400))) : 0;
    let step = 0;
    for (let t = 0; t <= tEnd; t += dt, step++) {
      const Iload = t < tRise ? I0 + slewAs * t : I1;
      const Vout = Vc + r.ESR * (IL - Iload);
      const m = Vout - vMin;
      if (m < minMargin) { minMargin = m; tMin = t; if (o.stopOnViolation && m < 0) break; }
      if (wave && step % every === 0) wave.push([t * 1e6, Vout, IL, Iload, n]);
      // phase management
      if (!usr && (r.Vref - r.RLL * IL) - Vout > r.vUsr) { usr = true; usrT = t + r.tUsr; }
      if (t >= usrT) n = r.N;
      const want = tab[IL <= 0 ? 0 : (IL >= tabMax ? tabMax : (IL | 0))];
      if (want > n && want > pendN) { if (pendN <= n) pendT = t + r.tAdd; pendN = want; }
      if (t >= pendT) { if (pendN > n) n = pendN; pendN = 0; pendT = Infinity; }
      // averaged current loop, slew-limited by active phases, current-limited
      // AVP current command with capacitor-current damping, clamped to a
      // load-current observer plus a recharge overdrive (keeps the current
      // from winding up after a deep undershoot)
      const dV = (Vout - vPrev) / dt; vPrev = Vout;
      dVf += (dV - dVf) * (dt / r.tauObs);
      const iLoadEst = IL - r.C * dVf;
      let Ides = (r.Vref - Vout) / r.RLL - r.Kd * r.C * dV;
      if (dVf > 0 && Ides > iLoadEst + r.Iod) Ides = iLoadEst + r.Iod;
      let dIL = r.k * (Ides - IL);
      const up = n * (r.Vin - Vout) / r.L, dn = -n * Vout / r.L;
      if (dIL > up) dIL = up; else if (dIL < dn) dIL = dn;
      let ILn = IL + dIL * dt;
      const cap = n * r.IpkPh;
      if (ILn > cap) ILn = cap;
      const tn = t + dt;
      const IloadN = tn < tRise ? I0 + slewAs * tn : I1;
      Vc += dt * (0.5 * (IL + ILn) - 0.5 * (Iload + IloadN)) / r.C; // trapezoid
      IL = ILn;
    }
    return { margin: minMargin, tMinUs: tMin * 1e6, nEnd: n, usr: usr, wave: wave };
  }

  // Smallest n such that the step stays in spec for every pre-step phase count
  // in [n, N] (datasheet add thresholds and USR still active). Margin is
  // almost but not exactly monotone in n (USR trip timing shifts with n), so
  // we scan down from N instead of bisecting: the result is safe for any
  // count the controller might actually have on.
  function requiredPhases(r, ev, policy) {
    const p = policy || defaultStatic(r);
    const ok = (n) => simulateStep(r, ev, n, p, { stopOnViolation: true }).margin >= 0;
    if (!ok(r.N)) return r.N + 1;           // even all phases cannot hold it
    let n = r.N;
    while (n > r.nMin && ok(n - 1)) n--;
    return n;
  }

  // -------------------------------------------------------------- traces ---
  // Synthetic accelerator core-current traces. Segments: {t (us), I (A),
  // slew (A/us) of the edge into this level}. Profiles are Markov chains over
  // kernel phases with log-normal dwell times and per-kernel jitter.
  const PROFILES = {
    training: {
      label: 'LLM training (TP=8)',
      states: {
        compute: { lvl: [700, 960], dwell: [140, 0.6], jit: 45 },
        comm:    { lvl: [190, 320], dwell: [70, 0.5], jit: 20 },
        mid:     { lvl: [380, 540], dwell: [55, 0.5], jit: 30 },
        stall:   { lvl: [95, 150],  dwell: [260, 0.7], jit: 8 }
      },
      next: {
        compute: [['comm', 0.5], ['mid', 0.25], ['stall', 0.08], ['compute', 0.17]],
        comm:    [['compute', 0.72], ['mid', 0.18], ['stall', 0.10]],
        mid:     [['compute', 0.65], ['comm', 0.25], ['stall', 0.10]],
        stall:   [['compute', 0.7], ['mid', 0.2], ['comm', 0.1]]
      },
      slew: [900, 0.55]
    },
    inference: {
      label: 'LLM inference (decode)',
      states: {
        idle:    { lvl: [110, 175], dwell: [120, 0.8], jit: 10 },
        decode:  { lvl: [420, 640], dwell: [45, 0.5], jit: 35 },
        prefill: { lvl: [760, 990], dwell: [90, 0.6], jit: 45 }
      },
      next: {
        idle:    [['decode', 0.75], ['prefill', 0.25]],
        decode:  [['idle', 0.55], ['decode', 0.25], ['prefill', 0.2]],
        prefill: [['decode', 0.6], ['idle', 0.4]]
      },
      slew: [1100, 0.5]
    },
    hpc: {
      label: 'HPC / dense GEMM',
      states: {
        gemm:  { lvl: [780, 980], dwell: [400, 0.5], jit: 40 },
        halo:  { lvl: [300, 460], dwell: [60, 0.5], jit: 25 },
        io:    { lvl: [100, 170], dwell: [180, 0.8], jit: 8 }
      },
      next: {
        gemm: [['halo', 0.7], ['io', 0.15], ['gemm', 0.15]],
        halo: [['gemm', 0.85], ['io', 0.15]],
        io:   [['gemm', 0.8], ['halo', 0.2]]
      },
      slew: [700, 0.5]
    }
  };

  function pick(rng, list) {
    let u = rng(), acc = 0;
    for (const [k, p] of list) { acc += p; if (u <= acc) return k; }
    return list[list.length - 1][0];
  }

  function generateTrace(profileName, seed, durationUs) {
    const P = PROFILES[profileName];
    const rng = mulberry32(seed);
    const keys = Object.keys(P.states);
    let st = keys[0], t = 0, I = P.states[st].lvl[0];
    const seg = [{ t: 0, I: Math.round(I), slew: 0 }];
    const slewOf = () => Math.min(3000, Math.max(150, lognormal(rng, P.slew[0], P.slew[1])));
    while (t < durationUs) {
      st = pick(rng, P.next[st]);
      const S = P.states[st];
      const base = S.lvl[0] + (S.lvl[1] - S.lvl[0]) * rng();
      let dwell = Math.max(4, lognormal(rng, S.dwell[0], S.dwell[1]));
      // kernel-level jitter inside the phase: sub-steps every 8-30 us
      let first = true;
      while (dwell > 0) {
        const d = Math.min(dwell, 8 + 22 * rng());
        const lvl = Math.max(60, base + (first ? 0 : S.jit * gauss(rng)));
        seg.push({ t: +t.toFixed(3), I: Math.round(lvl), slew: Math.round(slewOf()) });
        t += d; dwell -= d; first = false;
      }
    }
    seg.push({ t: +t.toFixed(3), I: seg[seg.length - 1].I, slew: 0, end: true });
    return { profile: profileName, label: P.label, seed: seed, durationUs: t, segments: seg };
  }

  // Rising edges of a trace = the step events that can undershoot.
  function extractEvents(trace) {
    const s = trace.segments, out = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].end) break;
      if (s[i].I > s[i - 1].I) {
        out.push({ I0: s[i - 1].I, I1: s[i].I, slew: s[i].slew, t: s[i].t,
          dwellUs: s[i].t - s[i - 1].t, profile: trace.profile, seed: trace.seed });
      }
    }
    return out;
  }

  // ------------------------------------------------- conformal calibration ---
  function binIndex(edges, I) {
    let b = 0;
    while (b < edges.length && I >= edges[b]) b++;
    return b; // 0 .. edges.length
  }

  // Split-conformal (Mondrian per pre-step load bin) upper quantile of the
  // required phase count. With m calibration scores in a bin, the floor is the
  // ceil((m+1)(1-alpha))-th smallest score; if that exceeds m, all phases.
  // For an exchangeable new step in the bin: P(required > floor) <= alpha.
  function calibrateFloor(r, scoredEvents, alpha, edges) {
    const nb = edges.length + 1;
    const bins = Array.from({ length: nb }, () => []);
    for (const e of scoredEvents) bins[binIndex(edges, e.I0)].push(e.nReq);
    const table = [], info = [];
    for (let b = 0; b < nb; b++) {
      const s = bins[b].slice().sort((x, y) => x - y);
      const m = s.length;
      const k = Math.ceil((m + 1) * (1 - alpha));
      let f = (m === 0 || k > m) ? r.N : Math.min(r.N, s[k - 1]);
      f = Math.max(r.nMin, f);
      table.push(f);
      info.push({ bin: b, lo: b === 0 ? 0 : edges[b - 1], hi: b < edges.length ? edges[b] : Infinity,
        m: m, k: k, floor: f, maxReq: m ? s[m - 1] : null,
        medianReq: m ? s[Math.floor((m - 1) / 2)] : null });
    }
    return { alpha: alpha, edges: edges, table: table, info: info };
  }

  function scoreEvents(r, events, policy) {
    const p = policy || defaultStatic(r);
    return events.map((e) => Object.assign({}, e, { nReq: requiredPhases(r, e, p) }));
  }

  // ------------------------------------------------------- trace replay ---
  // Replays a trace under a policy: phase drops after tDrop at the policy's
  // drop target, adds via the transient simulator on every rising edge.
  // Returns energy, loss, violations and a phase-count timeline.
  function runTrace(r, trace, policy, opts) {
    const o = opts || {};
    const s = trace.segments;
    let n = r.N, lowSince = null;
    let lossJ = 0, outJ = 0, violations = 0, events = 0, worst = null;
    const timeline = o.timeline ? [] : null;
    const evOut = o.events ? [] : null;
    const addSeg = (I, dUs, nn) => {
      if (dUs <= 0) return;
      const d = dUs * 1e-6;
      lossJ += d * railLoss(r, I, nn);
      outJ += d * (r.Vref - r.RLL * I) * I;
    };
    for (let i = 0; i < s.length - 1; i++) {
      const I = s[i].I, t0 = s[i].t, d = s[i + 1].t - t0;
      if (i > 0 && I > s[i - 1].I) {
        const ev = { I0: s[i - 1].I, I1: I, slew: s[i].slew };
        const res = simulateStep(r, ev, n, policy);
        events++;
        if (res.margin < 0) violations++;
        if (!worst || res.margin < worst.margin) worst = Object.assign({ t: t0, nBefore: n }, ev, { margin: res.margin });
        if (evOut) evOut.push({ t: t0, I0: ev.I0, I1: I, slew: ev.slew, nBefore: n, margin: res.margin });
        n = Math.max(res.nEnd, policy.addTarget(I));
        lowSince = null;
      } else if (policy.addTarget(I) > n) {
        n = policy.addTarget(I);
      }
      if (timeline) timeline.push([t0, I, n]);
      const target = policy.dropTarget(I);
      if (target < n) {
        if (lowSince === null) lowSince = t0;
        const tDrop = lowSince + r.tDropUs;
        if (tDrop < t0 + d) {
          addSeg(I, Math.max(0, tDrop - t0), n);
          n = target;
          if (timeline) timeline.push([Math.max(t0, tDrop), I, n]);
          addSeg(I, t0 + d - Math.max(t0, tDrop), n);
          lowSince = null;
          continue;
        }
      } else {
        lowSince = null;
      }
      addSeg(I, d, n);
    }
    return { policy: policy.name, lossJ, outJ, violations, events, worst,
      durationUs: trace.durationUs, avgLossW: lossJ / (trace.durationUs * 1e-6),
      timeline, eventsList: evOut };
  }

  function runMany(r, traces, policy) {
    const agg = { policy: policy.name, lossJ: 0, outJ: 0, violations: 0, events: 0, durationUs: 0, worst: null };
    for (const tr of traces) {
      const x = runTrace(r, tr, policy);
      agg.lossJ += x.lossJ; agg.outJ += x.outJ; agg.violations += x.violations;
      agg.events += x.events; agg.durationUs += x.durationUs;
      if (x.worst && (!agg.worst || x.worst.margin < agg.worst.margin)) agg.worst = Object.assign({ profile: tr.profile, seed: tr.seed }, x.worst);
    }
    agg.avgLossW = agg.lossJ / (agg.durationUs * 1e-6);
    agg.efficiency = agg.outJ / (agg.outJ + agg.lossJ);
    agg.violationRate = agg.events ? agg.violations / agg.events : 0;
    return agg;
  }

  // Interpolate the loss a static-threshold sweep needs to reach a given
  // violation rate (sweep sorted by iTh; violations non-decreasing in iTh).
  function staticLossAtRate(sweep, rate) {
    const pts = sweep.slice().sort((a, b) => a.iTh - b.iTh);
    let best = null;
    for (const p of pts) if (p.violationRate <= rate + 1e-12) best = p; // most aggressive that still meets it
    return best;
  }

  // ------------------------------------------------------------ analysis ---
  const BIN_EDGES = [150, 250, 350, 450, 550, 650, 750, 850];
  const STATIC_GRID = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42];

  function fromCompact(t) {
    return { profile: t.profile, label: t.label, seed: t.seed, split: t.split,
      durationUs: t.durationUs,
      segments: t.seg.map((x, i) => (i === t.seg.length - 1 ? { t: x[0], I: x[1], slew: x[2], end: true } : { t: x[0], I: x[1], slew: x[2] })) };
  }
  function splitTraces(data) {
    const all = data.traces.map(fromCompact);
    return { cal: all.filter((t) => t.split === 'cal'), test: all.filter((t) => t.split === 'test') };
  }

  // Core pipeline shared by the page and scripts/report.js.
  function analyze(r, data, alpha, scored) {
    const sp = splitTraces(data);
    const calEv = sp.cal.flatMap(extractEvents);
    const sc = scored || scoreEvents(r, calEv);
    const floor = calibrateFloor(r, sc, alpha, BIN_EDGES);
    const pAll = allOnPolicy(r), pDs = defaultStatic(r), pFl = floorPolicy(r, floor, 'calibrated floor');
    const all = runMany(r, sp.test, pAll), ds = runMany(r, sp.test, pDs), fl = runMany(r, sp.test, pFl);
    const saving = all.avgLossW - ds.avgLossW;
    return { split: sp, calEvents: calEv, scored: sc, floor, policies: { all: pAll, ds: pDs, fl: pFl },
      all, ds, fl, saving, keptFloor: (all.avgLossW - fl.avgLossW) / saving };
  }

  // Uniform-threshold sweep on held-out traces, and the best one that has no
  // more held-out violations than `maxViol` (favours the baseline: it is
  // chosen with test labels).
  function staticSweep(r, testTraces, grid) {
    return (grid || STATIC_GRID).map((iTh) => {
      const x = runMany(r, testTraces, staticPolicy(r, iTh));
      x.iTh = iTh; return x;
    });
  }
  function matchedStatic(sweep, maxViol) {
    let best = null;
    for (const x of sweep) if (x.violations <= maxViol && (!best || x.avgLossW < best.avgLossW)) best = x;
    return best;
  }

  return {
    BIN_EDGES, STATIC_GRID, fromCompact, splitTraces, analyze, staticSweep, matchedStatic, addTable,
    DEFAULT_RAIL, rail, mulberry32, gauss, lognormal,
    phaseLoss, railLoss, peakEffCurrent, lossOptimalPhases,
    staticPolicy, allOnPolicy, defaultStatic, floorPolicy,
    simulateStep, requiredPhases, PROFILES, generateTrace, extractEvents,
    binIndex, calibrateFloor, scoreEvents, runTrace, runMany, staticLossAtRate
  };
});
