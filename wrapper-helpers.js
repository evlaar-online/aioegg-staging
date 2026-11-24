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

function isUnsolicitedRconBroadcast(rawId) {
	if (typeof rawId !== "number" && (typeof rawId !== "string" || rawId.trim() === "")) {
		return true;
	}
	const id = Number(rawId);
	return !Number.isInteger(id) || id <= 0;
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

			// Server console broadcasts use Identifier <= 0 and are already on stdout.
			if (isUnsolicitedRconBroadcast(json.Identifier)) continue;
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
	return formatPosixDate("%d-%m-%Y %H:%M:%S", date);
}

// Current d-m-Y stamps, plus the previous Y-m-d stamps so a followed log is not stamped twice.
const LOG_TIMESTAMP_PREFIX = /^(?:(\d{2}-\d{2}-\d{4})|(\d{4}-\d{2}-\d{2})) \d{2}:\d{2}:\d{2} /;

function hasLogTimestamp(line) {
	return LOG_TIMESTAMP_PREFIX.test(String(line));
}

function unstampedLogLine(line) {
	return String(line).replace(LOG_TIMESTAMP_PREFIX, "");
}

function stampLogLines(text, date) {
	const stamp = formatLogTimestamp(date);
	const parts = String(text == null ? "" : text).replace(/\r/g, "").split("\n");
	const lines = [];
	for (let i = 0; i < parts.length; i++) {
		if (!parts[i]) continue;
		lines.push(hasLogTimestamp(parts[i]) ? parts[i] : stamp + " " + parts[i]);
	}
	return lines;
}

function readShellArg(text, start) {
	const quote = text[start];
	if (quote === "\"" || quote === "'") {
		let end = start + 1;
		while (end < text.length && text[end] !== quote) end++;
		return { value: text.slice(start + 1, end), end: Math.min(end + 1, text.length) };
	}
	let end = start;
	while (end < text.length) {
		if (text[end] === "$" && text[end + 1] === "(") {
			end += 2;
			let depth = 1;
			while (end < text.length && depth > 0) {
				if (text[end] === "(") depth++;
				else if (text[end] === ")") depth--;
				end++;
			}
			continue;
		}
		if (/\s/.test(text[end])) break;
		end++;
	}
	return { value: text.slice(start, end), end };
}

// Unity -logfile <file> keeps the player log off stdout. Point that argument at
// stdout and remember the file so it can be followed if Unity still writes it.
function retargetUnityLogfile(startup) {
	const source = String(startup);
	const marker = /(^|\s)-logfile(?:\s+|=)/g;
	let unityLogPath = "";
	let out = "";
	let last = 0;
	let match;
	while ((match = marker.exec(source)) !== null) {
		const lead = match[1];
		const argPos = marker.lastIndex;
		const arg = readShellArg(source, argPos);
		if (arg.end <= argPos) {
			marker.lastIndex = match.index + match[0].length;
			out += source.slice(last, marker.lastIndex);
			last = marker.lastIndex;
			continue;
		}
		out += source.slice(last, match.index) + lead;
		if (!arg.value || arg.value === "-") {
			out += source.slice(match.index + lead.length, arg.end);
		} else {
			unityLogPath = arg.value;
			out += "-logfile -";
		}
		last = arg.end;
		marker.lastIndex = arg.end;
	}
	out += source.slice(last);
	return { startup: out, unityLogPath };
}

// One player-log occurrence may arrive on stdout, stderr, the Unity log file,
// and again inside a tracked RCON command reply. The first source is kept.
// A later source of that same occurrence is dropped. A repeated line on the
// same source is a new occurrence and is kept.
function createLogLineDeduper(limit) {
	const max = typeof limit === "number" && limit > 0 ? Math.floor(limit) : 500;
	const slots = [];

	return function accept(source, rawLine) {
		const key = unstampedLogLine(rawLine);
		if (!key) return false;
		const existing = slots.find((slot) => slot.key === key && !slot.seen[source]);
		if (existing) {
			existing.seen[source] = true;
			return false;
		}
		slots.push({ key, seen: { [source]: true } });
		if (slots.length > max) slots.shift();
		return true;
	};
}

// Expands the egg's $(date +FORMAT) path token once. Other text is kept as a literal path.
function expandLogFilePath(raw, formatDate) {
	const value = String(raw == null ? "" : raw).trim();
	if (!value) return "";
	return value.replace(/\$\(date \+([^)\r\n]+)\)/g, (_, format) => formatDate(format));
}

// Prefixes each log line once. Lines that already start with YYYY-MM-DD HH:MM:SS are unchanged.
function createTimestampedLogWriter(options) {
	const now = typeof options.now === "function" ? options.now : () => new Date();
	const writeLine = options.writeLine;

	return function writeTimestamped(text) {
		const lines = stampLogLines(text, now());
		if (lines.length) writeLine(lines.join("\n") + "\n");
	};
}

module.exports = {
	createGameOutputHandler,
	createRconCommandTracker,
	isUnsolicitedRconBroadcast,
	createRconMessageHandler,
	createConsoleInputHandler,
	formatPosixDate,
	formatLogTimestamp,
	hasLogTimestamp,
	unstampedLogLine,
	stampLogLines,
	expandLogFilePath,
	retargetUnityLogfile,
	createLogLineDeduper,
	createTimestampedLogWriter
};
