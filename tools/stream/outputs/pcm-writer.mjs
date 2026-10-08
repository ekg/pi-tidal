// Shared backpressure policy for ffmpeg-backed outputs (icecast, hls).
//
// Both outputs pipe raw s16le PCM into ffmpeg's stdin. If the encoder or the
// downstream sink (a network socket, a slow disk) stalls, node buffers the
// un-consumed writes in memory. Left unbounded that turns into growing
// latency: the audio drifts further and further behind real time. Same
// philosophy as ws-pcm's drop-oldest queue — when the buffered bytes exceed
// the threshold we DROP the frame instead of queueing it. A dropped frame is
// lost audio; it is never latency.
//
// `stdin` is any Writable-like object (a child process stdin, or a fake in
// tests) exposing `.writable`, `.writableLength` and `.write(chunk)`.

export function writePcmFrame(stdin, pcm, maxBufferedBytes) {
  if (!stdin || !stdin.writable) return { written: 0, dropped: false, needsDrain: false };
  if (stdin.writableLength > maxBufferedBytes) return { written: 0, dropped: true, needsDrain: false };
  const ok = stdin.write(pcm);
  return { written: pcm.length, dropped: false, needsDrain: !ok };
}
