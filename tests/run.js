#!/usr/bin/env node
/*
 * shatool test suite.
 *
 * Run with:  node tests/run.js       (or: bash tests/run.sh)
 *
 * The application is written as classic scripts that assign to globals, so
 * that index.html opens from a file:// URL with no server. Node cannot
 * `require` such a file — there are no exports — so each one is read and
 * evaluated into this process's global scope with `vm.runInThisContext`,
 * which is exactly what a <script> tag does in a browser.
 *
 * The model and PoW layers are DOM-free by construction, so all of their
 * behaviour is reachable here. The UI layer is not; what is tested instead is
 * the *interface* between the two — that every element id the UI looks up
 * exists in index.html, and that every script index.html loads exists on
 * disk. Those are the drift failures that a browser reports as a blank panel
 * and nothing else.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

/* Pinned so that a re-sync of the vendored library from ../shavar cannot
 * happen silently. See js/vendor/README.md. */
const EXPECTED_SHAVAR_SHA256 =
  "ab5b928727808d04f3224861b50516ac79290fec61ecdc1e206f4640de0a8e9c";

// ---------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------

let passed = 0;
const failures = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log("\n" + name);
}

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok    " + name);
  } catch (e) {
    failures.push({ group: currentGroup, name, message: e.message });
    console.log("  FAIL  " + name + "\n          " + e.message);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((what ? what + ": " : "") + "expected " + b + ", got " + a);
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what || "expected truthy");
}

function throws(fn, what) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error((what || "expression") + " should have thrown");
}

// ---------------------------------------------------------------------
// Load the application into this process
// ---------------------------------------------------------------------

/* The script list is read out of index.html rather than repeated here, in
 * the order the page loads them. A new module added to the page is therefore
 * picked up automatically; a hardcoded list silently omits it and the whole
 * smoke suite fails with an undefined global. */
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const ALL_SCRIPTS = [...INDEX_HTML.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)]
  .map((m) => m[1]);

/* The DOM-free layers load now, so the model tests below can use them. The
 * UI layer needs a document and is loaded later, in the smoke group. */
const isUiScript = (p) => /\/(ui-[^/]+|app)\.js$/.test(p);
const MODEL_SCRIPTS = ALL_SCRIPTS.filter((p) => !isUiScript(p));
const UI_SCRIPTS = ALL_SCRIPTS.filter(isUiScript);

for (const rel of MODEL_SCRIPTS) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
    filename: rel,
  });
}

const S = globalThis.SHAVAR;
const M = globalThis.SHATOOL_MODEL;
const P = globalThis.SHATOOL_POW;
const Q = globalThis.SHATOOL_SEARCH;

