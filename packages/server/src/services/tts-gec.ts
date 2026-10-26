/**
 * Edge TTS `Sec-MS-GEC` v2 token — 2026-10-24.
 *
 * 🔴 Why this exists (second protocol break in 12 days): Microsoft changed the
 * token algorithm again around 2026-10-23. The 10-12 parameter set (new host
 * `api.msedgeservices.com` + v1 GEC) now gets an HTTP 200 (no upgrade) instead
 * of 101; the OLD host `speech.platform.bing.com/.../edge/v1` is back but only
 * accepts the **v2** token. Verified end-to-end against `edge-tts==7.3.1`
 * (which synthesizes successfully); same outbreak reported in pyvideotrans #8421.
 *
 * v2 token = `"<16 hex CS64>-<64 hex SHA256*>"` where
 *   · SHA256*  = SHA-256 with FIPS round constant #14 replaced (0xC9DC06A7),
 *                plus small-sigma adjustments during the init expansion, and a
 *                custom initial *working* state (the FIPS initial state is
 *                still the final addend);
 *   · CS64     = an additional custom keyed digest over the same input;
 *   · input    = `"<unix seconds + WIN_EPOCH, floored to 300s} × 1e7>" +
 *                TRUSTED_CLIENT_TOKEN` (ascii).
 *
 * The only acceptance criterion is **bit-exact agreement with the upstream
 * Python implementation** (`edge_tts.drm.generate_sec_ms_gec_v2` from
 * rany2/edge-tts, MIT-at-source but GPL-3.0 packaged — algorithm re-expressed
 * here in TypeScript, nothing vendored). Dual comparison lives in
 * `tts-gec.test.ts` / `scripts/diag/verify-tts-gec-v2.mjs`.
 */

// ---- SHA-256 tables (v2 variant — NOT pure FIPS 180-4, see notes) ----
//
// 🔴 Upstream deviates from FIPS in TWO places, both verified against
// `edge_tts.drm` by table diff (2026-10-24):
//   1. `ROUND_CONSTANTS[3]` = 0xe9b5dba5 (FIPS has 0xe9b5dbae) — applies to
//      BOTH the digest block and the init block (BLOCK_CONSTANTS derives from
//      this table by slice, so the fix propagates automatically);
//   2. `BLOCK_CONSTANTS[14]` = 0xc9dc06a7 (init path only).

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const

/** Custom initial working state (replaces the standard `H0` mid-pipeline). */
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
] as const

const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
] as const

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

/** Round constant #14 is replaced by this adjusted value (init path only). */
const K_ADJUSTMENT = 0xc9dc06a7
const BLOCK_CONSTANTS: readonly number[] = [
  ...ROUND_CONSTANTS.slice(0, 14),
  K_ADJUSTMENT,
  ...ROUND_CONSTANTS.slice(15),
]

const SIGMA0_ADJUSTMENT = 0x059c0b80
const SIGMA1_ADJUSTMENT = 0x000b92c0

// ---- CS64 tables ----

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

const U32 = 0xffffffff

/** Rotate right (32-bit). */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** Small sigma 0 — combined rotations truncated once, as upstream. */
function sigma0(v: number): number {
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0
}

/** Small sigma 1 — combined rotations truncated once, as upstream. */
function sigma1(v: number): number {
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0
}

/** Rotate a 32-bit value left by 16 bits (byte swap). */
function rol16(v: number): number {
  v &= U32
  return ((v << 16) | (v >>> 16)) >>> 0
}

/** Split data into little-endian 32-bit words, zero-padded to an even count. */
function wordsLe4Even(data: Buffer): number[] {
  const padded = Buffer.concat([
    data,
    Buffer.alloc((4 - (data.length % 4)) % 4),
  ])
  const words: number[] = []
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i))
  if (words.length % 2) words.push(0)
  return words
}

/** Big sigma 1 (round function, e): ROTR6 ^ ROTR11 ^ ROTR25. */
function bigSigma1(v: number): number {
  return (rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25)) >>> 0
}

/** Big sigma 0 (round function, a): ROTR2 ^ ROTR13 ^ ROTR22. */
function bigSigma0(v: number): number {
  return (rotr(v, 2) ^ rotr(v, 13) ^ rotr(v, 22)) >>> 0
}

/**
 * Standard SHA-256 round function. `constants` selects the table (standard vs
 * adjusted) and `first` skips the first N rounds (init path starts at 14).
 * Equivalent to the upstream unrolled form — verified bit-exact.
 */
function sha256Rounds(
  state: readonly number[],
  words: number[],
  constants: readonly number[],
  first = 0,
): number[] {
  let [a, b, c, d, e, f, g, h] = state
  for (let i = first; i < 64; i++) {
    const t1 =
      (h + bigSigma1(e) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) >>> 0
    const t2 =
      (bigSigma0(a) + ((a & b) | (c & (a | b)))) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}

/** Standard SHA-256 message schedule expansion (from word `firstWord`). */
function expandSchedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2]
    const y = words[i - 15]
    words.push((sigma1(x) + words[i - 7] + sigma0(y) + words[i - 16]) >>> 0)
  }
}

/**
 * Custom init: the first 7 bytes of the input are folded into the initial
 * state through a truncated expansion, then rounds 14..63 run over the
 * adjusted constants starting from the custom working state.
 */
