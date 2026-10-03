#!/bin/bash
set -euo pipefail

# ==============================================================================
# build-incus-worker-image.sh
# Deterministic conversion pipeline: Docker/OCI worker image -> Incus VM image
# ==============================================================================

SOURCE_IMAGE="agentor-worker:latest"
ALIAS="agentor-worker"
INCUS_PROJECT="default"
FORCE=false
NO_IMPORT=false
OUTPUT_DIR=""
DISK_SIZE="8G"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_CONTEXT="$REPO_ROOT/worker/vm"

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --source-image <image>   Source worker Docker image (default: agentor-worker:latest)
  --alias <alias>          Incus image alias (default: agentor-worker)
  --project <project>      Incus target project for image (default: default)
  --output-dir <path>      Output directory for converted disk (default: temporary dir)
  --size <size>            Disk size for VM rootfs (default: 8G)
  --force                  Force conversion even if Incus image is up to date
  --no-import              Only produce disk.qcow2 and metadata, skip incus import
  -h, --help               Show this help message
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source-image)
            SOURCE_IMAGE="$2"
            shift 2
            ;;
        --alias)
            ALIAS="$2"
            shift 2
            ;;
        --project)
            INCUS_PROJECT="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --size)
            DISK_SIZE="$2"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --no-import)
            NO_IMPORT=true
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage 1
            ;;
    esac
done

# Prerequisite checks
if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker is required but not installed or not in PATH." >&2
    exit 1
fi

if ! command -v d2vm >/dev/null 2>&1; then
    echo "Error: d2vm is required but not installed or not in PATH." >&2
    exit 1
fi

if ! command -v sgdisk >/dev/null 2>&1; then
    echo "Error: sgdisk is required but not installed or not in PATH." >&2
    exit 1
fi

if ! command -v qemu-img >/dev/null 2>&1; then
    echo "Error: qemu-img is required but not installed or not in PATH." >&2
    exit 1
fi

if [ "$NO_IMPORT" = false ] && ! command -v incus >/dev/null 2>&1; then
    echo "Error: incus is required for image import. Use --no-import if running in isolated builder." >&2
    exit 1
fi

# Verify source Docker image exists
if ! docker image inspect "$SOURCE_IMAGE" >/dev/null 2>&1; then
    echo "Source Docker image '$SOURCE_IMAGE' not found locally. Attempting pull..."
    docker pull "$SOURCE_IMAGE" || {
        echo "Error: Failed to find or pull source image '$SOURCE_IMAGE'." >&2
        exit 1
    }
fi

SOURCE_IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$SOURCE_IMAGE")
echo "==> Source image: $SOURCE_IMAGE ($SOURCE_IMAGE_ID)"

# Check Incus cache / idempotency
if [ "$FORCE" = false ] && [ "$NO_IMPORT" = false ]; then
    EXISTING_FINGERPRINT=$(incus image alias list --project "$INCUS_PROJECT" --format csv 2>/dev/null | grep "^${ALIAS}," | cut -d',' -f2 || true)
    if [ -n "$EXISTING_FINGERPRINT" ]; then
        EXISTING_SOURCE_ID=$(incus image show "$EXISTING_FINGERPRINT" --project "$INCUS_PROJECT" 2>/dev/null | grep 'source_image_id:' | awk '{print $2}' || true)
        if [ "$EXISTING_SOURCE_ID" = "$SOURCE_IMAGE_ID" ]; then
            echo "==> Incus image alias '$ALIAS' ($EXISTING_FINGERPRINT) is already up to date with source image. Skipping conversion (use --force to override)."
            exit 0
        fi
    fi
fi

# Setup working directory
CLEANUP_OUTPUT=false
if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR=$(mktemp -d -t agentor-vm-convert-XXXXXX)
    CLEANUP_OUTPUT=true
fi
mkdir -p "$OUTPUT_DIR"

cleanup() {
    if [ "$CLEANUP_OUTPUT" = true ] && [ -d "$OUTPUT_DIR" ]; then
        rm -rf "$OUTPUT_DIR"
    fi
}
trap cleanup EXIT

STAGE_IMAGE="agentor-worker-vm-stage:${SOURCE_IMAGE_ID:7:12}"

