variable "region" {
  type    = string
  default = "cn-shanghai"
  validation {
    condition     = var.region == "cn-shanghai"
    error_message = "Rhea V1 may only deploy in cn-shanghai."
  }
}
variable "zone_id" {
  type = string
}
variable "ecs_image_id" {
  type = string
}
variable "ecs_instance_type" {
  type = string
}
variable "ecs_system_disk_category" {
  type    = string
  default = "cloud_essd"
}
variable "rds_instance_type" {
  type = string
}
variable "rds_storage_gb" {
  type    = number
  default = 100
}
variable "rds_migration_password" {
  type      = string
  sensitive = true
}
variable "rds_api_password" {
  type      = string
  sensitive = true
}
variable "rds_ai_worker_password" {
  type      = string
  sensitive = true
}
variable "rds_domain_worker_password" {
  type      = string
  sensitive = true
}
variable "rds_safety_worker_password" {
  type      = string
  sensitive = true
}
variable "rds_recovery_password" {
  type      = string
  sensitive = true
}
variable "rds_provider_governance_password" {
  type      = string
  sensitive = true
}
variable "rds_support_password" {
  type      = string
  sensitive = true
}
variable "rds_operations_password" {
  type      = string
  sensitive = true
}
variable "redis_instance_class" {
  type = string
}
variable "redis_password" {
  type      = string
  sensitive = true
}
variable "operator_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.operator_cidr)) && !contains(["0.0.0.0/0", "::/0"], var.operator_cidr)
    error_message = "operator_cidr must be a specific operator network, not an open internet range."
  }
}
variable "name_prefix" {
  type    = string
  default = "rhea-v1"
}
