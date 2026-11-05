//! RTP H.264 depacketization (RFC 6184: single NAL, STAP-A, FU-A) and
//! access-unit assembly.

pub const NAL_SLICE: u8 = 1;
pub const NAL_IDR: u8 = 5;
pub const NAL_SPS: u8 = 7;
pub const NAL_PPS: u8 = 8;
pub const NAL_AUD: u8 = 9;
pub const NAL_STAP_A: u8 = 24;
pub const NAL_FU_A: u8 = 28;

const START: [u8; 4] = [0, 0, 0, 1];

#[derive(Debug, Clone, PartialEq)]
pub struct RtpPacket<'a> {
    pub marker: bool,
    pub payload_type: u8,
    pub seq: u16,
    pub timestamp: u32,
    pub payload: &'a [u8],
}

/// Parses an RTP packet (RFC 3550), skipping CSRCs, header extension and
/// padding.
pub fn parse_rtp(b: &[u8]) -> Option<RtpPacket<'_>> {
    if b.len() < 12 || b[0] >> 6 != 2 {
        return None;
    }
    let padding = b[0] & 0x20 != 0;
    let extension = b[0] & 0x10 != 0;
    let cc = (b[0] & 0x0f) as usize;
    let mut off = 12 + cc * 4;
    if extension {
        if b.len() < off + 4 {
            return None;
        }
        let words = u16::from_be_bytes([b[off + 2], b[off + 3]]) as usize;
        off += 4 + words * 4;
    }
    let mut end = b.len();
    if padding {
        let pad = *b.last()? as usize;
        end = end.checked_sub(pad)?;
    }
    if off > end {
        return None;
    }
    Some(RtpPacket {
        marker: b[1] & 0x80 != 0,
        payload_type: b[1] & 0x7f,
        seq: u16::from_be_bytes([b[2], b[3]]),
        timestamp: u32::from_be_bytes([b[4], b[5], b[6], b[7]]),
        payload: &b[off..end],
    })
}

/// WebCodecs codec string from an SPS NAL (header byte included).
pub fn codec_string(sps: &[u8]) -> Option<String> {
    (sps.len() >= 4).then(|| format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]))
}

#[derive(Debug, PartialEq)]
pub enum Output {
    /// Codec string; emitted when the SPS changes.
    Config(String),
    /// One Annex-B access unit. Keyframes are prefixed with SPS and PPS.
    Frame {
        key: bool,
        timestamp: u32,
        data: Vec<u8>,
    },
}

#[derive(Default)]
pub struct Assembler {
    fu: Vec<u8>,
    fu_active: bool,
    last_seq: Option<u16>,
    cur_ts: Option<u32>,
    cur: Vec<Vec<u8>>,
    cur_broken: bool,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    need_key: bool,
}

impl Assembler {
    pub fn new() -> Self {
        Self {
            need_key: true,
            ..Default::default()
        }
    }

    /// Seeds parameter sets (e.g. from the SDP's sprop-parameter-sets).
    pub fn set_parameter_sets(&mut self, nals: &[Vec<u8>], out: &mut Vec<Output>) {
        for n in nals {
            self.param_nal(n, out);
        }
    }

    fn param_nal(&mut self, nal: &[u8], out: &mut Vec<Output>) {
        match nal.first().map(|b| b & 0x1f) {
            Some(NAL_SPS) => {
                if self.sps.as_deref() != Some(nal) {
                    self.sps = Some(nal.to_vec());
                    if let Some(c) = codec_string(nal) {
                        out.push(Output::Config(c));
                    }
                }
            }
            Some(NAL_PPS) => self.pps = Some(nal.to_vec()),
            _ => {}
        }
    }

    pub fn push(&mut self, pkt: &RtpPacket<'_>, out: &mut Vec<Output>) {
        // Packet loss: we can't tell whether the lost packet belonged to the
        // access unit in flight or to this one, so both are unusable.
        let gap = self
            .last_seq
            .is_some_and(|last| pkt.seq != last.wrapping_add(1));
        self.last_seq = Some(pkt.seq);
        if gap {
            self.fu_active = false;
            self.cur_broken = true;
        }
        if self.cur_ts.is_some_and(|t| t != pkt.timestamp) {
            self.flush(out);
            if gap {
                self.cur_broken = true;
            }
        }
        self.cur_ts = Some(pkt.timestamp);
        self.depacketize(pkt.payload);
        if pkt.marker {
            self.flush(out);
        }
    }

