# Shanghai single-active operations

The production topology has exactly one active ECS application node in cn-shanghai.
The API and ai, domain, and safety workers are separate read-only containers on
that node. PostgreSQL, Tair, OSS, and KMS are managed Shanghai services; Redis and the
event stream are rebuildable, never authoritative.

An EIP terminates only TCP/443 at the hardened gateway container; outbound traffic uses
the same address and is constrained by the host egress allow-list. Each container receives
its own environment file and PostgreSQL login (`rhea_api`, `rhea_ai`, `rhea_domain`, or `rhea_safety`). Support reads use the separate `rhea_support` login through `SUPPORT_DATABASE_URL`; quality and child-safety operations use `rhea_operations` through `OPERATIONS_DATABASE_URL`. Never copy a database URL between those
files: role memberships intentionally prevent the domain worker from entering the
safety schema and prevent API/AI/safety processes from entering the metrics schema.

Every production PostgreSQL URL, including migration, support, operations, and
recovery URLs, must use the managed internal endpoint and append
`sslmode=verify-full` with the Alibaba Cloud CA installed in the container trust
store. Every production Redis URL must use `rediss://` and certificate
verification. RDS and Tair TLS are enabled by Terraform; plaintext production
connection strings fail the application startup transport gate.

Every API, AI-worker, and safety-worker environment must provide an independent
`SAFETY_TOKEN_PEPPER` and the Terraform `SAFETY_KMS_KEY_ID`. The domain worker does not
receive safety secrets, a workload credential volume, or a safety database role.

The only process allowed to read the ECS metadata identity is `credential-broker`. Populate
its private `/etc/rhea/credential-broker.env` with
`CREDENTIAL_BROKER_BASE_RAM_ROLE_NAME`, `CREDENTIAL_BROKER_API_ROLE_ARN`,
`CREDENTIAL_BROKER_AI_ROLE_ARN`, and `CREDENTIAL_BROKER_SAFETY_ROLE_ARN` from Terraform
outputs. It assumes each role through the Shanghai VPC STS endpoint and atomically rotates
three root-owned, node-group-readable mode-0440 short-lived STS credential files. Each workload mounts only its own named
volume directory and sets `WORKLOAD_ROLE_ARN` to the matching role; Compose fixes
`WORKLOAD_CREDENTIALS_FILE` to `/run/rhea-credentials/credentials.json`. Directory mounts
are required so atomic rename rotation replaces the inode observed by the workload.

The default-deny forwarding rules allow only broker address `172.30.0.2` to call IMDS and
drop all other container traffic to `100.100.100.200`; ordinary containers cannot reach IMDS.
The broker base role has only `sts:AssumeRole`, while the three target roles hold their own
OSS and KMS permissions. This makes a workload role independently revocable and prevents a
compromised workload from selecting another role ARN. Route every structured
`workload_credential_refresh_failed` event to the infrastructure on-call as a critical alert.
Do not place `OBJECT_STORE_ACCESS_KEY` or `OBJECT_STORE_SECRET_KEY` in production private
bucket workloads; those variables are for local S3-compatible development only. The
erasure-ledger writer/reader remain separate principals with their own narrowly scoped
credentials.

The `rhea_safety` database login may assume `rhea_profile_crypto_reader` only for privacy
exports. That role can resolve a profile, check the erasure fence, and read an existing wrapped
data key; it cannot create or update key wraps. Legacy non-envelope objects are returned through
the read-only path without an automatic rewrite, so the safety/privacy workload never needs OSS
Put or learning-key Encrypt.

After provisioning or changing any workload role, run the real Shanghai OSS/KMS permission
smoke test and retain its JSON output with the release evidence:

    docker compose --profile operations run --rm credential-smoke

It exercises API and AI SSE-KMS put/get, privacy deletion, API/AI learning-key round trips,
the safety worker's narrowly scoped learning-key decrypt needed for original-asset export,
the API's audited safety-mapping round trip, AI/safety-worker safety-key encrypt-only boundaries,
and the safety-worker OSS write deny path. A missing `passed: true` result blocks deployment.

Route every structured `challenge_report_classification_failed` event to the child-safety
on-call as a critical alert. It means a deidentified challenge report remains in the durable
safety outbox and will retry automatically, but a person must investigate KMS/database
availability and confirm the pending count returns to zero.

