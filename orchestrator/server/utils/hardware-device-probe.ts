/** Runs in the existing networkless, read-only /dev + /sys discovery helper.
 * No /dev node is opened, driver rebound, module loaded or host mount inspected.
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
def gpu_serial(sys):
    serial = read(sys/'serial')
    if re.fullmatch(r'[A-Za-z0-9._-]{1,128}', serial): return serial
    try:
        with (sys/'vpd').open('rb') as stream: data = stream.read(4097)
    except OSError: return ''
    if len(data) > 4096: return ''
    offset, serials = 0, []
    while offset < len(data):
        tag = data[offset]; offset += 1
        if tag == 0x78: break
        if tag & 0x80:
            if offset + 2 > len(data): return ''
            length = int.from_bytes(data[offset:offset+2], 'little'); offset += 2
        else: length = tag & 7
        end = offset + length
        if end > len(data): return ''
        if tag == 0x90:
            while offset < end:
                if offset + 3 > end: return ''
                key, size = data[offset:offset+2], data[offset+2]; offset += 3
                if offset + size > end: return ''
                if key == b'SN':
                    value = data[offset:offset+size].decode('ascii', errors='replace').strip()
                    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', value): return ''
                    serials.append(value)
                offset += size
        offset = end
    return serials[0] if len(serials) == 1 else ''
result = []
drm_devices = set()
for node in sorted((root/'dev/dri').glob('renderD*')):
    sys = link(root/'sys/class/drm'/node.name/'device')
    if not sys: continue
    drm_devices.add(sys)
    nodes = [root/'dev/dri'/p.name for p in (root/'sys/class/drm').iterdir()
             if re.fullmatch(r'(card|renderD)\d+', p.name) and link(p/'device') == sys and (root/'dev/dri'/p.name).exists()]
    driver, iommu = link(sys/'driver'), link(sys/'iommu_group')
    profiles = sorted(p.name for p in (sys/'mdev_supported_types').glob('*'))
    available, instances = {}, {}
    for profile in profiles:
        path = sys/'mdev_supported_types'/profile
        count = read(path/'available_instances')
        if re.fullmatch(r'i915-GVTg_V[0-9]+_[0-9]+', profile) and read(path/'device_api') == 'vfio-pci' and count.isdigit():
            available[profile] = int(count)
            instances[profile] = sorted(p.name for p in (path/'devices').glob('*')
                                        if re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', p.name) and p.exists())
    vfs = read(sys/'sriov_totalvfs', '0')
    gvt = read(root/'sys/module/i915/parameters/enable_gvt')
    evidence = dict(driver=driver.name if driver else '', iommuGroup=iommu.name if iommu else '',
                    mediatedProfiles=profiles, mediatedAvailable=available, mediatedInstances=instances, sriovTotalVfs=int(vfs) if vfs.isdigit() else 0, bootVga=read(sys/'boot_vga') == '1',
                    **({'gvtEnabled': gvt in {'Y','1'}} if read(sys/'vendor') == '0x8086' and gvt in {'Y','N','0','1'} else {}))
    vendor, product = read(sys/'vendor').removeprefix('0x'), read(sys/'device').removeprefix('0x')
    reason = 'GPU passthrough is unsupported: whole-device assignment needs an isolated, dedicated GPU; shared GPU modes require separate host/guest validation.'
    if vendor == '8086':
        reason = 'Intel mediated GPU is unavailable on the current host; a DRM render node alone does not establish guest acceleration.'
        if gvt in {'N','0'}:
            reason += ' Host GVT-g is disabled; maintenance-time host enablement and an exposed, validated mdev profile are required before mediated sharing can be used.'
        elif not profiles and not int(vfs if vfs.isdigit() else '0'):
            reason += ' The host exposes no mdev profiles or SR-IOV capacity; verify the supported GVT-g host stack before selecting a profile.'
        if evidence['bootVga']:
            reason += ' The host boot GPU must not be detached for whole-device passthrough.'
    capability = unsupported(reason, evidence)
    if vendor == '8086' and driver and driver.name == 'i915' and gvt in {'Y','1'} and available:
        capability = dict(supported=True, mode='gpu-mdev', reason='Intel GVT-g mediated GPU; an operator-selected profile and current capacity are required. Physical GPU stays bound to the host.', evidence=evidence)
    result.append(dict(kind='gpu', selector='drm:pci:'+sys.name, name='GPU '+vendor+':'+product+' ('+sys.name+')',
                       vendor=vendor, product=product, deviceNodes=[str(p).removeprefix('/host') for p in nodes],
                       groupIds=sorted(set(p.stat().st_gid for p in nodes)), incus=capability))
for entry in sorted((root/'sys/bus/pci/devices').glob('*')):
    sys = link(entry)
    if not sys or sys in drm_devices or not re.fullmatch(r'[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]', entry.name): continue
    gpu_class = read(sys/'class')
    if not re.fullmatch(r'0x03[0-9a-f]{4}', gpu_class): continue
    ids = [read(sys/name).removeprefix('0x') for name in ['vendor', 'device', 'subsystem_vendor', 'subsystem_device']]
    serial = gpu_serial(sys)
    driver, iommu = link(sys/'driver'), link(sys/'iommu_group')
    members = sorted(p.name for p in (iommu/'devices').glob('*')) if iommu else []
    boot = read(sys/'boot_vga')
    nonboot = boot == '0' or (not (sys/'boot_vga').exists() and not (sys/'boot_vga').is_symlink() and re.fullmatch(r'0x03(?:02|80)[0-9a-f]{2}', gpu_class))
    evidence = dict(pciAddress=entry.name, driver=driver.name if driver else '',
                    iommuGroup=iommu.name if iommu else '', iommuMembers=members, bootVga=not nonboot)
    reason = ''
    if not serial or not all(re.fullmatch(r'[0-9a-f]{4}', value) for value in ids):
        reason = 'Physical GPU requires a stable serial number and complete PCI identity; missing identity cannot authorize passthrough.'
    elif not nonboot:
        reason = 'Physical GPU must be explicitly identified as a non-boot device; host boot GPUs are protected.'
    elif not iommu or not iommu.name.isdigit() or members != [entry.name] or link(iommu/'devices'/entry.name) != sys:
        reason = 'Physical GPU requires an isolated single-device IOMMU group; group isolation could not be established.'
    elif (driver and driver.name != 'vfio-pci') or (not driver and (sys/'driver').is_symlink()):
        reason = 'Physical GPU is owned by a host driver or its ownership is unknown; operator maintenance must release it before assignment.'
    capability = unsupported(reason, evidence) if reason else dict(supported=True, mode='gpu-physical',
        reason='Exclusive physical GPU passthrough; current identity, isolation and ownership are checked before start.', evidence=evidence)
    # shortcut: GPUs without serial evidence stay unsupported; add identity sources only when independently trustworthy.
    selector = 'pci-gpu:'+':'.join(ids)+':'+serial if serial and all(re.fullmatch(r'[0-9a-f]{4}', value) for value in ids) else 'pci-gpu:unavailable:'+entry.name
    result.append(dict(kind='gpu', selector=selector, name='GPU '+ids[0]+':'+ids[1]+' ('+entry.name+')',
                       vendor=ids[0], product=ids[1], serial=serial or None, deviceNodes=[], groupIds=[], incus=capability))
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
