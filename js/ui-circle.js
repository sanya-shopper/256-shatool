/*
 * shatool/js/ui-circle.js — the digest as a point on the value circle.
 *
 * A floating, collapsible, draggable pane showing where the current digest
 * sits in the 256-bit value space, drawn as a circle: zero at the top, values
 * increasing clockwise, wrapping back to zero after 2^256 - 1.
 *
 * ------------------------------------------------------------------
 * Why a circle, and what "discrete" means here
 * ------------------------------------------------------------------
 *
 * The proof-of-work question is "is this value small", and small means "just
 * clockwise of the top". A circle makes that a position rather than a number,
 * and makes the thing a line cannot show: that the space wraps. One step past
 * the largest value is zero.
 *
 * The circle is discrete — it has exactly 2^256 positions and a digest can
 * only ever land on one of them. It is drawn as a continuous ring because at
 * any size that fits on a screen a single pixel spans about 2^248 of those
 * positions, so the discreteness is real but invisible. The pane says so
 * rather than letting the smooth ring imply otherwise.
 *
 * ------------------------------------------------------------------
 * The convention that makes wrapping visible
 * ------------------------------------------------------------------
 *
 * Between two digests there are two arcs, and nothing about hashing says
 * which one the value "took" — successive digests are unrelated. So one
 * convention is fixed and never varied: motion is always drawn CLOCKWISE, in
 * the direction of increasing value.
 *
 * That makes wrapping well defined rather than arbitrary. If the new value is
 * larger, the clockwise arc between them does not pass the top. If it is
 * smaller, the clockwise arc must pass through zero — the value wrapped — and
 * that arc is drawn in a different colour and counted. A decrease is exactly
 * a wrap, which is the fact the picture exists to show.
 */

