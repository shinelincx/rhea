resource "alicloud_vpc" "rhea" {
  vpc_name   = var.name_prefix
  cidr_block = "10.30.0.0/16"
}
resource "alicloud_vswitch" "app" {
  vpc_id       = alicloud_vpc.rhea.id
  cidr_block   = "10.30.1.0/24"
  zone_id      = var.zone_id
  vswitch_name = "${var.name_prefix}-app"
}
resource "alicloud_security_group" "app" {
  security_group_name = "${var.name_prefix}-app"
  vpc_id              = alicloud_vpc.rhea.id
  inner_access_policy = "Drop"
}
resource "alicloud_security_group_rule" "https" {
  nic_type          = "intranet"
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "443/443"
  security_group_id = alicloud_security_group.app.id
  cidr_ip           = "0.0.0.0/0"
  policy            = "accept"
  priority          = 1
}
resource "alicloud_security_group_rule" "operator_ssh" {
  nic_type          = "intranet"
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "22/22"
  security_group_id = alicloud_security_group.app.id
  cidr_ip           = var.operator_cidr
  policy            = "accept"
  priority          = 1
}

data "alicloud_account" "current" {}
resource "alicloud_ram_role" "credential_broker" {
  role_name   = "${var.name_prefix}-credential-broker"
  description = "ECS identity used only by the Rhea workload credential broker"
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = ["ecs.aliyuncs.com"] }
    }]
  })
}

locals {
  credential_broker_role_arn = "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.credential_broker.role_name}"
  private_bucket_arn         = "acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.private.bucket}"
  private_objects_arn        = "${local.private_bucket_arn}/ingest-temporary/*"
}

resource "alicloud_ram_role" "object_storage_api" {
  role_name   = "${var.name_prefix}-object-api"
  description = "Short-lived private OSS identity for the Rhea API"
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { RAM = [local.credential_broker_role_arn] }
    }]
  })
}
resource "alicloud_ram_role" "object_storage_ai" {
  role_name   = "${var.name_prefix}-object-ai"
  description = "Short-lived private OSS identity for the Rhea AI worker"
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { RAM = [local.credential_broker_role_arn] }
    }]
  })
}
resource "alicloud_ram_role" "object_storage_privacy" {
  role_name   = "${var.name_prefix}-object-privacy"
  description = "Short-lived delete-only private OSS identity for the Rhea privacy worker"
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { RAM = [local.credential_broker_role_arn] }
    }]
  })
}

resource "alicloud_ram_policy" "credential_broker_assume" {
  policy_name = "${var.name_prefix}-credential-broker-assume"
  description = "Allow only the broker to issue the three scoped workload roles"
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Action = ["sts:AssumeRole"]
      Effect = "Allow"
      Resource = [
        "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_api.role_name}",
        "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_ai.role_name}",
        "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_privacy.role_name}"
      ]
    }]
  })
  force = true
}
resource "alicloud_ram_role_policy_attachment" "credential_broker_assume" {
  role_name   = alicloud_ram_role.credential_broker.role_name
  policy_name = alicloud_ram_policy.credential_broker_assume.policy_name
  policy_type = "Custom"
}

resource "alicloud_ram_policy" "object_storage_api" {
  policy_name = "${var.name_prefix}-object-api"
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Action = [
          "oss:DeleteObject", "oss:DeleteObjectVersion", "oss:GetObject",
          "oss:ListObjects", "oss:ListObjectVersions", "oss:PutObject"
        ]
        Effect   = "Allow"
        Resource = [local.private_bucket_arn, local.private_objects_arn]
      },
      {
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.learning.id}"]
      },
      {
        Action   = ["kms:Decrypt", "kms:Encrypt"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.safety.id}"]
      }
    ]
  })
  force = true
}
resource "alicloud_ram_policy" "object_storage_ai" {
  policy_name = "${var.name_prefix}-object-ai"
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Action = [
          "oss:DeleteObject", "oss:DeleteObjectVersion", "oss:GetObject",
          "oss:ListObjects", "oss:ListObjectVersions", "oss:PutObject"
        ]
        Effect   = "Allow"
        Resource = [local.private_bucket_arn, local.private_objects_arn]
      },
      {
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.learning.id}"]
      },
      {
        Action   = ["kms:Encrypt"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.safety.id}"]
      }
    ]
  })
  force = true
}
resource "alicloud_ram_policy" "object_storage_privacy" {
  policy_name = "${var.name_prefix}-object-privacy"
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Action = [
          "oss:DeleteObject", "oss:DeleteObjectVersion", "oss:GetObject",
          "oss:ListObjects", "oss:ListObjectVersions"
        ]
        Effect   = "Allow"
        Resource = [local.private_bucket_arn, local.private_objects_arn]
      },
      {
        Action   = ["kms:Decrypt"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.learning.id}"]
      },
      {
        Action   = ["kms:Encrypt"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.safety.id}"]
      }
    ]
  })
  force = true
}
resource "alicloud_ram_role_policy_attachment" "object_storage_api" {
  role_name   = alicloud_ram_role.object_storage_api.role_name
  policy_name = alicloud_ram_policy.object_storage_api.policy_name
  policy_type = "Custom"
}
resource "alicloud_ram_role_policy_attachment" "object_storage_ai" {
  role_name   = alicloud_ram_role.object_storage_ai.role_name
  policy_name = alicloud_ram_policy.object_storage_ai.policy_name
  policy_type = "Custom"
}
resource "alicloud_ram_role_policy_attachment" "object_storage_privacy" {
  role_name   = alicloud_ram_role.object_storage_privacy.role_name
  policy_name = alicloud_ram_policy.object_storage_privacy.policy_name
  policy_type = "Custom"
}

