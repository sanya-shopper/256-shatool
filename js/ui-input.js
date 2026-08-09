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

      for (var i = 0; i < msg.nbits; i++) {
        var cell = bitCells[i];
        if (cell) cell.classList.toggle("on", M.getBit(msg, i) === 1);
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

      paintSummary(state);
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
