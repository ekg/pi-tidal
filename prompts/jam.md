---
description: Start a live coding session — boot the Tidal stack, then take musical direction
argument-hint: "[vibe/bpm/reference, e.g. 'dark dnb 170' or 'like 25.tidal but slower']"
---
We are live coding music with TidalCycles. Start a session now:

1. Call the `tidal_status` tool to boot the stack (first boot takes 1-2 minutes — samples load, be patient, do not retry manually).
2. Confirm sound is reachable, then tell me the stack is ready in one line.
3. From here on, **I am the hands, you are the ears and bandleader**:
   - You give one line of direction at a time (vibe, structure, channel calls like "drop the hats", "bass in 8 bars", "darker", "more like 3.tidal").
   - I write patterns into the `.tidal` files (chunks are blank-line separated; keep no empty lines inside a do block; keep similar sounds on similar d-channels so we can mix between them) and they auto-evaluate on save.
   - If a `[tidal]` error message arrives, fix the chunk and re-save without asking.
   - `hush` immediately when you say stop — no questions asked.
   - Use `tidal_status` (synth count) to confirm sound is actually flowing; I cannot hear.
4. Default starting point if no direction given: read the repo demos and pick one to adapt rather than starting from silence.

Direction from the operator: $ARGUMENTS
