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
      found: false,
      startedAt: 0,
      rate2: 0,           // measured samples per second
    },

    /** Result of the last flip scan, single or pair, or null. */
    flip: null,

    /** Progress of a running pair scan, or null when none is running. */
    pairProgress: null,

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
    if (res.bestBits > s.best) s.best = res.bestBits;

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
    /* Restart the clock but keep the counters: a pause and resume is one run
     * as far as the attempt total is concerned, and resetting is a separate
     * button. */
    s.startedAt = now() - (s.rate2 > 0 ? (s.attempts / s.rate2) * 1000 : 0);
    render();
    rafId = raf(searchFrame);
  }

  function stopSearch() {
    state.search.running = false;
    if (rafId !== null) { caf(rafId); rafId = null; }
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
      s.found = false;
      s.rate2 = 0;
      state.flip = null;
      /* A pair scan in flight is abandoned too: its cursor is discarded and
       * the message is already whole, because the scan restores it after
       * every individual pair rather than only at the end. */
      if (pairRaf !== null) { caf(pairRaf); pairRaf = null; }
      pairScan = null;
      state.pairProgress = null;
      render();
    },
    onBestFlip: function () {
      /* Synchronous: one hash per input bit, which for any message this tool
       * will hold is a few hundred hashes and finishes well inside a frame.
       * The change it makes is animated by the canvas afterglow like any
       * other edit, so the result is visible without the scan being staged. */
      stopSearch();
      var before = P.leadingZeroBits(state.analysis.digest);
      var res = Q.bestSingleFlip(state.msg);
      if (!res) { state.flip = null; refresh(); return; }
      state.flip = flipResult("single", [res.index], res, before);
      refresh();
    },

    onBestPair: function () {
      /* Not synchronous. There are n(n-1)/2 pairs — 131,328 for the default
       * message — so a full scan is over a second of solid hashing. Run in
       * one go it would freeze the page and show nothing while it did, so it
       * is spread across animation frames with a progress readout. */
      if (pairScan) return;
      stopSearch();
      if (state.msg.nbits < 2) return;
      pairScan = {
        scan: Q.createPairScan(state.msg),
        zerosBefore: P.leadingZeroBits(state.analysis.digest),
      };
      state.pairProgress = { tested: 0, total: pairScan.scan.total };
      render();
      pairRaf = raf(pairFrame);
    },
  };

  /** Normalise either flip scan's result into what the UI displays. */
  function flipResult(kind, indices, res, zerosBefore) {
    return {
      kind: kind,
      indices: indices,
      tested: res.tested,
      improved: res.improved,
      log2Delta: res.log2Delta,
      zerosBefore: zerosBefore,
      zerosAfter: P.leadingZeroBits(res.after),
    };
  }

  /* Pairs scanned between redraws. Chosen so a frame's work stays in the
   * region of ten milliseconds, which keeps the progress readout moving
   * smoothly without making the scan take noticeably longer overall. */
  var PAIR_BUDGET = 3000;
  var pairScan = null;
  var pairRaf = null;

  function pairFrame() {
    pairRaf = null;
    if (!pairScan) return;

    var progress = pairScan.scan.step(PAIR_BUDGET);
    state.pairProgress = {
      tested: progress.tested,
      total: progress.total,
      bestI: progress.bestI,
      bestJ: progress.bestJ,
    };

    if (!progress.done) {
      render();
      pairRaf = raf(pairFrame);
      return;
    }

    /* Finished: apply the winner and let the ordinary render path animate the
     * change, exactly as it does for a single flip. */
    var zerosBefore = pairScan.zerosBefore;
    var res = pairScan.scan.apply();
    pairScan = null;
    state.pairProgress = null;
    state.flip = res ? flipResult("pair", res.indices, res, zerosBefore) : null;
    refresh();
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
