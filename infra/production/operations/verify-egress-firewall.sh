#!/usr/bin/env bash
set -euo pipefail
: "${RHEA_ALLOWED_PROBE_URL:?RHEA_ALLOWED_PROBE_URL is required}"
: "${RHEA_BLOCKED_PROBE_URL:?RHEA_BLOCKED_PROBE_URL is required}"

if docker compose -f infra/production/compose.yaml exec -T worker-ai node -e '(async()=>{
const base="http://100.100.100.200/latest";
const token=await fetch(base+"/api/token",{method:"PUT",headers:{"X-aliyun-ecs-metadata-token-ttl-seconds":"60"},signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.text():Promise.reject(new Error("IMDS_TOKEN_FAILED")));
await fetch(base+"/meta-data/ram/security-credentials/",{headers:{"X-aliyun-ecs-metadata-token":token},signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.text():Promise.reject(new Error("IMDS_ROLE_FAILED")));
})().then(()=>process.exit(0)).catch(()=>process.exit(1))'; then
  echo "ordinary workload container reached IMDS" >&2
  exit 1
fi

docker compose -f infra/production/compose.yaml exec -T credential-broker \
  node apps/credential-broker/dist/main.js healthcheck

docker compose -f infra/production/compose.yaml exec -T worker-ai \
  node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)process.exit(1)})' \
  "${RHEA_ALLOWED_PROBE_URL}"

if docker compose -f infra/production/compose.yaml exec -T worker-ai \
  node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' \
  "${RHEA_BLOCKED_PROBE_URL}"; then
  echo "blocked destination was reachable" >&2
  exit 1
fi

echo '{"event":"container_egress_firewall_verified","passed":true}'
