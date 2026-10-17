"""Read-only Intel GVT-g profile admission shared by operator setup/check."""
from pathlib import Path
import re


def require_profile(profile, root=Path('/sys')):
    if not isinstance(profile, str) or not re.fullmatch(r'i915-GVTg_V[0-9]+_[0-9]+', profile):
        raise ValueError('Choose an exact Intel GVT-g profile exposed by this host')
    try:
        if (root / 'module/i915/parameters/enable_gvt').read_text().strip() not in ('Y', '1'):
            raise ValueError('Host GVT-g is disabled; arrange reviewed maintenance-time enablement first')
        matches = []
        for device in (root / 'bus/pci/devices').iterdir():
            if not re.fullmatch(r'[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]', device.name):
                continue
            path = device / 'mdev_supported_types' / profile
            if not path.is_dir():
                continue
            if (device / 'vendor').read_text().strip() != '0x8086' or (device / 'driver').resolve(strict=True).name != 'i915':
                continue
            available = (path / 'available_instances').read_text().strip()
            if (path / 'device_api').read_text().strip() != 'vfio-pci' or not available.isdigit() or int(available) < 1:
                continue
            matches.append(device.name)
        if not matches:
            raise ValueError('Selected Intel GVT-g profile has no available host instance; no GPU policy was enabled')
        return sorted(matches)
    except OSError as error:
        raise ValueError('Cannot verify current Intel GVT-g profile; preserve host configuration') from error
