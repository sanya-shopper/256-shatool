/*
 * shatool/js/ui-canvas.js — the computation raster.
 *
 * Draws one block's compression as three bit rasters stacked vertically:
 *
 *      W   the message schedule,  W[0..63]
 *      A   the A track,           A[-4..63]
 *      E   the E track,           E[-4..63]
 *
 * Time runs left to right: column t holds W[t], A[t] and E[t], vertically
 * aligned, so a single column is one round of the recurrence and the whole
 * picture is the block's history. Bits run top to bottom within each band,
 * bit 31 (most significant) at the top.
 *
 * ------------------------------------------------------------------
 * The visual grammar, which is fixed across the whole canvas
 * ------------------------------------------------------------------
 *
 *   HUE encodes which track a cell belongs to — amber W, cyan A, violet E.
 *   LUMINANCE encodes the bit's value — bright for 1, near-background for 0.
 *   HATCHED/EMPTY means "not computed", i.e. a round beyond the round limit.
 *
 * Those three channels never swap meanings anywhere in the drawing. In diff
 * mode the whole grammar switches at once and the legend says so: hue no
 * longer encodes track, and a lit cell means "this bit differs from the
 * reference" rather than "this bit is 1".
 *
 * ------------------------------------------------------------------
 * Why the axis is always 68 columns wide
 * ------------------------------------------------------------------
 *
 * t runs from -4 to 63 regardless of the round limit. The four negative
 * columns are the seed window — those A and E values come from the incoming
 * chaining value, not from any round — and are separated by a rule so they
 * are not mistaken for computation. Keeping the axis at its full width when
 * the round limit is reduced means the geometry does not jump while the
 * limit is being scrubbed, and it shows that the schedule is computed for all
 * 64 rounds whether or not they run.
 */

