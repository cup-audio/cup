import { check } from "@patricktree-stack/utils-ecma/assert.utils";
import React from "react";

import { createPlatformPlayers, createPlaybackSession } from "#src/app/player/create-playback.js";
import type { PreparedAudiobook } from "#src/app/player/playback-session.js";
import {
  PlayerHost,
  type LoadedAudiobook,
  type PlayerHostAccount,
  type PlayerHostSnapshot,
} from "#src/app/player/player-host.js";
import type { Player, PlayerSnapshot } from "#src/app/player/player.js";
import { authStateSnapshot, subscribeAuthState } from "#src/auth/account-session.js";
import { fetchAudiobookForPlayer, getLocalPlaybackPosition } from "#src/data-fetching/reader.js";
import { mediaSession } from "#src/platform/media-session.js";
import { STOP_PLAYBACK_EVENT_NAME } from "#src/playback-events.js";

const PlayerHostContext = React.createContext<PlayerHost | null>(null);

export function PlayerHostProvider({ children }: { children: React.ReactNode }) {
  const [host] = React.useState(
    () =>
      new PlayerHost({
        ...createPlatformPlayers(),
        createSession: createPlaybackSession,
        mediaSession,
        getAccount: readPlayerHostAccount,
        getLocalPosition: getLocalPlaybackPosition,
        fetchAudiobook: (conversionId) => fetchAudiobookForPlayer(conversionId),
        now: () => Date.now(),
      }),
  );

  React.useEffect(
    function unloadWhenLeavingTheShell() {
      return () => host.unload();
    },
    [host],
  );

  React.useEffect(
    function adoptWhatPlaysWhenThePageStarts() {
      host.adoptRunningPlayer().catch((error: unknown) => {
        console.error("The player could not take over what played when the page started.", error);
      });
    },
    [host],
  );

  React.useEffect(
    function pauseOnSessionStop() {
      window.addEventListener(STOP_PLAYBACK_EVENT_NAME, host.pause);
      return () => window.removeEventListener(STOP_PLAYBACK_EVENT_NAME, host.pause);
    },
    [host],
  );

  React.useEffect(
    function reportAccountChanges() {
      host.accountChanged();
      return subscribeAuthState(() => queueMicrotask(host.accountChanged));
    },
    [host],
  );

  return <PlayerHostContext value={host}>{children}</PlayerHostContext>;
}

export function usePlayerHost(): PlayerHost {
  const host = React.use(PlayerHostContext);
  check.assert(host, "usePlayerHost must be used below PlayerHostProvider.");
  return host;
}

export function usePlayerHostSnapshot(): PlayerHostSnapshot {
  const host = usePlayerHost();
  return React.useSyncExternalStore(host.subscribe, host.getSnapshot);
}

export function useShownConversion(conversionId: string): void {
  const host = usePlayerHost();

  React.useLayoutEffect(
    function showWhileOnThePage() {
      host.showConversion(conversionId);
      return () => host.hideConversion(conversionId);
    },
    [host, conversionId],
  );
}

type ShownAudiobookPlayback = {
  loaded: LoadedAudiobook | null;
  canPlay: boolean;
  resumePositionMilliseconds: number;
  playFromUnit: (unitIndex: number) => void;
};

export function useShownAudiobook(
  conversionId: string,
  audiobook: PreparedAudiobook,
  receivedAt: number,
): ShownAudiobookPlayback {
  const host = usePlayerHost();
  const { loaded, shown } = usePlayerHostSnapshot();

  React.useLayoutEffect(
    function showLatestVersion() {
      host.showConversion(conversionId, audiobook, receivedAt);
    },
    [host, conversionId, audiobook, receivedAt],
  );

  const isShown = shown?.conversionId === conversionId;
  return {
    loaded: loaded?.conversionId === conversionId ? loaded : null,
    canPlay: isShown && shown.canPlay,
    resumePositionMilliseconds: isShown ? shown.resumePositionMilliseconds : 0,
    playFromUnit: host.playShown,
  };
}

export function usePlayerState<Selected>(
  player: Player,
  select: (snapshot: PlayerSnapshot) => Selected,
): Selected {
  return React.useSyncExternalStore(player.subscribe, () => select(player.getSnapshot()));
}

function readPlayerHostAccount(): PlayerHostAccount {
  const authState = authStateSnapshot();
  if (authState.status === "loading") {
    return { status: "restoring" };
  }

  return {
    status: "known",
    subject: authState.status === "signed-in" ? authState.session.user.id : null,
  };
}
