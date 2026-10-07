# Contributing

Thanks for looking. This is a small project with a narrow scope, and the fastest way to
get a change merged is to know where its boundary is.

## Scope

This repository is **only the desktop shell**. Agent behaviour — models, tools, sessions,
permissions, the web UI — lives upstream in
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

If your change is about what the agent *does*, it belongs upstream. If it is about how the
runtime gets launched, watched, contained, or shut down, it belongs here.

The shell does not patch or fork upstream code. Preferences are expressed through the
kernel's own `--patch` overlay mechanism, which is a supported part of its configuration
layering. A change that requires editing upstream files is a sign the problem should be
reported upstream instead.

## Getting set up

```sh
npm install              # shell dependencies
npm test                 # unit tests — fast, no network, no Electron
npm run kernel:install   # fetch the pinned kernel
npm run test:e2e         # start a real kernel and assert it serves
npm start                # run the shell
```

## Where code goes

Decisions live in plain modules under `src/` with no Electron or filesystem imports;
`src/main.js` does IO and orchestration. Please keep that split.

The reason is practical rather than stylistic: the failures that matter in this project are
about processes, timing, and permissions, and those are the failures that are hardest to
reproduce once the decision making them is entangled with the IO around it. A rule like
"an open port is not a ready server" is one assertion when it is a pure function, and a
flaky integration test when it is not.

## Tests

Every load-bearing decision needs a test, and the useful test is the one that fails when
the decision is made the obvious-but-wrong way. Some of the existing ones, as examples:

- a navigation allowlist that accepts another local port,
- a Node version check that passes 22.14 because it only compared the major version,
- a redaction rule that misses a key because the JSON quotes sit between the name and the
  colon.

If you change a rule, try breaking the implementation on purpose and check that a test
turns red. A test that passes against a deliberately broken implementation is not
protecting anything.

## Upgrading the kernel

The pinned version and its integrity hash live in `upstream.lock.json`, and nowhere else.
Upgrading means editing that file in its own commit, then running
`npm run kernel:install` (which verifies what actually landed against the lock) and
`npm run test:e2e`.

Upstream is a developer preview that documents breaking changes between releases, so this
is deliberately a decision someone makes, rather than something a rebuild does quietly.

## Commits and pull requests

- One concern per commit; explain *why* in the body, since the *what* is in the diff.
- `npm test`, `npm run typecheck`, and `npm run scan:leaks` should pass before you push.
- Describe what you actually verified. "Ran the app on macOS 15 arm64 and the window opened"
  is more useful than "should work".

## Cutting a release

`CHANGELOG.md` is the user-facing record of what shipped, so a tag is only honest if the
changelog was updated first. Order matters as much as content:

1. Rename the top `## [Unreleased]` heading to `## [<version>] — YYYY-MM-DD`.
2. Insert the fresh, empty `## [Unreleased]` **at the top of the file**, directly under the
   `# Changelog` preamble and above the version you just named.
3. Leave every other version section in strictly descending order.
4. Align `version` in `package.json` with the tag. The tag name is what decides the deb
   filename in CI; `package.json` is only the fallback reading.
5. Commit, push both remotes, then push the tag — the tag is what starts the package build.

Steps 2 and 3 exist because both have been got wrong. An `[Unreleased]` inserted above the
*oldest* section, or a new version section placed after an older one, leaves the file in a
state where the first screen shows a release from several versions ago. Nothing fails: the
tests stay green and the package still builds, so the mistake survives until someone opens
the changelog and draws the wrong conclusion about where the project is.

The invariant is one line: **a reader opening this file sees the current state of the
project without scrolling.** If the newest section is not the first one, the changelog is
lying by omission.

## Reporting a problem

Startup failures are the most common category, and the shell captures the kernel's output
for exactly this reason. Include what the error dialog said, your OS, and your Node
version (`node --version`). Please check the output for anything sensitive before pasting
it — redaction is pattern-based and cannot be complete.

## Debugging: verify the assumption, not the code

A shell bug report usually arrives as "this file/component isn't loading" or "the renderer
is black". The instinct is to check your own code first — the path, the syntax, the
environment. That instinct is often wrong, and acting on it burns hours.

**Reproduce with the smallest thing that shows the symptom.** If a preload script fails,
write a two-line preload and load it in the same runtime. If that fails too, the problem was
never your code. This step found the real cause of a long black-screen hunt in this
repository: a two-line preload failed identically, which ruled out the path, the
permissions, the sandbox helper and the extension, and pointed at the API call itself
(`require('electron')` versus a bare global reference).

**Test one variable at a time, and let the result decide.** Flipping `sandbox: false`
and watching the symptom persist is evidence; flipping it and watching nothing change is
also evidence. Write down what each observation rules *out*, not just what it suggests.

**Prefer a real runtime over a hand-written stand-in.** A fake server you wrote will
happily agree with your assumptions — it will not redirect, it will not set a cookie, it
will not build its URL from `document.baseURI`. When a stub and the product disagree,
the product is right by definition. Every bug in this repository that took more than one
attempt came from the stub, never from the product.

**When the official shell does the same thing, read all of it.** The desktop shell
spreads one capability across several files: data prepared in `main.ts`, handed over
through `desktop-host`, set on the page by the renderer's entry, and read by the kernel.
Copying only the last step produces code that looks right and connects to nothing.
Follow the data from where it is produced to where it is consumed.

**Make the failure observable before guessing.** When a runtime error is ambiguous, add a
probe that turns "is it working?" into a value you can read (`preload.cjs` exposes
`window.__dshPreloadProbe` and reports over IPC; the main process writes the verdict to
`userData/logs/`). One probe run is worth a dozen speculative edits.
