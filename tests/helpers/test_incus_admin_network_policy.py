"""Real authority files and stubbed host transports; never touches host networking."""
import copy
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location('admin_network_policy', Path(__file__).resolve().parents[2] / 'scripts/incus-admin-network-policy.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Missing(Exception):
    status_code = 404


class AdminNetworkTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='admin-network-test-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.installation, self.workspace, self.nonce = (str(uuid.uuid4()) for _ in range(3))
        (self.root / 'backup-installation-id').write_text(self.installation)
        (self.root / 'admin').mkdir()
        (self.root / 'users' / 'healthy-owner').mkdir(parents=True)
        self.path = self.root / 'admin' / 'workspace.v1.json'
        self.record = {'schemaVersion': 1, 'id': self.workspace, 'kind': 'administrative', 'trusted': True,
                       'status': 'stopped', 'runtimeKind': 'incus-vm', 'nativeRuntime': {'version': 1,
                           'name': 'agentor-admin-' + self.workspace, 'installationId': self.installation,
                           'nonce': self.nonce, 'image': 'f' * 64, 'overlayVersion': '6', 'overlaySha256': 'e' * 64}}
        self.save()
        self.payload = {'workspaceId': self.workspace}
        self.calls = []
        self.project = {'name': 'agentor', 'config': {'restricted': 'true', 'features.networks': 'false',
            'restricted.devices.nic': 'managed', 'restricted.networks.access': 'workers', 'restricted.devices.pci': 'block'}}
        self.network = self.wrapper = self.instance = None
        self.ports = []
        self.controller = {'Id': 'a' * 64, 'Name': '/agentor-orchestrator', 'State': {'Running': True},
                           'Mounts': [{'Destination': '/data', 'Source': str(self.root), 'RW': True, 'Type': 'bind'}],
                           'NetworkSettings': {'Networks': {}}}
        self.tables = []
        self.rules = [['-N', 'DOCKER-USER'], ['-A', 'FORWARD', '-j', 'DOCKER-USER']]
        self.routes = [{'dst': 'default', 'dev': 'eth0'}, {'dst': '10.42.0.0/24', 'dev': 'eth0', 'scope': 'link'},
                       {'dst': '80.90.0.0/24', 'dev': 'eth0', 'scope': 'link'}]
        managed = MODULE.BASE.ManagedNetworkPolicy(str(self.root), self.installation, 'agentor', 'workers', self.incus, lambda _: self.ports)
        self.policy = MODULE.AdminNetworkPolicy(managed, 'owned-pool', 'agentor-orchestrator', self.docker, self.host_run)
        self.after_call = lambda *_: None

    def save(self):
        self.path.write_text(json.dumps(self.record))

    def incus(self, method, path, body=None, etag=None):
        self.calls.append(('incus', method, path, copy.deepcopy(body)))
        self.after_call('incus', method, path)
        if path.startswith('/1.0/projects/'):
            if method == 'PUT':
                self.assertEqual(etag, 'project-etag')
                self.project.update(body)
            return copy.deepcopy(self.project), 'project-etag'
        if path.startswith('/1.0/instances/'):
            if self.instance is None:
                raise Missing()
            return copy.deepcopy(self.instance), 'instance-etag'
        if method == 'POST':
            self.network = {**copy.deepcopy(body), 'managed': True, 'used_by': []}
            self.network['config']['ipv4.address'] = '10.210.19.1/24'
            return {}, None
        if self.network is None:
            raise Missing()
        if method == 'PUT':
            self.assertEqual(etag, 'network-etag')
            self.network.update(copy.deepcopy(body))
        return copy.deepcopy(self.network), 'network-etag'

    def docker(self, method, path, body=None):
        self.calls.append(('docker', method, path, copy.deepcopy(body)))
        self.after_call('docker', method, path)
        if path.startswith('/containers/'):
            return copy.deepcopy(self.controller)
        if path == '/networks/create':
            self.wrapper = {**copy.deepcopy(body), 'Id': 'b' * 64, 'Containers': {}, 'Scope': 'local',
                            'Attachable': False, 'Ingress': False, 'ConfigOnly': False}
            self.wrapper['IPAM']['Options'] = None  # Actual Engine inspect default.
            return {'Id': 'b' * 64}
        if self.wrapper is None:
            raise Missing()
        if path.endswith('/connect'):
            self.assertEqual(body['Container'], self.controller['Id'])
            address = body['EndpointConfig']['IPAMConfig']['IPv4Address']
            self.wrapper['Containers'][self.controller['Id']] = {'Name': 'agentor-orchestrator', 'EndpointID': 'c' * 64,
                'MacAddress': body['EndpointConfig']['MacAddress'], 'IPv4Address': address + '/24', 'IPv6Address': ''}
            self.controller['NetworkSettings']['Networks'][self.wrapper['Name']] = {
                'NetworkID': self.wrapper['Id'], 'EndpointID': 'c' * 64, 'IPAddress': address}
            self.ports.append('veth-controller')
            return None
        return copy.deepcopy(self.wrapper)

    def host_run(self, *args, data=None):
        self.calls.append(('host', *args, data))
        self.after_call('host', args[0], args)
        if args[:2] == ('ip', '-j'):
            return json.dumps(self.routes).encode()
        if args == ('nft', '-j', 'list', 'tables'):
            return json.dumps({'nftables': [entry for entry in self.tables if 'table' in entry]}).encode()
        if args[:4] == ('nft', '-j', 'list', 'table'):
            entries = [entry for entry in self.tables if next(iter(entry.values()))['family'] == args[4]]
            # Real listings include handles and metadata, which carry no rule authority.
            entries = [{kind: {**value, 'handle': index + 1}} for index, entry in enumerate(entries) for kind, value in entry.items()]
            return json.dumps({'nftables': [{'metainfo': {'version': 'fixture'}}, *entries]}).encode()
        if args == ('nft', '-j', '-f', '-'):
            self.tables.extend(copy.deepcopy(entry['add']) for entry in json.loads(data)['nftables'])
        elif args == ('iptables', '-w', '-S'):
            return '\n'.join(shlex.join(rule) for rule in self.rules).encode()
        elif args[:3] == ('iptables', '-w', '-N'):
            self.rules.append(['-N', args[3]])
        elif args[0] == 'iptables-restore':
            self.rules.extend(shlex.split(line) for line in data.decode().splitlines() if line.startswith('-A '))
        elif args[:3] == ('iptables', '-w', '-I'):
            self.rules.append(['-A', args[3], *args[5:]])
        else:
            self.assertEqual(args, ('nft', '--check', '-j', '-f', '-'))
        return b''

    def owned_instance(self, result):
        labels = {**self.policy.labels(self.policy.authority(self.payload)), 'user.agentor.admin-nonce': self.nonce,
                  'user.agentor.admin-overlay-sha256': 'e' * 64, 'boot.autostart': 'false', 'security.secureboot': 'false', 'limits.memory': '4GiB', 'limits.cpu': '2'}
        name = self.record['nativeRuntime']['name']
        devices = {'root': {'type': 'disk', 'path': '/', 'pool': 'owned-pool'},
                   'workspace': {'type': 'disk', 'path': '/workspace', 'pool': 'owned-pool', 'source': name + '-workspace'},
                   'agents': {'type': 'disk', 'path': '/home/agent/.agent-data', 'pool': 'owned-pool', 'source': name + '-agents'},
                   'eth0': {'type': 'nic', 'name': 'eth0', 'network': result['network'], 'ipv4.address': result['guestAddress'],
                            'hwaddr': result['guestMac'], 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true'}}
        return {'name': name, 'type': 'virtual-machine', 'profiles': [], 'config': labels,
                'devices': devices, 'expanded_devices': copy.deepcopy(devices)}

    def mutations(self):
        return [call for call in self.calls if (call[0] in ('incus', 'docker') and call[1] != 'GET')
                or (call[0] == 'host' and (call[1] == 'iptables-restore' or ('-f' in call and '--check' not in call)
                    or '-I' in call or '-N' in call))]

    def test_fresh_global_without_users_directory_preserves_closed_path_admission(self):
        users = self.root / 'users'
        (users / 'healthy-owner').rmdir()
        users.rmdir()
        before = self.path.read_bytes()
        result = self.policy.ensure(self.payload)
        self.assertEqual(result['ownerId'], '__agentor_admin__')
        self.assertEqual(result['managementAddress'], '10.210.19.2')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(users.exists())  # Authority reads never manufacture user metadata.
        self.calls.clear()
        self.assertEqual(self.policy.inspect(self.payload), result)
        self.assertEqual(self.mutations(), [])
        foreign = self.root / 'foreign'
        foreign.mkdir()
        for target in (foreign, self.root / 'missing-target'):
            with self.subTest(symlink_target=target.name):
                users.symlink_to(target)
                self.calls.clear()
                with self.assertRaises(OSError):
                    self.policy.ensure(self.payload)
                self.assertEqual(self.calls, [])
                users.unlink()
        users.write_text('not a directory')
        with self.assertRaises(OSError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        users.unlink()
        with self.assertRaises(FileNotFoundError):
            MODULE.directory_names(str(self.root / 'missing-root'), ['users'])
        alias = self.root / 'root-alias'
        alias.symlink_to(self.root)
        with self.assertRaises(OSError):
            MODULE.directory_names(str(alias), ['users'])
        (self.root / 'backup-installation-id').write_text(str(uuid.uuid4()))
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_ensure_private_geometry_order_and_idempotent_inspect(self):
        result = self.policy.ensure(self.payload)
        self.assertEqual(result['managementAddress'], '10.210.19.2')
        self.assertEqual(result['guestAddress'], '10.210.19.3')
        self.assertEqual(result['ownerId'], '__agentor_admin__')
        self.assertEqual(result['mcpUrl'], 'http://10.210.19.2:3099/mcp')
        self.assertEqual(self.network['config']['ipv4.dhcp.ranges'], '10.210.19.3-10.210.19.3')
        self.assertTrue(self.wrapper['Internal'])
        self.assertEqual(self.wrapper['IPAM']['Config'][0]['AuxiliaryAddresses'], {'guest': result['guestAddress']})
        mutations = self.mutations()
        firewall = next(index for index, call in enumerate(mutations) if call[:3] == ('host', 'nft', '-j'))
        peer = next(index for index, call in enumerate(mutations) if call[:3] == ('docker', 'POST', '/networks/create'))
        allow = next(index for index, call in enumerate(mutations) if call[:3] == ('incus', 'PUT', '/1.0/projects/agentor'))
        self.assertLess(firewall, peer)
        self.assertLess(peer, allow)
        self.calls.clear()
        self.assertEqual(self.policy.inspect(self.payload), result)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.policy.ensure(self.payload), result)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.project['config']['restricted.devices.pci'], 'block')

    def test_new_private_sibling_routes_do_not_change_existing_firewall_authority(self):
        result = self.policy.ensure(self.payload)
        self.routes.append({'dst': '10.211.20.0/24', 'dev': 'aaSibling', 'scope': 'link'})
        self.calls.clear()
        self.assertEqual(self.policy.inspect(self.payload), result)
        self.assertEqual(self.mutations(), [])

    def test_legacy_identity_names_preserve_uuid_and_hash_only_dns_incompatible_names(self):
        self.assertEqual(MODULE.native_name(self.workspace), 'agentor-admin-' + self.workspace)
        for workspace in ('legacy-admin', 'legacy_admin', 'legacy-', 'a' * 128):
            self.record['id'] = workspace
            self.record['nativeRuntime']['name'] = MODULE.native_name(workspace)
            self.save()
            identity = self.policy.authority({'workspaceId': workspace})
            self.assertEqual(identity['record']['id'], workspace)
            self.assertLessEqual(len(identity['record']['nativeRuntime']['name'] + '-workspace'), 63)
            self.assertRegex(identity['record']['nativeRuntime']['name'], r'^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$')
        with self.assertRaises(MODULE.PolicyError): self.policy.authority({'workspaceId': 'a' * 129})
        self.assertEqual(self.calls, [])

    def test_absent_read_only_inspection_does_not_allocate(self):
        self.assertIsNone(self.policy.inspect(self.payload))
        self.assertEqual(self.mutations(), [])

    def test_exact_request_and_corrupt_authority_make_zero_host_calls(self):
        for payload in ({}, {**self.payload, 'network': 'workers'}, {'workspaceId': '../host'}, {'workspaceId': 1}):
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(payload)
        original = self.path.read_bytes()
        for raw in ('null', '{}', '{', json.dumps({**self.record, 'trusted': False}), json.dumps({**self.record, 'runtimeKind': 'docker'}),
                    json.dumps({**self.record, 'schemaVersion': True}), json.dumps({**self.record, 'groupId': 'foreign'})):
            self.path.write_text(raw)
            with self.assertRaises((MODULE.PolicyError, ValueError)):
                self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        self.path.write_bytes(original)
        self.record['nativeRuntime']['installationId'] = str(uuid.uuid4())
        self.save()
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_group_binding_duplicate_and_unrelated_quarantine_deny(self):
        self.path.unlink()
        record = copy.deepcopy(self.record)
        record.update(kind='group-administrative', ownerId='healthy-owner', groupId='legacy_group')
        group = {'id': 'legacy_group', 'userId': 'healthy-owner', 'adminWorkspace': record}
        path = self.root / 'users' / 'healthy-owner' / 'worker-groups.json'
        path.write_text(json.dumps([group]))
        result = self.policy.ensure(self.payload)
        self.assertEqual(result['ownerId'], 'healthy-owner')
        self.assertEqual(result['groupId'], 'legacy_group')
        self.calls.clear()
        for groups in ([group, group], [{**group, 'userId': 'foreign'}], [{**group, 'adminWorkspace': {**record, 'groupId': 'foreign'}}], {}):
            path.write_text(json.dumps(groups))
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(self.payload)
            self.assertEqual(self.calls, [])
        path.write_text(json.dumps([group]))
        broken = self.root / 'users' / 'quarantined'
        broken.mkdir()
        (broken / 'worker-groups.json').write_text('{')
        with self.assertRaises(ValueError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_authority_reads_refuse_symlink_fifo_and_oversized_files(self):
        self.path.unlink()
        self.path.symlink_to(self.root / 'backup-installation-id')
        with self.assertRaises(OSError):
            self.policy.ensure(self.payload)
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.path.unlink()
        self.path.write_bytes(b'x' * (1024 * 1024 + 1))
        with self.assertRaises(MODULE.PolicyError):
            self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def selected(self, *, seeded=True, target="/opt/application-data"):
        identity = str(uuid.uuid4())
        volume = {"id": identity, "userId": "__agentor_admin__", "workerId": self.workspace,
                  "storageRuntimeKind": "incus-vm", "purpose": "persistent-path", "attached": True,
                  "dockerName": "agentor-persist-" + identity, "seeded": seeded,
                  "state": "ready" if seeded else "pending", "target": target}
        self.record["nativeRuntime"]["selectedVolumeIds"] = [identity]
        self.save()
        directory = self.root / "users" / "__agentor_admin__"
        directory.mkdir(exist_ok=True)
        path = directory / "managed-volumes.v1.json"
        path.write_text(json.dumps([volume]))
        return volume, path

    def test_selected_seeded_disk_and_pending_selection_use_exact_devices(self):
        for seeded in (False, True):
            with self.subTest(seeded=seeded):
                volume, path = self.selected(seeded=seeded)
                result = self.policy.ensure(self.payload)
                self.instance = self.owned_instance(result)
                key = "m" + volume["id"].replace("-", "")[:6]
                device = {"type": "disk", "pool": "owned-pool", "source": volume["dockerName"], "path": volume["target"]}
                if seeded:
                    for field in ("devices", "expanded_devices"):
                        self.instance[field][key] = copy.deepcopy(device)
                self.calls.clear()
                self.assertEqual(self.policy.inspect(self.payload), result)
                self.assertEqual(self.mutations(), [])
                for field in ("devices", "expanded_devices"):
                    self.instance[field][key] = {**device, "source": "/host"}
                with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
                self.instance = None

    def test_selected_volume_authority_and_protected_targets_fail_before_host_calls(self):
        volume, path = self.selected()
        variants = []
        for field, value in (("userId", "foreign"), ("workerId", str(uuid.uuid4())), ("storageRuntimeKind", "legacy-docker"),
                             ("purpose", "legacy-backup-path"), ("attached", False), ("seeded", 1),
                             ("state", "detached"), ("dockerName", "/host"), ("incusLive", {}),
                             ("liveContainerId", None), ("previousRestartPolicy", {}), ("retainedAfterAccountDeletion", True)):
            variants.append({**volume, field: value})
        for target in ("/", "/workspace", "/workspace/child", "/home/agent", "/home/agent/.local",
                       "/home/agent/.local/share/kilo", "/etc", "/run/data", "/opt/../data", "//opt/data",
                       "/opt/data/", "/opt/with\\slash", "/opt/with:colon", "/opt/with\nnewline"):
            variants.append({**volume, "target": target})
        for changed in variants:
            with self.subTest(changed=changed):
                path.write_text(json.dumps([changed]))
                with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
                self.assertEqual(self.calls, [])
        path.write_text(json.dumps([{**volume, "target": "/home/agent/.local/share"}]))
        self.assertEqual(self.policy.authority(self.payload)["selected"][0]["target"], "/home/agent/.local/share")

    def test_explicit_null_selected_receipts_fail_before_host_calls(self):
        volume, path = self.selected()
        self.record["nativeRuntime"]["selectedOperation"] = None
        self.save()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        del self.record["nativeRuntime"]["selectedOperation"]
        self.save()
        path.write_text(json.dumps([{**volume, "operation": None}]))
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.calls, [])

    def test_selected_identity_bounds_collisions_duplicates_and_overlap(self):
        volume, path = self.selected()
        original = copy.deepcopy(self.record)
        for ids in ([volume["id"], volume["id"]], ["../foreign"], [str(uuid.uuid4())] * 33, "invalid"):
            self.record["nativeRuntime"]["selectedVolumeIds"] = ids
            self.save()
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.record = original
        self.save()
        for values in ([], [volume, volume], {}, [{"id": 1}]):
            path.write_text(json.dumps(values))
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        for collision in (False, True):
            other_id = str(uuid.uuid4())
            if collision: other_id = volume["id"][:6] + other_id[6:]
            other = {**volume, "id": other_id, "dockerName": "agentor-persist-" + other_id,
                     "target": "/opt/other" if collision else volume["target"] + "/child"}
            self.record["nativeRuntime"]["selectedVolumeIds"] = [volume["id"], other_id]
            self.save()
            path.write_text(json.dumps([volume, other]))
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_selected_authority_reader_rejects_symlink_fifo_and_oversized_file(self):
        _, path = self.selected()
        path.unlink()
        path.symlink_to(self.root / "backup-installation-id")
        with self.assertRaises(OSError): self.policy.ensure(self.payload)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        path.unlink()
        path.write_bytes(b"x" * (1024 * 1024 + 1))
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])

    def test_selected_staging_requires_exact_receipt_and_never_allows_start(self):
        volume, path = self.selected(seeded=False)
        result = self.policy.ensure(self.payload)
        self.record["nativeRuntime"]["incarnation"] = str(uuid.uuid4())
        receipt = {"volumeId": volume["id"], "operationId": str(uuid.uuid4()),
                   "incarnation": self.record["nativeRuntime"]["incarnation"], "kind": "snapshot"}
        self.record["nativeRuntime"]["selectedOperation"] = receipt
        volume.update(state="preparing", operation={"id": receipt["operationId"], "mode": "recreate", "stage": "copying"})
        path.write_text(json.dumps([volume]))
        self.save()
        self.instance = self.owned_instance(result)
        self.instance["config"]["volatile.uuid"] = receipt["incarnation"]
        key = "m" + volume["id"].replace("-", "")[:6]
        device = {"type": "disk", "pool": "owned-pool", "source": volume["dockerName"],
                  "path": "/run/agentor-volume-seed/" + volume["id"]}
        for kind in ("snapshot", "seed"):
            receipt["kind"] = kind
            self.save()
            for attached in (False, True):
                for field in ("devices", "expanded_devices"):
                    self.instance[field].pop(key, None)
                    if attached: self.instance[field][key] = copy.deepcopy(device)
                self.calls.clear()
                self.assertEqual(self.policy.inspect(self.payload), result)
                self.assertEqual(self.mutations(), [])
                with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        for changed in ({**device, "path": volume["target"]}, {**device, "readonly": "true"}):
            for field in ("devices", "expanded_devices"): self.instance[field][key] = changed
            with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        for field in ("devices", "expanded_devices"): self.instance[field][key] = copy.deepcopy(device)
        volume["operation"]["id"] = str(uuid.uuid4())
        path.write_text(json.dumps([volume]))
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.calls, [])

    def test_group_selected_records_use_authoritative_owner_partition(self):
        volume, path = self.selected()
        self.record.update(kind="group-administrative", ownerId="healthy-owner", groupId="legacy_group")
        group_path = self.root / "users" / "healthy-owner" / "worker-groups.json"
        group_path.write_text(json.dumps([{"id": "legacy_group", "userId": "healthy-owner", "adminWorkspace": self.record}]))
        self.path.unlink()
        volume["userId"] = "healthy-owner"
        group_volumes = group_path.with_name("managed-volumes.v1.json")
        group_volumes.write_text(json.dumps([volume]))
        self.assertEqual(self.policy.authority(self.payload)["selected"], [volume])
        group_volumes.unlink()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        self.assertTrue(path.exists())  # Foreign platform-owner copy is never a fallback.

    def test_selected_receipt_shape_incarnation_and_unsettled_copy_deny(self):
        volume, path = self.selected(seeded=False)
        native = self.record["nativeRuntime"]
        native["incarnation"] = str(uuid.uuid4())
        operation = {"volumeId": volume["id"], "operationId": str(uuid.uuid4()),
                     "incarnation": native["incarnation"], "kind": "seed"}
        volume.update(state="preparing", operation={"id": operation["operationId"], "mode": "recreate", "stage": "copying"})
        path.write_text(json.dumps([volume]))
        self.save()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        variants = [{**operation, field: value} for field, value in (
            ("volumeId", str(uuid.uuid4())), ("operationId", "not-a-uuid"), ("incarnation", str(uuid.uuid4())),
            ("kind", "mount"), ("arbitraryPath", "/host"))]
        for receipt in variants:
            native["selectedOperation"] = receipt
            self.save()
            with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        native["selectedOperation"] = operation
        self.save()
        for state, stage, seeded in (("pending", "copying", False), ("ready", "failed", True),
                                     ("ready", "complete", False), ("preparing", "mounting", False)):
            path.write_text(json.dumps([{**volume, "state": state, "seeded": seeded,
                                         "operation": {**volume["operation"], "stage": stage}}]))
            with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        operation["kind"] = "snapshot"
        self.save()
        path.write_text(json.dumps([{**volume, "seeded": True}]))
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.calls, [])

    def test_unreferenced_attached_native_volume_is_not_silently_omitted(self):
        volume, path = self.selected()
        del self.record["nativeRuntime"]["selectedVolumeIds"]
        self.save()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        for changed in ({**volume, "storageRuntimeKind": "legacy-docker"}, {**volume, "attached": False, "state": "detached"}):
            path.write_text(json.dumps([changed]))
            self.assertEqual(self.policy.authority(self.payload)["selected"], [])
        self.assertEqual(self.calls, [])

    def test_selected_device_receipts_are_strict_and_inspection_never_replays(self):
        volume, path = self.selected(seeded=False)
        result = self.policy.ensure(self.payload)
        native = self.record["nativeRuntime"]
        native["incarnation"] = str(uuid.uuid4())
        operation = {"volumeId": volume["id"], "operationId": str(uuid.uuid4()),
                     "incarnation": native["incarnation"], "kind": "seed"}
        native["selectedOperation"] = operation
        volume.update(state="preparing", operation={"id": operation["operationId"], "mode": "recreate", "stage": "copying"})
        path.write_text(json.dumps([volume]))
        self.save()
        self.instance = self.owned_instance(result)
        self.instance["config"]["volatile.uuid"] = native["incarnation"]
        for device in ({"state": "unknown"}, {"state": "accepted", "operation": "/1.0/operations/" + str(uuid.uuid4())}, {"state": "settled"}):
            operation["device"] = device
            self.save()
            self.calls.clear()
            self.assertEqual(self.policy.inspect(self.payload), result)
            self.assertEqual(self.mutations(), [])
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        for device in ({}, {"state": "accepted"}, {"state": "unknown", "operation": "/1.0/operations/" + str(uuid.uuid4())},
                       {"state": "accepted", "operation": "https://foreign/1.0/operations/" + str(uuid.uuid4())},
                       {"state": "settled", "path": "/host"}):
            operation["device"] = device
            self.save()
            self.calls.clear()
            with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
            self.assertEqual(self.calls, [])

    def test_seed_canonical_transition_requires_stopped_seeded_exact_same_volume(self):
        volume, path = self.selected()
        result = self.policy.ensure(self.payload)
        native = self.record["nativeRuntime"]
        native["incarnation"] = str(uuid.uuid4())
        operation = {"volumeId": volume["id"], "operationId": str(uuid.uuid4()), "incarnation": native["incarnation"],
                     "kind": "seed", "canonical": True, "device": {"state": "settled"}}
        native["selectedOperation"] = operation
        volume["operation"] = {"id": operation["operationId"], "mode": "recreate", "stage": "copying"}
        path.write_text(json.dumps([volume]))
        self.save()
        self.instance = self.owned_instance(result)
        self.instance.update(status="Stopped")
        self.instance["config"]["volatile.uuid"] = native["incarnation"]
        key = "m" + volume["id"].replace("-", "")[:6]
        for target in ("/run/agentor-volume-seed/" + volume["id"], volume["target"]):
            for field in ("devices", "expanded_devices"):
                self.instance[field][key] = {"type": "disk", "pool": "owned-pool", "source": volume["dockerName"], "path": target}
            self.calls.clear()
            self.assertEqual(self.policy.inspect(self.payload), result)
            self.assertEqual(self.mutations(), [])
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.instance["status"] = "Running"
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.instance["status"] = "Stopped"
        for field in ("devices", "expanded_devices"): self.instance[field].pop(key)
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        operation["kind"] = "snapshot"
        self.save()
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.calls, [])

    def test_selected_record_change_during_admission_is_fenced(self):
        volume, path = self.selected()
        def change(kind, method, route):
            if kind == "incus" and method == "POST":
                path.write_text(json.dumps([{**volume, "target": "/opt/changed"}]))
        self.after_call = change
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertIsNone(self.wrapper)
        self.assertEqual(self.tables, [])
        self.assertEqual(self.project["config"]["restricted.networks.access"], "workers")

    def test_deletion_intent_blocks_ensure_without_host_mutation(self):
        result = self.policy.ensure(self.payload)
        self.record["nativeRuntime"]["deleting"] = True
        self.save()
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.policy.inspect(self.payload), result)
        self.assertEqual(self.mutations(), [])

    def test_native_profiles_rawconfig_other_networks_and_disks_are_rejected(self):
        result = self.policy.ensure(self.payload)
        original = self.owned_instance(result)
        variants = []
        for key, value in [('raw.qemu', 'injected'), ('boot.autostart', 'true'), ('user.agentor.owner', 'foreign'), ('limits.memory', '1GiB'), ('limits.cpu', '8')]:
            changed = copy.deepcopy(original)
            changed['config'][key] = value
            variants.append(changed)
        changed = copy.deepcopy(original)
        changed['profiles'] = ['default']
        variants.append(changed)
        for field in ('devices', 'expanded_devices'):
            changed = copy.deepcopy(original)
            changed[field]['eth1'] = {'type': 'nic', 'network': 'workers'}
            variants.append(changed)
            changed = copy.deepcopy(original)
            changed[field]['workspace']['source'] = '/etc'
            variants.append(changed)
            changed = copy.deepcopy(original)
            changed[field]['eth0']['security.ipv4_filtering'] = 'false'
            variants.append(changed)
        for instance in variants:
            self.instance = instance
            self.calls.clear()
            with self.assertRaises(MODULE.PolicyError):
                self.policy.ensure(self.payload)
            self.assertEqual(self.mutations(), [])
        self.instance = original
        self.assertEqual(self.policy.inspect(self.payload), result)

    def test_foreign_native_and_docker_members_are_never_disconnected_or_adopted(self):
        self.policy.ensure(self.payload)
        original = copy.deepcopy(self.network)
        for change in ('identity', 'reference', 'raw'):
            self.network = copy.deepcopy(original)
            if change == 'identity': self.network['config']['user.agentor.owner'] = 'foreign'
            if change == 'reference': self.network['used_by'] = ['/1.0/instances/sibling?project=agentor']
            if change == 'raw': self.network['config']['raw.dnsmasq'] = 'arbitrary'
            self.calls.clear()
            with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
            self.assertEqual(self.mutations(), [])
        self.network = original
        self.wrapper['Containers']['d' * 64] = {'Name': 'ordinary-worker'}
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])
        self.assertIn('d' * 64, self.wrapper['Containers'])

    def test_controller_replacement_and_loopback_bridge_are_rejected(self):
        self.policy.ensure(self.payload)
        self.controller['Id'] = 'd' * 64
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])
        self.controller['Id'] = 'a' * 64
        self.network['config']['ipv4.address'] = '127.0.0.1/24'
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])

    def test_pending_mutation_and_unexpected_kernel_ports_are_rejected(self):
        self.record['nativeRuntime']['pending'] = {'kind': 'create'}
        self.save()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.calls, [])
        del self.record['nativeRuntime']['pending']
        self.save()
        result = self.policy.ensure(self.payload)
        self.ports.append('foreign-veth')
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.mutations(), [])
        self.ports.remove('foreign-veth')
        self.instance = self.owned_instance(result)
        self.instance['config']['volatile.eth0.host_name'] = 'tap-owned'
        self.ports.append('tap-owned')
        self.assertEqual(self.policy.inspect(self.payload), result)

    def test_firewall_failure_never_attaches_peer_or_publishes_project(self):
        def fail(kind, method, path):
            if kind == 'host' and '--check' in path:
                raise MODULE.PolicyError('stub syntax/privilege failure')
        self.after_call = fail
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertIsNone(self.wrapper)
        self.assertEqual(self.project['config']['restricted.networks.access'], 'workers')
        self.assertIsNotNone(self.network)  # No rollback deletion of retained resources.

    def test_authority_change_before_firewall_and_peer_is_fenced(self):
        def change(kind, method, path):
            if kind == 'incus' and method == 'POST':
                self.record['nativeRuntime']['nonce'] = str(uuid.uuid4())
                self.save()
        self.after_call = change
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertIsNone(self.wrapper)
        self.assertEqual(self.tables, [])
        self.assertEqual(self.project['config']['restricted.networks.access'], 'workers')

    def test_firewall_drift_missing_policy_and_ambiguous_uplink_deny_read_only(self):
        self.policy.ensure(self.payload)
        original = copy.deepcopy(self.tables)
        self.tables[-1]['rule']['expr'][-1] = {'accept': None}
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])
        self.tables = []
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.inspect(self.payload)
        self.assertEqual(self.mutations(), [])
        self.tables = original
        self.routes.append({'dst': 'default', 'dev': 'unexpected'})
        self.calls.clear()
        with self.assertRaises(MODULE.PolicyError): self.policy.ensure(self.payload)
        self.assertEqual(self.mutations(), [])


