/*
 * shatool/js/search.js — random sampling of a contiguous input window.
 *
 * No DOM access. Loaded as a classic script; defines the global
 * SHATOOL_SEARCH. Depends on SHAVAR, SHATOOL_MODEL and SHATOOL_POW.
 *
 * ------------------------------------------------------------------
 * What this does, and what it is a model of
 * ------------------------------------------------------------------
 *
 * One contiguous window of the message — 64 bits by default, at an adjustable
 * offset — is repeatedly randomized while every other bit is held fixed. After
 * each sample the digest is scored by how many leading zero bits it has *in
 * proof-of-work order*, which is to say counting down from digest[31], the
 * same order the raster in the output panel draws. Sampling stops when a
 * digest clears a chosen number of leading zeros.
 *
 * That is mining, with two honest differences. A miner varies a 32-bit nonce
 * field in an 80-byte header and hashes it twice; this varies an arbitrary
 * window of an arbitrary message and hashes it once. The *shape* of the
 * search is the same, and it is the shape that is worth seeing: the target is
 * cleared by luck alone, the expected cost doubles for every additional zero
 * bit demanded, and nothing about the input can be steered toward it.
 *
 * ------------------------------------------------------------------
 * Why the digest is computed without a trace
 * ------------------------------------------------------------------
 *
 * `SHATOOL_MODEL.analyze` records the full interior of every block, which is
 * what the canvas draws and is far more work than a search needs. This module
 * calls the library's plain `hashEx` instead, so a sample costs two
 * compressions and no allocation of trace arrays. The interior is recomputed
 * once, by the normal render path, only for the sample that is finally shown.
 */

