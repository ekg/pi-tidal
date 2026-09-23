# How Tidal/SuperDirt actually interpret pitch

**Status: solved, verified by source reading + measurement. 2026-09-23.**

For months every jam came out either screeching or growling. It was not taste and
not the corpus — it was a double octave convention in the pitch path, and we were
feeding it the wrong kind of number.

## The mechanism, in two code paths

**Tidal** — `tidal-core-1.10.1/src/Sound/Tidal/ParseBP.hs:660`

```haskell
parseNote :: (Num a) => MyParser a
parseNote = do
  n <- notenum                  -- c=0 d=2 e=4 f=5 g=7 a=9 b=11
  modifiers <- many noteModifier -- s=+1, f=-1, n=0
  octave <- option 5 natural
  let n' = foldr (+) n modifiers
  return $ fromIntegral $ n' + ((octave - 5) * 12)
```

Octave **5** is the zero point, so `c5` parses to `0`, `c4` to `-12`, `c6` to `+12`.

**SuperDirt** — `SuperDirt/classes/DirtOrbit.sc:184`

```supercollider
~octave = 5;
~midinote = #{ ~note ? ~n + (~octave * 12) };
~freq = #{ ~midinote.value.midicps };
```

Every event gets **+60** added, then `midicps`. Net result:

| written in Tidal       | Tidal value | SuperDirt midinote | sounding pitch |
|------------------------|-------------|--------------------|----------------|
| name `c5`              | 0           | 60                 | **middle C** (261.6 Hz) |
| name `c4`              | −12         | 48                 | C3 (130.8 Hz)  |
| name `c1`              | −48         | 12                 | C0 (16.4 Hz — subsonic growl) |
| number `0`             | 0           | 60                 | **middle C**   |
| number `12`            | 12          | 72                 | C5             |
| number `60` (a "MIDI note"!) | 60    | 120                | C9 ≈ 8372 Hz — **the screech** |

**So:**
- Note **names** use the SuperCollider convention — **middle C is written `c5`**, i.e.
  written octave == `midi // 12`. Names sound at true pitch.
- Raw **numbers** live in a "middle C = 0" space — number `n` sounds as MIDI `n + 60`.
  Writing a literal MIDI note number is therefore **five octaves high**.
- Tidal also ships `midinote` (`Params.hs:168`, `midinote = note . (subtract 60 <$>)`),
  which accepts **true MIDI numbers**: `midinote "60"` = middle C. This is the
  escape hatch if you want to think in MIDI.

## Measurement that confirmed it

Two single-note recordings through the clean `s.record` tap, FFT peak:

| eval | measured fundamental | expected |
|------|----------------------|----------|
| `note "c5"` | 252 Hz | middle C 261.6 (MdaPiano detune explains 252) |
| `note "0"`  | 252 Hz | middle C 261.6 |
| `note "60"` | strong cluster 7665–7975 Hz | MIDI 120 ≈ 8372 Hz |

The "insanely high frequency" complaint was literally the note an octave-spanning
five octaves above the write site. The "growling bass, once a bar" was a source
bass part written at names octave 1 (`g1` → midinote 19 ≈ 24 Hz).

## What went wrong in the toolchain

1. **Converters emitted bare MIDI numbers** (`midi_to_tidal.py`, `gp_to_tidal.py`):
   MIDI 60 came out as `60` → sounded MIDI 120 → screech. This wrecked every
   melody pulled from the corpus, and generated the phantom "creepy high melody"
   artifacts that were previously misdiagnosed as bitcrush aliasing.
2. **When names were emitted, they used standard scientific octaves**
   (MIDI 60 → `c4`) → sounded one octave **low** → growls on bass parts and a
   permanent "everything is too low / muddy" feel.

## Rules going forward

- **Synth pitch: always note names.** `c5` = middle C, `c4` = the C below it.
- Never write a raw MIDI number as a pitch. If you must, use `midinote "60"`.
- `n` is for **sample index** on samplers; keep it away from synth pitch.
- Register bands (written names — sounding):
  - bass: `c2:c4` (MIDI 24–48)
  - lead / melody: `c4:c6` (MIDI 48–72; voice-leading around `c5`)
  - pads / chords: `c4:g5`
  - sparkle / horns: `c5:c7` (any higher and MdaPiano's partials turn to screech)

## Tooling changes made

- `tunepile/tools/midi_to_tidal.py` — `_pitch_name()` now uses `midi // 12`
  (SC/Tidal convention); both emission paths (`cells_to_mininotation`,
  `cells_to_varied_pattern`) emit names. `gp_to_tidal.py` shares the same
  renderer, so it is fixed too.
- `tunepile/tools/retune.py` — parses and emits names in the same convention;
  octave-shifts a whole pattern (median-based, shape preserving) into a
  `--band c4:c6` style window before it is played.
- Corpus re-conversion is required after this change (`tabs-tidal/`).

## Verification recipe (repeat any time you doubt the mapping)

```bash
# 1. play one note
#    d10 $ s "superpiano" # note "c5" # gain 0.9 # legato 3
# 2. record the clean tap for ~3 s, stop
# 3. measure the fundamental
ffmpeg -i jam-*.flac -f s16le -ac 1 -ar 44100 /tmp/x.pcm
# then a coarse DFT / peak pick; middle C = 261.6 Hz
```

## Possible plugin guard (not implemented)

`pi-tidal` could lint eval text and warn when a numeric pitch appears in
`n`/`note` (e.g. `note "60"`, `n "[48,52,55]"`), suggesting names or `midinote`.
That single warning would have saved this entire detour.
