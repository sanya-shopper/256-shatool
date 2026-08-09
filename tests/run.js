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

const SCRIPTS = ["js/vendor/shavar.js", "js/model.js", "js/pow.js"];
for (const rel of SCRIPTS) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
    filename: rel,
  });
}

const S = globalThis.SHAVAR;
const M = globalThis.SHATOOL_MODEL;
const P = globalThis.SHATOOL_POW;

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
  for (const rel of ["js/ui-input.js", "js/ui-canvas.js", "js/ui-output.js",
                     "js/app.js"]) {
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
/** The digest currently shown, scraped from the rendered spans. */
const shownDigest = () =>
  [...el("digest-hex").innerHTML.matchAll(/>([0-9a-f]{2})</g)]
    .map((m) => m[1]).join("");

check("the application boots without throwing", () => {
  if (bootError) throw new Error(bootError.stack || String(bootError));
  ok(true);
});

check("it starts on a random 513-bit message", () => {
  eq(el("stat-nbits").textContent, "513 bits");
  eq(el("stat-blocks").textContent, "2 blocks");
  eq(el("input-nbits").value, "513");
  eq(el("input-hex").value.length, 130, "65 bytes as hex");
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
  eq(shownDigest(), S.hashHex(hx(hexShown), 513));
});

check("the input grid has one editable cell per message bit", () => {
  eq(bitCells().length, 513);
  const locked = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("locked"));
  eq(locked.length, 7, "the final byte's seven insignificant bits");
});

check("the block tabs offer exactly the padded block count", () => {
  const tabs = el("block-tabs").innerHTML.match(/data-block="\d+"/g) || [];
  eq(tabs.length, 2);
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
  eq(after, S.hashHex(hx(afterHex), 513), "and be correct for the new message");

  /* Flip it back, and everything should return exactly. */
  dom.fire(el("hex-grid"), "click", { target: bitCells()[0] });
  eq(el("input-hex").value, beforeHex);
  eq(shownDigest(), before);
});

check("a locked bit cell does nothing when clicked", () => {
  const before = el("input-hex").value;
  const locked = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("locked"))[0];
  dom.fire(el("hex-grid"), "click", { target: locked });
  eq(el("input-hex").value, before, "bit 513 is not part of the message");
});

check("editing a hex byte updates the digest", () => {
  const inputs = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("byte-hex"));
  eq(inputs.length, 65);
  inputs[0].value = "ff";
  dom.fire(el("hex-grid"), "input", { target: inputs[0] });
  eq(el("input-hex").value.slice(0, 2), "ff");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 513));
});

check("the final byte is masked to its one significant bit", () => {
  const inputs = dom.findAll(el("hex-grid"),
    (n) => n.classList.contains("byte-hex"));
  inputs[64].value = "ff";
  dom.fire(el("hex-grid"), "input", { target: inputs[64] });
  eq(el("input-hex").value.slice(-2), "80",
    "typing ff into the final byte of a 513-bit message stores 80");
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
  el("input-hex").value = "ab".repeat(65);
  dom.fire(el("input-hex"), "input", { target: el("input-hex") });
  eq(el("msg-error").hidden, true);
  eq(el("input-hex").value.slice(-2), "80", "final byte re-masked");
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

check("changing the difficulty moves the colour bands", () => {
  const sel = el("pow-nbits");
  sel.value = "0x1d00ffff";
  dom.fire(sel, "change", { target: sel });
  const genesis = (el("digest-hex").innerHTML.match(/must-be-zero/g) || []).length;
  sel.value = "0x17034a3f";
  dom.fire(sel, "change", { target: sel });
  const mainnet = (el("digest-hex").innerHTML.match(/must-be-zero/g) || []).length;
  eq(genesis, 3, "genesis requires three zero bytes");
  eq(mainnet, 9, "the mainnet example requires nine");
});

check("a custom nBits is accepted and reflected", () => {
  const sel = el("pow-nbits");
  sel.value = "custom";
  dom.fire(sel, "change", { target: sel });
  eq(el("pow-nbits-custom-row").hidden, false);
  el("pow-nbits-custom").value = "0x1b0404cb";
  dom.fire(el("pow-nbits-custom"), "input", { target: el("pow-nbits-custom") });
  ok(/0x1b0404cb/.test(el("pow-stats").innerHTML));
});

check("the output panel states the single-vs-double hashing caveat", () => {
  /* This is a correctness property, not a styling one: the panel shows a
   * Bitcoin difficulty verdict for a single SHA-256 digest, and it must say
   * so. Removing the caveat would make the tool quietly misleading. */
  const note = el("pow-note").innerHTML;
  ok(/twice/.test(note), "must say Bitcoin hashes twice");
  ok(/not a block hash/.test(note), "must say this is not a block hash");
  ok(/little-endian/.test(note), "must explain the byte order");
});

check("randomize and zero both work from the buttons", () => {
  dom.fire(el("btn-clear"), "click", { target: el("btn-clear") });
  eq(/^0+$/.test(el("input-hex").value), true, "zeroed");
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 24));
  dom.fire(el("btn-randomize"), "click", { target: el("btn-randomize") });
  eq(shownDigest(), S.hashHex(hx(el("input-hex").value), 24));
});

check("hiding the bit rows leaves the hex editor working", () => {
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

console.log("\n" + "-".repeat(60));
if (failures.length === 0) {
  console.log("ok " + passed + " checks passed");
  process.exit(0);
} else {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length));
  for (const f of failures) console.log("  " + f.group + " / " + f.name);
  process.exit(1);
}
