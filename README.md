# cssh

`cssh` opens an interactive shell on a code-server instance. It can also be used as a Node.js client library to create and manage remote terminals. Mainly created because I locked myself out of a container by updating code-server without restarting the service.

## CLI

Install the package globally and create a `.env` file in the directory where you will run `cssh`:

```sh
npm install --global cssh
cp .env.example .env
```

Set `CSSH_URL` in `.env` to your code-server URL. Authentication is optional; use `CSSH_CONNECTION_TOKEN` or `CSSH_COOKIE` if your instance requires it. Then run:

```sh
cssh
```

The default remote shell is Bash. Pass a different executable and its arguments after `cssh`, for example `cssh sh`.

## Configuration

The CLI reads `.env` from the current working directory. Values already set in the process environment take precedence over `.env`.

| Variable | Description |
| --- | --- |
| `CSSH_URL` | Required HTTP(S) or WS(S) URL for code-server |
| `CSSH_CONNECTION_TOKEN` | Optional code-server connection token |
| `CSSH_COOKIE` | Optional Cookie header value |
| `CSSH_CWD` | Optional working directory on the remote server |
| `CSSH_REJECT_UNAUTHORIZED` | Verify TLS certificates; `true` by default |
| `CSSH_HANDSHAKE_TIMEOUT_MS` | Positive handshake timeout in milliseconds; defaults to `10000` |
| `CSSH_MAX_MESSAGE_BYTES` | Positive maximum message size; defaults to `67108864` |
| `CSSH_HEADERS` | Optional JSON object of additional HTTP header names and string values |

## Library

```js
const { CodeServerClient } = require("cssh");

const client = new CodeServerClient({ url: "https://code-server.example" });
await client.connect();

const terminal = await client.createTerminal({
  executable: "bash",
  onData: (data) => process.stdout.write(data),
});

await terminal.write("pwd\n");
// When finished:
await terminal.dispose();
client.close();
```

`CodeServerClientOptions`, `CreateTerminalOptions`, `ControlMessage`, and `RemoteTerminal` are also exported as TypeScript types.

## Development

```sh
npm install
npm run build
npm run typecheck
npm test
```

The integration test uses the `.env` endpoint and is skipped when `CSSH_URL` is not configured.