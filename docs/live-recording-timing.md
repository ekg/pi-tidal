# Recording a live take: timing, and the sleep anti-pattern

This is about *process*, not sound. It exists because the natural instinct —
"lay out the arrangement, then wait for it to develop" — is wrong here, and it
wastes the performance.

## The mistake

An agent building a take tends to do this:

```
tidal_record start
eval  melody only
sleep 45                      # "let it breathe"
eval  add pad
sleep 45
eval  add kick+bass
sleep 45
...
```

Two things go wrong:

1. **The write time is missing from the plan.** Evaluating a pattern, seeing a
   `[tidal]` error and fixing it takes real seconds-to-minutes — that time is
   already part of the take. Adding explicit sleeps on top of it means the
   musical events land much later than the plan assumed, and the take either
   overruns or the sections sag.
2. **Idle time is dead air.** While the agent sleeps, nothing changes. A
   listener hears a static loop; the interesting part of live coding (something
   arriving, something dropping) is elsewhere.

## The rule

**Never sleep or poll between musical moves.** Interleave writing and playing:

```
tidal_record start        →  mark "melody alone"
eval   melody              (music is now audible; the clock is running)
eval   pad in              →  mark "pad in"
eval   kick + bass         →  mark "kick"
eval   claps, perc         →  mark "drive"
eval   breakdown           →  mark "breakdown"
...
```

Each write *is* the time passing. The music develops at the rate you can
improvise, which is exactly the rate a live coder works.

If the take needs to be **longer**, add *musical* development — another layer, a
variation (`every 4`, `sometimesBy`, a filter ride), a section — not idle waits.

If a moment genuinely needs to develop on its own, **let the pattern do it**:
`slow`, `every 8`, a gain ramp, an `iter`/`striate` that evolves. Then keep
writing the next thing while it happens. Waiting is almost never the right tool.

## Recording mechanics

- `tidal_record start` / `stop` run in the background — start it and keep
  working; don't stop to "watch" it.
- `tidal_mark` is cheap: stamp every transition. Markers carry `rel` (seconds
  into the take), the eval label and git HEAD, so the audio is auditable
  afterwards.
- The marker file gives **true elapsed time**. Read it instead of assuming how
  long you've been playing.
- Budget a take by **actions, not sleeps**: a ~4-minute take is roughly 8-12
  transitions, each of which takes the time it takes to write + fix that
  pattern. If your writes are fast, the take is fast.

## What this is not

It is not "rush". It's the opposite: because you never idle, every second of the
recording corresponds to a real decision. Rushing happens when a plan has
sleeps in it and the agent wakes up behind schedule; interleaving keeps the
music and the writing on the same clock.
