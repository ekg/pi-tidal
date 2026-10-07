// tidal.ts — pi extension for livecoding TidalCycles
//
// - Lazily ensures the SuperDirt stack is up (sclang + scsynth via pipewire's
//   libjack) and a Tidal REPL (ghci + BootTidal.hs) is running.
// - Auto-evaluates changed chunks of *.tidal files after pi write/edit calls
//   (chunks = blank-line separated blocks, per the repo README convention).
// - Feeds REPL errors back into the agent context as user messages.
// - Tools: tidal_eval, tidal_hush, tidal_state, tidal_status. Command: /tidal.

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as dgram from "node:dgram";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PW_JACK = "/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)); // .../pi-tidal/
const STREAM_CTL = path.join(PACKAGE_DIR, "tools/stream/stream-ctl");
const AUDITION_CTL = path.join(PACKAGE_DIR, "tools/audition/audition-ctl");
const SCSYNTH_PORT = 57110;
const SUPERDIRT_PORT = 57120;
const DEBUG = !!process.env.TIDAL_EXT_DEBUG;
function dbg(...args: unknown[]) { if (DEBUG) console.error("[tidal-ext]", ...args); }

// Run a control CLI and keep its exit status: the audition `report` verb uses
// exit 3 for "still running", so a non-zero exit is data, not necessarily a throw.
function runCtl(bin: string, args: string[]): { stdout: string; stderr: string; code: number } {
	const res = cp.spawnSync(bin, args, { encoding: "utf8", timeout: 330_000, maxBuffer: 8 * 1024 * 1024 });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? (res.error ? 127 : 1) };
}

// Pi/Jiti reloads this entry point but can retain native helper exports. Load
// the tiny bootstrap through Node itself; it uses content-addressed native ESM
// imports. Jiti import() strips query strings; Function(import) lacks a VM callback.
export const importFreshModule = createRequire(import.meta.url)(
	path.join(PACKAGE_DIR, "lib/fresh-import.cjs")
).importFreshModule as (filename: string) => Promise<any>;

