//! A listening aid for the drum synth's sound library (client/src/content/drumSounds.ts): renders every sound in a
//! file and prints its peak, loudness, length, brightness and lowest strong partial; with `DRUM_WAV_DIR` set it also
//! writes each one as a WAV. Ignored by default:
//!
//! ```sh
//! DRUM_PRESETS=/path/sounds.tsv DRUM_WAV_DIR=/tmp/drums cargo test -p dsp --test drum_presets -- --ignored --nocapture
//! ```
//! Each line of the file is `id<TAB>v0 v1 ... v22` (every param by id).

use dsp::drumsynth::{DrumSynth, PARAM_COUNT};
use rustfft::{num_complex::Complex, FftPlanner};

const SR: f32 = 48000.0;

fn write_wav(path: &str, x: &[f32]) {
    let mut b = Vec::with_capacity(44 + x.len() * 2);
    let n = (x.len() * 2) as u32;
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(SR as u32).to_le_bytes());
    b.extend_from_slice(&(SR as u32 * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&n.to_le_bytes());
    for v in x {
        b.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
}

#[test]
#[ignore]
fn render_drum_presets() {
    let Ok(file) = std::env::var("DRUM_PRESETS") else { return };
    let dir = std::env::var("DRUM_WAV_DIR").ok();
    let text = std::fs::read_to_string(file).unwrap();
    let mut planner = FftPlanner::<f32>::new();
    println!("{:<22} {:>6} {:>7} {:>7} {:>8} {:>7}", "sound", "peak", "loud", "len ms", "bright", "low Hz");
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (id, vals) = line.split_once('\t').unwrap();
        let v: Vec<f32> = vals.split_whitespace().map(|s| s.parse().unwrap()).collect();
        assert_eq!(v.len(), PARAM_COUNT, "{id}");
        let mut d = DrumSynth::new(SR);
        for (i, x) in v.iter().enumerate() {
            d.set_param_smooth(i as u32, *x, 0.0);
        }
        d.set_param_smooth(20, 0.0, 0.0); // centred, so the left channel is the whole thing
        let n = (SR * 6.0) as usize;
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        d.note_on(1.0, 0.0, 4321);
        d.render_add(&mut l, &mut r);
        // mono sum back at unity (the centre pan is -3 dB per side)
        let x: Vec<f32> = l.iter().zip(&r).map(|(a, b)| (a + b) * std::f32::consts::FRAC_1_SQRT_2).collect();
        let peak = x.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        let end = x.iter().rposition(|v| v.abs() > peak * 1e-3).unwrap_or(0);
        // loudness: the RMS of the loudest 50 ms window (a crude momentary loudness)
        let w = 2400;
        let mut best = 0.0f32;
        let mut acc: f32 = x[..w.min(n)].iter().map(|v| v * v).sum();
        for i in w..n {
            best = best.max(acc);
            acc += x[i] * x[i] - x[i - w] * x[i - w];
            if i > end + w {
                break;
            }
        }
        let loud = 10.0 * (best / w as f32).max(1e-12).log10();
        // spectrum of the first 170 ms
        let m = 8192;
        let mut buf: Vec<Complex<f32>> = (0..m)
            .map(|i| {
                let win = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / m as f32).cos();
                Complex::new(x[i] * win, 0.0)
            })
            .collect();
        planner.plan_fft_forward(m).process(&mut buf);
        let mags: Vec<f32> = buf[..m / 2].iter().map(|c| c.norm()).collect();
        let hz = |k: usize| k as f32 * SR / m as f32;
        let total: f32 = mags.iter().map(|a| a * a).sum::<f32>().max(1e-12);
        let centroid = mags.iter().enumerate().map(|(k, a)| hz(k) * a * a).sum::<f32>() / total;
        let pk = mags.iter().cloned().fold(0.0, f32::max);
        let low = mags.iter().position(|&a| a > pk * 0.3).map(hz).unwrap_or(0.0);
        println!("{:<22} {:>6.2} {:>7.1} {:>7.0} {:>8.0} {:>7.0}", id, peak, loud, end as f32 / SR * 1000.0, centroid, low);
        if let Some(dir) = &dir {
            write_wav(&format!("{dir}/{id}.wav"), &x[..(end + 2400).min(n)]);
        }
    }
}

/// Rough cost per model: render 10 s of a long hit natively and print the real-time factor.
#[test]
#[ignore]
fn drum_model_cost() {
    for model in 0..5 {
        let mut d = DrumSynth::new(SR);
        for (id, v) in [(0u32, model as f32), (4, 5000.0), (8, 0.5), (12, 3000.0), (15, 0.5)] {
            d.set_param_smooth(id, v, 0.0);
        }
        let n = SR as usize * 10;
        let mut l = vec![0.0; 128];
        let mut r = vec![0.0; 128];
        let t = std::time::Instant::now();
        let mut i = 0;
        while i < n {
            if i % 48_000 == 0 {
                d.note_on(1.0, 0.0, i as i64);
            }
            d.render_add(&mut l, &mut r);
            i += 128;
        }
        let secs = t.elapsed().as_secs_f64();
        println!("model {model}: {:.0}x real time ({:.1} us per 128-frame block)", 10.0 / secs, secs * 1e6 / (n / 128) as f64);
    }
}
