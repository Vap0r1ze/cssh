import { config as loadDotEnv } from "dotenv";
import type { CodeServerClientOptions } from "./CodeServerClient";

export interface ShellConfig extends CodeServerClientOptions {
	cwd?: string;
}

function readBoolean(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	if (value.toLowerCase() === "true") return true;
	if (value.toLowerCase() === "false") return false;
	throw new Error(`${name} must be true or false`);
}

function readPositiveInteger(name: string): number | undefined {
	const value = process.env[name];
	if (value === undefined || value === "") return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
	return number;
}

function readHeaders(): Record<string, string> | undefined {
	const value = process.env.CSSH_HEADERS;
	if (value === undefined || value === "") return undefined;
	let headers: unknown;
	try {
		headers = JSON.parse(value);
	} catch {
		throw new Error("CSSH_HEADERS must be a JSON object of string values");
	}
	if (!headers || typeof headers !== "object" || Array.isArray(headers)
		|| !Object.values(headers).every((header) => typeof header === "string")) {
		throw new Error("CSSH_HEADERS must be a JSON object of string values");
	}
	return headers as Record<string, string>;
}

export function loadShellConfig(): ShellConfig {
	loadDotEnv();
	return {
		url: process.env.CSSH_URL ?? "",
		connectionToken: process.env.CSSH_CONNECTION_TOKEN || undefined,
		cookie: process.env.CSSH_COOKIE || undefined,
		rejectUnauthorized: readBoolean("CSSH_REJECT_UNAUTHORIZED"),
		handshakeTimeoutMs: readPositiveInteger("CSSH_HANDSHAKE_TIMEOUT_MS"),
		maxMessageBytes: readPositiveInteger("CSSH_MAX_MESSAGE_BYTES"),
		headers: readHeaders(),
		cwd: process.env.CSSH_CWD || undefined,
	};
}