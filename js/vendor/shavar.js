/* =====================================================================
 * shavar.js — SHA-256 written as a two-dimensional order-4 recurrence.
 *
 * See ../spec/SPEC.md (the algorithm) and ../spec/CLI.md (the encoding).
 * This file is the whole implementation. It has no dependencies, touches
 * no host facilities, and runs unchanged in three places:
 *
 *   - a browser, loaded with <script src="shavar.js"></script>
 *   - Safari's command-line JavaScript engine, `jsc shavar.js`
 *   - any other ES2017+ engine
 *
 * Everything it defines lands on a single global object, `SHAVAR`. There
 * is deliberately no `require`, no `import`, no `module.exports`: those
 * are three mutually incompatible module systems, none of which is part
 * of the language a browser gives you when it loads a plain script.
 *
 * ---------------------------------------------------------------------
 * THE CENTRAL HAZARD: JavaScript HAS NO INTEGER TYPE
 * ---------------------------------------------------------------------
 * If you come from C or Python, this is the one thing that will bite you,
 * and it bites hardest in exactly this kind of code. Read this before the
 * code; the rest of the file assumes you have.
 *
 * A JavaScript `number` is an IEEE-754 double. There is no `uint32_t`.
 * Integers are exact only while their magnitude stays below 2^53
 * (`Number.MAX_SAFE_INTEGER` = 9007199254740991); past that, addition
 * silently rounds instead of overflowing, and no error is raised.
 *
 *   (1) Bitwise operators are defined on SIGNED 32-bit integers.
 *       `&  |  ^  ~  <<  >>` all convert their operands with ToInt32 and
 *       produce a value in [-2^31, 2^31). So:
 *
 *           0xFFFFFFFF | 0        ===  -1        // not 4294967295
 *           0x80000000 ^ 0        === -2147483648
 *           0x12 << 24            ===  301989888 (fine)
 *           0xB0 << 24            === -1342177280 (negative!)
 *
 *       This means the natural way to assemble a big-endian word,
 *       `b0<<24 | b1<<16 | b2<<8 | b3`, produces a NEGATIVE number
 *       whenever the top bit is set. In C the same expression on
 *       `uint32_t` would be fine. Here it is not.
 *
 *   (2) `>>>` (unsigned right shift) is the ONE bitwise operator that
 *       yields an unsigned 32-bit value, via ToUint32. Hence the idiom
 *       that appears on nearly every line below:
 *
 *           x >>> 0
 *
 *       It shifts by zero — it does nothing to the bits — but it forces
 *       the result through ToUint32, giving a number in [0, 2^32).
 *       ToUint32 is defined as "truncate toward zero, then reduce
 *       modulo 2^32", so `x >>> 0` is *exactly* C's `(uint32_t)x` for
 *       any finite x, including x far larger than 2^32 and negative x.
 *       That is why it doubles as our modular reduction: for a sum of
 *       five words, each < 2^32, the true sum is < 5*2^32 ~= 2^34.4,
 *       which a double represents exactly, and `>>> 0` then reduces it
 *       mod 2^32 with no loss. The 2^53 headroom is what makes this safe;
 *       it is not luck, but it is worth stating rather than assuming.
 *
 *       You will also see `x | 0` in other people's JavaScript. That is
 *       the SIGNED counterpart (ToInt32) and is the wrong tool here: it
 *       would turn 0xFFFFFFFF into -1. This file never uses it.
 *
 *   (3) A typed array is the clean structural fix. `new Uint32Array(n)`
 *       is a fixed-length buffer of genuine unsigned 32-bit slots. Any
 *       value written to a slot is put through ToUint32 on the way in,
 *       so wraparound is automatic and reads always come back in
 *       [0, 2^32). This is real machine-word semantics, and it is core
 *       language — not a library. Every piece of state here (the round
 *       constants, the chaining value, the A/E tracks, the schedule)
 *       lives in a Uint32Array for that reason. The explicit `>>> 0`
 *       is kept anyway on values that pass through plain locals, so the
 *       intent is visible even where the typed array would have saved us.
 *
 * A related bound: bit lengths. SPEC.md §5 allows L < 2^64. A JavaScript
 * number is exact only to 2^53 - 1, so that is the honest limit here and
 * `hash()` rejects anything above it rather than quietly rounding. 2^53
 * bits is a petabyte of message; the restriction is theoretical, but
 * pretending it is absent would be a fabrication.
 * ===================================================================== */

