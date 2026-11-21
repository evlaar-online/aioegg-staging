#!/usr/bin/env node

var startupCmd = "";
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const {
	createGameOutputHandler,
	createRconCommandTracker,
	createRconMessageHandler,
	createConsoleInputHandler,
	createTimestampedLogWriter,
	expandLogFilePath,
	formatPosixDate
} = require("./wrapper-helpers");

// LOG_FILE is a timestamped transcript of the panel console. console.log stays unstamped
// so Wings and the live console are unchanged. Rust's own -logfile is /dev/null.
let consoleLogFd = null;
function closeConsoleLog() {
	if (consoleLogFd == null) return;
	const fd = consoleLogFd;
	consoleLogFd = null;
	try { fs.closeSync(fd); } catch (e) {}
}

function openConsoleLog() {
	let logPath = "";
	try {
		logPath = expandLogFilePath(process.env.LOG_FILE, (format) => formatPosixDate(format, new Date()));
	} catch (e) {
		console.log("Console log path is invalid: " + (e && e.message ? e.message : e));
		return () => {};
	}
	if (!logPath) return () => {};

	try {
		const dir = path.dirname(logPath);
		if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
		consoleLogFd = fs.openSync(logPath, "a");
	} catch (e) {
		consoleLogFd = null;
		console.log("Failed to open console log " + logPath + ": " + (e && e.message ? e.message : e));
		return () => {};
	}

	let failed = false;
	return createTimestampedLogWriter({
		writeLine(line) {
			if (failed || consoleLogFd == null) return;
			try {
				fs.writeSync(consoleLogFd, line);
			} catch (err) {
				failed = true;
				console.log("Console log write failed: " + (err && err.message ? err.message : err));
			}
		}
	});
}

const writeConsoleLog = openConsoleLog();
const writePanel = (text) => {
	console.log(text);
	writeConsoleLog(text);
};

var args = process.argv.splice(process.execArgv.length + 2);
for (var i = 0; i < args.length; i++) {
	if (i === args.length - 1) {
		startupCmd += args[i];
	} else {
		startupCmd += args[i] + " ";
	}
}

if (startupCmd.length < 1) {
	writePanel("Error: Please specify a startup command.");
	closeConsoleLog();
	process.exit();
}

const seenPercentage = {};

function filterLine(line) {
    const str = String(line).replace(/\r/g, "");
    if (!str) return null;
    if(str.startsWith("Fallback handler could not load library")) return null; // Remove fallback
    if(str.includes("Filename:")) return null; //Remove bindings.h
	if(str.includes("ERROR: Shader ")) return null; //Remove shader errors
	if(str.includes("WARNING: Shader ")) return null; //Remove shader errors
    if (str.startsWith("Loading Prefab Bundle ")) { // Rust seems to spam the same percentage, so filter out any duplicates.
        const percentage = str.substr("Loading Prefab Bundle ".length);
        if (seenPercentage[percentage]) return null;

        seenPercentage[percentage] = true;
    }

    return str;
}

const { spawn } = require("child_process");
writePanel("Starting Rust...");

// Networking/runtime mitigations for Mono/Unity
// - Disable IPv6 in Mono to avoid dual-stack socket issues on some hosts
process.env.MONO_DISABLE_IPV6 = process.env.MONO_DISABLE_IPV6 || '1';
process.env.DOTNET_SYSTEM_NET_DISABLEIPV6 = process.env.DOTNET_SYSTEM_NET_DISABLEIPV6 || '1';
// Optional: enable verbose Mono logging via env toggle MONO_LOGGING
// Accepts: 1/true/yes/on (case-insensitive)
const _monoLoggingRaw = (process.env.MONO_LOGGING || '').toLowerCase();
const _monoLogging = _monoLoggingRaw === '1' || _monoLoggingRaw === 'true' || _monoLoggingRaw === 'yes' || _monoLoggingRaw === 'on';
if (_monoLogging) {
    process.env.MONO_LOG_LEVEL = process.env.MONO_LOG_LEVEL || 'debug';
    process.env.MONO_LOG_MASK = process.env.MONO_LOG_MASK || 'all';
    process.env.MONO_LOG_DEST = process.env.MONO_LOG_DEST || 'file:/home/container/mono-debug.log';
}

