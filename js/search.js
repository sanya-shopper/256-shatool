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
    var bestBytes = null;
    var bits = 0;
    var digest = null;
    var found = false;

    for (var i = 0; i < samples; i++) {
      M.randomizeRegion(msg, win.start, win.width, rand);
      digest = S.hashEx(msg.bytes, msg.nbits);
      bits = P.leadingZeroBits(digest);
      attempts++;
      if (bits > bestBits) {
        bestBits = bits;
        /* Copied only when the best improves, not once per sample, so the
         * cost is a handful of copies across a run of millions. Keeping the
         * bytes — not just the count — is what lets a paused run be rewound
         * to its best point rather than left wherever it happened to stop. */
        bestBytes = Uint8Array.from(msg.bytes);
      }
      if (bits >= threshold) { found = true; break; }
    }

    return {
      attempts: attempts,
      found: found,
      bits: bits,
      bestBits: bestBits,
      bestBytes: bestBytes,
      digest: digest,
    };
  }

  /**
   * C(m, n), as a float, saturating to Infinity rather than overflowing.
   *
   * Multiplying and dividing alternately keeps the running value small enough
   * to stay exact well past anything this tool will scan: C(513,3) is
   * 22,369,536 and lands on an integer. Beyond a double's range the answer is
   * Infinity, which is the right thing to display for a scan nobody will run.
   */
  function combinations(m, n) {
    if (n < 0 || n > m) return 0;
    var r = 1;
    for (var i = 0; i < n; i++) {
      r = (r * (m - i)) / (i + 1);
      if (!isFinite(r)) return Infinity;
    }
    return Math.round(r);
  }

  /**
   * Longest scan the UI will offer to start, in seconds.
   *
   * This is a real limit, not a formality. For a 513-bit message the counts
   * are 513, then 131,328, then 22,369,536, then 2.85 billion — each step in
   * n multiplies the work by roughly m/n. Three bits is minutes; four is
   * days. Offering a button that would never finish is worse than not
   * offering it, so the control reports the count and the estimate and
   * refuses above this.
   */
  var MAX_SCAN_SECONDS = 180;

  /** Seconds a scan of `total` combinations should take at a measured rate. */
  function estimateSeconds(total, hashesPerSecond) {
    if (!isFinite(total)) return Infinity;
    if (!(hashesPerSecond > 0)) return Infinity;
    return total / hashesPerSecond;
  }

  /**
   * Classify every input bit by what flipping it does to the digest's leading
   * zero count.
   *
   * Answers "which bits do not change the leading zeros at all" — plus, for
   * free, which improve and which worsen it. One hash per bit, so the whole
   * map costs about as much as a single-flip scan.
   *
   * What the answer looks like is worth knowing before reading it. On a
   * digest with no leading zeros, flipping a bit leaves the count at zero
   * whenever the new digest's top bit is 1 — about half the time — so roughly
   * half the bits come back neutral and the map says little. On a digest that
   * a sampling run has pushed to a dozen leading zeros, landing on exactly
   * that count again is very unlikely, so almost every bit worsens it and the
   * few that do not are genuinely notable. The map is most informative
   * exactly where the search has already done some work.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg restored before returning
   * @returns {{base: number, map: Int8Array, same: number, better: number,
   *            worse: number}} map[i] is 0 if bit i leaves the count alone,
   *   +1 if flipping it gains leading zeros, -1 if it loses them
   */
  function leadingZeroDeltaMap(msg) {
    var n = msg.nbits;
    var map = new Int8Array(n);
    var same = 0, better = 0, worse = 0;
    if (n === 0) return { base: 256, map: map, same: 0, better: 0, worse: 0 };

    var base = P.leadingZeroBits(S.hashEx(msg.bytes, msg.nbits));
    for (var i = 0; i < n; i++) {
      M.toggleBit(msg, i);
      var z = P.leadingZeroBits(S.hashEx(msg.bytes, msg.nbits));
      M.toggleBit(msg, i);
      if (z === base) { map[i] = 0; same++; }
      else if (z > base) { map[i] = 1; better++; }
      else { map[i] = -1; worse++; }
    }
    return { base: base, map: map, same: same, better: better, worse: worse };
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
   * @param {{start: number, width: number}} [range] defaults to the whole
   *   message
   * @returns {Object|null} null for a zero-length message
   */
  function bestSingleFlip(msg, range) {
    if (msg.nbits === 0) return null;
    var scan = createFlipScan(msg, 1, range);
    scan.step(scan.total || 1);     // one step covers every combination
    return scan.apply();
  }

  /**
   * A resumable scan over every combination of `n` simultaneous bit flips.
   *
   * One implementation covers every width the UI offers: n = 1 is the
   * single-flip scan, n = 2 the pair scan, and larger n the same thing at a
   * cost that grows by roughly m/n with every step. Having a second,
   * hand-rolled loop for each width is how the two drift apart.
   *
   * ---------------------------------------------------------------
   * Why it is a cursor rather than a function
   * ---------------------------------------------------------------
   *
   * C(513, 2) is 131,328 hashes — over a second of solid computation — and
   * C(513, 3) is 22,369,536, which is minutes. A single call would freeze the
   * page for the duration and show nothing while it did. `step(budget)`
   * advances by at most `budget` combinations and returns, so the caller can
   * spread the scan across animation frames, report progress, and let it be
   * cancelled.
   *
   * The message is restored after every *individual* combination, never
   * merely at the end of a step. That is what makes pausing between frames
   * safe: whatever renders in the gap sees the original message, not a
   * half-applied probe.
   *
   * ---------------------------------------------------------------
   * The odometer
   * ---------------------------------------------------------------
   *
   * `idx` holds a strictly increasing tuple of bit positions. Advancing finds
   * the rightmost element that has not yet hit its ceiling (position k can
   * reach at most m - n + k, since everything to its right must still fit
   * above it), increments it, and repacks everything to its right as tightly
   * as possible. That enumerates every combination exactly once, in
   * lexicographic order, with no allocation per step.
   *
   * Note that widths are not nested: a scan of width n never tries a change
   * of width n-1, so a wider scan's winner can be worse than a narrower
   * one's. The UI reports what each found rather than implying one improves
   * on the other.
   *
   * ---------------------------------------------------------------
   * The range
   * ---------------------------------------------------------------
   *
   * Combinations are drawn from a contiguous window of the message — the same
   * window the sampler resamples — rather than from the whole of it. That is
   * what makes wider scans usable at all: C(513,3) is 22,369,536 and takes
   * minutes, while C(64,3) over a 64-bit window is 41,664 and is over before
   * the progress bar appears. Setting the range to the whole message gets the
   * old behaviour back.
   *
   * Positions are enumerated locally, within the window, and reported as
   * absolute bit indices, so callers never see the offset.
   *
   * @param {{bytes: Uint8Array, nbits: number}} msg MUTATED by apply()
   * @param {number} n how many bits to flip at once
   * @param {{start: number, width: number}} [range] defaults to the whole
   *   message
   */
  function createFlipScan(msg, n, range) {
    var start = range ? range.start : 0;
    var m = range ? range.width : msg.nbits;
    var width = Math.max(1, n | 0);
    var total = combinations(m, width);
    var base = msg.nbits === 0 ? null : S.hashEx(msg.bytes, msg.nbits);

    var idx = null;
    var exhausted = m < width || m === 0;
    var tested = 0;
    var bestIdx = null;
    var bestDigest = null;

    if (!exhausted) {
      idx = new Array(width);
      for (var i = 0; i < width; i++) idx[i] = i;
    }

    function advance() {
      var k = width - 1;
      while (k >= 0 && idx[k] === m - width + k) k--;
      if (k < 0) return false;
      idx[k]++;
      for (var j = k + 1; j < width; j++) idx[j] = idx[j - 1] + 1;
      return true;
    }

    /* Toggling the same set twice restores it, because the positions in a
     * combination are distinct by construction. */
    function toggleAll() {
      for (var i = 0; i < width; i++) M.toggleBit(msg, start + idx[i]);
    }

    /** The current combination as absolute bit indices. */
    function absolute() {
      var out = new Array(width);
      for (var i = 0; i < width; i++) out[i] = start + idx[i];
      return out;
    }

    function snapshot() {
      return {
        done: exhausted,
        tested: tested,
        total: total,
        n: width,
        range: { start: start, width: m },
        bestIndices: bestIdx ? bestIdx.slice() : null,
        bestDigest: bestDigest,
        base: base,
      };
    }

    return {
      n: width,
      total: total,

      /** Advance by at most `budget` combinations. */
      step: function (budget) {
        var count = 0;
        while (!exhausted && count < budget) {
          toggleAll();
          var d = S.hashEx(msg.bytes, msg.nbits);
          toggleAll();

          if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
            bestDigest = d;
            bestIdx = absolute();
          }
          tested++; count++;
          if (!advance()) exhausted = true;
        }
        return snapshot();
      },

      /**
       * Apply the winning combination to the message.
       * @returns {Object|null} null if nothing was ever tried
       */
      apply: function () {
        if (!bestIdx) return null;
        for (var i = 0; i < bestIdx.length; i++) M.toggleBit(msg, bestIdx[i]);
        var improved = P.compareValues(bestDigest, base) < 0;
        var delta = improved
          ? P.sub256(base, bestDigest).diff
          : P.sub256(bestDigest, base).diff;
        return {
          indices: bestIdx.slice(),
          n: width,
          before: base,
          after: bestDigest,
          improved: improved,
          delta: delta,
          log2Delta: P.log2Value(delta),
          tested: tested,
        };
      },
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
    createFlipScan: createFlipScan,
    combinations: combinations,
    estimateSeconds: estimateSeconds,
    MAX_SCAN_SECONDS: MAX_SCAN_SECONDS,
    leadingZeroDeltaMap: leadingZeroDeltaMap,
    expectedAttempts: expectedAttempts,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