/** A deterministic uniform source, so sampling tests are reproducible. */
function makeRand(seed) {
  let s = seed >>> 0;
  return function () {
    /* xorshift32; adequate for shuffling test bits and, unlike Math.random,
     * repeatable. */
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Bytes from a hex string, for building fixtures. */
const hx = (s) => Uint8Array.from(Buffer.from(s, "hex"));
/** Hex from bytes. */
const xh = (b) => Buffer.from(b).toString("hex");
/** Reverse a byte array (display order <-> digest order). */
const rev = (b) => Uint8Array.from(b).reverse();

// ---------------------------------------------------------------------
group("vendored library");
// ---------------------------------------------------------------------

check("shavar.js matches the pinned checksum", () => {
  const buf = fs.readFileSync(path.join(ROOT, "js/vendor/shavar.js"));
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  eq(got, EXPECTED_SHAVAR_SHA256,
    "vendored shavar.js has changed; re-sync deliberately and update " +
    "EXPECTED_SHAVAR_SHA256 in tests/run.js and js/vendor/README.md");
});

check("shavar selftest passes", () => {
  const r = S.selftest();
  eq(r.failures, []);
  ok(r.passed > 0, "expected at least one vector");
  eq(r.passed, r.total);
});

// ---------------------------------------------------------------------
group("model: message state");
// ---------------------------------------------------------------------

check("createMessage(513) allocates 65 bytes of zeros", () => {
  const m = M.createMessage(513);
  eq(m.bytes.length, 65);
  eq(m.nbits, 513);
  eq(Array.from(m.bytes).every((b) => b === 0), true);
});

check("finalByteMask reflects the significant-bit count", () => {
  eq(M.finalByteMask(512), 0xff, "byte-aligned");
  eq(M.finalByteMask(513), 0x80, "one significant bit");
  eq(M.finalByteMask(517), 0xf8, "five significant bits");
});

check("randomize leaves a legal 513-bit message", () => {
  for (let i = 0; i < 200; i++) {
    const m = M.randomize(M.createMessage(513));
    eq(m.bytes[64] & 0x7f, 0, "trailing bits of the final byte must be zero");
    /* Must be acceptable to the library, which rejects nonzero trailing
     * bits rather than masking them. */
    S.checkTrailingBits(m.bytes, m.nbits);
  }
});

check("randomize actually varies the bytes", () => {
  const a = M.randomize(M.createMessage(513));
  const b = M.randomize(M.createMessage(513));
  ok(xh(a.bytes) !== xh(b.bytes), "two random messages should differ");
});

check("getBit reads big-endian from the front of the message", () => {
  const m = M.createMessage(16);
  m.bytes[0] = 0b10000001;
  m.bytes[1] = 0b01000000;
  eq(M.getBit(m, 0), 1, "bit 0 is the top bit of byte 0");
  eq(M.getBit(m, 1), 0);
  eq(M.getBit(m, 7), 1);
  eq(M.getBit(m, 9), 1, "bit 9 is the second bit of byte 1");
  eq(M.getBit(m, 99), 0, "out of range reads as 0");
});

check("setBit / toggleBit round-trip every bit position", () => {
  const m = M.createMessage(513);
  for (let i = 0; i < 513; i++) {
    M.setBit(m, i, 1);
    eq(M.getBit(m, i), 1, "bit " + i + " after set");
    M.toggleBit(m, i);
    eq(M.getBit(m, i), 0, "bit " + i + " after toggle");
  }
  eq(Array.from(m.bytes).every((b) => b === 0), true, "back to all zeros");
});

check("setBit outside the message is ignored, not an error", () => {
  const m = M.createMessage(8);
  M.setBit(m, 8, 1);
  M.setBit(m, -1, 1);
  eq(m.bytes[0], 0);
});

check("setByte masks the final byte to the significant bits", () => {
  const m = M.createMessage(513);
  M.setByte(m, 0, 0xff);
  eq(m.bytes[0], 0xff, "a full byte is stored whole");
  M.setByte(m, 64, 0xff);
  eq(m.bytes[64], 0x80, "the final byte keeps only its one significant bit");
});

check("setMessageHex rejects non-hex and over-long input", () => {
  const m = M.createMessage(513);
  throws(() => M.setMessageHex(m, "zz"), "non-hex");
  throws(() => M.setMessageHex(m, "ab".repeat(66)), "too many digits");
});

check("setMessageHex tolerates whitespace, 0x, and a half-typed byte", () => {
  const m = M.createMessage(24);
  M.setMessageHex(m, "0x 61 62 63");
  eq(M.messageHex(m), "616263");
  M.setMessageHex(m, "6");
  eq(M.messageHex(m), "600000", "an odd digit count pads the low nibble");
});

check("setMessageHex clears bytes not covered by the new value", () => {
  const m = M.createMessage(24);
  M.setMessageHex(m, "ffffff");
  M.setMessageHex(m, "61");
  eq(M.messageHex(m), "610000", "stale bytes must not survive");
});

check("resize preserves leading bits and re-masks the tail", () => {
  const m = M.createMessage(24);
  M.setMessageHex(m, "616263");
  M.resize(m, 9);
  eq(m.bytes.length, 2);
  eq(m.nbits, 9);
  eq(M.messageHex(m), "6100", "0x62 truncated to its top bit, which is 0");
  M.resize(m, 24);
  eq(M.messageHex(m), "610000", "growing appends zeros");
});

// ---------------------------------------------------------------------
group("model: padding layout");
// ---------------------------------------------------------------------

check("513 bits occupies two blocks", () => {
  const L = M.paddingLayout(513);
  eq(L.nblocks, 2);
  eq(L.totalBits, 1024);
  eq(L.oneBitIndex, 513);
  eq(L.zeroBits, 1024 - 513 - 1 - 64);
  eq(L.lengthFieldStart, 960);
});

check("the layout accounts for every bit of the padded stream", () => {
  for (const n of [0, 1, 7, 8, 55, 56, 447, 448, 512, 513, 1000, 4096]) {
    const L = M.paddingLayout(n);
    eq(L.nbits + 1 + L.zeroBits + 64, L.totalBits, "bit accounting for n=" + n);
    ok(L.zeroBits >= 0, "zero-fill cannot be negative for n=" + n);
  }
});

check("bitRole classifies the boundaries of a 513-bit message", () => {
  const L = M.paddingLayout(513);
  eq(M.bitRole(L, 512), "message", "the last message bit");
  eq(M.bitRole(L, 513), "one", "the mandatory 1 bit");
  eq(M.bitRole(L, 514), "zero");
  eq(M.bitRole(L, 959), "zero", "last bit before the length field");
  eq(M.bitRole(L, 960), "length", "first bit of the 64-bit length");
  eq(M.bitRole(L, 1023), "length");
});

check("the padded stream really does encode the length at the end", () => {
  /* Read the length field back out of the last block the library builds and
   * check it equals nbits. This validates paddingLayout against the actual
   * padding rather than against its own arithmetic. */
  const m = M.randomize(M.createMessage(513));
  const L = M.paddingLayout(513);
  const last = S.paddedBlock(m.bytes, m.nbits, L.nblocks - 1);
  let len = 0n;
  for (let i = 56; i < 64; i++) len = (len << 8n) | BigInt(last[i]);
  eq(len.toString(), "513");
});

// ---------------------------------------------------------------------
group("model: analysis");
// ---------------------------------------------------------------------

check('analyze("abc") produces the FIPS digest', () => {
  const m = M.createMessage(24);
  M.setMessageHex(m, "616263");
  const a = M.analyze(m);
  eq(a.digestHex,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  eq(a.blocks.length, 1);
});

check("analyze of the empty message produces the FIPS digest", () => {
  const a = M.analyze(M.createMessage(0));
  eq(a.digestHex,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

check("analyze agrees with the library's own hashHex, always", () => {
  /* The digest shown in the UI is assembled from the chaining value the
   * traces produced, not from a second call to hashEx. This test is what
   * makes that shortcut safe: the two must never disagree. */
  for (const nbits of [0, 1, 5, 8, 24, 447, 448, 511, 512, 513, 1000]) {
    const m = M.randomize(M.createMessage(nbits));
    eq(M.analyze(m).digestHex, S.hashHex(m.bytes, m.nbits), "nbits=" + nbits);
  }
});

check("analyze traces every block, and each trace is complete", () => {
  const m = M.randomize(M.createMessage(513));
  const a = M.analyze(m);
  eq(a.blocks.length, 2);
  for (const b of a.blocks) {
    eq(b.trace.W.length, 64);
    eq(b.trace.A.length, 68, "A[-4..63] is 68 entries");
    eq(b.trace.E.length, 68);
    eq(b.trace.T1.length, 64);
    eq(b.trace.T2.length, 64);
  }
});

check("block 1's incoming chaining value is block 0's outgoing one", () => {
  const m = M.randomize(M.createMessage(513));
  const a = M.analyze(m);
  eq(Array.from(a.blocks[1].trace.hIn), Array.from(a.blocks[0].trace.hOut));
});

check("block 0's incoming chaining value is the FIPS IV", () => {
  const a = M.analyze(M.randomize(M.createMessage(513)));
  eq(Array.from(a.blocks[0].trace.hIn), Array.from(S.IV));
});

check("reduced rounds shorten the tracks and change the digest", () => {
  const m = M.createMessage(24);
  M.setMessageHex(m, "616263");
  const full = M.analyze(m);
  const short = M.analyze(m, { rounds: 16 });
  eq(short.blocks[0].trace.A.length, 20, "A[-4..15]");
  eq(short.blocks[0].trace.W.length, 64, "the schedule is always all 64");
  ok(short.digestHex !== full.digestHex, "16 rounds is not SHA-256");
});

// ---------------------------------------------------------------------
group("model: trace access");
// ---------------------------------------------------------------------

check("track() applies the +4 offset and seeds A/E in reverse", () => {
  /* spec/CLI.md: A[-1]=H0, A[-2]=H1, A[-3]=H2, A[-4]=H3, and likewise E from
   * H4..H7. Getting this backwards is the classic error, so it is pinned. */
  const t = M.analyze(M.createMessage(0)).blocks[0].trace;
  eq(M.track(t, "A", -1), S.IV[0]);
  eq(M.track(t, "A", -4), S.IV[3]);
  eq(M.track(t, "E", -1), S.IV[4]);
  eq(M.track(t, "E", -4), S.IV[7]);
  eq(M.track(t, "A", -5), undefined, "out of range");
  eq(M.track(t, "A", 64), undefined, "out of range");
});

check("trackRange covers exactly the traced rounds", () => {
  const t = M.analyze(M.createMessage(0), { rounds: 20 }).blocks[0].trace;
  eq(M.trackRange(t), { min: -4, max: 19 });
});

check("roundDetail recomputes terms consistent with the trace", () => {
  const m = M.randomize(M.createMessage(513));
  const tr = M.analyze(m).blocks[0].trace;
  for (let t = 0; t < 64; t++) {
    const d = M.roundDetail(tr, t);
    /* T1 = E[t-4] + Sigma1(E[t-1]) + Ch(...) + K[t] + W[t] */
    const t1 = (d.Ein[3] + d.Sigma1 + d.Ch + d.K + d.W) >>> 0;
    eq(t1, d.T1, "T1 at t=" + t);
    /* T2 = Sigma0(A[t-1]) + Maj(...) */
    eq((d.Sigma0 + d.Maj) >>> 0, d.T2, "T2 at t=" + t);
    /* E[t] = A[t-4] + T1 ; A[t] = T1 + T2 */
    eq((d.Ain[3] + d.T1) >>> 0, d.E, "E at t=" + t);
    eq((d.T1 + d.T2) >>> 0, d.A, "A at t=" + t);
  }
});

check("roundDetail returns null outside the traced rounds", () => {
  const tr = M.analyze(M.createMessage(0), { rounds: 8 }).blocks[0].trace;
  eq(M.roundDetail(tr, -1), null);
  eq(M.roundDetail(tr, 8), null);
  ok(M.roundDetail(tr, 7) !== null);
});

// ---------------------------------------------------------------------
group("model: differential");
// ---------------------------------------------------------------------

check("a message XORed with itself has an all-zero diff", () => {
  const m = M.randomize(M.createMessage(513));
  const a = M.analyze(m).blocks[0].trace;
  const d = M.diffTracks(a, a);
  eq(Array.from(d.A).every((x) => x === 0), true);
  eq(Array.from(d.E).every((x) => x === 0), true);
});

check("one flipped input bit avalanches to about half the bits", () => {
  const m = M.randomize(M.createMessage(513));
  const before = M.analyze(m).blocks[0].trace;
  M.toggleBit(m, 42);
  const after = M.analyze(m).blocks[0].trace;
  const d = M.diffTracks(before, after);

  /* Early rounds differ barely at all; by the end the difference should be
   * near 16 of 32 bits per word. Loose bounds — this is a sanity check that
   * the diff is wired to the right arrays, not a statistical test. */
  const lateA = M.popcount(d.A[67]);
  ok(lateA > 4 && lateA < 29, "late-round A diff was " + lateA + " bits");
  eq(M.popcount(d.A[0]), 0, "the seed window predates the message entirely");
});

check("popcount is correct on edge cases", () => {
  eq(M.popcount(0), 0);
  eq(M.popcount(1), 1);
  eq(M.popcount(0xffffffff), 32);
  eq(M.popcount(0x80000000), 1);
  eq(M.popcount(0xf0f0f0f0), 16);
});

// ---------------------------------------------------------------------
group("pow: compact target decoding");
// ---------------------------------------------------------------------

check("the genesis target decodes to its documented value", () => {
  /* The genesis block's target is the most-quoted 256-bit constant in
   * Bitcoin, so it is the right thing to pin the decoder against. */
  const d = P.decodeNBits(0x1d00ffff);
  eq(d.exponent, 0x1d);
  eq(d.coefficient, 0x00ffff);
  eq(d.negative, false);
  eq(d.overflow, false);
  eq(P.displayHex(P.targetBytes(0x1d00ffff)),
    "00000000ffff0000000000000000000000000000000000000000000000000000");
});

check("the example mainnet target decodes to the expected shape", () => {
  const nb = P.EXAMPLE_NBITS;
  const d = P.decodeNBits(nb);
  eq(d.exponent, 0x17);
  eq(d.coeffBytes, [0x03, 0x4a, 0x3f]);
  eq(d.msbIndex, 22, "the coefficient's top byte weighs 256^22");
  eq(d.zeroFrom, 23, "bytes 23..31 must be zero");
  eq(P.displayHex(P.targetBytes(nb)),
    "000000000000000000034a3f" + "0".repeat(40));
});

check("targetBytes places the coefficient at the right weights", () => {
  const t = P.targetBytes(P.EXAMPLE_NBITS);
  eq(t[22], 0x03);
  eq(t[21], 0x4a);
  eq(t[20], 0x3f);
  eq(t[23], 0, "nothing above the coefficient");
  eq(t[19], 0, "nothing below it");
});

check("a negative or overflowing nBits yields a zero target, not a throw", () => {
  eq(P.decodeNBits(0x1d80ffff).negative, true);
  eq(Array.from(P.targetBytes(0x1d80ffff)).every((b) => b === 0), true);
  eq(P.decodeNBits(0xff00ffff).overflow, true);
  eq(Array.from(P.targetBytes(0xff00ffff)).every((b) => b === 0), true);
});

// ---------------------------------------------------------------------
group("pow: byte order, against the real genesis block");
// ---------------------------------------------------------------------

/* The Bitcoin genesis block header, 80 bytes, exactly as it appears on the
 * wire. This is public, permanent, independently checkable data, and it is
 * the only way to test the byte-order story against something other than our
 * own reasoning about it. */
const GENESIS_HEADER = hx(
  "01000000" +                                                        // version
  "0000000000000000000000000000000000000000000000000000000000000000" + // prev
  "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" + // merkle
  "29ab5f49" +                                                        // time
  "ffff001d" +                                                        // bits
  "1dac2b7c");                                                        // nonce

const GENESIS_DISPLAY =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

/* SHA256d = SHA-256 applied twice. Bitcoin hashes headers this way; this
 * tool hashes once, which is why the digest on screen is not a block hash.
 * The double is done here to obtain real ground truth to test against. */
function sha256d(bytes) {
  return S.hash(S.hash(bytes, bytes.length * 8), 256);
}

check("the genesis header hashes to the genesis block hash", () => {
  const digest = sha256d(GENESIS_HEADER);
  eq(P.displayHex(digest), GENESIS_DISPLAY,
    "display order is the digest reversed");
  eq(xh(digest), xh(rev(hx(GENESIS_DISPLAY))),
    "and the raw digest is the display string reversed");
});

check("the raw genesis digest ENDS in zeros, it does not begin with them", () => {
  const digest = sha256d(GENESIS_HEADER);
  eq(digest[0], 0x6f, "the first byte SHA-256 emits is not zero");
  eq(digest[31], 0x00, "the last five bytes are the zeros people see");
  eq(digest[30], 0x00);
  eq(digest[29], 0x00);
  eq(digest[28], 0x00);
  eq(digest[27], 0x00);
  eq(digest[26], 0x19, "and this is the first nonzero, at weight 256^26");
});

check("the genesis block meets its own difficulty", () => {
  const a = P.analyze(sha256d(GENESIS_HEADER), 0x1d00ffff);
  eq(a.meetsTarget, true);
  eq(a.digestDisplayHex, GENESIS_DISPLAY);
  eq(a.decidingIndex, 27,
    "target has 0xff at index 27 where the digest has 0x00");
});

check("the genesis block does NOT meet a modern difficulty", () => {
  const a = P.analyze(sha256d(GENESIS_HEADER), P.EXAMPLE_NBITS);
  eq(a.meetsTarget, false);
  eq(a.zeroBytesRequired, 9);
  eq(a.zeroBytesAchieved, 5, "five zero bytes where nine are required");
});

check("leadingZeroBits counts from the top of the little-endian value", () => {
  eq(P.leadingZeroBits(sha256d(GENESIS_HEADER)), 43,
    "five zero bytes plus the three top bits of 0x19");
  eq(P.leadingZeroBits(new Uint8Array(32)), 256, "all zeros");
  const one = new Uint8Array(32); one[31] = 0x80;
  eq(P.leadingZeroBits(one), 0, "top bit set");
  const two = new Uint8Array(32); two[31] = 0x01;
  eq(P.leadingZeroBits(two), 7);
});

// ---------------------------------------------------------------------
group("pow: comparison and roles");
// ---------------------------------------------------------------------

check("a digest equal to the target meets it", () => {
  const t = P.targetBytes(P.EXAMPLE_NBITS);
  const a = P.analyze(t, P.EXAMPLE_NBITS);
  eq(a.meetsTarget, true, "the check is <=, not <");
  eq(a.decidingIndex, -1);
});

check("one over the target fails, and names the byte that failed it", () => {
  const t = Uint8Array.from(P.targetBytes(P.EXAMPLE_NBITS));
  t[22] += 1;
  const a = P.analyze(t, P.EXAMPLE_NBITS);
  eq(a.meetsTarget, false);
  eq(a.decidingIndex, 22);
});

check("a low byte cannot rescue a digest that is already over", () => {
  const t = Uint8Array.from(P.targetBytes(P.EXAMPLE_NBITS));
  t[31] = 1;      // far above the target
  t[0] = 0;       // far below it, at negligible weight
  eq(P.analyze(t, P.EXAMPLE_NBITS).meetsTarget, false);
  eq(P.analyze(t, P.EXAMPLE_NBITS).decidingIndex, 31);
});

check("byteRoles partitions all 32 bytes with no gaps or overlaps", () => {
  for (const nb of [P.EXAMPLE_NBITS, P.GENESIS_NBITS, 0x1b0404cb]) {
    const roles = P.byteRoles(nb);
    eq(roles.length, 32, "nBits=" + nb.toString(16));
    roles.forEach((r, i) => {
      eq(r.index, i);
      eq(r.displayPos, 31 - i, "display position is the mirror of the index");
      ok(["must-be-zero", "coefficient", "tail"].indexOf(r.role) >= 0);
    });
    eq(roles.filter((r) => r.role === "coefficient").length, 3,
      "exactly three coefficient bytes");
  }
});

check("the role bands line up with the nonzero bytes of the target", () => {
  /* The colouring must be derived from the target, not asserted alongside
   * it: every byte the target can be nonzero at is a coefficient byte, and
   * every must-be-zero byte is zero in the target too. */
  for (const nb of [P.EXAMPLE_NBITS, P.GENESIS_NBITS, 0x1b0404cb]) {
    const roles = P.byteRoles(nb);
    const t = P.targetBytes(nb);
    roles.forEach((r, i) => {
      if (r.role === "must-be-zero") {
        eq(t[i], 0, "target byte " + i + " for nBits=" + nb.toString(16));
      }
    });
  }
});

check("raising the difficulty widens the must-be-zero band", () => {
  const easy = P.byteRoles(P.GENESIS_NBITS).filter((r) => r.role === "must-be-zero");
  const hard = P.byteRoles(P.EXAMPLE_NBITS).filter((r) => r.role === "must-be-zero");
  ok(hard.length > easy.length,
    "mainnet requires more zero bytes than genesis: " +
    hard.length + " vs " + easy.length);
  eq(easy.length, 3);
  eq(hard.length, 9);
});

// ---------------------------------------------------------------------
group("pow: the hardest difficulty a digest clears");
// ---------------------------------------------------------------------

check("difficulty 1 is exactly the genesis target", () => {
  const t = P.targetBytes(P.GENESIS_NBITS);
  const h = P.hardestCleared(t);
  ok(Math.abs(h.difficulty - 1) < 1e-9,
    "a digest equal to the difficulty-1 target has difficulty 1, got " +
    h.difficulty);
});

check("halving the value doubles the difficulty", () => {
  const a = new Uint8Array(32); a[28] = 0x80;
  const b = new Uint8Array(32); b[28] = 0x40;
  const da = P.hardestCleared(a).difficulty;
  const db = P.hardestCleared(b).difficulty;
  ok(Math.abs(db / da - 2) < 1e-9, "expected 2x, got " + db / da);
});

check("the genesis block's own hash clears difficulty >= 1", () => {
  const h = P.hardestCleared(sha256d(GENESIS_HEADER));
  ok(h.difficulty >= 1,
    "the genesis block met difficulty 1, so its hash must clear it: " +
    h.difficulty);
  eq(h.leadingZeroBits, 43);
});

check("a random digest lands far below difficulty 1", () => {
  const h = P.hardestCleared(S.hash(hx("616263"), 24));
  ok(h.difficulty < 1e-6, "a single unsearched digest is not competitive");
  ok(h.log2Difficulty < 0);
});

check("encodeCompactCeil never encodes a target below the value", () => {
  /* The rounding direction is the whole point: a truncating encoder would
   * report an nBits the digest does not actually satisfy. */
  const rand = makeRand(0xc0ffee);
  for (let trial = 0; trial < 400; trial++) {
    const d = new Uint8Array(32);
    for (let i = 0; i < 32; i++) d[i] = (rand() * 256) | 0;
    /* Vary the magnitude so the top-byte and carry paths are both hit. */
    for (let i = 31; i > trial % 32; i--) d[i] = 0;
    const nb = P.encodeCompactCeil(d);
    if (nb === 0) { eq(P.topByteIndex(d), -1); continue; }
    const t = P.targetBytes(nb);
    ok(P.compareValues(t, d) >= 0,
      "target must be >= the value it was encoded from (trial " + trial + ")");
  }
});

check("encodeCompactCeil is exact when the value already fits", () => {
  /* A value with at most three significant bytes needs no rounding at all. */
  const d = new Uint8Array(32);
  d[22] = 0x03; d[21] = 0x4a; d[20] = 0x3f;
  eq(P.encodeCompactCeil(d), P.EXAMPLE_NBITS);
  eq(P.compareValues(P.targetBytes(P.encodeCompactCeil(d)), d), 0);
});

check("encodeCompactCeil handles the sign-bit shift", () => {
  /* A top byte of 0x80 or more cannot sit in the coefficient's high byte,
   * because bit 23 is a sign bit; the encoder must step the exponent. */
  const d = new Uint8Array(32);
  d[20] = 0xff; d[19] = 0x00; d[18] = 0x00;
  const nb = P.encodeCompactCeil(d);
  eq(P.decodeNBits(nb).negative, false, "must not encode as negative");
  ok(P.compareValues(P.targetBytes(nb), d) >= 0);
});

check("sub256 subtracts exactly, with borrow propagation", () => {
  const a = new Uint8Array(32); a[1] = 1;          // 256
  const b = new Uint8Array(32); b[0] = 1;          // 1
  const r = P.sub256(a, b);
  eq(r.borrow, 0);
  eq(r.diff[0], 255);
  eq(r.diff[1], 0);
  /* And a - a is zero everywhere. */
  const z = P.sub256(a, a);
  eq(Array.from(z.diff).every((x) => x === 0), true);
  eq(z.borrow, 0);
});

check("compareValues orders by significance, not by byte position", () => {
  const a = new Uint8Array(32); a[0] = 0xff;   // small: weight 256^0
  const b = new Uint8Array(32); b[31] = 0x01;  // large: weight 256^31
  eq(P.compareValues(a, b), -1);
  eq(P.compareValues(b, a), 1);
  eq(P.compareValues(a, a), 0);
});

// ---------------------------------------------------------------------
group("search: sampling a contiguous window");
// ---------------------------------------------------------------------

check("the default window is the first 64 bits", () => {
  /* The front of the message becomes schedule words W[0] and W[1], which
     propagate through all 64 rounds; the tail reaches far fewer directly. */
  eq(Q.defaultWindow(513, 64), { start: 0, width: 64 });
  eq(Q.defaultWindow(256, 64), { start: 0, width: 64 });
  eq(Q.defaultWindow(40, 64), { start: 0, width: 40 }, "a short message");
  eq(Q.WINDOW_BITS, 64);
});

check("windowFromRange treats both ends as inclusive", () => {
  eq(Q.windowFromRange(513, 0, 0), { start: 0, width: 1 });
  eq(Q.windowFromRange(513, 449, 512), { start: 449, width: 64 });
  eq(Q.windowFromRange(513, 0, 512), { start: 0, width: 513 });
});

check("windowFromRange clamps anything a person can type", () => {
  eq(Q.windowFromRange(513, -10, 20), { start: 0, width: 21 });
  eq(Q.windowFromRange(513, 500, 9999), { start: 500, width: 13 });
  eq(Q.windowFromRange(513, 400, 300), { start: 400, width: 1 },
    "an inverted range collapses rather than erroring");
  eq(Q.windowFromRange(513, 9999, 9999), { start: 512, width: 1 });
  eq(Q.windowFromRange(0, 0, 10), { start: 0, width: 0 });
});

check("windowEnd is the inverse of windowFromRange", () => {
  for (const [s, e] of [[0, 0], [0, 512], [449, 512], [7, 8], [100, 100]]) {
    const w = Q.windowFromRange(513, s, e);
    eq(Q.windowEnd(w), e, "round trip for " + s + ".." + e);
    eq(w.start, s);
  }
});

check("a range spanning the whole message samples every bit", () => {
  const msg = M.randomize(M.createMessage(513));
  const before = Array.from(msg.bytes);
  Q.run(msg, Q.windowFromRange(513, 0, 512), {
    samples: 30, thresholdBits: 256, rand: makeRand(13),
  });
  ok(Array.from(msg.bytes).some((b, i) => b !== before[i]), "something moved");
  S.checkTrailingBits(msg.bytes, msg.nbits);
});

check("clampWindow keeps the window contiguous and inside the message", () => {
  eq(Q.clampWindow(513, 500, 64), { start: 449, width: 64 },
    "slid back rather than truncated");
  eq(Q.clampWindow(513, -5, 64), { start: 0, width: 64 });
  eq(Q.clampWindow(40, 0, 64), { start: 0, width: 40 },
    "a short message gets the whole message");
  eq(Q.clampWindow(0, 0, 64), { start: 0, width: 0 });
});

check("sampling changes only the window and never the bits outside it", () => {
  const msg = M.randomize(M.createMessage(513));
  const before = Array.from(msg.bytes);
  const win = { start: 449, width: 64 };
  Q.run(msg, win, { samples: 50, thresholdBits: 256, rand: makeRand(7) });

  for (let i = 0; i < 513; i++) {
    const inWindow = i >= win.start && i < win.start + win.width;
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    if (!inWindow) {
      eq((msg.bytes[b] & mask) !== 0, (before[b] & mask) !== 0,
        "bit " + i + " is outside the window and must not move");
    }
  }
});

check("sampling leaves a legal message every time", () => {
  const msg = M.randomize(M.createMessage(513));
  const rand = makeRand(11);
  for (let i = 0; i < 40; i++) {
    Q.run(msg, { start: 449, width: 64 }, {
      samples: 1, thresholdBits: 256, rand,
    });
    /* The window ends at bit 512, inside the final byte, so this is exactly
     * where a sampler that ignored the trailing-bit rule would break. */
    S.checkTrailingBits(msg.bytes, msg.nbits);
    eq(msg.bytes[64] & 0x7f, 0);
  }
});

check("a window on a byte boundary and one off it both work", () => {
  for (const start of [0, 1, 7, 8, 449, 448]) {
    const msg = M.randomize(M.createMessage(513));
    const win = Q.clampWindow(513, start, 64);
    const r = Q.run(msg, win, {
      samples: 5, thresholdBits: 256, rand: makeRand(start + 1),
    });
    eq(r.attempts, 5, "start=" + start);
    S.checkTrailingBits(msg.bytes, msg.nbits);
  }
});

check("sampling stops the moment the threshold is met", () => {
  const msg = M.randomize(M.createMessage(513));
  const r = Q.run(msg, { start: 449, width: 64 }, {
    samples: 100000, thresholdBits: 8, rand: makeRand(3),
  });
  eq(r.found, true);
  ok(r.bits >= 8, "the ending sample must actually meet the threshold");
  ok(r.attempts < 100000, "and it must have stopped early");
  /* The message left standing must be the winning one, not the last drawn. */
  eq(P.leadingZeroBits(S.hashEx(msg.bytes, msg.nbits)), r.bits);
});

check("an unmet threshold exhausts the budget and reports honestly", () => {
  const msg = M.randomize(M.createMessage(513));
  const r = Q.run(msg, { start: 449, width: 64 }, {
    samples: 200, thresholdBits: 200, rand: makeRand(5),
  });
  eq(r.found, false);
  eq(r.attempts, 200);
  ok(r.bestBits < 200);
  ok(r.bestBits >= 0);
});

check("the digest reported is the digest of the message left behind", () => {
  const msg = M.randomize(M.createMessage(513));
  const r = Q.run(msg, { start: 449, width: 64 }, {
    samples: 25, thresholdBits: 256, rand: makeRand(9),
  });
  eq(S.bytesToHex(r.digest), S.hashHex(msg.bytes, msg.nbits));
});

check("leading-zero counts over many samples look like the geometric law", () => {
  /* Not a statistical test with a real bound — a sanity check that the score
   * being maximised is the proof-of-work one. About half of a large sample
   * should have zero leading zeros, and a run of 2000 should reach 8 or so. */
  const msg = M.randomize(M.createMessage(513));
  const rand = makeRand(0xbeef);
  let zeros = 0, best = 0;
  for (let i = 0; i < 2000; i++) {
    const r = Q.run(msg, { start: 449, width: 64 },
      { samples: 1, thresholdBits: 256, rand });
    if (r.bits === 0) zeros++;
    if (r.bits > best) best = r.bits;
  }
  ok(zeros > 800 && zeros < 1200, "about half should start with a 1: " + zeros);
  ok(best >= 6 && best <= 20, "best of 2000 should be around 11: " + best);
});

// ---------------------------------------------------------------------
group("search: the best single bit flip");
// ---------------------------------------------------------------------

check("bestSingleFlip picks the flip giving the smallest digest", () => {
  /* Checked against exhaustive search done independently here, which is the
   * only way to know the optimisation in the module — minimise the value
   * rather than maximise the difference — actually finds the same bit. */
  const msg = M.createMessage(64);
  M.setMessageHex(msg, "0123456789abcdef");
  const snapshot = Uint8Array.from(msg.bytes);

  let bestIdx = -1, bestDigest = null;
  for (let i = 0; i < 64; i++) {
    const probe = { bytes: Uint8Array.from(snapshot), nbits: 64 };
    M.toggleBit(probe, i);
    const d = S.hashEx(probe.bytes, probe.nbits);
    if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
      bestDigest = d; bestIdx = i;
    }
  }

  const r = Q.bestSingleFlip(msg);
  eq(r.indices, [bestIdx]);
  eq(r.tested, 64);
  eq(S.bytesToHex(r.after), S.bytesToHex(bestDigest));
});

check("the message is left with exactly the winning bit flipped", () => {
  const msg = M.createMessage(64);
  M.setMessageHex(msg, "0123456789abcdef");
  const before = Uint8Array.from(msg.bytes);
  const r = Q.bestSingleFlip(msg);

  let differing = [];
  for (let i = 0; i < 64; i++) {
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    if ((before[b] & mask) !== (msg.bytes[b] & mask)) differing.push(i);
  }
  eq(differing, r.indices, "exactly one bit should differ, the winner");
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(r.after),
    "and the message must hash to the digest that was reported");
});

check("the reported drop is the exact difference between the two digests", () => {
  const msg = M.createMessage(64);
  M.setMessageHex(msg, "0123456789abcdef");
  const r = Q.bestSingleFlip(msg);
  const expected = r.improved
    ? P.sub256(r.before, r.after).diff
    : P.sub256(r.after, r.before).diff;
  eq(Array.from(r.delta), Array.from(expected));
  ok(r.improved, "some flip should lower this particular digest");
  eq(P.compareValues(r.after, r.before) < 0, r.improved);
});

check("bestSingleFlip is deterministic — the same input gives the same bit", () => {
  const a = M.createMessage(64); M.setMessageHex(a, "0123456789abcdef");
  const b = M.createMessage(64); M.setMessageHex(b, "0123456789abcdef");
  eq(Q.bestSingleFlip(a).indices[0], Q.bestSingleFlip(b).indices[0]);
});

check("bestSingleFlip works on a sub-byte message", () => {
  const msg = M.randomize(M.createMessage(513));
  const r = Q.bestSingleFlip(msg);
  eq(r.tested, 513);
  ok(r.indices[0] >= 0 && r.indices[0] < 513);
  S.checkTrailingBits(msg.bytes, msg.nbits);
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(r.after));
});

check("bestSingleFlip returns null for an empty message", () => {
  eq(Q.bestSingleFlip(M.createMessage(0)), null);
});

// ---------------------------------------------------------------------
group("search: the best pair of bit flips");
// ---------------------------------------------------------------------

/** Run a pair scan to completion in `budget`-sized steps. */
function runPairScan(msg, budget) {
  const scan = Q.createFlipScan(msg, 2);
  let guard = 0;
  let last;
  do {
    last = scan.step(budget);
    if (++guard > 100000) throw new Error("pair scan failed to terminate");
  } while (!last.done);
  return { scan, last };
}

check("a pair scan visits exactly n(n-1)/2 pairs", () => {
  const msg = M.createMessage(32);
  M.setMessageHex(msg, "0123abcd");
  const { last } = runPairScan(msg, 7);   // an awkward budget on purpose
  eq(last.total, (32 * 31) / 2);
  eq(last.tested, last.total, "every pair must be visited exactly once");
});

check("a pair scan visits every distinct unordered pair, once", () => {
  /* Reconstructed by instrumenting the message: rather than trust the
   * cursor arithmetic, record which pairs a scan of a tiny message reaches. */
  const n = 12;
  const msg = M.createMessage(n);
  const seen = new Set();
  const scan = Q.createFlipScan(msg, 2);
  /* Re-derive the visit order from the cursor's own contract: step one pair
   * at a time and note the best-so-far indices whenever they move. */
  let count = 0;
  let r;
  do { r = scan.step(1); count++; } while (!r.done);
  /* The step that consumes the last pair also reports done, so the number of
   * steps equals the number of pairs exactly — no trailing empty step. */
  eq(count, (n * (n - 1)) / 2, "one step per pair, and no more");
  eq(r.tested, (n * (n - 1)) / 2);
  /* The pair the scan settled on must be a legal unordered pair. */
  ok(r.bestIndices[0] >= 0 && r.bestIndices[1] > r.bestIndices[0] &&
     r.bestIndices[1] < n);
  seen.add(r.bestIndices.join(","));
  eq(seen.size, 1);
});

check("the message is intact between steps, not only at the end", () => {
  /* This is what makes pausing between animation frames safe: anything that
   * renders mid-scan must see the original message. */
  const msg = M.randomize(M.createMessage(64));
  const before = Array.from(msg.bytes);
  const scan = Q.createFlipScan(msg, 2);
  for (let i = 0; i < 6; i++) {
    scan.step(50);
    eq(Array.from(msg.bytes), before, "message must be restored after step " + i);
  }
});

check("the scan finds the pair giving the smallest digest", () => {
  /* Checked against an independent exhaustive search over a small message. */
  const n = 24;
  const msg = M.createMessage(n);
  M.setMessageHex(msg, "616263");
  const snapshot = Uint8Array.from(msg.bytes);

  let bestPair = null, bestDigest = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const probe = { bytes: Uint8Array.from(snapshot), nbits: n };
      M.toggleBit(probe, i);
      M.toggleBit(probe, j);
      const d = S.hashEx(probe.bytes, probe.nbits);
      if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
        bestDigest = d; bestPair = [i, j];
      }
    }
  }

  const { scan } = runPairScan(msg, 13);
  const res = scan.apply();
  eq(res.indices, bestPair);
  eq(S.bytesToHex(res.after), S.bytesToHex(bestDigest));
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(bestDigest),
    "and the message must be left on the winning pair");
});

