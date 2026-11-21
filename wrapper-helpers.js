"use strict";

const DEFAULT_RCON_TTL_MS = 30000;
const DEFAULT_MAX_PENDING_COMMANDS = 256;
const MAX_RCON_IDENTIFIER = 0x7fffffff;

function createGameOutputHandler(write, filterLine, getLogStream) {
	let pending = "";

	return function onGameOutput(data) {
		const logStream = getLogStream && getLogStream();
		if (logStream) logStream.write(data);

		pending += data.toString();
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			const filtered = filterLine(line);
			if (filtered != null) write(filtered);
			newline = pending.indexOf("\n");
		}
	};
}

function createRconCommandTracker(options = {}) {
	const ttlMs = typeof options.ttlMs === "number" && options.ttlMs > 0
		? options.ttlMs
		: DEFAULT_RCON_TTL_MS;
	const maxPending = typeof options.maxPending === "number" && options.maxPending > 0
		? Math.floor(options.maxPending)
		: DEFAULT_MAX_PENDING_COMMANDS;
	const maxIdentifier = typeof options.maxIdentifier === "number" && options.maxIdentifier >= 1
		? Math.floor(options.maxIdentifier)
		: MAX_RCON_IDENTIFIER;
	const now = typeof options.now === "function" ? options.now : Date.now;

	let nextIdentifier = 1;
	const pending = new Map();

	function prune(timestamp) {
		for (const [id, expiresAt] of pending) {
			if (expiresAt <= timestamp) {
				pending.delete(id);
			}
		}
	}

	function allocate() {
		const timestamp = now();
		prune(timestamp);

		while (pending.size >= maxPending) {
			const oldestId = pending.keys().next().value;
			if (oldestId === undefined) break;
			pending.delete(oldestId);
		}

		let id = nextIdentifier;
		let attempts = 0;
		while (pending.has(id) && attempts < maxPending) {
			id = id >= maxIdentifier ? 1 : id + 1;
			attempts++;
		}

		nextIdentifier = id >= maxIdentifier ? 1 : id + 1;
		pending.set(id, timestamp + ttlMs);
		return id;
	}

	function has(rawId) {
		if (typeof rawId !== "number" && (typeof rawId !== "string" || rawId.trim() === "")) {
			return false;
		}
		const id = Number(rawId);
		if (!Number.isInteger(id) || id <= 0) return false;
		prune(now());
		return pending.has(id);
	}

	function remove(id) {
		return pending.delete(id);
	}

	function size() {
		prune(now());
		return pending.size;
	}

	return {
		allocate,
		has,
		remove,
		size
	};
}

function createRconMessageHandler(parseFrame, options = {}) {
	const tracker = options.tracker || null;
	const write = typeof options.write === "function" ? options.write : () => {};
	const markReady = typeof options.markReady === "function" ? options.markReady : null;
	let readyMarked = false;

	return function onRconMessage(data) {
		const payloads = parseFrame(data);
		if (!Array.isArray(payloads)) return [];

		for (let i = 0; i < payloads.length; i++) {
			const json = payloads[i];
			if (!json || typeof json !== "object") continue;

			if (markReady && !readyMarked) {
				readyMarked = true;
				markReady();
			}

			if (!tracker || !tracker.has(json.Identifier)) continue;

			if (typeof json.Message === "string" && json.Message.length > 0) {
				const message = json.Message.replace(/\r/g, "");
				if (message.length > 0) write(message);
			}
			if (typeof json.Stacktrace === "string" && json.Stacktrace.trim().length > 0) {
				write(json.Stacktrace.replace(/\r/g, ""));
			}
		}

		return payloads;
	};
}

function createConsoleInputHandler(options) {
	const getSocket = options.getSocket;
	const isSocketOpen = typeof options.isSocketOpen === "function"
		? options.isSocketOpen
		: (ws) => Boolean(ws && ws.readyState === (ws.OPEN || 1));
	const tracker = options.tracker;
	const write = typeof options.write === "function" ? options.write : () => {};
	const echoCommand = options.echoCommand !== undefined ? Boolean(options.echoCommand) : true;
	const onQuit = typeof options.onQuit === "function" ? options.onQuit : null;

	return function onConsoleLine(rawLine) {
		const line = String(rawLine == null ? "" : rawLine).trim();
		if (!line) return false;

		if (echoCommand) {
			write(`> ${line}`);
		}

		const ws = getSocket ? getSocket() : null;
		if (isSocketOpen(ws)) {
			const id = tracker.allocate();
			const packet = JSON.stringify({
				Identifier: id,
				Message: line,
				Name: "WebRcon"
			});
			try {
				ws.send(packet);
				return true;
			} catch (err) {
				tracker.remove(id);
				write("Failed to send RCON command: " + (err && err.message ? err.message : err));
				return false;
			}
		}

		if (line === "quit" && onQuit) {
			onQuit();
			return false;
		}

		write("RCON not connected; command not sent.");
		return false;
	};
}

function formatPosixDate(format, date) {
	const pad = (n) => String(n).padStart(2, "0");
	const tokens = {
		"%": "%",
		Y: String(date.getFullYear()),
		y: String(date.getFullYear()).slice(-2),
		m: pad(date.getMonth() + 1),
		d: pad(date.getDate()),
		H: pad(date.getHours()),
		M: pad(date.getMinutes()),
		S: pad(date.getSeconds()),
		s: String(Math.floor(date.getTime() / 1000))
	};
	return String(format).replace(/%(.)/g, (all, code) => (Object.prototype.hasOwnProperty.call(tokens, code) ? tokens[code] : all));
}

function formatLogTimestamp(date) {
	return formatPosixDate("%Y-%m-%d %H:%M:%S", date);
}

// Expands the egg's $(date +FORMAT) path token once. Other text is kept as a literal path.
function expandLogFilePath(raw, formatDate) {
	const value = String(raw == null ? "" : raw).trim();
	if (!value) return "";
	return value.replace(/\$\(date \+([^)\r\n]+)\)/g, (_, format) => formatDate(format));
}

// Prefixes each console line for the log file. The caller still prints the original text.
function createTimestampedLogWriter(options) {
	const now = typeof options.now === "function" ? options.now : () => new Date();
	const writeLine = options.writeLine;

	return function writeTimestamped(text) {
		const stamp = formatLogTimestamp(now());
		const parts = String(text == null ? "" : text).replace(/\r/g, "").split("\n");
		let out = "";
		for (let i = 0; i < parts.length; i++) {
			if (!parts[i]) continue;
			out += stamp + " " + parts[i] + "\n";
		}
		if (out) writeLine(out);
	};
}

module.exports = {
	createGameOutputHandler,
	createRconCommandTracker,
	createRconMessageHandler,
	createConsoleInputHandler,
	formatPosixDate,
	formatLogTimestamp,
	expandLogFilePath,
	createTimestampedLogWriter
};
