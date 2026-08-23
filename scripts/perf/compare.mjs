/*
  Turning a run into a pass or a fail.

  Two independent checks, for two different questions:

  - **Did anything get more expensive than it was?** `drawCostMs` p50 against
    the committed baseline. This catches regressions.
  - **Is anything over the budget it was given?** Each per-section `perfCost`
    p90 against `PERF_BUDGET_MS`. This catches a layer that was always too
    expensive, which a baseline comparison never would — the baseline would
    simply have enshrined it.

  The budgets are read out of renderer.js rather than restated here. A copy
  would drift the first time a budget changed, and then the harness would be
  enforcing a number nobody believes.
*/

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

export const BASELINE_PATH = join(HERE, 'baseline.json');

/*
  How much worse than baseline counts as a regression.

  The band is measured, not guessed. Three back-to-back runs of the same
  scenarios on this hardware (0.43.0, dev build) gave:

      full/liquid       1.40  1.50  1.48     spread  7%
      full/concert      2.00  2.01  1.75     spread 15%
      full/ghost        0.20  0.20  0.20     spread  0%
      full/liquid+lite  1.08  0.99  1.00     spread  9%
      full/milkdrop     0.42  0.45  0.43     spread  7%

  Worst case ~15%, so 25% sits clear of the measurement's own noise without
  being so loose that a real regression hides inside it. Worth contrasting with
  `frameIntervalMs` over those same three runs — 37 to 57ms for identical work.
  That is why one of these is asserted on and the other is not.

  Both conditions have to hold. The ratio alone would flag ghost, whose whole
  backdrop costs 0.2ms, for a 0.05ms wobble; the floor alone would miss a real
  doubling of a cheap layer.
*/
const REGRESSION_RATIO = 1.25;
const REGRESSION_FLOOR_MS = 0.3;

/**
 * Read `PERF_BUDGET_MS` out of renderer.js.
 *
 * @returns {Record<string, number>}
 */
