/*
 * shatool/js/app.js — state and wiring.
 *
 * The only file that mutates application state. The three UI modules render
 * from a state object and report user actions back through callbacks; each
 * callback changes the state, recomputes whatever the change invalidated, and
 * re-renders. There is no other path, which is what keeps three panels
 * showing three views of one computation rather than three computations.
 *
 * Rendering is unconditional and total: every action redraws all three
 * panels. At this scale that costs well under a millisecond of model work
 * (two blocks of SHA-256) and it removes a whole category of bug in which one
 * panel is a keystroke behind the others.
 */

(function (root) {
  "use strict";

  var M = root.SHATOOL_MODEL;
  var P = root.SHATOOL_POW;
  var Q = root.SHATOOL_SEARCH;

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  var state = {
    /** The message being hashed: {bytes: Uint8Array, nbits: number}. */
    msg: null,
    /** A pinned copy of an earlier message, for diff mode; null until pinned. */
    reference: null,

    /** Derived, recomputed by refresh(). */
    analysis: null,
    refAnalysis: null,
    diff: null,
    pow: null,

    rounds: 64,
    blockIndex: 0,
    selectedRound: null,

    showInputBits: true,
    showDigestBits: false,
    diffMode: false,
    animate: true,
    nBits: P.EXAMPLE_NBITS,

    /**
     * Sampling run.
     *
     * `range` is what the user asked for, inclusive, and is never modified by
     * anything except the user. `window` is that range clamped to the current
     * message, recomputed on every refresh. Keeping the two apart is what
     * lets a range survive a resize: shrinking the message to 64 bits and
     * growing it back restores the original range instead of leaving it
     * collapsed to the single bit the short message could hold.
     */
    search: {
      running: false,
      range: { start: 0, end: Q.WINDOW_BITS - 1 },
      window: { start: 0, width: Q.WINDOW_BITS },
      threshold: 16,
      rate: 500,          // samples per animation frame
      attempts: 0,
      best: -1,
      /** The best sample's message bytes, so a pause can rewind to it. */
      bestBytes: null,
      bestNbits: -1,
      /** Set when a pause rewound the message, so the UI can say so. */
      rewound: false,
      found: false,
      startedAt: 0,
      rate2: 0,           // measured samples per second
    },

    /** Result of the last flip scan, of whatever width, or null. */
    flip: null,

    /** Progress of a running flip scan, or null when none is running. */
    flipProgress: null,

    /** Width for the general "best n-bit flip" control. */
    flipN: 3,

    /** Whether to classify every bit by its effect on the leading zeros. */
    showNeutral: false,
    /** The classification itself, recomputed by refresh() when enabled. */
    neutral: null,

    /**
     * Measured hashes per second on this machine, used to turn a combination
     * count into an estimate a person can act on. Measured rather than
     * assumed because the counts span nine orders of magnitude and the
     * difference between "twenty seconds" and "twenty minutes" is the whole
     * decision.
     */
    hashRate: 0,

    error: null,
  };

  var ui = {};

  // -------------------------------------------------------------------
  // Derivation
  // -------------------------------------------------------------------

  /**
   * Recompute everything downstream of the message, then draw.
   *
   * Ordering matters here: the analysis has to exist before blockIndex and
   * selectedRound can be clamped against it, and the clamping has to happen
   * before any renderer indexes into it. Shrinking the message from two
   * blocks to one while block 1 is selected is the case this protects.
   */
  function refresh() {
    state.analysis = M.analyze(state.msg, { rounds: state.rounds });
    state.pow = P.analyze(state.analysis.digest, state.nBits);

    /* Derived from the requested range every time, so a message that grows
     * or shrinks moves the window without destroying what was asked for. */
    state.search.window = Q.windowFromRange(state.msg.nbits,
      state.search.range.start, state.search.range.end);

    if (state.blockIndex >= state.analysis.blocks.length) {
      state.blockIndex = state.analysis.blocks.length - 1;
    }
    if (state.selectedRound !== null && state.selectedRound >= state.rounds) {
      state.selectedRound = null;
    }

    /* One hash per input bit, so this is only computed when asked for. */
    state.neutral = state.showNeutral ? Q.leadingZeroDeltaMap(state.msg) : null;

    /* The diff is against the same block index of the reference message. If
     * the reference is shorter and has no such block there is nothing to
     * compare, so diff mode falls back to showing no difference rather than
     * throwing or silently comparing the wrong block. */
    state.diff = null;
    if (state.reference) {
      state.refAnalysis = M.analyze(state.reference, { rounds: state.rounds });
      var mine = state.analysis.blocks[state.blockIndex];
      var theirs = state.refAnalysis.blocks[state.blockIndex];
      if (mine && theirs) state.diff = M.diffTracks(theirs.trace, mine.trace);
    } else {
      state.refAnalysis = null;
    }

    render();
  }

  function render() {
    ui.input.render(state);
    ui.canvas.render(state);
    ui.output.render(state);
    document.getElementById("stat-nbits").textContent =
      state.msg.nbits + " bits";
    document.getElementById("stat-blocks").textContent =
      state.analysis.layout.nblocks +
      (state.analysis.layout.nblocks === 1 ? " block" : " blocks");
    document.getElementById("stat-rounds").textContent =
      state.rounds === 64 ? "64" : state.rounds + " of 64";
  }

  /** Run `fn`, showing its message in the input panel instead of throwing. */
  function guarded(fn) {
    try {
      state.error = null;
      fn();
    } catch (e) {
      state.error = e && e.message ? e.message : String(e);
    }
    refresh();
  }

  /** Copy a message state, for pinning a reference. */
  function cloneMessage(msg) {
    return { bytes: Uint8Array.from(msg.bytes), nbits: msg.nbits };
  }

  // -------------------------------------------------------------------
  // Callbacks
  // -------------------------------------------------------------------

  var inputCallbacks = {
    onToggleBit: function (i) {
      M.toggleBit(state.msg, i);
      refresh();
    },
    onSetByte: function (i, v) {
      M.setByte(state.msg, i, v);
      refresh();
    },
    onSetHex: function (text) {
      guarded(function () { M.setMessageHex(state.msg, text); });
    },
    onSetNbits: function (n) {
      /* No window bookkeeping here: refresh() re-derives it from the
       * requested range against whatever the new length turns out to be. */
      guarded(function () { M.resize(state.msg, n); });
    },
    onRandomize: function () {
      M.randomize(state.msg);
      state.error = null;
      refresh();
    },
    onClear: function () {
      state.msg.bytes.fill(0);
      state.error = null;
      refresh();
    },
    onShowBits: function (v) {
      state.showInputBits = v;
      render();
    },
  };

  var canvasCallbacks = {
    onSelectBlock: function (i) {
      state.blockIndex = i;
      refresh();
    },
    onSelectRound: function (t) {
      state.selectedRound = t;
      render();
    },
    onSetRounds: function (n) {
      if (n < 0 || n > 64) return;
      state.rounds = n;
      refresh();
    },
    onDiff: function (v) {
      state.diffMode = v;
      render();
    },
    onAnimate: function (v) {
      state.animate = v;
      render();
    },
    onPinReference: function () {
      /* Pinning takes a snapshot of the message as it is now. Toggling a bit
       * afterwards is then visible in diff mode as the avalanche from that
       * one change — which is the reason the bit cells are clickable. */
      state.reference = cloneMessage(state.msg);
      state.diffMode = true;
      refresh();
    },
  };

  var outputCallbacks = {
    onShowDigestBits: function (v) {
      state.showDigestBits = v;
      render();
    },
    onSetNBits: function (v) {
      state.nBits = v >>> 0;
      state.pow = P.analyze(state.analysis.digest, state.nBits);
      render();
    },
  };

  // -------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------
  //
  // A run draws `rate` samples per animation frame and renders after each
  // frame rather than after each sample. That is what makes it watchable: the
  // sampling itself is far faster than a display can show, so the frame is
  // the natural unit, and every frame that is drawn is a real point that was
  // really sampled — not an interpolation between them.

  var rafId = null;
  var raf = typeof root.requestAnimationFrame === "function"
    ? function (fn) { return root.requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(fn, 16); };
  var caf = typeof root.cancelAnimationFrame === "function"
    ? function (id) { root.cancelAnimationFrame(id); }
    : function (id) { clearTimeout(id); };

  var now = (typeof root.performance === "object" && root.performance &&
             typeof root.performance.now === "function")
    ? function () { return root.performance.now(); }
    : function () { return new Date().getTime(); };

  /** One frame of sampling. Exposed for tests, which pump frames by hand. */
  function searchFrame() {
    rafId = null;
    var s = state.search;
    if (!s.running) return;

    var res = Q.run(state.msg, s.window, {
      samples: s.rate,
      thresholdBits: s.threshold,
    });

    s.attempts += res.attempts;
    if (res.bestBits > s.best) {
      s.best = res.bestBits;
      s.bestBytes = res.bestBytes;
      s.bestNbits = state.msg.nbits;
    }

    var elapsed = (now() - s.startedAt) / 1000;
    s.rate2 = elapsed > 0 ? Math.round(s.attempts / elapsed) : 0;

    if (res.found) {
      s.running = false;
      s.found = true;
    }

    /* The message was mutated in place by the sampler, so a full refresh is
     * both correct and necessary — the traces on the canvas belong to the
     * point now on screen. */
    refresh();

    if (s.running) rafId = raf(searchFrame);
  }

  function startSearch() {
    var s = state.search;
    if (s.running) return;
    if (state.msg.nbits === 0) return;
    s.running = true;
    s.found = false;
    s.rewound = false;
    /* Restart the clock but keep the counters: a pause and resume is one run
     * as far as the attempt total is concerned, and resetting is a separate
     * button. */
    s.startedAt = now() - (s.rate2 > 0 ? (s.attempts / s.rate2) * 1000 : 0);
    render();
    rafId = raf(searchFrame);
  }

  /**
   * Stop a sampling run and rewind to the best sample it found.
   *
   * A run left standing wherever it happened to be interrupted throws away
   * everything it achieved: the last sample drawn is just another random
   * point, and the good one — the reason the run was worth watching — is
   * gone. So pausing restores the best sample's bytes.
   *
   * Only when the sampler was actually running, so that the incidental
   * stopSearch() calls made before starting a flip scan do not rewind a
   * message nobody was sampling. And only when the best was recorded at the
   * current message length, since a resize in between makes those bytes a
   * different message.
   */
  function stopSearch() {
    var s = state.search;
    var wasRunning = s.running;
    s.running = false;
    if (rafId !== null) { caf(rafId); rafId = null; }

    if (wasRunning && s.bestBytes && s.bestNbits === state.msg.nbits &&
        s.bestBytes.length === state.msg.bytes.length) {
      state.msg.bytes.set(s.bestBytes);
      s.rewound = true;
      refresh();
      return;
    }
    render();
  }

  var searchCallbacks = {
    onSetSearchRange: function (start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;
      state.search.range = { start: start, end: end };
      refresh();
    },
    onSetThreshold: function (n) {
      if (!Number.isInteger(n) || n < 1 || n > 256) return;
      state.search.threshold = n;
      state.search.found = false;
      render();
    },
    onSetRate: function (n) {
      if (!Number.isInteger(n) || n < 1) return;
      state.search.rate = n;
      render();
    },
    onToggleSearch: function () {
      if (state.search.running) stopSearch(); else startSearch();
    },
    onResetSearch: function () {
      stopSearch();
      var s = state.search;
      s.attempts = 0;
      s.best = -1;
      s.bestBytes = null;
      s.bestNbits = -1;
      s.rewound = false;
      s.found = false;
      s.rate2 = 0;
      state.flip = null;
      cancelFlipScan();
      render();
    },
    /* All three widths go through startFlipScan, which decides for itself
     * whether the combination count is small enough to run in one go. Width 1
     * on any message this tool holds always is. */
    onBestFlip: function () { startFlipScan(1); },

    onBestPair: function () { startFlipScan(2); },

    onBestN: function () { startFlipScan(state.flipN); },

    onSetFlipN: function (n) {
      if (!Number.isInteger(n) || n < 1 || n > 8) return;
      state.flipN = n;
      render();
    },

    onCancelScan: function () { cancelFlipScan(); render(); },

    onShowNeutral: function (v) {
      state.showNeutral = v;
      refresh();
    },
  };

  /** Normalise a flip scan's result into what the UI displays. */
  function flipResult(res, zerosBefore) {
    return {
      n: res.n,
      indices: res.indices,
      tested: res.tested,
      improved: res.improved,
      log2Delta: res.log2Delta,
      zerosBefore: zerosBefore,
      zerosAfter: P.leadingZeroBits(res.after),
    };
  }

  /* Combinations tried between redraws. Chosen so a frame's work stays in the
   * region of ten milliseconds, which keeps the progress readout moving
   * smoothly without making the scan take noticeably longer overall. */
  var SCAN_BUDGET = 3000;

  /* Below this, a scan finishes inside one frame anyway and staging it would
   * only add a frame of latency and a progress bar nobody sees. */
  var SYNC_LIMIT = 20000;

  var flipScan = null;
  var flipRaf = null;

  /** A copy of the message with `indices` flipped, without disturbing it. */
  function bytesWithFlips(msg, indices) {
    var probe = { bytes: Uint8Array.from(msg.bytes), nbits: msg.nbits };
    for (var i = 0; i < indices.length; i++) M.toggleBit(probe, indices[i]);
    return probe.bytes;
  }

  /**
   * Fold a flip scan's progress into the search session.
   *
   * A scan is a search over the input space just as sampling is, so it feeds
   * the same counters: the points-tried total, the best leading-zero count,
   * and the bytes that achieved it — which means a scan can improve the point
   * a later pause rewinds to.
   *
   * The best-valued digest is also the one with the most leading zeros, so no
   * separate tracking is needed: leading zeros are determined by the position
   * of the highest set bit, so a smaller value can only have more of them.
   *
   * One thing this deliberately does not do is treat scan probes as random
   * draws. They are systematic, so the "expected at random" figure beside the
   * total is not a prediction of them; the panel labels it accordingly.
   *
   * @param {Object} progress a scan snapshot
   * @param {number} counted how many of its probes are already counted
   * @returns {number} the new counted total
   */
  function recordScanProgress(progress, counted) {
    var s = state.search;
    s.attempts += progress.tested - counted;

    if (progress.bestDigest) {
      var lz = P.leadingZeroBits(progress.bestDigest);
      if (lz > s.best) {
        s.best = lz;
        s.bestBytes = bytesWithFlips(state.msg, progress.bestIndices);
        s.bestNbits = state.msg.nbits;
      }
    }
    return progress.tested;
  }

  /**
   * Begin (or immediately complete) a scan of `n`-bit flips.
   *
   * Small scans run synchronously; large ones are spread across frames. The
   * caller does not choose which — the combination count does — so the same
   * button behaves sensibly whether the message is 24 bits or 513.
   */
  function startFlipScan(n) {
    if (flipScan) return;
    stopSearch();

    /* Scans cover the same contiguous range the sampler resamples, not the
     * whole message. Besides being the more useful question — "what is the
     * best I can do by changing these bits" — it is what keeps wider scans
     * finishable: C(64,3) over a 64-bit range is 41,664, against 22,369,536
     * over all 513 bits. */
    var win = state.search.window;
    if (win.width < n) return;

    var scan = Q.createFlipScan(state.msg, n, win);
    if (scan.total === 0) return;

    var zerosBefore = P.leadingZeroBits(state.analysis.digest);

    if (scan.total <= SYNC_LIMIT) {
      /* Recorded before apply(), while the message is still unflipped — that
       * is what bytesWithFlips() expects to be handed. */
      recordScanProgress(scan.step(scan.total), 0);
      var res = scan.apply();
      state.flip = res ? flipResult(res, zerosBefore) : null;
      refresh();
      return;
    }

    flipScan = {
      scan: scan, zerosBefore: zerosBefore, startedAt: now(), counted: 0,
    };
    state.flipProgress = {
      n: n, tested: 0, total: scan.total, bestIndices: null, etaSeconds: null,
    };
    render();
    flipRaf = raf(flipFrame);
  }

  function cancelFlipScan() {
    if (flipRaf !== null) { caf(flipRaf); flipRaf = null; }
    /* Nothing to undo: the scan restores the message after every individual
     * combination, so abandoning it mid-step leaves nothing half-applied. */
    flipScan = null;
    state.flipProgress = null;
  }

  function flipFrame() {
    flipRaf = null;
    if (!flipScan) return;

    var progress = flipScan.scan.step(SCAN_BUDGET);
    flipScan.counted = recordScanProgress(progress, flipScan.counted);

    var elapsed = (now() - flipScan.startedAt) / 1000;
    var rate = elapsed > 0 ? progress.tested / elapsed : 0;

    state.flipProgress = {
      n: progress.n,
      tested: progress.tested,
      total: progress.total,
      bestIndices: progress.bestIndices,
      etaSeconds: rate > 0 ? (progress.total - progress.tested) / rate : null,
    };

    if (!progress.done) {
      render();
      flipRaf = raf(flipFrame);
      return;
    }

    /* Finished: apply the winner and let the ordinary render path animate the
     * change, exactly as it does for a hand edit. */
    var zerosBefore = flipScan.zerosBefore;
    var res = flipScan.scan.apply();
    flipScan = null;
    state.flipProgress = null;
    state.flip = res ? flipResult(res, zerosBefore) : null;
    refresh();
  }

  /**
   * Measure this machine's hashing rate once, at startup.
   *
   * Ten milliseconds of real hashing, which is imperceptible at load and is
   * what turns "22,369,536 combinations" into "about three and a half
   * minutes" — the form of the number anyone can actually decide on.
   */
  function calibrate() {
    var probe = M.randomize(M.createMessage(512));
    var t0 = now();
    var n = 0;
    while (now() - t0 < 10) {
      for (var i = 0; i < 200; i++) root.SHAVAR.hashEx(probe.bytes, probe.nbits);
      n += 200;
    }
    var elapsed = (now() - t0) / 1000;
    return elapsed > 0 ? Math.round(n / elapsed) : 0;
  }

  // -------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------

  function start() {
    /* A random 513-bit message: not byte-aligned, and one bit too long to
     * fit its own padding in a single block. See model.js for why. */
    state.msg = M.randomize(M.createMessage(M.DEFAULT_NBITS));

    var w0 = Q.defaultWindow(state.msg.nbits, Q.WINDOW_BITS);
    state.search.range = { start: w0.start, end: Q.windowEnd(w0) };
    state.hashRate = calibrate();

    /* ui-input owns the sampling controls as well as the message editor,
     * because both of them change the input. The two callback sets are merged
     * rather than passed separately so that module keeps one collaborator. */
    var inputAll = {};
    var k;
    for (k in inputCallbacks) inputAll[k] = inputCallbacks[k];
    for (k in searchCallbacks) inputAll[k] = searchCallbacks[k];

    ui.input = root.SHATOOL_UI_INPUT.create(inputAll);
    ui.canvas = root.SHATOOL_UI_CANVAS.create(canvasCallbacks);
    ui.output = root.SHATOOL_UI_OUTPUT.create(outputCallbacks);

    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