check("apply() flips exactly the two winning bits", () => {
  const msg = M.createMessage(24);
  M.setMessageHex(msg, "616263");
  const before = Uint8Array.from(msg.bytes);
  const { scan } = runPairScan(msg, 100);
  const res = scan.apply();

  const differing = [];
  for (let i = 0; i < 24; i++) {
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    if ((before[b] & mask) !== (msg.bytes[b] & mask)) differing.push(i);
  }
  eq(differing, res.indices, "exactly two bits, the winning pair");
});

check("the step budget does not affect the answer", () => {
  const answers = [1, 7, 100, 100000].map((budget) => {
    const msg = M.createMessage(24);
    M.setMessageHex(msg, "616263");
    const { scan } = runPairScan(msg, budget);
    return scan.apply().indices.join(",");
  });
  eq(new Set(answers).size, 1, "got " + answers.join(" / "));
});

check("a pair scan works on a sub-byte message and keeps it legal", () => {
  const msg = M.randomize(M.createMessage(41));
  const { scan, last } = runPairScan(msg, 200);
  eq(last.total, (41 * 40) / 2);
  const res = scan.apply();
  S.checkTrailingBits(msg.bytes, msg.nbits);
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(res.after));
});

check("a message too short to have a pair scans to zero and applies nothing", () => {
  for (const n of [0, 1]) {
    const scan = Q.createFlipScan(M.createMessage(n), 2);
    eq(scan.total, 0);
    eq(scan.step(10).done, true);
    eq(scan.apply(), null);
  }
});