# Exactly one active application node; API and workers are separate processes on this node.
resource "alicloud_instance" "active" {
  instance_name              = "${var.name_prefix}-active-1"
  availability_zone          = var.zone_id
  security_groups            = [alicloud_security_group.app.id]
  vswitch_id                 = alicloud_vswitch.app.id
  image_id                   = var.ecs_image_id
  instance_type              = var.ecs_instance_type
  internet_max_bandwidth_out = 0
  system_disk_category       = var.ecs_system_disk_category
  system_disk_encrypted      = true
  system_disk_kms_key_id     = alicloud_kms_key.learning.id
  system_disk_size           = 40
  tags                       = { Role = "single-active-app", RegionBoundary = "Shanghai" }
}
resource "alicloud_ecs_ram_role_attachment" "credential_broker" {
  instance_id   = alicloud_instance.active.id
  ram_role_name = alicloud_ram_role.credential_broker.role_name
}
resource "alicloud_eip_address" "active_gateway" {
  address_name         = "${var.name_prefix}-active-gateway"
  bandwidth            = "10"
  internet_charge_type = "PayByTraffic"
  payment_type         = "PayAsYouGo"
  tags                 = { Role = "controlled-ingress-egress", RegionBoundary = "Shanghai" }
}
resource "alicloud_eip_association" "active_gateway" {
  allocation_id = alicloud_eip_address.active_gateway.id
  instance_id   = alicloud_instance.active.id
}

resource "alicloud_db_instance" "postgres" {
  engine                   = "PostgreSQL"
  engine_version           = "17.0"
  instance_type            = var.rds_instance_type
  instance_storage         = var.rds_storage_gb
  db_instance_storage_type = "cloud_essd"
  category                 = "HighAvailability"
  zone_id                  = var.zone_id
  vswitch_id               = alicloud_vswitch.app.id
  security_ips             = ["10.30.1.0/24"]
  instance_name            = "${var.name_prefix}-postgres"
  encryption_key           = alicloud_kms_key.learning.id
  ssl_action               = "Open"
}
resource "alicloud_rds_account" "migration" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_migration"
  account_password = var.rds_migration_password
  account_type     = "Super"
}
resource "alicloud_rds_account" "api" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_api"
  account_password = var.rds_api_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "ai_worker" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_ai"
  account_password = var.rds_ai_worker_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "domain_worker" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_domain"
  account_password = var.rds_domain_worker_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "safety_worker" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_safety"
  account_password = var.rds_safety_worker_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "recovery" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_recovery"
  account_password = var.rds_recovery_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "provider_governance" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_governance"
  account_password = var.rds_provider_governance_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "support" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_support"
  account_password = var.rds_support_password
  account_type     = "Normal"
}
resource "alicloud_rds_account" "operations" {
  db_instance_id   = alicloud_db_instance.postgres.id
  account_name     = "rhea_operations"
  account_password = var.rds_operations_password
  account_type     = "Normal"
}
resource "alicloud_db_database" "rhea" {
  instance_id    = alicloud_db_instance.postgres.id
  data_base_name = "rhea"
  character_set  = "UTF8"
}
resource "alicloud_db_backup_policy" "rhea" {
  instance_id                 = alicloud_db_instance.postgres.id
  preferred_backup_period     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  preferred_backup_time       = "18:00Z-19:00Z"
  backup_retention_period     = 30
  enable_backup_log           = true
  log_backup_retention_period = 30
}

resource "alicloud_kvstore_instance" "redis" {
  db_instance_name = "${var.name_prefix}-tair"
  vswitch_id       = alicloud_vswitch.app.id
  zone_id          = var.zone_id
  instance_class   = var.redis_instance_class
  instance_type    = "Redis"
  engine_version   = "7.0"
  password         = var.redis_password
  security_ips     = ["10.30.1.0/24"]
  vpc_auth_mode    = "Open"
  tde_status       = "Enabled"
  encryption_key   = alicloud_kms_key.learning.id
  encryption_name  = "AES-CTR-256"
  ssl_enable       = "Enable"
  backup_period    = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  backup_time      = "19:00Z-20:00Z"
}