(function (root) {
  "use strict";

  var P = root.SHATOOL_POW;

  /** How many past positions to keep as a fading trail. */
  var TRAIL = 28;

  /* The target arc is drawn far larger than it is. At the example mainnet
   * difficulty the target is about 2^-78 of the space, which is some twenty
   * orders of magnitude below one pixel — an honest drawing would be nothing
   * at all. It is given this minimum sweep so it can be seen, and the pane
   * labels it as exaggerated. Getting this wrong in the other direction —
   * drawing it to scale and letting a reader conclude the target is a
   * reachable-looking slice — would be the worse error. */
  var MIN_TARGET_SWEEP = 0.035;   // as a fraction of the circle

  /** Whether motion from `prev` to `cur` wraps through zero. */
  function isWrap(prev, cur) {
    return cur < prev;
  }

  /** Clockwise sweep from `prev` to `cur`, as a fraction of the circle. */
  function sweep(prev, cur) {
    return cur >= prev ? cur - prev : (1 - prev) + cur;
  }

  /** Canvas angle for a fraction of the circle: zero at the top, clockwise. */
  function angleOf(fraction) {
    return -Math.PI / 2 + fraction * 2 * Math.PI;
  }

  function create(cb) {
    var pane = document.getElementById("circle-pane");
    var header = document.getElementById("circle-header");
    var toggle = document.getElementById("circle-toggle");
    var body = document.getElementById("circle-body");
    var canvas = document.getElementById("circle-canvas");
    var stats = document.getElementById("circle-stats");
    var resetBtn = document.getElementById("circle-reset");

    var ctx = canvas.getContext("2d");

    /* View history, not application state — the same standing as the canvas
     * afterglow. It is produced by successive renders rather than by any
     * user decision, and nothing outside this pane can ask about it. */
    var trail = [];
    var prevFraction = null;
    var wraps = 0;
    var lastWasWrap = false;

    var lastState = null;

    // ---------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------

    toggle.addEventListener("click", function () { cb.onToggleCircle(); });
    resetBtn.addEventListener("click", function () {
      trail = [];
      wraps = 0;
      lastWasWrap = false;
      prevFraction = null;
      if (lastState) render(lastState);
    });

    /* Dragging by the header. A floating pane that cannot be moved will
     * eventually sit on top of the one thing the user wants to read. */
    var dragging = null;
    header.addEventListener("mousedown", function (ev) {
      if (ev.target === toggle || ev.target === resetBtn) return;
      var r = pane.getBoundingClientRect();
      dragging = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      ev.preventDefault();
    });
    root.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      /* Switch to top/left positioning on first drag; the pane is anchored
       * bottom-right by CSS until then. */
      pane.style.right = "auto";
      pane.style.bottom = "auto";
      pane.style.left = Math.max(0, ev.clientX - dragging.dx) + "px";
      pane.style.top = Math.max(0, ev.clientY - dragging.dy) + "px";
    });
    root.addEventListener("mouseup", function () { dragging = null; });

    // ---------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------

    function resize() {
      var dpr = root.devicePixelRatio || 1;
      var w = body.clientWidth || 240;
      var size = Math.max(120, Math.min(w, 260));
      var px = Math.round(size * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      canvas.style.width = size + "px";
      canvas.style.height = size + "px";
      return { size: size, dpr: dpr };
    }

    function draw(state) {
      var geo = resize();
      var size = geo.size;
      var cx = size / 2, cy = size / 2;
      var radius = size / 2 - 26;

      ctx.save();
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      drawTargetWedge(state, cx, cy, radius);
      drawRing(cx, cy, radius);
      drawTicks(cx, cy, radius);
      drawLabels(cx, cy, radius);
      drawTrail(cx, cy, radius);
      drawMotion(cx, cy, radius);
      drawPoint(cx, cy, radius);

      ctx.restore();
    }

    function drawRing(cx, cy, r) {
      ctx.strokeStyle = "#2a323d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 64 ticks, longer every 16, which is a quarter turn. They stand for the
     * discreteness without pretending to show 2^256 positions. */
    function drawTicks(cx, cy, r) {
      for (var i = 0; i < 64; i++) {
        var a = angleOf(i / 64);
        var major = i % 16 === 0;
        var len = major ? 7 : 3;
        ctx.strokeStyle = major ? "#4a5461" : "#232b35";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.lineTo(cx + Math.cos(a) * (r + len), cy + Math.sin(a) * (r + len));
        ctx.stroke();
      }
    }

    function drawLabels(cx, cy, r) {
      ctx.fillStyle = "#5a6472";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      var marks = [
        [0, "0", 0, -13],
        [0.25, "2²⁵⁴", 20, 0],
        [0.5, "2²⁵⁵", 0, 13],
        [0.75, "3·2²⁵⁴", -22, 0],
      ];
      for (var i = 0; i < marks.length; i++) {
        var a = angleOf(marks[i][0]);
        ctx.fillText(marks[i][1],
          cx + Math.cos(a) * r + marks[i][2],
          cy + Math.sin(a) * r + marks[i][3]);
      }
      /* Direction of increasing value, so the clockwise convention is on the
       * picture rather than only in the prose. */
      ctx.fillStyle = "#4a5461";
      ctx.fillText("value ↻", cx, cy + 10);
    }

    /* The accepting region: values at or below the target, which is the arc
     * immediately clockwise of zero. Drawn at a visible minimum size and
     * labelled as exaggerated. */
    function drawTargetWedge(state, cx, cy, r) {
      var frac = P.unitFraction(state.pow.target);
      var shown = Math.max(frac, MIN_TARGET_SWEEP);
      ctx.fillStyle = "rgba(95, 194, 126, 0.16)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angleOf(0), angleOf(shown));
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(95, 194, 126, 0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, angleOf(0), angleOf(shown));
      ctx.stroke();
    }

    function drawTrail(cx, cy, r) {
      for (var i = 0; i < trail.length; i++) {
        var age = (i + 1) / trail.length;       // 1 = newest
        var a = angleOf(trail[i]);
        ctx.fillStyle = "rgba(70, 198, 216," + (0.08 + age * 0.35).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* The clockwise arc from the previous position to the current one. Amber
     * normally; red, thicker, and starting from a marked zero when it had to
     * pass through the top — which is exactly when the value wrapped. */
    function drawMotion(cx, cy, r) {
      if (prevFraction === null || trail.length < 2) return;
      var from = trail[trail.length - 2];
      var to = trail[trail.length - 1];
      ctx.strokeStyle = lastWasWrap
        ? "rgba(224, 92, 92, 0.85)"
        : "rgba(232, 163, 61, 0.55)";
      ctx.lineWidth = lastWasWrap ? 2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 5, angleOf(from), angleOf(to),
        false);   // false = clockwise in canvas coordinates
      ctx.stroke();
    }

    function drawPoint(cx, cy, r) {
      if (!trail.length) return;
      var a = angleOf(trail[trail.length - 1]);
      var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;

      ctx.strokeStyle = "rgba(70, 198, 216, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = "#46c6d8";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0a0d12";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ---------------------------------------------------------------

    function render(state) {
      lastState = state;
      pane.classList.toggle("collapsed", !state.circleOpen);
      toggle.textContent = state.circleOpen ? "▾" : "▸";
      body.hidden = !state.circleOpen;
      if (!state.circleOpen) return;

      var f = P.unitFraction(state.analysis.digest);

      /* Only record a move when the value actually changed; re-rendering for
       * an unrelated reason must not manufacture a step or a wrap. */
      if (prevFraction === null || f !== prevFraction) {
        if (prevFraction !== null) {
          lastWasWrap = isWrap(prevFraction, f);
          if (lastWasWrap) wraps++;
        }
        trail.push(f);
        if (trail.length > TRAIL) trail.shift();
        prevFraction = f;
      }

      draw(state);

      var last = trail.length > 1
        ? sweep(trail[trail.length - 2], trail[trail.length - 1])
        : null;
      var html = '<div class="row"><span>position</span><span class="n">' +
        (f * 100).toFixed(6) + "% round</span></div>";
      html += '<div class="row"><span>wraps through 0</span><span class="n' +
        (lastWasWrap ? " warn" : "") + '">' + wraps + "</span></div>";
      if (last !== null) {
        html += '<div class="row"><span>last step</span><span class="n">' +
          (last * 100).toFixed(2) + "% clockwise" +
          (lastWasWrap ? " — wrapped" : "") + "</span></div>";
      }
      html += '<div class="row"><span class="hint-inline">Motion is always ' +
        "drawn clockwise, so a decrease must cross zero and shows as a wrap. " +
        "The green arc is the accepting region, drawn far larger than it is — " +
        "at this difficulty it is around 2^-78 of the circle, which is many " +
        "orders of magnitude below one pixel. The circle is discrete: 2^256 " +
        "positions, about 2^248 of them per pixel.</span></div>";
      stats.innerHTML = html;
    }

    return { render: render };
  }

  root.SHATOOL_UI_CIRCLE = Object.freeze({
    create: create,
    isWrap: isWrap,
    sweep: sweep,
    angleOf: angleOf,
    TRAIL: TRAIL,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
