use dsp::adsr::{Adsr, Stage};

#[test]
fn fill_matches_next_bit_for_bit_across_stage_changes() {
    // fractional and tiny segment lengths, sustain moving mid-note, a release part way through
    for (a, d, s, r) in [(100.3, 200.7, 0.5, 50.2), (1.0, 1.0, 0.0, 1.0), (37.5, 3.2, 0.9, 480.0), (0.0, 64.0, 1.0, 10.0)] {
        for chunk in [1usize, 7, 32] {
            let (mut x, mut y) = (Adsr::new(), Adsr::new());
            for e in [&mut x, &mut y] {
                e.set(a, d, s, r);
                e.note_on();
            }
            for blk in 0..60 {
                if blk == 25 {
                    x.release();
                    y.release();
                }
                if blk == 10 {
                    x.set(a, d, s * 0.5, r);
                    y.set(a, d, s * 0.5, r);
                }
                let mut buf = vec![0.0f32; chunk];
                x.fill(&mut buf);
                for (i, v) in buf.iter().enumerate() {
                    let w = y.next();
                    assert_eq!(v.to_bits(), w.to_bits(), "a={a} chunk={chunk} blk={blk} i={i}");
                }
                assert_eq!(x.stage(), y.stage());
                assert_eq!(x.level().to_bits(), y.level().to_bits());
            }
        }
    }
}

#[test]
fn segments_are_linear_and_hit_their_times() {
    let mut e = Adsr::new();
    e.set(100.0, 200.0, 0.5, 50.0);
    e.note_on();
    let mut v = vec![];
    for _ in 0..100 {
        v.push(e.next());
    }
    assert!((v[49] - 0.5).abs() < 1e-5, "mid-attack {}", v[49]);
    assert_eq!(v[99], 1.0);
    assert_eq!(e.stage(), Stage::Decay);
    for _ in 0..100 {
        e.next();
    }
    assert!((e.level() - 0.75).abs() < 1e-5, "mid-decay {}", e.level());
    for _ in 0..100 {
        e.next();
    }
    assert_eq!(e.stage(), Stage::Sustain);
    assert_eq!(e.level(), 0.5);
    // Release from sustain 0.5 over 50 samples.
    e.release();
    for _ in 0..25 {
        e.next();
    }
    assert!((e.level() - 0.25).abs() < 1e-5);
    for _ in 0..25 {
        e.next();
    }
    assert!(e.is_idle() && e.level() == 0.0);
}

#[test]
fn release_takes_the_same_time_from_any_level() {
    let mut e = Adsr::new();
    e.set(1000.0, 10.0, 1.0, 40.0);
    e.note_on();
    for _ in 0..100 {
        e.next(); // level 0.1, mid-attack
    }
    e.release();
    for _ in 0..40 {
        e.next();
    }
    assert!(e.is_idle());
}

#[test]
fn zero_times_take_one_sample() {
    let mut e = Adsr::new();
    e.set(0.0, 0.0, 0.7, 0.0);
    e.note_on();
    assert_eq!(e.next(), 1.0);
    assert!((e.next() - 0.7).abs() < 1e-6);
    e.release();
    assert_eq!(e.next(), 0.0);
    assert!(e.is_idle());
}