resource "alicloud_oss_bucket" "private" {
  bucket          = "${var.name_prefix}-private"
  redundancy_type = "ZRS"
  lifecycle {
    ignore_changes = [acl]
  }
  versioning { status = "Enabled" }
  server_side_encryption_rule {
    sse_algorithm     = "KMS"
    kms_master_key_id = alicloud_kms_key.learning.id
  }
  lifecycle_rule {
    id      = "expire-raw-and-exports"
    enabled = true
    prefix  = ""
    expiration { days = 30 }
    noncurrent_version_expiration { days = 30 }
  }
  tags = { DataBoundary = "Shanghai", PublicAccess = "Denied" }
}
resource "alicloud_oss_bucket_acl" "private" {
  bucket = alicloud_oss_bucket.private.bucket
  acl    = "private"
}
resource "alicloud_oss_bucket" "erasure_ledger" {
  bucket          = "${var.name_prefix}-erasure-ledger"
  redundancy_type = "ZRS"
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [acl]
  }
  versioning { status = "Enabled" }
  server_side_encryption_rule {
    sse_algorithm     = "KMS"
    kms_master_key_id = alicloud_kms_key.safety.id
  }
  tags = {
    DataBoundary   = "Shanghai"
    PublicAccess   = "Denied"
    RecoveryLedger = "IndependentFromRdsBackups"
  }
}
resource "alicloud_oss_bucket_acl" "erasure_ledger" {
  bucket = alicloud_oss_bucket.erasure_ledger.bucket
  acl    = "private"
}
resource "alicloud_oss_bucket_worm" "erasure_ledger" {
  bucket                   = alicloud_oss_bucket.erasure_ledger.bucket
  retention_period_in_days = 3650
  status                   = "Locked"
}
resource "alicloud_ram_user" "erasure_ledger_writer" {
  name         = "${var.name_prefix}-erasure-ledger-writer"
  display_name = "Rhea erasure ledger append-only writer"
  force        = true
}
resource "alicloud_ram_user" "erasure_ledger_reader" {
  name         = "${var.name_prefix}-erasure-ledger-recovery-reader"
  display_name = "Rhea erasure ledger recovery reader"
  force        = true
}
resource "alicloud_ram_policy" "erasure_ledger_writer" {
  policy_name = "${var.name_prefix}-erasure-ledger-writer"
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Action   = ["oss:PutObject"]
        Effect   = "Allow"
        Resource = ["acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.erasure_ledger.bucket}/erasure-ledger/*"]
      },
      {
        Action   = ["oss:DeleteObject", "oss:DeleteObjectVersion"]
        Effect   = "Deny"
        Resource = ["acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.erasure_ledger.bucket}/*"]
      },
      {
        Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.safety.id}"]
      }
    ]
  })
  force = true
}
resource "alicloud_ram_policy" "erasure_ledger_reader" {
  policy_name = "${var.name_prefix}-erasure-ledger-reader"
  policy_document = jsonencode({
    Version = "1"
    Statement = [
      {
        Action = ["oss:GetObject", "oss:ListObjects"]
        Effect = "Allow"
        Resource = [
          "acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.erasure_ledger.bucket}",
          "acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.erasure_ledger.bucket}/erasure-ledger/*"
        ]
      },
      {
        Action   = ["oss:DeleteObject", "oss:DeleteObjectVersion", "oss:PutObject"]
        Effect   = "Deny"
        Resource = ["acs:oss:*:${data.alicloud_account.current.id}:${alicloud_oss_bucket.erasure_ledger.bucket}/*"]
      },
      {
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Effect   = "Allow"
        Resource = ["acs:kms:${var.region}:${data.alicloud_account.current.id}:key/${alicloud_kms_key.safety.id}"]
      }
    ]
  })
  force = true
}
resource "alicloud_ram_user_policy_attachment" "erasure_ledger_writer" {
  user_name   = alicloud_ram_user.erasure_ledger_writer.name
  policy_name = alicloud_ram_policy.erasure_ledger_writer.policy_name
  policy_type = "Custom"
}
resource "alicloud_ram_user_policy_attachment" "erasure_ledger_reader" {
  user_name   = alicloud_ram_user.erasure_ledger_reader.name
  policy_name = alicloud_ram_policy.erasure_ledger_reader.policy_name
  policy_type = "Custom"
}
resource "alicloud_kms_key" "learning" {
  description            = "Rhea profile key wrapping"
  automatic_rotation     = "Enabled"
  deletion_protection    = "Enabled"
  pending_window_in_days = 30
  rotation_interval      = "30d"
  status                 = "Enabled"
}
resource "alicloud_kms_key" "safety" {
  description            = "Rhea safety-domain encryption"
  automatic_rotation     = "Enabled"
  deletion_protection    = "Enabled"
  pending_window_in_days = 30
  rotation_interval      = "30d"
  status                 = "Enabled"
}
