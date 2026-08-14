#!/usr/bin/env bash
# Agentor worker clipboard setter.
#
# Sets the X11 CLIPBOARD selection on the display currently exported through
# noVNC. The normal worker display is :99, but restored/persistent desktop
# processes may move the live X server to another display.
# argv[1] MUST be exactly one of: image/png | text/plain
#
# Design notes:
#  - Reads stdin to a temp file (never to a shell variable) so binary PNG and
#    large text are handled safely without argv/printf limits.
#  - Enforces a local sanity cap (image 16 MiB, text 1 MiB) as a defence in
#    depth; the orchestrator route already enforces the same caps.
#  - Validates the PNG signature + IHDR chunk for image/png before offering it
#    so a malformed payload can never wedge the X selection owner.
#  - Uses xclip's default daemonisation: the command returns after its owner
#    process has acquired the selection and keeps serving until replacement.
#    A MIME-specific read verifies ownership before this helper returns.
#  - Never logs clipboard contents (no `cat`, no `echo` of the file, no
#    `xclip -o` echo to stdout). Exit status is the only signal.
#  - Cleans up the temp file on every exit path.
#
# Exit codes:
#   0  selection is owned and serving
#   2  bad usage (argc / mime type)
#   3  stdin empty
#   4  payload exceeds local cap
#   5  PNG signature / IHDR validation failed
#   6  xclip not installed
#   7  xclip failed to take ownership / serve

set -u
umask 077

MIME="${1:-}"
IMG_CAP=$((16 * 1024 * 1024))   # 16 MiB
TXT_CAP=$((1 * 1024 * 1024))    # 1 MiB

die() { rc="$1"; shift; printf '%s\n' "$*" >&2; exit "$rc"; }

if [ "$#" -ne 1 ]; then
  die 2 "usage: set.sh <image/png|text/plain>"
fi
case "$MIME" in
  image/png|text/plain) ;;
  *) die 2 "unsupported mime type" ;;
esac

command -v xclip >/dev/null 2>&1 || die 6 "xclip not installed"

TMP="$(mktemp /tmp/agentor-clip.XXXXXX)" || die 7 "mktemp failed"
cleanup() { rm -f "$TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Stream stdin into the temp file with a hard size cap. `head -c` reads at most
# CAP+1 bytes; we then check the resulting size so an oversized payload is
# rejected without reading the whole stream into memory unbounded.
CAP=$IMG_CAP
[ "$MIME" = "text/plain" ] && CAP=$TXT_CAP
head -c $((CAP + 1)) > "$TMP" 2>/dev/null || true
SIZE=$(wc -c < "$TMP" 2>/dev/null | tr -d ' ')
[ -n "$SIZE" ] || SIZE=0
if [ "$SIZE" -eq 0 ]; then
  die 3 "empty clipboard payload"
fi
if [ "$SIZE" -gt "$CAP" ]; then
  die 4 "payload exceeds local cap"
fi

if [ "$MIME" = "image/png" ]; then
  # PNG signature: 89 50 4E 47 0D 0A 1A 0A
  SIG="$(head -c 8 "$TMP" | od -An -tx1 | tr -d ' \n')"
  if [ "$SIG" != "89504e470d0a1a0a" ]; then
    die 5 "png signature mismatch"
  fi
  # IHDR chunk: bytes 8..11 = "IHDR" (49 48 44 52), length word (always 13) at 4..7.
  # Width (big-endian u32) at offset 16, height at 20. Both must be > 0 and sane.
  IHDR_TAG="$(dd if="$TMP" bs=1 skip=12 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [ "$IHDR_TAG" != "49484452" ]; then
    die 5 "png ihdr chunk missing"
  fi
  W="$(dd if="$TMP" bs=1 skip=16 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  H="$(dd if="$TMP" bs=1 skip=20 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  # Reject zero / obviously bogus dimensions. Cap at 65535 (PNG u16 width, u32
  # height but practical VNC desktops are far smaller).
  w_dec=$((0x${W:-0}))
  h_dec=$((0x${H:-0}))
  if [ "$w_dec" -le 0 ] || [ "$h_dec" -le 0 ] || [ "$w_dec" -gt 65535 ] || [ "$h_dec" -gt 65535 ]; then
    die 5 "png dimensions invalid"
  fi
fi

# X11 text consumers conventionally request UTF8_STRING rather than text/plain.
TARGET="$MIME"
[ "$MIME" = "text/plain" ] && TARGET="UTF8_STRING"

# Prefer the display x11vnc is actually exporting. Fall back to the configured
# DISPLAY and then live Xvfb processes. Validate every candidate before use so
# process text can never become an xclip option or shell fragment.
CANDIDATES="$(
  ps -eo args= 2>/dev/null |
    sed -n 's/.*[x]11vnc.*-display[[:space:]]\{1,\}\(:[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p'
)"
CANDIDATES="$CANDIDATES ${DISPLAY:-:99} $(
  ps -eo args= 2>/dev/null |
    sed -n 's/.*[X]vfb[[:space:]]\{1,\}\(:[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\).*/\1/p'
)"

SELECTED_DISPLAY=""
for candidate in $CANDIDATES; do
  case "$candidate" in
    :[0-9]*|:[0-9]*.[0-9]*) ;;
    *) continue ;;
  esac
  # Invalid lookalikes such as :99foo are rejected after the cheap case match.
  printf '%s' "$candidate" | grep -Eq '^:[0-9]+(\.[0-9]+)?$' || continue
  if DISPLAY="$candidate" xclip -selection clipboard -t "$TARGET" -i "$TMP" >/dev/null 2>&1; then
    SELECTED_DISPLAY="$candidate"
    break
  fi
done
[ -n "$SELECTED_DISPLAY" ] || die 7 "xclip failed to take ownership"
DISPLAY="$SELECTED_DISPLAY"
export DISPLAY

# xclip forks its selection owner by default and returns only after reading the
# complete input. The owner retains the bytes in memory, so removing TMP on this
# script's exit is safe.
# Verify the exact target is available. This read is bounded so a broken X
# server cannot hang the API request.
if ! timeout 2 xclip -selection clipboard -t "$TARGET" -o >/dev/null 2>&1; then
  die 7 "xclip owner not ready"
fi

exit 0