echo "==> Step 1: Building VM-adapted Docker layer on top of $SOURCE_IMAGE..."
docker build \
    -t "$STAGE_IMAGE" \
    -f "$VM_CONTEXT/Dockerfile.vm" \
    --build-arg BASE_IMAGE="$SOURCE_IMAGE" \
    "$VM_CONTEXT"

echo "==> Step 2: Converting container image to bootable disk via d2vm (size: $DISK_SIZE)..."
RAW_PATH="$OUTPUT_DIR/disk.raw"
d2vm convert --raw --bootloader grub-efi --size "$DISK_SIZE" "$STAGE_IMAGE" -o "$RAW_PATH" --force

echo "==> Step 2b: Finalizing GPT partitioning and official GRUB-EFI installation..."
sgdisk -g "$RAW_PATH"
sgdisk -t 1:EF00 "$RAW_PATH"
LOOP_DEV=$(losetup -Pf --show "$RAW_PATH")
MNT_ROOT=$(mktemp -d -t agentor-vm-root-XXXXXX)
MNT_BOOT="$MNT_ROOT/boot"
mount "${LOOP_DEV}p2" "$MNT_ROOT"
mount "${LOOP_DEV}p1" "$MNT_BOOT"
mount --bind /dev "$MNT_ROOT/dev"
mount --bind /proc "$MNT_ROOT/proc"
mount --bind /sys "$MNT_ROOT/sys"

# Install official grub-efi with all modules
chroot "$MNT_ROOT" grub-install --target=x86_64-efi --efi-directory=/boot --bootloader-id=BOOT --removable
chroot "$MNT_ROOT" update-grub

# Write startup.nsh fallback
printf '\\EFI\\BOOT\\BOOTX64.EFI\r\n' > "$MNT_BOOT/startup.nsh"

umount "$MNT_ROOT/sys" "$MNT_ROOT/proc" "$MNT_ROOT/dev" "$MNT_BOOT" "$MNT_ROOT"
rm -rf "$MNT_ROOT"
losetup -d "$LOOP_DEV"

echo "==> Step 2c: Compressing raw disk to qcow2..."
QCOW2_PATH="$OUTPUT_DIR/disk.qcow2"
qemu-img convert -f raw -O qcow2 -c "$RAW_PATH" "$QCOW2_PATH"
rm -f "$RAW_PATH"

echo "==> Step 3: Generating Incus image metadata..."
CREATION_DATE=$(date +%s)
cat <<EOF > "$OUTPUT_DIR/metadata.yaml"
architecture: "x86_64"
creation_date: $CREATION_DATE
properties:
  description: "Agentor Worker VM (Derived from $SOURCE_IMAGE)"
  os: "ubuntu"
  release: "noble"
  source_image: "$SOURCE_IMAGE"
  source_image_id: "$SOURCE_IMAGE_ID"
type: "virtual-machine"
EOF

tar czf "$OUTPUT_DIR/metadata.tar.gz" -C "$OUTPUT_DIR" metadata.yaml

if [ "$NO_IMPORT" = true ]; then
    echo "==> Conversion complete. Artifacts saved in $OUTPUT_DIR:"
    ls -lh "$OUTPUT_DIR/disk.qcow2" "$OUTPUT_DIR/metadata.tar.gz"
    CLEANUP_OUTPUT=false
    exit 0
fi

echo "==> Step 4: Importing converted VM image into Incus..."
# Remove existing alias if already assigned
if incus image alias list --project "$INCUS_PROJECT" --format csv 2>/dev/null | grep -q "^${ALIAS},"; then
    echo "Removing existing alias '$ALIAS'..."
    incus image alias delete "$ALIAS" --project "$INCUS_PROJECT" || true
fi

IMPORT_OUTPUT=$(incus image import "$OUTPUT_DIR/metadata.tar.gz" "$QCOW2_PATH" --project "$INCUS_PROJECT" --alias "$ALIAS")
echo "$IMPORT_OUTPUT"

NEW_FINGERPRINT=$(echo "$IMPORT_OUTPUT" | grep -oE '[a-f0-9]{64}' | head -n 1 || true)
if [ -n "$NEW_FINGERPRINT" ]; then
    echo "==> Successfully imported Incus VM image '$ALIAS' ($NEW_FINGERPRINT)!"
    incus image show "$NEW_FINGERPRINT" --project "$INCUS_PROJECT"
else
    echo "==> Image imported successfully with alias '$ALIAS'."
fi
