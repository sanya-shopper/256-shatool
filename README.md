# shatool

A static web UI for watching SHA-256 work. Open `index.html` in a browser —
no server, no build step, no dependencies.

```sh
open index.html          # macOS
bash tests/run.sh        # 213 checks
```

Three columns, left to right, following the data:

| | |
| --- | --- |
| **Input** | the message in hex, every bit individually toggleable, what the padding turns it into, and two searches over it |
| **Computation** | one block's compression drawn as bit rasters — the constants `K`, the schedule `W`, and the two tracks `A` and `E` — one column per round, with the chaining value below |
| **Output** | the digest, coloured by the part each byte plays in Bitcoin's proof-of-work difficulty check, and the hardest difficulty it would have cleared |

It starts on a random **513-bit** message. That length is awkward in three
useful ways at once: it is not a multiple of 8, so the final byte carries one
significant bit and seven that must be zero; it is one bit too long to fit its
own padding in a single block, so the message occupies two; and block 1 is
therefore compressed against a computed chaining value rather than the
standard IV. Most of the edge cases are visible on load.

## The middle panel

SHA-256's compression function is usually written as eight registers `a…h`
shuffling each round. This tool draws the formulation used by the sibling
[`shavar`](../256-shavar) project, in which six of those eight assignments are
recognised as pure copies and removed, leaving two coupled recurrences with a
lookback of four:

```
T1[t] = E[t-4] ⊞ Σ1(E[t-1]) ⊞ Ch(E[t-1],E[t-2],E[t-3]) ⊞ K[t] ⊞ W[t]
T2[t] = Σ0(A[t-1]) ⊞ Maj(A[t-1],A[t-2],A[t-3])
E[t]  = A[t-4] ⊞ T1[t]
A[t]  = T1[t] ⊞ T2[t]
```

So there are two tracks to draw, not eight registers, and the picture is their
history. Time runs left to right; a column is one round. Click a column to
break that round out into its terms; hover any cell for its word and bit.

**The visual grammar is fixed.** Hue says which track a cell belongs to —
green `K`, amber `W`, cyan `A`, violet `E`. Brightness says whether the bit is
1 or 0. Panel-background means "not computed", which happens past the round
limit. The four columns left of the dashed rule are the seed window, taken
from the incoming chaining value rather than produced by any round.

`K` never varies — it is the same 64 constants for every message and every
block. It is drawn anyway, because seeing it makes a point the algebra
buries: half of what feeds `T1` each round is fixed, and in diff mode the `K`
band stays completely dark while everything below it lights up.

**The chaining value** is shown as a strip under the canvas, tinted with the
`A` and `E` hues because those eight words *are* the seed columns of those
two tracks — `H[0]` seeds `A[-1]`, down to `H[3]` seeding `A[-4]`, and
likewise `H[4..7]` into `E`. The seeding runs in reverse, which is the classic
place to get SHA-256 wrong, so each word says which column it became.

**Cells flash when their bit changes** and fade back over a few frames. That
is what makes an edit legible as propagation rather than as a new picture:
toggle one input bit and a handful of cells light in `W`, then a widening
wedge through `A` and `E`. Respects `prefers-reduced-motion`, and there is an
Animate checkbox.

**Diff mode** switches the grammar wholesale, and the legend switches with it:
pin a reference message, then toggle an input bit, and a lit cell now means
"this bit differs from the reference". That is the avalanche, round by round —
it is what the clickable input bits are for.

**Reduced rounds.** The round limit can be lowered to watch the state before
diffusion completes. This is not SHA-256 and the tool does not pretend
otherwise; it is there because reduced-round variants are what cryptanalysis
actually studies.

## Searching the input

Two buttons on the left, both of which change the message and let the rest of
the page react.

**Sample** resamples one contiguous bit range — you type the start and end,
inclusive — holding every other bit fixed, and stops when the digest shows
enough leading zeros in proof-of-work order, or when you pause it. The range
is outlined in the bit grid so you can see which part of the message is
churning and which is being held. It draws a batch per animation frame and
redraws after each, so every frame on screen is a point that was really
sampled.

That is mining, with two honest differences: a miner varies a 32-bit nonce in
an 80-byte header and hashes it twice. The *shape* is the same, and the shape
is the lesson — the target is cleared by luck alone, the expected cost doubles
for every extra zero bit demanded, and nothing about the input can be steered
toward it. The panel shows the attempt count next to the expected count for
exactly that reason: one number alone cannot tell you whether a run is lucky,
unlucky, or simply unfinished.

**Best single flip** and **Best pair flip** try every one-bit and every
two-bit change respectively, keeping whichever lowers the digest value most.
Each reports how far the value moved and whether anything lowered it at all —
on an already-small digest nothing may, and it says so rather than implying
progress.

Since the baseline is the same for every candidate, the change with the
largest drop is simply the one producing the smallest digest; no 256-bit
differences are needed to find it, only to report its size.

The pair scan is 131,328 hashes for the default message, so it runs across
animation frames with a progress bar rather than freezing the page. Note that
pairs are **not** a superset of singles — the pair scan never tries a one-bit
change — so its winner can be worse than the single-flip winner.