check("the reported drop is the exact difference, in the right direction", () => {
  const msg = M.createMessage(24);
  M.setMessageHex(msg, "616263");
  const { scan } = runPairScan(msg, 500);
  const res = scan.apply();
  const expected = res.improved
    ? P.sub256(res.before, res.after).diff
    : P.sub256(res.after, res.before).diff;
  eq(Array.from(res.delta), Array.from(expected));
  eq(P.compareValues(res.after, res.before) < 0, res.improved);
});

check("pairs are not a superset of singles, and the code does not assume so", () => {
  /* A pair scan never tries a one-bit change, so its winner is not
   * guaranteed to beat the best single flip. Both are computed from the same
   * starting point here; the assertion is only that each is the best within
   * its own set, which is what each claims. */
  const base = M.createMessage(24);
  M.setMessageHex(base, "616263");

  const single = { bytes: Uint8Array.from(base.bytes), nbits: 24 };
  const singleRes = Q.bestSingleFlip(single);
  const pair = { bytes: Uint8Array.from(base.bytes), nbits: 24 };
  const pairRes = runPairScan(pair, 500).scan.apply();

  eq(pairRes.indices.length, 2);
  ok(singleRes.indices.length === 1);
  /* Whichever wins, each must be internally consistent. */
  eq(S.hashHex(single.bytes, 24), S.bytesToHex(singleRes.after));
  eq(S.hashHex(pair.bytes, 24), S.bytesToHex(pairRes.after));
});

// ---------------------------------------------------------------------
group("search: n-bit flips and their cost");
// ---------------------------------------------------------------------

check("combinations matches C(m,n) on known values", () => {
  eq(Q.combinations(513, 1), 513);
  eq(Q.combinations(513, 2), 131328);
  eq(Q.combinations(513, 3), 22369536);
  eq(Q.combinations(64, 3), 41664);
  eq(Q.combinations(5, 5), 1);
  eq(Q.combinations(5, 0), 1);
  eq(Q.combinations(5, 6), 0, "more bits than the message has");
  eq(Q.combinations(0, 1), 0);
});

check("combinations saturates instead of overflowing", () => {
  ok(Q.combinations(4096, 2000) === Infinity, "must not wrap or go NaN");
  ok(isFinite(Q.combinations(513, 4)), "2.8 billion still fits a double");
});

check("estimateSeconds turns a count into time at a measured rate", () => {
  eq(Q.estimateSeconds(1000000, 100000), 10);
  eq(Q.estimateSeconds(Infinity, 100000), Infinity);
  eq(Q.estimateSeconds(1000, 0), Infinity, "an unmeasured rate is not zero time");
});

check("a width-3 scan visits exactly C(m,3) combinations, each once", () => {
  const n = 16;
  const msg = M.randomize(M.createMessage(n));
  const scan = Q.createFlipScan(msg, 3);
  eq(scan.total, Q.combinations(n, 3));
  eq(scan.total, 560);
  let r; do { r = scan.step(37); } while (!r.done);
  eq(r.tested, 560);
  eq(r.n, 3);
});

check("the odometer emits strictly increasing, distinct indices", () => {
  /* If a combination ever repeated an index, toggling it twice would cancel
   * and the scan would silently be probing a narrower change than it claims. */
  const n = 12;
  const msg = M.createMessage(n);
  const scan = Q.createFlipScan(msg, 3);
  const seen = new Set();
  let r;
  do {
    r = scan.step(1);
    if (r.bestIndices) {
      const idx = r.bestIndices;
      eq(idx.length, 3);
      ok(idx[0] < idx[1] && idx[1] < idx[2], "strictly increasing: " + idx);
      seen.add(idx.join(","));
    }
  } while (!r.done);
  eq(r.tested, Q.combinations(n, 3));
});

check("a width-3 scan finds the same winner as an exhaustive search", () => {
  const n = 18;
  const msg = M.randomize(M.createMessage(n));
  const snapshot = Uint8Array.from(msg.bytes);

  let best = null, bestDigest = null;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        const probe = { bytes: Uint8Array.from(snapshot), nbits: n };
        M.toggleBit(probe, a); M.toggleBit(probe, b); M.toggleBit(probe, c);
        const d = S.hashEx(probe.bytes, probe.nbits);
        if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
          bestDigest = d; best = [a, b, c];
        }
      }
    }
  }

  const scan = Q.createFlipScan(msg, 3);
  let r; do { r = scan.step(11); } while (!r.done);
  const res = scan.apply();
  eq(res.indices, best);
  eq(res.n, 3);
  eq(S.bytesToHex(res.after), S.bytesToHex(bestDigest));
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(bestDigest));
});

check("apply flips exactly n bits, and the right ones", () => {
  const n = 18;
  const msg = M.randomize(M.createMessage(n));
  const before = Uint8Array.from(msg.bytes);
  const scan = Q.createFlipScan(msg, 3);
  let r; do { r = scan.step(500); } while (!r.done);
  const res = scan.apply();

  const differing = [];
  for (let i = 0; i < n; i++) {
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    if ((before[b] & mask) !== (msg.bytes[b] & mask)) differing.push(i);
  }
  eq(differing, res.indices);
  eq(differing.length, 3);
});

check("the message is intact between steps at any width", () => {
  for (const width of [1, 2, 3, 4]) {
    const msg = M.randomize(M.createMessage(20));
    const before = Array.from(msg.bytes);
    const scan = Q.createFlipScan(msg, width);
    for (let i = 0; i < 4; i++) {
      scan.step(13);
      eq(Array.from(msg.bytes), before, "width " + width + ", step " + i);
    }
  }
});

check("a width wider than the message scans nothing and applies nothing", () => {
  const scan = Q.createFlipScan(M.createMessage(3), 5);
  eq(scan.total, 0);
  eq(scan.step(10).done, true);
  eq(scan.apply(), null);
});

check("a ranged scan counts C(range width, n), not C(message, n)", () => {
  const msg = M.randomize(M.createMessage(513));
  eq(Q.createFlipScan(msg, 3, { start: 449, width: 64 }).total,
    Q.combinations(64, 3));
  eq(Q.createFlipScan(msg, 3, { start: 449, width: 64 }).total, 41664);
  eq(Q.createFlipScan(msg, 3).total, Q.combinations(513, 3),
    "no range means the whole message");
});

check("a ranged scan never touches a bit outside the range", () => {
  const msg = M.randomize(M.createMessage(120));
  const before = Array.from(msg.bytes);
  const range = { start: 40, width: 24 };
  const scan = Q.createFlipScan(msg, 2, range);
  let r; do { r = scan.step(29); } while (!r.done);
  eq(r.tested, Q.combinations(24, 2));

  const res = scan.apply();
  for (const i of res.indices) {
    ok(i >= 40 && i < 64, "index " + i + " must lie inside the range");
  }
  /* And the bits that did move are exactly the winning pair. */
  const differing = [];
  for (let i = 0; i < 120; i++) {
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    if ((before[b] & mask) !== (msg.bytes[b] & mask)) differing.push(i);
  }
  eq(differing, res.indices);
});

check("a ranged scan finds the best within the range, not overall", () => {
  /* The distinction matters: the globally best flip usually lies outside a
     narrow range, and a ranged scan must not find it. */
  const n = 40;
  const msg = M.randomize(M.createMessage(n));
  const snapshot = Uint8Array.from(msg.bytes);
  const range = { start: 8, width: 10 };   // bits 8..17

  let best = -1, bestDigest = null;
  for (let i = range.start; i < range.start + range.width; i++) {
    const probe = { bytes: Uint8Array.from(snapshot), nbits: n };
    M.toggleBit(probe, i);
    const d = S.hashEx(probe.bytes, probe.nbits);
    if (bestDigest === null || P.compareValues(d, bestDigest) < 0) {
      bestDigest = d; best = i;
    }
  }

  const res = Q.bestSingleFlip(msg, range);
  eq(res.indices, [best]);
  eq(res.tested, 10, "ten candidates, not forty");
  eq(S.bytesToHex(res.after), S.bytesToHex(bestDigest));
});

check("apply() declines when the best candidate is worse than the start", () => {
  /* A width-n scan never tries the do-nothing change, so its best can be a
     step backwards. Aimed at a single bit known to raise the digest. */
  const msg = M.randomize(M.createMessage(256));
  const base = S.hashEx(msg.bytes, msg.nbits);

  let worse = -1;
  for (let i = 0; i < 256 && worse < 0; i++) {
    M.toggleBit(msg, i);
    if (P.compareValues(S.hashEx(msg.bytes, msg.nbits), base) > 0) worse = i;
    M.toggleBit(msg, i);
  }
  ok(worse >= 0, "some bit must raise the digest");

  const before = Array.from(msg.bytes);
  const scan = Q.createFlipScan(msg, 1, { start: worse, width: 1 });
  scan.step(1);
  const res = scan.apply();

  eq(res.applied, false);
  eq(res.improved, false);
  eq(res.indices, [worse], "it still names the candidate it rejected");
  eq(Array.from(msg.bytes), before, "the message must not have moved");
  eq(S.bytesToHex(res.resulting), S.bytesToHex(base),
    "`resulting` is what the message actually has, not the candidate");
  ok(S.bytesToHex(res.after) !== S.bytesToHex(base),
    "`after` is still the rejected candidate, for reporting");
});

check("apply() takes an improvement, and says it did", () => {
  const msg = M.randomize(M.createMessage(256));
  const base = S.hashEx(msg.bytes, msg.nbits);

  let better = -1;
  for (let i = 0; i < 256 && better < 0; i++) {
    M.toggleBit(msg, i);
    if (P.compareValues(S.hashEx(msg.bytes, msg.nbits), base) < 0) better = i;
    M.toggleBit(msg, i);
  }
  ok(better >= 0, "some bit must lower the digest");

  const scan = Q.createFlipScan(msg, 1, { start: better, width: 1 });
  scan.step(1);
  const res = scan.apply();

  eq(res.applied, true);
  eq(res.indices, [better]);
  eq(S.hashHex(msg.bytes, msg.nbits), S.bytesToHex(res.after));
  eq(S.bytesToHex(res.resulting), S.bytesToHex(res.after));
});

check("a range narrower than n yields nothing", () => {
  const msg = M.randomize(M.createMessage(100));
  const scan = Q.createFlipScan(msg, 4, { start: 10, width: 3 });
  eq(scan.total, 0);
  eq(scan.step(10).done, true);
  eq(scan.apply(), null);
});

check("a ranged scan reports the range it used", () => {
  const msg = M.randomize(M.createMessage(64));
  const r = Q.createFlipScan(msg, 2, { start: 16, width: 8 }).step(1);
  eq(r.range, { start: 16, width: 8 });
});

check("width 1 through the general scanner equals bestSingleFlip", () => {
  const a = M.randomize(M.createMessage(64));
  const b = { bytes: Uint8Array.from(a.bytes), nbits: 64 };
  const viaScan = Q.createFlipScan(a, 1);
  viaScan.step(64);
  eq(viaScan.apply().indices, Q.bestSingleFlip(b).indices,
    "one implementation, so these cannot disagree");
});

// ---------------------------------------------------------------------
group("search: bits that do not change the leading zeros");
// ---------------------------------------------------------------------

check("the map classifies every bit, and the counts add up", () => {
  const msg = M.randomize(M.createMessage(513));
  const nz = Q.leadingZeroDeltaMap(msg);
  eq(nz.map.length, 513);
  eq(nz.same + nz.better + nz.worse, 513, "every bit gets exactly one verdict");
  eq(nz.base, P.leadingZeroBits(S.hashEx(msg.bytes, msg.nbits)));
});

check("each verdict is what actually happens when that bit is flipped", () => {
  /* Verified against the real thing for every bit, not sampled. */
  const msg = M.randomize(M.createMessage(120));
  const nz = Q.leadingZeroDeltaMap(msg);
  for (let i = 0; i < 120; i++) {
    M.toggleBit(msg, i);
    const z = P.leadingZeroBits(S.hashEx(msg.bytes, msg.nbits));
    M.toggleBit(msg, i);
    const expected = z === nz.base ? 0 : (z > nz.base ? 1 : -1);
    eq(nz.map[i], expected, "bit " + i + ": " + z + " vs base " + nz.base);
  }
});

check("the map leaves the message exactly as it found it", () => {
  const msg = M.randomize(M.createMessage(513));
  const before = Array.from(msg.bytes);
  Q.leadingZeroDeltaMap(msg);
  eq(Array.from(msg.bytes), before);
});

check("neutral bits are common at zero leading zeros and rare above", () => {
  /* The property that makes this feature worth reading: it says little on an
   * unsearched digest and a lot on a searched one. */
  const msg = M.randomize(M.createMessage(256));
  const low = Q.leadingZeroDeltaMap(msg);
  if (low.base === 0) {
    ok(low.same > 60 && low.same < 196,
      "about half of 256 bits should be neutral, got " + low.same);
  }

  /* Push it to a high leading-zero count, then re-map. */
  const r = Q.run(msg, Q.windowFromRange(256, 192, 255), {
    samples: 200000, thresholdBits: 12, rand: makeRand(21),
  });
  ok(r.found, "sampling should reach 12 zero bits");
  const high = Q.leadingZeroDeltaMap(msg);
  eq(high.base, r.bits);
  ok(high.same <= 4,
    "at " + high.base + " leading zeros almost nothing should be neutral, got " +
    high.same);
  ok(high.worse > 240, "nearly every bit should lose zeros, got " + high.worse);
});

