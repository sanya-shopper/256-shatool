/*
 * shatool/js/model.js — the data model.
 *
 * This file contains no DOM access of any kind. It owns the message being
 * hashed, the derived SHA-256 computation, and the queries the views need to
 * ask about them. The views (js/ui-*.js) read from here and never compute
 * anything cryptographic themselves.
 *
 * That separation is not decoration. A bug in a renderer produces a picture
 * that looks wrong; a bug in the model produces a picture that looks right
 * and is wrong, which is the failure mode this tool exists to avoid. Keeping
 * the model DOM-free is what lets tests/run.js exercise all of it headlessly.
 *
 * Loaded as a classic script — no import/export — so that index.html opens
 * from a file:// URL without a web server. Depends on the global SHAVAR from
 * js/vendor/shavar.js, which must be loaded first.
 */

(function (root) {
  "use strict";

  if (!root.SHAVAR) {
    throw new Error("model.js requires js/vendor/shavar.js to be loaded first");
  }
  var S = root.SHAVAR;

  // -------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------

  /* The default message length, in bits. Chosen because it is awkward in
   * three separate ways at once, and each one is a thing worth seeing:
   *
   *   - It is not a multiple of 8, so the final byte carries exactly one
   *     significant bit and seven that must be zero.
   *   - It is one bit past 512, so padding cannot fit in the first block and
   *     the message occupies two blocks. Block 1 is almost entirely padding.
   *   - The chaining value entering block 1 is therefore a real, computed
   *     value rather than the FIPS IV, so the two-block path is exercised.
   */
  var DEFAULT_NBITS = 513;

  /* Hard ceiling on what the UI will accept. SHA-256 itself allows up to
   * 2^64 - 1 bits; this tool renders every bit of the message and every
   * round of every block, so the real limit is what a browser can draw.
   * Eight blocks is already 4096 bits of input and 512 rounds of trace. */
  var MAX_NBITS = 4096;

  // -------------------------------------------------------------------
  // 2. Message state
  // -------------------------------------------------------------------
  //
  // A message is a byte array plus a bit count, exactly as spec/CLI.md in the
  // shavar repo defines it: `bytes` has ceil(nbits/8) entries, and when nbits
  // is not a multiple of 8 the final byte holds its significant bits in the
  // HIGH-order positions with the low-order bits zero.
  //
  // Bit numbering throughout this file is big-endian and 0-based from the
  // front of the message: bit 0 is the most significant bit of byte 0. That
  // matches how SHA-256 itself consumes the message, and how the padding is
  // specified, so the UI never has to reverse anything to explain itself.

  /** Number of bytes needed to hold `nbits` bits. */
  function byteLength(nbits) {
    return Math.ceil(nbits / 8);
  }

  /** Mask of the significant bits in the final byte; 0xff when byte-aligned. */
  function finalByteMask(nbits) {
    var rem = nbits % 8;
    return rem === 0 ? 0xff : (0xff << (8 - rem)) & 0xff;
  }

  /**
   * Create a message state of `nbits` zero bits.
   * @returns {{bytes: Uint8Array, nbits: number}}
   */
  function createMessage(nbits) {
    checkNbits(nbits);
    return { bytes: new Uint8Array(byteLength(nbits)), nbits: nbits };
  }

  function checkNbits(nbits) {
    if (!Number.isInteger(nbits) || nbits < 0 || nbits > MAX_NBITS) {
      throw new Error("nbits must be an integer in 0.." + MAX_NBITS);
    }
  }

  /**
   * Fill a message with cryptographically random bits.
   *
   * `crypto.getRandomValues` is used where available. The trailing bits of
   * the final byte are then cleared, because a message state that violates
   * the low-bits-must-be-zero rule is rejected by SHAVAR and would leave the
   * tool showing an error on first load.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg MUTATED
   */
  function randomize(msg) {
    var c = root.crypto || root.msCrypto;
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(msg.bytes);
    } else {
      /* Fallback for environments without WebCrypto. This is a visualization
       * toy, not a key generator, so Math.random is adequate here — but it is
       * worth being explicit that it is a fallback and not the intent. */
      for (var i = 0; i < msg.bytes.length; i++) {
        msg.bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    clearTrailingBits(msg);
    return msg;
  }

  /**
   * Randomize a contiguous run of `width` bits starting at bit `start`.
   *
   * This is the search primitive: it plays the part a nonce plays in mining,
   * varying one window of the input while everything around it is held fixed.
   *
   * Whole bytes inside the window are filled a byte at a time and only the
   * ragged edges are written bit by bit. That matters because the sampler
   * calls this in tight loops — a bit-at-a-time implementation spends most of
   * its time in the random source rather than in SHA-256, which is the thing
   * actually being sampled.
   *
   * `rand` returns a float in [0, 1) and defaults to Math.random. This is a
   * search toy, not a key generator, so the quality of Math.random is not a
   * concern; being injectable makes the sampler deterministic under test.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg MUTATED
   * @param {number} start first bit of the window
   * @param {number} width number of bits
   * @param {function():number} [rand]
   */
  function randomizeRegion(msg, start, width, rand) {
    var r = rand || Math.random;
    var lo = Math.max(0, start);
    var hi = Math.min(msg.nbits, start + width);
    if (hi <= lo) return msg;

    var firstWhole = Math.ceil(lo / 8);   // first byte fully inside
    var lastWhole = Math.floor(hi / 8);   // one past the last fully inside

    var i;
    for (i = lo; i < Math.min(firstWhole * 8, hi); i++) {
      setBit(msg, i, r() < 0.5 ? 1 : 0);
    }
    for (var b = firstWhole; b < lastWhole; b++) {
      msg.bytes[b] = (r() * 256) | 0;
    }
    for (i = Math.max(lo, lastWhole * 8); i < hi; i++) {
      setBit(msg, i, r() < 0.5 ? 1 : 0);
    }
    return clearTrailingBits(msg);
  }

  /** Zero the insignificant low bits of the final byte. */
  function clearTrailingBits(msg) {
    var n = msg.bytes.length;
    if (n > 0) msg.bytes[n - 1] &= finalByteMask(msg.nbits);
    return msg;
  }

  /** Read message bit `i` (0-based, big-endian from the front). */
  function getBit(msg, i) {
    if (i < 0 || i >= msg.nbits) return 0;
    return (msg.bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }

  /** Write message bit `i`. Out-of-range indices are ignored, not an error. */
  function setBit(msg, i, value) {
    if (i < 0 || i >= msg.nbits) return msg;
    var mask = 1 << (7 - (i & 7));
    if (value) msg.bytes[i >> 3] |= mask;
    else msg.bytes[i >> 3] &= ~mask;
    return msg;
  }

  /** Flip message bit `i`. */
  function toggleBit(msg, i) {
    return setBit(msg, i, getBit(msg, i) ^ 1);
  }

  /**
   * Set byte `idx` to `value`, masking off any bits beyond `nbits`.
   *
   * The mask matters: the hex editor lets you type into the final byte of a
   * 513-bit message, where only the top bit is real. Typing `ff` there must
   * store `80`, not `ff`, or the message state becomes one SHAVAR rejects.
   */
  function setByte(msg, idx, value) {
    if (idx < 0 || idx >= msg.bytes.length) return msg;
    var v = value & 0xff;
    if (idx === msg.bytes.length - 1) v &= finalByteMask(msg.nbits);
    msg.bytes[idx] = v;
    return msg;
  }

  /**
   * Change the message length, preserving as many leading bits as possible.
   *
   * Growing appends zero bits; shrinking discards from the end. Either way
   * the trailing-bit rule is re-established afterwards, so the result is
   * always a legal message state.
   */
  function resize(msg, nbits) {
    checkNbits(nbits);
    var next = new Uint8Array(byteLength(nbits));
    next.set(msg.bytes.subarray(0, Math.min(msg.bytes.length, next.length)));
    msg.bytes = next;
    msg.nbits = nbits;
    return clearTrailingBits(msg);
  }

  /** Lowercase hex of the message bytes; "" for a zero-byte message. */
  function messageHex(msg) {
    return S.bytesToHex(msg.bytes);
  }

  /**
   * Replace the message from a hex string, keeping `nbits` unchanged.
   *
   * Accepts optional whitespace and an optional `0x` prefix, and tolerates an
   * odd number of digits by treating the string as left-aligned and padding
   * the final nibble with zeros — which is what a person editing hex in place
   * means when they have typed half a byte so far.
   *
   * @throws {Error} on non-hex characters or too many digits
   */
  function setMessageHex(msg, text) {
    var clean = String(text).replace(/\s+/g, "").replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]*$/.test(clean)) {
      throw new Error("not hexadecimal: " + text);
    }
    if (clean.length > msg.bytes.length * 2) {
      throw new Error(
        "too many hex digits for " + msg.nbits + " bits: expected at most " +
        msg.bytes.length * 2 + ", got " + clean.length);
    }
    if (clean.length % 2 === 1) clean += "0";
    var bytes = S.hexToBytes(clean);
    msg.bytes.fill(0);
    msg.bytes.set(bytes);
    return clearTrailingBits(msg);
  }

  // -------------------------------------------------------------------
  // 3. Padding, described rather than merely applied
  // -------------------------------------------------------------------
  //
  // SHAVAR builds padded blocks internally. The UI needs to *explain* the
  // padding as well as consume it, so this section reports its structure:
  // where the message ends, where the mandatory 1 bit sits, how many zero
  // bits follow, and where the 64-bit length field lands.

  /**
   * Describe the padding for a message of `nbits` bits.
   *
   * @returns {{nbits: number, nblocks: number, totalBits: number,
   *            oneBitIndex: number, zeroBits: number,
   *            lengthFieldStart: number}}
   */
  function paddingLayout(nbits) {
    var nblocks = S.paddedBlocks(nbits);
    var totalBits = nblocks * 512;
    return {
      nbits: nbits,
      nblocks: nblocks,
      totalBits: totalBits,
      oneBitIndex: nbits,               // the mandatory '1' bit
      zeroBits: totalBits - nbits - 1 - 64,
      lengthFieldStart: totalBits - 64, // 64-bit big-endian bit count
    };
  }

  /**
   * Classify bit `i` of the padded stream.
   * @returns {"message"|"one"|"zero"|"length"}
   */
  function bitRole(layout, i) {
    if (i < layout.nbits) return "message";
    if (i === layout.oneBitIndex) return "one";
    if (i >= layout.lengthFieldStart) return "length";
    return "zero";
  }

  // -------------------------------------------------------------------
  // 4. The computation
  // -------------------------------------------------------------------

  /**
   * Everything the views need about one message, computed once.
   *
   * The traces are the expensive part and are the reason this is a single
   * function rather than a set of independent getters: `traceBlock` re-runs
   * every preceding block to obtain the correct incoming chaining value, so
   * asking for block k costs k+1 compressions. Tracing all blocks in one
   * pass here is O(n) instead of the O(n^2) that repeated calls would cost.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg
   * @param {{rounds?: number}} [opts]
   * @returns {Object} an analysis (see fields below)
   */
  function analyze(msg, opts) {
    var rounds = (opts && opts.rounds !== undefined) ? opts.rounds : S.ROUNDS;
    var layout = paddingLayout(msg.nbits);

    /* Walk the blocks once, carrying the chaining value forward by hand.
     * `compress` mutates `h` in place and returns the trace for the block it
     * just did, which is exactly the shape this loop wants. */
    var h = Uint32Array.from(S.IV);
    var blocks = [];
    for (var i = 0; i < layout.nblocks; i++) {
      var block = S.paddedBlock(msg.bytes, msg.nbits, i);
      var trace = S.compress(h, block, rounds, true);
      blocks.push({ index: i, bytes: block, trace: trace });
    }

    /* The digest is the final chaining value, big-endian per word. Derived
     * from the same `h` the loop just produced rather than by calling
     * hashEx() again — a second, independent computation could disagree with
     * the traces on screen, and a tool that shows a digest its own trace does
     * not produce is worse than no tool. */
    var digest = new Uint8Array(32);
    for (var w = 0; w < 8; w++) {
      digest[4 * w] = (h[w] >>> 24) & 0xff;
      digest[4 * w + 1] = (h[w] >>> 16) & 0xff;
      digest[4 * w + 2] = (h[w] >>> 8) & 0xff;
      digest[4 * w + 3] = h[w] & 0xff;
    }

    return {
      nbits: msg.nbits,
      rounds: rounds,
      layout: layout,
      blocks: blocks,
      digest: digest,
      digestHex: S.bytesToHex(digest),
    };
  }

  // -------------------------------------------------------------------
  // 5. Trace access
  // -------------------------------------------------------------------
  //
  // The A and E arrays are stored with a four-element prologue: index 4 + t,
  // so t runs from -4. Every reader would otherwise have to remember that
  // offset, and one that forgets it is off by four rounds and still draws a
  // plausible picture. These accessors are the only place the +4 appears.

  /** A[t] or E[t] for t in -4 .. rounds-1. */
  function track(trace, name, t) {
    var arr = trace[name];
    var i = 4 + t;
    if (i < 0 || i >= arr.length) return undefined;
    return arr[i];
  }

  /** The inclusive index range of t for the A/E tracks of a trace. */
  function trackRange(trace) {
    return { min: -4, max: trace.rounds - 1 };
  }

  /**
   * Everything about one round, for the detail panel.
   *
   * Recomputes the round's intermediate terms (Sigma1, Ch, Sigma0, Maj) from
   * the trace rather than storing them, so what is displayed is a function of
   * the same A/E values being drawn on the canvas and cannot drift from them.
   *
   * @returns {Object|null} null when `t` is outside the traced rounds
   */
  function roundDetail(trace, t) {
    if (t < 0 || t >= trace.rounds) return null;
    var e1 = track(trace, "E", t - 1);
    var e2 = track(trace, "E", t - 2);
    var e3 = track(trace, "E", t - 3);
    var e4 = track(trace, "E", t - 4);
    var a1 = track(trace, "A", t - 1);
    var a2 = track(trace, "A", t - 2);
    var a3 = track(trace, "A", t - 3);
    var a4 = track(trace, "A", t - 4);
    return {
      t: t,
      W: trace.W[t],
      K: S.K[t],
      Ein: [e1, e2, e3, e4],
      Ain: [a1, a2, a3, a4],
      Sigma1: S.Sigma1(e1),
      Ch: S.ch(e1, e2, e3),
      Sigma0: S.Sigma0(a1),
      Maj: S.maj(a1, a2, a3),
      T1: trace.T1[t],
      T2: trace.T2[t],
      A: track(trace, "A", t),
      E: track(trace, "E", t),
    };
  }

  // -------------------------------------------------------------------
  // 6. Differential comparison
  // -------------------------------------------------------------------

  /**
   * Bitwise XOR of two traces' A and E tracks, as a diff mask.
   *
   * This is what makes a single-bit toggle legible: flipping one input bit
   * changes roughly half the output bits, and the interesting question is not
   * *that* it does but *how fast*. The mask below, drawn as a raster, is the
   * avalanche.
   *
   * Returns undefined entries where the two traces have different lengths,
   * which happens only if the round counts differ.
   */
  function diffTracks(traceA, traceB) {
    function xorArrays(x, y) {
      var n = Math.min(x.length, y.length);
      var out = new Uint32Array(n);
      for (var i = 0; i < n; i++) out[i] = (x[i] ^ y[i]) >>> 0;
      return out;
    }
    return {
      A: xorArrays(traceA.A, traceB.A),
      E: xorArrays(traceA.E, traceB.E),
      W: xorArrays(traceA.W, traceB.W),
      rounds: Math.min(traceA.rounds, traceB.rounds),
    };
  }

  /** Population count of a 32-bit word. */
  function popcount(x) {
    x = x >>> 0;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >>> 24;
  }

  // -------------------------------------------------------------------
  // 7. Export
  // -------------------------------------------------------------------

  root.SHATOOL_MODEL = Object.freeze({
    DEFAULT_NBITS: DEFAULT_NBITS,
    MAX_NBITS: MAX_NBITS,
    byteLength: byteLength,
    finalByteMask: finalByteMask,
    createMessage: createMessage,
    randomize: randomize,
    randomizeRegion: randomizeRegion,
    clearTrailingBits: clearTrailingBits,
    getBit: getBit,
    setBit: setBit,
    toggleBit: toggleBit,
    setByte: setByte,
    resize: resize,
    messageHex: messageHex,
    setMessageHex: setMessageHex,
    paddingLayout: paddingLayout,
    bitRole: bitRole,
    analyze: analyze,
    track: track,
    trackRange: trackRange,
    roundDetail: roundDetail,
    diffTracks: diffTracks,
    popcount: popcount,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
