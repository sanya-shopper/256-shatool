/*
 * shatool/js/ui-output.js — the right-hand digest and proof-of-work panel.
 *
 * Shows the 32-byte digest twice over: as SHA-256 emits it, and as Bitcoin's
 * difficulty check reads it. Every byte is coloured by the part it plays in
 * that check, with the colour bands derived from the decoded nBits rather
 * than hardcoded, so changing the difficulty moves them.
 *
 * All of the arithmetic lives in SHATOOL_POW; this file only draws.
 */

(function (root) {
  "use strict";

  var P = root.SHATOOL_POW;
  var M = root.SHATOOL_MODEL;

  /* The three roles, in the order the panel explains them, with the CSS
   * custom property each maps to. Kept here so the legend text and the
   * colouring cannot drift apart. */
  var ROLE_TEXT = {
    "must-be-zero": "must be zero at this difficulty",
    "coefficient": "compared against the nBits coefficient",
    "tail": "below the target's precision",
  };

  function create(cb) {
    var elDigestHex = document.getElementById("digest-hex");
    var elDigestBytes = document.getElementById("digest-bytes");
    var elShowBits = document.getElementById("chk-digest-bits");
    var elSelect = document.getElementById("pow-nbits");
    var elCustomRow = document.getElementById("pow-nbits-custom-row");
    var elCustom = document.getElementById("pow-nbits-custom");
    var elVerdict = document.getElementById("pow-verdict");
    var elStats = document.getElementById("pow-stats");
    var elTarget = document.getElementById("pow-target");
    var elNote = document.getElementById("pow-note");

    elShowBits.addEventListener("change", function () {
      cb.onShowDigestBits(elShowBits.checked);
    });

    elSelect.addEventListener("change", function () {
      if (elSelect.value === "custom") {
        elCustomRow.hidden = false;
        applyCustom();
      } else {
        elCustomRow.hidden = true;
        cb.onSetNBits(parseInt(elSelect.value, 16));
      }
    });

    elCustom.addEventListener("input", applyCustom);

    function applyCustom() {
      var v = parseInt(String(elCustom.value).replace(/^0[xX]/, ""), 16);
      if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) cb.onSetNBits(v >>> 0);
    }

    // ---------------------------------------------------------------

    /**
     * The digest as a run of hex byte spans, each carrying its role class.
     *
     * @param {Uint8Array} bytes
     * @param {Array} roles from SHATOOL_POW.byteRoles
     * @param {boolean} reversed render in Bitcoin display order
     * @param {number} deciding digest index that settled the comparison, or -1
     */
    function hexSpans(bytes, roles, reversed, deciding) {
      var out = "";
      for (var k = 0; k < 32; k++) {
        var i = reversed ? 31 - k : k;
        var cls = "dh-byte " + roles[i].role;
        if (bytes[i] === 0) cls += " is-zero";
        if (i === deciding) cls += " deciding";
        out += '<span class="' + cls + '" title="' +
          "digest byte " + i + " · weight 256^" + i + " · " +
          ROLE_TEXT[roles[i].role] + '">' +
          bytes[i].toString(16).padStart(2, "0") + "</span>";
      }
      return out;
    }

    function renderDigest(state) {
      var a = state.pow;
      var d = state.analysis.digest;

      elDigestHex.innerHTML = hexSpans(d, a.roles, false, a.decidingIndex);

      /* One cell per byte, most significant first, because the panel is
       * explaining significance and reading order should follow it. */
      var html = "";
      for (var k = 0; k < 32; k++) {
        var i = 31 - k;
        var role = a.roles[i].role;
        var cls = "db-cell " + role + (d[i] === 0 ? " is-zero" : "");
        html += '<div class="' + cls + '" title="digest byte ' + i +
          " · weight 256^" + i + " · " + ROLE_TEXT[role] + '">';
        html += '<div class="db-top"><span class="db-idx">' + i +
          '</span><span class="db-val">' +
          d[i].toString(16).padStart(2, "0") + "</span></div>";
        if (state.showDigestBits) {
          html += '<div class="db-bits">';
          for (var p = 7; p >= 0; p--) {
            html += '<span class="db-bit' +
              (((d[i] >> p) & 1) ? " on" : "") + '"></span>';
          }
          html += "</div>";
        }
        html += "</div>";
      }
      elDigestBytes.innerHTML = html;
      elShowBits.checked = state.showDigestBits;
    }

    function renderPow(state) {
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
          ": digest 0x" + state.analysis.digest[a.decidingIndex].toString(16)
            .padStart(2, "0") +
          " exceeds target 0x" + a.target[a.decidingIndex].toString(16)
            .padStart(2, "0") + "</span>";
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

      elTarget.innerHTML = hexSpans(a.target, a.roles, false, -1);

      elNote.innerHTML =
        "<p><strong>Reading order.</strong> Bitcoin treats these 32 bytes as a " +
        "<em>little-endian</em> 256-bit integer, so byte 31 — the last one " +
        "SHA-256 emits — is the most significant, and byte 0 is the least. " +
        "The conventional block-hash string is this digest written backwards, " +
        "which is why its zeros appear at the front.</p>" +
        "<p>In Bitcoin display order that string is:</p>" +
        '<p class="digest-hex" style="letter-spacing:0.02em">' +
        hexSpans(state.analysis.digest, a.roles, true, a.decidingIndex) +
        "</p>" +
        "<p><strong>What this is not.</strong> Bitcoin hashes an 80-byte block " +
        "header with SHA-256 applied <em>twice</em>. shatool applies it once to " +
        "an arbitrary message, so the digest above is not a block hash and the " +
        "verdict is not a claim about mining. What is exactly true is the part " +
        "shown: given any 32 bytes, this is the weight each byte carries in the " +
        "difficulty comparison and this is how the comparison comes out.</p>";
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
     * for a figure that is only ever displayed to one decimal place.
     */
    function expectedWork(a) {
      var dec = a.decoded;
      if (dec.negative || dec.overflow || dec.coefficient === 0) return "—";
      /* log2(target) = log2(coefficient) + 8 * (exponent - 3) */
      var log2Target = Math.log2(dec.coefficient) + 8 * (dec.exponent - 3);
      var log2Tries = 256 - log2Target;
      if (log2Tries < 0) return "1 (target exceeds the range)";
      return "2^" + log2Tries.toFixed(1) + " hashes";
    }

    // ---------------------------------------------------------------

    function render(state) {
      /* Keep the selector in step with the state, including when the state
       * was set from somewhere other than this panel. */
      var asHex = "0x" + state.nBits.toString(16).padStart(8, "0");
      var matched = false;
      for (var i = 0; i < elSelect.options.length; i++) {
        if (elSelect.options[i].value.toLowerCase() === asHex) {
          elSelect.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (!matched) {
        elSelect.value = "custom";
        elCustomRow.hidden = false;
        if (elCustom !== document.activeElement) elCustom.value = asHex;
      } else {
        elCustomRow.hidden = true;
      }

      renderDigest(state);
      renderPow(state);
    }

    return { render: render };
  }

  root.SHATOOL_UI_OUTPUT = Object.freeze({ create: create });
})(typeof globalThis !== "undefined" ? globalThis : this);