Contrast either with Sample: a hundred thousand targeted hashes buy you one
greedy step, and it is nowhere near enough. All three buttons are pointed at
the same wall.

## The output panel, and one fact worth the trouble

SHA-256 emits 32 bytes. Bitcoin's difficulty check reads them as a
**little-endian** 256-bit integer:

```
value = SUM over i of digest[i] * 256^i        accept iff value <= target
```

So the byte that dominates the comparison is `digest[31]` — the *last* one
SHA-256 produces — and `digest[0]` is the least significant of all. The
conventional block-hash string is the digest written backwards, which is the
only reason its zeros appear at the front. Nothing about SHA-256 favours zeros
at either end.

The panel colours each byte by its role, with the boundaries derived from the
decoded `nBits` rather than hardcoded, so changing the difficulty moves them:

- **must be zero** — the target has no value at this weight at all
- **coefficient** — compared against the three `nBits` coefficient bytes
- **tail** — below the target's precision; only ever breaks an exact tie

Below that, all 256 bits are drawn in significance order — 32 per row, most
significant first, so PoW bit 0 is the top bit of `digest[31]`. The run the
target requires to be zero is painted near-black and terminated by a marker,
which turns the difficulty check into a shape question: **does the black reach
the marker?** A set bit inside that run is red, since a 1 there fails outright.

Note the requirement is bit-granular, not byte-granular. For the mainnet
example it is 78 bits — nine whole zero bytes plus six bits into byte 22,
because the coefficient's top byte is `0x03` — so the marker lands mid-row.

**Hardest difficulty cleared**, at the bottom, turns the question around.
Instead of "does this clear the difficulty you picked", it asks what the
smallest target is that this digest still satisfies — which, since the check
is `value <= target`, is the digest's own value. Reported in Bitcoin's usual
units where 1 is the genesis block, so a random digest lands far below 1, and
watching this number climb is what a sampling run is actually doing. The
`nBits` it quotes rounds *up*: truncating into the three-byte compact form
would name a target the digest does not in fact satisfy.

### What this is not

Bitcoin hashes an 80-byte block header with SHA-256 applied **twice**. shatool
applies it once to an arbitrary message, so the digest on screen is not a
block hash and the verdict is not a claim about mining. What is exactly true
is what is shown: given any 32 bytes presented to the difficulty check, this
is the weight each byte carries and this is how the comparison comes out. The
UI says so too, and a test asserts that it still does.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | the whole page; no inline script or style, enforced by a test |
| `css/shatool.css` | presentation only — the palette lives at the top |
| `js/model.js` | message state, padding, traces. No DOM access |
| `js/pow.js` | the Bitcoin reading of a digest. No DOM access |
| `js/search.js` | sampling and both flip scans. No DOM access |
| `js/ui-input.js` `js/ui-canvas.js` `js/ui-output.js` | the three panels |
| `js/ui-circle.js` | the value circle: a floating pane, off until its checkbox is set |
| `js/app.js` | the only file that mutates state |
| `js/vendor/shavar.js` | SHA-256, copied verbatim from `../256-shavar` |
| `tests/run.js` | the suite |
| `tests/domstub.js` | just enough DOM to boot the app in Node |
| `NOTES.md` | decisions, and what is still open |

The model and PoW layers are DOM-free by construction, which is what lets the
test suite exercise all of their behaviour headlessly. The UI layer sets class
names and custom properties and lets CSS decide what things look like.

## Correctness

`bash tests/run.sh` — 213 checks, no dependencies.

- The vendored SHA-256 is pinned by checksum and runs its own known-answer
  vectors, so a silent re-sync from `../256-shavar` fails here.
- The digest shown is assembled from the same traces the canvas draws, and a
  test asserts it agrees with an independent hash across a range of lengths —
  including 0, 1, and both sides of every block boundary.
- Each round's displayed terms are checked against the recurrence itself:
  `T1`, `T2`, `A[t]` and `E[t]` are recomputed from the trace for all 64
  rounds and must match.
- **The byte-order story is checked against the real Bitcoin genesis block.**
  Its 80-byte header is hashed to its documented block hash, and the raw
  digest is confirmed to *end* in the five zero bytes that the conventional
  display shows at the front.
- The app is booted against the real `index.html` on a minimal DOM and driven
  through every control, including a sampling run pumped frame by frame.
- Both flip scans are checked against independent exhaustive searches, the
  pair scan's answer is checked to be independent of its step budget, and the
  compact-`nBits` encoder against randomised values: its target must never
  fall below the value it was encoded from.
- Consistency both ways: every id the JS looks up exists in the markup, and
  every id in the markup is used by JS or CSS.

### Known gap

Nothing has verified how any of this **looks**. No browser automation was
available when it was built, so the tests cover behaviour and arithmetic and
say nothing about layout, proportions, or legibility. See `NOTES.md`.

## Licence

Not yet chosen. Treat as all-rights-reserved until one is added. The vendored
`js/vendor/shavar.js` carries whatever terms `../256-shavar` does.
