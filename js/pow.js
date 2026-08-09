/*
 * shatool/js/pow.js — how Bitcoin reads a 32-byte digest.
 *
 * No DOM access. Loaded as a classic script; defines the global SHATOOL_POW.
 *
 * ---------------------------------------------------------------------
 * The one fact this file exists to make visible
 * ---------------------------------------------------------------------
 *
 * SHA-256 emits 32 bytes. Bitcoin's proof-of-work check interprets those
 * bytes as a **little-endian** 256-bit unsigned integer and asks whether it
 * is less than or equal to a target:
 *
 *     value = SUM over i of digest[i] * 256^i        (i = 0 .. 31)
 *     accept iff value <= target
 *
 * So the byte that dominates the comparison is `digest[31]` — the LAST byte
 * SHA-256 produces — and `digest[0]` is the least significant of all. This is
 * the reverse of the order in which the digest is written down, and it is the
 * single most common source of confusion about Bitcoin hashes.
 *
 * It is also why block hashes appear to begin with a run of zeros. The
 * conventional display reverses the bytes:
 *
 *     displayed = digest[31], digest[30], ... , digest[0]
 *
 * which puts the most significant byte first, as decimal numbers are written.
 * The "leading zeros" of a block hash are therefore the *trailing* zero bytes
 * of the raw digest. Nothing about SHA-256 favours zeros at either end; the
 * miner is simply searching for a value below a threshold, and a small
 * 256-bit number written most-significant-first starts with zeros.
 *
 * ---------------------------------------------------------------------
 * Scope, stated plainly
 * ---------------------------------------------------------------------
 *
 * Bitcoin does not apply SHA-256 once. It applies it twice —
 * SHA-256(SHA-256(header)) — to an 80-byte block header. This tool hashes an
 * arbitrary message once, so the digest on screen is not a block hash and the
 * verdicts below are not claims that any block was or was not mined.
 *
 * What *is* exactly true, and is what this module reports: given any 32 bytes
 * presented to Bitcoin's difficulty check, this is the significance each byte
 * carries and this is how the comparison would come out. That statement holds
 * regardless of where the bytes came from. The UI says so too, rather than
 * leaving the reader to assume they are looking at a mining simulator.
 */