// Optional: prevent stdio fds (0/1/2) from being closed via LD_PRELOAD shim
// Controlled by PREVENT_FD toggle: 1/true/yes/on
const _preventFdRaw = (process.env.PREVENT_FD || '').toLowerCase();
const _preventFd = _preventFdRaw === '1' || _preventFdRaw === 'true' || _preventFdRaw === 'yes' || _preventFdRaw === 'on';
if (_preventFd) {
    const preloadPath = '/usr/local/lib/libkeepstdio.so';
    process.env.LD_PRELOAD = process.env.LD_PRELOAD
        ? `${preloadPath}:${process.env.LD_PRELOAD}`
        : preloadPath;
}

// Prefer keeping stdin (fd 0) open to avoid Mono fd reuse
// Spawn via bash -lc to preserve shell expansions present in the startup string
var exited = false;
// Ensure child stdin (fd 0) is a valid file descriptor (map to /dev/null)
// This avoids Mono reusing fd 0 for sockets/files and aborting.
// When MONO_LOGGING is enabled, also run under a PTY via `script` to provide a
// controlling terminal which further reduces the chance of stdio being closed.
let usePty = _monoLogging; // tie PTY usage to MONO_LOGGING as requested
// If PREVENT_FD is enabled, prefer launching directly via bash to avoid any env sanitization by `script`
if (_preventFd) usePty = false;
const spawnCmd = usePty ? 'script' : 'bash';
const spawnArgs = usePty
    ? ['-qfec', startupCmd, '/dev/null']
    : ['-lc', startupCmd];

const gameProcess = spawn(spawnCmd, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
});
// If MONO_LOGGING is enabled, tee raw stdout/stderr to mono-debug.log as a fallback
let monoLogStream = null;
if (_monoLogging) {
    try {
        monoLogStream = fs.createWriteStream('/home/container/mono-debug.log', { flags: 'a' });
    } catch (e) {
        writePanel('Failed to open mono-debug.log for writing: ' + (e?.message || e));
    }
}

// Child stdout/stderr are the sole source of game output in the panel. Each
// stream has exactly one permanent listener for the lifetime of the process.
gameProcess.stdout.on("data", createGameOutputHandler(writePanel, filterLine, () => monoLogStream));
gameProcess.stderr.on("data", createGameOutputHandler(writePanel, filterLine, () => monoLogStream));
gameProcess.on('exit', function (code, signal) {
	exited = true;
	stopRconLifecycle();

	if (code) writePanel("Main game process exited with code " + code);
	else if (signal) writePanel("Main game process exited from signal " + signal);
    if (monoLogStream) {
        try { monoLogStream.end(); } catch {}
    }
	try { rl.close(); } catch {}
	process.stdin.pause();
	closeConsoleLog();
	process.exitCode = typeof code === "number" ? code : 1;
});

process.on('exit', function (code) {
	if (!exited) {
		writePanel("Received request to stop the process, stopping the game...");
		gameProcess.kill('SIGTERM');
	}
	closeConsoleLog();
});

function createPacket(command, identifier) {
	var packet = {
		Identifier: identifier === undefined ? -1 : identifier,
		Message: command,
		Name: "WebRcon"
	};
	return JSON.stringify(packet);
}

var consoleSocket = null;
var activeSocket = null;
var retryTimer = null;
var attemptId = 0;
var dialing = false;
var connectedOnce = false;
var retryWarningShown = false;

const rconTracker = createRconCommandTracker({
	ttlMs: 30000,
	maxPending: 256
});

// Container PTY /dev/pts/0 runs with -echo (stty ECHO off), so print typed
// commands explicitly so they remain visible in the Pterodactyl console.
const handleConsoleLine = createConsoleInputHandler({
	getSocket: () => consoleSocket,
	isSocketOpen: (ws) => Boolean(ws && ws.readyState === (ws.OPEN || 1)),
	tracker: rconTracker,
	write: writePanel,
	echoCommand: true,
	onQuit: () => gameProcess.kill("SIGTERM")
});

const rl = readline.createInterface({
	input: process.stdin,
	crlfDelay: Infinity
});
rl.on("line", handleConsoleLine);