Challenge reports keep only temporary identity tokens in learner-facing and ordinary report
records. The two real profile mappings are independently KMS-encrypted in the `safety` schema
for 180 days. A safety operator can resolve them only through the audited internal report-subject
operation with a concrete investigation reason; direct table reads and all learning-domain roles
remain denied. The safety worker purges mappings at expiry.

The gateway returns 404 for `/internal/operations/`; operations are never reachable on public
TCP/443. An authorized operator must connect from `operator_cidr` over the SSH security-group
rule and create a tunnel to the API's loopback-only port (for example, local port 3300 to
`127.0.0.1:3000`). Each operator has one server-configured role in
`OPERATIONS_PRINCIPAL_ROLES`; every policy-required quality signatory, the evidence operator,
and the independent release manager must use distinct principal IDs and tokens.

Before starting the stack, install the host egress firewall with the private managed
service CIDRs and the contract-approved provider IPs. The application provider gate is
also default-deny and checks exact HTTPS origins, signed capabilities, regions, and data
categories.
The nftables policy covers both host output and Docker forwarding. After each firewall
or Docker upgrade, run `verify-egress-firewall.sh` with one approved and one unapproved
HTTPS probe; the unapproved container request must fail.

Install the two units from `infra/production/systemd` under `/etc/systemd/system`,
place the checkout at `/opt/rhea`, and provide `/etc/rhea/egress-firewall.env` plus
`/etc/rhea/stack.env`. Then run `systemctl daemon-reload` and enable both
`rhea-egress-firewall.service` and `rhea-stack.service`. The firewall unit is a required
predecessor of Docker, while containers use `on-failure` rather than daemon-restart
semantics; a reboot cannot auto-start the stack before the default-deny rules load.

Provision support operators with individual secrets in `SUPPORT_PRINCIPAL_TOKENS` and bind
each map key to the immutable support principal identifier sent by the support console. Do not
configure the development-only shared `SUPPORT_SERVICE_TOKEN` in production. The API opens the
support read transaction only with `SUPPORT_DATABASE_URL` for the dedicated `rhea_support` login.

Before the first API/worker start, import the security-approved provider capability manifest.
The importer verifies its detached Ed25519 signature, writes through the dedicated
`rhea_governance` login, rejects mutation of an existing version, and then reads every version
through a normal runtime credential as a cold-start smoke test:

    PROVIDER_MANIFEST_PUBLIC_KEY_PEM=... GOVERNANCE_DATABASE_URL=... \
    PROVIDER_RUNTIME_DATABASE_URL=... \
    pnpm --filter @rhea/postgres-provider-governance import-manifest -- signed-provider-manifest.json

Disabling or changing a provider requires a newly signed capability version and deployment of
the new version ID; an existing version is immutable.

After a Tair loss, run pnpm --filter @rhea/job-worker rebuild-runtime with the dedicated
`rhea_recovery` database URL, then start the workers. The credential can invoke only the
minimized rebuild snapshot. It reconstructs outstanding OCR/AI/privacy jobs and unexpired
grade-only match entries from PostgreSQL.

Every quarter, restore RDS to an isolated drill VPC and run the following command with
all values supplied from the drill environment:

    DRILL_STARTED_AT=... RESTORE_POINT_LAG_MINUTES=... \
    DRILL_RESTORED_DATABASE_URL=... DRILL_REDIS_URL=... \
    DRILL_KMS_KEY_ID=... WORKLOAD_CREDENTIALS_FILE=... WORKLOAD_ROLE_ARN=... KMS_ENDPOINT=... \
    PRIVACY_TOMBSTONE_PEPPER=... METRICS_TOKEN_PEPPER=... \
    OBJECT_STORE_ENDPOINT=... OBJECT_STORE_REGION=cn-shanghai \
    ERASURE_LEDGER_READ_ACCESS_KEY=... ERASURE_LEDGER_READ_SECRET_KEY=... \
    ERASURE_LEDGER_BUCKET=... \
    node infra/production/operations/recovery-drill.mjs

The safety worker writes that bucket with a separate append-only credential, while the
recovery environment receives a read-only credential. Neither principal may delete an object or
an object version; the bucket also has a locked ten-year WORM policy. The drill reads the erasure ledger from its dedicated versioned OSS bucket—not from the
restored RDS point—and replays those tombstones before availability checks. It verifies the three
schema boundary, KMS availability and destroyed key wrappers, rebuilds Redis from the
authoritative database, and emits a mode-0600 JSON evidence file. Any failed check blocks
production readiness.
