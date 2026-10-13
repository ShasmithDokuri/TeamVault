variable "aws_region" {
  description = "AWS region for a later explicitly approved deployment."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Lowercase name prefix used for TeamVault resources."
  type        = string
  default     = "teamvault"
}

variable "environment" {
  description = "Deployment environment label."
  type        = string
  default     = "portfolio"
}

variable "vpc_cidr" {
  description = "IPv4 range reserved for the TeamVault VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "enable_nat_gateway" {
  description = "Whether to create one billable NAT gateway for private-subnet egress. Disabled by default."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "Small initial RDS instance size; review the current cost estimate before deployment."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_storage_gb" {
  description = "Initial encrypted RDS storage in GiB."
  type        = number
  default     = 20
}

variable "db_username" {
  description = "Non-secret initial RDS administrator name; the password is managed by RDS."
  type        = string
  default     = "teamvault_admin"
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN for the public HTTPS listener."
  type        = string
  sensitive   = true
}

variable "deployment_approved" {
  description = "Must be set true only after a reviewed resource-by-resource estimate and explicit user approval."
  type        = bool
  default     = false
}
