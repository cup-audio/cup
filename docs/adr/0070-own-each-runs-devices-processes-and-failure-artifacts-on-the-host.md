---
status: accepted
---

# Own each run's devices, processes and failure artifacts on the host

[ADR 0018](0018-test-the-mobile-apps-with-appium-through-webdriverio-on-host-owned-emulators-and-simulators.md) has each mobile E2E run boot its own devices and servers on the developer's Mac and never attach to another run's, and [ADR 0026](0026-replay-mobile-e2e-passes-per-platform-and-run-both-platforms-in-parallel.md) runs Android and iOS as two cached Turbo tasks at once. Runs can therefore overlap across checkouts, can be killed halfway, and share one Mac's caches. The suite landed in [cup-audio/cup#211](https://github.com/cup-audio/cup/pull/211); removing what killed runs left behind came in [cup-audio/cup#229](https://github.com/cup-audio/cup/pull/229); the parallel runner and Quick Boot snapshot saving came with the validation gates in [cup-audio/cup#255](https://github.com/cup-audio/cup/pull/255); the cached Turbo tasks in [cup-audio/cup#312](https://github.com/cup-audio/cup/pull/312). These decisions were recorded from code comments on 2026-11-23.

## Decision

Devices per run and per Mac:

- **One device per platform per run**, so spec files run one after another (`fileParallelism: false` in [`vitest.config.ts`](../../qa/mobile-e2e/vitest.config.ts)).
- **The suite's AVD is shared by every checkout on the Mac and only read by runs** ([emulator](../../qa/mobile-e2e/src/android/emulator.ts)). It lives in `~/Library/Caches/cup-mobile-e2e/avd`, outside the checkout and Android Studio's AVD folder. A run's emulator is read-only, so killing it leaves the snapshot unchanged; only the writable emulator that creates the snapshot saves it, because Quick Boot saves the snapshot when a writable emulator quits.
- **The emulator boots headless from the Quick Boot snapshot in read-only mode, so concurrent runs can share the AVD.** The AVD and its snapshot are created once per Mac under a lock; a marker file is written once the snapshot is saved, so an interrupted preparation, which never wrote it, is redone.
- **The guest gets 4096 MB of RAM**, set as a plain number because the emulator ignores a unit suffix and falls back to the profile's 2048. The Pixel 8 profile's 2 GB drove the guest into constant zram swapping during the full suite until adbd stopped answering (2026-11-09).
- **The AVD is named after its RAM** (`cup-mobile-e2e-api36-ram4g`), which its Quick Boot snapshot fixes: a machine with an AVD of another RAM size, such as the earlier 2 GB `cup-mobile-e2e-api36`, creates this one and its snapshot anew.
- **The emulator picks its own console port** and reports it over `-report-console tcp:<port>` to a server the suite listens on; the adb serial follows as `emulator-<console port>`.
- **A run stops its emulator with `adb -s <serial> emu kill`, never `adb kill-server`**, which other runs share.
- **WebDriverAgent builds are shared by every checkout on the Mac**, like the emulator's snapshot, in `~/Library/Caches/cup-mobile-e2e/wda` ([WebDriverAgent](../../qa/mobile-e2e/src/ios/web-driver-agent.ts)). A build is made only when this WebDriverAgent version has not been built with this Xcode on this Mac; sessions start it with `xcodebuild test-without-building`, so later runs never rebuild it.

Runs that die:

