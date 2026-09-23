# Tidal gotchas we keep re-learning

Five traps have cost real time across sessions. Each one produces a confusing
type error or, worse, a silent musical failure. All verified on this machine
(Tidal 1.10.1, SuperDirt, GHCi REPL).

## 1. Transforms vs controls: the `$` / `#` split

**Controls** take a value and attach to an event — used after `#`:
`gain`, `lpf`, `hpf`, `speed`, `crush`, `shape`, `room`, `size`, `pan`,
`vowel`, `resonance`, `tremolorate`, `tremolodepth`, `begin`, `end`,
`sustain`, `legato`, `delay`, `delaytime`, `delayfeedback`, `note`, `n`, `s`.

**Transforms** take a pattern and return a pattern — they must appear
*before* `$`, never after `#`:
`stut`, `struct`, `loopAt`, `chop`, `striate`, `every`, `sometimes`,
`sometimesBy`, `someCyclesBy`, `whenmod`, `fast`, `slow`, `ply`, `rev`,
`palindrome`, `trunc`, `linger`, `hurry`, `jux`, `superimpose`, `rot`,
`swingBy`, `echo`, `iter`, `mask`, `spread`.

```haskell
-- WRONG  (type error: "applied to too few arguments")
d1 $ s "bd" # struct "t(3,8)" # gain 0.9
d1 $ s "lpmr" # n 0 # loopAt 2 # gain 0.9

-- RIGHT
d1 $ struct "t(3,8)" $ s "bd" # gain 0.9
d1 $ loopAt 2 $ s "lpmr" # n 0 # gain 0.9
```

Rule of thumb: if the function's first argument is a *number/string value*
it is a control; if its first argument is *another pattern* it is a transform.

## 2. Negative literals need parentheses

`range -2 2 sine` parses as `range - (2 2 sine)`. Write `range (-2) 2 sine`.
Same for `speed (-1)` (which is also how you play a sample in reverse).

## 3. Pitch: numbers are +60, names are true pitch

See `tidal-pitch-convention.md` for the full derivation. Short version:

- Names use the SuperCollider octave convention: **middle C is written `c5`**
  (written octave == `midi // 12`). Names sound at true pitch.
- Raw **numbers** land five octaves high: number `n` sounds as MIDI `n + 60`.
  Writing a literal MIDI note (e.g. `note "60"`) is the classic screech bug.
- `midinote "60"` is the escape hatch that accepts true MIDI numbers.

## 4. `n` vs `note` for samples vs synths

- On a **sampler** (`s "breaks125"`), `n` selects *which file* in the set.
  Use `note` for pitch (semitones relative to the sample's recorded pitch).
- On a **synth** (`s "superpiano"`), `note`/`n` both set pitch.
- Poly-rhythmic sample *picking*: `# n "t(<3 5 9>,16,<0 1 2>)"` makes the
  choice of file itself a euclid pattern — cheap timbral weirdness.

## 5. Streams above d16, and IO vs pattern context

`d1`..`d16` are aliases. Beyond that use the generic `p` with the id, and
**the space matters**:

```haskell
p 17 $ s "hh" ...     -- right
p17  $ s "hh" ...     -- "Variable not in scope: p17"
```

Also `xfadeIn`, `hush`, `d1` etc. are **IO actions** — they sit at the top of
an eval, not inside a `#` chain.

## 6. Mininotation euclid beats `struct`

`s "bd(3,8)"` is enough; `struct "t(3,8)"` is only needed when combining with
other structure. Rotations ride along: `s "bd(3,8,2)"`, and
`s "bd(3,8,<0 1 2 3>)"` walks the rotation cycle by cycle.

## 7. Strings in evals: keep patterns on one line

A raw newline inside a Tidal string literal is a GHCi lexical error, and JSON
transport layers turn `\n` into a real newline. Always emit single-line
patterns (that is why the corpus converters collapse whitespace).

## 8. `split turn` / eval granularity

A multi-statement eval is not transactional in a useful way: if any line
fails to typecheck, the *whole* chunk is rejected and the previous patterns
keep playing — so a broken eval can silently leave a section "missing" (this
is how the loops stayed faded out after a tape-stop). When a chunk errors,
assume nothing in it applied.