export function readBudgets() {
  const src = readFileSync(join(REPO_ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
  const match = src.match(/const PERF_BUDGET_MS = \{([^}]*)\}/);
  if (!match) {
    throw new Error(
      'cannot find PERF_BUDGET_MS in src/renderer/renderer.js — it moved or changed shape. ' +
        'Fix this parse rather than hardcoding the budgets here; a second copy of them will drift.'
    );
  }
  const budgets = {};
  for (const [, key, value] of match[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) budgets[key] = Number(value);
  if (!Object.keys(budgets).length) throw new Error('PERF_BUDGET_MS parsed as empty — check the regex in compare.mjs');
  return budgets;
}

/**
 * Compare a run against the committed baseline.
 *
 * @param {object} run Output of the harness.
 * @returns {{rows: object[], failures: string[], notes: string[]}}
 */
export function compareToBaseline(run) {
  const budgets = readBudgets();
  const failures = [];
  const notes = [];
  const rows = [];

  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    notes.push('No baseline.json yet — recording only. Create one with --baseline once the numbers look sane.');
  }

  /*
    A dev build's Rust is unoptimised and its frontend is served from a dev
    server. Comparing one against a release baseline would produce a confident
    number about nothing at all, so refuse rather than caveat.
  */
  if (baseline && baseline.build !== run.build) {
    notes.push(
      `Baseline is a "${baseline.build}" build and this run is "${run.build}" — not comparing. ` +
        'Record a baseline per build type.'
    );
    baseline = null;
  }

  /*
    Different hardware is a caveat rather than a refusal: the comparison is
    still the best signal available on a new machine, it just should not be
    read as a regression the first time it fails. Say so rather than let a
    fresh checkout look broken.
  */
  if (baseline?.machine && run.machine && baseline.machine.cpu !== run.machine.cpu) {
    notes.push(
      `Baseline was recorded on "${baseline.machine.cpu}" and this is "${run.machine.cpu}" — ` +
        'draw cost is hardware-bound, so treat any delta below as unproven until you re-baseline here.'
    );
  }

  for (const scenario of run.scenarios) {
    const prior = baseline?.scenarios.find((s) => s.name === scenario.name) || null;
    const row = {
      name: scenario.name,
      drawP50: scenario.drawCostMs.p50,
      baseP50: prior?.drawCostMs.p50 ?? null,
      deltaMs: prior ? +(scenario.drawCostMs.p50 - prior.drawCostMs.p50).toFixed(3) : null,
      frameIntervalMs: scenario.frameIntervalMs.p50,
      drawing: scenario.backdropDrawing !== false,
      status: 'ok',
    };

    /*
      Structural checks first. A scenario that measured the wrong thing must
      not be compared against the baseline at all — the comparison would be
      arithmetically fine and mean nothing.
    */
    if (scenario.backdropDrawing !== scenario.expectBackdrop) {
      row.status = scenario.expectBackdrop ? 'NOT DRAWING' : 'STILL DRAWING';
      failures.push(
        scenario.expectBackdrop
          ? `${scenario.name}: backdrop never drew — drawCostMs is a leftover, not a measurement`
          : `${scenario.name}: backdrop is still drawing in a compact mode, which is supposed to shed it entirely`
      );
    }
    if (scenario.expectEngine && scenario.activeEngine !== scenario.expectEngine) {
      row.status = 'WRONG ENGINE';
      failures.push(
        `${scenario.name}: expected the ${scenario.expectEngine} engine, measured ${scenario.activeEngine}`
      );
    }

    if (!prior) {
      notes.push(`"${scenario.name}" is not in the baseline — recorded, not compared.`);
    } else if (!scenario.backdropDrawing) {
      // Parked by design: there is no cost to compare, and zero vs zero is noise.
    } else if (
      scenario.drawCostMs.p50 > prior.drawCostMs.p50 * REGRESSION_RATIO &&
      scenario.drawCostMs.p50 - prior.drawCostMs.p50 > REGRESSION_FLOOR_MS
    ) {
      row.status = 'REGRESSED';
      failures.push(
        `${scenario.name}: drawCostMs p50 ${prior.drawCostMs.p50.toFixed(2)}ms → ` +
          `${scenario.drawCostMs.p50.toFixed(2)}ms (+${row.deltaMs}ms)`
      );
    }

    for (const [key, budget] of Object.entries(budgets)) {
      const measured = scenario.sections?.[key]?.p90;
      if (typeof measured !== 'number') continue;
      if (measured > budget) {
        row.status = row.status === 'ok' ? 'OVER BUDGET' : row.status;
        failures.push(`${scenario.name}: section "${key}" p90 ${measured.toFixed(2)}ms over its ${budget}ms budget`);
      }
    }

    /*
      A scenario that never rendered produces a beautiful, meaningless zero.
      Catch it here rather than letting it look like an improvement.
    */
    if (scenario.canRender === false) {
      row.status = 'NOT RENDERING';
      failures.push(`${scenario.name}: canRender() was false during sampling — nothing was drawn, the numbers are void`);
    }

    rows.push(row);
  }

  return { rows, failures, notes };
}

/**
 * Render a comparison for a terminal.
 *
 * @param {{rows: object[], failures: string[], notes: string[]}} comparison
 * @returns {string}
 */
export function formatComparison({ rows, failures, notes }) {
  const lines = ['', 'drawCostMs p50 (asserted) — frame interval recorded but never asserted:', ''];
  const width = Math.max(...rows.map((r) => r.name.length), 8);
  for (const r of rows) {
    if (!r.drawing) {
      lines.push(`  ${r.name.padEnd(width)}  backdrop parked — no cost to report  ${r.status === 'ok' ? '' : r.status}`);
      continue;
    }
    const delta = r.deltaMs === null ? '     —' : `${r.deltaMs >= 0 ? '+' : ''}${r.deltaMs.toFixed(2)}ms`;
    const base = r.baseP50 === null ? '  —  ' : `${r.baseP50.toFixed(2)}ms`;
    lines.push(
      `  ${r.name.padEnd(width)}  ${r.drawP50.toFixed(2)}ms  (was ${base}, ${delta})` +
        `  [${r.frameIntervalMs.toFixed(1)}ms/frame]  ${r.status === 'ok' ? '' : r.status}`
    );
  }
  if (notes.length) lines.push('', ...notes.map((n) => `  note: ${n}`));
  lines.push('');
  lines.push(failures.length ? `FAIL — ${failures.length} problem(s):` : 'PASS');
  for (const f of failures) lines.push(`  - ${f}`);
  return lines.join('\n');
}