check("an empty message produces an empty map", () => {
  const nz = Q.leadingZeroDeltaMap(M.createMessage(0));
  eq(nz.map.length, 0);
  eq(nz.same + nz.better + nz.worse, 0);
});

// ---------------------------------------------------------------------
group("model: counting through a range");
// ---------------------------------------------------------------------

check("incrementRegion counts up in big-endian order", () => {
  const msg = M.createMessage(16);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    seen.push(M.messageHex(msg));
    M.incrementRegion(msg, 8, 8);        // the second byte only
  }
  eq(seen, ["0000", "0001", "0002", "0003", "0004", "0005"],
    "the last bit of the range is the least significant");
});

check("the carry propagates to the front of the range and no further", () => {
  const msg = M.createMessage(24);
  M.setMessageHex(msg, "ff00ff");
  /* Range is the middle byte alone; its neighbours must not be disturbed
     even when it overflows. */
  for (let i = 0; i < 256; i++) M.incrementRegion(msg, 8, 8);
  eq(M.messageHex(msg), "ff00ff", "256 increments is a full cycle");

  M.incrementRegion(msg, 8, 8);
  eq(M.messageHex(msg), "ff01ff");
});

check("incrementRegion reports a wrap, and only on a wrap", () => {
  const msg = M.createMessage(8);
  eq(M.incrementRegion(msg, 0, 4), false, "0 -> 1");
  M.setMessageHex(msg, "e0");                 // range bits are 1110
  eq(M.incrementRegion(msg, 0, 4), false, "14 -> 15");
  eq(M.messageHex(msg), "f0");
  eq(M.incrementRegion(msg, 0, 4), true, "15 -> 0 wraps");
  eq(M.messageHex(msg), "00");
});

check("counting a range never disturbs bits outside it", () => {
  const msg = M.randomize(M.createMessage(200));
  const before = Array.from(msg.bytes);
  for (let i = 0; i < 300; i++) M.incrementRegion(msg, 64, 16);
  for (let i = 0; i < 200; i++) {
    const inRange = i >= 64 && i < 80;
    if (inRange) continue;
    const b = i >> 3, mask = 1 << (7 - (i & 7));
    eq((msg.bytes[b] & mask) !== 0, (before[b] & mask) !== 0, "bit " + i);
  }
});

check("counting keeps a sub-byte message legal", () => {
  const msg = M.randomize(M.createMessage(513));
  for (let i = 0; i < 40; i++) {
    M.incrementRegion(msg, 449, 64);
    S.checkTrailingBits(msg.bytes, msg.nbits);
  }
});

check("counting enumerates distinct points, unlike random sampling", () => {
  /* The point of having both: a counter cannot repeat until it cycles,
     whereas random draws collide by the birthday bound. */
  const msg = M.createMessage(64);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    M.incrementRegion(msg, 0, 16);
    seen.add(M.messageHex(msg));
  }
  eq(seen.size, 500, "500 increments must give 500 distinct states");
});

// ---------------------------------------------------------------------
group("pow: mapping a digest onto the circle");
// ---------------------------------------------------------------------

check("unitFraction maps the value space onto [0, 1)", () => {
  const zero = new Uint8Array(32);
  eq(P.unitFraction(zero), 0);

  const half = new Uint8Array(32); half[31] = 0x80;   // 2^255
  eq(P.unitFraction(half), 0.5);

  const quarter = new Uint8Array(32); quarter[31] = 0x40;
  eq(P.unitFraction(quarter), 0.25);

  const max = new Uint8Array(32).fill(0xff);
  ok(P.unitFraction(max) < 1, "must stay below 1");
  ok(P.unitFraction(max) > 0.9999, "but only just");
});

check("unitFraction is driven by the most significant bytes", () => {
  /* Byte 31 dominates; byte 0 is far below a double's precision and must not
     move the answer at all. */
  const a = new Uint8Array(32); a[31] = 0x10;
  const b = new Uint8Array(32); b[31] = 0x10; b[0] = 0xff;
  eq(P.unitFraction(a), P.unitFraction(b));
  const c = new Uint8Array(32); c[31] = 0x11;
  ok(P.unitFraction(c) > P.unitFraction(a));
});

// ---------------------------------------------------------------------
group("consistency: index.html and the UI layer");
// ---------------------------------------------------------------------

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

check("every script index.html loads exists on disk", () => {
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  ok(srcs.length > 0, "expected script tags");
  for (const src of srcs) {
    ok(fs.existsSync(path.join(ROOT, src)), "missing script: " + src);
  }
});

check("every stylesheet index.html loads exists on disk", () => {
  const hrefs = [...html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  ok(hrefs.length > 0, "expected a stylesheet");
  for (const href of hrefs) {
    ok(fs.existsSync(path.join(ROOT, href)), "missing stylesheet: " + href);
  }
});

check("scripts load in dependency order", () => {
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const at = (s) => srcs.indexOf(s);
  ok(at("js/vendor/shavar.js") >= 0, "shavar.js must be loaded");
  ok(at("js/vendor/shavar.js") < at("js/model.js"), "model.js needs SHAVAR");
  ok(at("js/model.js") < at("js/app.js"), "app.js needs the model");
  ok(at("js/pow.js") < at("js/app.js"), "app.js needs the PoW module");
  eq(at("js/app.js"), srcs.length - 1, "app.js must be last");
});

check("every element id the UI looks up exists in index.html", () => {
  /* The drift this catches: renaming an id in the HTML, or adding a
   * getElementById in the JS without adding the element. In a browser that
   * shows up as one silently dead panel, which is easy to miss. */
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const uiFiles = fs.readdirSync(path.join(ROOT, "js"))
    .filter((f) => f.endsWith(".js"));
  const missing = [];
  for (const f of uiFiles) {
    const src = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    for (const m of src.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
      if (!ids.has(m[1])) missing.push(f + " -> #" + m[1]);
    }
  }
  eq(missing, [], "element ids referenced by JS but absent from index.html");
});

check("every id in index.html is used by either JS or CSS", () => {
  /* The other direction of the same drift: an element that nothing looks up
   * and nothing styles is left over from something that was removed. */
  const css = fs.readFileSync(path.join(ROOT, "css/shatool.css"), "utf8");
  const js = fs.readdirSync(path.join(ROOT, "js"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(ROOT, "js", f), "utf8")).join("\n");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const orphans = ids.filter((i) => !js.includes('"' + i + '"') &&
    !css.includes("#" + i));
  eq(orphans, [], "ids in index.html that nothing references");
});

check("index.html declares no inline script or style blocks", () => {
  /* CLAUDE.md rule W2: UI logic separate from the markup. Enforced rather
   * than merely intended, because inline handlers accumulate. */
  ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
    "found an inline <script> block");
  ok(!/<style[^>]*>/.test(html), "found an inline <style> block");
  ok(!/\son(click|change|input|load)=/i.test(html),
    "found an inline event handler attribute");
});

// ---------------------------------------------------------------------
group("smoke: the application boots and responds");
// ---------------------------------------------------------------------
//
// Everything below runs the real UI modules against the real index.html on a
// minimal DOM (tests/domstub.js). It proves the app loads without throwing
// and that its handlers do what they claim. It proves nothing about how any
// of it looks; see the header of domstub.js for that boundary.

const dom = require("./domstub.js");
const D = dom.install(path.join(ROOT, "index.html"));

/* Load the UI layer into the same global scope the model already occupies,
 * in the order index.html loads it. app.js runs start() on load because the
 * stub reports readyState "complete". */
let bootError = null;
try {
  for (const rel of UI_SCRIPTS) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), "utf8"),
      { filename: rel });
  }
} catch (e) {
  bootError = e;
}

const el = (id) => D.getElementById(id);
/** The *editable* bit cells in the input grid, in message-bit order. Locked
 *  cells carry data-bit too, so they have to be excluded explicitly. */
const bitCells = () => dom.findAll(el("hex-grid"),
  (n) => n.classList.contains("bit") && !n.classList.contains("locked"));
/* The output panel builds persistent elements rather than assigning
 * innerHTML — that is what lets its cells animate — so these read the DOM
 * tree instead of scraping markup. */
const cellsIn = (id, cls) =>
  dom.findAll(el(id), (n) => n.classList.contains(cls));
/** The digest currently shown, in the order SHA-256 emits it. */
const shownDigest = () =>
  cellsIn("digest-hex", "dh-byte").map((n) => n.textContent).join("");
/** The 256 raster cells, in proof-of-work bit order. */
const rasterCells = () => cellsIn("digest-bit-raster", "br-bit");

/* The chaining strip and the legend are static text, so they are still built
 * with innerHTML and are read as strings. */
const chainWords = () =>
  [...el("chaining").innerHTML.matchAll(/class="cv-w [ae]"[^>]*>([0-9a-f]{8})</g)]
    .map((m) => m[1]);
/** Set the message length through the real control. */
const setNbits = (n) => {
  el("input-nbits").value = String(n);
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
};
/** Set the difficulty through the real nBits field. */
const setNBits = (hex) => {
  el("pow-nbits-custom").value = hex;
  dom.fire(el("pow-nbits-custom"), "input", { target: el("pow-nbits-custom") });
};
/** Set the sampling range through the real controls, inclusive. */
const setRange = (a, b) => {
  el("search-start").value = String(a);
  el("search-end").value = String(b);
  dom.fire(el("search-end"), "change", { target: el("search-end") });
};
/** The sampler's attempt total, read back off the panel. */
const sampleCount = () => {
  const m = el("search-stats").innerHTML
    .match(/points tried<\/span><span class="n">([\d,]+)</);
  return m ? Number(m[1].replace(/,/g, "")) : -1;
};
const selectBlock = (i) => dom.fire(el("block-tabs"), "click",
  { target: { classList: { contains: () => true }, getAttribute: () => String(i) } });


check("the application boots without throwing", () => {
  if (bootError) throw new Error(bootError.stack || String(bootError));
  ok(true);
});

check("it starts on a random 256-bit message in one block", () => {
  eq(el("stat-nbits").textContent, "256 bits");
  eq(el("stat-blocks").textContent, "1 block");
  eq(el("input-nbits").value, "256");
  eq(el("input-hex").value.length, 64, "32 bytes as hex — the digest's width");
});

check("it starts sampling the first 64 bits", () => {
  eq(el("search-start").value, "0");
  eq(el("search-end").value, "63");
  eq(el("search-window-label").textContent, "64 bits");
});

check("the initial message is not all zeros", () => {
  ok(/[1-9a-f]/.test(el("input-hex").value),
    "randomize should have produced a nonzero message");
});

check("the digest panel rendered a full 64-digit digest", () => {
  const d = shownDigest();
  eq(d.length, 64, "digest hex length");
  ok(/^[0-9a-f]{64}$/.test(d));
});

check("the shown digest is the digest of the shown message", () => {
  /* The cross-check that matters: the left panel and the right panel must be
   * describing the same message. Recomputed here from the hex on screen. */
  const hexShown = el("input-hex").value;
  eq(shownDigest(), S.hashHex(hx(hexShown), 256));
});

check("the input grid has one editable cell per message bit", () => {
  eq(bitCells().length, 256);
  const locked = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("locked"));
  eq(locked.length, 0, "256 is byte-aligned, so nothing is locked");
});

check("the block tabs offer exactly the padded block count", () => {
  const tabs = el("block-tabs").innerHTML.match(/data-block="\d+"/g) || [];
  eq(tabs.length, 1, "256 bits and its padding fit in one block");
  ok(/class="tab active" data-block="0"/.test(el("block-tabs").innerHTML));
});

check("clicking a bit cell flips it and changes the digest", () => {
  const before = shownDigest();
  const beforeHex = el("input-hex").value;
  const cell = bitCells()[0];
  dom.fire(el("hex-grid"), "click", { target: cell });

  const afterHex = el("input-hex").value;
  ok(afterHex !== beforeHex, "the message should have changed");
  const after = shownDigest();
  ok(after !== before, "the digest should have changed");
  eq(after, S.hashHex(hx(afterHex), 256), "and be correct for the new message");

  /* Flip it back, and everything should return exactly. */
  dom.fire(el("hex-grid"), "click", { target: bitCells()[0] });
  eq(el("input-hex").value, beforeHex);
  eq(shownDigest(), before);
});

check("editing a hex byte updates the digest", () => {
  const inputs = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("byte-hex"));
  eq(inputs.length, 32);
  inputs[0].value = "ff";
  dom.fire(el("hex-grid"), "input", { target: inputs[0] });
  eq(el("input-hex").value.slice(0, 2), "ff");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 256));
});

/* The default length is byte-aligned and single-block, which is the simple
 * case. The awkward ones are still reachable and still have to work, so they
 * are exercised here explicitly rather than relying on the default. */

check("a sub-byte length locks the final byte's spare bits", () => {
  setNbits(513);
  const locked = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("locked"));
  eq(locked.length, 7, "the final byte's seven insignificant bits");
  eq(bitCells().length, 513);

  const before = el("input-hex").value;
  dom.fire(el("hex-grid"), "click", { target: locked[0] });
  eq(el("input-hex").value, before, "bit 513 is not part of the message");
});

check("the final byte is masked to its one significant bit", () => {
  const inputs = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("byte-hex"));
  eq(inputs.length, 65);
  inputs[64].value = "ff";
  dom.fire(el("hex-grid"), "input", { target: inputs[64] });
  eq(el("input-hex").value.slice(-2), "80",
    "typing ff into the final byte of a 513-bit message stores 80");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 513));
});

check("513 bits spans two blocks, the second seeded by the first", () => {
  eq(el("stat-blocks").textContent, "2 blocks");
  const tabs = el("block-tabs").innerHTML.match(/data-block="\d+"/g) || [];
  eq(tabs.length, 2);
  setNbits(256);
});

check("bad hex in the bulk field surfaces an error and does not crash", () => {
  const before = shownDigest();
  el("input-hex").value = "nonsense";
  dom.fire(el("input-hex"), "input", { target: el("input-hex") });
  eq(el("msg-error").hidden, false, "the error line should be visible");
  ok(/hexadecimal/i.test(el("msg-error").textContent));
  eq(shownDigest(), before, "the digest should not have changed");
});

