# TeamVault EKS deployment package

This package describes a Kubernetes deployment; it does not provision or deploy anything. AWS Terraform remains behind `deployment_approved = false`. Do not create AWS resources or incur costs until a current resource-by-resource estimate and deployment plan are approved.

## Service boundaries

- `teamvault-web` is the only public application target. The Terraform ALB targets the EKS managed node group's instances on NodePort `30080`; Nginx serves the React bundle and proxies `/api` and `/socket.io` to the in-cluster `api:3001` Service.
- Two API replicas serve HTTP and authenticated Socket.IO. Liveness checks use `/api/health`; readiness checks query PostgreSQL at `/api/ready`.
- A one-replica outbox worker uses the same API image and database, with Kafka credentials supplied separately. The PostgreSQL outbox remains the durable source; Kafka unavailability does not block API database writes.
- The migration Job runs the numbered migrations before an application rollout. Run one migration Job at a time.
- PostgreSQL is the private RDS database and S3 remains private object storage. Redis and Kafka are external service endpoints; this package does not install either in the cluster or provision managed services for them.

Terraform adds an EKS 1.36 control plane, two-to-four on-demand managed worker nodes, ECR/S3/STS/EKS Auth VPC endpoints for private node operation, control-plane audit logs, and EKS Pod Identity for the API's existing private-file IAM policy. The default is a currently standard-support Kubernetes version, but review the version lifecycle again before a future deployment. Private subnets have no default internet route while `enable_nat_gateway` is false. Google OAuth and externally hosted Kafka/Redis endpoints will require an explicitly designed private route or an approved egress option. Do not enable NAT by default.

## Prerequisites before a real deployment

1. Obtain explicit approval for a current cost estimate, AWS region, availability design, and resource plan. The EKS/Terraform files have not been applied or verified against AWS.
2. Provision and review the Terraform resources only after that approval. Set `eks_cluster_admin_role_arn` to the dedicated operator IAM role; the cluster creator is not granted Kubernetes administrator access automatically. `eks_public_access_cidrs` defaults empty, which keeps the Kubernetes API endpoint private; operate it from a VPC-connected environment. If public access is necessary, use a narrow, reviewed CIDR allowlist.
3. Build and push both images to the immutable ECR repositories using a reviewed Git SHA tag. Replace `ACCOUNT_ID`, region, and image tags in both Kustomize files with the actual ECR image names. The placeholder references intentionally cannot pull an image.
4. Confirm RDS, Redis, Kafka, DNS/TLS, and S3 endpoints and security groups are reachable from the private workload subnets. Redis and Kafka must use TLS and least-privilege credentials in production.
5. Create Kubernetes secrets through an approved AWS Secrets Manager synchronization workflow or another protected secret-management system. Never put values in these manifests, Git, command history, or deployment output:
   - `teamvault-api-secrets`: the API's restricted `DATABASE_URL`, `REDIS_URL`, and optional Google OAuth client values.
   - `teamvault-worker-secrets`: a separate `DATABASE_URL` restricted to the outbox tables and operations needed by the relay. The worker does not receive the API's Redis or OAuth credentials.
   - `teamvault-migration-secrets`: a separate migration-capable `DATABASE_URL`.
   - `teamvault-kafka-secrets`: `KAFKA_BROKERS` and any required SASL username/password/mechanism. `KAFKA_SSL` is set to true in the ConfigMap.
6. Update `WEB_ORIGIN`, `AWS_REGION`, and `S3_BUCKET` in `base/config.yaml`. `WEB_ORIGIN` must exactly match the HTTPS browser origin. The API service account receives S3 access through the Terraform Pod Identity association; the web, worker, and migration accounts have no S3 role.
7. Review database backup and recovery, migration compatibility, alarm thresholds, Kafka topic provisioning, and application database privileges before opening the ALB to users.

The migration secret should use a dedicated migration principal. The API secret should use an application principal with only the privileges needed by the runtime; do not run the API as the RDS master user.

## Local manifest validation

These checks render local YAML only and do not contact AWS or a Kubernetes cluster:

```sh
kubectl kustomize deploy/kubernetes/base
kubectl kustomize deploy/kubernetes/migrations
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
```

The repository's Terraform provider lockfile and initialized provider cache may be required for validation. `terraform init -backend=false` is the local-only initialization command. Do not run `terraform plan` or `terraform apply` without separate approval.

## Reviewed deployment sequence

The following is a future operator procedure, not a claim that a deployment has run. It requires an approved AWS environment, configured `kubectl`, available immutable images, and the externally managed Secrets listed above.

```sh
# Confirm the intended account, region, cluster, and namespace before continuing.
aws sts get-caller-identity
aws eks update-kubeconfig --region <approved-region> --name <approved-cluster>
kubectl config current-context

# Bootstrap namespace and service accounts, then provision/synchronize the external Secrets.
kubectl apply -f deploy/kubernetes/base/namespace.yaml
kubectl -n teamvault apply -f deploy/kubernetes/base/service-accounts.yaml
kubectl -n teamvault apply -f deploy/kubernetes/base/config.yaml

# Run the migration Job first and wait for success before changing app Deployments.
kubectl apply -k deploy/kubernetes/migrations
kubectl -n teamvault wait --for=condition=complete job/teamvault-migrations --timeout=15m
kubectl -n teamvault logs job/teamvault-migrations

# Roll out workloads only after migrations completed successfully.
kubectl apply -k deploy/kubernetes/base
kubectl -n teamvault rollout status deployment/teamvault-api --timeout=5m
kubectl -n teamvault rollout status deployment/teamvault-web --timeout=5m
kubectl -n teamvault rollout status deployment/teamvault-outbox-worker --timeout=5m
kubectl -n teamvault get pods,services,pdb
```

Before rerunning migrations while the previous Job still exists, inspect it and remove only the completed Job object (`kubectl -n teamvault delete job/teamvault-migrations`). This does not delete database rows, volumes, or migration history. The Job's one-hour TTL normally removes its Kubernetes object automatically.

## Health, rollout, and rollback

Check `/api/health` for process liveness and `/api/ready` for database readiness. Confirm the browser through the ALB HTTPS endpoint, then exercise registration, workspace isolation, files, and realtime behavior against the intended environment. These production checks have not been run.

For an application rollback, select the previous immutable image tag in Kustomize and reapply the base package, then verify the Deployment rollout and API readiness. Do not roll back a database migration by deleting or resetting database contents. Current numbered migrations are additive; any future non-additive migration needs an expand/contract release plan and a tested backup restore procedure before rollout.

## Known operational limits

- No AWS deployment, managed service connectivity, TLS certificate, Secrets Manager synchronization, or Kubernetes rollout has been verified.
- The ALB points at all managed node instances through a Terraform Auto Scaling attachment; service readiness is enforced by pod readiness and the ALB health path. Review ALB target health after each rollout.
- Kubernetes NetworkPolicy enforcement is not configured here; the EKS VPC CNI must be configured to enforce policies before network-policy manifests can be relied on. ClusterIP scope, security groups, authentication, and database workspace scoping remain the current controls.
- The worker starts at one replica. The outbox supports leased concurrent claims, but scaling and lag/dead-letter alerts belong to the operational-readiness milestone.
- Socket.IO relies on shared Redis for cross-replica rooms. During Redis failure the API continues, but live updates degrade to process-local best effort and missed events are not replayed.
- API file concurrency limits are per pod. Capacity planning must account for total replicas and the 10 MiB upload limit.
- `TRUST_PROXY_HOPS=2` is correct only for ALB -> Nginx -> API. Keep the API Service private and update the setting if the proxy topology changes.
