import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { get as httpGet, type ClientRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import WebSocket, { type RawData } from "ws";

export interface CodeServerClientOptions {
	url: string;
	connectionToken?: string;
	cookie?: string;
	headers?: Record<string, string>;
	rejectUnauthorized?: boolean;
	handshakeTimeoutMs?: number;
	maxMessageBytes?: number;
	sign?: (challenge: string) => string | Promise<string>;
}

export interface ControlMessage {
	type: string;
	[key: string]: unknown;
}

export interface CreateTerminalOptions {
	name?: string;
	executable?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | null>;
	cols?: number;
	rows?: number;
	onData?: (data: string) => void | Promise<void>;
	onExit?: (exitCode: number | undefined) => void;
}

export interface RemoteTerminal {
	id: number;
	resolvedShellLaunchConfig: Record<string, unknown>;
	write(data: string): Promise<void>;
	resize(cols: number, rows: number): Promise<void>;
	dispose(): Promise<void>;
}

enum MessageType {
	Regular = 1,
	Control = 2,
	Ack = 3,
	Disconnect = 5,
	ReplayRequest = 6,
	Pause = 7,
	Resume = 8,
	KeepAlive = 9,
}

export class CodeServerClient extends EventEmitter {
	readonly reconnectionToken = randomUUID();
	private socket?: WebSocket;
	private versionRequest?: ClientRequest;
	private connecting = false;
	private serverCommit?: string;
	private buffer: Buffer = Buffer.alloc(0);
	private incomingId = 0;
	private outgoingId = 0;
	private paused = false;
	private ready = false;
	private stage: "auth" | "signing" | "ok" | "ready" | "closed" = "auth";
	private readonly pending = new Map<number, Buffer>();
	private queued: Buffer[] = [];
	private keepAlive?: ReturnType<typeof setInterval>;
	private timeout?: ReturnType<typeof setTimeout>;
	private resolveConnect?: () => void;
	private rejectConnect?: (error: Error) => void;
	private ipcInitialized?: Promise<unknown>;
	private ipcRequestId = 0;
	private readonly ipcListeners = new Map<number, (value: unknown) => void>();
	private readonly ipcRequests = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly options: CodeServerClientOptions) {
		super();
		for (const value of [options.handshakeTimeoutMs ?? 10000, options.maxMessageBytes ?? 64 * 1024 * 1024]) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error("Timeout and message size limits must be positive integers");
			}
		}
	}

	get connected(): boolean {
		return this.ready;
	}

	get commit(): string | undefined {
		return this.serverCommit;
	}

	get websocketUrl(): string {
		if (!this.serverCommit) throw new Error("Call connect() to discover the server commit first");
		const url = new URL(this.options.url);
		if (url.protocol === "http:") url.protocol = "ws:";
		if (url.protocol === "https:") url.protocol = "wss:";
		if (url.protocol !== "ws:" && url.protocol !== "wss:") {
			throw new Error("Expected an HTTP(S) or WS(S) URL");
		}
		const endpoint = `/stable-${this.serverCommit}`;
		const path = url.pathname.replace(/\/+$/, "").replace(/\/stable-[^/]+$/, "");
		url.pathname = path.endsWith(endpoint) ? path : `${path}${endpoint}`;
		url.hash = "";
		url.searchParams.set("reconnectionToken", this.reconnectionToken);
		url.searchParams.set("reconnection", "false");
		url.searchParams.set("skipWebSocketFrames", "false");
		return url.toString();
	}

	async connect(): Promise<void> {
		if (this.connecting || this.socket || this.stage === "closed") {
			throw new Error("Create a new client for each connection");
		}
		this.connecting = true;
		const headers = { ...this.options.headers };
		if (this.options.cookie) headers.Cookie = this.options.cookie;
		try {
			this.serverCommit = await this.fetchCommit(headers);
		} catch (error) {
			this.fail(error);
			throw error;
		}
		if (this.stage as string === "closed") throw new Error("Client closed during commit discovery");
		return new Promise((resolve, reject) => {
			this.resolveConnect = resolve;
			this.rejectConnect = reject;
			try {
				this.socket = new WebSocket(this.websocketUrl, {
					headers,
					rejectUnauthorized: this.options.rejectUnauthorized ?? true,
					maxPayload: this.options.maxMessageBytes ?? 64 * 1024 * 1024,
				});
			} catch (error) {
				this.fail(error);
				return;
			}
			this.timeout = setTimeout(() => this.fail(new Error("Code-server handshake timed out")), this.options.handshakeTimeoutMs ?? 10000);
			this.socket.on("open", () => {
				this.writeControl({ type: "auth", auth: this.options.connectionToken ?? "00000000000000000000", data: randomUUID() });
				this.keepAlive = setInterval(() => this.write(MessageType.KeepAlive), 5000);
			});
			this.socket.on("message", (data: RawData, binary: boolean) => {
				try {
					if (!binary) throw new Error("Expected binary VS Code protocol frames");
					const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
					this.receive(chunk);
				} catch (error) {
					this.fail(error);
				}
			});
			this.socket.on("error", (error) => this.fail(error));
			this.socket.on("close", (code, reason) => {
				this.cleanup();
				this.rejectConnect?.(new Error(`WebSocket closed before handshake completed (${code}): ${reason.toString()}`));
				this.resolveConnect = undefined;
				this.rejectConnect = undefined;
				this.emit("close", code, reason.toString());
			});
		});
	}

	private fetchCommit(headers: Record<string, string>): Promise<string> {
		const url = new URL(this.options.url);
		if (url.protocol === "ws:") url.protocol = "http:";
		if (url.protocol === "wss:") url.protocol = "https:";
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Expected an HTTP(S) or WS(S) URL");
		url.pathname = "/version";
		url.search = "";
		url.hash = "";
		return new Promise((resolve, reject) => {
			const get = url.protocol === "https:" ? httpsGet : httpGet;
			const request = get(url, {
				headers,
				rejectUnauthorized: this.options.rejectUnauthorized ?? true,
			}, (response) => {
				if (response.statusCode !== 200) {
					response.resume();
					reject(new Error(`Version request failed with HTTP ${response.statusCode}`));
					return;
				}
				let body = "";
				const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
				if (encoding && !["identity", "gzip", "deflate", "br"].includes(encoding)) {
					response.resume();
					reject(new Error(`Unsupported version response encoding: ${encoding}`));
					return;
				}
				const stream = encoding === "gzip" || encoding === "deflate"
					? response.pipe(createUnzip())
					: encoding === "br" ? response.pipe(createBrotliDecompress()) : response;
				stream.setEncoding("utf8");
				stream.on("data", (chunk: string) => {
					body += chunk;
					if (body.length > 4096) {
						stream.destroy(new Error("Version response exceeds size limit"));
						request.destroy();
					}
				});
				response.on("error", reject);
				stream.on("error", reject);
				stream.on("end", () => {
					const commit = body.trim();
					if (!/^[a-f0-9]{40}$/i.test(commit)) reject(new Error("Version endpoint did not return a valid VS Code commit"));
					else resolve(commit);
				});
			});
			this.versionRequest = request;
			const timeout = setTimeout(() => request.destroy(new Error("Version request timed out")), this.options.handshakeTimeoutMs ?? 10000);
			request.on("error", reject);
			request.on("close", () => {
				clearTimeout(timeout);
				if (this.versionRequest === request) this.versionRequest = undefined;
			});
		});
	}

	send(data: Uint8Array): void {
		this.requireReady();
		const payload = Buffer.from(data);
		if (payload.length > (this.options.maxMessageBytes ?? 64 * 1024 * 1024)) {
			throw new Error("Message exceeds configured size limit");
		}
		const id = ++this.outgoingId;
		const frame = this.frame(MessageType.Regular, payload, id);
		this.pending.set(id, frame);
		this.transmit(frame);
	}

	sendControl(message: ControlMessage): void {
		this.requireReady();
		this.writeControl(message);
	}

	async createTerminal(options: CreateTerminalOptions = {}): Promise<RemoteTerminal> {
		this.requireReady();
		const cols = options.cols ?? 80;
		const rows = options.rows ?? 24;
		if (![cols, rows].every((value) => Number.isSafeInteger(value) && value > 0)) {
			throw new Error("Terminal dimensions must be positive integers");
		}
		const executable = options.executable ?? await this.terminalCall("$getDefaultSystemShell", []);
		if (typeof executable !== "string" || !executable) throw new Error("Server did not return a default shell");
		const result = await this.terminalCall("$createProcess", {
			configuration: { "terminal.integrated.detectLocale": "auto" },
			resolvedVariables: {},
			envVariableCollections: [],
			shellLaunchConfig: { name: options.name, executable, args: options.args, cwd: options.cwd, env: options.env, useShellEnvironment: true },
			workspaceId: this.reconnectionToken,
			workspaceName: "CodeServerClient",
			workspaceFolders: [],
			activeWorkspaceFolder: null,
			shouldPersistTerminal: false,
			options: {
				shellIntegration: { enabled: false, suggestEnabled: false, nonce: randomUUID() },
				windowsEnableConpty: true,
				windowsUseConptyDll: false,
			},
			cols,
			rows,
			unicodeVersion: "11",
		}) as { persistentTerminalId: number; resolvedShellLaunchConfig: Record<string, unknown> };
		if (!result || !Number.isSafeInteger(result.persistentTerminalId) || result.persistentTerminalId <= 0) {
			throw new Error("Server returned an invalid terminal ID");
		}
		const id = result.persistentTerminalId;
		let disposed = false;
		let exited = false;
		const subscriptions: (() => void)[] = [];
		const unsubscribe = () => {
			for (const subscription of subscriptions.splice(0)) subscription();
		};
		const dispose = async () => {
			if (disposed || exited) return;
			if (this.connected) await this.terminalCall("$shutdown", [id, true]);
			disposed = true;
			unsubscribe();
		};
		try {
			subscriptions.push(this.terminalListen("$onProcessDataEvent", (value) => {
				const event = value as { id: number; event: string | { data: string } };
				if (event.id !== id || disposed || exited) return;
				const data = typeof event.event === "string" ? event.event : event.event.data;
				void Promise.resolve(options.onData?.(data)).then(async () => {
					if (this.connected && !disposed && !exited) await this.terminalCall("$acknowledgeDataEvent", [id, data.length]);
				}).catch((error) => this.fail(error));
			}));
			subscriptions.push(this.terminalListen("$onProcessExitEvent", (value) => {
				const event = value as { id: number; event: number | undefined };
				if (event.id !== id) return;
				exited = true;
				unsubscribe();
				options.onExit?.(event.event);
			}));
			const launch = await this.terminalCall("$start", [id]);
			if (launch && typeof launch === "object" && "message" in launch) {
				throw new Error(String(launch.message));
			}
		} catch (error) {
			await dispose().catch(() => undefined);
			throw error;
		}
		const requireActive = () => {
			if (disposed || exited) throw new Error("Terminal is closed");
		};
		return {
			id,
			resolvedShellLaunchConfig: result.resolvedShellLaunchConfig,
			write: async (data) => {
				requireActive();
				await this.terminalCall("$input", [id, data]);
			},
			resize: async (cols, rows) => {
				requireActive();
				if (![cols, rows].every((value) => Number.isSafeInteger(value) && value > 0)) {
					throw new Error("Terminal dimensions must be positive integers");
				}
				await this.terminalCall("$resize", [id, cols, rows]);
			},
			dispose,
		};
	}

	private terminalListen(event: string, listener: (value: unknown) => void): () => void {
		const id = this.ipcRequestId++;
		this.ipcListeners.set(id, listener);
		try {
			this.send(Buffer.concat([encodeIpc([102, id, "remoteterminal", event]), encodeIpc(undefined)]));
		} catch (error) {
			this.ipcListeners.delete(id);
			throw error;
		}
		return () => {
			if (!this.ipcListeners.delete(id) || !this.ready) return;
			this.send(Buffer.concat([encodeIpc([103, id]), encodeIpc(undefined)]));
		};
	}

	private async terminalCall(command: string, args: unknown): Promise<unknown> {
		this.requireReady();
		if (!this.ipcInitialized) {
			this.ipcInitialized = this.ipcRequest(-1, () => {
				this.send(encodeIpc({ remoteAuthority: new URL(this.options.url).host, clientId: this.reconnectionToken }));
				this.send(Buffer.concat([encodeIpc([200]), encodeIpc(undefined)]));
			});
		}
		await this.ipcInitialized;
		this.requireReady();
		const id = this.ipcRequestId++;
		return this.ipcRequest(id, () => this.send(Buffer.concat([
			encodeIpc([100, id, "remoteterminal", command]), encodeIpc(args),
		])));
	}

	private ipcRequest(id: number, send: () => void): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.ipcRequests.delete(id);
				reject(new Error("Terminal IPC request timed out"));
				if (id >= 0 && this.ready) {
					this.send(Buffer.concat([encodeIpc([101, id]), encodeIpc(undefined)]));
				}
			}, this.options.handshakeTimeoutMs ?? 10000);
			this.ipcRequests.set(id, { resolve, reject, timer });
			try {
				send();
			} catch (error) {
				clearTimeout(timer);
				this.ipcRequests.delete(id);
				reject(error);
			}
		});
	}

	private receiveIpc(payload: Buffer): void {
		const [header, body] = decodeIpc(payload);
		if (!Array.isArray(header)) throw new Error("Invalid IPC response header");
		const type = header[0];
		const id = type === 200 ? -1 : header[1];
		if (type === 204) {
			this.ipcListeners.get(id)?.(body);
			return;
		}
		const request = this.ipcRequests.get(id);
		if (!request || ![200, 201, 202, 203].includes(type)) return;
		clearTimeout(request.timer);
		this.ipcRequests.delete(id);
		if (type === 200 || type === 201) request.resolve(body);
		else {
			const details = body as { message?: string; name?: string; stack?: string } | null;
			const error = new Error(details?.message ?? String(body));
			if (details?.name) error.name = details.name;
			if (details?.stack) error.stack = details.stack;
			request.reject(error);
		}
	}

	close(): void {
		this.versionRequest?.destroy(new Error("Client closed during commit discovery"));
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.write(MessageType.Disconnect);
			this.socket.close();
		} else {
			this.socket?.terminate();
		}
		this.rejectConnect?.(new Error("Client closed before handshake completed"));
		this.resolveConnect = undefined;
		this.rejectConnect = undefined;
		this.cleanup();
	}

	private requireReady(): void {
		if (!this.ready) throw new Error("Call and await connect() before sending messages");
	}

	private frame(type: MessageType, data = Buffer.alloc(0), id = 0): Buffer {
		const header = Buffer.alloc(13);
		header.writeUInt8(type, 0);
		header.writeUInt32BE(id, 1);
		header.writeUInt32BE(this.incomingId, 5);
		header.writeUInt32BE(data.length, 9);
		return Buffer.concat([header, data]);
	}

	private transmit(frame: Buffer): void {
		if (this.paused) this.queued.push(frame);
		else if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(frame, (error) => { if (error) this.fail(error); });
		}
	}

	private write(type: MessageType, data = Buffer.alloc(0)): void {
		this.transmit(this.frame(type, data));
	}

	private writeControl(message: ControlMessage): void {
		this.write(MessageType.Control, Buffer.from(JSON.stringify(message)));
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.stage !== "closed" && this.buffer.length >= 13) {
			const size = this.buffer.readUInt32BE(9);
			if (size > (this.options.maxMessageBytes ?? 64 * 1024 * 1024)) {
				throw new Error("Server message exceeds configured size limit");
			}
			if (this.buffer.length < 13 + size) return;
			const type = this.buffer.readUInt8(0);
			const id = this.buffer.readUInt32BE(1);
			const ack = this.buffer.readUInt32BE(5);
			const payload = this.buffer.subarray(13, 13 + size);
			this.buffer = this.buffer.subarray(13 + size);
			if (ack > this.outgoingId) throw new Error("Invalid server acknowledgement");
			for (const pendingId of this.pending.keys()) {
				if (pendingId <= ack) this.pending.delete(pendingId);
			}
			switch (type) {
				case MessageType.Regular:
					if (id <= this.incomingId) break;
					if (id !== this.incomingId + 1) {
						this.write(MessageType.ReplayRequest);
						break;
					}
					this.incomingId = id;
					this.write(MessageType.Ack);
					if (this.ipcInitialized) this.receiveIpc(payload);
					this.emit("message", payload);
					break;
				case MessageType.Control:
					void this.control(JSON.parse(payload.toString())).catch((error) => this.fail(error));
					break;
				case MessageType.Disconnect:
					this.close();
					break;
				case MessageType.ReplayRequest:
					for (const frame of this.pending.values()) this.transmit(frame);
					break;
				case MessageType.Pause:
					this.paused = true;
					break;
				case MessageType.Resume: {
					this.paused = false;
					const frames = this.queued;
					this.queued = [];
					for (const frame of frames) this.transmit(frame);
					break;
				}
				case MessageType.Ack:
				case MessageType.KeepAlive:
					break;
				default:
					throw new Error(`Unsupported VS Code protocol message type: ${type}`);
			}
		}
	}

	private async control(message: ControlMessage): Promise<void> {
		if (!message || typeof message.type !== "string") throw new Error("Malformed control message");
		if (message.type === "error") throw new Error(String(message.reason ?? "Server rejected connection"));
		if (this.stage === "auth") {
			if (message.type !== "sign" || typeof message.data !== "string") throw new Error("Expected server signing challenge");
			this.stage = "signing";
			const signedData = this.options.sign
				? await this.options.sign(message.data)
				: this.options.connectionToken ?? "00000000000000000000";
			if (this.stage as string === "closed") return;
			if (typeof signedData !== "string") throw new Error("Signing callback must return a string");
			this.stage = "ok";
			this.writeControl({ type: "connectionType", commit: this.serverCommit, signedData, desiredConnectionType: 1 });
		} else if (this.stage === "ok") {
			if (message.type !== "ok") throw new Error("Expected server handshake acknowledgement");
			clearTimeout(this.timeout);
			this.stage = "ready";
			this.ready = true;
			this.resolveConnect?.();
			this.resolveConnect = undefined;
			this.rejectConnect = undefined;
		} else if (this.stage !== "ready" && this.stage !== "closed") {
			throw new Error("Unexpected control message during signing");
		}
		this.emit("control", message);
	}

	private cleanup(): void {
		this.ready = false;
		this.stage = "closed";
		clearTimeout(this.timeout);
		clearInterval(this.keepAlive);
		this.buffer = Buffer.alloc(0);
		this.pending.clear();
		this.queued = [];
		for (const request of this.ipcRequests.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Connection closed during terminal IPC request"));
		}
		this.ipcRequests.clear();
		this.ipcListeners.clear();
	}

	private fail(value: unknown): void {
		if (this.stage === "closed") return;
		const error = value instanceof Error ? value : new Error(String(value));
		this.rejectConnect?.(error);
		this.resolveConnect = undefined;
		this.rejectConnect = undefined;
		this.cleanup();
		this.socket?.terminate();
		if (this.listenerCount("error")) this.emit("error", error);
	}
}

