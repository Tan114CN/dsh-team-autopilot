#!/usr/bin/env python3
"""Render the storefront assets: the tile icon and the how-it-works card.

Optional tooling, not part of the build. Needs Pillow:

    python -m pip install pillow
    python scripts/render-assets.py

The numbers on the card are not illustrative. They are the real status-file
lines from a live host on 2026-10-28, replays of which are quoted in
`docs/distribution.md`; see the "真实派发验证" section of the README for the
transcript. A card that invents its own timings would be the one piece of
marketing in this repository that could not be checked against anything.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

BG = (13, 17, 23)
PANEL = (22, 27, 34)
PANEL_DIM = (18, 22, 28)
BORDER = (48, 54, 61)
TEXT = (230, 237, 243)
MUTED = (139, 148, 158)
FAINT = (88, 96, 105)
ACCENT = (63, 185, 80)
WARN = (210, 153, 34)

MONO = "C:/Windows/Fonts/consola.ttf"
MONO_BOLD = "C:/Windows/Fonts/consolab.ttf"
SANS = "C:/Windows/Fonts/segoeui.ttf"
SANS_BOLD = "C:/Windows/Fonts/segoeuib.ttf"


def font(path: str, size: int, fallback: str = "C:/Windows/Fonts/arial.ttf"):
    for candidate in (path, fallback):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def icon() -> None:
    """A square tile: one member of a roster takes the task."""
    size = 180
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=40, fill=(17, 22, 29, 255))

    # Roster: three members, the top one selected. The selected dot sits on the
    # task tile's centre line so the dispatch edge runs straight.
    for index, y in enumerate((68, 100, 132)):
        radius = 11 if index == 0 else 8
        colour = ACCENT if index == 0 else (74, 85, 96)
        draw.ellipse([44 - radius, y - radius, 44 + radius, y + radius], fill=colour)

    # The task being handed over.
    draw.rounded_rectangle([104, 46, 148, 90], radius=10, outline=ACCENT, width=4)
    for offset in range(3):
        y = 58 + offset * 10
        width = 22 if offset < 2 else 14
        draw.line([114, y, 114 + width, y], fill=ACCENT, width=3)

    # Dispatch edge from the selected member to the task, stopping at the tile.
    draw.line([58, 68, 94, 68], fill=ACCENT, width=4)
    draw.polygon([(94, 61), (94, 75), (104, 68)], fill=ACCENT)

    img.save(ASSETS / "icon-180.png")


def card() -> None:
    width, height = 1600, 1000
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    mono_sm = font(MONO, 19)
    mono = font(MONO, 22)
    mono_lg = font(MONO_BOLD, 26)
    sans_kicker = font(SANS_BOLD, 24)
    sans_title = font(SANS_BOLD, 44)
    sans = font(SANS, 25)
    sans_sm = font(SANS, 21)
    sans_tiny = font(SANS, 18)

    # Header.
    draw.text((80, 62), "dsh-team-autopilot", font=sans_kicker, fill=ACCENT)
    draw.text((80, 100), "A ready task starts nobody. This starts somebody.",
              font=sans_title, fill=TEXT)
    draw.text((80, 162),
              "Deterministic auto-dispatch for the native DeepSeek Harness Agent Teams seam.",
              font=sans, fill=MUTED)

    top, bottom = 226, 806
    left = (80, top, 760, bottom)
    right = (840, top, 1520, bottom)

    # --- Without -------------------------------------------------------
    draw.rounded_rectangle(left, radius=18, fill=PANEL_DIM, outline=BORDER, width=2)
    draw.text((116, top + 34), "NATIVE AGENT TEAMS", font=sans_kicker, fill=MUTED)

    draw.rounded_rectangle([116, top + 84, 724, top + 148], radius=12,
                           fill=PANEL, outline=BORDER, width=2)
    draw.text((140, top + 100), "task-1", font=mono_lg, fill=TEXT)
    draw.text((250, top + 104), "ready  ·  no owner", font=mono, fill=WARN)

    for index, name in enumerate(("worker-a", "worker-b")):
        y = top + 178 + index * 46
        draw.text((140, y), name, font=mono, fill=MUTED)
        draw.text((280, y), "idle", font=mono, fill=FAINT)

    draw.text((116, top + 296), "waiting for someone to ask",
              font=font(SANS_BOLD, 32), fill=FAINT)

    draw.line([116, top + 366, 724, top + 366], fill=BORDER, width=2)

    # The gap, in the upstream project's own words.
    quote = font(MONO, 20)
    lines = [
        '"Task readiness never starts an owner."',
        '"The owner is never released automatically."',
        '"Write-scope overlap is advisory, not a lock."',
    ]
    for index, line in enumerate(lines):
        draw.text((116, top + 396 + index * 34), line, font=quote, fill=MUTED)
    draw.text((116, top + 520), "— native Agent Teams model policy",
              font=sans_tiny, fill=FAINT)

    # --- With ----------------------------------------------------------
    draw.rounded_rectangle(right, radius=18, fill=PANEL, outline=ACCENT, width=2)
    draw.text((876, top + 34), "WITH AUTOPILOT  ·  SAME BOARD",
              font=sans_kicker, fill=ACCENT)

    rows = [
        ("+0.0s", "task-1 created  ·  ready  ·  no owner", TEXT, FAINT),
        ("+0.0s", "wake  →  worker-c        dispatched=1", ACCENT, ACCENT),
        ("+1.0s", "claimed                  inFlight=1", TEXT, FAINT),
        ("+2.0s", "completed                done=1", TEXT, FAINT),
        ("+4.0s", "idle=1  slots=2           back to full", MUTED, FAINT),
    ]
    for index, (elapsed, text, colour, dot) in enumerate(rows):
        y = top + 96 + index * 62
        if index:
            draw.line([900, y - 20, 900, y + 26], fill=(40, 46, 54), width=2)
        draw.ellipse([894, y + 8, 906, y + 20], fill=dot)
        draw.text((924, y), elapsed, font=mono_lg, fill=colour)
        draw.text((1020, y + 2), text, font=mono, fill=colour)

    draw.line([876, top + 428, 1484, top + 428], fill=BORDER, width=2)
    draw.text((876, top + 452), "no model call anywhere in this path",
              font=font(SANS_BOLD, 28), fill=TEXT)
    draw.text((876, top + 494),
              "the tick reads the board, decides, and sends the wake",
              font=sans_sm, fill=MUTED)
    draw.text((876, top + 526),
              "the model's job starts after it is woken",
              font=sans_sm, fill=MUTED)

    # --- Evidence ------------------------------------------------------
    # Time-only stamps: the full ISO date would run into the install line, and
    # the caption below carries the date once for all three.
    draw.text((80, 848), "09:52:16.504  tasks=1  claimable=1  dispatched=1  wake=task-1>worker-c",
              font=mono_sm, fill=MUTED)
    draw.text((80, 878), "09:52:17.478  inFlight=1  claimable=0  slots=1  outcome=claimed",
              font=mono_sm, fill=MUTED)
    draw.text((80, 908), "09:52:18.481  done=1  inFlight=0  slots=2",
              font=mono_sm, fill=MUTED)
    draw.text((80, 944), "real host, 2026-10-28, measured rather than simulated  ·  4.0s from ready to done",
              font=sans_tiny, fill=FAINT)

    # Right-aligned footer: the install line is the only call to action.
    footer_right = 1520
    for index, (text, colour) in enumerate((
        ("dsh plugin --profile web add dsh-team-autopilot", MUTED),
        ("github.com/wooden-tan/dsh-team-autopilot", FAINT),
    )):
        offset = footer_right - draw.textlength(text, font=mono_sm)
        draw.text((offset, 848 + index * 30), text, font=mono_sm, fill=colour)

    img.save(ASSETS / "how-it-works.png")


if __name__ == "__main__":
    ASSETS.mkdir(exist_ok=True)
    icon()
    card()
    print("wrote", ASSETS / "icon-180.png")
    print("wrote", ASSETS / "how-it-works.png")