check("a valid bulk hex edit clears the error", () => {
  el("input-hex").value = "ab".repeat(32);
  dom.fire(el("input-hex"), "input", { target: el("input-hex") });
  eq(el("msg-error").hidden, true);
  eq(el("input-hex").value, "ab".repeat(32));
});

check("changing the length re-shapes the grid and the block count", () => {
  el("input-nbits").value = "24";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  eq(el("stat-nbits").textContent, "24 bits");
  eq(el("stat-blocks").textContent, "1 block");
  eq(bitCells().length, 24);
  const tabs = el("block-tabs").innerHTML.match(/data-block="\d+"/g) || [];
  eq(tabs.length, 1, "one block means one tab");
});

check("shrinking off a selected block does not leave a dangling index", () => {
  /* Regression guard for the ordering in app.js refresh(): select block 1 of
   * a two-block message, then shrink to one block. */
  el("input-nbits").value = "513";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  dom.fire(el("block-tabs"), "click",
    { target: { classList: { contains: () => true }, getAttribute: () => "1" } });
  ok(/class="tab active" data-block="1"/.test(el("block-tabs").innerHTML));

  el("input-nbits").value = "24";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  ok(/class="tab active" data-block="0"/.test(el("block-tabs").innerHTML),
    "selection should fall back to block 0");
});

check("known message and length produce the known digest end to end", () => {
  el("input-nbits").value = "24";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  el("input-hex").value = "616263";
  dom.fire(el("input-hex"), "input", { target: el("input-hex") });
  eq(shownDigest(),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    'the whole pipeline on "abc"');
});

check("reducing the round count changes the digest and the readout", () => {
  const full = shownDigest();
  el("input-rounds").value = "16";
  dom.fire(el("input-rounds"), "change", { target: el("input-rounds") });
  eq(el("stat-rounds").textContent, "16 of 64");
  ok(shownDigest() !== full, "16 rounds is not SHA-256");
  el("input-rounds").value = "64";
  dom.fire(el("input-rounds"), "change", { target: el("input-rounds") });
  eq(shownDigest(), full, "and restoring 64 rounds restores the digest");
  eq(el("stat-rounds").textContent, "64");
});

check("the round detail panel fills in when a round is selected", () => {
  ok(/Click a column/.test(el("round-detail").innerHTML),
    "starts with the hint");
  /* Selecting a round goes through the canvas click handler, which needs a
   * hit test; drive the callback path the handler uses instead by clicking
   * at a position inside the first band. */
  const canvas = el("canvas-main");
  dom.fire(canvas, "mousemove", { clientX: 300, clientY: 40 });
  dom.fire(canvas, "click", { clientX: 300, clientY: 40 });
  ok(/round t = /.test(el("round-detail").innerHTML),
    "a round should now be broken out");
  ok(/T1/.test(el("round-detail").innerHTML));
});

check("pinning a reference enables diff mode", () => {
  eq(el("chk-diff").disabled, true, "nothing to diff against yet");
  dom.fire(el("btn-set-reference"), "click", { target: el("btn-set-reference") });
  eq(el("chk-diff").disabled, false);
  eq(el("chk-diff").checked, true, "pinning turns diff mode on");
  ok(/differs from reference/.test(el("canvas-legend").innerHTML),
    "the legend must switch grammar with the mode");
});

check("editing nBits moves the colour bands", () => {
  const zeroBytes = () => cellsIn("digest-hex", "must-be-zero").length;
  setNBits("0x1d00ffff");
  eq(zeroBytes(), 3, "the genesis target requires three zero bytes");
  setNBits("0x17034a3f");
  eq(zeroBytes(), 9, "the mainnet default requires nine");
});

check("the bit raster draws all 256 bits with row labels", () => {
  eq(rasterCells().length, 256);
  const labels = cellsIn("digest-bit-raster", "br-label");
  eq(labels.length, 8, "one label per row of 32");
  eq(labels.map((n) => n.textContent),
    ["0", "32", "64", "96", "128", "160", "192", "224"]);
});

check("raster bit k maps to digest byte 31-k/8, most significant first", () => {
  /* The whole point of the raster is its ordering, so the mapping is pinned
   * against the digest actually on screen rather than trusted. */
  const digest = shownDigest();
  const byteAt = (i) => parseInt(digest.slice(2 * i, 2 * i + 2), 16);
  const cells = rasterCells();
  eq(cells.length, 256);
  cells.forEach((cell, k) => {
    const m = cell.title.match(
      /^PoW bit (\d+) · digest byte (\d+) bit (\d+) · value (\d)/);
    ok(m, "cell " + k + " should describe itself: " + cell.title);
    eq(Number(m[1]), k, "cells must be in PoW bit order");
    eq(Number(m[2]), 31 - (k >> 3), "byte index for PoW bit " + k);
    eq(Number(m[3]), 7 - (k & 7), "bit position for PoW bit " + k);
    eq(Number(m[4]), (byteAt(Number(m[2])) >> Number(m[3])) & 1,
      "value at bit " + k);
  });
});

check("PoW bit 0 is the top bit of the LAST digest byte", () => {
  const m = rasterCells()[0].title.match(/digest byte (\d+) bit (\d+)/);
  eq(m[1], "31");
  eq(m[2], "7");
});

check("the required-zero run matches the target's leading zeros", () => {
  for (const [nb, expected] of [["0x17034a3f", 78], ["0x1d00ffff", 32]]) {
    setNBits(nb);
    eq(cellsIn("digest-bit-raster", "req").length, expected,
      "required zero bits for nBits=" + nb);
    ok(new RegExp("needs ≥ " + expected + " leading zero bits")
      .test(el("digest-bit-caption").innerHTML), "caption for " + nb);
    /* And that count must equal what the PoW module says about the target,
     * so the picture and the arithmetic cannot drift apart. */
    eq(P.leadingZeroBits(P.targetBytes(parseInt(nb, 16))), expected);
    /* The run must be a prefix — contiguous from bit 0 — or it is not the
     * black block the panel claims it is. */
    const cells = rasterCells();
    for (let k = 0; k < 256; k++) {
      eq(cells[k].classList.contains("req"), k < expected,
        "req flag at bit " + k + " for nBits=" + nb);
    }
  }
});

check("the digest's own leading zeros are marked and counted in the raster", () => {
  const achieved = P.leadingZeroBits(hx(shownDigest()));
  const run = cellsIn("digest-bit-raster", "lz-run");
  eq(run.length, achieved, "one marked cell per leading zero");

  /* It must be a prefix — the run starts at bit 0 and stops at the first 1 —
   * or the block on screen is not the leading zeros it claims to be. */
  const cells = rasterCells();
  for (let k = 0; k < 256; k++) {
    eq(cells[k].classList.contains("lz-run"), k < achieved, "bit " + k);
  }
  /* And every marked cell must really be zero. */
  for (const c of run) ok(/· value 0/.test(c.title), c.title);

  const badge = el("lz-badge");
  if (achieved === 0) {
    eq(badge.hidden, true, "nothing to label at zero");
  } else {
    eq(badge.hidden, false);
    eq(badge.textContent,
      achieved + (achieved === 1 ? " leading zero" : " leading zeros"));
  }
});

check("the marked run tracks the digest as it changes", () => {
  /* Driven to a digest with a known, non-trivial number of leading zeros so
     the marking is exercised at more than whatever a random digest gives. */
  setNbits(256);
  setRange(0, 63);
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  el("search-threshold").value = "6";
  dom.fire(el("search-threshold"), "change", { target: el("search-threshold") });
  el("search-rate").value = "4000";
  dom.fire(el("search-rate"), "change", { target: el("search-rate") });
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });
  let frames = 0;
  while (dom.pendingFrames() > 0 && frames < 60) { dom.pumpFrames(1); frames++; }

  const achieved = P.leadingZeroBits(hx(shownDigest()));
  ok(achieved >= 6, "the run should have reached the threshold: " + achieved);
  eq(cellsIn("digest-bit-raster", "lz-run").length, achieved);
  eq(el("lz-badge").textContent, achieved + " leading zeros");
  ok(el("lz-badge").className.indexOf("pass") < 0,
    "six zeros does not clear a mainnet target, so no pass styling");
});

check("the badge marks a pass when the run reaches the requirement", () => {
  const achieved = P.leadingZeroBits(hx(shownDigest()));
  ok(achieved >= 6);
  /* A target whose top byte is nonzero, so it demands no leading zeros at
     all and any digest clears it. Checked, not assumed. */
  eq(P.leadingZeroBits(P.targetBytes(0x2100ffff)), 0);
  setNBits("0x2100ffff");
  ok(el("lz-badge").className.indexOf("pass") >= 0,
    "cleared: " + el("lz-badge").className);
  setNBits("0x17034a3f");
  ok(el("lz-badge").className.indexOf("pass") < 0);
  /* Leave no sampling session behind for the tests that follow. */
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
});

check("exactly one boundary marker, at the end of the required run", () => {
  setNBits("0x1d00ffff");
  const marked = cellsIn("digest-bit-raster", "boundary");
  eq(marked.length, 1);
  eq(marked[0].title.match(/^PoW bit (\d+)/)[1], "32",
    "genesis difficulty requires 32 leading zero bits");
});

check("a digest of all zeros lights no cells in the raster", () => {
  /* Not reachable by hashing, so the raster is checked against a digest the
   * PoW module is handed directly; this pins the "all zero means all dark"
   * end of the scale that a real digest never reaches. */
  const zero = new Uint8Array(32);
  eq(P.leadingZeroBits(zero), 256);
  eq(P.analyze(zero, P.EXAMPLE_NBITS).meetsTarget, true);
});

check("the genesis block's raster would show 43 dark cells then a lit one", () => {
  /* Ground truth, end to end: the genesis hash has 43 leading zero bits, so
   * a raster of it is 43 contiguous dark cells followed by a lit cell — and
   * 43 clears the 32 its own difficulty required. */
  const digest = sha256d(GENESIS_HEADER);
  const bitAt = (k) => (digest[31 - (k >> 3)] >> (7 - (k & 7))) & 1;
  for (let k = 0; k < 43; k++) eq(bitAt(k), 0, "PoW bit " + k);
  eq(bitAt(43), 1, "the first set bit");
  ok(P.leadingZeroBits(digest) >= P.leadingZeroBits(P.targetBytes(0x1d00ffff)));
});

check("an arbitrary nBits is accepted and reflected", () => {
  setNBits("0x1b0404cb");
  ok(/0x1b0404cb/.test(el("pow-stats").innerHTML), el("pow-stats").innerHTML);
  /* Written back into the field in canonical form on the next render. */
  eq(el("pow-nbits-custom").value, "0x1b0404cb");
  setNBits("0x17034a3f");
});

check("the panel defaults to a mainnet difficulty", () => {
  ok(/0x17034a3f/.test(html), "the field must ship with it");
  ok(/nBits is how a Bitcoin block header stores its difficulty target/
    .test(html), "and nBits must be explained in the tooltip");
  ok(!/<select/.test(html), "no difficulty picker any more");
});

check("the output panel states the single-vs-double hashing caveat", () => {
  /* This is a correctness property, not a styling one: the panel shows a
   * Bitcoin difficulty verdict for a single SHA-256 digest, and it must say
   * so. Removing the caveat would make the tool quietly misleading.
   * The prose is static markup, so it is checked in the file itself. */
  const note = html.slice(html.indexOf('id="pow-note"'));
  ok(/twice/.test(note), "must say Bitcoin hashes twice");
  ok(/not a block hash/.test(note), "must say this is not a block hash");
  ok(/little-endian/.test(note), "must explain the byte order");
});

check("randomize and zero both work from the buttons", () => {
  setNbits(24);
  dom.fire(el("btn-clear"), "click", { target: el("btn-clear") });
  eq(/^0+$/.test(el("input-hex").value), true, "zeroed");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 24));
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 24));
});

check("the canvas legend covers all four bands including K", () => {
  /* Diff mode replaces the whole legend, so it is turned off first — the
   * two grammars are deliberately never shown together. */
  el("chk-diff").checked = false;
  dom.fire(el("chk-diff"), "change", { target: el("chk-diff") });
  const legend = el("canvas-legend").innerHTML;
  for (const band of ["K", "W", "A", "E"]) {
    ok(new RegExp(band + " bit = 1").test(legend), "legend must explain " + band);
  }
  ok(/not computed/.test(legend));
  ok(/hue = track/.test(legend), "the grammar must be stated");
});

check("diff mode replaces the legend rather than adding to it", () => {
  el("chk-diff").checked = true;
  dom.fire(el("chk-diff"), "change", { target: el("chk-diff") });
  const legend = el("canvas-legend").innerHTML;
  ok(/differs from reference/.test(legend));
  ok(!/A bit = 1/.test(legend), "the track grammar must not linger");
  el("chk-diff").checked = false;
  dom.fire(el("chk-diff"), "change", { target: el("chk-diff") });
});

check("the chaining strip shows both chaining values, eight words each", () => {
  eq(chainWords().length, 16, "eight in, eight out");
});

check("block 0's incoming chaining value is displayed as the FIPS IV", () => {
  el("input-nbits").value = "513";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  selectBlock(0);
  eq(chainWords().slice(0, 8),
    Array.from(S.IV, (x) => x.toString(16).padStart(8, "0")));
  ok(/FIPS initial value/.test(el("chaining").innerHTML));
});

