import assert from "node:assert/strict";
import test from "node:test";
import { CodeServerClient } from "./CodeServerClient";
import { loadShellConfig } from "./config";

const options = loadShellConfig();
const unconfigured = options.url.trim() === "";

test("creates an interactive Bash terminal with input, output, Up Arrow history, resize and exit", {
    skip: unconfigured ? "Set CSSH_URL in .env to test your endpoint" : false,
    timeout: (options.handshakeTimeoutMs ?? 10000) * 2 + 2000,
}, async (context) => {
    const client = new CodeServerClient({
        ...options,
        connectionToken: options.connectionToken || undefined,
        cookie: options.cookie || undefined,
    });
    context.after(() => client.close());
    await client.connect();
    assert.equal(client.connected, true);
    assert.match(client.commit ?? "", /^[a-f0-9]{40}$/i);
    assert.equal(new URL(client.websocketUrl).pathname, `/stable-${client.commit}`);
    let output = "";
    let resolveOutput!: () => void;
    let resolveRecall!: () => void;
    let resolveExit!: (code: number | undefined) => void;
    const echoed = new Promise<void>((resolve) => { resolveOutput = resolve; });
    const recalled = new Promise<void>((resolve) => { resolveRecall = resolve; });
    const exited = new Promise<number | undefined>((resolve) => { resolveExit = resolve; });
    const terminal = await client.createTerminal({
        name: "CodeServerClient test", executable: "bash", cols: 80, rows: 24,
        onData: (data) => {
            output += data;
            if (output.includes("CSSH_IO_OK")) resolveOutput();
            if (output.split("CSSH_IO_OK").length >= 3) resolveRecall();
        },
        onExit: resolveExit,
    });
    context.after(async () => {
        if (client.connected) await terminal.dispose();
    });
    assert(Number.isSafeInteger(terminal.id) && terminal.id > 0);
    assert.equal(typeof terminal.resolvedShellLaunchConfig.executable, "string");
    context.after(() => {
        if (output.split("CSSH_IO_OK").length < 3) {
            context.diagnostic(JSON.stringify({ shell: terminal.resolvedShellLaunchConfig.executable, output: output.slice(-2500) }));
        }
    });
    await terminal.resize(100, 30);
    await terminal.write("echo CSSH_IO_\"OK\"\r");
    await echoed;
    await terminal.write("\x1b[A\r");
    await recalled;
    await terminal.write("exit\r");
    assert.equal(await exited, 0);
    await terminal.dispose();
    client.close();
    assert.equal(client.connected, false);
});