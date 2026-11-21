"use strict";

const assert = require("assert");
const fs = require("fs");
const {
	createGameOutputHandler,
	createRconCommandTracker,
	createRconMessageHandler,
	createConsoleInputHandler,
	createTimestampedLogWriter,
	expandLogFilePath,
	formatLogTimestamp,
	formatPosixDate
} = require("./wrapper-helpers");

const output = [];
const childOutput = createGameOutputHandler(
	(text) => output.push(text),
	(line) => line.replace(/\r/g, ""),
	() => null
);

// Child output is printed once and genuine repeated lines remain repeated.
childOutput(Buffer.from("Spawning World\n"));
assert.deepStrictEqual(output, ["Spawning World"]);
childOutput(Buffer.from("Processing World\nProcessing World\n"));
assert.deepStrictEqual(output, [
	"Spawning World",
	"Processing World",
	"Processing World"
]);

// Split child chunks still produce one panel line.
childOutput(Buffer.from("Finalizing "));
childOutput(Buffer.from("World\n"));
assert.strictEqual(output.at(-1), "Finalizing World");

// Broadcast RCON frames (-1, 0, non-numeric) are parsed but emit zero lines.
let nowMs = 1000;
const tracker = createRconCommandTracker({
	ttlMs: 30000,
	maxPending: 256,
	now: () => nowMs
});
let readyCount = 0;
let parsedRcon;
const rconMessage = createRconMessageHandler(
	(data) => {
		parsedRcon = JSON.parse(String(data));
		return [parsedRcon];
	},
	{
		tracker,
		write: (text) => output.push(text),
		markReady: () => {
			readyCount++;
		}
	}
);

const beforeBroadcasts = output.length;
rconMessage(Buffer.from('{"Message":"Spawning World","Identifier":-1}'));
rconMessage(Buffer.from('{"Message":"[Server] Saved","Identifier":0}'));
rconMessage(Buffer.from('{"Message":"String zero","Identifier":"0"}'));
rconMessage(Buffer.from('{"Message":"String minus one","Identifier":"-1"}'));
rconMessage(Buffer.from('{"Message":"Boolean one","Identifier":true}'));
rconMessage(Buffer.from('{"Message":"No identifier"}'));
assert.strictEqual(parsedRcon.Message, "No identifier");
assert.strictEqual(readyCount, 1);
assert.strictEqual(output.length, beforeBroadcasts);

// Sending commands echoes "> cmd", assigns positive Identifiers, and displays matching replies.
const sentPackets = [];
let currentSocket = {
	readyState: 1,
	OPEN: 1,
	send(payload) {
		sentPackets.push(JSON.parse(payload));
	}
};
let quitCalled = 0;
const consoleInput = createConsoleInputHandler({
	getSocket: () => currentSocket,
	tracker,
	write: (text) => output.push(text),
	echoCommand: true,
	onQuit: () => {
		quitCalled++;
	}
});

// Empty/whitespace lines are ignored without echoing or sending.
assert.strictEqual(consoleInput("   \r\n  "), false);
assert.strictEqual(sentPackets.length, 0);
assert.strictEqual(output.length, beforeBroadcasts);

assert.strictEqual(consoleInput("  status  "), true);
assert.strictEqual(consoleInput("oxide.plugins"), true);
assert.deepStrictEqual(sentPackets, [
	{ Identifier: 1, Message: "status", Name: "WebRcon" },
	{ Identifier: 2, Message: "oxide.plugins", Name: "WebRcon" }
]);
assert.deepStrictEqual(output.slice(beforeBroadcasts), [
	"> status",
	"> oxide.plugins"
]);

// Multi-line and multi-frame replies matching sent command Identifiers are printed once.
const statusReply = "hostname: My Rust Server\r\nplayers : 12 (1 queued) (100 max)";
rconMessage(Buffer.from(JSON.stringify({ Identifier: 1, Message: statusReply })));
rconMessage(Buffer.from(JSON.stringify({ Identifier: 1, Message: "frame 2 for status" })));
rconMessage(Buffer.from(JSON.stringify({
	Identifier: 2,
	Message: "Listing 2 plugins:\n  01 \"AdminRadar\"\n  02 \"Vanish\""
})));
// Broadcast interleaved between command replies is still suppressed.
rconMessage(Buffer.from(JSON.stringify({ Identifier: -1, Message: "Broadcast duplicate" })));
// Error reply with Stacktrace prints both Message and Stacktrace.
rconMessage(Buffer.from(JSON.stringify({
	Identifier: 2,
	Message: "Command error",
	Stacktrace: "at Oxide.Plugins.Test.Cmd () [0x00000]"
})));