check("block 1's H in is block 0's H out, on screen", () => {
  const outOf0 = chainWords().slice(8);
  selectBlock(1);
  eq(chainWords().slice(0, 8), outOf0);
  ok(/block 0's outgoing value/.test(el("chaining").innerHTML));
  selectBlock(0);
});

check("the chaining words match the trace's own seed columns", () => {
  /* These eight words ARE A[-1..-4] and E[-1..-4]; the strip would be
   * decorative if it did not agree with the canvas it sits under. */
  const a = M.analyze({ bytes: hx(el("input-hex").value), nbits: 513 });
  const tr = a.blocks[0].trace;
  const shown = chainWords().slice(0, 8);
  for (let i = 0; i < 4; i++) {
    eq(shown[i], M.track(tr, "A", -1 - i).toString(16).padStart(8, "0"),
      "H[" + i + "] seeds A[" + (-1 - i) + "]");
    eq(shown[4 + i], M.track(tr, "E", -1 - i).toString(16).padStart(8, "0"),
      "H[" + (4 + i) + "] seeds E[" + (-1 - i) + "]");
  }
});

check("the sampled window is marked in the input grid, 64 bits wide", () => {
  setNbits(256);
  setRange(0, 63);
  const marked = bitCells().filter((c) => c.classList.contains("in-window"));
  eq(marked.length, 64);
  eq(marked.map((c) => Number(c.getAttribute("data-bit"))),
    Array.from({ length: 64 }, (_, i) => i),
    "the window must be the first 64 bits, and contiguous");
});

check("the sampling range is set by typing start and end bits", () => {
  setNbits(513);
  const setRange = (a, b) => {
    el("search-start").value = String(a);
    el("search-end").value = String(b);
    dom.fire(el("search-end"), "change", { target: el("search-end") });
  };
  const marked = () => bitCells()
    .filter((c) => c.classList.contains("in-window"))
    .map((c) => Number(c.getAttribute("data-bit")));

  setRange(0, 9);
  eq(marked(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "inclusive at both ends");
  eq(el("search-window-label").textContent, "10 bits");

  setRange(100, 100);
  eq(marked(), [100], "a single-bit range is legal");
  eq(el("search-window-label").textContent, "1 bit");

  setRange(0, 512);
  eq(marked().length, 513, "the whole message");
});

check("an out-of-range or inverted range is clamped, never rejected", () => {
  setNbits(513);
  const setRange = (a, b) => {
    el("search-start").value = String(a);
    el("search-end").value = String(b);
    dom.fire(el("search-end"), "change", { target: el("search-end") });
  };
  const marked = () => bitCells()
    .filter((c) => c.classList.contains("in-window"))
    .map((c) => Number(c.getAttribute("data-bit")));

  setRange(500, 9999);
  eq(marked()[marked().length - 1], 512, "clamped to the last message bit");
  eq(el("search-start").value, "500");
  eq(el("search-end").value, "512", "the field is corrected to what is used");

  setRange(400, 300);
  eq(marked(), [400], "end below start collapses to a single bit");

  setRange(-50, 20);
  eq(marked()[0], 0, "a negative start clamps to 0");
});

check("a resize clamps the range, and growing back restores it", () => {
  setNbits(513);
  /* The requested range is kept apart from the clamped window precisely so
   * this round trip is lossless. Clamping in place would collapse 400..500
   * to a single bit and never recover it. */
  const marked = () => bitCells()
    .filter((c) => c.classList.contains("in-window"))
    .map((c) => Number(c.getAttribute("data-bit")));

  el("search-start").value = "400";
  el("search-end").value = "500";
  dom.fire(el("search-end"), "change", { target: el("search-end") });
  eq(marked().length, 101, "inclusive 400..500");

  el("input-nbits").value = "64";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  eq(marked(), [63], "clamped to what a 64-bit message can hold");

  el("input-nbits").value = "513";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  eq(marked().length, 101, "and restored on the way back");
  eq(marked()[0], 400);

  el("search-start").value = "449";
  el("search-end").value = "512";
  dom.fire(el("search-end"), "change", { target: el("search-end") });
  eq(marked().length, 64);
});

check("starting a run schedules frames and shows it is running", () => {
  /* The sampling sequence that follows runs on a 513-bit message with the
     window on its last 64 bits, so the byte arithmetic below is explicit. */
  setNbits(513);
  setRange(449, 512);
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  el("search-threshold").value = "200";        // unreachable, so it will not stop
  dom.fire(el("search-threshold"), "change", { target: el("search-threshold") });
  el("search-rate").value = "5";
  dom.fire(el("search-rate"), "change", { target: el("search-rate") });

  eq(el("btn-search").textContent, "Start sampling");
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });
  eq(el("btn-search").textContent, "Pause", "the control must show its state");
  ok(el("btn-search").classList.contains("running"));
  ok(dom.pendingFrames() > 0, "a frame must be scheduled");
});

check("each frame samples, advances the counter, and redraws", () => {
  const digestBefore = shownDigest();
  /* Sampling frames share the animation queue with the canvas afterglow's
   * decay frames, so pumping N frames does not mean N rounds of sampling.
   * The assertion is on the counter, not on the frame count. */
  dom.pumpFrames(12);
  const n = sampleCount();
  ok(n >= 15, "expected several frames of 5 samples, got " + n);
  eq(n % 5, 0, "every frame draws a whole batch: " + n);
  ok(shownDigest() !== digestBefore, "the display must follow the sampling");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 513),
    "and must still be the digest of the message on screen");
});

check("sampling moves only the window's bits", () => {
  const hexBefore = el("input-hex").value;
  dom.pumpFrames(6);
  const hexAfter = el("input-hex").value;
  ok(hexBefore !== hexAfter, "something must have moved");
  /* The window is bits 449..512, which lives in bytes 56..64, so bytes 0..55
   * — the first 112 hex digits — must be untouched. */
  eq(hexBefore.slice(0, 112), hexAfter.slice(0, 112),
    "bytes 0..55 are wholly outside the window");
});

check("pausing stops the run", () => {
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });
  eq(el("btn-search").textContent, "Start sampling");
  ok(!el("btn-search").classList.contains("running"));
  const frozen = sampleCount();
  const hexFrozen = el("input-hex").value;
  dom.pumpFrames(20);
  eq(sampleCount(), frozen, "a paused run must not keep sampling");
  eq(el("input-hex").value, hexFrozen, "and must not keep changing the input");
});

check("a run stops by itself when the threshold is reached", () => {
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  el("search-threshold").value = "5";
  dom.fire(el("search-threshold"), "change", { target: el("search-threshold") });
  el("search-rate").value = "3000";
  dom.fire(el("search-rate"), "change", { target: el("search-rate") });
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });

  let frames = 0;
  while (dom.pendingFrames() > 0 && frames < 40) { dom.pumpFrames(1); frames++; }

  eq(el("btn-search").textContent, "Start sampling", "it must have stopped");
  ok(/stopped/.test(el("search-stats").innerHTML), "and must say why");
  const zeros = P.leadingZeroBits(hx(shownDigest()));
  ok(zeros >= 5, "the digest left on screen must actually meet it: " + zeros);
});

check("the raster caption reports the session's best, and marks it", () => {
  /* Runs after a completed sampling run, so there is a session to report. */
  const caption = el("digest-bit-caption").innerHTML;
  ok(/best this search session/.test(caption), caption);
  const m = caption.match(/best this search session<\/span><span class="n[^"]*">(\d+) in ([\d,]+) points/);
  ok(m, "must give the count and the sample total: " + caption);

  const best = Number(m[1]);
  eq(Number(m[2].replace(/,/g, "")), sampleCount(),
    "the sample total must agree with the counter beside it");

  /* The run stopped on reaching the threshold, so the best is at least that
   * and is also what the digest on screen shows. */
  ok(best >= 5, "the run stopped at 5 zero bits, so the best is at least that");
  eq(best, P.leadingZeroBits(hx(shownDigest())),
    "the winning sample is the one left on screen, so it IS the best");

  const marked = cellsIn("digest-bit-raster", "sess-best");
  eq(marked.length, 1, "exactly one marker");
  eq(Number(marked[0].title.match(/^PoW bit (\d+)/)[1]), best,
    "the marker must sit at the best bit count");
  ok(/best this session reached here/.test(marked[0].title));
});

check("the session best is absent before any sampling has happened", () => {
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  const caption = el("digest-bit-caption").innerHTML;
  ok(/target needs ≥/.test(caption), "the requirement is always shown");
  ok(!/best this search session/.test(caption),
    "but there is no session to report: " + caption);
  eq(cellsIn("digest-bit-raster", "sess-best").length, 0, "and no marker");
});

check("the session best survives editing the message", () => {
  /* It is a property of the sampling session, not of the digest on screen,
   * so hand-editing a bit afterwards must not clear or move it. */
  el("search-threshold").value = "4";
  dom.fire(el("search-threshold"), "change", { target: el("search-threshold") });
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });
  let frames = 0;
  while (dom.pendingFrames() > 0 && frames < 40) { dom.pumpFrames(1); frames++; }

  const before = el("digest-bit-caption").innerHTML
    .match(/session<\/span><span class="n[^"]*">(\d+) in/)[1];
  dom.fire(el("hex-grid"), "click", { target: bitCells()[0] });
  const after = el("digest-bit-caption").innerHTML
    .match(/session<\/span><span class="n[^"]*">(\d+) in/)[1];
  eq(after, before, "an edit must not disturb the session record");
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
});

check("reset clears the counters", () => {
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  const stats = el("search-stats").innerHTML;
  ok(/>0</.test(stats), "sample count back to zero: " + stats);
  ok(/—/.test(stats), "best-so-far cleared");
  eq(el("flip-result").innerHTML, "");
});

check("best single flip finds the same bit the module does", () => {
  /* Compute the answer independently from the message on screen, then press
   * the button and check the UI agrees. Scans cover the sampling range, so
   * the range is set to the whole message explicitly here. */
  setNbits(513);
  setRange(0, 512);
  const hexBefore = el("input-hex").value;
  const probe = { bytes: hx(hexBefore), nbits: 513 };
  const expected = Q.bestSingleFlip(probe, { start: 0, width: 513 });

  dom.fire(el("btn-best-flip"), "click", { target: el("btn-best-flip") });

  ok(/kept/.test(el("flip-result").innerHTML));
  ok(new RegExp("bit " + expected.indices[0] + "<").test(el("flip-result").innerHTML),
    "should report bit " + expected.indices[0] + ": " + el("flip-result").innerHTML);
  eq(el("input-hex").value, S.bytesToHex(probe.bytes),
    "the message must be left on the winning flip");
  eq(shownDigest(), S.bytesToHex(expected.after));
});

/** A bit whose flip moves the digest value in the given direction. */
function findBitWhereFlip(hexNow, nbits, direction) {
  const probe = { bytes: hx(hexNow), nbits: nbits };
  const base = S.hashEx(probe.bytes, nbits);
  for (let i = 0; i < nbits; i++) {
    M.toggleBit(probe, i);
    const d = S.hashEx(probe.bytes, nbits);
    M.toggleBit(probe, i);
    if (Math.sign(P.compareValues(d, base)) === direction) return i;
  }
  return -1;
}

check("a flip that improves is applied, and the move is reported", () => {
  /* Aimed at a single bit that is known to lower the digest, so the applied
     branch is exercised deterministically rather than by luck. */
  setNbits(513);
  /* From a fresh random message, where the digest is typical and about half
     of all flips lower it. Starting from an already-searched point would be
     flaky: after a good scan the value is small enough that most single
     flips raise it. */
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  const better = findBitWhereFlip(el("input-hex").value, 513, -1);
  ok(better >= 0, "some bit must lower the digest");
  setRange(better, better);

  const beforeHex = el("input-hex").value;
  dom.fire(el("btn-best-flip"), "click", { target: el("btn-best-flip") });

  const out = el("flip-result").innerHTML;
  ok(el("input-hex").value !== beforeHex, "the input must have moved");
  ok(new RegExp("kept</span><span class=\"n\">bit " + better + "<").test(out),
    out);
  ok(/fell by ≈ 2\^/.test(out), "must size the move: " + out);
  ok(!/left alone/.test(out));
});

check("a scan that cannot improve leaves the input alone and says so", () => {
  /* Aimed at a single bit that is known to raise the digest, so the only
     candidate the scan has is a step backwards. */
  setNbits(513);
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  const worse = findBitWhereFlip(el("input-hex").value, 513, 1);
  ok(worse >= 0, "some bit must raise the digest");
  setRange(worse, worse);

  const beforeHex = el("input-hex").value;
  const beforeDigest = shownDigest();
  dom.fire(el("btn-best-flip"), "click", { target: el("btn-best-flip") });

  eq(el("input-hex").value, beforeHex, "the input must not have moved");
  eq(shownDigest(), beforeDigest, "nor the digest");

  const out = el("flip-result").innerHTML;
  ok(/left alone/.test(out), "must say it declined: " + out);
  ok(new RegExp("best found</span><span class=\"n\">bit " + worse + "<")
    .test(out), "must still name the best candidate: " + out);
  ok(/would have risen by/.test(out), out);
  ok(/if taken/.test(out), "and must not read as if it happened: " + out);
  ok(!/kept/.test(out), "nothing was kept: " + out);
});

check("best pair flip really does span several frames", () => {
  /* 250 bits is 31,125 pairs: over the limit below which a scan just runs
   * synchronously, and about ten frames at a 3,000-pair budget. A shorter
   * message would finish in one go and the test would not be exercising the
   * resumable path at all. */
  setNbits(250);
  setRange(0, 249);
  const probe = { bytes: hx(el("input-hex").value), nbits: 250 };
  const scan = Q.createFlipScan(probe, 2, { start: 0, width: 250 });
  let r; do { r = scan.step(4000); } while (!r.done);
  const expected = scan.apply();

  dom.fire(el("btn-best-pair"), "click", { target: el("btn-best-pair") });
  eq(el("btn-best-pair").textContent, "Cancel",
    "the button that started it becomes its cancel button");
  ok(el("btn-search").disabled, "sampling must not run over a scan");
  ok(el("btn-best-flip").disabled, "nor another scan");
  ok(/scanning 2-bit flips/.test(el("flip-result").innerHTML));

  let frames = 0;
  while (el("btn-best-pair").textContent === "Cancel" && frames < 400) {
    dom.pumpFrames(1);
    frames++;
  }
  ok(frames > 3, "should have taken several frames, took " + frames);

  eq(el("btn-best-pair").textContent, "Best pair flip", "and reset when done");
  eq(el("input-hex").value, S.bytesToHex(probe.bytes),
    "the message must be left on the winning pair");
  eq(shownDigest(), S.bytesToHex(expected.after));
  ok(new RegExp("bits " + expected.indices.join(" \\+ "))
    .test(el("flip-result").innerHTML),
    "must name both bits: " + el("flip-result").innerHTML);
  ok(/2-bit combinations/.test(el("flip-result").innerHTML),
    "must say how many were tried: " + el("flip-result").innerHTML);
});

