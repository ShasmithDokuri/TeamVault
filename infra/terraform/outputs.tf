output "vpc_id" {
  description = "TeamVault VPC identifier."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet identifiers for database and later EKS workloads."
  value       = [for subnet in aws_subnet.private : subnet.id]
}

output "database_endpoint" {
  description = "Private RDS PostgreSQL endpoint."
  value       = aws_db_instance.main.address
}

output "database_secret_arn" {
  description = "RDS-managed administrator secret ARN; retrieve only through approved secret access."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "private_file_bucket" {
  description = "Private S3 bucket name for API file storage."
  value       = aws_s3_bucket.files.bucket
}

output "api_repository_url" {
  description = "ECR repository URI for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "web_repository_url" {
  description = "ECR repository URI for the frontend image."
  value       = aws_ecr_repository.web.repository_url
}

output "web_load_balancer_dns" {
  description = "Public HTTPS load balancer DNS name."
  value       = aws_lb.web.dns_name
}

output "file_access_policy_arn" {
  description = "Least-privilege S3 policy ARN; attach it only to the approved EKS workload identity."
  value       = aws_iam_policy.files_access.arn
}

output "eks_cluster_name" {
  description = "EKS cluster name for a later explicitly approved deployment."
  value       = aws_eks_cluster.main.name
}

output "api_pod_identity_role_arn" {
  description = "Least-privilege Pod Identity role associated with the TeamVault API service account."
  value       = aws_iam_role.api_pod_identity.arn
}