(function attachShavar(root) {
  "use strict";

  /* `"use strict"` is not decoration: in sloppy mode, assigning to an
   * undeclared name silently creates a global. Strict mode makes that a
   * ReferenceError, which is the behaviour a C or Python programmer
   * already expects. */

  // -------------------------------------------------------------------
  // 0. Errors
  // -------------------------------------------------------------------

  /* One error type, carrying the process exit code that CLI.md assigns to
   * this class of failure (2 = bad usage / malformed input). Keeping the
   * code on the error means the CLI driver never has to guess. */
  class ShavarError extends Error {
    constructor(message, code = 2) {
      super(message);
      this.name = "ShavarError";
      this.code = code;
    }
  }

  // -------------------------------------------------------------------
  // 1. Constants (SPEC.md §9)
  // -------------------------------------------------------------------

  /* Uint32Array.from(...) rather than a plain array: the elements are then
   * genuinely uint32, and reading K[t] can never hand back a negative.
   * Note that the literals themselves are safe — 0xbb67ae85 as a *number
   * literal* is the positive value 3143530629. It is only bitwise
   * *operators* that would reinterpret it as negative. */

  /** First 32 bits of the fractional parts of sqrt(first 8 primes). */
  const IV = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  /** First 32 bits of the fractional parts of cbrt(first 64 primes). */
  const K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const ROUNDS = 64;          // full SHA-256
  const BLOCK_BYTES = 64;     // 512 bits
  const DIGEST_BYTES = 32;
  const MAX_BITS = Number.MAX_SAFE_INTEGER; // see the header note

  // -------------------------------------------------------------------
  // 2. The six round functions (SPEC.md §1.1)
  // -------------------------------------------------------------------
  //
  // Kept as six separate exported functions rather than inlined into one
  // expression, because SPEC.md §7.1 turns on which of them are
  // GF(2)-linear: the four sigmas are, Ch and Maj are not. Research code
  // needs to replace them one at a time.
  //
  // Arrow functions (`const f = (x) => expr`) are just function literals
  // with a terse syntax; `=>` reads as "returns".

  /** Circular right rotation. `n` must be in 1..31 — `x << 32` would be a
   *  no-op, since JS shift counts are taken modulo 32 like on x86. */
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

  /** Logical right shift, zero-filled. `>>>` is already the unsigned form. */
  const shr = (x, n) => x >>> n;

  /** Ch(x,y,z): bit i of x chooses between bit i of y and bit i of z. */
  const ch = (x, y, z) => ((x & y) ^ (~x & z)) >>> 0;

  /** Maj(x,y,z): bit i is the value occurring at least twice. */
  const maj = (x, y, z) => ((x & y) ^ (x & z) ^ (y & z)) >>> 0;

  const Sigma0 = (x) => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
  const Sigma1 = (x) => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
  const sigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ shr(x, 3)) >>> 0;
  const sigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ shr(x, 10)) >>> 0;

  // -------------------------------------------------------------------
  // 3. The message schedule as an order-16 recurrence (SPEC.md §4)
  // -------------------------------------------------------------------

  /**
   * Yield W[0..63] for one 64-byte block.
   *
   * This is a *generator*: `function*` plus `yield`. It is the same idea
   * as a Python generator — calling it runs no code, it returns a lazy
   * iterator, and each `yield` hands back one value and suspends. That
   * fits the schedule exactly, because W is defined as a recurrence
   * producing one word at a time, and it lets the consumer decide whether
   * to materialise all 64 words or stream them.
   *
   * Only a 16-word sliding window is retained. `(t - 2) & 15` is the
   * cheap form of `(t - 2) mod 16`, valid because 16 is a power of two
   * and t >= 16 in that branch, so no negative operand reaches `&`.
   * Note that W[t-16] and W[t] share the slot `t & 15`, which is why the
   * new value is computed fully before being written back.
   *
   * @param {Uint8Array} block 64 bytes
   * @yields {number} W[t], an unsigned 32-bit value
   */
  function* scheduleWords(block) {
    const w = new Uint32Array(16);

    for (let t = 0; t < 16; t++) {
      const j = 4 * t;
      // Big-endian assembly. The `>>> 0` is load-bearing: with block[j]
      // >= 0x80 the `<< 24` term is a negative int32, and without the
      // conversion the word would be wrong for every high-bit-set byte.
      w[t] = ((block[j] << 24) | (block[j + 1] << 16) |
              (block[j + 2] << 8) | block[j + 3]) >>> 0;
      yield w[t];
    }

    for (let t = 16; t < ROUNDS; t++) {
      const next = (sigma1(w[(t - 2) & 15]) + w[(t - 7) & 15] +
                    sigma0(w[(t - 15) & 15]) + w[t & 15]) >>> 0;
      w[t & 15] = next;
      yield next;
    }
  }

  /** The whole schedule as a Uint32Array(64). `TypedArray.from` accepts
   *  any iterable, so the generator drops straight in. */
  const schedule = (block) => Uint32Array.from(scheduleWords(block));

  // -------------------------------------------------------------------
  // 4. Compression: the 2D order-4 recurrence (SPEC.md §3)
  // -------------------------------------------------------------------
  //
  // The A and E arrays are indexed from t = -4, so every access is
  // written A[4 + t]. Doing the offset once, in a named local `i`, rather
  // than open-coding `+ 4` at each of the ten uses, is the difference
  // between a readable round body and an off-by-one hunt.

  /**
   * A complete record of one block's compression.
   * @typedef {Object} Trace
   * @property {Uint32Array} A   A[-4..rounds-1], stored at index 4 + t
   * @property {Uint32Array} E   E[-4..rounds-1], stored at index 4 + t
   * @property {Uint32Array} W   W[0..63] (always all 64; see CLI.md)
   * @property {Uint32Array} T1  T1[0..rounds-1]
   * @property {Uint32Array} T2  T2[0..rounds-1]
   * @property {Uint32Array} hIn  chaining value entering the block
   * @property {Uint32Array} hOut chaining value leaving the block
   * @property {number} rounds
   */

  /**
   * Compress one block into `h`, in place.
   *
   * `h` is a caller-supplied chaining value, and `rounds` may be < 64.
   * Neither is reachable from a normal hashing API and both are required
   * by SPEC.md §6: free-start (chosen-IV) attacks and reduced-round
   * distinguishers are the point of this repository.
   *
   * @param {Uint32Array} h      8 words, MUTATED to the outgoing value
   * @param {Uint8Array}  block  64 bytes
   * @param {number}      rounds 0..64 (0 = feed-forward only)
   * @param {boolean}     wantTrace
   * @returns {Trace|null}
   */
  function compress(h, block, rounds = ROUNDS, wantTrace = false) {
    // rounds === 0 is a legal degenerate case, not an error: no round runs
    // and the block contributes only its feed-forward. spec/CLI.md fixes the
    // range at 0..64 inclusive, and the other six implementations accept 0.
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > ROUNDS) {
      throw new ShavarError(`rounds must be an integer in 0..${ROUNDS}`);
    }

    const hIn = h.slice();               // copy, for the trace
    const W = schedule(block);
    const A = new Uint32Array(4 + rounds);
    const E = new Uint32Array(4 + rounds);
    const T1s = new Uint32Array(rounds);
    const T2s = new Uint32Array(rounds);

    /* Seeding, SPEC.md §3: A[-1]=H0 .. A[-4]=H3, E[-1]=H4 .. E[-4]=H7.
     * Written with destructuring assignment, which is JavaScript's
     * parallel-assignment form — the same shape as Python's
     * `a, b = b, a`. The left-hand side may be arbitrary assignment
     * targets, including typed-array elements. Index 4 + t, so
     * A[-1] -> A[3] and A[-4] -> A[0]. */
    [A[3], A[2], A[1], A[0]] = [h[0], h[1], h[2], h[3]];
    [E[3], E[2], E[1], E[0]] = [h[4], h[5], h[6], h[7]];

    for (let t = 0; t < rounds; t++) {
      const i = 4 + t;

      /* Five-term sum: each term is < 2^32, so the exact total is
       * < 5 * 2^32 < 2^35, comfortably inside a double's exact integer
       * range. `>>> 0` then reduces it modulo 2^32. This is where a
       * naive port of C code goes wrong in JavaScript, and where a port
       * that reduces after every single addition does needless work. */
      const T1 = (E[i - 4] + Sigma1(E[i - 1]) + ch(E[i - 1], E[i - 2], E[i - 3]) +
                  K[t] + W[t]) >>> 0;
      const T2 = (Sigma0(A[i - 1]) + maj(A[i - 1], A[i - 2], A[i - 3])) >>> 0;

      E[i] = (A[i - 4] + T1) >>> 0;
      A[i] = (T1 + T2) >>> 0;

      T1s[t] = T1;
      T2s[t] = T2;
    }

    /* Feed-forward. `last` indexes A[rounds-1]; the four terms are the
     * final window A[rounds-1 .. rounds-4]. For rounds < 4 the window
     * legitimately reaches back into the seeds, which is exactly what
     * the sliding-window reading of SPEC.md §3 says it should do — and
     * is why the arrays carry their four-element prologue rather than
     * treating the seeds as separate variables. */
    const last = 3 + rounds;
    for (let j = 0; j < 4; j++) {
      h[j] = (h[j] + A[last - j]) >>> 0;
      h[4 + j] = (h[4 + j] + E[last - j]) >>> 0;
    }

    return wantTrace
      ? { A, E, W, T1: T1s, T2: T2s, hIn, hOut: h.slice(), rounds }
      : null;
  }

  // -------------------------------------------------------------------
  // 5. Padding for arbitrary bit length (SPEC.md §5)
  // -------------------------------------------------------------------

  /** Reject a bit count we cannot represent exactly. */
  function checkBitLength(nbits) {
    if (typeof nbits !== "number" || !Number.isInteger(nbits) || nbits < 0) {
      throw new ShavarError(`nbits must be a non-negative integer, got ${nbits}`);
    }
    if (nbits > MAX_BITS) {
      throw new ShavarError(
        `nbits ${nbits} exceeds ${MAX_BITS}, the largest bit count a JavaScript ` +
        `number represents exactly (SPEC.md allows up to 2^64)`);
    }
  }

  /**
   * SPEC.md §5.1: when nbits % 8 != 0 the final byte carries its
   * significant bits in the HIGH-order positions and its low bits must be
   * zero. We reject rather than mask, because masking maps two distinct
   * inputs to the same digest and hides the caller's bug.
   */
  function checkTrailingBits(msg, nbits) {
    const rem = nbits % 8;
    if (rem === 0) return;
    const lastByte = msg[(nbits - rem) / 8];
    const junk = lastByte & ((1 << (8 - rem)) - 1);
    if (junk !== 0) {
      throw new ShavarError(
        `final byte 0x${lastByte.toString(16).padStart(2, "0")} has nonzero bits ` +
        `below bit ${8 - rem}; with nbits=${nbits} the low ${8 - rem} bits must be zero`);
    }
  }

  /** Number of 512-bit blocks the padded message occupies. */
  function paddedBlocks(nbits) {
    checkBitLength(nbits);
    // k = smallest non-negative solution of nbits + 1 + k = 448 (mod 512).
    // JS `%` keeps the sign of the dividend (like C, unlike Python), so the
    // "+ 512) % 512" is not superstition — for nbits > 447 the first
    // remainder really is negative.
    const k = (((447 - nbits) % 512) + 512) % 512;
    return (nbits + 1 + k + 64) / 512;
  }

  /**
   * Materialise block `idx` of the padded message without building the
   * whole padded stream.
   *
   * @param {Uint8Array} msg  ceil(nbits/8) bytes
   * @param {number} nbits
   * @param {number} idx
   * @returns {Uint8Array} 64 bytes
   */
  function paddedBlock(msg, nbits, idx) {
    const nblocks = paddedBlocks(nbits);
    if (!Number.isInteger(idx) || idx < 0 || idx >= nblocks) {
      throw new ShavarError(`block index ${idx} out of range 0..${nblocks - 1}`);
    }
    if (msg.length !== Math.ceil(nbits / 8)) {
      throw new ShavarError(
        `message is ${msg.length} bytes but nbits=${nbits} needs ${Math.ceil(nbits / 8)}`);
    }
    checkTrailingBits(msg, nbits);

    const out = new Uint8Array(BLOCK_BYTES);  // zero-filled by construction
    const totalBytes = nblocks * BLOCK_BYTES;
    const rem = nbits % 8;
    const fullBytes = (nbits - rem) / 8;      // whole message bytes
    const base = idx * BLOCK_BYTES;

    for (let j = 0; j < BLOCK_BYTES; j++) {
      const gi = base + j;                    // index into the padded stream

      if (gi < fullBytes) {
        out[j] = msg[gi];
      } else if (gi === fullBytes) {
        /* The byte where the appended `1` bit lands: bit offset nbits is
         * bit 7 - (nbits mod 8) of byte floor(nbits/8). When rem is 0 the
         * whole byte is 0x80; otherwise the bit is ORed into the partial
         * message byte. SPEC.md §5.2 worked example: nbits=5, msg 0xb0,
         * gives 0xb0 | (0x80 >>> 5) = 0xb0 | 0x04 = 0xb4. */
        out[j] = rem === 0 ? 0x80 : (msg[gi] | (0x80 >>> rem));
      } else if (gi >= totalBytes - 8) {
        /* The 64-bit big-endian bit count. There is no 64-bit integer
         * type, so it is carried as a pair of 32-bit halves. `nbits >>> 0`
         * is ToUint32, i.e. nbits mod 2^32 — the low half — and the
         * floor-divide gives the high half. */
        const tail = gi - (totalBytes - 8);   // 0..7
        const hi = Math.floor(nbits / 4294967296) >>> 0;
        const lo = nbits >>> 0;
        const word = tail < 4 ? hi : lo;
        out[j] = (word >>> (8 * (3 - (tail & 3)))) & 0xff;
      }
      /* else: leave the zero the Uint8Array was born with. */
    }
    return out;
  }

  // -------------------------------------------------------------------
  // 6. Hashing
  // -------------------------------------------------------------------

  /**
   * Digest of `nbits` bits of `msg`, from a caller-chosen IV and round
   * count.
   *
   * The options object with destructured defaults —
   * `{ iv = IV, rounds = ROUNDS } = {}` — is the idiomatic JavaScript
   * substitute for keyword arguments. The trailing `= {}` makes the whole
   * options argument optional; without it, calling with no third argument
   * would try to destructure `undefined` and throw.
   *
   * @param {Uint8Array} msg
   * @param {number} nbits
   * @param {{iv?: Uint32Array, rounds?: number}} [opts]
   * @returns {Uint8Array} 32 bytes
   */
  function hashEx(msg, nbits, { iv = IV, rounds = ROUNDS } = {}) {
    checkBitLength(nbits);
    if (iv.length !== 8) throw new ShavarError("iv must have 8 words");

    const h = Uint32Array.from(iv);   // copy: never mutate the caller's IV
    const nblocks = paddedBlocks(nbits);
    for (let i = 0; i < nblocks; i++) {
      compress(h, paddedBlock(msg, nbits, i), rounds, false);
    }

    const out = new Uint8Array(DIGEST_BYTES);
    for (let i = 0; i < 8; i++) {
      out[4 * i] = (h[i] >>> 24) & 0xff;
      out[4 * i + 1] = (h[i] >>> 16) & 0xff;
      out[4 * i + 2] = (h[i] >>> 8) & 0xff;
      out[4 * i + 3] = h[i] & 0xff;
    }
    return out;
  }

  /** Plain SHA-256: FIPS IV, 64 rounds. */
  const hash = (msg, nbits) => hashEx(msg, nbits);

  /** Digest as 64 lowercase hex characters. */
  const hashHex = (msg, nbits, opts) => bytesToHex(hashEx(msg, nbits, opts));

  /**
   * The full interior of the compression of one padded block, having run
   * the preceding blocks to get the correct incoming chaining value.
   */
  function traceBlock(msg, nbits, idx = 0, { iv = IV, rounds = ROUNDS } = {}) {
    checkBitLength(nbits);
    const h = Uint32Array.from(iv);
    let tr = null;
    for (let i = 0; i <= idx; i++) {
      tr = compress(h, paddedBlock(msg, nbits, i), rounds, i === idx);
    }
    return tr;
  }

  // -------------------------------------------------------------------
  // 7. Encoding helpers
  // -------------------------------------------------------------------

  /** Lowercase, zero-padded, exactly 8 hex digits. */
  const hex8 = (x) => (x >>> 0).toString(16).padStart(8, "0");

  /** Bytes to lowercase hex.
   *  `Array.from(bytes, fn)` maps over the typed array without first
   *  copying it; `map` on a typed array would return another typed array
   *  and truncate the strings back to numbers. */
  const bytesToHex = (bytes) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  /** Hex to bytes, strict: even length, hex digits only. */
  function hexToBytes(hex) {
    if (hex === "-") return new Uint8Array(0);
    if (typeof hex !== "string" || hex.length % 2 !== 0) {
      throw new ShavarError(`hex string must have an even number of digits: "${hex}"`);
    }
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      throw new ShavarError(`not hexadecimal: "${hex}"`);
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(2 * i, 2), 16);
    }
    return out;
  }

  /**
   * UTF-8 encode a string, by hand.
   *
   * `TextEncoder` would do this in browsers but does not exist in `jsc`,
   * and the project forbids dependencies, so the eleven lines are cheaper
   * than a conditional. Note the surrogate-pair step: a JavaScript string
   * is a sequence of UTF-16 code units, so characters outside the Basic
   * Multilingual Plane arrive as two units. `codePointAt` reads the whole
   * code point, and the index advance skips the low surrogate.
   */
  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++;                    // skip the low surrogate
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
                 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return Uint8Array.from(out);
  }

  /**
   * Render a trace in the exact tab-separated form of CLI.md, including
   * the trailing newline. Shared by the command-line driver and the HTML
   * page so the two can never drift apart.
   */
  function formatTrace(tr) {
    const lines = [];
    const push = (tag, i, v) => lines.push(`${tag}\t${i}\t${hex8(v)}`);

    for (let i = 0; i < 8; i++) push("HIN", i, tr.hIn[i]);
    for (let t = 0; t < ROUNDS; t++) push("W", t, tr.W[t]);
    for (let t = -4; t < tr.rounds; t++) push("A", t, tr.A[4 + t]);
    for (let t = -4; t < tr.rounds; t++) push("E", t, tr.E[4 + t]);
    for (let t = 0; t < tr.rounds; t++) push("T1", t, tr.T1[t]);
    for (let t = 0; t < tr.rounds; t++) push("T2", t, tr.T2[t]);
    for (let i = 0; i < 8; i++) push("HOUT", i, tr.hOut[i]);

    return lines.join("\n") + "\n";
  }

  // -------------------------------------------------------------------
  // 8. Known-answer vectors and the self-test
  // -------------------------------------------------------------------
  //
  // Expected digests were produced by an independent implementation in a
  // different language (Python) written in the STANDARD eight-register
  // form, itself cross-checked against the platform's own SHA-256 on all
  // byte-aligned inputs. So these values test the 2D recurrence of
  // SPEC.md §3 against the FIPS presentation of §2, not merely against
  // themselves. The four classic digests (empty, "abc", the 448-bit and
  // 896-bit strings, and one million 'a') are the published FIPS values.

  const REPEAT = (byte, n) => new Uint8Array(n).fill(byte);

  const VECTORS = [
    // --- the classics, byte-aligned -----------------------------------
    { name: "empty", hex: "-", nbits: 0,
      expect: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { name: "abc", hex: "616263", nbits: 24,
      expect: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    { name: "448-bit alphabet", nbits: 448,
      hex: "6162636462636465636465666465666765666768666768696768696a68696a6b" +
           "696a6b6c6a6b6c6d6b6c6d6e6c6d6e6f6d6e6f706e6f7071",
      expect: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" },
    { name: "896-bit alphabet (two blocks)", nbits: 896,
      hex: "61626364656667686263646566676869636465666768696a6465666768696a6b" +
           "65666768696a6b6c666768696a6b6c6d6768696a6b6c6d6e68696a6b6c6d6e6f" +
           "696a6b6c6d6e6f706a6b6c6d6e6f70716b6c6d6e6f7071726c6d6e6f70717273" +
           "6d6e6f70717273746e6f707172737475",
      expect: "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1" },
    { name: "one million 'a'", nbits: 8000000, make: () => REPEAT(0x61, 1000000),
      expect: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0" },

    // --- sub-byte bit lengths (SPEC.md §5) ----------------------------
    { name: "1 bit '1'", hex: "80", nbits: 1,
      expect: "b9debf7d52f36e6468a54817c1fa071166c3a63d384850e1575b42f702dc5aa1" },
    { name: "5 bits '10110' (SPEC.md §5.2)", hex: "b0", nbits: 5,
      expect: "82c9ef980dfdf26f0cb97f59d34a60dc39c82e489da9ca2132681fe0aa14270a" },
    /* 0xb8 = 1011_1000. The five message bits are 10111 and the three low
     * bits are already zero, so this is VALID and must be accepted — the
     * mirror image of the 0xb4 rejection case in STRUCTURAL below. A
     * validator that refused every byte with a set bit in the low nibble
     * would pass the rejection test and fail here. */
    { name: "5 bits '10111' (valid, low bits zero)", hex: "b8", nbits: 5,
      expect: "9103bf6cd9f1134d81807ade91d54d9888b1a3df1f947f735ce00220dca5261c" },
    { name: "7 bits '1111111'", hex: "fe", nbits: 7,
      expect: "7bbca3be22fe9d6a58cb656c5a3ab902aac8fba77c7b464eb94c2c50eba0e1d1" },
    { name: "9 bits", hex: "ff80", nbits: 9,
      expect: "6a9d7293537d56731cf8c72552b48833cfe3111bff4f3a7b90657431fd87931e" },

    // --- the block-boundary neighbourhood -----------------------------
    { name: "447 bits (last that fits one block)", nbits: 447,
      make: () => { const m = REPEAT(0xaa, 56); m[55] = 0xaa & 0xfe; return m; },
      expect: "442050a57b1363bce7f93ffdd39e1b1b74149360852f7023f8a505d9af36862a" },
    { name: "448 bits (padding spills to a 2nd block)", nbits: 448,
      make: () => REPEAT(0xaa, 56),
      expect: "d464bb04abbc80a2254cd4ad0f3356f1b70b5b6390085b193edcd291f065b01e" },
    { name: "449 bits", nbits: 449,
      make: () => { const m = REPEAT(0xaa, 57); m[56] = 0x80; return m; },
      expect: "cb668060ff99f154b93d846df7aa104b94f0fd3b0b52e0a2ebf3fd14bdd36f46" },
    { name: "503 bits", nbits: 503,
      make: () => { const m = REPEAT(0x5a, 63); m[62] = 0x5a & 0xfe; return m; },
      expect: "7b036c70936fbb657713551b4852944f8d17854dd4bdd7b6c5388227d39d4df3" },
    { name: "511 bits", nbits: 511,
      make: () => { const m = REPEAT(0xff, 64); m[63] = 0xfe; return m; },
      expect: "72c10a554047e0b01956ca3c5c2f4e968b78ff427e3c904774d51c1045447a40" },
    { name: "512 bits (exactly one block of message)", nbits: 512,
      make: () => REPEAT(0xff, 64),
      expect: "8667e718294e9e0df1d30600ba3eeb201f764aad2dad72748643e4a285e1d1f7" },
    { name: "513 bits", nbits: 513,
      make: () => { const m = REPEAT(0xff, 65); m[64] = 0x80; return m; },
      expect: "dcd50b6c8a8b9329b91930476c54d6e702ff6c23ef998cb2c3ad6fe81337b77c" },

    // --- reduced rounds (SPEC.md §6) ----------------------------------
    { name: "abc, 1 round", hex: "616263", nbits: 24, rounds: 1,
      expect: "c774d234257194ecf7d6a1f7e1bee8ac4b3898a1ec13bb0bba8942377b64a6c4" },
    { name: "abc, 16 rounds", hex: "616263", nbits: 24, rounds: 16,
      expect: "1b0409f57bcc0e6315a1de882ce11eca5867604ca6985a9893de22897a384f31" },
    { name: "abc, 32 rounds", hex: "616263", nbits: 24, rounds: 32,
      expect: "ddbd225ca600d8a7dc74fea2db8478030b6763919c0f13c6cd6b6de2bcf370d0" },

    // --- free start: a caller-supplied chaining value (SPEC.md §6) -----
    { name: "abc, free-start IV", hex: "616263", nbits: 24,
      iv: [0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210,
           0x0f1e2d3c, 0x4b5a6978, 0x8796a5b4, 0xc3d2e1f0],
      expect: "4dc4541421359ca8177513ca4145df34bf18c4a02122d45cb10d5b3dcf8a1237" },
    { name: "abc, free-start IV, 24 rounds", hex: "616263", nbits: 24, rounds: 24,
      iv: [0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210,
           0x0f1e2d3c, 0x4b5a6978, 0x8796a5b4, 0xc3d2e1f0],
      expect: "eefc30313b76103de7f972a6996076bff538ae1c273624acbcc57b60cdb504e4" },
  ];

  /* Two structural checks that no digest vector would catch. */
  const STRUCTURAL = [
    /* Both directions of the SPEC.md §5.1 rule, deliberately paired.
     * Testing only the rejection would be passed by a validator that
     * rejects everything; testing only the acceptance would be passed by
     * one that validates nothing. With nbits = 5 the low three bits of
     * the single message byte must be zero:
     *     0xb0 = 1011_0000  low bits 000 -> valid
     *     0xb8 = 1011_1000  low bits 000 -> valid
     *     0xb4 = 1011_0100  low bits 100 -> invalid
     * and the two valid bytes must give *different* digests, which is the
     * whole reason the standard forbids silent masking. */
    {
      name: "trailing-bit rule accepts 0xb0/5 and 0xb8/5 and separates them",
      run() {
        const a = hashHex(hexToBytes("b0"), 5);
        const b = hashHex(hexToBytes("b8"), 5);
        return a !== b &&
               a === "82c9ef980dfdf26f0cb97f59d34a60dc39c82e489da9ca2132681fe0aa14270a" &&
               b === "9103bf6cd9f1134d81807ade91d54d9888b1a3df1f947f735ce00220dca5261c";
      },
    },
    {
      name: "trailing-bit rule rejects 0xb4/5 rather than masking it",
      run() {
        try {
          hash(hexToBytes("b4"), 5);
        } catch (e) {
          return e instanceof ShavarError && e.code === 2;
        }
        return false;   // accepting it would be the silent-masking bug
      },
    },
    {
      name: "every byte with zero low bits is accepted at nbits=5 (32 of 256)",
      run() {
        let accepted = 0;
        for (let b = 0; b < 256; b++) {
          const msg = Uint8Array.of(b);
          let ok = true;
          try { hash(msg, 5); } catch (e) { ok = false; }
          if (ok !== ((b & 0x07) === 0)) return false;   // exact agreement
          if (ok) accepted++;
        }
        return accepted === 32;
      },
    },
    {
      name: "the 2D form is unsigned everywhere (no negative word in a trace)",
      run() {
        const tr = traceBlock(hexToBytes("616263"), 24, 0);
        const allWords = [tr.A, tr.E, tr.W, tr.T1, tr.T2, tr.hIn, tr.hOut];
        return allWords.every((arr) => Array.from(arr).every((v) => v >= 0 && v < 4294967296));
      },
    },
    {
      name: "padded length is a multiple of 512 bits for every L in 0..2048",
      run() {
        for (let L = 0; L <= 2048; L++) {
          const n = paddedBlocks(L);
          if (!Number.isInteger(n) || n * 512 < L + 65) return false;
          if ((n - 1) * 512 >= L + 65) return false;   // and it is the smallest
        }
        return true;
      },
    },
  ];

  /**
   * Run every vector.
   * @returns {{total:number, passed:number, failures:Array}}
   */
  function selftest() {
    const failures = [];
    let passed = 0;

    for (const v of VECTORS) {
      const msg = v.make ? v.make() : hexToBytes(v.hex);
      const opts = {};
      if (v.rounds !== undefined) opts.rounds = v.rounds;
      if (v.iv !== undefined) opts.iv = Uint32Array.from(v.iv);

      let actual;
      try {
        actual = hashHex(msg, v.nbits, opts);
      } catch (e) {
        actual = `threw: ${e.message}`;
      }
      if (actual === v.expect) passed++;
      else failures.push({ name: v.name, input: `${v.hex || "<generated>"} ${v.nbits}`,
                           expect: v.expect, actual });
    }

    for (const c of STRUCTURAL) {
      let ok;
      try {
        ok = c.run() === true;
      } catch (e) {
        ok = false;
      }
      if (ok) passed++;
      else failures.push({ name: c.name, input: "<structural>",
                           expect: "true", actual: "false" });
    }

    return { total: VECTORS.length + STRUCTURAL.length, passed, failures };
  }

  // -------------------------------------------------------------------
  // 9. Export
  // -------------------------------------------------------------------
  //
  // One global object, assembled with shorthand property names (`{ hash }`
  // means `{ hash: hash }`). `Object.freeze` makes the surface read-only,
  // so a page that loads this file cannot accidentally shadow a function
  // and produce a wrong digest that looks authoritative.

  root.SHAVAR = Object.freeze({
    // constants
    IV, K, ROUNDS, BLOCK_BYTES, DIGEST_BYTES, MAX_BITS,
    // round functions (SPEC.md §1.1), individually addressable
    rotr, shr, ch, maj, Sigma0, Sigma1, sigma0, sigma1,
    // schedule (SPEC.md §4)
    scheduleWords, schedule,
    // compression (SPEC.md §3)
    compress, traceBlock,
    // padding (SPEC.md §5)
    paddedBlocks, paddedBlock, checkTrailingBits, checkBitLength,
    // hashing (SPEC.md §6)
    hash, hashEx, hashHex,
    // encoding
    hex8, bytesToHex, hexToBytes, utf8Bytes, formatTrace,
    // testing
    VECTORS, selftest, ShavarError,
  });

  /* `globalThis` is the standard name for the global object in every
   * environment (Safari 12.1+, and jsc). The fallback keeps the file
   * working in an ancient browser: inside a non-strict function invoked
   * with no receiver, `this` is the global object, and the IIFE below is
   * called from sloppy top-level code precisely so that remains true. */
})(typeof globalThis !== "undefined" ? globalThis : this);