export function sha256Init(head: Buffer): number[] {
  const words: number[] = new Array(14).fill(0)
  words.push(head.readUIntBE(0, 3)) // data[:3] big-endian (index 14)
  words.push(head.readUInt32BE(3)) // data[3:7] big-endian (index 15)
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16]
    if (index - 2 >= 14) {
      value +=
        index === 16
          ? sigma1(words[index - 2]) ^ SIGMA1_ADJUSTMENT
          : sigma1(words[index - 2])
    }
    if (index - 7 >= 14) value += words[index - 7]
    if (index - 15 >= 14) {
      value +=
        index === 29
          ? sigma0(words[index - 15]) ^ SIGMA0_ADJUSTMENT
          : sigma0(words[index - 15])
    }
    words.push((value & U32) >>> 0)
  }
  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      K_ADJUSTMENT -
      ROUND_CONSTANTS[14]) >>> 0,
  )
  expandSchedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, BLOCK_CONSTANTS, 14)
  return working.map((x, i) => ((x + SHA256_INITIAL[i]) & U32) >>> 0)
}

/** The adjusted SHA-256 digest used inside the v2 token. */
export function sha256Adjusted(data: Buffer): Buffer {
  if (data.length < 7) throw new Error('Token salt must contain at least seven bytes')
  const length = 57 + data.length
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(((55 - length) % 64 + 64) % 64),
  ])
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64BE(BigInt(length) * 8n)
  const blocks = Buffer.concat([padded, lenBuf])
  const state = sha256Init(data.subarray(0, 7))
  let cur = state
  for (let off = 0; off < blocks.length; off += 64) {
    const words: number[] = []
    for (let i = 0; i < 16; i++) words.push(blocks.readUInt32BE(off + i * 4))
    expandSchedule(words)
    const working = sha256Rounds(cur, words, ROUND_CONSTANTS)
    cur = cur.map((x, i) => ((x + working[i]) & U32) >>> 0)
  }
  return Buffer.from(cur.flatMap((x) => [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]))
}

/** The custom CS64 keyed digest over (data, adjusted-digest). */
export function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  let keyA = digest.readUInt32LE(0)
  let keyB = digest.readUInt32LE(4)
  keyA = (keyA | 1) >>> 0
  keyB = (keyB | 1) >>> 0
  const factors = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ]
  const terms: number[] = CS64_COEFFICIENTS.map(
    (coefficient, index) => Math.imul(coefficient[0], factors[index % 2]) >>> 0,
  )
  const offsets: number[] = CS64_COEFFICIENTS.map((c) => c[1])
  const dataWords = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]))
  for (let index = 0; index < dataWords.length; index++) {
    const word = dataWords[index]
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB) >>> 0
    let offset = Math.imul(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db) >>> 0
    if (index === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factors[0])) >>> 0
      offset = (offset + CS64_ADJUSTMENT1) >>> 0
    }
    terms.push(term >>> 0)
    offsets.push(offset >>> 0)
  }
  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]
    const y = terms[index + 1]
    let t = rol16((offsets[index] + x) >>> 0)
    let q = Math.imul(t, 0x76f50f34) >>> 0
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xc3efea97) >>> 0) + q >>> 0)) >>> 0
    t = rol16((offsets[index + 1] + y) >>> 0)
    q = Math.imul(t, 0x1881ce3c) >>> 0
    swapLast = (((Math.imul(rol16(q), 0x35bd1ec9) >>> 0) + q) >>> 0)
    swapAcc = (swapAcc + swapLast) >>> 0

    // state * keyA exceeds 2^53 — only the low 32 bits survive the mask, so
    // Math.imul is the exact equivalent of Python's `(state * keyA) & mask`.
    state = (Math.imul(state, keyA) + x) >>> 0
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0
    acc = (acc + state) >>> 0
    let tt = (Math.imul(state, keyB) + y) >>> 0
    tt = Math.imul(rol16(tt), 0xa27416f5) >>> 0
    tt = Math.imul(rol16(tt), 0xd38396ff) >>> 0
    state = Math.imul(rol16(Math.imul(rol16(tt), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0
    acc = (acc + state) >>> 0
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0]
}

/** Token hash components: [cs64 hex16, adjusted-sha256 hex64], both uppercase. */
function tokenHash(data: Buffer): [string, string] {
  const digest = sha256Adjusted(data)
  const [w0, w1] = cs64Digest(data, digest)
  const le = Buffer.alloc(8)
  le.writeUInt32LE(w0 >>> 0, 0)
  le.writeUInt32LE(w1 >>> 0, 4)
  return [le.toString('hex').toUpperCase(), digest.toString('hex').toUpperCase()]
}

// ---- Public API ----

const WIN_EPOCH_SECONDS = 11_644_473_600n
const GEC_WINDOW_SECONDS = 300n

/**
 * v2 `Sec-MS-GEC` value. `unixTimestamp` (seconds) is injectable for tests and
 * for clock-skew correction; defaults to now.
 *
 * 🔴 The only acceptance standard is bit-exact agreement with upstream
 * `edge_tts.drm.generate_sec_ms_gec_v2()` — see the dual comparison test.
 */
export function secMsGecV2(unixTimestamp?: number): string {
  let ticks = BigInt(
    Math.floor(unixTimestamp ?? Date.now() / 1000),
  )
  ticks += WIN_EPOCH_SECONDS
  ticks -= ticks % GEC_WINDOW_SECONDS
  const str = `${ticks * 10_000_000n}6A5AA1D4EAFF4E9FB37E23D68491D6F4`
  const [cs64, sha] = tokenHash(Buffer.from(str, 'ascii'))
  return `${cs64}-${sha}`
}
