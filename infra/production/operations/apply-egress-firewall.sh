#!/usr/bin/env bash
set -euo pipefail
: "${RHEA_MANAGED_CIDRS:?RHEA_MANAGED_CIDRS is required}"
: "${RHEA_PROVIDER_IPS:?RHEA_PROVIDER_IPS is required}"

exec 9>/run/lock/rhea-egress-firewall.lock
flock -x 9
replacement_file="$(mktemp)"
trap 'rm -f "$replacement_file"' EXIT

render_rules() {
  local table_name="$1"
  cat <<RULES
table inet ${table_name} {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    ct state established,related accept
    ip daddr { ${RHEA_MANAGED_CIDRS} } tcp dport { 443,5432,6379 } accept
    ip daddr { ${RHEA_PROVIDER_IPS} } tcp dport 443 accept
    ip daddr 100.100.100.200 tcp dport 80 accept
    udp dport 53 ip daddr { ${RHEA_MANAGED_CIDRS} } accept
  }
  chain forward {
    type filter hook forward priority -1; policy drop;
    ct state established,related accept
    iifname "docker0" oifname "docker0" accept
    iifname "br-*" oifname "br-*" accept
    iifname "docker0" ip daddr { ${RHEA_MANAGED_CIDRS} } tcp dport { 443,5432,6379 } accept
    iifname "br-*" ip daddr { ${RHEA_MANAGED_CIDRS} } tcp dport { 443,5432,6379 } accept
    iifname "docker0" ip daddr { ${RHEA_PROVIDER_IPS} } tcp dport 443 accept
    iifname "br-*" ip daddr { ${RHEA_PROVIDER_IPS} } tcp dport 443 accept
    ip saddr 172.30.0.2 ip daddr 100.100.100.200 tcp dport 80 accept
    ip daddr 100.100.100.200 drop
    iifname "docker0" udp dport 53 ip daddr { ${RHEA_MANAGED_CIDRS} } accept
    iifname "br-*" udp dport 53 ip daddr { ${RHEA_MANAGED_CIDRS} } accept
    oifname "docker0" tcp dport 443 accept
    oifname "br-*" tcp dport 443 accept
  }
}
RULES
}

# The delete and replacement are one nftables transaction. Validation failure
# therefore leaves the previous default-deny table in place.
if ! nft list table inet rhea_egress >/dev/null 2>&1; then
  nft add table inet rhea_egress
fi
{
  echo 'delete table inet rhea_egress'
  render_rules rhea_egress
} >"$replacement_file"
nft -c -f "$replacement_file"
nft -f "$replacement_file"
