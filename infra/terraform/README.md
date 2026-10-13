# TeamVault AWS foundation (Milestone 12)

This directory contains Terraform configuration only. It does not create AWS resources until an operator explicitly approves the resource-by-resource estimate and sets `deployment_approved = true`. The default approval gate is false and prevents a plan/apply from proceeding. Do not remove that gate as a shortcut.

The configuration describes a two-AZ VPC with public ALB subnets and private workload/database subnets, an optional single NAT gateway (disabled by default), encrypted private RDS PostgreSQL with RDS-managed credentials and deletion protection, a private versioned S3 bucket with public access blocked and TLS-only bucket policy, immutable/scanned ECR repositories, an HTTPS ALB using an existing ACM certificate, short-retention CloudWatch log groups, and a narrowly scoped S3 IAM policy. Milestone 13 adds an EKS control plane and managed node group, private ECR/S3/STS/EKS Auth endpoints, and EKS Pod Identity for API file access. The worker and application also need reviewed external Redis and Kafka endpoints; those services are not provisioned here.

No Terraform command has permission to apply resources as part of ordinary local verification. A later, explicitly approved workflow must provide a current cost estimate, the intended region/availability design, a reviewed plan, and a separate approval before `terraform apply`. RDS deletion protection and S3 `force_destroy = false` are intentional safeguards.

Terraform state may contain infrastructure identifiers and secret references. Keep state local only for review or use an approved encrypted remote backend; never commit state, plan files, or real `.tfvars`. The example variables contain no real credentials. This foundation is not yet deployed or verified against AWS.

The EKS endpoint is private-only by default. Cluster creation does not automatically grant Kubernetes administrator access: supply `eks_cluster_admin_role_arn` for the explicitly approved operator role, and set `eks_public_access_cidrs` only to an explicitly reviewed operator CIDR list if a public endpoint is required. The private subnets have no internet route when NAT is disabled; interface endpoints support ECR pulls and Pod Identity, but external Google OAuth, Redis, and Kafka need a separately approved private connectivity or egress design. The managed node group and VPC endpoints have ongoing charges even when the cluster is idle.

Local-only checks, when Terraform CLI is available:

```sh
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

The normal plan is intentionally blocked while `deployment_approved` is false. Do not turn it on until the user has approved a current resource-by-resource cost estimate and deployment plan.