(function (root) {
  "use strict";

  // -------------------------------------------------------------------
  // 1. The compact target encoding ("nBits")
  // -------------------------------------------------------------------
  //
  // A Bitcoin block header stores its target in four bytes, as a
  // floating-point-like value: one exponent byte and a three-byte coefficient.
  //
  //     nBits = 0xEECCCCCC     exponent EE, coefficient CCCCCC
  //     target = coefficient * 256^(exponent - 3)
  //
  // Expanding that sum shows where each coefficient byte lands in the
  // 256-bit value, which is what the visualization needs:
  //
  //     target = c2 * 256^(exponent-1)      c2 = (coefficient >> 16) & 0xff
  //            + c1 * 256^(exponent-2)      c1 = (coefficient >>  8) & 0xff
  //            + c0 * 256^(exponent-3)      c0 =  coefficient        & 0xff
  //
  // Since digest byte i carries weight 256^i, the coefficient's top byte c2
  // is compared against digest[exponent-1]. Every byte above that — indices
  // exponent .. 31 — must be zero for the digest to be under target, because
  // the target has no bits at those weights at all.

  /**
   * An example mainnet difficulty. NOT a live value — it is a plausible
   * mid-2024-era nBits kept as a fixed default so the tool is deterministic
   * and never implies it is reading the network. The UI labels it as an
   * example and lets it be edited.
   */
  var EXAMPLE_NBITS = 0x17034a3f;

  /** The genesis block's nBits, useful as a much easier contrast. */
  var GENESIS_NBITS = 0x1d00ffff;

  /**
   * Decode a compact nBits value.
   *
   * @param {number} nBits a 32-bit unsigned integer
   * @returns {{nBits: number, exponent: number, coefficient: number,
   *            coeffBytes: number[], msbIndex: number, zeroFrom: number,
   *            negative: boolean, overflow: boolean}}
   *
   * `msbIndex` is the digest byte index the coefficient's top byte is weighed
   * against, and `zeroFrom` is the lowest digest index that must be zero; all
   * indices from `zeroFrom` through 31 must be zero.
   */
  function decodeNBits(nBits) {
    var n = nBits >>> 0;
    var exponent = (n >>> 24) & 0xff;
    var coefficient = n & 0x007fffff;

    /* Bitcoin treats bit 23 of the coefficient as a sign bit. A negative or
     * overflowing target is invalid in a real header; it is reported rather
     * than thrown so the UI can say so instead of going blank. */
    var negative = (n & 0x00800000) !== 0;
    var overflow = coefficient !== 0 &&
      ((exponent > 34) || (coefficient > 0xff && exponent > 33) ||
       (coefficient > 0xffff && exponent > 32));

    return {
      nBits: n,
      exponent: exponent,
      coefficient: coefficient,
      coeffBytes: [
        (coefficient >>> 16) & 0xff,
        (coefficient >>> 8) & 0xff,
        coefficient & 0xff,
      ],
      msbIndex: exponent - 1,
      zeroFrom: exponent,
      negative: negative,
      overflow: overflow,
    };
  }

  /**
   * The target as 32 bytes in the same little-endian layout as a digest, so
   * that target[i] and digest[i] can be compared byte for byte.
   *
   * @returns {Uint8Array} 32 bytes, index i carrying weight 256^i
   */
  function targetBytes(nBits) {
    var d = decodeNBits(nBits);
    var out = new Uint8Array(32);
    if (d.negative || d.overflow || d.coefficient === 0) return out;
    for (var j = 0; j < 3; j++) {
      /* coeffBytes[0] is the most significant, at weight 256^(exponent-1). */
      var idx = d.exponent - 1 - j;
      if (idx >= 0 && idx < 32) out[idx] = d.coeffBytes[j];
    }
    return out;
  }

  // -------------------------------------------------------------------
  // 2. Comparison
  // -------------------------------------------------------------------

  /**
   * Compare a digest against a target, both in little-endian byte layout.
   *
   * Walks from the most significant byte (index 31) downward and stops at the
   * first difference — which is exactly the byte a reader should be looking
   * at, so it is returned rather than discarded.
   *
   * @returns {{meetsTarget: boolean, cmp: number, decidingIndex: number}}
   *   `cmp` is -1, 0 or 1 for digest <, =, > target. `decidingIndex` is the
   *   digest byte index that settled it, or -1 if the two are equal.
   */
  function compareToTarget(digest, target) {
    for (var i = 31; i >= 0; i--) {
      if (digest[i] !== target[i]) {
        return {
          meetsTarget: digest[i] < target[i],
          cmp: digest[i] < target[i] ? -1 : 1,
          decidingIndex: i,
        };
      }
    }
    return { meetsTarget: true, cmp: 0, decidingIndex: -1 };
  }

  /**
   * How many leading zero bits the digest has *as Bitcoin reads it* — that
   * is, scanning from byte 31 downward, most significant bit first.
   *
   * This is the number quoted informally as "the hash has N leading zeros",
   * and it counts from the end of the raw digest, not the start.
   */
  function leadingZeroBits(digest) {
    var n = 0;
    for (var i = 31; i >= 0; i--) {
      var b = digest[i];
      if (b === 0) { n += 8; continue; }
      for (var k = 7; k >= 0; k--) {
        if ((b >> k) & 1) return n;
        n++;
      }
      return n;
    }
    return 256;
  }

  /** The digest in conventional Bitcoin display order: byte 31 first. */
  function displayHex(digest) {
    var s = "";
    for (var i = 31; i >= 0; i--) s += digest[i].toString(16).padStart(2, "0");
    return s;
  }

  // -------------------------------------------------------------------
  // 3. Per-byte roles, for colouring
  // -------------------------------------------------------------------

  /**
   * Classify every digest byte by the part it plays in the difficulty check.
   *
   * Three roles, and the boundaries between them come from the decoded nBits
   * rather than being hardcoded, so changing the difficulty moves the bands:
   *
   *   "must-be-zero"  index >= exponent. The target has no value at this
   *                   weight, so any nonzero byte here fails immediately.
   *                   These are the bytes whose zeroness *is* the difficulty.
   *   "coefficient"   index in [exponent-3, exponent-1]. Compared against the
   *                   three coefficient bytes; this is where a candidate that
   *                   has cleared the zeros is actually won or lost.
   *   "tail"          index < exponent-3. Below the target's precision
   *                   entirely — these bytes only ever matter to break an
   *                   exact tie in the bytes above, which does not happen in
   *                   practice.
   *
   * @returns {Array<{index: number, role: string, significance: number,
   *                  displayPos: number}>} indexed by digest byte index
   *   `significance` is the byte's power of 256 (equal to its index), and
   *   `displayPos` is where it appears in the reversed display string.
   */
  function byteRoles(nBits) {
    var d = decodeNBits(nBits);
    var roles = [];
    for (var i = 0; i < 32; i++) {
      var role;
      if (i >= d.zeroFrom) role = "must-be-zero";
      else if (i >= d.exponent - 3) role = "coefficient";
      else role = "tail";
      roles.push({
        index: i,
        role: role,
        significance: i,
        displayPos: 31 - i,
      });
    }
    return roles;
  }

  /**
   * The full analysis of one digest under one difficulty.
   *
   * @param {Uint8Array} digest 32 bytes as SHA-256 emits them
   * @param {number} nBits compact target
   */
  function analyze(digest, nBits) {
    var decoded = decodeNBits(nBits);
    var target = targetBytes(nBits);
    var cmp = compareToTarget(digest, target);
    return {
      nBits: nBits,
      decoded: decoded,
      target: target,
      targetDisplayHex: displayHex(target),
      digestDisplayHex: displayHex(digest),
      roles: byteRoles(nBits),
      leadingZeroBits: leadingZeroBits(digest),
      meetsTarget: cmp.meetsTarget,
      decidingIndex: cmp.decidingIndex,
      /* How many of the required-zero bytes actually are zero. A digest that
       * is nowhere near the target still gets a couple of these by luck, and
       * showing the count makes the scale of the search concrete: mainnet
       * asks for nine or ten in a row, at 1/256 each. */
      zeroBytesRequired: 32 - decoded.zeroFrom,
      zeroBytesAchieved: countLeadingZeroBytes(digest),
    };
  }

  /** Zero bytes at the top of the little-endian value, i.e. from index 31 down. */
  function countLeadingZeroBytes(digest) {
    var n = 0;
    for (var i = 31; i >= 0 && digest[i] === 0; i--) n++;
    return n;
  }

  root.SHATOOL_POW = Object.freeze({
    EXAMPLE_NBITS: EXAMPLE_NBITS,
    GENESIS_NBITS: GENESIS_NBITS,
    decodeNBits: decodeNBits,
    targetBytes: targetBytes,
    compareToTarget: compareToTarget,
    leadingZeroBits: leadingZeroBits,
    countLeadingZeroBytes: countLeadingZeroBytes,
    displayHex: displayHex,
    byteRoles: byteRoles,
    analyze: analyze,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