    fn depacketize(&mut self, p: &[u8]) {
        let Some(&hdr) = p.first() else { return };
        if hdr & 0x80 != 0 {
            self.cur_broken = true;
            return;
        }
        match hdr & 0x1f {
            1..=23 => self.cur.push(p.to_vec()),
            NAL_STAP_A => {
                let mut rest = &p[1..];
                while rest.len() >= 2 {
                    let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
                    rest = &rest[2..];
                    if len == 0 || len > rest.len() {
                        self.cur_broken = true;
                        break;
                    }
                    self.cur.push(rest[..len].to_vec());
                    rest = &rest[len..];
                }
            }
            NAL_FU_A => {
                if p.len() < 2 {
                    return;
                }
                let fu = p[1];
                let (start, end) = (fu & 0x80 != 0, fu & 0x40 != 0);
                if start {
                    self.fu.clear();
                    self.fu.push((hdr & 0xe0) | (fu & 0x1f));
                    self.fu_active = true;
                } else if !self.fu_active {
                    return; // missed the start fragment
                }
                self.fu.extend_from_slice(&p[2..]);
                if end {
                    self.fu_active = false;
                    self.cur.push(std::mem::take(&mut self.fu));
                }
            }
            _ => {} // STAP-B, MTAP, FU-B: not used in practice
        }
    }

    fn flush(&mut self, out: &mut Vec<Output>) {
        let nals = std::mem::take(&mut self.cur);
        let broken = std::mem::replace(&mut self.cur_broken, false);
        let Some(ts) = self.cur_ts else { return };
        if nals.is_empty() {
            return;
        }
        let mut has_vcl = false;
        let mut key = false;
        let mut body: Vec<&[u8]> = Vec::with_capacity(nals.len());
        for n in &nals {
            let t = n[0] & 0x1f;
            match t {
                NAL_SPS | NAL_PPS => self.param_nal(n, out),
                NAL_AUD => {}
                _ => {
                    if (NAL_SLICE..=NAL_IDR).contains(&t) {
                        has_vcl = true;
                    }
                    key |= t == NAL_IDR;
                    body.push(n);
                }
            }
        }
        if !has_vcl {
            return;
        }
        if broken {
            self.need_key = true;
            return;
        }
        if self.need_key && !key {
            return;
        }
        let mut data = Vec::with_capacity(body.iter().map(|n| n.len() + 4).sum::<usize>() + 128);
        if key {
            let (Some(sps), Some(pps)) = (&self.sps, &self.pps) else {
                self.need_key = true;
                return;
            };
            for n in [sps, pps] {
                data.extend_from_slice(&START);
                data.extend_from_slice(n);
            }
        }
        for n in body {
            data.extend_from_slice(&START);
            data.extend_from_slice(n);
        }
        self.need_key = false;
        out.push(Output::Frame {
            key,
            timestamp: ts,
            data,
        });
    }
}

/// Extends 32-bit RTP timestamps to a monotonic microsecond clock starting
/// at zero.
pub struct Clock {
    rate: u64,
    last: Option<u32>,
    ext: i64,
}

impl Clock {
    pub fn new(rate: u32) -> Self {
        Self {
            rate: rate.max(1) as u64,
            last: None,
            ext: 0,
        }
    }

    pub fn micros(&mut self, ts: u32) -> u64 {
        if let Some(last) = self.last {
            self.ext += ts.wrapping_sub(last) as i32 as i64;
        }
        self.last = Some(ts);
        (self.ext.max(0) as u64) * 1_000_000 / self.rate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
    const PPS: &[u8] = &[0x68, 0xeb, 0xe3];

    fn rtp(seq: u16, ts: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0x80, if marker { 0x80 | 96 } else { 96 }];
        v.extend_from_slice(&seq.to_be_bytes());
        v.extend_from_slice(&ts.to_be_bytes());
        v.extend_from_slice(&[0, 0, 0, 1]);
        v.extend_from_slice(payload);
        v
    }

    fn feed(a: &mut Assembler, pkts: &[Vec<u8>]) -> Vec<Output> {
        let mut out = Vec::new();
        for p in pkts {
            a.push(&parse_rtp(p).unwrap(), &mut out);
        }
        out
    }

    fn annexb(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter()
            .flat_map(|n| START.iter().chain(n.iter()).copied())
            .collect()
    }

    #[test]
    fn codec() {
        assert_eq!(codec_string(SPS).unwrap(), "avc1.640028");
        assert_eq!(codec_string(&[0x67, 0x42]), None);
    }

    #[test]
    fn rtp_parse_with_extension_and_padding() {
        let mut v = vec![0xb1, 0x60, 0, 1, 0, 0, 0, 9, 0, 0, 0, 1];
        v.extend_from_slice(&[1, 2, 3, 4]); // one CSRC
        v.extend_from_slice(&[0xbe, 0xde, 0, 1, 9, 9, 9, 9]); // extension, 1 word
        v.extend_from_slice(&[0x41, 0xaa]); // payload
        v.extend_from_slice(&[0, 2]); // padding (2 bytes)
        let p = parse_rtp(&v).unwrap();
        assert_eq!(p.payload, &[0x41, 0xaa]);
        assert_eq!(
            (p.seq, p.timestamp, p.marker, p.payload_type),
            (1, 9, false, 96)
        );
        assert!(parse_rtp(&[0x40; 12]).is_none());
    }