(function (root) {
  "use strict";

  var S = root.SHAVAR;
  var M = root.SHATOOL_MODEL;
  var P = root.SHATOOL_POW;

  /** The window width the UI offers. Named rather than spelled 64 inline. */
  var WINDOW_BITS = 64;

  /**
   * Clamp a window to a message, keeping it contiguous and non-empty.
   *
   * A window that would run off the end is slid back rather than truncated,
   * so it stays the requested width whenever the message is long enough to
   * hold it. A message shorter than the window gets the whole message.
   *
   * @returns {{start: number, width: number}}
   */
  function clampWindow(nbits, start, width) {
    var w = Math.max(1, Math.min(width, nbits));
    var s = Math.max(0, Math.min(start, nbits - w));
    if (nbits === 0) return { start: 0, width: 0 };
    return { start: s, width: w };
  }

  /** The window a fresh message should start with: the last `width` bits. */
  function defaultWindow(nbits, width) {
    return clampWindow(nbits, nbits - (width || WINDOW_BITS),
      width || WINDOW_BITS);
  }

  /**
   * Build a window from an inclusive [start, end] bit range as typed.
   *
   * Both ends are clamped into the message and `end` is never allowed below
   * `start`, so any pair of numbers a person can type produces a legal,
   * non-empty, contiguous window rather than an error. That is the right
   * trade for a field being edited a digit at a time: typing "5" on the way
   * to "512" briefly means end < start, and rejecting it would fight the
   * user mid-keystroke.
   *
   * @returns {{start: number, width: number}}
   */
  function windowFromRange(nbits, start, end) {
    if (nbits === 0) return { start: 0, width: 0 };
    var s = Math.max(0, Math.min(start | 0, nbits - 1));
    var e = Math.max(s, Math.min(end | 0, nbits - 1));
    return { start: s, width: e - s + 1 };
  }

  /** The inclusive last bit of a window, which is what the UI displays. */
  function windowEnd(win) {
    return win.width > 0 ? win.start + win.width - 1 : win.start;
  }

  /**
   * Draw `samples` random points from the window and score each digest.
   *
   * The message is MUTATED and is left standing at whichever sample the run
   * stopped on — the winning one if `thresholdBits` was reached, otherwise
   * the last one drawn. That is deliberate: the caller renders the message it
   * is handed, so what is on screen is always a point that was actually
   * sampled rather than a summary of points that were.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg MUTATED
   * @param {{start: number, width: number}} win
   * @param {{samples: number, thresholdBits: number,
   *          rand?: function():number}} opts
   * @returns {{attempts: number, found: boolean, bits: number,
   *            bestBits: number, digest: Uint8Array}}
   *   `bits` scores the sample the run ended on; `bestBits` is the best seen
   *   during this call, which may be the same sample.
   */
  function run(msg, win, opts) {
    var samples = Math.max(1, opts.samples | 0);
    var threshold = opts.thresholdBits;
    var rand = opts.rand;

    var attempts = 0;
    var bestBits = -1;
    var bits = 0;
    var digest = null;
    var found = false;

    for (var i = 0; i < samples; i++) {
      M.randomizeRegion(msg, win.start, win.width, rand);
      digest = S.hashEx(msg.bytes, msg.nbits);
      bits = P.leadingZeroBits(digest);
      attempts++;
      if (bits > bestBits) bestBits = bits;
      if (bits >= threshold) { found = true; break; }
    }

    return {
      attempts: attempts,
      found: found,
      bits: bits,
      bestBits: bestBits,
      digest: digest,
    };
  }

  /**
   * Try every single-bit flip in turn and keep the one that lowers the digest
   * value most.
   *
   * Each bit is flipped, the message hashed, and the bit restored, so the
   * candidates are independent single-bit perturbations of the same starting
   * point rather than a cumulative walk. The message is left with the winning
   * bit flipped.
   *
   * ---------------------------------------------------------------
   * Why the winner is simply the smallest digest
   * ---------------------------------------------------------------
   *
   * The drop caused by flipping bit i is `base - value(i)`, and `base` is the
   * same for every candidate. Maximising the drop is therefore exactly
   * minimising `value(i)`, and no subtraction is needed to find the winner —
   * only to report how large the drop was. That is worth stating because the
   * obvious implementation computes 256-bit differences for every bit and
   * compares those, which is more arithmetic for an identical answer.
   *
   * "Value" here is the proof-of-work reading: the digest as a little-endian
   * 256-bit integer, the same quantity the output panel's raster orders by.
   * A drop in it is a step toward clearing a target.
   *
   * One honest caveat, surfaced in the return value: there is no guarantee
   * any flip lowers the digest at all. Roughly half of them will, but on a
   * digest that is already small every candidate may be larger, and then the
   * "best" flip is a rise. `improved` says which happened.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg MUTATED
   * @returns {{index: number, before: Uint8Array, after: Uint8Array,
   *            improved: boolean, delta: Uint8Array, log2Delta: number,
   *            tested: number}|null} null for a zero-length message
   */
  function bestSingleFlip(msg) {
    if (msg.nbits === 0) return null;

    var before = S.hashEx(msg.bytes, msg.nbits);
    var bestIndex = -1;
    var bestDigest = null;

    for (var i = 0; i < msg.nbits; i++) {
      M.toggleBit(msg, i);
      var d = S.hashEx(msg.bytes, msg.nbits);
      M.toggleBit(msg, i);          // restore before moving on
      if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
        bestDigest = d;
        bestIndex = i;
      }
    }

    M.toggleBit(msg, bestIndex);    // leave the message on the winner

    var improved = P.compareValues(bestDigest, before) < 0;
    /* Report the magnitude of the move, whichever direction it went. */
    var delta = improved
      ? P.sub256(before, bestDigest).diff
      : P.sub256(bestDigest, before).diff;

    return {
      index: bestIndex,
      before: before,
      after: bestDigest,
      improved: improved,
      delta: delta,
      log2Delta: P.log2Value(delta),
      tested: msg.nbits,
    };
  }

  /**
   * Expected number of samples to reach `bits` leading zeros, as 2^bits.
   *
   * Each sample is an independent draw from what is, for this purpose, a
   * uniform 256-bit value, so the count is geometric with p = 2^-bits. Worth
   * displaying next to the attempt counter, because the gap between the two
   * is the only honest sense of how a difficulty "costs" anything.
   */
  function expectedAttempts(bits) {
    return Math.pow(2, bits);
  }

  root.SHATOOL_SEARCH = Object.freeze({
    WINDOW_BITS: WINDOW_BITS,
    clampWindow: clampWindow,
    defaultWindow: defaultWindow,
    windowFromRange: windowFromRange,
    windowEnd: windowEnd,
    run: run,
    bestSingleFlip: bestSingleFlip,
    expectedAttempts: expectedAttempts,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