(function (root) {
  "use strict";

  var M = root.SHATOOL_MODEL;

  var T_MIN = -4;
  var T_MAX = 63;
  var COLS = T_MAX - T_MIN + 1;   // 68
  var BITS = 32;

  /* Band definitions, in the order the round reads them: the two inputs to a
   * round on top, the two state tracks below.
   *
   * `rgb` is the "bit is 1" colour; the "bit is 0" colour is the same hue
   * crushed towards the background, computed once below.
   *
   * K is included even though it never varies — it is the same 64 constants
   * for every message and every block. Seeing it is the point: half of what
   * feeds T1 each round is fixed, and in diff mode the K band stays
   * completely dark while everything below it lights up, which is a clearer
   * statement of "K contributes nothing to the difference" than a sentence
   * would be. */
  var BANDS = [
    { key: "K", title: "K", rgb: [122, 190, 106], constant: true },
    { key: "W", title: "W", rgb: [216, 162, 74] },
    { key: "A", title: "A", rgb: [70, 198, 216] },
    { key: "E", title: "E", rgb: [157, 127, 240] },
  ];

  var DIFF_ON = [240, 96, 96];    // this bit differs from the reference
  var DIFF_OFF = [26, 32, 41];

  var GUTTER = 26;                // left margin for band letters
  var PAD_R = 8;
  var PAD_T = 14;                 // room for the bit-index label
  var AXIS_H = 16;                // bottom ruler
  var BAND_GAP = 10;

  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  /** Mix a colour towards the sunken background; f = 0 keeps it, 1 kills it. */
  function dim(c, f) {
    var bg = [10, 13, 18];
    return [
      Math.round(c[0] + (bg[0] - c[0]) * f),
      Math.round(c[1] + (bg[1] - c[1]) * f),
      Math.round(c[2] + (bg[2] - c[2]) * f),
    ];
  }

  /**
   * @param {Object} cb
   *   cb.onSelectRound(t|null)  a column was clicked
   */
  function create(cb) {
    var wrap = document.getElementById("canvas-wrap");
    var canvas = document.getElementById("canvas-main");
    var tooltip = document.getElementById("canvas-tooltip");
    var elTabs = document.getElementById("block-tabs");
    var elLegend = document.getElementById("canvas-legend");
    var elDetail = document.getElementById("round-detail");
    var elRounds = document.getElementById("input-rounds");
    var elDiff = document.getElementById("chk-diff");
    var elPin = document.getElementById("btn-set-reference");

    var elChaining = document.getElementById("chaining");
    var elAnimate = document.getElementById("chk-animate");

    var ctx = canvas.getContext("2d");
    var lastState = null;
    var geom = null;      // recomputed on every draw; used for hit testing
    var hover = null;     // {band, t, bit} or null

    // ---------------------------------------------------------------
    // Change afterglow
    // ---------------------------------------------------------------
    //
    // Every cell carries a decaying value in [0, 1] that is set to 1 the
    // moment its bit flips and fades to nothing over a few frames. Drawn as a
    // white overlay, it answers the question the raster alone cannot: not
    // "what is the state" but "what did that edit just do". Toggling one
    // input bit lights a handful of cells in W and then a widening wedge
    // through A and E, which is the avalanche happening rather than the
    // avalanche summarised.
    //
    // Indexing is ((band * COLS) + column) * BITS + row throughout.

    var CELLS = BANDS.length * COLS * BITS;
    var SLOTS = BANDS.length * COLS;
    var glow = new Float32Array(CELLS);
    var prevWords = new Uint32Array(SLOTS);
    var prevValid = new Uint8Array(SLOTS);
    var glowActive = false;
    var rafId = null;
    var contextKey = null;

    var GLOW_DECAY = 0.80;        // per frame
    var GLOW_LEVELS = 6;          // quantisation, so alpha is set 6 times not 8704
    var GLOW_MAX_ALPHA = 0.38;    // deliberately short of white; see below

    /* A viewer who has asked their system for reduced motion gets none. The
     * raster still updates, it simply does not flash — which also removes the
     * one case where this could strobe: a fast sampling run changes about
     * half of every word every frame. GLOW_MAX_ALPHA is capped well short of
     * opaque for the same reason. */
    var reduceMotion = false;
    if (typeof root.matchMedia === "function") {
      try {
        reduceMotion = root.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch (e) { reduceMotion = false; }
    }

    var raf = typeof root.requestAnimationFrame === "function"
      ? function (fn) { return root.requestAnimationFrame(fn); }
      : function (fn) { return setTimeout(fn, 16); };

    /**
     * Compare the incoming frame against the previous one and light whatever
     * changed. Called once per state change, never from the decay loop.
     *
     * A change of *context* — a different block, round limit, message length
     * or diff mode — repopulates the previous frame without lighting
     * anything. Otherwise switching blocks would flash the entire canvas,
     * which says "everything changed" when nothing was edited.
     */
    function updateGlow(state) {
      var key = [state.blockIndex, state.rounds, state.msg.nbits,
                 state.diffMode ? 1 : 0].join(":");
      var fresh = key !== contextKey;
      contextKey = key;

      var animate = state.animate && !reduceMotion;
      var trace = state.analysis.blocks[state.blockIndex].trace;
      var lit = false;

      for (var b = 0; b < BANDS.length; b++) {
        for (var c = 0; c < COLS; c++) {
          var t = c + T_MIN;
          var w = state.diffMode
            ? diffWordAt(state.diff, BANDS[b].key, t)
            : wordAt(trace, BANDS[b].key, t);
          var slot = b * COLS + c;
          var has = w !== undefined;
          var val = has ? (w >>> 0) : 0;

          if (!fresh && animate && has && prevValid[slot]) {
            var changed = (prevWords[slot] ^ val) >>> 0;
            if (changed) {
              var base = slot * BITS;
              for (var r = 0; r < BITS; r++) {
                if ((changed >>> (31 - r)) & 1) { glow[base + r] = 1; lit = true; }
              }
            }
          }
          prevWords[slot] = val;
          prevValid[slot] = has ? 1 : 0;
        }
      }

      if (fresh || !animate) {
        glow.fill(0);
        glowActive = false;
        return;
      }
      if (lit) { glowActive = true; startDecay(); }
    }

    function startDecay() {
      if (rafId !== null) return;
      rafId = raf(function tick() {
        rafId = null;
        var any = false;
        for (var i = 0; i < CELLS; i++) {
          var v = glow[i];
          if (v > 0) {
            v *= GLOW_DECAY;
            glow[i] = v < 0.02 ? 0 : v;
            if (glow[i] > 0) any = true;
          }
        }
        glowActive = any;
        draw();
        if (any) rafId = raf(tick);
      });
    }

    // ---------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------

    elRounds.addEventListener("change", function () {
      var n = parseInt(elRounds.value, 10);
      if (Number.isInteger(n)) cb.onSetRounds(n);
    });
    elDiff.addEventListener("change", function () { cb.onDiff(elDiff.checked); });
    elAnimate.addEventListener("change", function () {
      cb.onAnimate(elAnimate.checked);
    });
    elPin.addEventListener("click", function () { cb.onPinReference(); });

    elTabs.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t && t.classList.contains("tab")) {
        cb.onSelectBlock(parseInt(t.getAttribute("data-block"), 10));
      }
    });

    canvas.addEventListener("mousemove", function (ev) {
      var h = hitTest(ev);
      /* Only redraw when the hovered cell actually changed. Without this the
       * canvas is repainted on every mouse event, which is visible as lag on
       * a large window. */
      if (sameHit(h, hover)) { if (h) placeTooltip(ev); return; }
      hover = h;
      if (h) { showTooltip(ev, h); } else { tooltip.hidden = true; }
      draw();
    });

    canvas.addEventListener("mouseleave", function () {
      if (hover) { hover = null; tooltip.hidden = true; draw(); }
    });

    canvas.addEventListener("click", function (ev) {
      var h = hitTest(ev);
      if (!h) return;
      /* The seed columns are not rounds, so they cannot be selected: there is
       * no T1/T2 to show for them. */
      if (h.t < 0) { cb.onSelectRound(null); return; }
      var already = lastState && lastState.selectedRound === h.t;
      cb.onSelectRound(already ? null : h.t);
    });

    /* Keep the backing store matched to the element's CSS size. ResizeObserver
     * fires for layout changes that a window resize event misses, such as the
     * panel reflowing when the summary below it grows. */
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { resize(); }).observe(wrap);
    }
    root.addEventListener("resize", resize);

    function resize() {
      var dpr = root.devicePixelRatio || 1;
      var w = wrap.clientWidth, h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      draw();
    }

    // ---------------------------------------------------------------
    // Geometry and hit testing
    // ---------------------------------------------------------------

    function computeGeom() {
      var dpr = root.devicePixelRatio || 1;
      var w = canvas.width / dpr, h = canvas.height / dpr;
      var gridW = Math.max(1, w - GUTTER - PAD_R);
      var bandsH = Math.max(1, h - PAD_T - AXIS_H - BAND_GAP * (BANDS.length - 1));
      var bandH = bandsH / BANDS.length;
      return {
        dpr: dpr, w: w, h: h,
        x0: GUTTER, y0: PAD_T,
        cellW: gridW / COLS,
        cellH: bandH / BITS,
        bandH: bandH,
        bandY: function (i) { return PAD_T + i * (bandH + BAND_GAP); },
      };
    }

    /** Pixel x of column t (left edge). */
    function colX(g, t) { return g.x0 + (t - T_MIN) * g.cellW; }

    function hitTest(ev) {
      if (!geom || !lastState) return null;
      var r = canvas.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      var t = Math.floor((x - geom.x0) / geom.cellW) + T_MIN;
      if (t < T_MIN || t > T_MAX) return null;
      for (var i = 0; i < BANDS.length; i++) {
        var by = geom.bandY(i);
        if (y >= by && y < by + geom.bandH) {
          var bit = Math.floor((y - by) / geom.cellH);
          if (bit < 0 || bit >= BITS) return null;
          return { bandIndex: i, band: BANDS[i].key, t: t, bit: bit };
        }
      }
      return null;
    }

    function sameHit(a, b) {
      if (a === null || b === null) return a === b;
      return a.band === b.band && a.t === b.t && a.bit === b.bit;
    }

    // ---------------------------------------------------------------
    // Values
    // ---------------------------------------------------------------

    /** The 32-bit word at (band, t), or undefined if not computed. */
    function wordAt(trace, band, t) {
      if (band === "K") return (t >= 0 && t < 64) ? root.SHAVAR.K[t] : undefined;
      if (band === "W") return (t >= 0 && t < trace.W.length) ? trace.W[t] : undefined;
      return M.track(trace, band, t);
    }

    /** The same, from a diff mask (which is stored in the trace's layout). */
    function diffWordAt(diff, band, t) {
      if (!diff) return undefined;
      /* K is a constant of the algorithm, so it is identical between any two
       * messages: its difference is zero by construction, not by coincidence. */
      if (band === "K") return (t >= 0 && t < 64) ? 0 : undefined;
      if (band === "W") return (t >= 0 && t < diff.W.length) ? diff.W[t] : undefined;
      var i = 4 + t;
      var arr = diff[band];
      return (i >= 0 && i < arr.length) ? arr[i] : undefined;
    }

    /** Row r of a band shows bit (31 - r): most significant at the top. */
    function bitOf(word, r) { return (word >>> (31 - r)) & 1; }

    // ---------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------

    function draw() {
      if (!lastState) return;
      var g = geom = computeGeom();
      ctx.save();
      ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);

      var state = lastState;
      var block = state.analysis.blocks[state.blockIndex];
      if (!block) { ctx.restore(); return; }
      var trace = block.trace;
      var diff = state.diffMode ? state.diff : null;

      for (var i = 0; i < BANDS.length; i++) {
        drawBand(g, i, trace, diff, state);
      }
      drawGlow(g);
      drawSeedRule(g);
      drawSelection(g, state);
      drawHover(g);
      drawAxis(g, state);
      ctx.restore();
    }

    /**
     * The afterglow overlay: white, quantised into GLOW_LEVELS alpha steps so
     * that `globalAlpha` is assigned a handful of times per frame instead of
     * once per cell. Cells are visited in index order and tested against each
     * level's band, which costs a few passes over a typed array and no
     * allocation.
     */
    function drawGlow(g) {
      if (!glowActive) return;
      ctx.fillStyle = "#ffffff";
      for (var level = 1; level <= GLOW_LEVELS; level++) {
        var lo = (level - 1) / GLOW_LEVELS;
        var hi = level / GLOW_LEVELS;
        ctx.globalAlpha = (level / GLOW_LEVELS) * GLOW_MAX_ALPHA;
        for (var b = 0; b < BANDS.length; b++) {
          var y0 = g.bandY(b);
          for (var c = 0; c < COLS; c++) {
            var base = (b * COLS + c) * BITS;
            var x = g.x0 + c * g.cellW;
            for (var r = 0; r < BITS; r++) {
              var v = glow[base + r];
              if (v > lo && v <= hi) {
                ctx.fillRect(x, y0 + r * g.cellH, g.cellW + 0.5, g.cellH + 0.5);
              }
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawBand(g, bandIndex, trace, diff, state) {
      var band = BANDS[bandIndex];
      var y0 = g.bandY(bandIndex);
      var onColor = state.diffMode ? DIFF_ON : band.rgb;
      var offColor = state.diffMode ? DIFF_OFF : dim(band.rgb, 0.88);

      /* Background for the whole band, then only the lit cells are filled.
       * Drawing 2176 rects instead of 4352 is worth having on a large
       * window, and the flat background reads more evenly than a grid of
       * separately-filled dark rects. */
      ctx.fillStyle = rgb(offColor);
      ctx.fillRect(g.x0, y0, COLS * g.cellW, g.bandH);

      ctx.fillStyle = rgb(onColor);
      for (var t = T_MIN; t <= T_MAX; t++) {
        var word = state.diffMode
          ? diffWordAt(diff, band.key, t)
          : wordAt(trace, band.key, t);

        if (word === undefined) {
          /* Not computed: past the round limit, or a W column in the seed
           * region. Painted in the panel background so it reads as absent
           * rather than as all-zero. */
          ctx.fillStyle = "rgb(14,17,22)";
          ctx.fillRect(colX(g, t), y0, g.cellW, g.bandH);
          ctx.fillStyle = rgb(onColor);
          continue;
        }

        var x = colX(g, t);
        for (var r = 0; r < BITS; r++) {
          if (bitOf(word, r)) {
            /* +0.5 on the size closes the seams that appear between
             * fractional-width rects on a non-integral cell size. */
            ctx.fillRect(x, y0 + r * g.cellH, g.cellW + 0.5, g.cellH + 0.5);
          }
        }
      }

      /* Byte separators inside the word: every 8 bits, so a reader can count
       * to a bit position without counting 32 rows. */
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      for (var k = 8; k < BITS; k += 8) {
        ctx.fillRect(g.x0, y0 + k * g.cellH - 0.5, COLS * g.cellW, 1);
      }

      /* Band letter and the bit-index bounds. */
      ctx.fillStyle = state.diffMode ? "#8b96a5" : rgb(dim(band.rgb, 0.25));
      ctx.font = "600 12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(band.title, 4, y0 + g.bandH / 2);

      ctx.fillStyle = "#4a5461";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "bottom";
      ctx.fillText("31", 4, y0 + 9);
      ctx.textBaseline = "top";
      ctx.fillText("0", 4, y0 + g.bandH - 9);
    }

    /* The rule between t = -1 and t = 0: everything left of it is the seed
     * window taken from the chaining value, everything right of it is
     * computed by the round function. */
    function drawSeedRule(g) {
      var x = colX(g, 0);
      ctx.strokeStyle = "rgba(216,222,231,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD_T - 4);
      ctx.lineTo(x, g.h - AXIS_H + 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function drawSelection(g, state) {
      var t = state.selectedRound;
      if (t === null || t === undefined) return;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      ctx.strokeRect(colX(g, t) - 0.5, PAD_T - 3.5,
        g.cellW + 1, g.h - AXIS_H - PAD_T + 6);
    }

    function drawHover(g) {
      if (!hover) return;
      var x = colX(g, hover.t);
      var y = g.bandY(hover.bandIndex) + hover.bit * g.cellH;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, y - 0.5, g.cellW + 1, g.cellH + 1);
    }

    function drawAxis(g, state) {
      var y = g.h - AXIS_H + 4;
      ctx.fillStyle = "#5a6472";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";

      /* Label every eighth round, plus the seed marker. Denser labels do not
       * fit at typical widths and denser ticks do not help. */
      for (var t = 0; t <= T_MAX; t += 8) {
        ctx.fillText(String(t), colX(g, t) + g.cellW / 2, y);
      }
      ctx.fillText("seed", colX(g, T_MIN) + g.cellW * 2, y);

      ctx.textAlign = "right";
      ctx.fillStyle = "#4a5461";
      ctx.fillText("t →  round", g.w - PAD_R, y);

      /* Grey out the columns past the round limit so the limit is visible on
       * the axis and not only in the bands. */
      if (state.rounds < 64) {
        var x = colX(g, state.rounds);
        ctx.fillStyle = "rgba(14,17,22,0.75)";
        ctx.fillRect(x, y - 3, g.w - PAD_R - x, AXIS_H);
      }
    }

    // ---------------------------------------------------------------
    // Tooltip
    // ---------------------------------------------------------------

    function showTooltip(ev, h) {
      var state = lastState;
      var trace = state.analysis.blocks[state.blockIndex].trace;
      var word = wordAt(trace, h.band, h.t);
      var bitIndex = 31 - h.bit;

      var lines = [];
      var label = h.band + "[" + h.t + "]";
      if (h.t < 0 && h.band !== "W") label += "   seed, from H[" + (-h.t - 1) + "]";
      lines.push(label);

      if (word === undefined) {
        lines.push(h.band === "W" && h.t < 0
          ? "no schedule word before t=0"
          : "not computed at " + state.rounds + " rounds");
      } else {
        lines.push("word    " + hex8(word));
        lines.push("bit " + String(bitIndex).padStart(2) + "  " +
          ((word >>> bitIndex) & 1));
        if (state.diffMode) {
          var d = diffWordAt(state.diff, h.band, h.t);
          if (d !== undefined) {
            lines.push("diff    " + hex8(d) + "  (" + M.popcount(d) + " bits)");
          }
        }
      }
      tooltip.textContent = lines.join("\n");
      tooltip.hidden = false;
      placeTooltip(ev);
    }

    function placeTooltip(ev) {
      var r = wrap.getBoundingClientRect();
      var x = ev.clientX - r.left + 14;
      var y = ev.clientY - r.top + 14;
      /* Flip before the edge rather than after, so the tooltip never causes
       * the wrapper to scroll or clip. */
      if (x + tooltip.offsetWidth > r.width - 4) {
        x = ev.clientX - r.left - tooltip.offsetWidth - 10;
      }
      if (y + tooltip.offsetHeight > r.height - 4) {
        y = ev.clientY - r.top - tooltip.offsetHeight - 10;
      }
      tooltip.style.left = Math.max(2, x) + "px";
      tooltip.style.top = Math.max(2, y) + "px";
    }

    function hex8(x) { return (x >>> 0).toString(16).padStart(8, "0"); }

    // ---------------------------------------------------------------
    // Surrounding chrome
    // ---------------------------------------------------------------

    function renderTabs(state) {
      var n = state.analysis.blocks.length;
      var html = "";
      for (var i = 0; i < n; i++) {
        html += '<button type="button" class="tab' +
          (i === state.blockIndex ? " active" : "") +
          '" data-block="' + i + '">block ' + i + "</button>";
      }
      elTabs.innerHTML = html;
    }

    function renderLegend(state) {
      var items;
      if (state.diffMode) {
        items = [
          [rgb(DIFF_ON), "bit differs from reference"],
          [rgb(DIFF_OFF), "bit identical"],
          ["#0e1116", "not computed"],
        ];
      } else {
        items = BANDS.map(function (b) {
          return [rgb(b.rgb), b.title + " bit = 1"];
        }).concat([
          [rgb(dim(BANDS[1].rgb, 0.88)), "bit = 0"],
          ["#0e1116", "not computed"],
        ]);
      }
      var html = items.map(function (it) {
        return '<span class="item"><span class="sw" style="background:' +
          it[0] + '"></span>' + it[1] + "</span>";
      }).join("");
      html += '<span class="item">hue = track, brightness = bit value; ' +
        'columns left of the dashed rule are the seed window</span>';
      elLegend.innerHTML = html;
    }

    /**
     * The chaining value entering and leaving the selected block.
     *
     * These eight words are the only thing one block passes to the next, and
     * they are already on the canvas without being labelled as such: H[0..3]
     * are the four seed columns of the A track and H[4..7] are the four seed
     * columns of E, which is why the strip is tinted with the same two hues
     * the bands use. Seeding runs in reverse — A[-1] = H[0] down to
     * A[-4] = H[3] — so each word says which column it became.
     */
    function renderChaining(state) {
      var block = state.analysis.blocks[state.blockIndex];
      var tr = block.trace;

      function words(arr, kind) {
        var out = "";
        for (var i = 0; i < 8; i++) {
          var track = i < 4 ? "A" : "E";
          var t = -1 - (i % 4);
          var title = kind === "in"
            ? "H[" + i + "] seeds " + track + "[" + t + "]"
            : "H[" + i + "] leaving this block";
          out += '<span class="cv-w ' + (i < 4 ? "a" : "e") +
            '" title="' + title + '">' + hex8(arr[i]) + "</span>";
        }
        return out;
      }

      var origin = state.blockIndex === 0
        ? "the FIPS initial value"
        : "block " + (state.blockIndex - 1) + "'s outgoing value";
      var fate = state.blockIndex === state.analysis.blocks.length - 1
        ? "the digest"
        : "block " + (state.blockIndex + 1) + "'s incoming value";

      elChaining.innerHTML =
        '<div class="cv-row"><span class="cv-label">H in</span>' +
        '<span class="cv-words">' + words(tr.hIn, "in") + "</span>" +
        '<span class="cv-note">' + origin + "</span></div>" +
        '<div class="cv-row"><span class="cv-label">H out</span>' +
        '<span class="cv-words">' + words(tr.hOut, "out") + "</span>" +
        '<span class="cv-note">' + fate + "</span></div>" +
        '<div class="cv-legend">H[0..3] seed the A track at t = −1…−4 · ' +
        "H[4..7] seed E · H out = H in ⊞ the final window</div>";
    }

    function renderDetail(state) {
      var t = state.selectedRound;
      var trace = state.analysis.blocks[state.blockIndex].trace;
      if (t === null || t === undefined) {
        elDetail.innerHTML = '<span class="hint">Click a column to break out ' +
          'that round. Hover any cell for its word and bit.</span>';
        return;
      }
      var d = M.roundDetail(trace, t);
      if (!d) {
        elDetail.innerHTML = '<span class="hint">Round ' + t +
          " is beyond the current round limit.</span>";
        return;
      }
      /* Same order as the expanded equations under the legend: the terms
       * carried in unchanged first, the computed ones last. */
      var items = [
        ["W[" + t + "]", d.W],
        ["K[" + t + "]", d.K],
        ["A[" + (t - 4) + "]", d.Ain[3]],
        ["E[" + (t - 4) + "]", d.Ein[3]],
        ["E[" + (t - 1) + "]", d.Ein[0]],
        ["Σ1(E[" + (t - 1) + "])", d.Sigma1],
        ["Ch(E" + (t - 1) + "," + (t - 2) + "," + (t - 3) + ")", d.Ch],
        ["A[" + (t - 1) + "]", d.Ain[0]],
        ["Σ0(A[" + (t - 1) + "])", d.Sigma0],
        ["Maj(A" + (t - 1) + "," + (t - 2) + "," + (t - 3) + ")", d.Maj],
      ];
      var out = [["T1", d.T1], ["T2", d.T2], ["A[" + t + "]", d.A], ["E[" + t + "]", d.E]];

      var html = '<div class="rd-head">round t = ' + t +
        "   ·   block " + state.blockIndex + "</div><div class=\"rd-grid\">";
      html += items.map(function (it) {
        return '<div class="rd-item"><span class="lbl">' + esc(it[0]) +
          '</span><span class="val">' + hex8(it[1]) + "</span></div>";
      }).join("");
      html += out.map(function (it) {
        return '<div class="rd-item out"><span class="lbl">' + esc(it[0]) +
          '</span><span class="val">' + hex8(it[1]) + "</span></div>";
      }).join("");
      html += "</div>";
      html += '<div class="rd-eq">T1 = W[t] ⊞ K[t] ⊞ E[t-4] ⊞ Σ1(E[t-1]) ⊞ ' +
        "Ch(E[t-1],E[t-2],E[t-3]) ··· " +
        "T2 = Σ0(A[t-1]) ⊞ Maj(A[t-1],A[t-2],A[t-3]) ··· " +
        "E[t] = A[t-4] ⊞ T1 ··· A[t] = T1 ⊞ T2</div>";
      elDetail.innerHTML = html;
    }

    function esc(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    // ---------------------------------------------------------------

    function render(state) {
      lastState = state;
      if (elRounds !== document.activeElement) {
        elRounds.value = String(state.rounds);
      }
      elDiff.checked = state.diffMode;
      elDiff.disabled = !state.reference;
      elAnimate.checked = state.animate;
      elPin.textContent = state.reference ? "Re-pin reference" : "Pin reference";
      renderTabs(state);
      renderLegend(state);
      renderChaining(state);
      renderDetail(state);
      updateGlow(state);
      resize();   // sizes the backing store if needed, and always redraws
    }

    return { render: render };
  }

  root.SHATOOL_UI_CANVAS = Object.freeze({ create: create });
})(typeof globalThis !== "undefined" ? globalThis : this);
