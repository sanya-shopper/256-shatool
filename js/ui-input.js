/*
 * shatool/js/ui-input.js — the left-hand input editor.
 *
 * Renders the message as a grid of hex bytes, four bytes (one 32-bit word)
 * per row, with an optional row of clickable bit cells under each byte. Also
 * renders the padding summary, because what the message *becomes* is as much
 * a part of the input as what was typed.
 *
 * This module reads and writes the message through SHATOOL_MODEL and holds no
 * cryptographic knowledge of its own. It owns no state either: everything it
 * draws comes from the state object handed to render(), and every edit is
 * reported back through a callback so that app.js remains the single place
 * where state changes.
 *
 * ------------------------------------------------------------------
 * Why the DOM is patched rather than rebuilt
 * ------------------------------------------------------------------
 *
 * Rebuilding the grid on every keystroke would destroy and recreate the very
 * <input> the user is typing into, which drops focus and the caret. So the
 * structure is rebuilt only when the *shape* changes (the bit length, or the
 * bits-visible toggle), and every other render just repaints values and
 * classes onto the existing nodes — skipping the focused element so that a
 * half-typed byte is never overwritten under the caret.
 */

(function (root) {
  "use strict";

  var M = root.SHATOOL_MODEL;
  var SEARCH = root.SHATOOL_SEARCH;
  var POW = root.SHATOOL_POW;
  var BYTES_PER_ROW = 4;   // one 32-bit word, matching the schedule words

  /**
   * @param {Object} cb callbacks into app.js
   *   cb.onToggleBit(index)      a bit cell was clicked
   *   cb.onSetByte(index, value) a hex byte was edited
   *   cb.onSetHex(text)          the bulk hex field was edited
   *   cb.onSetNbits(n)           the length field was changed
   *   cb.onRandomize()  cb.onClear()  cb.onShowBits(bool)
   */
  function create(cb) {
    var elNbits = document.getElementById("input-nbits");
    var elHex = document.getElementById("input-hex");
    var elGrid = document.getElementById("hex-grid");
    var elShowBits = document.getElementById("chk-showbits");
    var elError = document.getElementById("msg-error");
    var elSummary = document.getElementById("padding-summary");
    var elRandom = document.getElementById("btn-randomize");
    var elClear = document.getElementById("btn-clear");

    var elSearchStart = document.getElementById("search-start");
    var elSearchEnd = document.getElementById("search-end");
    var elSearchWindowLabel = document.getElementById("search-window-label");
    var elThreshold = document.getElementById("search-threshold");
    var elThresholdNote = document.getElementById("threshold-note");
    var elRate = document.getElementById("search-rate");
    var elSearchBtn = document.getElementById("btn-search");
    var elSearchReset = document.getElementById("btn-search-reset");
    var elIncrement = document.getElementById("btn-increment");
    var elSearchStats = document.getElementById("search-stats");
    var elBestFlip = document.getElementById("btn-best-flip");
    var elBestPair = document.getElementById("btn-best-pair");
    var elFlipN = document.getElementById("flip-n");
    var elBestN = document.getElementById("btn-best-n");
    var elFlipNEstimate = document.getElementById("flip-n-estimate");
    var elFlipResult = document.getElementById("flip-result");
    var elNeutral = document.getElementById("chk-neutral");
    var elNeutralSummary = document.getElementById("neutral-summary");

    /* What the current DOM structure was built for. When either of these
     * changes the grid is rebuilt; otherwise it is patched. */
    var builtFor = { nbits: -1, showBits: null };
    var byteInputs = [];   // index -> <input>, parallel to the message bytes
    var bitCells = [];     // index -> <button>, parallel to the message bits

    // ---------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------

    elNbits.addEventListener("change", function () {
      var n = parseInt(elNbits.value, 10);
      if (Number.isInteger(n)) cb.onSetNbits(n);
    });

    elRandom.addEventListener("click", function () { cb.onRandomize(); });
    elClear.addEventListener("click", function () { cb.onClear(); });

    elShowBits.addEventListener("change", function () {
      cb.onShowBits(elShowBits.checked);
    });

    elHex.addEventListener("input", function () { cb.onSetHex(elHex.value); });

    /* Both ends report together: the model clamps the pair as a unit, so
     * sending only the field that changed would need it to remember the
     * other one. */
    function reportRange() {
      cb.onSetSearchRange(parseInt(elSearchStart.value, 10),
        parseInt(elSearchEnd.value, 10));
    }
    elSearchStart.addEventListener("change", reportRange);
    elSearchEnd.addEventListener("change", reportRange);
    elThreshold.addEventListener("change", function () {
      cb.onSetThreshold(parseInt(elThreshold.value, 10));
    });
    elRate.addEventListener("change", function () {
      cb.onSetRate(parseInt(elRate.value, 10));
    });
    elSearchBtn.addEventListener("click", function () { cb.onToggleSearch(); });
    elSearchReset.addEventListener("click", function () { cb.onResetSearch(); });
    elIncrement.addEventListener("click", function () { cb.onIncrement(); });
    elBestFlip.addEventListener("click", function () { cb.onBestFlip(); });
    elBestPair.addEventListener("click", function () {
      if (elBestPair.classList.contains("running")) cb.onCancelScan();
      else cb.onBestPair();
    });
    elFlipN.addEventListener("change", function () {
      cb.onSetFlipN(parseInt(elFlipN.value, 10));
    });
    elNeutral.addEventListener("change", function () {
      cb.onShowNeutral(elNeutral.checked);
    });

    /* One button, two jobs: it starts a scan, and while one is running it
     * cancels it. A long scan the user cannot stop is worse than no scan. */
    elBestN.addEventListener("click", function () {
      if (elBestN.classList.contains("running")) cb.onCancelScan();
      else cb.onBestN();
    });

    /* Delegated handlers on the grid: one listener each rather than two per
     * byte, so rebuilding the grid never leaks listeners. */
    elGrid.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t && t.classList.contains("bit") && !t.classList.contains("locked")) {
        cb.onToggleBit(parseInt(t.getAttribute("data-bit"), 10));
      }
    });

    elGrid.addEventListener("input", function (ev) {
      var t = ev.target;
      if (!t || !t.classList.contains("byte-hex")) return;
      var idx = parseInt(t.getAttribute("data-byte"), 10);
      var cleaned = t.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 2);
      if (cleaned !== t.value) t.value = cleaned;
      cb.onSetByte(idx, cleaned === "" ? 0 : parseInt(cleaned, 16));
    });

    /* Select the whole pair on focus so typing replaces it, which is what
     * clicking into a two-character hex field is nearly always meant to do. */
    elGrid.addEventListener("focusin", function (ev) {
      if (ev.target && ev.target.classList.contains("byte-hex")) {
        ev.target.select();
      }
    });

    /* Normalise on blur: a byte left as a single digit is shown as the two
     * digits actually stored, so what is on screen is what is being hashed. */
    elGrid.addEventListener("focusout", function (ev) {
      var t = ev.target;
      if (t && t.classList.contains("byte-hex")) {
        t.value = t.getAttribute("data-stored") || t.value;
      }
    });

    /* Arrow keys move between byte fields, which makes the grid navigable
     * without the mouse. */
    elGrid.addEventListener("keydown", function (ev) {
      var t = ev.target;
      if (!t || !t.classList.contains("byte-hex")) return;
      var idx = parseInt(t.getAttribute("data-byte"), 10);
      var delta = 0;
      if (ev.key === "ArrowRight") delta = 1;
      else if (ev.key === "ArrowLeft") delta = -1;
      else if (ev.key === "ArrowDown") delta = BYTES_PER_ROW;
      else if (ev.key === "ArrowUp") delta = -BYTES_PER_ROW;
      else return;
      var next = byteInputs[idx + delta];
      if (next) { ev.preventDefault(); next.focus(); }
    });

    // ---------------------------------------------------------------
    // Structure
    // ---------------------------------------------------------------

    function build(state) {
      var msg = state.msg;
      var nbytes = msg.bytes.length;
      var frag = document.createDocumentFragment();
      byteInputs = new Array(nbytes);
      bitCells = new Array(msg.nbits);

      for (var start = 0; start < nbytes; start += BYTES_PER_ROW) {
        var row = document.createElement("div");
        row.className = "hex-row";

        var off = document.createElement("span");
        off.className = "offset";
        /* Byte offset in hex, which is how every hex dump labels its rows. */
        off.textContent = start.toString(16).padStart(3, "0");
        row.appendChild(off);

        var cells = document.createElement("div");
        cells.className = "cells";

        var end = Math.min(start + BYTES_PER_ROW, nbytes);
        for (var b = start; b < end; b++) {
          cells.appendChild(buildByte(b, msg, state.showInputBits));
        }
        row.appendChild(cells);
        frag.appendChild(row);
      }

      elGrid.textContent = "";
      elGrid.appendChild(frag);
      builtFor = { nbits: msg.nbits, showBits: state.showInputBits };
    }

    function buildByte(b, msg, showBits) {
      var wrap = document.createElement("div");
      wrap.className = "byte";

      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "byte-hex";
      inp.maxLength = 2;
      inp.spellcheck = false;
      inp.setAttribute("data-byte", String(b));
      inp.setAttribute("aria-label", "byte " + b);
      wrap.appendChild(inp);
      byteInputs[b] = inp;

      if (showBits) {
        var bits = document.createElement("div");
        bits.className = "bit-row";
        for (var p = 0; p < 8; p++) {
          var i = b * 8 + p;
          var cell = document.createElement("button");
          cell.type = "button";
          cell.className = "bit";
          cell.setAttribute("data-bit", String(i));
          if (i < msg.nbits) {
            bitCells[i] = cell;
            cell.title = "bit " + i;
          } else {
            /* Beyond the message: present in the byte, not part of the
             * message, and required to be zero. */
            cell.classList.add("locked");
            cell.disabled = true;
            cell.title = "bit " + i + " — past the end of a " + msg.nbits +
              "-bit message; must be zero";
          }
          bits.appendChild(cell);
        }
        wrap.appendChild(bits);
      }
      return wrap;
    }

    // ---------------------------------------------------------------
    // Paint
    // ---------------------------------------------------------------

    function paint(state) {
      var msg = state.msg;
      var active = document.activeElement;
      var lastByte = msg.bytes.length - 1;

      for (var b = 0; b < msg.bytes.length; b++) {
        var inp = byteInputs[b];
        if (!inp) continue;
        var text = msg.bytes[b].toString(16).padStart(2, "0");
        inp.setAttribute("data-stored", text);
        /* Never write into the field being typed in: the model may have
         * masked the value (final byte of a sub-byte message), and replacing
         * the text would move the caret mid-keystroke. */
        if (inp !== active) inp.value = text;
        inp.classList.toggle("partial", b === lastByte && msg.nbits % 8 !== 0);
      }

      /* Mark the bits the sampler is resampling. During a run those cells
       * churn every frame, so outlining them is what makes it obvious which
       * part of the message is moving and which is being held fixed. */
      var win = state.search.window;
      var winEnd = win.start + win.width;
      var nz = state.neutral;
      for (var i = 0; i < msg.nbits; i++) {
        var cell = bitCells[i];
        if (!cell) continue;
        cell.classList.toggle("on", M.getBit(msg, i) === 1);
        cell.classList.toggle("in-window", i >= win.start && i < winEnd);
        /* Effect on the leading zero count, as a bottom edge on the cell:
         * grey for no change, green for more, red for fewer. */
        cell.classList.toggle("lz-same", !!nz && nz.map[i] === 0);
        cell.classList.toggle("lz-better", !!nz && nz.map[i] === 1);
        cell.classList.toggle("lz-worse", !!nz && nz.map[i] === -1);
      }

      if (elNbits !== active) elNbits.value = String(msg.nbits);
      if (elHex !== active) elHex.value = M.messageHex(msg);
      elShowBits.checked = state.showInputBits;

      if (state.error) {
        elError.textContent = state.error;
        elError.hidden = false;
      } else {
        elError.hidden = true;
      }

      paintSearch(state);
      paintNeutral(state);
      paintSummary(state);
    }

    /**
     * The sampling controls and their running totals.
     *
     * The attempt counter is shown next to the expected count for the chosen
     * threshold, because the two together are the only honest picture of what
     * a difficulty costs: one number alone says nothing about whether a run
     * is lucky, unlucky, or simply not finished.
     */
    function paintSearch(state) {
      var s = state.search;
      var active = document.activeElement;

      var last = Math.max(0, state.msg.nbits - 1);
      if (elSearchStart !== active) elSearchStart.value = String(s.window.start);
      if (elSearchEnd !== active) {
        elSearchEnd.value = String(s.window.start + Math.max(0, s.window.width - 1));
      }
      if (elThreshold !== active) elThreshold.value = String(s.threshold);
      if (elRate !== active) elRate.value = String(s.rate);
      elSearchStart.max = String(last);
      elSearchEnd.max = String(last);
      elSearchWindowLabel.textContent = s.window.width +
        (s.window.width === 1 ? " bit" : " bits");

      /* Truthiness, not `!== null`: an absent field is `undefined`, and
       * `undefined !== null` is true, which would put the whole panel into a
       * permanent "scanning" state that nothing can clear. */
      var scanning = !!state.flipProgress;
      elSearchBtn.textContent = s.running ? "Pause" : "Start sampling";
      elSearchBtn.classList.toggle("running", s.running);
      /* A zero-length message has no window to resample, and nothing else may
       * touch the message while a flip scan is walking it. */
      elSearchBtn.disabled = state.msg.nbits === 0 || scanning;
      var win = s.window;
      elIncrement.disabled = win.width < 1 || s.running || scanning;
      elBestFlip.disabled = win.width < 1 || s.running || scanning;

      /* Whichever button started the running scan becomes its cancel button;
       * a long scan the user cannot stop is worse than no scan. The single
       * flip needs none — it finishes inside one frame. */
      var pairRunning = scanning && state.flipProgress.n === 2;
      elBestPair.classList.toggle("running", pairRunning);
      elBestPair.textContent = pairRunning ? "Cancel" : "Best pair flip";
      elBestPair.disabled = pairRunning
        ? false
        : (win.width < 2 || s.running || scanning);

      paintFlipN(state, scanning);

      /* "Points tried", not "samples": flip scans feed this counter too, and
       * their probes are systematic rather than random draws. The expected
       * figure beside it is therefore labelled as the random-draw
       * expectation, which is what it is — a yardstick, not a prediction of
       * a scan. */
      paintThresholdNote(state);

      var expected = Math.pow(2, s.threshold);
      var rows = [
        ["points tried", s.attempts.toLocaleString()],
        ["expected at random for " + s.threshold, fmtCount(expected)],
        ["best so far", s.best < 0 ? "—" : s.best + " zero bits"],
      ];
      if (s.rate2 > 0) rows.push(["rate", fmtCount(s.rate2) + " / s"]);
      if (s.found) {
        rows.push(["result", "stopped: " + s.threshold + " zero bits reached"]);
      }

      var html = "";
      for (var i = 0; i < rows.length; i++) {
        html += '<div class="row"><span>' + rows[i][0] +
          '</span><span class="n">' + rows[i][1] + "</span></div>";
      }
      elSearchStats.innerHTML = html;

      paintFlip(state);
    }

    /**
     * The general n-bit flip control: how many combinations it would try,
     * how long that should take on this machine, and whether it is allowed.
     *
     * The count is the whole reason this control needs an estimate at all.
     * For a 513-bit message it is 513, then 131 thousand, then 22 million,
     * then 2.8 billion — each step in n multiplies the work by roughly m/n.
     * A button that silently starts a scan lasting days is worse than one
     * that says it will not.
     */
    function paintFlipN(state, scanning) {
      var running = scanning && state.flipProgress.n === state.flipN;
      if (elFlipN !== document.activeElement) elFlipN.value = String(state.flipN);
      elFlipN.disabled = scanning;

      /* Over the sampling range, not the whole message — the same range the
       * fields above set, which is what keeps the counts finishable. */
      var win = state.search.window;
      var total = SEARCH.combinations(win.width, state.flipN);
      var seconds = SEARCH.estimateSeconds(total, state.hashRate);
      var tooBig = seconds > SEARCH.MAX_SCAN_SECONDS;

      elBestN.classList.toggle("running", running);
      elBestN.textContent = running ? "Cancel" : "Scan";
      elBestN.disabled = running
        ? false                        // cancelling is always allowed
        : (scanning || s_running(state) || total === 0 || tooBig);

      var scope = "bits " + win.start + "–" +
        (win.start + Math.max(0, win.width - 1));
      if (total === 0) {
        elFlipNEstimate.textContent = "the range (" + scope + ", " +
          win.width + " bits) has no " + state.flipN + "-bit combinations";
        return;
      }
      var text = "over " + scope + ": " + fmtCount(total) +
        " combinations · ≈ " + fmtDuration(seconds);
      if (tooBig) {
        text += " — too long; lower n or narrow the range";
      }
      elFlipNEstimate.textContent = text;
    }

    function s_running(state) { return state.search.running; }

    /** Seconds as something a person can judge at a glance. */
    function fmtDuration(sec) {
      if (!isFinite(sec)) return "forever";
      if (sec < 1) return "under a second";
      if (sec < 90) return Math.round(sec) + "s";
      if (sec < 5400) return Math.round(sec / 60) + " min";
      if (sec < 172800) return (sec / 3600).toFixed(1) + " hours";
      return (sec / 86400).toFixed(1) + " days";
    }

    /**
     * What Bitcoin actually asks for, next to what the player is asking for.
     *
     * The goal in the field above is reachable in seconds; the real thing is
     * not reachable at all on one machine. Stating both together, with the
     * ratio between them, is the only way the small number stays honest — on
     * its own it invites the reading that the search is nearly there.
     */
    function paintThresholdNote(state) {
      var needed = POW.leadingZeroBits(POW.targetBytes(state.nBits));
      var goal = state.search.threshold;
      var hex = "0x" + state.nBits.toString(16).padStart(8, "0");
      var gap = needed - goal;
      var rel = gap > 0 ? "2^" + gap + " × harder than this goal"
        : gap < 0 ? "2^" + (-gap) + " × easier than this goal"
        : "exactly this goal";
      elThresholdNote.textContent = "Bitcoin at " + hex + " needs " + needed +
        " leading zero bits — " + rel + ". The raster on the right is drawn " +
        "against the goal, not against that.";
    }

    /**
     * Either the progress of a running scan or the outcome of the last
     * completed one — never both, since one replaces the other.
     */
    function paintFlip(state) {
      if (state.flipProgress) { paintScanProgress(state.flipProgress); return; }

      var f = state.flip;
      if (!f) { elFlipResult.innerHTML = ""; return; }

      var unit = f.n === 1 ? "single-bit flips" : f.n + "-bit combinations";
      var label = f.n === 1 ? "bit " : "bits ";
      var rows, html = "";

      if (f.applied) {
        rows = [
          ["tested", fmtCount(f.tested) + " " + unit],
          ["kept", label + f.indices.join(" + ")],
          ["digest value", "fell by ≈ 2^" + f.log2Delta.toFixed(1)],
          ["leading zeros", f.zerosBefore + " → " + f.zerosAfter],
        ];
        for (var i = 0; i < rows.length; i++) {
          html += '<div class="row"><span>' + rows[i][0] +
            '</span><span class="n">' + rows[i][1] + "</span></div>";
        }
      } else {
        /* Nothing was applied, so the report has to be about what was
         * rejected and why — and must not read as if the input moved. */
        rows = [
          ["tested", fmtCount(f.tested) + " " + unit],
          ["best found", label + f.indices.join(" + ")],
          ["would have risen by", "≈ 2^" + f.log2Delta.toFixed(1)],
          ["leading zeros", f.zerosBefore + " → " + f.zerosCandidate +
            " if taken"],
        ];
        for (var j = 0; j < rows.length; j++) {
          html += '<div class="row"><span>' + rows[j][0] +
            '</span><span class="n' + (j >= 2 ? " warn" : "") + '">' +
            rows[j][1] + "</span></div>";
        }
        html += '<div class="row"><span class="hint-inline">no ' + f.n +
          "-bit change improved on the starting point, so the input was " +
          "left alone</span></div>";
      }
      elFlipResult.innerHTML = html;
    }

    function paintScanProgress(p) {
      var pct = p.total > 0 ? Math.floor((p.tested / p.total) * 100) : 100;
      var html = '<div class="row"><span>scanning ' + p.n +
        '-bit flips</span><span class="n">' + pct + "%</span></div>" +
        '<div class="row"><span>tested</span><span class="n">' +
        fmtCount(p.tested) + " of " + fmtCount(p.total) + "</span></div>";
      if (p.etaSeconds !== null && p.etaSeconds !== undefined) {
        html += '<div class="row"><span>remaining</span><span class="n">' +
          fmtDuration(p.etaSeconds) + "</span></div>";
      }
      if (p.bestIndices) {
        html += '<div class="row"><span>best so far</span><span class="n">bits ' +
          p.bestIndices.join(" + ") + "</span></div>";
      }
      html += '<div class="progress"><span style="width:' + pct + '%"></span></div>';
      elFlipResult.innerHTML = html;
    }

    /**
     * The neutral-bit classification, as counts under the checkbox.
     *
     * The per-bit marks go on the grid itself, in paint(); this is the
     * summary and the caveat. The caveat matters: on a digest with no leading
     * zeros about half of all bits come back neutral and the map says very
     * little, whereas on one a sampling run has pushed to a dozen zeros
     * almost every bit worsens it and the neutral ones are genuinely notable.
     */
    function paintNeutral(state) {
      elNeutral.checked = state.showNeutral;
      var nz = state.neutral;
      if (!nz) { elNeutralSummary.innerHTML = ""; return; }

      /* "Marked" counts the bits that carry a visible mark, which is the
       * neutral and improving ones. The bits that lose leading zeros are
       * deliberately left unmarked: past a few leading zeros they are almost
       * every bit in the message, and marking them would be a wall of colour
       * saying nothing. */
      var marked = nz.same + nz.better;
      var rows = [
        ["bits marked", marked + " of " + nz.map.length],
        ["current leading zeros", String(nz.base)],
        [swatch("--fg-faint") + "no change if flipped", String(nz.same)],
        [swatch("--ok") + "more leading zeros", String(nz.better)],
        ["fewer leading zeros (unmarked)", String(nz.worse)],
      ];
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        html += '<div class="row"><span>' + rows[i][0] +
          '</span><span class="n">' + rows[i][1] + "</span></div>";
      }
      html += '<div class="row"><span class="hint-inline">' +
        (nz.base === 0
          ? "with no leading zeros to lose, about half of all bits are neutral"
          : "at " + nz.base + " leading zeros, landing on exactly that " +
            "count again is unlikely, so few bits are neutral") +
        "</span></div>";
      elNeutralSummary.innerHTML = html;
    }

    function swatch(varName) {
      return '<span class="swatch" style="background:var(' + varName + ')"></span>';
    }

    /** Compact counts: 1.2k, 3.4M, 2^78 once past what a reader can hold. */
    function fmtCount(n) {
      if (!isFinite(n)) return "∞";
      if (n >= 1e15) return "2^" + Math.log2(n).toFixed(1);
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
      return String(Math.round(n));
    }

    /* The padding, in the same terms the canvas uses: how many bits of each
     * kind end up in the compressed stream. */
    function paintSummary(state) {
      var L = state.analysis.layout;
      var ones = countOnes(state.msg);
      var rows = [
        ["message", L.nbits + " bits", "--role-message"],
        ["padding '1'", "1 bit", "--role-one"],
        ["padding zeros", L.zeroBits + " bits", "--role-zero"],
        ["length field", "64 bits", "--role-length"],
        ["padded total", L.totalBits + " bits (" + L.nblocks + " blocks)", null],
        ["set bits in message", ones + " of " + L.nbits, null],
      ];
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        var sw = rows[i][2]
          ? '<span class="swatch" style="background:var(' + rows[i][2] + ')"></span>'
          : "";
        html += '<div class="row"><span>' + sw + rows[i][0] +
          '</span><span class="n">' + rows[i][1] + "</span></div>";
      }
      elSummary.innerHTML = html;
    }

    function countOnes(msg) {
      var n = 0;
      for (var b = 0; b < msg.bytes.length; b++) n += M.popcount(msg.bytes[b]);
      return n;
    }

    // ---------------------------------------------------------------

    function render(state) {
      if (state.msg.nbits !== builtFor.nbits ||
          state.showInputBits !== builtFor.showBits) {
        build(state);
      }
      paint(state);
    }

    return { render: render };
  }

  root.SHATOOL_UI_INPUT = Object.freeze({ create: create });
})(typeof globalThis !== "undefined" ? globalThis : this);