function encodeIpc(value: unknown): Buffer {
	const length = (number: number): Buffer => {
		const bytes: number[] = [];
		do {
			const byte = number & 127;
			number >>>= 7;
			bytes.push(byte | (number ? 128 : 0));
		} while (number);
		return Buffer.from(bytes);
	};
	if (value === undefined) return Buffer.from([0]);
	if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), length(value.length), ...value.map(encodeIpc)]);
	if (typeof value === "number" && (value | 0) === value) return Buffer.concat([Buffer.from([6]), length(value)]);
	const type = typeof value === "string" ? 1 : Buffer.isBuffer(value) ? 2 : 5;
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(type === 1 ? value as string : JSON.stringify(value));
	return Buffer.concat([Buffer.from([type]), length(bytes.length), bytes]);
}

function decodeIpc(buffer: Buffer): [unknown, unknown] {
	let offset = 0;
	const read = (size: number): Buffer => {
		if (size > buffer.length - offset) throw new Error("Truncated IPC message");
		const value = buffer.subarray(offset, offset + size);
		offset += size;
		return value;
	};
	const length = (): number => {
		let value = 0;
		for (let shift = 0; shift < 35; shift += 7) {
			const byte = read(1)[0];
			value |= (byte & 127) << shift;
			if (!(byte & 128)) return value >>> 0;
		}
		throw new Error("Invalid IPC integer");
	};
	const decode = (): unknown => {
		const type = read(1)[0];
		if (type === 0) return undefined;
		if (type === 6) return length();
		const size = length();
		if (type === 4) {
			if (size > buffer.length - offset) throw new Error("Truncated IPC array");
			return Array.from({ length: size }, () => decode());
		}
		const bytes = read(size);
		if (type === 1) return bytes.toString();
		if (type === 2 || type === 3) return bytes;
		if (type === 5) return JSON.parse(bytes.toString());
		throw new Error(`Unsupported IPC data type: ${type}`);
	};
	return [decode(), decode()];
}

export default CodeServerClient;