export default async function (pi: ExtensionAPI) {
	const { createSclangTransport } = await importFreshModule(path.join(PACKAGE_DIR, "lib/sclang-command.mjs"));
	const { stopOwnedProcessTree } = await importFreshModule(path.join(PACKAGE_DIR, "lib/process-tree.mjs"));
	const { createLifecycleQueue } = await importFreshModule(path.join(PACKAGE_DIR, "lib/lifecycle.mjs"));
	const { formatScStatus } = await importFreshModule(path.join(PACKAGE_DIR, "lib/sc-status.mjs"));
	const { cleanReplError } = await importFreshModule(path.join(PACKAGE_DIR, "lib/repl-error.mjs"));
	const { planOutputLinks } = await importFreshModule(path.join(PACKAGE_DIR, "lib/output-routing.mjs"));
	const { buildStreamArgs, parseStreamStatus, parseStreamUrl } = await importFreshModule(path.join(PACKAGE_DIR, "lib/stream-tools.mjs"));
	const { buildAuditionArgs, parseAuditionSubmitId, parseAuditionReport, parseAuditionJobs, parseAuditionStatus, parseSpectrumReport, parseOrbitScanReport, buildLiveReport, liveSnapshotPath, isAuditionStillRunning } = await importFreshModule(path.join(PACKAGE_DIR, "lib/audition-tools.mjs"));
	const { createBootSignals, inspectBootLog, BOOT_TIMEOUT_MS, REPL_TIMEOUT_MS, ENSURE_TIMEOUT_MS, isStackReady } = await importFreshModule(path.join(PACKAGE_DIR, "lib/boot-readiness.mjs"));
	const { createSceneRegistry, isSceneFile, extractSc, deckIndex, deckSlot, patternExpression, sceneCommands, stopCommands } = await importFreshModule(path.join(PACKAGE_DIR, "lib/scenes.mjs"));
	const { resolveSceneMixerConfig, DEFAULT_SCENE_MIXER } = await importFreshModule(path.join(PACKAGE_DIR, "lib/scene-mixer-config.mjs"));
	const { tidalStatements } = await importFreshModule(path.join(PACKAGE_DIR, "lib/tidal-chunks.mjs"));
	const { replCommand } = await importFreshModule(path.join(PACKAGE_DIR, "lib/repl-command.mjs"));
	const { tempoRideSteps } = await importFreshModule(path.join(PACKAGE_DIR, "lib/tempo-ride.mjs"));
	const sceneMixer = (() => {
		try { return resolveSceneMixerConfig(); }
		catch (error) {
			console.warn(`[pi-tidal] scene mixer config ignored: ${error instanceof Error ? error.message : error}; using ${DEFAULT_SCENE_MIXER.channelCount} x ${DEFAULT_SCENE_MIXER.orbitsPerChannel}`);
			return { ...DEFAULT_SCENE_MIXER, source: 'default' };
		}
	})();
	const scenes = createSceneRegistry({
		channelCount: sceneMixer.channelCount,
		orbitsPerChannel: sceneMixer.orbitsPerChannel,
	});
	dbg(`scene mixer ${scenes.channelCount} x ${scenes.orbitsPerChannel} orbits (from ${sceneMixer.source})`);
	if (scenes.channelCount > 6) console.warn(`[pi-tidal] WARNING: ${scenes.channelCount} scene channels claim ${scenes.channelCount * scenes.orbitsPerChannel} orbits; each orbit adds global FX instances and CPU. Match project startup before use.`);
	const sceneQueue = createLifecycleQueue();
	const queryQueue = createLifecycleQueue();
	const bootSignals = createBootSignals();

	// Opt-in stream link config. stream-ctl reads the same file; missing/unreadable
	// is the normal "gate off" case, never fatal.
	function readStreamLinkConfig(): { link?: boolean } {
		try {
			const dir = process.env.PI_TIDAL_STREAM_CONFIG_DIR || path.join(process.env.HOME || "", ".config/tidal-stream");
			const file = process.env.PI_TIDAL_STREAM_CONFIG || path.join(dir, "config.json");
			return JSON.parse(fs.readFileSync(file, "utf8"));
		} catch { return {}; }
	}
	let bootLogBefore = 0;
	let bootStage = "idle";
	let scOutputBuffer = "";
	let scRequestNumber = 0;
	// ---------- state ----------
	const lifecycle = createLifecycleQueue();
	let closing = false;
	let sclangProc: cp.ChildProcess | null = null;
	const scTransport = createSclangTransport((command: string) => {
		if (!sclangProc?.stdin?.writable) throw new Error("no writable sclang stdin");
		sclangProc.stdin.write(command);
	});
	let scBootError = "";                      // last failing boot stage, if any
	let currentCwd = process.cwd();            // for reading sc/boot.log from the probes
	let lastStateFile: string | null = null;   // last ":script foo.tidal" we loaded
	let replProc: cp.ChildProcess | null = null;
	let replReady = false;
	let weSpawnedSclang = false;
	let replBootedAt = 0;
	const snapshots = new Map<string, string[]>(); // .tidal path -> chunks
	const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const queuedChunks: string[] = []; // chunks waiting for REPL readiness
	let lastLabel = "—";
	let lastErrorExcerpt = "";
	let lastErrorAt = 0;
	let stderrLines: string[] = [];
	// sclang stdout, kept as the last SCLANG_TAIL_MAX lines plus a monotonic
	// counter (sclangSeq). NEVER index the ring by sclangTail.length: the buffer
	// shifts as it fills, so a mark taken at length N goes stale the moment new
	// lines arrive — every tidal_sc eval then returned "(no sclang output)"
	// while the buffer sat full of boot banner lines, hiding parse errors,
	// runtime errors AND replies (this made sclang look mute for a whole day).
	let sclangTail: string[] = [];
	let sclangSeq = 0;
	let lastChunks: string[] = []; // recent non-stream chunks (hush/setcps/do-blocks), re-fired after revival
	const streamChunks = new Map<string, string>(); // "d4" -> latest chunk for that stream (incl. silences)
	let bootSeq = 0;     // sclangSeq value where the current boot started
	const SCLANG_TAIL_MAX = 800;
	function sclangLinesSince(seq: number): string[] {
		const n = Math.min(sclangSeq - seq, sclangTail.length);
		return n <= 0 ? [] : sclangTail.slice(-n);
	}
	let replStdoutBuf = "";
	let watchdog: ReturnType<typeof setInterval> | null = null;

	// ---------- recording state ----------
	let recActive = false;
	let recVia: "sclang" | null = null;
	let recPath = "";
	let recStartedAt = 0;

	// ---------- OSC / scsynth ----------
	function pad(b: Buffer): Buffer {
		return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
	}

	function queryScsynth(timeoutMs = 1500): Promise<{ alive: boolean; synths: number; ugens: number }> {
		return new Promise((resolve) => {
			const sock = dgram.createSocket("udp4");
			let done = false;
			const finish = (r: { alive: boolean; synths: number; ugens: number }) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				try { sock.close(); } catch { /* already closed */ }
				resolve(r);
			};
			const timer = setTimeout(() => finish({ alive: false, synths: 0, ugens: 0 }), timeoutMs);
			sock.on("message", (data: Buffer) => {
				dbg("osc reply bytes:", data.length);
				try {
					const tagStart = data.indexOf(0x2c, 1);
					if (tagStart < 0) return finish({ alive: true, synths: 0, ugens: 0 });
					const tag = data.subarray(tagStart, tagStart + 12).toString().split("\0")[0];
					const body = data.subarray(tagStart + pad(Buffer.from(tag)).length);
					// /status.reply: ,iiiiiffdd -> [1, ugens, synths, groups, defs, ...]
					const ints: number[] = [];
					for (let i = 0; i + 4 <= Math.min(body.length, 20); i += 4) ints.push(body.readInt32BE(i));
					finish({ alive: true, synths: ints[2] ?? 0, ugens: ints[1] ?? 0 });
				} catch {
					finish({ alive: true, synths: 0, ugens: 0 });
				}
			});
			sock.on("error", (e: Error) => { dbg("osc sock error:", e.message); });
			const msg = pad(Buffer.from("/status\0"));
			sock.send(Buffer.concat([msg, pad(Buffer.from(",\0"))]), SCSYNTH_PORT, "127.0.0.1", (err) => {
				if (err) dbg("osc send failed:", err.message); else dbg("osc /status sent");
			});
		});
	}

	function udpPortListening(port: number): boolean {
		try {
			const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
			const lines = fs.readFileSync("/proc/net/udp", "utf-8").split("\n");
			return lines.some((l) => {
				const cols = l.trim().split(/\s+/);
				return cols.length > 1 && cols[1].split(":")[1] === hexPort;
			});
		} catch {
			return false;
		}
	}

	async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 2000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (closing) throw new Error("plugin is shutting down");
			if (await predicate()) { dbg("waitFor ok"); return true; }
			let scProc = "none";
			try {
				for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
					try {
						const cl = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
						if (cl.startsWith("scsynth") || cl.includes("/scsynth ")) scProc = cl.trim().slice(0, 80);
					} catch { /* vanished */ }
				}
			} catch { /* ignore */ }
			dbg("waitFor poll false, remaining", deadline - Date.now(), "port57110:", udpPortListening(SCSYNTH_PORT), "scsynthProc:", scProc);
			await new Promise((r) => setTimeout(r, everyMs));
		}
		return predicate();
	}

	// ---------- stack lifecycle ----------
	// Kill only what WE started: sclang, plus the scsynth it spawned as its child.
	// A blind `pkill -u $USER -x sclang` (the old behaviour) kills a stack the user
	// started and leaves the partner process orphaned — the source of the duplicate
	// sclang / port-held-by-a-dead-stack mess.
	let linkTimer: ReturnType<typeof setTimeout> | null = null;
	let replPokeTimer: ReturnType<typeof setInterval> | null = null;
	let replInitialPokeTimer: ReturnType<typeof setTimeout> | null = null;
	async function killOwnStack(): Promise<void> {
		if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
		if (replPokeTimer) { clearInterval(replPokeTimer); replPokeTimer = null; }
		if (replInitialPokeTimer) { clearTimeout(replInitialPokeTimer); replInitialPokeTimer = null; }
		weSpawnedSclang = false;
		for (const child of [replProc, sclangProc]) {
			if (!child?.pid || child.exitCode !== null || child.signalCode !== null) continue;
			await stopOwnedProcessTree(child.pid);
		}
		sclangProc = null;
		replProc = null;
		replReady = false;
		sceneController.resetTransport();
	}

	async function startSclang(): Promise<void> {
		await killOwnStack();
		scsynthCached = null;
		updateWidget("booting SC");
		if (closing) throw new Error("plugin is shutting down");
		// killOwnStack() has just signalled whatever tree we owned. Its UDP sockets
		// stay listed in /proc/net/udp until the processes actually exit, so an
		// immediate check here sees our OWN dying stack and refuses to reboot —
		// the "ports still occupied" dead end after every /tidal restart. Give the
		// ports a bounded moment to free before treating them as foreign.
		const portsFree = await waitFor(
			() => !udpPortListening(SCSYNTH_PORT) && !udpPortListening(SUPERDIRT_PORT),
			12_000,
			250,
		);
		if (!portsFree) {
			throw new Error("audio ports still occupied by an unowned stack; refusing a duplicate boot");
		}
		// On pipewire systems, scsynth links jackd2's libjack by default and
		// auto-spawns a jackd that fights pipewire for the ALSA device (SIGABRT).
		// Point it at pipewire's own libjack when that exists; otherwise assume
		// the system's default jack setup is correct.
		const env = { ...process.env };
		if (fs.existsSync(PW_JACK)) {
			env.LD_LIBRARY_PATH = PW_JACK + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
		}
		// systemd-inhibit blocks suspend while the stack runs — a suspend/resume
		// cycle kills scsynth's pipewire-jack client (clean exit(0)), which was
		// the recurring "Server exited with exit code 0" mystery.
		// Keep the explicit pw-jack launch recipe. The September silence was
		// a commented-out DSP return, not evidence that PipeWire links failed.
		const inhibit = fs.existsSync("/usr/bin/systemd-inhibit");
		const cmd = inhibit ? "systemd-inhibit" : "pw-jack";
		const args = inhibit
			? ["--what=sleep", "--mode=block", "--who=pi-tidal", "pw-jack", "sclang"]
			: ["sclang"];
		sclangProc = cp.spawn(cmd, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
		weSpawnedSclang = true;
		sclangTail = [];
		sclangSeq = 0;
		bootSeq = 0; // marker for this boot
		bootSignals.reset();
		scOutputBuffer = "";
		scBootError = "";
		bootStage = "SuperCollider startup / DSP self-test";
		const bootLog = path.join(currentCwd, "sc/boot.log");
		bootLogBefore = fs.existsSync(bootLog) ? fs.statSync(bootLog).mtimeMs : 0;
		// scsynth does not auto-connect its jack ports under pw-jack. Prefer
		// the Tidal Main virtual sink, whose PipeWire playback stream follows
		// Ubuntu's selected output. Fall back to XREAL/default if unavailable.
		// Connect one stereo pair, never the first arbitrary physical sink.
		const linkOwner = sclangProc;
		linkTimer = setTimeout(() => {
			linkTimer = null;
			if (sclangProc !== linkOwner) return;
			try {
				const ports = cp.execFileSync("pw-link", ["-i"], { encoding: "utf8" });
				let defaultSink = "";
				try { defaultSink = cp.execFileSync("wpctl", ["inspect", "@DEFAULT_AUDIO_SINK@"], { encoding: "utf8" }); }
				catch { /* no wpctl/default; fall back to the first complete pair */ }
				const plan = planOutputLinks({ pwLinkInputs: ports, defaultSink, config: readStreamLinkConfig(), env: process.env });
				if (plan.physical) {
					for (const [i, channel] of [[1, "FL"], [2, "FR"]] as const) {
						try { cp.execFileSync("pw-link", [`SuperCollider:out_${i}`, plan.physical[channel]], { stdio: "ignore" }); }
						catch { /* already linked */ }
					}
				}
				// Opt-in (default off): ALSO link scsynth's outs to the tidal_stream sink,
				// additive on top of the physical link above. Never removes a link, never
				// targets a capture port (selectStreamLinkPorts only matches playback_FL/FR),
				// and does nothing when the sink node is absent. Gate: config link:true or
				// PI_TIDAL_STREAM_LINK=1; with the gate off plan.stream is null and this
				// block does not run.
				if (plan.stream) {
					for (const [i, channel] of [[1, "FL"], [2, "FR"]] as const) {
						try { cp.execFileSync("pw-link", [`SuperCollider:out_${i}`, plan.stream[channel]], { stdio: "ignore" }); }
						catch { /* already linked */ }
					}
				}
			} catch (error) { dbg("jack link:", error); }
		}, 20_000);
		sclangProc.stdout?.on("data", (d: Buffer) => {
			if (sclangProc !== owner) return;
			bootSignals.feed(d.toString());
			scOutputBuffer = (scOutputBuffer + d.toString()).slice(-64_000);
			for (const line of d.toString().split("\n")) {
				sclangSeq++;
				sclangTail.push(line);
				if (sclangTail.length > SCLANG_TAIL_MAX) sclangTail.shift();
			}
		});
		sclangProc.stderr?.on("data", () => {});
		const owner = sclangProc;
		sclangProc.on("exit", () => { if (sclangProc === owner) sclangProc = null; });
	}

	function startRepl(cwd: string): void {
		// prefer a project-local BootTidal.hs; fall back to the copy bundled
		// with this package so the extension works in any repo
		const candidates = [path.join(cwd, "BootTidal.hs"), path.join(PACKAGE_DIR, "BootTidal.hs")];
		const boot = candidates.find((c) => fs.existsSync(c));
		if (!boot) {
			updateWidget("BootTidal.hs not found (project or package)");
			return;
		}
		replReady = false;
		replBootedAt = Date.now();
		// a fresh REPL has none of the previous process's state, so anything queued
		// for the old one is stale: flushing it produces bursts of
		// "Variable not in scope" for declarations that were made in the old REPL
		// (and for params that no longer exist at all)
		queuedChunks.length = 0;
		replProc = cp.spawn("ghci", ["-ghci-script", boot], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		stderrLines = [];
		errorBurst = null;
		if (errorFlushTimer) { clearTimeout(errorFlushTimer); errorFlushTimer = null; }
		replStdoutBuf = "";
		replProc.stdout?.on("data", (d: Buffer) => {
			const text = d.toString();
			dbg("repl stdout:", JSON.stringify(text.slice(0, 80)));
			// ghci stdout arrives in tiny pipe-sized fragments; match against a
			// rolling buffer, not individual chunks (large enough to hold a full
			// 'list' capture for replQuery)
			replStdoutBuf = (replStdoutBuf + text).slice(-4000);
			if (!replReady && /Connected to SuperDirt|Listening for external controls/.test(replStdoutBuf)) {
				replReady = true;
				flushQueue();
				updateWidget("repl ready");
			}
		});
		// poke stdin so ghci flushes its prompt through the block-buffered pipe
		if (replInitialPokeTimer) clearTimeout(replInitialPokeTimer);
		replInitialPokeTimer = setTimeout(() => { try { replProc?.stdin?.write("\n"); } catch { /* gone */ } }, 5000);
		if (replPokeTimer) clearInterval(replPokeTimer);
		replPokeTimer = setInterval(() => { if (!replReady) { try { replProc?.stdin?.write("\n"); } catch { /* gone */ } } }, 10_000);
		replPokeTimer.unref();
		replProc.stderr?.on("data", (d: Buffer) => handleStderr(d.toString()));
		const owner = replProc;
		replProc.on("exit", () => {
			if (replProc !== owner) return;
			replProc = null; replReady = false; updateWidget("repl exited");
		});
	}

	function serverListeningSinceBoot(): boolean {
		// SuperDirt's port binds early; our layer finishes later and writes "done".
		// Require BOTH, and refuse to report ready while a boot stage is failing.
		if (!bootSignals.listening) return false;
		const logPath = path.join(currentCwd, "sc/boot.log");
		if (!fs.existsSync(logPath)) return true; // stock SuperDirt
		try {
			const state = inspectBootLog(fs.readFileSync(logPath, "utf8"), {
				fresh: fs.statSync(logPath).mtimeMs > bootLogBefore,
			});
			scBootError = state.error;
			return state.ready;
		} catch { return false; } // an unreadable project log is not proof of readiness
	}

	function serverDiedSinceBoot(): boolean {
		return bootSignals.died;
	}

	// Real implementation (may block while a stack boots).
	async function ensureStackInner(cwd: string): Promise<string> {
		if (closing) throw new Error("plugin is shutting down");
		currentCwd = cwd;
		const st = await queryScsynth();
		if (!sclangProc && (st.alive || udpPortListening(SUPERDIRT_PORT))) {
			// Something outside this session holds the SC ports. That may be a
			// healthy foreign stack (another pi session, manual start-tidal.sh) —
			// or a stack that is mid-death / mid-boot and about to vanish (its
			// UDP socket lingers in /proc/net/udp until the process exits). Before
			// refusing, give it a moment and re-check: if the occupant is gone we
			// can boot normally instead of wedging the session behind a dead end.
			const wasAlive = st.alive;
			await new Promise((r) => setTimeout(r, 4000));
			const re = await queryScsynth();
			if (!re.alive && !udpPortListening(SCSYNTH_PORT) && !udpPortListening(SUPERDIRT_PORT)) {
				dbg("foreign stack vanished during recheck; booting our own");
			} else if (re.alive) {
				return "SC is running outside this plugin instance (OSC /status answers on 57110); no owned stdin. "
					+ "Another pi session or a manual start-tidal.sh owns the stack — use its session, or stop it before restarting here.";
			} else {
				return "SC ports are held by an unowned stack that is not answering OSC (likely mid-boot or hung; "
					+ (wasAlive ? "was answering moments ago" : "port bound, no /status reply") + "). "
					+ "Check for sclang/scsynth processes and stop them before restarting here.";
			}
		}
		// scsynth is UDP-silent for 30-90s after spawn (README: pipe backpressure
		// while sclang churns). If the port is bound the server is NOT dead —
		// treat it as up instead of killStack()ing a healthy stack and rebooting.
		if (!sclangProc) await startSclang();
		// Start GHCi concurrently with SC; neither process needs the other to
		// finish compiling. Never reboot merely because a healthy boot is slow.
		if (!replProc) startRepl(cwd);
		const scOk = await waitFor(() => serverListeningSinceBoot() || serverDiedSinceBoot() || !!scBootError, BOOT_TIMEOUT_MS, 250);
		if (!scOk || serverDiedSinceBoot() || scBootError) {
			return `SC startup failed at ${bootStage}: ${scBootError || (serverDiedSinceBoot() ? "server exited" : "deadline exceeded")}; sclang tail:\n${sclangTail.slice(-12).join("\n")}`;
		}
		bootStage = "Tidal REPL handshake";
		const replOk = await waitFor(() => replReady, REPL_TIMEOUT_MS, 250);
		scsynthCached = await queryScsynth();
		updateWidget();
		startWatchdog();
		if (replOk && scenes.entries().length && !sceneController.runtimeReady) await sceneController.restore();
		bootStage = replOk ? "ready" : "Tidal REPL handshake failed";
		return replOk ? "stack ready" : "Tidal REPL handshake timed out; SC passed its audio self-test";
	}

	// Watchdog: if scsynth dies while we own the stack (typically suspend/resume
	// killing the pipewire-jack client), bring the stack back and re-fire the
	// last chunks so the music resumes. Rate-limited to one revival per 15s.
	let reviving = false;
	let lastReviveAt = 0;
	let scsynthMisses = 0;
	function startWatchdog(): void {
		if (watchdog) return;
		watchdog = setInterval(async () => {
			if (closing || reviving || !weSpawnedSclang) return;
			if (Date.now() - lastReviveAt < 15_000) return;
			const owner = sclangProc;
			const sc = await queryScsynth(3000);
			if (!watchdog || owner !== sclangProc || !weSpawnedSclang) return;
			scsynthCached = sc;
			updateWidget();
			if (sc.alive) { scsynthMisses = 0; return; }
			scsynthMisses++;
			if (scsynthMisses < 2) return;
			scsynthMisses = 0;
			// a silent scsynth during sclang's startup churn is normal; only revive
			// when sclang itself reports the server process died
			if (!serverDiedSinceBoot() && sclangProc) {
				dbg("scsynth silent but sclang alive and no exit reported — not reviving");
				return;
			}
			reviving = true;
			updateWidget("scsynth died — reviving");
			try {
				const cwd = process.cwd();
				await lifecycle(() => teardown());
				const msg = await ensureStack(cwd);
				lastReviveAt = Date.now();
				if (isStackReady(msg)) {
					const hadScenes = scenes.entries().length > 0;
					// restore state: globals first (hush/setcps/do-blocks), then each
					// stream's latest chunk in numeric order — silences stay silent
					for (const c of hadScenes ? [] : [...lastChunks]) {
						if (replReady) sendChunk(c);
					}
					const streams = [...streamChunks.entries()].sort(
						(a, b) => (parseInt(a[0].slice(1)) || 0) - (parseInt(b[0].slice(1)) || 0),
					);
					for (const [, c] of hadScenes ? [] : streams) {
						if (replReady) sendChunk(c);
					}
					updateWidget("stack revived + state restored");
				} else {
					updateWidget(`revive failed: ${msg.slice(0, 40)}`);
				}
			} catch (error) {
				dbg("watchdog recovery failed:", error);
			} finally {
				reviving = false;
			}
		}, 10_000);
	}

	// ---------- recording ----------
	// Preferred path: scsynth records its own output bus via s.record — a clean
	// pre-mixer tap with no system audio (browser, notifications) and no
	// clipping from the user's output volume. No system-source fallback.
	function markerPath(): string {
		return recPath.replace(/\.wav$/, ".markers.jsonl");
	}

	function writeMarker(label: string): void {
		try {
			let git = "";
			try {
				git = cp.execSync("git rev-parse --short HEAD", {
					cwd: path.dirname(recPath), encoding: "utf-8",
				}).trim();
			} catch { /* not a repo */ }
			fs.appendFileSync(markerPath(), JSON.stringify({
				t: new Date().toISOString(),
				rel: Math.round((Date.now() - recStartedAt) / 100) / 10,
				label,
				last: lastLabel,
				git,
			}) + "\n");
		} catch { /* best effort */ }
	}

	async function startRecording(cwd: string, name?: string): Promise<string> {
		if (recActive) return `already recording: ${recPath}`;
		const stackMsg = await ensureStack(cwd);
		if (!isStackReady(stackMsg)) return `cannot record: ${stackMsg}`;
		const dir = path.join(cwd, "recordings");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
		// A take can be named: "Jolene in the Riddim" -> jolene-in-the-riddim-20261004-1137.
		// The timestamp stays so takes sort chronologically and never collide; the
		// slug is what a human (and the album dir) actually reads. Falls back to
		// the anonymous `jam-` prefix when no name is given.
		const slug = (name ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60);
		const stem = (slug ? slug + "-" : "jam-") + stamp;
		recPath = path.join(dir, stem + ".wav");
		recStartedAt = Date.now();
		recVia = null;
		if (sclangProc?.stdin) {
			try {
				sclangProc.stdin.write(
				// sched(2) is load-bearing: calling s.record immediately after
				// prepareForRecord races the Recorder's temp DiskOut synthdef to the
				// server ("SynthDef temp__0 not found") and yields a header-only file
				`s.recHeaderFormat = "wav"; s.prepareForRecord(${JSON.stringify(recPath)}); SystemClock.sched(2, { s.record });\n`);
			await new Promise((r) => setTimeout(r, 3000));
				if (fs.existsSync(recPath) && fs.statSync(recPath).size > 44) recVia = "sclang";
			} catch { /* fail closed below */ }
		}
		// Fail closed: an unresolved pw-record target can capture the microphone.
		// Recording this stack must never silently fall back to a system source.
		if (!recVia) return "could not start scsynth output recording (no system/microphone fallback)";
		recActive = true;
		writeMarker("start");
		updateWidget(`recording: ${path.basename(recPath)}`);
		return `recording to ${recPath} (via ${recVia})`;
	}

	async function stopRecording(transcode = true): Promise<string> {
		if (!recActive) return "not recording";
		recActive = false;
		writeMarker("stop");
		if (recVia === "sclang" && sclangProc?.stdin) {
			try { sclangProc.stdin.write("s.stopRecording;\n"); } catch { /* gone */ }
		}
		await new Promise((r) => setTimeout(r, 1500));
		const dur = Math.round((Date.now() - recStartedAt) / 100) / 10;
		let extra = "";
		if (transcode && fs.existsSync("/usr/bin/ffmpeg") && fs.existsSync(recPath) && fs.statSync(recPath).size > 44) {
			try {
				cp.execFileSync("/usr/bin/ffmpeg", ["-y", "-i", recPath, "-c:a", "flac", markerPath().replace(/\.markers\.jsonl$/, ".flac")], { stdio: "ignore" });
				extra = " (+flac)";
			} catch { /* keep wav only */ }
		}
		const size = fs.existsSync(recPath) ? Math.round(fs.statSync(recPath).size / 1e6) : 0;
		updateWidget(`recording stopped: ${Math.round(dur)}s`);
		return `stopped after ${dur}s, ${size}MB: ${recPath}${extra} | markers: ${markerPath()}`;
	}

	async function teardown(reason?: string): Promise<void> {
		for (const timer of pendingTimers.values()) clearTimeout(timer);
		pendingTimers.clear();
		if (errorFlushTimer) { clearTimeout(errorFlushTimer); errorFlushTimer = null; }
		if (watchdog) { clearInterval(watchdog); watchdog = null; }
		// A replacement extension cannot recover this stdin pipe. Leaving SC
		// alive across /reload created an unmanageable orphan; stop only our
		// complete process tree, on reload as well as quit. No delayed pkill.
		await killOwnStack();
		scTransport.dispose();
	}

	// ---------- chunk handling ----------
	function splitChunks(text: string): string[] {
		return text
			.split(/\n[ \t]*\n/)
			.map((c) => c.trim())
			.filter((c) => c.length > 0 && !c.split("\n").every((l) => l.trim() === "" || l.trim().startsWith("--")));
	}

	function sendChunk(chunk: string): boolean {
		if (!replProc?.stdin || !replReady) return false;
		// SC blocks are scene-only; never forward them (even fragments) to GHCi.
		if (extractSc(chunk).sc.length) throw new Error("Embedded SC requires tidal_scene and a -- @scene header");
		const stmts = tidalStatements(chunk);
		if (stmts.length === 0) return true;
		for (const line of stmts) {
			replProc.stdin.write(":{\n" + line + "\n:}\n");
			// track state per stream: a later "d4 $ silence" must override an earlier
			// "d4 $ ..." chunk, so revival restores what is ACTUALLY playing instead
			// of resurrecting long-replaced patterns (this bug kept a silenced piano
			// coming back after every ghci revival)
			const sm = line.match(/^d(\d+)\s*\$/);
			if (sm) streamChunks.set(`d${sm[1]}`, line);
			else {
				if (line === "hush") streamChunks.clear();
				lastChunks.push(line);
				if (lastChunks.length > 12) lastChunks.shift();
			}
		}
		return true;
	}

	function flushQueue(): void {
		while (queuedChunks.length > 0) {
			const c = queuedChunks.shift()!;
			sendChunk(c);
		}
	}

	function scheduleEval(filePath: string, cwd: string): void {
		const prev = pendingTimers.get(filePath);
		if (prev) clearTimeout(prev);
		pendingTimers.set(
			filePath,
			setTimeout(() => {
				pendingTimers.delete(filePath);
				evalChangedChunks(filePath, cwd);
			}, 400),
		);
	}

	async function evalChangedChunks(filePath: string, cwd: string): Promise<void> {
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf-8");
		} catch {
			return;
		}
		try {
			const active = scenes.entries().filter(([, record]: any) => record.file === path.resolve(filePath));
			if (isSceneFile(text) || active.length) {
				// Saving an inactive scene must not claim a deck or restart audio.
				for (const [deck] of active) await sceneQueue(async () => {
					const status = await ensureStack(cwd);
					if (!isStackReady(status)) throw new Error(status);
					await sceneController.activate(scenes.plan(deck, filePath, text, false));
				});
				snapshots.set(filePath, [text]);
				return;
			}
			if (sceneController.runtimeReady) throw new Error("Legacy .tidal edits are disabled while scene decks own the orbits; use tidal_scene action=leave first");
			if (extractSc(text).sc.length) throw new Error("Embedded SC requires a -- @scene header");
		} catch (error) {
			pi.sendUserMessage(`[tidal scene] ${path.basename(filePath)} edit not activated: ${error}`, { deliverAs: "followUp" });
			return;
		}
		const chunks = splitChunks(text);
		const old = snapshots.get(filePath);
		snapshots.set(filePath, chunks);
		if (!old) return; // first sighting: just snapshot, don't blast the file

		const changed: string[] = [];
		const n = Math.max(old.length, chunks.length);
		for (let i = 0; i < n; i++) {
			if (old[i] !== chunks[i] && chunks[i] !== undefined) changed.push(chunks[i]);
		}
		if (changed.length === 0) return;

		const rel = path.relative(cwd, filePath);
		for (const [i, chunk] of changed.entries()) {
			lastLabel = `${rel} [${i + 1}/${changed.length}]`;
			if (replReady) sendChunk(chunk);
			else queuedChunks.push(chunk);
		}
		updateWidget(`eval ${lastLabel}`);
	}

	// ---------- error feedback ----------
	// GHC emits a single error across several stderr writes: the header line
	// (<interactive>:N:M: error:) arrives first, the message body (bullets,
	// source context) in later chunks. Reporting on the first matching line
	// produces empty-bodied reports, and excerpting the stderr ring-buffer tail
	// pulls in stale fragments from older errors. So: on the first matching
	// line, open a burst that accumulates everything until stderr goes quiet
	// for a beat, then report once with the complete burst as the excerpt.
	let errorBurst: string[] | null = null;
	let errorFlushTimer: ReturnType<typeof setTimeout> | null = null;
	const ERROR_QUIET_MS = 400;

	function flushErrorBurst(): void {
		errorFlushTimer = null;
		const burst = errorBurst;
		errorBurst = null;
		if (!burst || !replReady) return;
		const now = Date.now();
		// hard cooldown: at most one error report per 30s. GHC errors carry
		// fresh line numbers (<interactive>:23:5) on every attempt, so naive
		// content dedupe never matches and each failed eval spawns a new
		// [tidal] message — which makes the agent react and re-eval, flooding
		// the session with an eval-error-response loop.
		if (now - lastErrorAt < 30_000) return;
		// normalize line numbers out before dedupe so the same error re-fired
		// on chunk edits still counts as "the same error", then clean the burst:
		// rejoin GHC's terminal-width hard wraps (words split mid-token), strip
		// ANSI/control garbage, collapse blank runs, and cut the CALL STACK dump
		// so the report is legible and does not flood the scrollback
		const excerpt = cleanReplError(
			burst
				.map((l) => l.replace(/<interactive>:\d+(:\d+)?(-\d+)?:?/g, "<interactive>").trimEnd())
				.filter((l) => !l.trim().startsWith("--") && !/Suggested fix/.test(l))
				.join("\n"),
		);
		if (!excerpt) return;
		if (excerpt === lastErrorExcerpt) return; // same error, already reported
		lastErrorExcerpt = excerpt;
		lastErrorAt = now;
		updateWidget(`ERROR: ${excerpt.split("\n")[0].slice(0, 60)}`);
		pi.sendUserMessage(
			`[tidal] REPL error after evaluating ${lastLabel}:\n\`\`\`\n${excerpt}\n\`\`\`\nFix the chunk and re-save it.`,
			{ deliverAs: "followUp" },
		);
	}

	function handleStderr(text: string): void {
		for (const line of text.split("\n")) {
			stderrLines.push(line);
			if (stderrLines.length > 60) stderrLines.shift();
			if (!replReady) continue; // ignore ghci boot noise
			const matches = /(error|Exception|not in scope|parse error|Cannot interpolate|Variable not)/i.test(line);
			const noise = line.trim().startsWith("--") || /Suggested fix/.test(line);
			if (errorBurst) {
				// inside a burst: collect every line (GHC message bodies don't all
				// match the error regex) until the quiet timer flushes
				errorBurst.push(line);
			} else if (matches && !noise) {
				errorBurst = [line];
			}
		}
		if (errorBurst && !errorFlushTimer) {
			errorFlushTimer = setTimeout(flushErrorBurst, ERROR_QUIET_MS);
		}
	}

	// ---------- UI ----------
	function updateWidget(extra?: string): void {
		if (!piHasUI) return;
		const sc = scsynthCached;
		const lines = [
			`tidal: scsynth ${formatScStatus(sc)} | repl ${replReady ? "✓" : replProc ? "…" : "✗"} | last: ${lastLabel}`,
		];
		if (extra) lines.push(extra);
		try { piSetWidget(lines); } catch { /* UI unavailable */ }
	}

	// These are captured lazily because ctx isn't available at factory time.
	let piHasUI = false;
	let scsynthCached: { alive: boolean; synths: number; ugens: number } | null = null;
	function piSetWidget(lines: string[]): void {
		// setWidget needs a context; use the last registered command ctx trick:
		// instead we stash a UI-facing callback set during session_start.
		widgetSink?.(lines);
	}
	let widgetSink: ((lines: string[]) => void) | null = null;

	// ---------- lifecycle ----------
	pi.on("session_start", async (_event, ctx) => {
		closing = false;
		piHasUI = ctx.hasUI;
		widgetSink = (lines) => {
			try { ctx.ui.setWidget("tidal", lines); } catch { /* ignore */ }
		};
		// Recover only the active branch's latest scene snapshot, never unsent
		// file edits. The next stack operation restores the pair decks from zero;
		// snapshots without a pair (older versions) default to A/B.
		const saved = ctx.sessionManager?.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "tidal-scenes").at(-1) as any;
		if (saved?.data?.decks) {
			try {
				// Apply the audible pair before validating tempos: parked A/B may
				// have different cps from each other and from the saved hot pair.
				scenes.restoreSnapshot(saved.data);
			} catch { scenes.clear(); }
		}
		// snapshot existing .tidal files so first edits diff cleanly
		try {
			for (const f of fs.readdirSync(ctx.cwd)) {
				if (f.endsWith(".tidal")) {
					snapshots.set(path.join(ctx.cwd, f), splitChunks(fs.readFileSync(path.join(ctx.cwd, f), "utf-8")));
				}
			}
		} catch { /* ignore */ }
		updateWidget();
	});

	pi.on("session_shutdown", async (event) => {
		closing = true;
		await sceneQueue(() => sceneController.action({ action: "cancel" }, process.cwd()));
		if (watchdog) { clearInterval(watchdog); watchdog = null; }
		if (recActive) await stopRecording(false);
		const reason = (event as { reason?: string } | undefined)?.reason;
		await lifecycle(() => teardown(reason));
	});

	// ---------- auto-eval on edit ----------
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const inputPath = (event.input as { path?: string } | undefined)?.path;
		if (event.isError || !inputPath || !inputPath.endsWith(".tidal")) return;
		const p = path.resolve(ctx.cwd, inputPath);
		// only auto-eval files inside the project
		const rel = path.relative(ctx.cwd, p);
		if (rel.startsWith("..")) return;
		scheduleEval(p, ctx.cwd);
	});

	// ---------- REPL output capture ----------
	// ghci's stdout is block-buffered through the pipe; the established
	// workaround (see startRepl) is poking stdin, which makes ghci flush its
	// buffered output when it processes the next line. replQuery sends a
	// marker-delimited command and pokes until the end marker shows up.
	function replQuery(cmds: string[], timeoutMs = 5000): Promise<string> {
		return queryQueue(() => new Promise<string>((resolve) => {
			if (!replProc || !replReady) return resolve("(repl not ready)");
			const BEGIN = "__PI_TIDAL_BEGIN__", END = "__PI_TIDAL_END__";
			const cmd = replCommand(cmds, BEGIN, END);
			// Drop everything buffered so far: BEGIN/END markers from earlier queries
			// linger in the rolling buffer, and indexOf(BEGIN) would match the OLDEST
			// pair — returning stale output (e.g. an unchanged 'list') while looking
			// freshly captured. Only output produced after this write is considered.
			replStdoutBuf = "";
			try { replProc.stdin?.write(cmd + "\n"); } catch { return resolve("(repl stdin closed)"); }
			const deadline = Date.now() + timeoutMs;
			const poll = setInterval(() => {
				const buf = replStdoutBuf;
				const bi = buf.indexOf(BEGIN);
				const ei = bi >= 0 ? buf.indexOf(END, bi) : -1;
				if (bi >= 0 && ei > bi) {
					clearInterval(poll);
					resolve(buf.slice(bi + BEGIN.length, ei).trim());
				} else if (Date.now() > deadline) {
					clearInterval(poll);
					resolve("(no output captured from REPL)");
				} else {
					try { replProc?.stdin?.write("\n"); } catch { /* gone */ } // flush poke
				}
			}, 250);
		}));
	}

	// ---------- scene ownership ----------
	function writeRepl(statement: string): void {
		if (!replReady || !replProc?.stdin?.writable) throw new Error("Tidal REPL is not writable");
		replProc.stdin.write(`:{\n${statement}\n:}\n`);
	}

	async function sceneSc(body: (token: string) => string, asynchronous = false): Promise<void> {
		const token = `PI_SCENE_${++scRequestNumber}_${Date.now()}`;
		const source = body(JSON.stringify(token));
		const done = asynchronous ? "" : `; ${JSON.stringify(token + ":ok")}.postln`;
		scTransport.send(`(try { ${source}${done} } { |error| (${JSON.stringify(token + ":error:")} ++ error.errorString).postln })`, token);
		const ok = await waitFor(() => scOutputBuffer.includes(token + ":ok") || scOutputBuffer.includes(token + ":error:"), 10_000, 25);
		if (!ok) throw new Error(`SC scene request failed to acknowledge (compile error or stopped interpreter): ${scOutputBuffer.slice(-1600)}`);
		const error = scOutputBuffer.match(new RegExp(token + ":error:([^\\n]*)"));
		if (error) throw new Error(error[1]);
	}

	const { createSceneController } = await importFreshModule(path.join(PACKAGE_DIR, "lib/scene-controller.mjs"));
	const sceneController = createSceneController({
		registry: scenes, runtimePath: path.join(PACKAGE_DIR, "sc/scenes.scd"),
		ensure: ensureStack, ready: isStackReady, writeRepl, queryRepl: replQuery,
		sc: sceneSc, hush: () => sendChunk("hush"),
		label: (text: string) => { lastLabel = text; updateWidget(); persistScenes(); },
		deckIndex, deckSlot, patternExpression, sceneCommands, stopCommands, enqueue: sceneQueue, tempoRideSteps,
	});

	function persistScenes(): void {
		pi.appendEntry?.("tidal-scenes", scenes.snapshot());
	}

	async function leaveScenesForHush(): Promise<void> {
		await sceneQueue(() => sceneController.leave());
		// Persist the empty snapshot too: reload must not resurrect hushed decks.
		persistScenes();
	}

	pi.registerTool({
		name: "tidal_scene", label: "Tidal Scene",
		description:
			"Load a .tidal scene with -- @scene metadata and {- @sc ... -} blocks onto a logical deck A..Z. " +
			"Decks in configured channels (default A/B pair) render; loading an unassigned letter parks it " +
			"(source saved, Haskell checked, no DSP) until 'select' swaps it into a channel, parking the deck it displaces. " +
			"Load/restart starts at local cycle zero on a future bar; edit preserves phase. Mix crossfades the two pair decks; " +
			"gain sets a channel power weight; morph {from,to,toCps,seconds,stepHz} rides the ONE global clock while crossfading two channels; cancel holds last acknowledged targets. " +
			"Configurable channels default to the backward-compatible A/B pair; stop frees owned nodes; leave restores legacy orbit routing. Active channels share effective tempo. " +
			"SC blocks use scene[\\mod].value({ |cycles| [toneHz, sat, wet, gain] }).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("load"), Type.Literal("restart"), Type.Literal("edit"), Type.Literal("select"), Type.Literal("mix"), Type.Literal("gain"), Type.Literal("morph"), Type.Literal("cancel"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("leave")]),
			deck: Type.Optional(Type.String({ description: "logical deck letter A..Z", pattern: "^[A-Z]$" })),
			slot: Type.Optional(Type.Number({ description: "channel index for select (default 0 or 1); the deck holding that channel is parked" })),
			file: Type.Optional(Type.String()),
			mix: Type.Optional(Type.Number({ description: "0 = pair position 0, 1 = pair position 1; both clocks continue" })),
			cycles: Type.Optional(Type.Number({ description: "Crossfade duration at the current tempo" })),
			channel: Type.Optional(Type.Number({ description: "Channel index for gain" })),
			gain: Type.Optional(Type.Number({ description: "Power weight 0..1; amplitude is sqrt(gain)" })),
			from: Type.Optional(Type.Number({ description: "Source channel index for morph" })),
			to: Type.Optional(Type.Number({ description: "Destination channel index for morph" })),
			toCps: Type.Optional(Type.Number({ description: "Explicit global tempo target >0..4 for morph" })),
			seconds: Type.Optional(Type.Number({ description: "Wall-clock duration (morph >0..300, gain 0..300)" })),
			stepHz: Type.Optional(Type.Number({ description: "Tempo writes/sec 1..10, default 4; look-ahead can jitter" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const text = await sceneQueue(() => sceneController.action(params, ctx.cwd));
			persistScenes();
			return { content: [{ type: "text", text }], details: scenes.snapshot() };
		},
	});

	// ---------- tools ----------
	// Bounded wrapper: an unbounded wait here makes EVERY tidal_* tool hang with no
	// result (observed when sclang could not initialise audio because an orphaned
	// scsynth held the device — the plugin kept waiting for a stack that could
	// never come up). Fail loudly with a diagnosis instead.
	let ensureFlight: Promise<string> | null = null;
	async function ensureStack(cwd: string): Promise<string> {
		// Concurrent tools must share one boot, including after a caller times
		// out. Clearing this on timeout would spawn another stack over the first.
		if (!ensureFlight) {
			ensureFlight = lifecycle(() => ensureStackInner(cwd)).finally(() => { ensureFlight = null; });
		}
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve(
				`startup deadline exceeded (${ENSURE_TIMEOUT_MS / 1000}s), stage: ${bootStage}. ` +
				"The owned boot is still tracked; do not launch a second sclang."), ENSURE_TIMEOUT_MS);
		});
		try { return await Promise.race([ensureFlight, timeout]); }
		finally { clearTimeout(timer!); }
	}

	pi.registerTool({
		name: "tidal_state",
		label: "Tidal State",
		description:
			"Inspect what is actually running in the REPL vs what is saved on disk. Queries Tidal's own " +
			"'list' (which d-streams are active/muted/soloed) and reports the plugin's tracked .tidal files " +
			"with chunk counts and the last eval label. Use to reconcile ad-hoc tidal_eval tweaks with the " +
			"saved chunks so live state and files don't drift apart.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			const listOut = replReady ? await replQuery(["list"]) : "(repl not ready)";
			const files: string[] = [];
			for (const [fp, chunks] of snapshots) {
				const rel = path.relative(ctx.cwd, fp);
				files.push(`${rel} (${chunks.length} chunks)`);
			}
			const text = [
				`stack: ${status}`,
				`last eval: ${lastLabel}`,
				`active streams (from Tidal 'list'):\n${listOut}`,
				`tracked .tidal files: ${files.length ? files.join(", ") : "(none)"}`,
				await sceneController.action({ action: "status" }, ctx.cwd),
			].join("\n");
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_record",
		label: "Tidal Record",
		description:
			"Start/stop recording the stack's audio output. Preferred over shelling out to pw-record: " +
			"uses s.record (clean scsynth tap, no system audio or output-volume clipping), writes " +
			"recordings/<name>-YYYYMMDD-HHMM.wav (default prefix `jam-`) plus a FLAC copy on stop, and maintains a markers sidecar. " +
			"Pass `name` to title the take — it is slugified, so 'Jolene in the Riddim' -> jolene-in-the-riddim-20261004-1137. " +
			"Use start before a take and stop when it's over; recording auto-stops on session shutdown.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")], {
				description: "start, stop, or query recording state",
			}),
			name: Type.Optional(Type.String({
				description: "Optional title for the take (slugified into the filename), e.g. 'Jolene in the Riddim'",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let msg: string;
			if (params.action === "start") msg = await startRecording(ctx.cwd, params.name);
			else if (params.action === "stop") msg = await stopRecording();
			else msg = recActive
				? `recording ${path.basename(recPath)} via ${recVia}, ${Math.round((Date.now() - recStartedAt) / 1000)}s`
				: "not recording";
			return { content: [{ type: "text", text: msg }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_mark",
		label: "Tidal Mark",
		description:
			"Stamp a labeled marker into the current recording's markers sidecar (<jam>.markers.jsonl): " +
			"timestamp, seconds into the take, current eval label, and the project's git HEAD. " +
			"Call at musical transitions ('drop', 'breakdown', 'climax') so the audio can be " +
			"cross-referenced with the commit history afterwards. Requires an active recording.",
		parameters: Type.Object({
			label: Type.String({ description: "Short marker label, e.g. 'drop', 'breakdown', 'pianos back'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!recActive) {
				return { content: [{ type: "text", text: "not recording — use tidal_record action=start first" }], details: {} };
			}
			writeMarker(params.label);
			return { content: [{ type: "text", text: `marked "${params.label}" at ${Math.round((Date.now() - recStartedAt) / 100) / 10}s` }], details: {} };
		},
	});


	pi.registerTool({
		name: "tidal_sc",
		label: "SuperCollider Eval",
		description:
			"Evaluate SuperCollider code in the running sclang (the SuperDirt process). " +
			"Use it to define SynthDefs, patch the effects/master chain, adjust orbits, " +
			"read server state, or reload the DSP layer (sc/init.scd) without restarting " +
			"the audio stack. Code is written to sclang's stdin; sclang's own output for " +
			"this eval is returned.",
		parameters: Type.Object({
			code: Type.String({ description: "SuperCollider code to evaluate" }),
			settleMs: Type.Optional(Type.Number({
				description: "ms to wait for sclang output before returning (default 900)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_sc failed: ${status}` }], details: {} };
			}
			// weSpawnedSclang means the stdin pipe is ours to write to
			if (!sclangProc || !sclangProc.stdin) {
				return { content: [{ type: "text", text: "tidal_sc: no sclang stdin available" }], details: {} };
			}
			const mark = sclangSeq;
			// Preserve multiline source in a file; readline stdin otherwise
			// evaluates '(' and each body line separately. Do not prepend a
			// marker to the source: that would invalidate leading var declarations.
			try {
				scTransport.send(params.code, `[tidal_sc eval ${Date.now()}]`);
			} catch (e) {
				return { content: [{ type: "text", text: `tidal_sc: write failed: ${e}` }], details: {} };
			}
			const settle = params.settleMs ?? 900;
			await new Promise((r) => setTimeout(r, settle));
			const out = sclangLinesSince(mark).join("\n").trim();
			lastLabel = "tidal_sc";
			updateWidget("eval sclang");
			return {
				content: [{ type: "text", text: out ||
					"(no sclang output at all — the eval most likely failed to PARSE and silently " +
					"no-opped: sclang posts syntax errors as 'ERROR: syntax error ...' but throws " +
					"nothing through executeFile/compile. Most common cause: a var declaration after " +
					"other statements in a function/block body; also unbalanced brackets/strings.)" }],
				details: {},
			};
		},
	});


	pi.registerTool({
		name: "tidal_param",
		label: "Declare Tidal Parameters",
		description:
			"Declare SuperDirt parameters in the running Tidal REPL so patterns can " +
			"send them (without this an eval fails with 'Variable not in scope'). " +
			"Takes specs like 'ddSend:f mSat:f lock:i', where f/i/s pick pF/pI/pS. " +
			"For a permanent declaration add the param to livecode/sc/params.tsv and run " +
			"tools/sc_params.py, which regenerates BootTidal.hs.",
		parameters: Type.Object({
			spec: Type.String({ description: "space separated name[:type] specs" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_param failed: ${status}` }], details: {} };
			}
			const fn = (t: string) => (t === "i" ? "pI" : t === "s" ? "pS" : "pF");
			const specs = params.spec.trim().split(/\s+/).filter(Boolean);
			let n = 0;
			for (const spec of specs) {
				const [name, typ = "f"] = spec.split(":");
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
				if (!sendChunk(`let ${name} = ${fn(typ)} "${name}"`)) queuedChunks.push(`let ${name} = ${fn(typ)} "${name}"`);
				n++;
			}
			lastLabel = "tidal_param";
			updateWidget(`declare ${n} param(s)`);
			return { content: [{ type: "text", text: `declared ${n} parameter(s): ${specs.join(" ")}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_repl",
		label: "Restart Tidal REPL",
		description:
			"Restart the Tidal (ghci) REPL so it reloads BootTidal.hs, and by doing so " +
			"re-establish the OSC path to SuperDirt. Needed after the audio stack is " +
			"restarted (the old REPL looks healthy and reports active streams while " +
			"sending nothing), and after editing BootTidal.hs. Scene decks are restored from local zero; legacy patterns must be re-sent.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return sceneQueue(() => lifecycle(async () => {
				if (closing) throw new Error("plugin is shutting down");
				const old = replProc;
				if (old?.pid && old.exitCode === null && old.signalCode === null) {
					await stopOwnedProcessTree(old.pid);
				}
				replProc = null;
				replReady = false;
				startRepl(ctx.cwd);
				const ready = await waitFor(() => replReady, REPL_TIMEOUT_MS, 250);
				if (ready && scenes.entries().length) await sceneController.restore();
				lastLabel = "tidal_repl";
				updateWidget(ready ? "repl ready" : "repl failed");
				return {
					content: [{ type: "text", text: ready
						? "owned REPL restarted and ready (scene decks restored; legacy patterns must be re-sent)"
						: "REPL restart timed out" }],
					details: {},
				};
			}));
		},
	});


	pi.registerTool({
		name: "tidal_sc_reload",
		label: "Reload SuperCollider Layer",
		description:
			"Re-execute the project's SuperCollider DSP layer (livecode/sc/init.scd) in " +
			"the running sclang, so changes to SynthDefs, routing, effects and instruments " +
			"take effect WITHOUT restarting the audio stack (a restart costs 60-90s). " +
			"Use after editing anything in sc/. Reinstalls orbit effect chains and re-routes " +
			"orbits, so expect effects synths to be recreated.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_sc_reload failed: ${status}` }], details: {} };
			}
			if (sceneController.runtimeReady) throw new Error("Leave scene mode before reloading project routing (tidal_scene action=leave)");
			if (!sclangProc || !sclangProc.stdin) {
				return { content: [{ type: "text", text: "tidal_sc_reload: no sclang stdin available" }], details: {} };
			}
			const mark = sclangSeq;
			const sc = `${ctx.cwd}/sc/init.scd`;
			try {
				// init.scd uses s.sync/wait; reload it inside a Routine, as at boot.
				scTransport.send(`fork { this.executeFile(${JSON.stringify(sc)}); };`, "reload SC layer");
			} catch (e) {
				return { content: [{ type: "text", text: `tidal_sc_reload: write failed: ${e}` }], details: {} };
			}
			await new Promise((r) => setTimeout(r, 2500));
			const out = sclangLinesSince(mark).join("\n").trim();
			lastLabel = "tidal_sc_reload";
			updateWidget("reload sc layer");
			return { content: [{ type: "text", text: out || "(sent; sc/boot.log records the stages)" }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_sc_status",
		label: "SuperCollider Status",
		description:
			"Report the SuperCollider side as text: orbit -> bus routing, each orbit's " +
			"effect chain, master/aux send levels, plus the last lines of sc/boot.log " +
			"(which records self-test levels for every instrument and the master chain). " +
			"Use it to see the routing instead of guessing.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_sc_status failed: ${status}` }], details: {} };
			}
			let log = "";
			try {
				const logPath = `${ctx.cwd}/sc/boot.log`;
				if (fs.existsSync(logPath)) {
					const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
					log = lines.slice(-12).join("\n");
				}
			} catch { /* no log yet */ }
			let live = "";
			if (sclangProc?.stdin) {
				const mark = sclangSeq;
				try {
					scTransport.send(
						'(\n"--- sc state ---".postln;\n' +
						'~dirt.orbits.do { |o, i| ("  orbit % -> bus %  fx: %".format(i, o.outBus.asString, ' +
						'o.globalEffects.collect { |e| e.name.asString }.join(" -> "))).postln };\n' +
						'if(~route.notNil) { ~route.levels.value };\n' +
						'"--- end ---".postln;\n)\n');
				} catch { /* gone */ }
				await new Promise((r) => setTimeout(r, 1200));
				live = sclangLinesSince(mark).join("\n").trim();
			}
			lastLabel = "tidal_sc_status";
			updateWidget("sc status");
			return {
				content: [{ type: "text", text:
					`scsynth: ${scsynthCached?.alive ? "alive" : "?"}\n\n` +
					`live SC state:\n${live || "(no reply)"}\n\nsc/boot.log (tail):\n${log || "(none)"}` }],
				details: {},
			};
		},
	});


	pi.registerTool({
		name: "tidal_panic",
		label: "Panic (silence + free nodes)",
		description:
			"True silence: hush the Tidal streams AND free stuck SuperCollider nodes. " +
			"`hush` only stops *events* — a synth whose envelope never closed keeps " +
			"droning under everything, which is a disaster live. This frees the " +
			"SuperDirt event groups and re-initialises each orbit's effect chain, so " +
			"the audio path is rebuilt and genuinely silent.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_panic: ${status}` }], details: {} };
			}
			await leaveScenesForHush();
			sendChunk("hush");                       // stop events on the Tidal side
			let scOut = "(no sclang stdin)";
			if (sclangProc?.stdin) {
				const mark = sclangSeq;
				try {
					scTransport.send(
						'~dirt.orbits.do { |o| o.freeSynths };\n' +
						'"--- panic done ---".postln;');
				} catch { /* gone */ }
				await new Promise((r) => setTimeout(r, 1500));
				scOut = sclangLinesSince(mark).join("\n").trim() || "(sent)";
			}
			lastLabel = "tidal_panic";
			updateWidget("panic");
			return {
				content: [{ type: "text", text: `hush sent; SuperDirt nodes freed and orbit chains rebuilt\n${scOut}` }],
				details: {},
			};
		},
	});


	pi.registerTool({
		name: "tidal_restart",
		label: "Restart the stack (atomic)",
		description:
			"Restart SuperCollider and the Tidal REPL as ONE operation: stop only the " +
			"processes this plugin started (never a blind pkill), boot sclang, wait until " +
			"sc/boot.log reports a fresh 'done' with no failing stage, restart the REPL so " +
			"the OSC path is rebuilt, then re-send the last .tidal state so the music " +
			"resumes by itself. Use this instead of killing processes by hand.",
		parameters: Type.Object({
			file: Type.Optional(Type.String({
				description: "state file to re-send afterwards (default: the last one sent)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return sceneQueue(async () => {
				const status = await lifecycle(async () => {
					if (closing) throw new Error("plugin is shutting down");
					if (watchdog) { clearInterval(watchdog); watchdog = null; }
					await killOwnStack();
					return ensureStackInner(ctx.cwd);
				});
				if (!isStackReady(status)) throw new Error(status);
				let resent = scenes.entries().length ? "scene decks (SC + patterns, local zero)" : "none";
				const target = params.file ? path.resolve(ctx.cwd, params.file) : scenes.entries().length ? null : lastStateFile;
				if (target) {
					const text = fs.readFileSync(target, "utf8");
					if (isSceneFile(text)) await sceneController.activate(scenes.plan("A", target, text, true));
					else {
						if (sceneController.runtimeReady) throw new Error("Leave scene mode before replaying a legacy file");
						for (const chunk of splitChunks(text)) sendChunk(chunk);
						lastStateFile = target;
					}
					resent = target;
				}
				lastLabel = "tidal_restart";
				updateWidget("stack restarted");
				return { content: [{ type: "text", text: `stack restarted; re-sent ${resent}` }], details: {} };
			});
		},
	});

	pi.registerTool({
		name: "tidal_eval",
		label: "Tidal Eval",
		description:
			"Evaluate Tidal code in the running REPL. Use for ad-hoc patterns, e.g. 'd1 $ s \"bd*4\"' or 'hush'. " +
			"Multi-statement code must follow the repo convention: blank-line separated chunks, no empty lines inside a do block.",
		parameters: Type.Object({
			code: Type.String({ description: "Tidal/Haskell code to evaluate" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			if (!isStackReady(status)) {
				return { content: [{ type: "text", text: `tidal_eval failed: ${status}` }], details: {} };
			}
			if (params.code.trim() === "hush") await leaveScenesForHush();
			else if (sceneController.runtimeReady) throw new Error("Use tidal_scene while deck mode owns the orbits; leave scene mode before ad-hoc legacy evals");
			if (extractSc(params.code).sc.length || isSceneFile(params.code)) throw new Error("Use tidal_scene to load embedded SC scenes");
			const scripted = params.code.match(/:script\s+(\S+\.tidal)/);
			if (scripted) {
				const target = path.resolve(ctx.cwd, scripted[1]);
				if (isSceneFile(fs.readFileSync(target, "utf8"))) throw new Error("Use tidal_scene to load scene files, not :script");
				lastStateFile = target;
			}
			for (const chunk of params.code.split(/\n[ \t]*\n/)) {
				const c = chunk.trim();
				if (!c || c.split("\n").every((l) => l.trim().startsWith("--"))) continue;
				if (!sendChunk(c)) queuedChunks.push(c);
			}
			lastLabel = "tidal_eval";
			updateWidget(`eval tidal_eval`);
			return {
				content: [{ type: "text", text: "Sent to REPL. Errors, if any, will arrive as a [tidal] message. Use tidal_status to confirm sound." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "tidal_hush",
		label: "Tidal Hush",
		description: "Emergency stop: silence all Tidal patterns (sends 'hush' to the REPL).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await ensureStack(ctx.cwd);
			await leaveScenesForHush();
			if (sendChunk("hush")) {
				lastLabel = "hush";
				updateWidget("hush");
				return { content: [{ type: "text", text: `hush sent (${status})` }], details: {} };
			}
			return { content: [{ type: "text", text: `could not send hush: ${status}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_status",
		label: "Tidal Status",
		description: "Report livecoding stack state: scsynth (alive, synth count), SuperDirt port, REPL state.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			let sc = await queryScsynth();
			scsynthCached = sc;
			let ensureNote = "";
			if (!sc.alive) {
				// scsynth may just be in its post-boot UDP-silent window, or down for
				// real — bring the stack up before trusting a DOWN report
				ensureNote = await ensureStack(ctx.cwd);
				sc = await queryScsynth();
				scsynthCached = sc;
			}
			const dirt = udpPortListening(SUPERDIRT_PORT);
			const replUp = !!replProc && replReady;
			updateWidget();
			const parts = [
				`scsynth: ${sc.alive ? `up, ${sc.synths} synths, ${sc.ugens} ugens${weSpawnedSclang ? "" : " (foreign stack, not owned by this session)"}` : "DOWN"}`,
				`superdirt(57120): ${dirt ? "listening" : "not listening"}`,
				`repl: ${replUp ? "ready" : replProc ? "booting" : "down"}${replUp ? ` (${Math.round((Date.now() - replBootedAt) / 1000)}s)` : ""}`,
				`last eval: ${lastLabel}`,
			];
			if (ensureNote) parts.push(`(ensure: ${ensureNote})`);
			if (!sc.alive && sclangTail.length > 0) {
				parts.push("sclang tail:\n" + sclangTail.slice(-8).join("\n"));
			}
			return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
		},
	});

	// ---------- stream / audition tools ----------
	// snapshotLive: read the LIVE stack's deck scan and write sc/audition/reports/
	// live.json (lane 3 reads it for diffVsLive). Metering only — ~deckScanStart
	// adds read-only meter synths and ~orbitScanStop removes them, so the live mix
	// is never touched. Never boots a stack: an absent/silent sclang fails soft.
	async function snapshotLiveStack(): Promise<string> {
		if (!sclangProc?.stdin || !weSpawnedSclang) {
			return "live stack is not running under this plugin (no sclang stdin); live.json not written. Start the stack, then retry.";
		}
		const sc = await queryScsynth(1500);
		if (!sc.alive) return "live scsynth is down; live.json not written. Start the stack, then retry.";
		// 6-band master + channel shares come from ~spectrumStart/~spectrumReport —
		// the same bands the audition report uses, so diffVsLive is comparable. The
		// deck scan is used only for per-channel dominant frequency.
		try { scTransport.send("~spectrumStart.value; ~deckScanStart.value;", "[tidal_audition snapshotLive]"); }
		catch (e) { return `snapshotLive: could not reach live sclang: ${e}`; }
		await new Promise((r) => setTimeout(r, 2500)); // follower meters need a beat to build
		const mark = sclangSeq;
		try { scTransport.send("~spectrumReport.value; ~orbitScanReport.value;", "[tidal_audition snapshotLive]"); }
		catch { /* fall through and report the empty scan gracefully */ }
		await new Promise((r) => setTimeout(r, 1500));
		const raw = sclangLinesSince(mark).join("\n").trim();
		try { scTransport.send("~spectrumStop.value; ~orbitScanStop.value;", "[tidal_audition snapshotLive]"); } catch { /* best effort */ }
		const spectrum = parseSpectrumReport(raw);
		const orbit = parseOrbitScanReport(raw);
		const report = buildLiveReport({ spectrum, orbit, raw });
		if (!report.ok) {
			return `snapshotLive: the live spectrum meter returned no readings; live.json not written (is the DSP graph with ~spectrumStart loaded?).\n${raw || "(no sclang output)"}`;
		}
		const outPath = liveSnapshotPath();
		try {
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
		} catch (e) { return `snapshotLive: scan ok but could not write ${outPath}: ${e}`; }
		lastLabel = "tidal_audition snapshotLive";
		updateWidget("snapshot live");
		return `live.json written: ${outPath} (${decks.length} channel(s): ${decks.map((d: any) => d.name).join(", ")})`;
	}

	pi.registerTool({
		name: "tidal_stream",
		label: "Tidal Stream",
		description:
			"Control the low-latency audio stream (the `tidal_stream` tap + streamd daemon). " +
			"start/stop/enable/disable act on the systemd units; status prints the six parseable lines " +
			"(sink, source linked, listeners, frames/sec, dropped, source up|down); url prints the WS URL " +
			"and the tailnet hostname when the box is in a Tailscale tailnet. The stream is independent " +
			"of the Tidal REPL and never needed to make sound.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"), Type.Literal("stop"), Type.Literal("status"),
				Type.Literal("url"), Type.Literal("enable"), Type.Literal("disable"),
			], { description: "stream-ctl verb to run" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const res = runCtl(STREAM_CTL, buildStreamArgs(params.action));
			const raw = res.stdout.trim();
			if (params.action === "status") {
				const parsed = parseStreamStatus(res.stdout);
				const summary = `source: ${parsed.source ?? "?"} | sink: ${parsed.sink ?? "?"} | source linked: ${parsed.sourceLinked === null ? "?" : parsed.sourceLinked ? "yes" : "no"} | listeners: ${parsed.listeners ?? 0} | frames/sec: ${parsed.framesPerSec ?? 0} | dropped: ${parsed.dropped ?? 0}`;
				return { content: [{ type: "text", text: `${summary}\n\n${raw || res.stderr.trim() || "(no output)"}` }], details: parsed };
			}
			if (params.action === "url") {
				return { content: [{ type: "text", text: raw || res.stderr.trim() || "(no url output)" }], details: parseStreamUrl(res.stdout) };
			}
			if (res.code !== 0) {
				return { content: [{ type: "text", text: `stream ${params.action} failed (exit ${res.code}):\n${(res.stderr || res.stdout).trim() || "(no output)"}` }], details: { code: res.code } };
			}
			return { content: [{ type: "text", text: raw || `stream ${params.action}: ok` }], details: {} };
		},
	});

	pi.registerTool({
		name: "tidal_audition",
		label: "Tidal Audition",
		description:
			"Drive the headless audition stack (a mirror of the live DSP graph on scsynth 57111 / SuperDirt 57121). " +
			"start/stop/status manage the stack; submit stages a candidate scene and returns a job id; report polls it " +
			"(returns the raw report JSON, or 'still running' while it renders); jobs lists recent jobs. snapshotLive " +
			"scans the LIVE stack and writes sc/audition/reports/live.json for report diffVsLive — it never boots or " +
			"disturbs the live stack and fails soft when it is down. Nothing here is required to keep playing.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"), Type.Literal("stop"), Type.Literal("status"),
				Type.Literal("submit"), Type.Literal("report"), Type.Literal("jobs"), Type.Literal("snapshotLive"),
			], { description: "audition action" }),
			scene: Type.Optional(Type.String({ description: "path to the .tidal scene to submit" })),
			slot: Type.Optional(Type.Number({ description: "scene channel slot for submit" })),
			cps: Type.Optional(Type.Number({ description: "cycles/sec for submit" })),
			cycles: Type.Optional(Type.Number({ description: "render cycles for submit" })),
			withLive: Type.Optional(Type.Boolean({ description: "provision the render with the live mix for comparison" })),
			id: Type.Optional(Type.String({ description: "job id for report" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (params.action === "snapshotLive") {
				return { content: [{ type: "text", text: await snapshotLiveStack() }], details: {} };
			}
			const res = runCtl(AUDITION_CTL, buildAuditionArgs(params.action, params));
			const raw = res.stdout.trim();
			if (params.action === "submit") {
				if (res.code !== 0) return { content: [{ type: "text", text: `audition submit failed (exit ${res.code}):\n${(res.stderr || res.stdout).trim() || "(no output)"}` }], details: { code: res.code } };
				const id = parseAuditionSubmitId(res.stdout);
				return { content: [{ type: "text", text: `job ${id} submitted; poll with action=report id=${id}\n${raw}` }], details: { id } };
			}
			if (params.action === "report") {
				const report = parseAuditionReport(res.stdout, { exitCode: res.code });
				if (report === null) return { content: [{ type: "text", text: `audition report ${params.id} failed (exit ${res.code}):\n${(res.stderr || res.stdout).trim() || "(no output)"}` }], details: { code: res.code } };
				if (isAuditionStillRunning(res.code) || report.state === "running") {
					return { content: [{ type: "text", text: `job ${params.id} is still running; poll again.\n${raw}` }], details: report };
				}
				return { content: [{ type: "text", text: raw || JSON.stringify(report) }], details: report };
			}
			if (params.action === "jobs") {
				return { content: [{ type: "text", text: raw || "(no jobs)" }], details: { jobs: parseAuditionJobs(res.stdout) } };
			}
			if (params.action === "status") {
				return { content: [{ type: "text", text: raw || res.stderr.trim() || "(no output)" }], details: parseAuditionStatus(res.stdout) };
			}
			if (res.code !== 0) {
				return { content: [{ type: "text", text: `audition ${params.action} failed (exit ${res.code}):\n${(res.stderr || res.stdout).trim() || "(no output)"}` }], details: { code: res.code } };
			}
			return { content: [{ type: "text", text: raw || `audition ${params.action}: ok` }], details: {} };
		},
	});

	// ---------- command ----------
	pi.registerCommand("tidal", {
		description: "tidal stack: /tidal status|hush|restart|scene load A 159.tidal|scene select C 1|scene mix 1 4|scene gain 2 0.25 2|scene morph 0 1 0.4 8|scene cancel|scene stop A|scene leave|record start|mark <label>",
		handler: async (args, ctx) => {
			const arg = (args || "status").trim();
			if (arg === "scene" || arg.startsWith("scene ")) {
				const [, action = "status", ...rest] = arg.split(/\s+/);
				const params = action === "mix" ? { action, mix: Number(rest[0]), cycles: rest[1] === undefined ? 0 : Number(rest[1]) }
					: action === "gain" ? { action, channel: Number(rest[0]), gain: Number(rest[1]), seconds: rest[2] === undefined ? undefined : Number(rest[2]) }
					: action === "morph" ? { action, from: Number(rest[0]), to: Number(rest[1]), toCps: Number(rest[2]), seconds: Number(rest[3]), stepHz: rest[4] === undefined ? undefined : Number(rest[4]) }
					: action === "select" ? { action, deck: rest[0], slot: rest[1] === undefined ? undefined : Number(rest[1]) }
					: { action, deck: rest[0] ?? "A", file: rest.slice(1).join(" ") || undefined };
				try { ctx.ui.notify(await sceneQueue(() => sceneController.action(params, ctx.cwd)), "info"); persistScenes(); }
				catch (error) { ctx.ui.notify(`tidal scene: ${error}`, "error"); }
				return;
			}
			if (arg === "record" || arg.startsWith("record ")) {
				const sub = arg.slice(6).trim() || "status";
				if (sub === "start") {
					ctx.ui.notify("tidal: " + await startRecording(ctx.cwd), "info");
				} else if (sub === "stop") {
					ctx.ui.notify("tidal: " + await stopRecording(), "info");
				} else {
					ctx.ui.notify(recActive
						? `tidal: recording ${path.basename(recPath)} via ${recVia}, ${Math.round((Date.now() - recStartedAt) / 1000)}s`
						: "tidal: not recording", "info");
				}
				return;
			}
			if (arg === "mark" || arg.startsWith("mark ")) {
				const label = arg.slice(4).trim();
				if (!recActive) {
					ctx.ui.notify("tidal: not recording — /tidal record start first", "error");
					return;
				}
				writeMarker(label || "mark");
				ctx.ui.notify(`tidal: marked "${label || "mark"}" at ${Math.round((Date.now() - recStartedAt) / 100) / 10}s`, "info");
				return;
			}
			if (arg === "hush") {
				await leaveScenesForHush();
				if (sendChunk("hush")) ctx.ui.notify("tidal: hush sent", "info");
				else ctx.ui.notify("tidal: repl not ready", "error");
				return;
			}
			if (arg === "restart") {
				const msg = await sceneQueue(async () => {
					await lifecycle(() => teardown());
					return ensureStack(ctx.cwd);
				});
				ctx.ui.notify(`tidal: ${msg}`, isStackReady(msg) ? "info" : "error");
				return;
			}
			const sc = await queryScsynth();
			scsynthCached = sc;
			const msg = `scsynth ${sc.alive ? `up (${sc.synths} synths)${weSpawnedSclang ? "" : " foreign"}` : "down"} | superdirt ${udpPortListening(SUPERDIRT_PORT) ? "up" : "down"} | repl ${replReady ? "ready" : "down"} | last: ${lastLabel}`;
			ctx.ui.notify(`tidal: ${msg}`, sc.alive ? "info" : "warning");
			updateWidget();
		},
	});
}
