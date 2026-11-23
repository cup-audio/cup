---
status: accepted
---

# Slide the sheet with filled animations, not transitions

The [sheet](../../apps/web-app/src/app/design-system/sheet.tsx), which holds the Add a Track form, is a Base UI drawer that slides in and away and closes on a pull down. [cup-audio/cup#283](https://github.com/cup-audio/cup/pull/283) added the slide and the pull, and [cup-audio/cup#313](https://github.com/cup-audio/cup/pull/313) stopped the sheet flashing back on the last frame of its slide in WebKit. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Sliding in and away are animations that hold their end with a fill, not transitions.** In WebKit, a transform transition or unfilled animation sampled in its last millisecond showed the value from about a frame after its start, so the sheet flashed back toward where it started for a frame. The backdrop's fade uses filled animations for the same reason.
- **The closed state keeps the slide-out animation.** Base UI drops the ending style on the last frame, so `[data-closed]` repeats the slide-out with a `forwards` fill and the sheet stays still once closed.
- **Keyframes leave out the resting value.** The slide-in has only a `from` keyframe; the missing keyframe stands for the transform the swipe sets, so a pull still moves the opened sheet, and a pull that closes it slides it away from where it was let go. The backdrop's fade-in likewise leaves out its `to`, so a pull still fades it.
- **Transitions only settle a short pull.** A pull too short to close the sheet settles back, and the backdrop fades back in, through transitions on the swipe's transform and opacity.
- **A fast pull hands its speed on.** Base UI sets the swipe strength between 0.1 for a flick and 1 for a slow pull or any other close, which slides away as long as opening slid in; the close duration scales with it.
- **Where a pull starts.** Pulling the sheet down closes it by touch anywhere on the sheet, but by mouse only outside the content (the grabber, the title row and the blank space around them), so text in the content stays selectable. Escape and a press outside close it too.
- **The slide in runs on mount**, so a sheet mounted open slides in as well.
- **Opening focuses the sheet itself**, not a control in it: a focused field would raise the on-screen keyboard over the sheet, and a focused button would show its focus ring.
- **A minimum height, not bottom padding.** The design shows 313 px of the sheet above the bottom edge; the sheet sets that as a minimum height instead of padding below the content, so a short viewport or an open keyboard gives up only blank space.

## Consequences

- The sheet's motion depends on Base UI's `--drawer-swipe-movement-y`, `--drawer-swipe-progress`, `data-ending-style` and `data-closed`; an upgrade that changes them needs the WebKit check again.
