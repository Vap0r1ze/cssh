# cssh

```sh
npm i -g "@vap/cssh"
```

`cssh` opens an interactive shell on a code-server instance. It can also be used as a Node.js client library to create and manage remote terminals. Mainly created because I locked myself out of a container by updating code-server without restarting the service.

## CLI & Configuration

Install the package globally and either create an `.env` file in the directory where you will run `cssh`, or supply those environment variables to your shell yourself: [`.env.example`](./.env.example)

The default remote shell is Bash. Pass a different executable and its arguments after `cssh`, for example `cssh sh`.

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
