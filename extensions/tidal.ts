// tidal.ts — pi extension for livecoding TidalCycles
//
// - Lazily ensures the SuperDirt stack is up (sclang + scsynth via pipewire's
//   libjack) and a Tidal REPL (ghci + BootTidal.hs) is running.
// - Auto-evaluates changed chunks of *.tidal files after pi write/edit calls
//   (chunks = blank-line separated blocks, per the repo README convention).
// - Feeds REPL errors back into the agent context as user messages.
// - Tools: tidal_eval, tidal_hush, tidal_status. Command: /tidal.

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as dgram from "node:dgram";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PW_JACK = "/usr/lib/x86_64-linux-gnu/pipewire-0.3/jack";
const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url)); // .../pi-tidal/extensions/
const SCSYNTH_PORT = 57110;
const SUPERDIRT_PORT = 57120;
const DEBUG = !!process.env.TIDAL_EXT_DEBUG;
function dbg(...args: unknown[]) { if (DEBUG) console.error("[tidal-ext]", ...args); }

export default function (pi: ExtensionAPI) {
	// ---------- state ----------
	let sclangProc: cp.ChildProcess | null = null;
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
	let sclangTail: string[] = []; // ring buffer of sclang stdout for diagnosis
	let lastChunks: string[] = []; // recently sent chunks, re-fired after revival
	let bootTailLen = 0; // sclangTail index where the current boot started
	let replStdoutBuf = "";
	let watchdog: ReturnType<typeof setInterval> | null = null;

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
	function killStack() {
		try { cp.execSync("pkill -u $USER -x sclang", { stdio: "ignore" }); } catch { /* none running */ }
		try { cp.execSync("pkill -u $USER -x scsynth", { stdio: "ignore" }); } catch { /* none running */ }
	}

	function startSclang(): void {
		killStack();
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
		const inhibit = fs.existsSync("/usr/bin/systemd-inhibit");
		const cmd = inhibit ? "systemd-inhibit" : "sclang";
		const args = inhibit ? ["--what=sleep", "--mode=block", "--who=pi-tidal", "sclang"] : [];
		sclangProc = cp.spawn(cmd, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
		weSpawnedSclang = true;
		sclangTail = [];
		bootTailLen = 0; // marker into sclangTail for this boot
		sclangProc.stdout?.on("data", (d: Buffer) => {
			for (const line of d.toString().split("\n")) {
				sclangTail.push(line);
				if (sclangTail.length > 40) sclangTail.shift();
			}
		});
		sclangProc.stderr?.on("data", () => {});
		sclangProc.on("exit", () => { sclangProc = null; });
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
		replProc = cp.spawn("ghci", ["-ghci-script", boot], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		stderrLines = [];
		replStdoutBuf = "";
		replProc.stdout?.on("data", (d: Buffer) => {
			const text = d.toString();
			dbg("repl stdout:", JSON.stringify(text.slice(0, 80)));
			// ghci stdout arrives in tiny pipe-sized fragments; match against a
			// rolling buffer, not individual chunks
			replStdoutBuf = (replStdoutBuf + text).slice(-600);
			if (!replReady && /Connected to SuperDirt|Listening for external controls/.test(replStdoutBuf)) {
				replReady = true;
				flushQueue();
				updateWidget("repl ready");
			}
		});
		// poke stdin so ghci flushes its prompt through the block-buffered pipe
		setTimeout(() => { try { replProc?.stdin?.write("\n"); } catch { /* gone */ } }, 5000);
		setInterval(() => { if (!replReady) { try { replProc?.stdin?.write("\n"); } catch { /* gone */ } } }, 10_000).unref();
		replProc.stderr?.on("data", (d: Buffer) => handleStderr(d.toString()));
		replProc.on("exit", () => { replProc = null; replReady = false; updateWidget("repl exited"); });
	}

	function serverListeningSinceBoot(): boolean {
		return sclangTail.slice(bootTailLen).some((l) => l.includes("listening on port 57120"));
	}

	function serverDiedSinceBoot(): boolean {
		return sclangTail.slice(bootTailLen).some((l) => l.includes("exited with exit code"));
	}

	async function ensureStack(cwd: string): Promise<string> {
		const st = await queryScsynth();
		if (!st.alive) {
			// NOTE: do NOT wait on OSC /status replies here. While sclang churns
			// through its startup (synthdef compile + 450MB sample read), scsynth's
			// stdout pipe backs up into the busy interpreter and scsynth stops
			// answering UDP for 30-90s. sclang's own post output ("SuperDirt:
			// listening on port 57120") is the reliable boot signal.
			for (let attempt = 1; attempt <= 2; attempt++) {
				startSclang();
				const ok = await waitFor(() => serverListeningSinceBoot() || serverDiedSinceBoot(), 150_000, 2000);
				dbg("boot wait result:", ok, "died:", serverDiedSinceBoot());
				if (ok && !serverDiedSinceBoot()) break;
				if (attempt === 2) return "scsynth did not boot (2 attempts); sclang tail:\n" + sclangTail.slice(-12).join("\n");
				dbg("scsynth boot attempt failed, retrying");
			}
		}
		if (!udpPortListening(SUPERDIRT_PORT)) {
			await waitFor(() => udpPortListening(SUPERDIRT_PORT), 60_000);
		}
		if (!replProc) startRepl(cwd);
		const replOk = await waitFor(() => replReady, 90_000, 1000);
		startWatchdog();
		return replOk ? "stack ready" : "repl did not become ready within 90s";
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
			if (reviving || !weSpawnedSclang) return;
			if (Date.now() - lastReviveAt < 15_000) return;
			const sc = await queryScsynth(3000);
			scsynthCached = sc;
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
				teardown();
				const msg = await ensureStack(cwd);
				lastReviveAt = Date.now();
				if (msg.includes("ready")) {
					// re-fire recent chunks so patterns lost to the resume come back
					for (const c of [...lastChunks]) {
						if (replReady) sendChunk(c);
					}
					updateWidget("stack revived + patterns re-fired");
				} else {
					updateWidget(`revive failed: ${msg.slice(0, 40)}`);
				}
			} finally {
				reviving = false;
			}
		}, 10_000);
	}

	function teardown(): void {
		if (watchdog) { clearInterval(watchdog); watchdog = null; }
		if (replProc) { try { replProc.kill("SIGTERM"); } catch { /* gone */ } }
		if (sclangProc) {
			try { sclangProc.kill("SIGTERM"); } catch { /* gone */ }
			setTimeout(() => {
				// the systemd-inhibit wrapper does not forward signals to sclang,
				// so make sure no orphans survive teardown
				try { cp.execSync("pkill -u $USER -x sclang", { stdio: "ignore" }); } catch { /* none */ }
				try { cp.execSync("pkill -u $USER -x scsynth", { stdio: "ignore" }); } catch { /* none */ }
			}, 1500);
		}
		replProc = null;
		sclangProc = null;
		replReady = false;
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
		const wrapped = ":{\n" + chunk + "\n:}\n";
		replProc.stdin.write(wrapped);
		lastChunks.push(chunk);
		if (lastChunks.length > 12) lastChunks.shift();
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

	function evalChangedChunks(filePath: string, cwd: string): void {
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf-8");
		} catch {
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
	function handleStderr(text: string): void {
		for (const line of text.split("\n")) {
			stderrLines.push(line);
			if (stderrLines.length > 60) stderrLines.shift();
			if (!replReady) continue; // ignore ghci boot noise
			if (!/(error|Exception|not in scope|parse error|Cannot interpolate|Variable not)/i.test(line)) continue;
			if (line.trim().startsWith("--") || /Suggested fix/.test(line)) continue;

			const excerpt = stderrLines.slice(-10).join("\n").trim();
			const now = Date.now();
			if (excerpt === lastErrorExcerpt && now - lastErrorAt < 20_000) continue; // rate-limit dupes
			lastErrorExcerpt = excerpt;
			lastErrorAt = now;
			updateWidget(`ERROR: ${line.trim().slice(0, 60)}`);
			pi.sendUserMessage(
				`[tidal] REPL error after evaluating ${lastLabel}:\n\`\`\`\n${excerpt}\n\`\`\`\nFix the chunk and re-save it.`,
				{ deliverAs: "followUp" },
			);
		}
	}

	// ---------- UI ----------
	function updateWidget(extra?: string): void {
		if (!piHasUI) return;
		const sc = scsynthCached;
		const lines = [
			`tidal: scsynth ${sc.alive ? `✓ (${sc.synths} synths)` : "✗"} | repl ${replReady ? "✓" : replProc ? "…" : "✗"} | last: ${lastLabel}`,
		];
		if (extra) lines.push(extra);
		try { piSetWidget(lines); } catch { /* UI unavailable */ }
	}

	// These are captured lazily because ctx isn't available at factory time.
	let piHasUI = false;
	let scsynthCached = { alive: false, synths: 0, ugens: 0 };
	function piSetWidget(lines: string[]): void {
		// setWidget needs a context; use the last registered command ctx trick:
		// instead we stash a UI-facing callback set during session_start.
		widgetSink?.(lines);
	}
	let widgetSink: ((lines: string[]) => void) | null = null;

	// ---------- lifecycle ----------
	pi.on("session_start", async (_event, ctx) => {
		piHasUI = ctx.hasUI;
		widgetSink = (lines) => {
			try { ctx.ui.setWidget("tidal", lines); } catch { /* ignore */ }
		};
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

	pi.on("session_shutdown", async () => {
		teardown();
	});

	// ---------- auto-eval on edit ----------
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const p = (event.input as { path?: string } | undefined)?.path;
		if (!p || !p.endsWith(".tidal")) return;
		// only auto-eval files inside the project
		const rel = path.relative(ctx.cwd, p);
		if (rel.startsWith("..")) return;
		scheduleEval(p, ctx.cwd);
	});

	// ---------- tools ----------
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
			if (!status.includes("ready")) {
				return { content: [{ type: "text", text: `tidal_eval failed: ${status}` }], details: {} };
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
			const sc = await queryScsynth();
			scsynthCached = sc;
			const dirt = udpPortListening(SUPERDIRT_PORT);
			const replUp = !!replProc && replReady;
			updateWidget();
			const parts = [
				`scsynth: ${sc.alive ? `up, ${sc.synths} synths, ${sc.ugens} ugens` : "DOWN"}`,
				`superdirt(57120): ${dirt ? "listening" : "not listening"}`,
				`repl: ${replUp ? "ready" : replProc ? "booting" : "down"}${replUp ? ` (${Math.round((Date.now() - replBootedAt) / 1000)}s)` : ""}`,
				`last eval: ${lastLabel}`,
			];
			if (!sc.alive && sclangTail.length > 0) {
				parts.push("sclang tail:\n" + sclangTail.slice(-8).join("\n"));
			}
			if (!sc.alive || !dirt || !replUp) {
				parts.push(`(run ensure: ${await ensureStack(ctx.cwd)})`);
			}
			return { content: [{ type: "text", text: parts.join("\n") }], details: {} };
		},
	});

	// ---------- command ----------
	pi.registerCommand("tidal", {
		description: "tidal stack: /tidal [status|hush|restart]",
		handler: async (args, ctx) => {
			const arg = (args || "status").trim();
			if (arg === "hush") {
				if (sendChunk("hush")) ctx.ui.notify("tidal: hush sent", "info");
				else ctx.ui.notify("tidal: repl not ready", "error");
				return;
			}
			if (arg === "restart") {
				teardown();
				killStack();
				const msg = await ensureStack(ctx.cwd);
				ctx.ui.notify(`tidal: ${msg}`, msg.includes("ready") ? "info" : "error");
				return;
			}
			const sc = await queryScsynth();
			scsynthCached = sc;
			const msg = `scsynth ${sc.alive ? `up (${sc.synths} synths)` : "down"} | superdirt ${udpPortListening(SUPERDIRT_PORT) ? "up" : "down"} | repl ${replReady ? "ready" : "down"} | last: ${lastLabel}`;
			ctx.ui.notify(`tidal: ${msg}`, sc.alive ? "info" : "warning");
			updateWidget();
		},
	});
}
