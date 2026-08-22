# shatool — working notes

Running log of decisions, open questions, and context. Newest entries at the
bottom of each section. The README describes what the tool *is*; this file
records why it is that way and what is still unresolved.

## What this is

A static web UI for analysing and visualising the operation of SHA-256. Three
columns: message editor on the left, the compression rendered as a bit raster
in the middle, digest and Bitcoin proof-of-work reading on the right. Opens
from a `file://` URL with no server and no build step.

## Decisions

- **2026-08-09 — Repo initialized on `main`.** Notes kept here rather than
  scattered across commit messages, so reasoning survives independently of the
  diff that implemented it.

- **2026-08-09 — SHA-256 comes from the sibling `256-shavar` repo, vendored.**
  Copied verbatim to `js/vendor/shavar.js`; provenance, upstream commit and
  checksum recorded in `js/vendor/README.md`, and the checksum is re-verified
  by the test suite so a silent divergence between the two repos fails the
  build here. Reimplementing would have meant re-deriving 1154 NIST CAVP
  vectors' worth of confidence for no gain. `256-shavar` was also the right
  choice specifically: `traceBlock()` exposes the full per-round interior
  (`W`, `A`, `E`, `T1`, `T2`), which is the thing being visualised, and it
  supports arbitrary **bit** lengths, without which a 513-bit default message
  could not be expressed at all.

- **2026-08-09 — Classic scripts and globals, not ES modules.** ES module
  scripts are blocked by CORS from a `file://` origin in current Chrome and
  Safari, so a page built from modules cannot simply be double-clicked. The
  vendored library already follows the one-frozen-global convention for the
  same reason, so the rest of the app matches it. `tests/run.js` pins the
  script load order in `index.html` so a dependency cannot be loaded before
  what it needs.

- **2026-08-09 — Default input is 513 random bits.** As specified, and it
  turns out to be awkward in three useful ways at once: not a multiple of 8,
  so the final byte carries one significant bit and seven that must be zero;
  one bit too long to fit its own padding in a single block, so the message
  occupies two; and therefore block 1 is compressed against a computed
  chaining value rather than the FIPS IV. Nearly every edge case the tool
  needs to handle is on screen at load.

- **2026-08-09 — Time on the x-axis, bits on the y-axis, hue for track.**
  The canvas draws three stacked rasters — `W`, `A`, `E` — sharing one time
  axis running left to right, so a column is one round of the recurrence.
  Hue encodes which track a cell belongs to and luminance encodes the bit's
  value; those two channels never swap meanings (CLAUDE.md rule A8). Diff
  mode switches the whole grammar at once and the legend switches with it,
  rather than overloading the existing colours with a second meaning.

- **2026-08-09 — The axis is always 68 columns (t = −4 … 63).** Fixed width
  regardless of the round limit, so the geometry does not jump while the
  limit is being scrubbed, and so it stays visible that the schedule is
  computed for all 64 rounds whether or not they run. The four negative
  columns are the seed window taken from the chaining value; a dashed rule
  separates them from computed rounds so they are not mistaken for one.

- **2026-08-09 — The digest is assembled from the traces, not hashed again.**
  A second, independent call to `hashEx()` could in principle disagree with
  the trace on screen, and a tool that displays a digest its own trace does
  not produce is worse than no tool. A test asserts the two agree across a
  range of lengths, which is what makes the shortcut safe.

- **2026-08-09 — The PoW panel states what it is not.** Bitcoin applies
  SHA-256 *twice* to an 80-byte header; shatool applies it once to an
  arbitrary message. The panel therefore claims only what is exactly true —
  given any 32 bytes, this is the weight each byte carries in the difficulty
  comparison and this is how the comparison comes out — and says plainly that
  the digest is not a block hash. A test asserts the caveat text is present,
  because deleting it would leave the tool quietly misleading, which is the
  failure mode CLAUDE.md cares most about.

- **2026-08-09 — Difficulty bands are derived from nBits, never hardcoded.**
  `byteRoles()` computes the must-be-zero / coefficient / tail boundaries from
  the decoded exponent, so changing the difficulty moves the colours. A test
  checks the bands against the decoded target itself rather than against a
  second copy of the same arithmetic.

- **2026-08-09 — Hand-rolled DOM stub for smoke tests.** Neither jsdom nor a
  headless browser is available here, and adding either would put a
  `node_modules` tree into a repo that otherwise has no dependencies and no
  build step. `tests/domstub.js` implements only what shatool touches, which
  is enough to boot the real app against the real `index.html` and exercise
  the real handlers. Its limits are stated in its own header: it catches
  "that name does not exist" and "that handler throws", and nothing at all
  about appearance.