assert.deepStrictEqual(output.slice(beforeBroadcasts), [
	"> status",
	"> oxide.plugins",
	"hostname: My Rust Server\nplayers : 12 (1 queued) (100 max)",
	"frame 2 for status",
	"Listing 2 plugins:\n  01 \"AdminRadar\"\n  02 \"Vanish\"",
	"Command error",
	"at Oxide.Plugins.Test.Cmd () [0x00000]"
]);

// Unknown positive Identifiers are ignored.
const beforeUnknown = output.length;
rconMessage(Buffer.from(JSON.stringify({ Identifier: 999, Message: "Unsolicited id 999" })));
assert.strictEqual(output.length, beforeUnknown);

// Expired positive Identifiers are ignored after TTL elapses.
nowMs += 30000;
rconMessage(Buffer.from(JSON.stringify({ Identifier: 1, Message: "Late status reply" })));
assert.strictEqual(output.length, beforeUnknown);
assert.strictEqual(tracker.size(), 0);

// Bounded tracker evicts oldest entries and wraps safely around maxIdentifier.
let boundedNow = 0;
const boundedTracker = createRconCommandTracker({
	ttlMs: 30000,
	maxPending: 3,
	maxIdentifier: 4,
	now: () => boundedNow
});
assert.strictEqual(boundedTracker.allocate(), 1);
assert.strictEqual(boundedTracker.allocate(), 2);
assert.strictEqual(boundedTracker.allocate(), 3);
assert.strictEqual(boundedTracker.allocate(), 4);
assert.strictEqual(boundedTracker.has(1), false);
assert.strictEqual(boundedTracker.has(2), true);
assert.strictEqual(boundedTracker.has(3), true);
assert.strictEqual(boundedTracker.has(4), true);
// Wraps back to 1 (2, 3, 4 are still active; 2 gets evicted, 1 is allocated).
assert.strictEqual(boundedTracker.allocate(), 1);
assert.strictEqual(boundedTracker.has(2), false);
assert.strictEqual(boundedTracker.has(1), true);
assert.strictEqual(boundedTracker.size(), 3);

// Disconnected RCON warns instead of silently swallowing commands, while quit still works.
const beforeDisconnected = output.length;
currentSocket = { readyState: 3, OPEN: 1, send() { throw new Error("not open"); } };
assert.strictEqual(consoleInput("env.time"), false);
currentSocket = null;
assert.strictEqual(consoleInput("save"), false);
assert.deepStrictEqual(output.slice(beforeDisconnected), [
	"> env.time",
	"RCON not connected; command not sent.",
	"> save",
	"RCON not connected; command not sent."
]);

assert.strictEqual(consoleInput("quit"), false);
assert.strictEqual(quitCalled, 1);

// Send failure removes allocated tracker ID and prints an error instead of crashing.
const beforeSendErr = output.length;
const trackerSizeBeforeErr = tracker.size();
currentSocket = {
	readyState: 1,
	OPEN: 1,
	send() {
		throw new Error("socket write failed");
	}
};
assert.strictEqual(consoleInput("say hello"), false);
assert.strictEqual(tracker.size(), trackerSizeBeforeErr);
assert.deepStrictEqual(output.slice(beforeSendErr), [
	"> say hello",
	"Failed to send RCON command: socket write failed"
]);

// echoCommand: false suppresses the "> cmd" echo when PTY echo is already on.
const noEchoOut = [];
const noEchoInput = createConsoleInputHandler({
	getSocket: () => ({ readyState: 1, OPEN: 1, send() {} }),
	tracker,
	write: (text) => noEchoOut.push(text),
	echoCommand: false
});
assert.strictEqual(noEchoInput("time"), true);
assert.deepStrictEqual(noEchoOut, []);

