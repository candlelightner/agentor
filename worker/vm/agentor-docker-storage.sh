#!/bin/bash
set -eu

# Discover Incus custom block volume attached to VM
# Devices appear under /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_<name> or virtio-incus_<name>
DOCKER_DISK=""
for d in /dev/disk/by-id/*incus_docker* /dev/disk/by-id/*docker*disk*; do
    if [ -b "$d" ]; then
        DOCKER_DISK="$d"
        break
    fi
done

if [ -z "$DOCKER_DISK" ]; then
    # No dedicated block disk attached; use root disk
    exit 0
fi

# Format ext4 with label docker-data if unformatted
if ! blkid "$DOCKER_DISK" >/dev/null 2>&1; then
    echo "[agentor-docker-storage] Initializing ext4 on $DOCKER_DISK..."
    mkfs.ext4 -F -L docker-data "$DOCKER_DISK"
fi

mkdir -p /var/lib/docker
if ! mountpoint -q /var/lib/docker; then
    echo "[agentor-docker-storage] Mounting $DOCKER_DISK to /var/lib/docker..."
    mount -o defaults "$DOCKER_DISK" /var/lib/docker
fi
