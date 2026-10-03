#!/bin/bash
set -euo pipefail

# Guest-only adaptation of the existing Agentor egress semantics. Own only
# these OUTPUT chains, never flush Docker's chains or change global policies.
# Workers have guest root; this is product policy, not the host boundary.
mode="${1:?network mode required}"
domains="${2:-[]}"
case "$mode" in full|block|block-all|package-managers|custom) ;; *) exit 1 ;; esac
jq -e 'type == "array" and all(.[]; type == "string")' <<< "$domains" >/dev/null
jq -e 'all(.[]; (contains("\n") or contains("\r")) | not)' <<< "$domains" >/dev/null

systemctl stop agentor-dnsmasq.service
systemctl start systemd-resolved.service
for tool in iptables ip6tables; do
    if ! "$tool" -w -S AGENTOR-OUTPUT >/dev/null 2>&1; then
        "$tool" -w -N AGENTOR-OUTPUT
    fi
    "$tool" -w -F AGENTOR-OUTPUT
    if ! "$tool" -w -C OUTPUT -j AGENTOR-OUTPUT >/dev/null 2>&1; then
        "$tool" -w -I OUTPUT 1 -j AGENTOR-OUTPUT
    fi
    "$tool" -w -A AGENTOR-OUTPUT -o lo -j ACCEPT
    "$tool" -w -A AGENTOR-OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done

# resolv.conf is disposable guest state; restore it on every provisioning pass
# before installing the filtering resolver. DHCP/networkd feeds resolved.
ln -sfn /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
if [ "$mode" = full ]; then
    iptables -w -A AGENTOR-OUTPUT -j RETURN
    ip6tables -w -A AGENTOR-OUTPUT -j RETURN
    exit 0
fi

# Existing private-network reachability remains intentionally unchanged.
for subnet in 172.16.0.0/12 10.0.0.0/8 192.168.0.0/16; do
    iptables -w -A AGENTOR-OUTPUT -d "$subnet" -j ACCEPT
done
# Domain policy has always been IPv4. Do not permit an unnoticed IPv6 egress
# bypass when moving from Docker to a dual-stack guest.
ip6tables -w -A AGENTOR-OUTPUT -j DROP
iptables -w -A AGENTOR-OUTPUT -j DROP

if [ "$mode" = block-all ] || { [ "$mode" = block ] && [ "$(jq -r 'length' <<< "$domains")" = 0 ]; }; then
    exit 0
fi

ipset create allowed_ips hash:ip timeout 0 -exist
ipset flush allowed_ips
conf=/run/agentor/firewall-dns.conf
printf 'no-resolv\nlisten-address=127.0.0.55\nbind-interfaces\n' > "$conf"
# Use real DHCP-provided IPv4 resolvers, not the container-only 127.0.0.11 or
# our own stub. Limit the explicit upstream exception to DNS ports only.
upstreams=0
while read -r key address rest; do
    [ "$key" = nameserver ] || continue
    if ! awk -v ip="$address" 'BEGIN { n=split(ip,a,"."); if(n!=4) exit 1; for(i=1;i<=4;i++) if(a[i]!~/^[0-9]+$/ || a[i]>255) exit 1; if(a[1]==0 || a[1]==127 || a[1]>=224) exit 1 }'; then
        continue
    fi
    printf 'server=%s\n' "$address" >> "$conf"
    for protocol in udp tcp; do
        iptables -w -I AGENTOR-OUTPUT 1 -d "$address" -p "$protocol" --dport 53 -j ACCEPT
    done
    upstreams=$((upstreams + 1))
done < /run/systemd/resolve/resolv.conf
[ "$upstreams" -gt 0 ] || { echo 'No usable DHCP IPv4 DNS resolver' >&2; exit 1; }
while IFS= read -r domain; do
    domain="${domain#\*.}"
    # Domain values are server validated, but never allow a newline or dnsmasq
    # directive to become configuration if a custom image calls this helper.
    [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || exit 1
    printf 'ipset=/%s/allowed_ips\n' "$domain" >> "$conf"
done < <(jq -er '.[]' <<< "$domains")
chmod 600 "$conf"
systemctl start agentor-dnsmasq.service
# A failed resolver remains fail-closed, never substitutes a public fallback.
ready=false
for attempt in {1..15}; do
    systemctl is-active --quiet agentor-dnsmasq.service
    if dig @127.0.0.55 localhost A +time=1 +tries=1 +short | grep -qx '127.0.0.1'; then
        ready=true
        break
    fi
    sleep 0.2
done
[ "$ready" = true ] || { echo 'Filtering DNS resolver did not become ready' >&2; exit 1; }
printf 'nameserver 127.0.0.55\n' > /run/agentor/filter-resolv.conf
ln -sfn /run/agentor/filter-resolv.conf /etc/resolv.conf
iptables -w -I AGENTOR-OUTPUT 1 -m set --match-set allowed_ips dst -j ACCEPT
