/*
 * PROTOTYPE, throw away. Answers "How do Apple and Google sign-in sit on the login screen of each
 * platform?" (https://github.com/cup-audio/cup/issues/512).
 *
 * Three variants of the sign-in buttons, swapped in wherever `SignInButtons` renders (sign-in
 * dialog, Add sheet, account recovery) when the page URL carries `?variant=A|B|C`, plus
 * `&platform=web|ios|android`. A floating bar (or ← / →, and P for platform) switches them.
 * Only in development builds. Apple does nothing when pressed; Google runs the real sign-in.
 *
 * Verdict (2026-11-23): D, Cup pills in Cup type (Figma-style).
 */
import { css } from "@linaria/core";
import React from "react";
import { createPortal } from "react-dom";

import { DSButton } from "#src/app/design-system/button.js";
import { textStyles } from "#src/app/design-system/text-styles.js";
import { composeClassnames } from "#src/app/utils.js";
import type { SignInMethod } from "#src/auth/account-session.js";

const VARIANTS = {
  A: "Cup pills, both white, Apple first",
  B: "Vendor buttons, both dark, platform first",
  C: "Logo pair, both white",
  D: "Cup pills, Cup type (Figma-style)",
} as const;
type Variant = keyof typeof VARIANTS;
const PLATFORMS = ["web", "ios", "android"] as const;
type Platform = (typeof PLATFORMS)[number];

type Params = { variant: Variant; platform: Platform };

const CHANGE_EVENT = "cup-prototype-change";

function readParams(): Params | undefined {
  if (!import.meta.env.DEV) {
    return undefined;
  }
  const search = new URLSearchParams(window.location.search);
  const variant = search.get("variant");
  if (variant === null || !(variant in VARIANTS)) {
    return undefined;
  }
  const platform = search.get("platform");
  return {
    variant: variant as Variant,
    platform: PLATFORMS.includes(platform as Platform) ? (platform as Platform) : "web",
  };
}

