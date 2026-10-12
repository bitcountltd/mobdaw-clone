use engine::device::FilterDevice;

const SR: f32 = 48000.0;

fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x1234_5678u32;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 * (2.0 / u32::MAX as f32) - 1.0
        })
        .collect()
}

fn run(mode: f32, gain: f32, block: usize, x: &[f32]) -> Vec<f32> {
    let mut f = FilterDevice::new(SR);
    f.set_param_smooth(0, mode, 0.0);
    f.set_param_smooth(1, 2500.0, 0.0);
    f.set_param_smooth(2, 0.5, 0.0);
    f.set_param_smooth(3, gain, 0.0);
    let (mut l, mut r) = (x.to_vec(), x.to_vec());
    for (a, b) in l.chunks_mut(block).zip(r.chunks_mut(block)) {
        f.process(a, b, SR);
    }
    assert_eq!(l, r);
    l
}

#[test]
fn zero_db_bell_and_shelves_are_bit_exact_identity() {
    let x = noise(2000);
    for mode in [5.0, 6.0, 7.0] {
        assert_eq!(run(mode, 0.0, 128, &x), x, "mode {mode}");
    }
}

#[test]
fn re_entry_from_zero_db_starts_clean() {
    let x = noise(1024);
    let mut f = FilterDevice::new(SR);
    f.set_param_smooth(0, 5.0, 0.0);
    f.set_param_smooth(1, 2500.0, 0.0);
    f.set_param_smooth(2, 0.5, 0.0);
    // Run with gain, drop to 0 dB (skipped), then back up: must equal a fresh filter.
    f.set_param_smooth(3, 9.0, 0.0);
    let (mut l, mut r) = (x.clone(), x.clone());
    f.process(&mut l, &mut r, SR);
    f.set_param_smooth(3, 0.0, 0.0);
    f.process(&mut l, &mut r, SR);
    f.set_param_smooth(3, 9.0, 0.0);
    let (mut l, mut r) = (x.clone(), x.clone());
    f.process(&mut l, &mut r, SR);
    assert_eq!(l, run(5.0, 9.0, 1024, &x));
}

#[test]
fn block_size_independent_when_params_at_rest() {
    let x = noise(4096);
    for mode in 0..8 {
        let a = run(mode as f32, 7.0, 32, &x);
        for bs in [1, 128, 4096] {
            assert_eq!(a, run(mode as f32, 7.0, bs, &x), "mode {mode} block {bs}");
        }
        assert!(a.iter().all(|v| v.is_finite()));
    }
}

#[test]
fn modes_are_stable_while_ramping_params() {
    let x = noise(48000);
    for mode in 0..8 {
        let mut f = FilterDevice::new(SR);
        f.set_param_smooth(0, mode as f32, 0.0);
        f.set_param_smooth(1, 30.0, 0.0);
        f.set_param_smooth(1, 18000.0, 24000.0);
        f.set_param_smooth(3, -12.0, 0.0);
        f.set_param_smooth(3, 12.0, 24000.0);
        let (mut l, mut r) = (x.clone(), x.clone());
        for (a, b) in l.chunks_mut(32).zip(r.chunks_mut(32)) {
            f.process(a, b, SR);
        }
        assert!(l.iter().all(|v| v.is_finite() && v.abs() < 100.0), "mode {mode}");
    }
}
