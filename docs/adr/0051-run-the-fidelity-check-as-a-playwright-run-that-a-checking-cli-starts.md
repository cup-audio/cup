---
status: accepted
---

# Run the fidelity check as a Playwright run that a checking CLI starts

The fidelity check compares a screen of the web app with the design's image. It needs the gallery server, the Docker browser and the component tests' `mount` fixture, which only Playwright's test runner provides, yet it is a command an operator types with options. [cup-audio/cup#175](https://github.com/cup-audio/cup/pull/175) added it. These decisions were recorded from code comments on 2026-11-23.

## Decision

- [`cli.ts`](../../apps/web-app/fidelity-check/cli.ts) checks the command's options, then hands them to a Playwright run of [`run.ts`](../../apps/web-app/fidelity-check/run.ts), which needs Playwright's runner for the gallery server, the Docker browser and the `mount` fixture. It fails before Playwright starts, so that an error comes with the command's usage, and resolves to the run's exit code.
- Playwright starts the run in a process of its own, so the checked [inputs](../../apps/web-app/fidelity-check/inputs.ts) travel through its environment.
- The CLI forwards signals to the Playwright process: a signal sent to the CLI's process alone, such as a CI timeout's, would otherwise leave Playwright and its gallery server running.
- The run waits for `main` including hidden elements before comparing: a route story renders only after its lazily loaded chunk arrives, some time after mounting, and an open dialog hides `main` from the accessibility tree, though it is still drawn behind it.
- The run prints the fidelity report before asserting, because the report also has to reach a run whose bands all match, for its fonts and colors.
- The run renders at a device scale factor of 3, as on a phone: text at 1x snaps to whole pixels, unlike the design's render.

## Consequences

- Option errors never pay for starting Playwright.
- Every input of the run must be representable as an environment variable.