- **Each platform's global setup removes what killed runs left behind before it starts** ([Android](../../qa/mobile-e2e/src/android/global-setup.ts), [iOS](../../qa/mobile-e2e/src/ios/global-setup.ts)): a run killed before its teardown, such as with its whole process tree, leaves its emulator running, and a run killed together with its orphan watcher leaves its simulator behind. [`clean-devices.ts`](../../qa/mobile-e2e/src/clean-devices.ts) does the same without starting a run.
- **A left-behind emulator is one whose launcher's parent is `launchd` (process 1)** ([emulator](../../qa/mobile-e2e/src/android/emulator.ts)). An emulator's launcher is the run's child, so once the run dies `launchd` adopts it; its own children, such as QEMU, go with it. Emulators of runs still going, such as in another checkout, still have their run as parent and are kept. The process list comes from `ps -ww`, which keeps `ps` from cutting long command lines, such as QEMU's, to the terminal width. Their read-only runs leave the snapshot unchanged, so a signal is enough; only processes the listing still shows as left-behind emulators get SIGKILL after 15 seconds, since an ID freed in the meantime may belong to another process by now.
- **A run is identified by its process ID and its start time** ([run owner](../../qa/mobile-e2e/src/run-owner.ts)): macOS reuses process IDs, so the ID alone can't tell a dead run from a later, unrelated process. The start time is read from `ps -o pid=,lstart=` in the C locale, which keeps `lstart`'s day and month names in English; it comes from the kernel, so every reading of one process gives the same value.
- **Each run creates its own simulator in the default simulator set**, because WebDriverAgent starts through `xcodebuild`, which sees only the default set. A detached watcher, a shell outside the run's process group so that Ctrl+C or a killed run leaves it running, deletes the simulator once the run's process has exited. Deleting a simulator first stops the `xcodebuild` processes that ran WebDriverAgent on it, since Appium keeps them running after its session and its own exit. The sweep of a dead run's simulator tolerates the dead run's watcher having deleted it in the meantime.
- **Every simulator name carries its owning run**, as `cup-mobile-e2e-<pid>-<started at>-<random>` ([simulator](../../qa/mobile-e2e/src/ios/simulator.ts)). Only names with an owner count for the sweep: a name without one, from before the owner was part of the name, may belong to a run still going in an older checkout, so the sweep never deletes it.
- **The orphan watcher matches WebDriverAgent's `xcodebuild` processes with the pattern `[x]codebuild .*-destination id=<udid>`**: the bracket keeps the pattern from matching the watcher, whose own arguments contain it.
- **Concurrent first WebDriverAgent builds each build into their own folder, and the first rename into the cache wins** ([WebDriverAgent](../../qa/mobile-e2e/src/ios/web-driver-agent.ts)).
- **Locks across processes are directories** ([host](../../qa/mobile-e2e/src/host.ts)), such as for driver installation and snapshot preparation: `mkdir` creates them atomically, and each holds its holder's PID, so a dead holder's lock is taken over. A takeover holds a second lock, `<lockPath>.takeover`: without it, two waiters that both saw the dead holder could both remove the lock, the second removing the lock a new holder took in between. Under the takeover lock the holder is read again, and a lock whose holder is dead can only be removed there, so the removal hits exactly the stale lock. A takeover takes milliseconds, so a takeover lock older than 10 seconds was left by a process that died during its takeover and is removed, since it would otherwise block every later takeover.
- **A global setup settles the app build, the device and Appium with `Promise.allSettled` before acting**, so a failure in one still stops the others in teardown.

Processes and the parallel runner:

- **`run()` in [host](../../qa/mobile-e2e/src/host.ts) listens for `error` as well as `close`**, because a missing executable emits `error` instead of `close`.
- **[`run-e2e.ts`](../../qa/mobile-e2e/src/run-e2e.ts) runs the platforms as two Vitest processes.** One Vitest process cannot run the platforms at once: it awaits each project's global setup in turn, and `fileParallelism: false` puts every spec of both projects into one sequential group. With no arguments it runs both, a Vitest project name runs one, and other arguments go to Vitest unchanged. It sets `FORCE_COLOR` when its own output is a terminal, since piped output is no terminal and Vitest would drop its colors. It ignores SIGINT: Ctrl+C reaches both Vitest processes through the terminal's process group, and a second SIGINT from the runner would make Vitest quit without its teardown, which stops the devices.

Failure artifacts:

- **The fixture keeps a failed test's artifacts before its teardown stops the app** ([fixtures](../../qa/mobile-e2e/src/fixtures.ts)), and stops the test Worker, the fake auth provider and the Sentry stub even when the device does not answer, so no Wrangler process outlives the test.
- **Each capture has a 20-second limit** ([failure artifacts](../../qa/mobile-e2e/src/failure-artifacts.ts)), so a hung command cannot hold up the teardown for long. An artifact that fails or times out is written as `<fileName>.missing.txt` with the reason, so one broken capture never hides the others or the test's own error.
- **The artifacts are captured in a fixed order**: the device log, which needs no Appium session, then through the session the screenshot, the native page source and the WebView's DOM. The DOM comes from the context the test was in when that is a WebView, otherwise from Cup's WebView if the app shows one. Once the session leaves a capture unanswered, the remaining session captures are skipped, so a wedged session costs one timeout, not one per artifact.
- **The iOS device log is the simulator's unified log filtered to the processes a test involves** (Cup, its share extension, WebKit's processes and Safari), over the whole minutes since the test started, since `log show` takes durations in minutes at the finest. Unfiltered, the first minute of a new simulator logged 450,000 lines (86 MB), and its errors alone 50,000, nearly all of system daemons (2026-11-10).
- **A cached pass replays only the log**: `turbo:e2e:android` and `turbo:e2e:ios` declare no outputs ([`turbo.jsonc`](../../qa/mobile-e2e/turbo.jsonc)), because failure artifacts hold absolute paths of the checkout that ran them.

## Consequences

- A killed run costs at most one extra sweep at the next run's start; `pnpm test:e2e:mobile:clean` removes its devices without a run.
- Simulators named before run owners existed are never removed automatically.
- Changing the AVD's RAM means a new AVD name, and with it a new snapshot on every Mac.
- Failure artifacts of a replayed pass do not exist; a failure is never replayed, so they are always from a real run.
