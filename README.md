# Phase Tuner: workload-aware phase add/drop for Reed multiphase controllers

**Live demo:** https://mohith26.github.io/reed-semiconductor-phase-tuner/

Unofficial concept by Mohith Gajjela. Not affiliated with Reed Semiconductor. Synthetic data; every rail value is an assumption, not an RS17G22 or RS86900 specification.

## What it is

Reed's multiphase controllers (RS17G22, RS19C22, RS16K20 and others) shed phases at light load for efficiency and add them back on a current threshold, with undershoot reduction (USR) firing every phase when the output dips. Thresholds are normally set from the power stage's peak-efficiency current. That choice ignores the workload: on an AI accelerator the next load step can be 800+ A at 3,000 A/µs, and it often arrives right after a communication or data-loader stall, exactly when phases have been shed.

Phase Tuner is a design-tool page (shown on the RS17G22 product page) that takes captured core-current traces and returns a **minimum active-phase floor per load band**. Above the floor the datasheet thresholds still pick phase count for efficiency. The floor is chosen so that a load step arriving in that band undershoots the load-line window with probability at most α.

## Result on the demo data (α = 0.5%)

Held-out traces (9 traces, 9,940 load steps), computed by `node scripts/report.js`:

| Policy | Avg VR loss | Out-of-spec steps | Worst margin |
|---|---|---|---|
| All 16 phases on | 42.89 W | 0 | +7.2 mV |
| Datasheet-style shedding (39.6 A peak-eff. + 6 A) | 40.71 W | 190 | -86.8 mV |
| **Phase Tuner floors** | **41.54 W** | **3** | -10.2 mV |
| Best uniform threshold with no more than 3 misses (14 A/phase) | 42.15 W | 2 | |

Phase Tuner keeps 62% of the shedding saving (2.18 W) while removing 187 of 190 out-of-spec steps. A uniform lower threshold that gets to the same miss count keeps 34%. That baseline is picked with the held-out labels, which favours it.

## How it works

1. **Transient model** (`simulateStep`). Averaged 16-phase buck: total inductor current follows an AVP current command `(Vref - Vout)/RLL` with capacitor-current damping, limited by `n(Vin - Vout)/L` rising, `-n·Vout/L` falling, and the per-phase current limit. Phases are added on the policy's current threshold after 0.5 µs, and all phases fire 0.5 µs after a USR trip (12 mV below the load line). A load-current observer clamps the command during recovery so the current does not wind up. Margin = minimum of `Vout - (Vref - RLL·I1 - 25 mV)`.
2. **Score each calibration step** (`requiredPhases`). For every rising edge in the calibration traces, the smallest pre-step phase count n such that every count in [n, 16] keeps the step in spec. (Margin is almost but not exactly monotone in n because USR timing shifts, so the search scans down from 16.)
3. **Calibrate the floor** (`calibrateFloor`). Split conformal, per load band (Mondrian): with m scores in a band, the floor is the ⌈(m+1)(1-α)⌉-th smallest. For a new step exchangeable with that band's calibration steps, P(required > floor) ≤ α. Bands with too few steps fall back to all phases.
4. **Replay** (`runTrace`). Held-out traces run through the full controller logic: 50 µs phase-drop delay with 10 A hysteresis, adds on every rising edge via the transient model, loss `n·P(I/n) + (16-n)·Poff` with `P(i) = 1.10 W + 0.012·i + 0.70 mΩ·i²`.

The page computes all of this in the browser from `data/traces.js` (about 10k calibration steps scored in under a second), then sweeps 17 uniform thresholds and four α values for the frontier chart.

## Data

`scripts/gen-data.js` writes 18 synthetic core-current traces (40 ms each): LLM training (compute / all-reduce / mid / data-loader stall), LLM inference (idle / decode / prefill) and HPC (GEMM / halo / IO), as Markov chains over kernel phases with log-normal dwell times, per-kernel jitter and log-normal edge slew (150 to 3,000 A/µs). Runs 0-2 of each profile calibrate, runs 3-5 are held out.

## Tests

```
node --test test/phasetuner.test.js   # 14 tests
node scripts/report.js 0.005          # prints every number above
```

Tests cover steady state and settling on the load line, slew and current limits, the required-phase definition against a brute-force scan, tail-length independence of the undershoot minimum, no recovery overshoot, a 2 ns discretization check (10 ns step within 2.5 mV), the conformal order statistic and its empirical coverage, determinism of the committed data, energy bookkeeping and the drop delay, and that the floor policy never runs fewer phases than the datasheet policy.

## Limitations (honest)

- Synthetic traces and an assumed rail. The loss model, Cout, ESR, USR latency and window are illustrative; a real run would use measured RS86900 efficiency curves and the board's own transient data.
- Averaged model, discrete inductors. No TLVR (which changes the effective transient inductance), no per-phase current imbalance, no ripple, no PCB/socket impedance. Recovery and overshoot are not modelled faithfully; only the undershoot minimum is used.
- The guarantee is per step and marginal within a band, under exchangeability between calibration and deployment steps. A different workload mix needs recalibration, and α resolution is limited by calibration size (α = 0.2% needs about 500 steps per band; two bands fall back to all phases here).
- Floors are expressed as "minimum active phases per load band"; mapping them to RS17G22 PMBus/MTP registers needs the full register map, which is not public.
- The 3 remaining held-out misses (worst -10.2 mV) are within what α = 0.5% allows but are still misses.

## Novelty note

Reed's public product pages and newsroom describe automatic phase add/drop with programmable thresholds, thermal balance and programmable undershoot/overshoot reduction, but no design tool that sets them from a workload. Competitor controllers (TI TPS536xx, MPS MP29xx, Infineon XDPE) set add/drop thresholds from the per-phase peak-efficiency point plus an offset, with fast phase-adding for USR. Google holds a patent (US 12,547,236, "Workload-aware voltage regulator tuning") on reconfiguring load line, setpoint or phase shedding at runtime from workload information sent by the processor; Phase Tuner is different: it is a design-time calibration from captured traces with a stated per-step risk, using only the controller's existing add/drop and USR, with no processor handshake.