    #[test]
    fn stap_a_and_fu_a_keyframe() {
        let mut a = Assembler::new();
        let mut stap = vec![NAL_STAP_A | 0x60];
        for n in [SPS, PPS] {
            stap.extend_from_slice(&(n.len() as u16).to_be_bytes());
            stap.extend_from_slice(n);
        }
        let idr: Vec<u8> = std::iter::once(0x65).chain(1..=10u8).collect();
        let fu1 = [&[0x7c, 0x85][..], &idr[1..5]].concat();
        let fu2 = [&[0x7c, 0x05][..], &idr[5..8]].concat();
        let fu3 = [&[0x7c, 0x45][..], &idr[8..]].concat();
        let out = feed(
            &mut a,
            &[
                rtp(1, 1000, false, &stap),
                rtp(2, 1000, false, &fu1),
                rtp(3, 1000, false, &fu2),
                rtp(4, 1000, true, &fu3),
            ],
        );
        assert_eq!(
            out,
            vec![
                Output::Config("avc1.640028".into()),
                Output::Frame {
                    key: true,
                    timestamp: 1000,
                    data: annexb(&[SPS, PPS, &idr])
                }
            ]
        );

        // Following P frame, delimited by timestamp change (no marker).
        let p1 = [0x41, 0x9a, 0x01];
        let p2 = [0x41, 0x9a, 0x02];
        let out = feed(&mut a, &[rtp(5, 4000, false, &p1), rtp(6, 7000, true, &p2)]);
        assert_eq!(
            out,
            vec![
                Output::Frame {
                    key: false,
                    timestamp: 4000,
                    data: annexb(&[&p1])
                },
                Output::Frame {
                    key: false,
                    timestamp: 7000,
                    data: annexb(&[&p2])
                },
            ]
        );
    }

    #[test]
    fn waits_for_keyframe_and_recovers_from_loss() {
        let mut a = Assembler::new();
        // P frame before any keyframe: dropped.
        assert!(feed(&mut a, &[rtp(1, 0, true, &[0x41, 1])]).is_empty());
        // IDR without known SPS/PPS: dropped.
        assert!(feed(&mut a, &[rtp(2, 1, true, &[0x65, 1])]).is_empty());
        let mut out = Vec::new();
        a.set_parameter_sets(&[SPS.to_vec(), PPS.to_vec()], &mut out);
        assert_eq!(out, vec![Output::Config("avc1.640028".into())]);
        let out = feed(&mut a, &[rtp(3, 2, true, &[0x65, 2])]);
        assert!(matches!(&out[..], [Output::Frame { key: true, .. }]));
        // Lost packet (seq 4 missing): P frames dropped until next IDR.
        assert!(feed(&mut a, &[rtp(5, 3, true, &[0x41, 3])]).is_empty());
        assert!(feed(&mut a, &[rtp(6, 4, true, &[0x41, 4])]).is_empty());
        let out = feed(&mut a, &[rtp(7, 5, true, &[0x65, 5])]);
        assert_eq!(
            out,
            vec![Output::Frame {
                key: true,
                timestamp: 5,
                data: annexb(&[SPS, PPS, &[0x65, 5]])
            }]
        );
        // Same SPS in-band: no new config, no duplicated SPS in output.
        let out = feed(
            &mut a,
            &[
                rtp(8, 6, false, SPS),
                rtp(9, 6, false, PPS),
                rtp(10, 6, true, &[0x65, 6]),
            ],
        );
        assert_eq!(
            out,
            vec![Output::Frame {
                key: true,
                timestamp: 6,
                data: annexb(&[SPS, PPS, &[0x65, 6]])
            }]
        );
        // Changed SPS emits a new config.
        let sps2 = [0x67, 0x42, 0xc0, 0x1f];
        let out = feed(
            &mut a,
            &[rtp(11, 7, false, &sps2), rtp(12, 7, true, &[0x65, 7])],
        );
        assert_eq!(out[0], Output::Config("avc1.42c01f".into()));
    }

    #[test]
    fn fu_a_missing_start_is_ignored() {
        let mut a = Assembler::new();
        let mut out = Vec::new();
        a.set_parameter_sets(&[SPS.to_vec(), PPS.to_vec()], &mut out);
        let out = feed(&mut a, &[rtp(1, 0, true, &[0x7c, 0x45, 9, 9])]);
        assert!(out.is_empty());
    }

    #[test]
    fn clock_wraps() {
        let mut c = Clock::new(90_000);
        assert_eq!(c.micros(u32::MAX - 89_999), 0);
        assert_eq!(c.micros(0), 1_000_000);
        assert_eq!(c.micros(90_000), 2_000_000);
    }
}