// Log files get a timestamp. The text handed to the console writer is unchanged.
const fixedNow = new Date(2026, 10, 15, 21, 4, 5);
assert.strictEqual(formatLogTimestamp(fixedNow), "2026-11-15 21:04:05");
assert.strictEqual(
	expandLogFilePath("logs/$(date +%Y-%m-%d-%H%M).log", (format) => formatPosixDate(format, fixedNow)),
	"logs/2026-11-15-2104.log"
);
assert.strictEqual(expandLogFilePath("   ", () => "unused"), "");
assert.strictEqual(expandLogFilePath("logs/console.log", () => {
	throw new Error("date should not run");
}), "logs/console.log");

const stamped = [];
const writeStamped = createTimestampedLogWriter({
	now: () => fixedNow,
	writeLine: (line) => stamped.push(line)
});
writeStamped("Server startup complete");
writeStamped("hostname: My Rust Server\nplayers : 12");
writeStamped("");
assert.deepStrictEqual(stamped, [
	"2026-11-15 21:04:05 Server startup complete\n",
	"2026-11-15 21:04:05 hostname: My Rust Server\n2026-11-15 21:04:05 players : 12\n"
]);

// Static integration guardrails for the wrapper's actual child, stdin, and RCON paths.
const wrapper = fs.readFileSync(require.resolve("./wrapper"), "utf8");
assert.match(wrapper, /stdio:\s*\[['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"]\]/);
assert.strictEqual(
	(wrapper.match(/gameProcess\.(?:stdout|stderr)\.on\("data", createGameOutputHandler\(/g) || []).length,
	2
);
assert.doesNotMatch(wrapper, /stdio:\s*["']inherit["']|\.pipe\(process\.(?:stdout|stderr)\)/);
assert.doesNotMatch(wrapper, /json\.Message|panel\.rcon|appendFile\(["']latest\.log|writeFile\(["']latest\.log/);
assert.match(wrapper, /createRconCommandTracker\(/);
assert.match(wrapper, /createConsoleInputHandler\(/);
assert.match(wrapper, /rl\.on\("line",\s*handleConsoleLine\)/);
assert.match(wrapper, /console\.log\(text\);\s*writeConsoleLog\(text\);/);

const egg = JSON.parse(fs.readFileSync("./egg-rust--all-in-one4-0-staging.json", "utf8"));
assert.strictEqual(egg.name, "Rust - All In One 4.0 (Staging)");
assert.strictEqual(
	egg.meta.update_url,
	"https://raw.githubusercontent.com/evlaar-online/aioegg-staging/main/egg-rust--all-in-one4-0-staging.json"
);
assert.deepStrictEqual(Object.keys(egg.docker_images), ["ghcr.io/evlaar-online/aioegg-staging:staging"]);
assert.strictEqual(egg.docker_images["ghcr.io/evlaar-online/aioegg-staging:staging"], "ghcr.io/evlaar-online/aioegg-staging:staging");
assert.match(egg.startup, /-logfile \/dev\/null/);
assert.doesNotMatch(egg.startup, /LOG_FILE/);

const liveEgg = JSON.parse(fs.readFileSync("./egg-rust--all-in-one4-0.json", "utf8"));
assert.match(liveEgg.startup, /-logfile "\$\{LOG_FILE/);
assert.doesNotMatch(liveEgg.startup, /-logfile \/dev\/null/);

const workflow = fs.readFileSync("./.github/workflows/publish.yml", "utf8");
assert.match(workflow, /aioegg-staging:staging/);
assert.doesNotMatch(workflow, /aioegg:production/);

// RCON close/error only schedule reconnects; they never terminate the wrapper.
const rconLifecycle = wrapper.slice(
	wrapper.indexOf("function finish(wasConnected)"),
	wrapper.lastIndexOf("\npoll();")
);
assert.doesNotMatch(rconLifecycle, /process\.exit(?:Code)?\s*=|process\.exit\(/);
assert.match(rconLifecycle, /setTimeout\(function \(\) \{[\s\S]*poll\(\)/);

// Only the Rust child exit determines the wrapper's resulting exit code.
const childExit = wrapper.slice(
	wrapper.indexOf("gameProcess.on('exit'"),
	wrapper.indexOf("process.on('exit'")
);
assert.match(childExit, /process\.exitCode = typeof code === "number" \? code : 1/);
assert.strictEqual((wrapper.match(/process\.exitCode\s*=/g) || []).length, 1);

console.log("wrapper helper tests passed");