- **2026-08-09 — The output panel patches its cells; it does not rebuild
  them.** Assigning `innerHTML` destroys every cell and creates new ones
  already at their final colour, so CSS transitions never fire and the
  animation silently does nothing. Structure is therefore built once and only
  classes and text are patched. This is a constraint on that file, not a
  preference: reintroducing an `innerHTML` assignment for the digest, the byte
  grid or the raster would turn the animation off without any test noticing.

- **2026-08-09 — The sampling range is stored twice: as requested and as
  clamped.** `search.range` is what the user typed and is changed only by the
  user; `search.window` is that range clamped to the current message and is
  re-derived on every refresh. Clamping in place instead — which is what the
  first version did — permanently collapsed a 400–500 range to a single bit
  when the message was shrunk to 64 bits, and growing it back did not restore
  it. The tests caught this.

- **2026-08-09 — `encodeCompactCeil` rounds up, never truncates.** The compact
  nBits form keeps three significant bytes, so truncating a digest into it
  produces a target *below* that digest — an nBits the digest does not
  actually satisfy. Rounding up is the only direction that keeps the claim
  "this is the hardest difficulty it clears" true. A randomised test asserts
  the encoded target is `>=` the value it came from across the top-byte and
  carry paths.

- **2026-08-09 — Finding the best single flip needs no subtraction.** The drop
  from flipping bit *i* is `base − value(i)` and `base` is the same for every
  candidate, so maximising the drop is exactly minimising the resulting
  digest. 256-bit arithmetic is needed only to report how large the drop was,
  not to find it. A test verifies this against an independent exhaustive
  search rather than trusting the reasoning.

- **2026-08-09 — Animation is capped and can be turned off.** A sampling run
  changes roughly half of every word every frame, so an uncapped
  full-canvas flash would strobe. The afterglow alpha tops out well short of
  opaque, `prefers-reduced-motion` disables it entirely, and there is an
  explicit Animate checkbox.

- **2026-08-09 — The pair scan is a resumable cursor, not a function.** A
  full scan is n(n−1)/2 hashes — 131,328 for the default message, measured at
  ~1.3 s in Node and likely worse in a browser. One synchronous call would
  freeze the page and show nothing while it did. `createPairScan().step(budget)`
  advances and returns; `app.js` spreads it across animation frames. The
  message is restored after every *individual pair*, not at the end of a step,
  which is what makes pausing between frames safe — whatever renders in the
  gap sees the original message.

- **2026-08-09 — Pairs are not a superset of singles.** A pair scan never
  tries a one-bit change, so its winner can be worse than the best single
  flip. The panel reports what each scan found and does not present one as an
  improvement on the other.

