use engine::device::{EqDevice, FilterDevice};

const SR: f32 = 48000.0;

fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x9e37_79b9u32;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s as f32 * (2.0 / u32::MAX as f32) - 1.0
        })
        .collect()
}

#[test]
fn all_bands_at_zero_db_is_bit_exact_identity() {
    let x = noise(3000);
    let mut e = EqDevice::new(SR);
    let (mut l, mut r) = (x.clone(), x.clone());
    for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
        e.process(a, b, SR);
    }
    assert_eq!(l, x);
    assert_eq!(r, x);
}

#[test]
fn single_active_bell_matches_filter_device_bell() {
    let x = noise(4096);
    let mut f = FilterDevice::new(SR);
    f.set_param_smooth(0, 5.0, 0.0);
    f.set_param_smooth(1, 1500.0, 0.0);
    f.set_param_smooth(2, 0.4, 0.0);
    f.set_param_smooth(3, 9.0, 0.0);
    let mut e = EqDevice::new(SR);
    e.set_param_smooth(3, 1500.0, 0.0);
    e.set_param_smooth(4, 9.0, 0.0);
    e.set_param_smooth(5, 0.4, 0.0);
    let (mut fl, mut fr) = (x.clone(), x.clone());
    let (mut el, mut er) = (x.clone(), x.clone());
    for (a, b) in fl.chunks_mut(64).zip(fr.chunks_mut(64)) {
        f.process(a, b, SR);
    }
    for (a, b) in el.chunks_mut(64).zip(er.chunks_mut(64)) {
        e.process(a, b, SR);
    }
    for (a, b) in fl.iter().zip(&el) {
        assert!((a - b).abs() < 1e-5, "{a} vs {b}");
    }
    assert_eq!(el, er);
}
