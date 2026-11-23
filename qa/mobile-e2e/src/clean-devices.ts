import { stopOrphanedEmulators } from "#src/android/emulator.ts";
import { deleteOrphanedSimulators } from "#src/ios/simulator.ts";

await stopOrphanedEmulators();
await deleteOrphanedSimulators();
