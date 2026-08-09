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
    nBits: P.EXAMPLE_NBITS,

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
  // Start
  // -------------------------------------------------------------------

  function start() {
    /* A random 513-bit message: not byte-aligned, and one bit too long to
     * fit its own padding in a single block. See model.js for why. */
    state.msg = M.randomize(M.createMessage(M.DEFAULT_NBITS));

    ui.input = root.SHATOOL_UI_INPUT.create(inputCallbacks);
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
