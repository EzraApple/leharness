# 002 — npm CLI Distribution

## Goal

Make `leharness` easy to install and run from npm, primarily so a friend can
try it with one normal command. This is not trying to turn the project into a
large public platform yet; it is mostly about claiming the npm name and making
the current CLI usable without local repo setup.

Target user flow:

```bash
npm install -g leharness
lh
```

One-off usage should also work:

```bash
npx leharness@latest
```

## Naming Decision

| Area | Decision |
|---|---|
| npm package name | `leharness` |
| installed command | `lh` |
| npm package named `lh` | Do not use; it is already taken |
| `leharness` command alias | Do not include for now unless there is a clear reason |

The package name and binary name do not have to match. Publishing package
`leharness` with `bin: { "lh": "./dist/index.js" }` gives the desired install
and command shape without conflicting with the existing `lh` npm package.

Users should not be told to run `npx lh`, because `npx` resolves package names,
not just binary names. The correct no-install command is:

```bash
npx leharness@latest
```

## Package Shape

The cleanest near-term shape is one public npm package:

```json
{
  "name": "leharness",
  "bin": {
    "lh": "./dist/index.js"
  }
}
```

The repo can still keep a workspace split internally. Published users should
not need `pnpm`, workspace aliases, or source compilation. The published package
should contain built JavaScript and all runtime dependencies needed by `lh`.

Current repo state to resolve before publishing:

- The root package is named `leharness` but is marked `private: true`.
- `apps/cli` is named `@leharness/cli`, marked `private: true`, and exposes both
  `lh` and `leharness`.
- `apps/cli` depends on `@leharness/harness` through `workspace:*`.
- `packages/harness` is marked `private: true`.

That workspace dependency is fine for local development, but it is not enough
for a standalone public CLI install unless either:

- both `@leharness/cli` and `@leharness/harness` are published with real
  versions, or
- the CLI package bundles/includes the harness code into the single published
  `leharness` package.

Recommendation: publish one package named `leharness` that installs one binary
named `lh`. Keep internal repo structure flexible until the project is more
stable.

## First-Run Setup

`pnpm` should only be required for development in this repo. Users installing
from npm should only need Node and whichever model provider they choose.

OpenAI quickstart:

```bash
npm install -g leharness
export OPENAI_API_KEY=...
lh --provider openai
```

Ollama quickstart:

```bash
npm install -g leharness
ollama pull gemma4:26b
lh --provider ollama
```

Current default provider is Ollama, which is good for local-first usage but can
surprise people who do not already have Ollama running. The public README should
make provider setup explicit instead of assuming one path.

## Update Story

npm global installs do not auto-update by default. For this project, avoid a
heavy self-updater at first because global npm permissions, install paths, and
package managers vary by machine.

Good lightweight options:

- Document manual update:

  ```bash
  npm install -g leharness@latest
  ```

- Support always-latest one-off usage:

  ```bash
  npx leharness@latest
  ```

- Later, add a startup update notice that occasionally checks the npm registry
  and prints a message when a newer version is available.

- Later, add `lh update` as a convenience command that shells out to the user's
  package manager, but only after the install path story is clearer.

Recommendation: document manual updates now, then add an update notice before
adding a real self-update command.

## Versioning Posture

It is fine to publish early to claim the name. Keep it under `0.x`, make the
README clear that the CLI is experimental, and avoid promising stable behavior
until install, setup, and the command surface feel real.

Safe to change during `0.x`:

- underlying implementation
- repo layout
- workspace package names
- internal app/package split
- provider defaults
- setup flow

Try to keep stable:

- npm package name: `leharness`
- CLI command: `lh`
- basic invocation shape: `lh`, `lh "<prompt>"`, `lh --provider ...`

## Documentation To Add

The README should eventually include:

- install command
- update command
- no-install `npx` command
- provider setup for OpenAI and Ollama
- Node version requirement
- where sessions are saved
- clear experimental status

Suggested README install block:

```bash
npm install -g leharness
lh --help
```

Suggested update block:

```bash
npm install -g leharness@latest
```

Suggested no-install block:

```bash
npx leharness@latest --help
```