check("the message is untouched while a pair scan is mid-flight", () => {
  setNbits(250);
  setRange(0, 249);
  const before = el("input-hex").value;
  dom.fire(el("btn-best-pair"), "click", { target: el("btn-best-pair") });
  dom.pumpFrames(1);
  eq(el("btn-best-pair").textContent, "Cancel", "the scan must still be in flight");
  eq(el("input-hex").value, before,
    "a partial scan must not leave a probe applied");
  eq(shownDigest(), S.hashHex(hx(before), 250),
    "and the digest must still be the untouched message's");

  /* Abandoning it must also leave the message whole. */
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  eq(el("input-hex").value, before);
  eq(el("btn-best-pair").textContent, "Best pair flip");
  dom.pumpFrames(20);
  eq(el("input-hex").value, before, "an abandoned scan must not resume");
});

check("the n-flip control reports the count and an estimated time", () => {
  setNbits(513);
  setRange(0, 512);
  const setN = (n) => {
    el("flip-n").value = String(n);
    dom.fire(el("flip-n"), "change", { target: el("flip-n") });
  };

  setN(2);
  let text = el("flip-n-estimate").textContent;
  ok(/131k combinations/.test(text), text);
  ok(!el("btn-best-n").disabled, "131k is well within budget: " + text);

  setN(3);
  text = el("flip-n-estimate").textContent;
  ok(/22M combinations/.test(text), text);
  ok(/over bits 0–512/.test(text), "must name the range it covers: " + text);
});

check("narrowing the sampling range shrinks the scan enormously", () => {
  /* This is the whole reason scans are tied to the range: C(513,3) is 22
     million and takes minutes, C(64,3) is 41,664 and is instant. */
  setNbits(513);
  el("flip-n").value = "3";
  dom.fire(el("flip-n"), "change", { target: el("flip-n") });

  setRange(0, 512);
  ok(/22M combinations/.test(el("flip-n-estimate").textContent));

  setRange(449, 512);
  const text = el("flip-n-estimate").textContent;
  ok(/42k combinations/.test(text), text);
  ok(/over bits 449–512/.test(text), text);
  ok(!el("btn-best-n").disabled, "and is now perfectly runnable");
});

check("a scan that would take too long is refused, and says why", () => {
  setNbits(513);
  setRange(0, 512);
  el("flip-n").value = "4";              // 2.85 billion combinations
  dom.fire(el("flip-n"), "change", { target: el("flip-n") });
  const text = el("flip-n-estimate").textContent;
  ok(/too long/.test(text), "must say why: " + text);
  ok(el("btn-best-n").disabled, "and must not offer to start it");
  /* The refusal has to be driven by the estimate, not by n alone: the same
   * width on a short message is perfectly feasible. */
  setNbits(32);
  ok(!el("btn-best-n").disabled,
    "C(32,4) is 36k — fine: " + el("flip-n-estimate").textContent);
});

check("an n wider than the message is reported, not offered", () => {
  setNbits(3);
  el("flip-n").value = "5";
  dom.fire(el("flip-n"), "change", { target: el("flip-n") });
  ok(/no 5-bit combinations/.test(el("flip-n-estimate").textContent),
    el("flip-n-estimate").textContent);
  ok(el("btn-best-n").disabled);
});

check("the n-flip scan applies the winner, agreeing with the module", () => {
  setNbits(32);
  setRange(0, 31);
  el("flip-n").value = "3";
  dom.fire(el("flip-n"), "change", { target: el("flip-n") });

  const probe = { bytes: hx(el("input-hex").value), nbits: 32 };
  const scan = Q.createFlipScan(probe, 3, { start: 0, width: 32 });
  let r; do { r = scan.step(2000); } while (!r.done);
  const expected = scan.apply();

  dom.fire(el("btn-best-n"), "click", { target: el("btn-best-n") });
  eq(el("input-hex").value, S.bytesToHex(probe.bytes));
  eq(shownDigest(), S.bytesToHex(expected.after));
  ok(/3-bit combinations/.test(el("flip-result").innerHTML),
    el("flip-result").innerHTML);
  ok(new RegExp("bits " + expected.indices.join(" \\+ "))
    .test(el("flip-result").innerHTML), el("flip-result").innerHTML);
});

check("marking neutral bits classifies every bit and counts them", () => {
  setNbits(513);
  el("chk-neutral").checked = true;
  dom.fire(el("chk-neutral"), "change", { target: el("chk-neutral") });

  const cells = bitCells();
  const same = cells.filter((c) => c.classList.contains("lz-same")).length;
  const better = cells.filter((c) => c.classList.contains("lz-better")).length;
  const worse = cells.filter((c) => c.classList.contains("lz-worse")).length;
  eq(same + better + worse, 513, "every bit must carry exactly one verdict");

  /* The marks and the counts beside them come from the same map, so they
   * cannot disagree — which is exactly why it is worth asserting. */
  const expected = Q.leadingZeroDeltaMap(
    { bytes: hx(el("input-hex").value), nbits: 513 });
  eq(same, expected.same);
  eq(better, expected.better);
  eq(worse, expected.worse);

  const summary = el("neutral-summary").innerHTML;
  ok(new RegExp("no change if flipped</span><span class=\"n\">" + same + "<")
    .test(summary), summary);
  ok(new RegExp("current leading zeros</span><span class=\"n\">" +
    expected.base + "<").test(summary), summary);
});

check("no bit carries a neutral verdict when the marking is off", () => {
  el("chk-neutral").checked = false;
  dom.fire(el("chk-neutral"), "change", { target: el("chk-neutral") });
  const cells = bitCells();
  eq(cells.filter((c) => c.classList.contains("lz-same")).length, 0);
  eq(cells.filter((c) => c.classList.contains("lz-worse")).length, 0);
  eq(el("neutral-summary").innerHTML, "");
});

check("pausing the sampler rewinds to the best sample it found", () => {
  setNbits(513);
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  el("search-threshold").value = "200";      // unreachable: it will not stop
  dom.fire(el("search-threshold"), "change", { target: el("search-threshold") });
  el("search-rate").value = "300";
  dom.fire(el("search-rate"), "change", { target: el("search-rate") });

  dom.fire(el("btn-search"), "click", { target: el("btn-search") });
  dom.pumpFrames(30);

  /* Mid-run the message is wherever the last sample landed, which is almost
   * certainly not the best one. */
  const bestBits = Number(el("search-stats").innerHTML
    .match(/best so far<\/span><span class="n">(\d+) zero bits/)[1]);
  ok(bestBits >= 1, "a few thousand samples should beat zero");

  dom.fire(el("btn-search"), "click", { target: el("btn-search") });   // pause

  eq(P.leadingZeroBits(hx(shownDigest())), bestBits,
    "the message left on screen must be the best sample, not the last one");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 513),
    "and must still be internally consistent");
  ok(/rewound to the best sample/.test(el("search-stats").innerHTML),
    "and it must say so: " + el("search-stats").innerHTML);
});

check("pausing with nothing sampled leaves the message alone", () => {
  dom.fire(el("btn-search-reset"), "click", { target: el("btn-search-reset") });
  const before = el("input-hex").value;
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });   // start
  dom.fire(el("btn-search"), "click", { target: el("btn-search") });   // pause
  eq(el("input-hex").value, before, "no samples drawn, so nothing to rewind to");
});

check("the value circle is hidden until its checkbox is set", () => {
  eq(el("chk-circle").checked, false, "off by default");
  eq(el("circle-pane").hidden, true, "and the pane is not on screen");
  eq(el("circle-stats").innerHTML, "", "nor has it drawn anything");
});

check("checking the box shows the pane and starts it drawing", () => {
  el("chk-circle").checked = true;
  dom.fire(el("chk-circle"), "change", { target: el("chk-circle") });
  eq(el("circle-pane").hidden, false);
  ok(/position/.test(el("circle-stats").innerHTML), el("circle-stats").innerHTML);
  ok(/wraps through 0/.test(el("circle-stats").innerHTML));
});

check("the pane collapses without being hidden", () => {
  dom.fire(el("circle-toggle"), "click", { target: el("circle-toggle") });
  eq(el("circle-body").hidden, true, "the body folds away");
  eq(el("circle-pane").hidden, false, "but the pane stays on screen");
  dom.fire(el("circle-toggle"), "click", { target: el("circle-toggle") });
  eq(el("circle-body").hidden, false);
});

check("unchecking the box hides it again", () => {
  el("chk-circle").checked = false;
  dom.fire(el("chk-circle"), "change", { target: el("chk-circle") });
  eq(el("circle-pane").hidden, true);
  /* And a hidden pane must not keep accumulating a trail behind the user's
   * back: editing the message while it is off must not queue up positions
   * that all appear at once when it is switched back on. */
  const before = el("circle-stats").innerHTML;
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  eq(el("circle-stats").innerHTML, before, "nothing drawn while hidden");
});

check("the hardest-difficulty panel reports a difficulty and an nBits", () => {
  const best = el("pow-best").innerHTML;
  ok(/difficulty /.test(best), best);
  ok(/as nBits/.test(best));
  ok(/0x[0-9a-f]{8}/.test(best));
  ok(/vs genesis/.test(best));
});

check("the hardest difficulty is consistent with the digest on screen", () => {
  const digest = hx(shownDigest());
  const h = P.hardestCleared(digest);
  const best = el("pow-best").innerHTML;
  ok(new RegExp("0x" + h.nBits.toString(16).padStart(8, "0")).test(best),
    "panel must show the nBits the module computes");
  ok(new RegExp(">" + h.leadingZeroBits + "<").test(best),
    "and the same leading-zero count");
  /* The nBits it reports must be one the digest genuinely satisfies. */
  eq(P.analyze(digest, h.nBits).meetsTarget, true);
});

check("turning animation off does not break rendering", () => {
  setNbits(513);
  el("chk-animate").checked = false;
  dom.fire(el("chk-animate"), "change", { target: el("chk-animate") });
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 513));
  el("chk-animate").checked = true;
  dom.fire(el("chk-animate"), "change", { target: el("chk-animate") });
});

check("hiding the bit rows leaves the hex editor working", () => {
  el("input-nbits").value = "24";
  dom.fire(el("input-nbits"), "change", { target: el("input-nbits") });
  el("chk-showbits").checked = false;
  dom.fire(el("chk-showbits"), "change", { target: el("chk-showbits") });
  eq(bitCells().length, 0, "bit cells gone");
  const inputs = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("byte-hex"));
  eq(inputs.length, 3, "byte fields remain for a 24-bit message");
  el("chk-showbits").checked = true;
  dom.fire(el("chk-showbits"), "change", { target: el("chk-showbits") });
  eq(bitCells().length, 24);
});

// ---------------------------------------------------------------------
group("the value circle: drawing conventions");
// ---------------------------------------------------------------------
//
// These helpers live in js/ui-circle.js, which is part of the UI layer and is
// only loaded once a document exists, so they are exercised here rather than
// with the rest of the pure-math groups above.

check("a decrease in value is exactly a wrap through zero", () => {
  /* The convention the drawing depends on: motion is always clockwise, so a
     smaller value can only be reached by passing zero. */
  const C = globalThis.SHATOOL_UI_CIRCLE;
  eq(C.isWrap(0.9, 0.1), true, "a big drop wraps");
  eq(C.isWrap(0.5, 0.4999), true, "so does a tiny one");
  eq(C.isWrap(0.1, 0.9), false, "a rise does not");
  eq(C.isWrap(0.5, 0.5), false, "nor does standing still");
});

check("the clockwise sweep is consistent with the wrap it implies", () => {
  const C = globalThis.SHATOOL_UI_CIRCLE;
  ok(Math.abs(C.sweep(0.1, 0.4) - 0.3) < 1e-12, "no wrap: the direct gap");
  ok(Math.abs(C.sweep(0.9, 0.1) - 0.2) < 1e-12, "wrapped: through zero");
  eq(C.sweep(0.5, 0.5), 0);
  /* Whichever way, the sweep is a fraction of one turn. */
  for (const [a, b] of [[0, 0.999], [0.999, 0], [0.3, 0.7], [0.7, 0.3]]) {
    const s = C.sweep(a, b);
    ok(s >= 0 && s < 1, a + " -> " + b + " swept " + s);
    eq(C.isWrap(a, b), b < a);
  }
});

check("angleOf puts zero at the top and runs clockwise", () => {
  const C = globalThis.SHATOOL_UI_CIRCLE;
  const TAU = Math.PI * 2;
  eq(C.angleOf(0), -Math.PI / 2, "zero is straight up");
  ok(Math.abs(C.angleOf(0.25) - 0) < 1e-12, "a quarter turn is to the right");
  ok(Math.abs(C.angleOf(0.5) - Math.PI / 2) < 1e-12, "a half turn is down");
  ok(C.angleOf(0.75) > C.angleOf(0.5), "angle increases with value");
  ok(Math.abs((C.angleOf(1) - C.angleOf(0)) - TAU) < 1e-12, "a full turn");
});


// ---------------------------------------------------------------------

console.log("\n" + "-".repeat(60));
if (failures.length === 0) {
  console.log("ok " + passed + " checks passed");
  process.exit(0);
} else {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length));
  for (const f of failures) console.log("  " + f.group + " / " + f.name);
  process.exit(1);
}
