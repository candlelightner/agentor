/** Runs in the existing networkless, read-only /dev + /sys discovery helper.
 * No node is opened, driver rebound, module loaded or host mount inspected.
 * Refusing ALL storage/hubs also protects unmounted backups, swap and controllers. */
export const HARDWARE_DEVICE_PROBE = String.raw`
import json, os, re, stat
from pathlib import Path
root = Path('/host')
def read(path, default=''):
    try:
        value = path.read_text()[:4096].strip()
        return value if not any(ord(c) < 32 for c in value) else default
    except (OSError, UnicodeError): return default
def link(path):
    try: return path.resolve(strict=True)
    except OSError: return None
def unsupported(reason, evidence=None):
    return dict(supported=False, mode='unsupported', reason=reason, **({'evidence':evidence} if evidence else {}))
result = []
for node in sorted((root/'dev/dri').glob('renderD*')):
    sys = link(root/'sys/class/drm'/node.name/'device')
    if not sys: continue
    nodes = [root/'dev/dri'/p.name for p in (root/'sys/class/drm').iterdir()
             if re.fullmatch(r'(card|renderD)\d+', p.name) and link(p/'device') == sys and (root/'dev/dri'/p.name).exists()]
    driver, iommu = link(sys/'driver'), link(sys/'iommu_group')
    profiles = sorted(p.name for p in (sys/'mdev_supported_types').glob('*'))
    vfs = read(sys/'sriov_totalvfs', '0')
    evidence = dict(driver=driver.name if driver else '', iommuGroup=iommu.name if iommu else '',
                    mediatedProfiles=profiles, sriovTotalVfs=int(vfs) if vfs.isdigit() else 0, bootVga=read(sys/'boot_vga') == '1')
    vendor, product = read(sys/'vendor').removeprefix('0x'), read(sys/'device').removeprefix('0x')
    reason = 'GPU passthrough is unsupported: whole-device assignment needs an isolated, dedicated GPU; shared GPU modes require separate host/guest validation.'
    if vendor == '8086': reason = 'Intel iGPU sharing is unsupported: a DRM render node does not prove VM acceleration; mdev, SR-IOV or native-context must be validated on suitable hardware.'
    result.append(dict(kind='gpu', selector='drm:pci:'+sys.name, name='GPU '+vendor+':'+product+' ('+sys.name+')',
                       vendor=vendor, product=product, deviceNodes=[str(p).removeprefix('/host') for p in nodes],
                       groupIds=sorted(set(p.stat().st_gid for p in nodes)), incus=unsupported(reason, evidence)))
for sys in sorted((root/'sys/bus/usb/devices').glob('*')):
    vendor, product = read(sys/'idVendor'), read(sys/'idProduct')
    if not vendor or not product: continue
    serial = read(sys/'serial'); bus, dev = read(sys/'busnum'), read(sys/'devnum')
    if not bus.isdigit() or not dev.isdigit(): continue
    node = root/('dev/bus/usb/%03d/%03d' % (int(bus),int(dev)))
    if not node.exists() or not stat.S_ISCHR(node.stat().st_mode): continue
    classes = [read(p/'bInterfaceClass') for p in sys.glob(sys.name+':*')]
    classes += [read(p/'bInterfaceClass') for p in sys.parent.glob(sys.name+':*')]
    device_class = read(sys/'bDeviceClass')
    # Bound traversal; never follow sysfs symlinks into unrelated host trees.
    storage = False; count = 0; scan_errors = []
    for path, dirs, files in os.walk(sys.resolve(), onerror=lambda error: scan_errors.append(True)):
        count += 1
        if count > 4096: storage = True; break
        if 'block' in dirs or 'block' in files: storage = True; break
    if scan_errors: storage = True
    safe_classes = {'02','03','07','0a','0b','0e','dc','e0','fe','ff'}
    reason = ''
    if storage or device_class in {'08','09'} or any(c in {'08','09'} for c in classes):
        reason = 'USB storage devices and hubs/controllers are protected, including unmounted backups and host system disks.'
    elif not serial or serial.startswith('port:') or len(serial) > 128:
        reason = 'USB passthrough requires a unique, stable serial number; port-only identity is unsupported.'
    elif not classes or any(c not in safe_classes for c in classes) or device_class not in safe_classes | {'00','ef'}:
        reason = 'USB interface safety could not be established; passthrough is blocked.'
    capability = unsupported(reason) if reason else dict(supported=True, mode='usb-exclusive', reason='Exclusive USB passthrough; reconnect the same serial-numbered device before start.')
    result.append(dict(kind='usb', selector='usb:'+vendor+':'+product+':'+(serial or 'port:'+sys.name),
                       name=(read(sys/'manufacturer')+' '+read(sys/'product','USB '+vendor+':'+product)).strip(),
                       vendor=vendor, product=product, serial=serial or None, deviceNodes=[str(node).removeprefix('/host')],
                       groupIds=[node.stat().st_gid], incus=capability))
for item in result:
    if sum(other['selector'] == item['selector'] for other in result) != 1:
        item['incus'] = unsupported('Device identity is ambiguous; duplicate serial numbers cannot authorize passthrough.')
print(json.dumps(result))
`;