class FirewallSemanticsTests(unittest.TestCase):
    """Exercise emitted rule expressions, not an alternate firewall implementation."""
    def setUp(self):
        self.result = {'network': 'aa012345678901', 'guestAddress': '10.210.19.3', 'managementAddress': '10.210.19.2',
                       'gateway': '10.210.19.1', 'guestMac': '02:01:23:45:67:89', 'installation': str(uuid.uuid4())}
        self.objects = MODULE.firewall_objects({'key': '012345678901'}, self.result, 'eth0', ['10.0.0.0/8', '127.0.0.0/8', '80.90.0.0/24'])

    def verdict(self, family, hook, packet):
        for entry in self.objects:
            rule = entry.get('rule', {})
            if rule.get('family') != family or rule.get('chain') != hook: continue
            matches = True
            for expr in rule['expr']:
                if 'match' not in expr:
                    if matches: return next(iter(expr))
                    break
                match = expr['match']
                left = match['left']
                kind, key = next(iter(left.items()))
                if kind == 'payload': actual = packet.get(key['protocol'] + '.' + key['field'])
                elif kind == 'fib': actual = packet.get('fib.type')
                else: actual = packet.get(kind + '.' + key['key'])
                expected = match['right']
                if isinstance(expected, dict) and 'prefix' in expected:
                    prefix = expected['prefix']
                    matches &= actual is not None and ipaddress.ip_address(actual) in ipaddress.ip_network(f"{prefix['addr']}/{prefix['len']}")
                else: matches &= actual == expected
        return 'accept'  # Unrelated host traffic is outside this table's authority.

    def outgoing(self, **changes):
        return {'meta.iifname': self.result['network'], 'meta.oifname': 'eth0', 'ip.saddr': self.result['guestAddress'],
                'ip.daddr': '1.1.1.1', 'meta.l4proto': 'tcp', 'tcp.dport': 443, 'ct.state': 'new', **changes}

    def test_internet_only_egress_sibling_host_private_and_spoof_denials(self):
        self.assertEqual(self.verdict('inet', 'forward', self.outgoing()), 'accept')
        for change in ({'ip.daddr': '10.9.0.2'}, {'ip.daddr': '80.90.0.7'}, {'ip.daddr': '127.0.0.1'},
                       {'meta.oifname': 'workers'}, {'meta.oifname': 'aaOther'}, {'ip.saddr': '10.210.19.2'},
                       {'fib.type': 'local'}, {'ip.saddr': None, 'ip6.saddr': 'fe80::1'},
                       {'ip.daddr': '10.1.2.3', 'ct.state': 'established'}):
            self.assertEqual(self.verdict('inet', 'forward', self.outgoing(**change)), 'drop', change)
        reply = {'meta.iifname': 'eth0', 'meta.oifname': self.result['network'], 'ip.daddr': self.result['guestAddress'], 'ct.state': 'established'}
        self.assertEqual(self.verdict('inet', 'forward', reply), 'accept')
        for change in ({'ct.state': 'new'}, {'meta.iifname': 'workers'}, {'meta.iifname': 'aaOther'}):
            self.assertEqual(self.verdict('inet', 'forward', {**reply, **change}), 'drop')

    def test_host_input_only_dns_and_dhcp(self):
        dns = self.outgoing(**{'ip.daddr': self.result['gateway'], 'tcp.dport': 53})
        self.assertEqual(self.verdict('inet', 'input', dns), 'accept')
        for port in (22, 3000, 3099, 8443, 8444):
            self.assertEqual(self.verdict('inet', 'input', {**dns, 'tcp.dport': port}), 'drop')
        dhcp = self.outgoing(**{'ip.saddr': '0.0.0.0', 'ip.daddr': '255.255.255.255', 'meta.l4proto': 'udp', 'udp.sport': 68, 'udp.dport': 67})
        self.assertEqual(self.verdict('inet', 'input', dhcp), 'accept')
        self.assertEqual(self.verdict('inet', 'input', {**dhcp, 'udp.sport': 67, 'udp.dport': 68}), 'drop')

    def test_same_bridge_management_only_and_established_controller_replies(self):
        packet = {'meta.ibrname': self.result['network'], 'meta.obrname': self.result['network'],
                  'ether.type': 'ip', 'ether.saddr': self.result['guestMac'], 'ip.saddr': self.result['guestAddress'],
                  'ip.daddr': self.result['managementAddress'], 'meta.l4proto': 'tcp', 'ct.state': 'new'}
        for port in (3000, 3099):
            self.assertEqual(self.verdict('bridge', 'forward', {**packet, 'tcp.dport': port}), 'accept')
        for change in ({'tcp.dport': 22}, {'tcp.dport': 8443}, {'tcp.dport': 2375}, {'ether.type': 'ip6'},
                       {'ether.saddr': '02:ff:ff:ff:ff:ff'}, {'ip.saddr': '10.210.19.4'}, {'ip.daddr': '10.210.19.4'}):
            self.assertEqual(self.verdict('bridge', 'forward', {**packet, 'tcp.dport': 3000, **change}), 'drop')
        self.assertEqual(self.verdict('bridge', 'forward', {**packet, 'tcp.dport': 43210, 'ct.state': 'established'}), 'accept')
        controller = {**packet, 'ether.saddr': '06' + self.result['guestMac'][2:], 'ip.saddr': self.result['managementAddress'],
                      'ip.daddr': self.result['guestAddress'], 'tcp.dport': 8443}
        self.assertEqual(self.verdict('bridge', 'forward', controller), 'accept')


if __name__ == '__main__':
    unittest.main()
