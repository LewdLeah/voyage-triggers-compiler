Compiles a folder of `.js`/`.mjs` trigger files into the single [`triggers.json`](example/triggers.json) blob a Voyage world config expects.

## Quick start

```
node voyage-triggers-compiler.mjs path/to/your/folder/
```

Writes [`triggers.json`](example/triggers.json) to that folder.

## Example

Input file `hello.js`:

```js
log('hello');
```

Generated [`triggers.json`](example/triggers.json):

```json
{
  "hello": {
    "name": "hello",
    "conditions": [],
    "script": "log('hello');",
    "effects": [],
    "recurring": true
  }
}
```

See [`example/`](example/) for more.

## How it works

Each `.js`/`.mjs` file in the folder becomes one trigger.

A file may begin with `export const meta = { ... }` with recognized fields:

- `name` overrides the filename-derived trigger key
- `conditions` defaults to `[]`
- `effects` defaults to `[]`
- `recurring` defaults to `true`
- Any other fields pass through unchanged

Everything after the meta export becomes the trigger's `script` field. With no `meta`, the entire file is the script body and the trigger name comes from the filename.

Any `script` field inside `meta` is ignored. (Duh!)

## Flags

- `--compact` strips indentation from the outer `triggers.json`
- `--no-mangle` keeps original variable names in the `script` string
- `--no-minify` keeps aesthetic newlines/indentation in the `script` string
