/*
 * shatool/js/ui-output.js — the right-hand digest and proof-of-work panel.
 *
 * Shows the 32-byte digest three ways over: as SHA-256 emits it, as 32 bytes
 * ordered by significance, and as all 256 bits in the order the difficulty
 * check compares them. Every byte is coloured by the part it plays in that
 * check, with the bands derived from the decoded nBits rather than hardcoded,
 * so changing the difficulty moves them.
 *
 * All of the arithmetic lives in SHATOOL_POW; this file only draws.
 *
 * ------------------------------------------------------------------
 * Why this panel patches instead of rebuilding
 * ------------------------------------------------------------------
 *
 * The cells animate: a bit that flips fades from its old colour to its new
 * one, which is what makes a sampling run legible as something happening
 * rather than as a blur. CSS transitions only fire on an element that
 * persists across the change, so assigning innerHTML — which destroys every
 * cell and creates new ones already at their final colour — would silently
 * disable the animation. The structure is therefore built once and only
 * classes and text are patched afterwards.
 */

(function (root) {
  "use strict";

  var P = root.SHATOOL_POW;

  /* The three roles, in the order the panel explains them. Kept here so the
   * legend text and the colouring cannot drift apart. */
  var ROLE_TEXT = {
    "must-be-zero": "must be zero at this difficulty",
    "coefficient": "compared against the nBits coefficient",
    "tail": "below the target's precision",
  };

  var hex2 = function (b) { return b.toString(16).padStart(2, "0"); };

  function create(cb) {
    var elDigestHex = document.getElementById("digest-hex");
    var elDigestBytes = document.getElementById("digest-bytes");
    var elShowBits = document.getElementById("chk-digest-bits");
    var elCustom = document.getElementById("pow-nbits-custom");
    var elVerdict = document.getElementById("pow-verdict");
    var elStats = document.getElementById("pow-stats");
    var elTarget = document.getElementById("pow-target");
    var elNote = document.getElementById("pow-note");
    var elRaster = document.getElementById("digest-bit-raster");
    var elRasterCaption = document.getElementById("digest-bit-caption");
    var elLzBadge = document.getElementById("lz-badge");
    var elBest = document.getElementById("pow-best");

    /* Persistent cell references, created by the build* functions below. */
    var hexSpans = null;        // 32, digest in emitted order
    var targetSpans = null;     // 32, target in emitted order
    var byteCells = null;       // 32, {root, val, bits[8]}, most significant first
    var rasterCells = null;     // 256, PoW bit order
    var noteSpans = null;       // 32, digest in Bitcoin display order
    var builtBytesWithBits = null;

    elShowBits.addEventListener("change", function () {
      cb.onShowDigestBits(elShowBits.checked);
    });

    elCustom.addEventListener("input", applyCustom);

    function applyCustom() {
      var v = parseInt(String(elCustom.value).replace(/^0[xX]/, ""), 16);
      if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) cb.onSetNBits(v >>> 0);
    }

    // ---------------------------------------------------------------
    // Structure, built once
    // ---------------------------------------------------------------

    /** A row of 32 hex-byte spans inside `container`, in the given order. */
    function buildHexRow(container, reversed) {
      var spans = new Array(32);
      container.textContent = "";
      for (var k = 0; k < 32; k++) {
        var i = reversed ? 31 - k : k;
        var s = document.createElement("span");
        s.className = "dh-byte";
        container.appendChild(s);
        spans[i] = s;
      }
      return spans;
    }

    function buildByteCells(showBits) {
      var cells = new Array(32);
      elDigestBytes.textContent = "";
      /* Most significant first: the panel is explaining significance, so
       * reading order should follow it. */
      for (var k = 0; k < 32; k++) {
        var i = 31 - k;
        var cell = document.createElement("div");
        cell.className = "db-cell";

        var top = document.createElement("div");
        top.className = "db-top";
        var idx = document.createElement("span");
        idx.className = "db-idx";
        idx.textContent = String(i);
        var val = document.createElement("span");
        val.className = "db-val";
        top.appendChild(idx);
        top.appendChild(val);
        cell.appendChild(top);

        var bits = null;
        if (showBits) {
          bits = new Array(8);
          var row = document.createElement("div");
          row.className = "db-bits";
          for (var p = 7; p >= 0; p--) {
            var bcell = document.createElement("span");
            bcell.className = "db-bit";
            row.appendChild(bcell);
            bits[p] = bcell;
          }
          cell.appendChild(row);
        }

        elDigestBytes.appendChild(cell);
        cells[i] = { root: cell, val: val, bits: bits };
      }
      builtBytesWithBits = showBits;
      return cells;
    }

    function buildRaster() {
      var cells = new Array(256);
      /* textContent = "" would drop the badge, which is markup rather than a
       * generated cell, so it is detached and put back around the rebuild. */
      elRaster.textContent = "";
      elRaster.appendChild(elLzBadge);
      for (var k = 0; k < 256; k++) {
        if (k % 32 === 0) {
          var lab = document.createElement("div");
          lab.className = "br-label";
          lab.textContent = String(k);
          elRaster.appendChild(lab);
        }
        var c = document.createElement("div");
        c.className = "br-bit";
        elRaster.appendChild(c);
        cells[k] = c;
      }
      return cells;
    }

    // ---------------------------------------------------------------
    // Ordering
    // ---------------------------------------------------------------

    /**
     * Where bit `k` of the proof-of-work value lives in the digest.
     *
     * k = 0 is the most significant bit of the whole 256-bit value, which is
     * bit 7 of digest[31] — the top bit of the LAST byte SHA-256 emits.
     * k = 255 is the least significant, bit 0 of digest[0].
     */
    function powBitLocation(k) {
      return { byteIndex: 31 - (k >> 3), bitInByte: 7 - (k & 7) };
    }

    // ---------------------------------------------------------------
    // Paint
    // ---------------------------------------------------------------

    function paintHexRow(spans, bytes, roles, deciding) {
      for (var i = 0; i < 32; i++) {
        var s = spans[i];
        var cls = "dh-byte " + roles[i].role;
        if (bytes[i] === 0) cls += " is-zero";
        if (i === deciding) cls += " deciding";
        if (s.className !== cls) s.className = cls;
        var text = hex2(bytes[i]);
        if (s.textContent !== text) s.textContent = text;
        s.title = "digest byte " + i + " · weight 256^" + i + " · " +
          ROLE_TEXT[roles[i].role];
      }
    }

    function paintByteCells(state) {
      var a = state.pow;
      var d = state.analysis.digest;
      for (var i = 0; i < 32; i++) {
        var c = byteCells[i];
        var role = a.roles[i].role;
        var cls = "db-cell " + role + (d[i] === 0 ? " is-zero" : "");
        if (c.root.className !== cls) c.root.className = cls;
        c.root.title = "digest byte " + i + " · weight 256^" + i + " · " +
          ROLE_TEXT[role];
        var text = hex2(d[i]);
        if (c.val.textContent !== text) c.val.textContent = text;
        if (c.bits) {
          for (var p = 0; p < 8; p++) {
            var on = ((d[i] >> p) & 1) === 1;
            var bc = "db-bit" + (on ? " on" : "");
            if (c.bits[p].className !== bc) c.bits[p].className = bc;
          }
        }
      }
    }

    /**
     * The 256-bit raster, in proof-of-work significance order.
     *
     * Thirty-two bits per row, so a row is four digest bytes and the grid
     * lines up with the byte panel above it. The run of bits the target
     * requires to be zero is shaded darker and terminated by a marker, which
     * turns the difficulty check into something readable off the shape: the
     * black block has to reach the marker.
     */
    function paintRaster(state) {
      var a = state.pow;
      var d = state.analysis.digest;

      /* The outlined region is the GOAL set in the sampling control, not what
       * Bitcoin's target demands. Those differ by a factor nobody can cross
       * on one machine — 16 against 78 for the mainnet default — and drawing
       * the real one would put the boundary off the picture and leave the
       * whole raster looking uniformly hopeless. The real requirement is
       * stated next to the control that sets the goal, with the ratio, so the
       * small number cannot be mistaken for the real one. */
      var required = state.search.threshold;
      var achieved = a.leadingZeroBits;

      /* The best any point in the current search session reached — sampling
       * runs and flip scans both feed it. -1 until something has been tried;
       * the Reset button clears it. Marked on the raster as well as counted
       * below it, because the distance between where the best got to and
       * where the target sits is the whole story of a search, and it is far
       * more legible as two marks than as two numbers. */
      var session = state.search;
      var sessionBest = session.attempts > 0 ? session.best : -1;

      for (var k = 0; k < 256; k++) {
        var loc = powBitLocation(k);
        var bit = (d[loc.byteIndex] >> loc.bitInByte) & 1;
        var inReq = k < required;
        var cls = "br-bit " + a.roles[loc.byteIndex].role;
        if (bit) cls += " on";
        if (inReq) cls += " req";

        /* The required-zero region, outlined. It is a prefix of a 32-column
         * row-major grid, so its outline is a staircase: full rows while the
         * requirement lasts, then a partial one. Each cell is told which of
         * its own edges lie on that boundary, which is the only way to draw
         * the shape without computing pixel geometry that would then have to
         * agree with the CSS grid.
         *
         * Together with the green fill of the zeros already achieved, this
         * reads as a progress bar: the outline is the container, the fill is
         * how far along it you are. */
        if (inReq) {
          var col = k % 32;
          if (k < 32) cls += " rq-top";
          if (col === 0) cls += " rq-left";
          if (col === 31 || k + 1 >= required) cls += " rq-right";
          if (k + 32 >= required) cls += " rq-bottom";

          /* A 1 where the target demands a 0. Every one of these breaks the
           * requirement, and the most significant is the one that actually
           * decides it — a single 1 above everything else already puts the
           * value over target no matter what follows. */
          if (bit) {
            cls += " violate";
            if (k === achieved) cls += " violate-first";
          }
        }
        /* The leading zeros this digest actually has, as a filled block.
         * Fill rather than an edge, because the two markers already on the
         * raster use edges: a colour channel each, so none of the three can
         * be mistaken for another. Where the green stops IS the count, and
         * within the required run it separates the zeros already in hand
         * from the ones still needed. */
        if (k < achieved) cls += " lz-run";
        if (k === required) cls += " boundary";
        if (k === sessionBest) cls += " sess-best";
        var cell = rasterCells[k];
        if (cell.className !== cls) cell.className = cls;
        cell.title = "PoW bit " + k + " · digest byte " + loc.byteIndex +
          " bit " + loc.bitInByte + " · value " + bit +
          (k < achieved ? " · inside this digest's leading zeros" : "") +
          (inReq ? " · must be zero to reach the goal" : "") +
          (inReq && bit
            ? (k === achieved ? " · VIOLATION, and the decisive one"
                              : " · violates the requirement")
            : "") +
          (k === sessionBest ? " · best this session reached here" : "");
      }

      /* The count, on the picture rather than only under it. Hidden at zero:
       * a run of no length has nothing to label. */
      if (achieved > 0) {
        elLzBadge.hidden = false;
        elLzBadge.textContent = achieved +
          (achieved === 1 ? " leading zero" : " leading zeros");
        elLzBadge.className = "lz-badge" + (achieved >= required ? " pass" : "");
      } else {
        elLzBadge.hidden = true;
      }

      var pass = achieved >= required;
      var html = '<div class="rc-row"><span>goal: ≥ ' + required +
        " leading zero bits</span>" +
        '<span class="n ' + (pass ? "pass" : "fail") + '">this digest has ' +
        achieved + "</span></div>";

      html += '<div class="rc-row rc-key">' +
        '<span class="key-outline"></span>zeros the goal needs' +
        '<span class="key-fill"></span>zeros achieved' +
        '<span class="key-bad"></span>1 where the goal needs a 0' +
        "</div>";

      if (sessionBest >= 0) {
        var reached = sessionBest >= required;
        html += '<div class="rc-row"><span>' + swatch("--warn") +
          "best this search session</span>" +
          '<span class="n ' + (reached ? "pass" : "") + '">' + sessionBest +
          " in " + session.attempts.toLocaleString() + " points</span></div>";
      }
      elRasterCaption.innerHTML = html;
    }

    function paintPow(state) {
      var a = state.pow;
      var dec = a.decoded;

      elVerdict.className = "verdict " + (a.meetsTarget ? "pass" : "fail");
      if (dec.negative || dec.overflow) {
        elVerdict.className = "verdict fail";
        elVerdict.innerHTML = "invalid nBits" +
          '<span class="why">' +
          (dec.negative ? "sign bit set" : "coefficient overflows the exponent") +
          "</span>";
      } else if (a.meetsTarget) {
        elVerdict.innerHTML = "≤ target — would be accepted" +
          '<span class="why">' +
          (a.decidingIndex < 0
            ? "digest equals the target exactly"
            : "settled at byte " + a.decidingIndex + ", the most significant " +
              "byte where digest and target differ") +
          "</span>";
      } else {
        elVerdict.innerHTML = "&gt; target — would be rejected" +
          '<span class="why">settled at byte ' + a.decidingIndex +
          ": digest 0x" + hex2(state.analysis.digest[a.decidingIndex]) +
          " exceeds target 0x" + hex2(a.target[a.decidingIndex]) + "</span>";
      }

      var rows = [
        ["nBits", "0x" + dec.nBits.toString(16).padStart(8, "0")],
        ["exponent", "0x" + dec.exponent.toString(16) + " (" + dec.exponent + ")"],
        ["coefficient", "0x" + dec.coefficient.toString(16).padStart(6, "0")],
        ["zero bytes required", String(a.zeroBytesRequired)],
        ["zero bytes achieved", String(a.zeroBytesAchieved)],
        ["leading zero bits", String(a.leadingZeroBits) + " of 256"],
        ["expected work", expectedWork(a)],
      ];
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        html += '<div class="row"><span>' + rows[i][0] +
          '</span><span class="n">' + rows[i][1] + "</span></div>";
      }

      /* Colour key, generated from the same role names used to colour the
       * bytes above, so a role can never appear on screen unexplained. */
      html += '<div class="row" style="margin-top:8px"><span>' +
        swatch("--pow-zero") + "bytes " + dec.zeroFrom + "–31</span>" +
        '<span class="n">' + ROLE_TEXT["must-be-zero"] + "</span></div>";
      html += '<div class="row"><span>' + swatch("--pow-coeff") +
        "bytes " + Math.max(0, dec.exponent - 3) + "–" + dec.msbIndex +
        "</span><span class=\"n\">" + ROLE_TEXT["coefficient"] + "</span></div>";
      html += '<div class="row"><span>' + swatch("--pow-tail") +
        "bytes 0–" + Math.max(0, dec.exponent - 4) +
        "</span><span class=\"n\">" + ROLE_TEXT["tail"] + "</span></div>";
      elStats.innerHTML = html;
    }

    /**
     * The hardest difficulty this digest would have satisfied.
     *
     * The panel above answers "does it clear the difficulty you picked". This
     * answers the question that does not need a difficulty picked at all:
     * since the check is `value <= target`, the smallest target a digest
     * satisfies is its own value, and every easier difficulty is cleared too.
     * Reported in Bitcoin's usual units, where 1 is the genesis block's
     * difficulty — so a random digest lands far below 1, and watching this
     * number climb is what a sampling run is actually doing.
     */
    function paintBest(state) {
      var h = P.hardestCleared(state.analysis.digest);
      if (h.zero) {
        elBest.innerHTML = '<div class="bd-main">every difficulty</div>' +
          '<div class="bd-note">an all-zero digest is under every target</div>';
        return;
      }

      /* Below about 1e-4 the fixed-point form is all zeros and says nothing,
       * so switch to the exponent that does. */
      var d = h.difficulty;
      var pretty = d >= 1e-4
        ? (d >= 1000 ? d.toExponential(3) : d.toPrecision(4))
        : d.toExponential(3);

      var rows = [
        ["as nBits", "0x" + h.nBits.toString(16).padStart(8, "0")],
        ["leading zero bits", String(h.leadingZeroBits)],
        ["expected samples", "2^" + h.log2ExpectedAttempts.toFixed(1)],
        ["vs genesis (difficulty 1)",
          h.log2Difficulty >= 0
            ? "2^" + h.log2Difficulty.toFixed(1) + " × harder"
            : "2^" + (-h.log2Difficulty).toFixed(1) + " × easier"],
      ];
      var html = '<div class="bd-main">difficulty ' + pretty + "</div>";
      html += '<div class="summary" style="margin-top:6px;border:0;padding:0">';
      for (var i = 0; i < rows.length; i++) {
        html += '<div class="row"><span>' + rows[i][0] +
          '</span><span class="n">' + rows[i][1] + "</span></div>";
      }
      html += "</div>";
      html += '<div class="bd-note">the smallest target this digest still ' +
        "satisfies is its own value, so this is the hardest difficulty it " +
        "would have cleared</div>";
      elBest.innerHTML = html;
    }

    /**
     * The digest in Bitcoin display order, inside the explanatory note.
     *
     * The prose around it lives in index.html, not here — it is content, not
     * behaviour, and a renderer that carries three paragraphs of English is a
     * renderer nobody edits the English in. This only fills the one element
     * that actually changes.
     */
    function paintNote(state) {
      if (!noteSpans) {
        noteSpans = buildHexRow(document.getElementById("note-display"), true);
      }
      paintHexRow(noteSpans, state.analysis.digest, state.pow.roles,
        state.pow.decidingIndex);
    }

    function swatch(varName) {
      return '<span class="swatch" style="background:var(' + varName + ')"></span>';
    }

    /**
     * How many digests one would expect to try to land under this target.
     *
     * The probability a uniform 256-bit value is <= target is
     * (target + 1) / 2^256, so the expected count is its reciprocal. Computed
     * from the exponent and coefficient in floating point, which is plenty
     * for a figure only ever displayed to one decimal place.
     */
    function expectedWork(a) {
      var dec = a.decoded;
      if (dec.negative || dec.overflow || dec.coefficient === 0) return "—";
      var log2Target = Math.log2(dec.coefficient) + 8 * (dec.exponent - 3);
      var log2Tries = 256 - log2Target;
      if (log2Tries < 0) return "1 (target exceeds the range)";
      return "2^" + log2Tries.toFixed(1) + " hashes";
    }

    // ---------------------------------------------------------------

    function render(state) {
      /* Keep the field in step with the state, without fighting the caret
       * while it is being typed into. */
      if (elCustom !== document.activeElement) {
        elCustom.value = "0x" + state.nBits.toString(16).padStart(8, "0");
      }

      if (!hexSpans) hexSpans = buildHexRow(elDigestHex, false);
      if (!targetSpans) targetSpans = buildHexRow(elTarget, false);
      if (!rasterCells) rasterCells = buildRaster();
      if (!byteCells || builtBytesWithBits !== state.showDigestBits) {
        byteCells = buildByteCells(state.showDigestBits);
      }
      elShowBits.checked = state.showDigestBits;

      paintHexRow(hexSpans, state.analysis.digest, state.pow.roles,
        state.pow.decidingIndex);
      paintHexRow(targetSpans, state.pow.target, state.pow.roles, -1);
      paintByteCells(state);
      paintRaster(state);
      paintPow(state);
      paintNote(state);
      paintBest(state);
    }

    return { render: render };
  }

  root.SHATOOL_UI_OUTPUT = Object.freeze({ create: create });
})(typeof globalThis !== "undefined" ? globalThis : this);
