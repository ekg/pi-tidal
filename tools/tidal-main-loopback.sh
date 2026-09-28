#!/usr/bin/env bash
set -euo pipefail
# Virtual PipeWire sink for SuperCollider's JACK outputs. Its playback stream
# has NO explicit target; WirePlumber follows Ubuntu's configured default sink
# when selected from Settings / wpctl set-default. The low priority prevents
# Tidal Main itself from becoming the automatic physical output.
exec /usr/bin/pw-loopback --name tidal-main --channels 2 \
  --capture-props '{"node.name":"tidal_main","node.description":"Tidal Main (virtual)","media.class":"Audio/Sink","audio.position":["FL","FR"],"priority.session":1}' \
  --playback-props '{"node.name":"tidal_main_playback","node.description":"Tidal Main to Default Output","media.class":"Stream/Output/Audio","audio.position":["FL","FR"],"node.passive":true,"stream.dont-remix":true}'