function writeParams(next: Params): void {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", next.variant);
  url.searchParams.set("platform", next.platform);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

let cachedKey = "";
let cached: Params | undefined;
function snapshot(): Params | undefined {
  const next = readParams();
  const key = next ? `${next.variant}/${next.platform}` : "";
  if (key !== cachedKey) {
    cachedKey = key;
    cached = next;
  }
  return cached;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function usePrototypeSignInParams(): Params | undefined {
  return React.useSyncExternalStore(subscribe, snapshot, () => undefined);
}

type ButtonsProps = {
  params: Params;
  pendingMethod: SignInMethod | undefined;
  onSignIn: (method: SignInMethod) => void;
};

export function PrototypeSignInButtons({
  params,
  pendingMethod,
  onSignIn,
}: ButtonsProps): React.JSX.Element {
  const disabled = pendingMethod !== undefined;
  const onApple = () => {
    // eslint-disable-next-line no-alert -- prototype
    window.alert("Prototype: Sign in with Apple would start here.");
  };
  const onGoogle = () => onSignIn("google");
  const Component = { A: VariantA, B: VariantB, C: VariantC, D: VariantD }[params.variant];

  return (
    <>
      <Component
        platform={params.platform}
        disabled={disabled}
        isGooglePending={pendingMethod === "google"}
        onApple={onApple}
        onGoogle={onGoogle}
      />
      {createPortal(<PrototypeSwitcher params={params} />, document.body)}
    </>
  );
}

type VariantProps = {
  platform: Platform;
  disabled: boolean;
  isGooglePending: boolean;
  onApple: () => void;
  onGoogle: () => void;
};

/*
 * Google's branding guidelines (https://developers.google.com/identity/branding-guidelines):
 * Google Sans Medium 14/20; light theme fill #FFFFFF, 1px inside stroke #747775, text #1F1F1F;
 * dark theme fill #131314, stroke #8E918F, text #E3E3E3; the full-colour G on a white ground;
 * padding 12 / 10 / 12 on web and Android, 16 / 12 / 16 on iOS; at least as prominent as other
 * providers, "approximately the same size and ... similar visual weight". Apple's HIG: black,
 * white or white-with-outline; no smaller than other buttons; title 43 % of the height.
 * Google Sans is loaded from Google Fonts here only; production would self-host it.
 */
if (import.meta.env.DEV && !document.querySelector("link[data-prototype-google-sans]")) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Google+Sans:wght@500&display=swap";
  link.dataset["prototypeGoogleSans"] = "";
  document.head.append(link);
}

const GOOGLE_SANS = `"Google Sans", Roboto, system-ui, sans-serif`;
const GOOGLE_LIGHT = { fill: "#FFFFFF", stroke: "#747775", text: "#1F1F1F" };
const GOOGLE_DARK = { fill: "#131314", stroke: "#8E918F", text: "#E3E3E3" };

const fullRow = css`
  display: grid;
  flex-basis: 100%;
  gap: var(--spacing-base);
`;

const pill = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  border-radius: var(--border-radius-full);

  &:hover {
    cursor: pointer;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
`;

/**
 * A: Cup's pill shape for both, both white so neither outweighs the other. Apple is the HIG's
 * "white with outline" in Cup's own type; Google is its light theme in Google Sans. Apple first
 * everywhere.
 */
function VariantA({ platform, disabled, isGooglePending, onApple, onGoogle }: VariantProps) {
  const googlePadding = platform === "ios" ? "0 16px" : "0 12px";
  return (
    <div className={fullRow}>
      <button
        type="button"
        disabled={disabled}
        onClick={onApple}
        className={composeClassnames(textStyles.paragraph, pill)}
        style={{ gap: 8, background: "#fff", color: "#000", border: "1px solid #000" }}
      >
        <AppleLogo style={{ width: 18, height: 18 }} />
        Continue with Apple
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onGoogle}
        className={pill}
        style={{
          gap: platform === "ios" ? 12 : 10,
          padding: googlePadding,
          background: GOOGLE_LIGHT.fill,
          color: GOOGLE_LIGHT.text,
          border: `1px solid ${GOOGLE_LIGHT.stroke}`,
          font: `500 14px/20px ${GOOGLE_SANS}`,
        }}
      >
        <GoogleLogo style={{ width: 20, height: 20 }} />
        {isGooglePending ? "Signing in…" : "Continue with Google"}
      </button>
    </div>
  );
}

/**
 * D: Figma's reading of Google's guidelines. Both buttons are white pills with Cup's ink outline,
 * in Cup's own type at Cup's size, so they match each other and the app. Google keeps what it
 * actually checks: the unmodified full-colour G on white, "Continue with Google", and equal size
 * and weight. It drops the 14/20 Google Sans and the #747775 stroke. Apple first.
 */
function VariantD({ disabled, isGooglePending, onApple, onGoogle }: VariantProps) {
  return (
    <div className={fullRow}>
      <DSButton variant="outlined" disabled={disabled} onClick={onApple} style={{ background: "#fff" }}>
        <AppleLogo style={{ width: 18, height: 18 }} />
        Continue with Apple
      </DSButton>
      <DSButton variant="outlined" disabled={disabled} onClick={onGoogle} style={{ background: "#fff" }}>
        <GoogleLogo style={{ width: 18, height: 18 }} />
        {isGooglePending ? "Signing in…" : "Continue with Google"}
      </DSButton>
    </div>
  );
}

const vendorButton = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 44px;

  &:hover {
    cursor: pointer;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
`;

/**
 * B: each vendor's own button, both dark so they weigh the same: Apple's black system button
 * (as `ASAuthorizationAppleIDButton` and Apple's JS button draw it) and Google's dark theme,
 * rectangular, 44 px. The platform's own provider comes first: Apple on iOS and the web, Google
 * on Android.
 */
function VariantB({ platform, disabled, isGooglePending, onApple, onGoogle }: VariantProps) {
  const apple = (
    <button
      key="apple"
      type="button"
      disabled={disabled}
      onClick={onApple}
      className={vendorButton}
      style={{
        gap: 6,
        background: "#000",
        color: "#fff",
        border: 0,
        borderRadius: 8,
        // 43 % of the height, in the system font as Apple's own button
        font: `500 19px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
      }}
    >
      <AppleLogo style={{ width: 17, height: 17 }} />
      Sign in with Apple
    </button>
  );
  const google = (
    <button
      key="google"
      type="button"
      disabled={disabled}
      onClick={onGoogle}
      className={vendorButton}
      style={{
        gap: platform === "ios" ? 12 : 10,
        padding: platform === "ios" ? "0 16px" : "0 12px",
        background: GOOGLE_DARK.fill,
        color: GOOGLE_DARK.text,
        border: `1px solid ${GOOGLE_DARK.stroke}`,
        borderRadius: 8,
        font: `500 14px/20px ${GOOGLE_SANS}`,
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 24,
          height: 24,
          background: "#fff",
          borderRadius: "50%",
        }}
      >
        <GoogleLogo style={{ width: 16, height: 16 }} />
      </span>
      {isGooglePending ? "Signing in…" : "Sign in with Google"}
    </button>
  );
  return (
    <div className={fullRow}>{platform === "android" ? [google, apple] : [apple, google]}</div>
  );
}

const logoButton = css`
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  background: #fff;
  border-radius: 50%;

  &:hover {
    cursor: pointer;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
`;

/**
 * C: logo-only round buttons side by side under one "Continue with" caption, both white with an
 * outline: Apple's 1:1 logo-only button masked to a circle, Google's G "by itself for action
 * button" inside a boundary.
 */
function VariantC({ disabled, isGooglePending, onApple, onGoogle }: VariantProps) {
  return (
    <div
      className={css`
        display: grid;
        flex-basis: 100%;
        gap: var(--spacing-base);
        justify-items: center;
      `}
    >
      <p className={textStyles.paragraph}>{isGooglePending ? "Signing in…" : "Continue with"}</p>
      <div
        className={css`
          display: flex;
          gap: calc(2 * var(--spacing-base));
        `}
      >
        <button
          type="button"
          aria-label="Sign in with Apple"
          disabled={disabled}
          onClick={onApple}
          className={logoButton}
          style={{ color: "#000", border: "1px solid #000" }}
        >
          <AppleLogo style={{ width: 24, height: 24 }} />
        </button>
        <button
          type="button"
          aria-label="Sign in with Google"
          disabled={disabled}
          onClick={onGoogle}
          className={logoButton}
          style={{ border: `1px solid ${GOOGLE_LIGHT.stroke}` }}
        >
          <GoogleLogo style={{ width: 24, height: 24 }} />
        </button>
      </div>
    </div>
  );
}

function PrototypeSwitcher({ params }: { params: Params }) {
  const keys = Object.keys(VARIANTS) as Variant[];
  const cycleVariant = (step: number) => {
    const index = (keys.indexOf(params.variant) + step + keys.length) % keys.length;
    writeParams({ ...params, variant: keys[index] ?? "A" });
  };
  const cyclePlatform = () => {
    const index = (PLATFORMS.indexOf(params.platform) + 1) % PLATFORMS.length;
    writeParams({ ...params, platform: PLATFORMS[index] ?? "web" });
  };

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) {
        return;
      }
      if (event.key === "ArrowLeft") cycleVariant(-1);
      if (event.key === "ArrowRight") cycleVariant(1);
      if (event.key === "p") cyclePlatform();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Keeps presses on the bar from counting as presses outside the open dialog or sheet.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <div
      data-prototype-switcher=""
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2147483647,
        pointerEvents: "auto",
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "6px 10px",
        background: "#ff3ea5",
        color: "#fff",
        font: "600 12px system-ui, sans-serif",
        borderRadius: 999,
        boxShadow: "0 4px 16px rgb(0 0 0 / 30%)",
        whiteSpace: "nowrap",
      }}
    >
      <button type="button" onClick={() => cycleVariant(-1)} style={switcherButton}>
        ←
      </button>
      <span title={VARIANTS[params.variant]} style={{ font: "inherit" }}>
        {params.variant}: {VARIANTS[params.variant]}
      </span>
      <button type="button" onClick={() => cycleVariant(1)} style={switcherButton}>
        →
      </button>
      <button type="button" onClick={cyclePlatform} style={switcherButton}>
        {params.platform}
      </button>
    </div>
  );
}

const switcherButton: React.CSSProperties = {
  background: "rgb(255 255 255 / 25%)",
  color: "inherit",
  border: 0,
  borderRadius: 999,
  padding: "2px 8px",
  font: "inherit",
  cursor: "pointer",
};

function AppleLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

function GoogleLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" {...props}>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