- **2026-08-21 — Visual verification, and what it changed.** Browser
  automation became available; no browser was installed, so
  `chrome-headless-shell` (Chrome 152) was fetched outside the repo — the
  no-dependencies property still holds, nothing was added here. Two defects,
  both in CSS, both now fixed:

  1. **The stacked layout overlapped itself below 1100px.** The wide layout
     pins the page to the viewport (`html, body { height: 100% }`, panels
     scroll internally); the narrow media query stacked the panels and set
     panels to `overflow: visible` but left the page pinned, so the flexed
     `#layout` kept viewport height, the grid squeezed its rows below their
     content, and each panel's content painted straight across the panel
     below it — the hex grid was clipped mid-row and the canvas bled over
     the Output section. Fix: `html, body { height: auto }` inside the
     media query, so the page grows and scrolls as a document. The bug was
     invisible to the DOM-stub tests by construction; only a rendering
     confirmed it.

  2. **The byte-role key wrapped mid-range.** In the narrow Output panel,
     `bytes 20–22 / compared against the nBits coefficient` flex-shrank its
     label to "bytes 20–" with "22" orphaned on the next line, reading as
     two entries. Fix: the label span never wraps, and wrapped values are
     right-aligned so continuation lines stay attached to their row.

  What was checked and found sound: the three-column layout at 1440×900 and
  2200×1400 with no label overlap; the K/W/A/E hue separation and the
  on/off/not-computed luminance steps, legible at every size tried; the
  seed window and dashed rule; the digest byte grid and the 256-bit raster
  with its required-zero outline; the bit toggle end to end (clicking the
  first bit cell turned hex `21` into `a1` — the MSB, so cell order is
  right — and the digest re-rendered); the clear-a-leading-bit explosion
  (driven by switching between two precomputed messages with 0 and 5
  leading zeros; five cells animated and the badge bumped to "5 leading
  zeros"); and zero console errors across load and all of the above.

  Interactions were driven without adding any tooling to the repo: Node's
  built-in WebSocket speaking the Chrome DevTools protocol directly —
  `Runtime.evaluate` to click and to set the hex field, then
  `Page.captureScreenshot`. The app has no URL-state hook, and none was
  added for this; nothing needed it.

- **2026-08-09 — "Per frame" was a confusing label.** A user read it as
  something other than samples-drawn-between-redraws and concluded the
  sampling had stopped animating. Renamed to "Per redraw" with a tooltip
  giving the samples-per-second it works out to. No code was wrong; the word
  was.

## Open questions

- ~~**No visual verification yet.**~~ **Done, 2026-08-09 → 2026-08-21.**
  Verified in headless Chrome (chrome-headless-shell 152) at 1440×900,
  1024×768 and 2200×1400, plus a full-page capture of the stacked layout
  and a scripted interaction pass over the DevTools protocol. Two visual
  defects found and fixed; details in the 2026-08-21 decision and log
  entries below.

- Should the tool offer a SHA-256d (double) mode? It would make the Bitcoin
  panel a real mining view rather than an analogy, and the machinery is
  already there. Deferred as scope; the caveat text covers the gap honestly
  in the meantime.

- Is a learning document (`.tex` → `shatool.pdf`, per CLAUDE.md rules A and B)
  wanted for this repo, as `256-shavar` has? Not started.

- The example mainnet nBits (`0x17034a3f`) is a plausible fixed constant, not
  a live value, and is labelled as an example. If the tool should ever track
  real difficulty it would need a data source, which would end the
  no-dependencies, opens-from-`file://` property.

## Log

### 2026-08-09

- Empty directory. `git init`, `NOTES.md`, `.gitignore`.
- Surveyed `../256-shavar` (then named `shavar`); vendored `js/shavar.js`.
  The commit pin lives in `js/vendor/README.md`.
- Built the model (`js/model.js`), the Bitcoin PoW reading (`js/pow.js`), the
  three UI modules, `index.html`, and `css/shatool.css`.
- Test suite: 76 checks, all green. Includes the Bitcoin genesis block header
  hashed end to end to its documented block hash — the byte-order story is
  checked against real published data, not only against my own reasoning
  about it.
- One bug found by the tests during the build, in the tests themselves: the
  bit-cell selector counted locked cells, which carry `data-bit` too.
- Added the 256-bit raster in proof-of-work order, so a difficulty
  requirement reads as a shape: the black block has to reach the marker.
- Added the K band, the chaining-value strip, range sampling, the greedy
  single-flip search, the hardest-difficulty readout, and change animation.
  133 checks.

**Three bugs the tests caught during that round**, all worth recording
because none would have been visible on screen as an error:

1. The sampling range collapsed permanently when the message was shrunk and
   regrown. Fixed by separating requested from clamped (see Decisions).
2. `ui-output.js` created a `note-display` element that existed only in JS.
   The id-consistency test flagged it; the fix moved three paragraphs of
   English out of the renderer and into `index.html`, which is where they
   belonged anyway.
3. Two ids in `index.html` (`panel-input`, `panel-output`) were referenced by
   nothing at all. Found by a new test asserting every id is used by either
   JS or CSS — the reverse direction of the check that already existed.

Also learned, and worth knowing before writing more animation: the canvas
afterglow's decay frames share the `requestAnimationFrame` queue with the
sampling loop, so "pump N frames" is not "run N rounds of sampling". Two
tests initially asserted the latter and were wrong, not the code.

### 2026-08-21

- First visual verification (see Decisions). Screenshots at three sizes,
  full-page capture of the stacked layout, scripted bit-toggle and
  explosion checks over the DevTools protocol. Two CSS fixes: the stacked
  layout no longer overlaps itself below 1100px, and the byte-role key no
  longer wraps mid-range. 213 checks still green.
- Observed, deliberately left alone: when several leading bits clear at
  once (0 → 5 in the staged test), the five simultaneous bursts overlap
  into one bright flash that spills past the raster's top-left edge for
  half a second. The spill is the documented design — the raster does not
  clip so rings and sparks can overshoot — and the common case in a real
  search is one bit at a time, which reads exactly as intended. Worth
  revisiting only if multi-bit jumps turn out to be common.
- Not exercised, honestly: the hover tooltip, dragging the value-circle
  pane, and how a live sampling run *moves* — only static frames were
  captured, so the afterglow and the button pulse are still unverified as
  motion.
