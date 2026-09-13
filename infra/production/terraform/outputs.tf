output "active_instance_id" {
  value = alicloud_instance.active.id
}
output "active_gateway_ip" {
  value = alicloud_eip_address.active_gateway.ip_address
}
output "credential_broker_ram_role_name" {
  value = alicloud_ram_role.credential_broker.role_name
}
output "object_storage_api_role_arn" {
  value = "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_api.role_name}"
}
output "object_storage_ai_role_arn" {
  value = "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_ai.role_name}"
}
output "object_storage_privacy_role_arn" {
  value = "acs:ram::${data.alicloud_account.current.id}:role/${alicloud_ram_role.object_storage_privacy.role_name}"
}
output "postgres_connection" {
  value     = alicloud_db_instance.postgres.connection_string
  sensitive = true
}
output "redis_connection" {
  value     = alicloud_kvstore_instance.redis.connection_domain
  sensitive = true
}
output "private_bucket" {
  value = alicloud_oss_bucket.private.bucket
}
output "erasure_ledger_bucket" {
  value = alicloud_oss_bucket.erasure_ledger.bucket
}
output "learning_kms_key_id" {
  value = alicloud_kms_key.learning.id
}
output "safety_kms_key_id" {
  value = alicloud_kms_key.safety.id
}
