# shatool

A static web UI for watching SHA-256 work. Open `index.html` in a browser —
no server, no build step, no dependencies.

```sh
open index.html          # macOS
bash tests/run.sh        # 76 checks
```

Three columns, left to right, following the data:

| | |
| --- | --- |
| **Input** | the message in hex, every bit individually toggleable, plus what the padding turns it into |
| **Computation** | one block's compression drawn as a bit raster: the schedule `W` and the two tracks `A` and `E`, one column per round |
| **Output** | the digest, coloured by the part each byte plays in Bitcoin's proof-of-work difficulty check |

It starts on a random **513-bit** message. That length is awkward in three
useful ways at once: it is not a multiple of 8, so the final byte carries one
significant bit and seven that must be zero; it is one bit too long to fit its
own padding in a single block, so the message occupies two; and block 1 is
therefore compressed against a computed chaining value rather than the
standard IV. Most of the edge cases are visible on load.

## The middle panel

SHA-256's compression function is usually written as eight registers `a…h`
shuffling each round. This tool draws the formulation used by the sibling
[`shavar`](../shavar) project, in which six of those eight assignments are
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
amber `W`, cyan `A`, violet `E`. Brightness says whether the bit is 1 or 0.
Panel-background means "not computed", which happens past the round limit.
The four columns left of the dashed rule are the seed window, taken from the
incoming chaining value rather than produced by any round.

**Diff mode** switches the grammar wholesale, and the legend switches with it:
pin a reference message, then toggle an input bit, and a lit cell now means
"this bit differs from the reference". That is the avalanche, round by round —
it is what the clickable input bits are for.

**Reduced rounds.** The round limit can be lowered to watch the state before
diffusion completes. This is not SHA-256 and the tool does not pretend
otherwise; it is there because reduced-round variants are what cryptanalysis
actually studies.

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
| `js/ui-input.js` `js/ui-canvas.js` `js/ui-output.js` | the three panels |
| `js/app.js` | the only file that mutates state |
| `js/vendor/shavar.js` | SHA-256, copied verbatim from `../shavar` |
| `tests/run.js` | the suite |
| `tests/domstub.js` | just enough DOM to boot the app in Node |
| `NOTES.md` | decisions, and what is still open |

The model and PoW layers are DOM-free by construction, which is what lets the
test suite exercise all of their behaviour headlessly. The UI layer sets class
names and custom properties and lets CSS decide what things look like.

## Correctness

`bash tests/run.sh` — 76 checks, no dependencies.

- The vendored SHA-256 is pinned by checksum and runs its own known-answer
  vectors, so a silent re-sync from `../shavar` fails here.
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
  through every control.

### Known gap

Nothing has verified how any of this **looks**. No browser automation was
available when it was built, so the tests cover behaviour and arithmetic and
say nothing about layout, proportions, or legibility. See `NOTES.md`.

## Licence

Not yet chosen. Treat as all-rights-reserved until one is added. The vendored
`js/vendor/shavar.js` carries whatever terms `../shavar` does.
