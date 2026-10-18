#!/bin/bash
set -euo pipefail

fail() { echo "[agentor-docker-storage] ERROR: $*" >&2; exit 1; }
CONFIG=/run/agentor/docker-storage.json
[[ -f "$CONFIG" && ! -L "$CONFIG" ]] || fail "Authoritative Docker storage configuration is missing"
[[ "$(stat -c '%u:%a' "$CONFIG")" == "0:600" ]] || fail "Invalid storage configuration ownership/permissions"
jq -e '.serial == "incus_docker" and (.volume | test("^[A-Za-z0-9_-]+-docker$")) and (.initialize | type == "boolean")' "$CONFIG" >/dev/null \
    || fail "Invalid provisioned Docker volume identity"

# Only the exact serial of Incus device "docker", whose source is checked by
# the orchestrator against worker-owned volume metadata. Never scan unused
# disks or use /dev/sdb as authority.
udevadm settle
DOCKER_DISK=""
for id in /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker /dev/disk/by-id/virtio-incus_docker; do
    if [[ -b "$id" ]]; then
        disk=$(readlink -f "$id")
        [[ -z "$DOCKER_DISK" || "$DOCKER_DISK" == "$disk" ]] || fail "Ambiguous Docker block device"
        DOCKER_DISK="$disk"
    fi
done
[[ -n "$DOCKER_DISK" ]] || fail "Expected Incus Docker block device is absent"
[[ "$(lsblk -dn -o TYPE "$DOCKER_DISK")" == disk ]] || fail "Expected a whole custom block volume"
[[ "$(lsblk -n -o NAME "$DOCKER_DISK" | wc -l)" -eq 1 ]] || fail "Partitioned Docker volume needs explicit recovery"

filesystem=$(blkid -p -s TYPE -o value "$DOCKER_DISK" || true)
if [[ -z "$filesystem" ]]; then
    jq -e '.initialize == true' "$CONFIG" >/dev/null || fail "Initialization not authorized for existing storage"
    wipefs --no-act --json "$DOCKER_DISK" | jq -e '.signatures | length == 0' >/dev/null \
        || fail "Existing signatures detected; refusing to format"
    echo "[agentor-docker-storage] Initializing owned blank Docker volume..."
    mkfs.ext4 -L agentor-docker "$DOCKER_DISK"
elif [[ "$filesystem" != ext4 ]]; then
    fail "Expected ext4 Docker data; refusing to overwrite existing $filesystem"
fi

mkdir -p /var/lib/docker
if mountpoint -q /var/lib/docker; then
    mounted=$(findmnt -n -o SOURCE --target /var/lib/docker)
    [[ "$(readlink -f "$mounted")" == "$DOCKER_DISK" ]] || fail "Docker path is mounted from another source"
else
    echo "[agentor-docker-storage] Mounting $DOCKER_DISK to /var/lib/docker..."
    mount -o defaults "$DOCKER_DISK" /var/lib/docker
fi
[[ "$(findmnt -n -o FSTYPE --target /var/lib/docker)" == ext4 ]] || fail "Docker storage must be native ext4"
