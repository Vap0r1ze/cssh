#!/usr/bin/env node

import { CodeServerClient, type RemoteTerminal } from "./CodeServerClient";
import { loadShellConfig } from "./config";

async function main(): Promise<void> {
    const config = loadShellConfig();
    const options = config;
    const client = new CodeServerClient({
        ...options,
        connectionToken: options.connectionToken || undefined,
        cookie: options.cookie || undefined,
    });
    let terminal: RemoteTerminal | undefined;
    let ended = false;
    let closing = false;
    let complete!: (result: { code?: number; error?: Error }) => void;
    const finished = new Promise<{ code?: number; error?: Error }>((resolve) => { complete = resolve; });
    const finish = (result: { code?: number; error?: Error }) => {
        if (ended) return;
        ended = true;
        complete(result);
    };
    const fail = (error: unknown) => finish({ error: error instanceof Error ? error : new Error(String(error)) });
    let outputTail = Promise.resolve();
    let inputTail = Promise.resolve();
    const wasRaw = process.stdin.isRaw ?? false;
    const dimensions = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    const onInput = (data: string) => {
        if (ended) return;
        const escape = data.indexOf("\x1d");
        const input = escape < 0 ? data : data.slice(0, escape);
        inputTail = inputTail.then(async () => {
            if (input && terminal && !ended) await terminal.write(input);
            if (escape >= 0) finish({ code: 0 });
        }).catch(fail);
    };
    const onEnd = () => {
        inputTail = inputTail.then(async () => {
            if (terminal && !ended) await terminal.write("\x04");
        }).catch(fail);
    };
    const onResize = () => {
        if (!terminal || ended) return;
        const { cols, rows } = dimensions();
        void terminal.resize(cols, rows).catch(fail);
    };
    const onSignal = () => finish({ code: 130 });
    client.on("error", fail);
    client.on("close", (code: number) => {
        if (!closing && !ended) fail(new Error(`Remote connection closed (${code})`));
    });
    process.stdin.on("error", fail);
    process.stdout.on("error", fail);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
        await client.connect();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        terminal = await client.createTerminal({
            name: "cssh",
            executable: process.argv[2] ?? "bash",
            args: process.argv.slice(3),
            cwd: (config as { cwd?: string }).cwd,
            ...dimensions(),
            onData: (data) => {
                outputTail = outputTail.then(() => new Promise<void>((resolve, reject) => {
                    process.stdout.write(data, (error) => error ? reject(error) : resolve());
                }));
                return outputTail;
            },
            onExit: (code) => finish({ code: code ?? 0 }),
        });
        if (!ended) {
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", onInput);
            process.stdin.on("end", onEnd);
            process.stdout.on("resize", onResize);
            process.stdin.resume();
            onResize();
        }
        const result = await finished;
        await outputTail;
        if (result.error) throw result.error;
        process.exitCode = result.code ?? 0;
    } finally {
        closing = true;
        ended = true;
        process.stdin.removeListener("data", onInput);
        process.stdin.removeListener("end", onEnd);
        process.stdin.removeListener("error", fail);
        process.stdout.removeListener("resize", onResize);
        process.stdout.removeListener("error", fail);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
        if (process.stdout.isTTY) process.stdout.write("\x1b[0m\x1b[?25h\x1b[?2004l");
        try {
            await terminal?.dispose();
        } finally {
            client.close();
        }
    }
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});