function stopRconLifecycle() {
	attemptId++;
	dialing = false;
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	var socket = activeSocket;
	activeSocket = null;
	consoleSocket = null;
	if (!socket) return;
	try { socket.removeAllListeners(); } catch (e) {}
	try { socket.terminate(); } catch (e) {}
}

function splitJsonObjects(text) {
	var out = [];
	var depth = 0;
	var start = -1;
	var inStr = false;
	var esc = false;
	for (var i = 0; i < text.length; i++) {
		var ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === "\"") inStr = false;
			continue;
		}
		if (ch === "\"") {
			inStr = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				try {
					out.push(JSON.parse(text.slice(start, i + 1)));
				} catch (e) {}
				start = -1;
			}
		}
	}
	return out;
}

function payloadsFromFrame(data) {
	var text = Buffer.isBuffer(data) ? data.toString() : String(data);
	try {
		var one = JSON.parse(text);
		return one === undefined ? [] : [one];
	} catch (e) {
		var parts = splitJsonObjects(text);
		if (!parts.length && e) writePanel("Invalid RCON payload: " + e.message);
		return parts;
	}
}

const handleRconMessage = createRconMessageHandler(payloadsFromFrame, {
	tracker: rconTracker,
	write: writePanel
});

var poll = function () {
	if (exited || dialing || activeSocket) return;

	dialing = true;
	var myId = ++attemptId;
	var serverHostname = process.env.RCON_IP ? process.env.RCON_IP : "localhost";
	var serverPort = process.env.RCON_PORT;
	var serverPassword = process.env.RCON_PASS;
	var WebSocket = require("ws");
	var ws = new WebSocket("ws://" + serverHostname + ":" + serverPort + "/" + serverPassword);
	activeSocket = ws;
	var finished = false;
	var errorTimer = null;

	function finish(wasConnected) {
		if (finished) return;
		finished = true;
		dialing = false;
		if (errorTimer) {
			clearTimeout(errorTimer);
			errorTimer = null;
		}
		try { ws.removeAllListeners(); } catch (e) {}
		if (activeSocket === ws) activeSocket = null;
		if (consoleSocket === ws) consoleSocket = null;
		if (ws.readyState === 0 || ws.readyState === 1) {
			try { ws.terminate(); } catch (e) {}
		}
		if (exited || myId !== attemptId) return;
		if (wasConnected) {
			if (!retryWarningShown) {
				retryWarningShown = true;
				writePanel("RCON disconnected; Rust is still running. Retrying...");
			}
		} else {
			writePanel("Waiting for RCON to come up...");
		}
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = setTimeout(function () {
			retryTimer = null;
			poll();
		}, wasConnected ? 1000 : 5000);
	}

	ws.on("open", function open() {
		if (finished || myId !== attemptId || activeSocket !== ws) {
			finished = true;
			try { ws.removeAllListeners(); } catch (e) {}
			try { ws.terminate(); } catch (e) {}
			return;
		}
		dialing = false;
		consoleSocket = ws;
		retryWarningShown = false;
		if (!connectedOnce) {
			connectedOnce = true;
			writePanel("Connected to RCON. Generating the map now. Please wait until the server status switches to \"Running\".");
		} else {
			writePanel("Reconnected to RCON.");
		}

		// Hack to fix broken console output (kept untracked with Identifier -1)
		try { ws.send(createPacket("status")); } catch (e) {}
	});

	ws.on("message", function (data) {
		if (ws !== consoleSocket) return;
		// Only print replies matching positive tracked command Identifiers.
		// Broadcast frames (Identifier <= 0) are ignored because child stdout/stderr
		// already provide the panel's complete game log.
		handleRconMessage(data);
	});

	ws.on("error", function () {
		if (finished || myId !== attemptId || activeSocket !== ws) return;
		if (ws.readyState === 1) return;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(function () {
			errorTimer = null;
			if (finished || myId !== attemptId || activeSocket !== ws) return;
			finish(consoleSocket === ws);
		}, 250);
	});

	ws.on("close", function () {
		if (finished || myId !== attemptId || activeSocket !== ws) return;
		if (errorTimer) {
			clearTimeout(errorTimer);
			errorTimer = null;
		}
		finish(consoleSocket === ws);
	});
}
poll();
