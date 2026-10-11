//! PCM sources: planar f32 at the project sample rate. Either decoded and fixed (`Source::new`),
//! or live, growing while a take is recorded (`Source::live`).

/// Frames per chunk of a live source (a power of two, so a frame index splits with a shift).
/// 32768 frames is about 0.7 s at 48 kHz, 128 KB per channel.
pub const LIVE_CHUNK: usize = 1 << 15;

pub struct Source {
    channels: usize,
    ready: bool,
    store: Store,
}

enum Store {
    /// Planar: channel 0's `frames` samples, then channel 1's, and so on.
    Flat { frames: usize, data: Vec<f32> },
    Live(Live),
}

/// Fixed-size chunks, each holding every channel planar (`channels * LIVE_CHUNK` samples), so growing
/// never moves audio that was already written. Chunks are allocated by [`Source::live_reserve`]
/// (a structural call), never by [`Source::live_append`].
struct Live {
    chunks: Vec<Box<[f32]>>,
    written: usize,
    closed: bool,
}

impl Source {
    pub fn new(channels: usize, frames: usize) -> Self {
        Self { channels, ready: false, store: Store::Flat { frames, data: vec![0.0; channels * frames] } }
    }

    /// A live source: playable at once, with nothing written. Only the first two channels are kept.
    pub fn live(channels: usize) -> Self {
        let live = Live { chunks: Vec::new(), written: 0, closed: false };
        Self { channels: channels.clamp(1, 2), ready: true, store: Store::Live(live) }
    }

    /// The readable frames: all of a decoded source, the frames written so far of a live one.
    pub fn frames(&self) -> usize {
        match &self.store {
            Store::Flat { frames, .. } => *frames,
            Store::Live(l) => l.written,
        }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn set_ready(&mut self) {
        self.ready = true;
    }

    pub fn is_live(&self) -> bool {
        matches!(self.store, Store::Live(_))
    }

    /// The samples of a decoded source (empty for a live one).
    pub fn data_mut(&mut self) -> &mut [f32] {
        match &mut self.store {
            Store::Flat { data, .. } => data,
            Store::Live(_) => &mut [],
        }
    }

    /// Pointer for the host to fill (null for a live source). Stable as long as this source lives,
    /// because the `Vec`'s heap block does not move when the map around it shifts.
    pub fn as_mut_ptr(&mut self) -> *mut f32 {
        match &mut self.store {
            Store::Flat { data, .. } => data.as_mut_ptr(),
            Store::Live(_) => std::ptr::null_mut(),
        }
    }

    /// The stereo pair at `frame`; silent outside the readable frames (before 0, or at or past
    /// `frames()`, which for a live source means "not written yet"). A mono source plays to both
    /// sides, and sources with more than two channels use their first two. Allocation-free.
    #[inline]
    pub fn frame(&self, frame: i64) -> (f32, f32) {
        if frame < 0 || frame >= self.frames() as i64 {
            return (0.0, 0.0);
        }
        let i = frame as usize;
        match &self.store {
            Store::Flat { frames, data } => {
                let l = data[i];
                (l, if self.channels >= 2 { data[frames + i] } else { l })
            }
            Store::Live(l) => {
                let c = &l.chunks[i >> LIVE_CHUNK.trailing_zeros()];
                let o = i & (LIVE_CHUNK - 1);
                let left = c[o];
                (left, if self.channels >= 2 { c[LIVE_CHUNK + o] } else { left })
            }
        }
    }

    // ---- live sources ----------------------------------------------------------------------

    /// Frames of storage allocated so far (0 for a decoded source).
    pub fn live_capacity(&self) -> usize {
        match &self.store {
            Store::Live(l) => l.chunks.len() * LIVE_CHUNK,
            Store::Flat { .. } => 0,
        }
    }

    /// Whether a live source takes no more frames.
    pub fn live_closed(&self) -> bool {
        matches!(&self.store, Store::Live(l) if l.closed)
    }

    /// Allocate chunks until at least `frames` fit. This allocates: call it from a structural
    /// call, never from the audio callback's render path.
    pub fn live_reserve(&mut self, frames: usize) {
        let ch = self.channels;
        if let Store::Live(l) = &mut self.store {
            let need = frames.div_ceil(LIVE_CHUNK);
            l.chunks.reserve(need.saturating_sub(l.chunks.len()));
            while l.chunks.len() < need {
                l.chunks.push(vec![0.0; ch * LIVE_CHUNK].into_boxed_slice());
            }
        }
    }

    /// Append frames (`src` holds one slice per channel, all the same length; a missing channel
    /// repeats the first). Takes what fits in the allocated chunks and returns how many frames it
    /// took, which is less than offered only when the reserve ran out. Never allocates.
    pub fn live_append(&mut self, src: &[&[f32]]) -> usize {
        let ch = self.channels;
        let Store::Live(l) = &mut self.store else { return 0 };
        let Some(first) = src.first() else { return 0 };
        if l.closed {
            return 0;
        }
        let n = first.len().min(l.chunks.len() * LIVE_CHUNK - l.written);
        let mut done = 0;
        while done < n {
            let at = l.written + done;
            let (c, o) = (at >> LIVE_CHUNK.trailing_zeros(), at & (LIVE_CHUNK - 1));
            let take = (n - done).min(LIVE_CHUNK - o);
            for k in 0..ch {
                let from = src.get(k).unwrap_or(first);
                l.chunks[c][k * LIVE_CHUNK + o..k * LIVE_CHUNK + o + take].copy_from_slice(&from[done..done + take]);
            }
            done += take;
        }
        l.written += n;
        n
    }

    /// End a live source: no more appends, and the chunks past the written frames are freed.
    /// What was written stays readable (a decoded source is unaffected).
    pub fn live_finalize(&mut self) {
        if let Store::Live(l) = &mut self.store {
            l.closed = true;
            l.chunks.truncate(l.written.div_ceil(LIVE_CHUNK));
        }
    }
}
