// Engine benchmark runner. Usage: node engine/bench/run.mjs [bench.wasm] [--json] [--runs N] [--compare file.json]
// Normally run through `npm run bench`, which builds crates/bench for wasm32 (+simd128) first.
// Prints ns per stereo frame and % of one core at 48 kHz, best of N runs. Setup is excluded: block exports are
// timed as f(B) - f(0); engine scenes are rebuilt (untimed) before every run so clips are playing.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const valueFlags = new Set(['--runs', '--compare', '--out']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
const wasmPath = positional[0] ?? resolve(here, '../target/wasm32-unknown-unknown/release/bench.wasm');
const RUNS = Number(opt('--runs') ?? 9);
const json = flag('--json');

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const x = instance.exports;
const N = 32; // frames per block for the dsp-block exports
const B = 20000; // blocks per timed call
const EB = 2000; // engine blocks of 128 frames per timed call (5.3 s: inside the 30 s clips)
const E = 128;

const timeMs = (fn) => {
  const a = performance.now();
  fn();
  return performance.now() - a;
};

/** Baseline from docs/dsp.md section 1 (Intel i7-9750H, Node 24), ns/frame. Midpoint where a range is given. */
const results = [];
function block(name, fn, base) {
  fn(B); // warm up
  let best = Infinity;
  for (let k = 0; k < RUNS; k++) best = Math.min(best, timeMs(() => fn(B)) - timeMs(() => fn(0)));
  results.push({ name, ns: (best * 1e6) / (B * N), base });
}
function scene(name, a, base) {
  x.scene(...a);
  x.run(EB); // warm up
  let best = Infinity;
  for (let k = 0; k < RUNS; k++) {
    x.scene(...a); // fresh scene each time: clips start playing at 0
    best = Math.min(best, timeMs(() => x.run(EB)));
  }
  results.push({ name, ns: (best * 1e6) / (EB * E), base });
}
function clip(name, base) {
  // 128-frame blocks, 20 s source; f(0) subtracts the source build.
  const CB = 5000;
  x.clip(CB);
  let best = Infinity;
  for (let k = 0; k < RUNS; k++) best = Math.min(best, timeMs(() => x.clip(CB)) - timeMs(() => x.clip(0)));
  results.push({ name, ns: (best * 1e6) / (CB * E), base });
}

clip('audio clip, playing', 24.5);
block('SVF (raw Svf, no device)', x.svf);
block('compressor', x.compressor, 77);
block('tremolo', x.tremolo, 61);
block('reverb', x.reverb, 109);
block('tape delay (warble 0)', (b) => x.delay(b, 0));
block('tape delay (warble 0.25)', (b) => x.delay(b, 25), 282);
block('synth, 1 voice', (b) => x.synth(b, 1));
block('synth, 8 voices', (b) => x.synth(b, 8), 147);
block('resampler, speed 1.0', (b) => x.resampler(b, 100));
block('resampler, speed 1.5', (b) => x.resampler(b, 150));
block('resampler, speed 4.0', (b) => x.resampler(b, 400));
block('looper voice, warble 0', (b) => x.looper(b, 0), 111);
block('looper voice, warble 0.5', (b) => x.looper(b, 50), 222);
scene('engine: 1 track, 1 clip', [1, 1, 0]);
scene('engine: 16 tracks, 1 clip', [16, 1, 0]);
scene('engine: 16 tracks, 200 clips each', [16, 200, 0]);
scene('engine: 64 tracks, 1 clip', [64, 1, 0]);
scene('engine: 16 tracks x (clip + 5 fx)', [16, 1, 31], 10870);

const pct = (ns) => (ns * 48000) / 1e9 * 100;
for (const r of results) r.pct = pct(r.ns);

let prev;
if (opt('--compare')) prev = Object.fromEntries(JSON.parse(readFileSync(opt('--compare'), 'utf8')).results.map((r) => [r.name, r.ns]));

if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify({ node: process.version, runs: RUNS, results }, null, 2));
if (json) {
  console.log(JSON.stringify({ node: process.version, runs: RUNS, results }, null, 2));
} else {
  console.log(`bench: ${wasmPath}\nnode ${process.version}, best of ${RUNS}, 48 kHz. "audit" is the docs/dsp.md section 1 baseline (i7-9750H).\n`);
  console.log(`${'block'.padEnd(38)} ${'ns/frame'.padStart(10)} ${'% core'.padStart(8)} ${'audit'.padStart(8)}${prev ? '   vs prev' : ''}`);
  for (const r of results) {
    let line = `${r.name.padEnd(38)} ${r.ns.toFixed(1).padStart(10)} ${r.pct.toFixed(2).padStart(8)} ${(r.base ? String(r.base) : '').padStart(8)}`;
    if (prev && prev[r.name]) line += `   ${((r.ns / prev[r.name] - 1) * 100).toFixed(0).padStart(4)}%`;
    console.log(line);
  }
}
