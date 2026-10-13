import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import type { CodeServerClientOptions } from "./CodeServerClient";

export interface ShellConfig extends CodeServerClientOptions {
	cwd?: string;
}

function optionalText(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function readBoolean(name: string): boolean | undefined {
	const value = optionalText(name)?.toLowerCase();
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
}

function readPositiveInteger(name: string): number | undefined {
	const value = optionalText(name);
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
	return number;
}

function readJsonKV(name: string): Record<string, string> {
	const value = optionalText(name);
	if (value === undefined) return {};
	let kv: unknown;
	try {
		kv = JSON.parse(value);
	} catch {
		throw new Error(`${name} must be a JSON object of string values`);
	}
	if (!kv || typeof kv !== "object" || Array.isArray(kv)
		|| !Object.values(kv).every((header) => typeof header === "string")) {
		throw new Error(`${name} must be a JSON object of string values`);
	}
	return kv as Record<string, string>;
}

export function loadShellConfig(): ShellConfig {
	loadDotEnv({ path: [path.resolve(__dirname, ".env.example"), path.resolve(__dirname, "..", ".env.example")].find(existsSync) });
	loadDotEnv({ override: true });
	return {
		url: optionalText("CSSH_URL") ?? "",
		connectionToken: optionalText("CSSH_CONNECTION_TOKEN"),
		cookie: optionalText("CSSH_COOKIE"),
		rejectUnauthorized: readBoolean("CSSH_REJECT_UNAUTHORIZED"),
		handshakeTimeoutMs: readPositiveInteger("CSSH_HANDSHAKE_TIMEOUT_MS"),
		maxMessageBytes: readPositiveInteger("CSSH_MAX_MESSAGE_BYTES"),
		headers: readJsonKV("CSSH_HEADERS"),
		cwd: optionalText("CSSH_CWD"),
	};
}
