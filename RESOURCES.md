# Cloud resources

Inventory of what mobdaw provisions for **https://daw.bitcount.com/**. There are two CloudFormation stacks in
`us-east-1` (CloudFront only uses ACM certificates from us-east-1):

| Stack | Template | Deployed by | What |
|---|---|---|---|
| `mobdaw-daw-bitcount` | [`deploy/aws/site.yaml`](deploy/aws/site.yaml) | [`deploy/aws/deploy.sh`](deploy/aws/deploy.sh) | the client (S3 + CloudFront), and the routing of `/api/*` and `/collab*` to the server |
| `mobdaw-daw-bitcount-server` | [`deploy/aws/server.yaml`](deploy/aws/server.yaml) | [`deploy/aws/deploy-server.sh`](deploy/aws/deploy-server.sh) | the cloud server: accounts, cloud projects, sharing, collaboration, sample storage |

Every resource is tagged `project=mobdaw-demo` where the type supports tags. How-to: [`docs/deploy-daw.bitcount.com.md`](docs/deploy-daw.bitcount.com.md).

> **Status: live (2026-10-19).** Both stacks are created. The server runs release `20261019-074913-d87eb3c`; the client is the cloud build (`VITE_CLOUD=1`).

## Site stack: `mobdaw-daw-bitcount`

| Resource | Type | Physical id | Purpose | Cost / month |
|---|---|---|---|---|
| `SiteBucket` | S3 bucket | `mobdaw-daw-bitcount-sitebucket-rbrrv2gn1wkv` | the built client (~2 MB). Private, SSE-S3, reachable only through CloudFront (OAC). | < $0.01 |
| `SiteBucketPolicy` | S3 bucket policy | (on the bucket) | only this distribution may `s3:GetObject`; non-TLS access is denied | free |
| `Certificate` | ACM certificate | `…certificate/4988e104-6b84-45be-841f-c762e312a3f1` | TLS for daw.bitcount.com, DNS-validated, auto-renewed | free |
| `OriginAccessControl` | CloudFront OAC | `E1SZDJ8YR9L4CX` | signs CloudFront's requests to the site bucket | free |
| `RootCachePolicy` | CloudFront cache policy | `17fa4ec3-…` | index.html etc.: 0-300 s, honouring `no-cache` | free |
| `SecurityHeadersPolicy` | CloudFront response headers policy | `a4224757-…` | HSTS, CSP (with the server: `wss://` and the samples bucket allowed), COOP, nosniff, frame-deny, Permissions-Policy | free |
| `Distribution` | CloudFront distribution | `EQ8ATSG30JNNC` | the CDN. `/*` comes from S3. `/assets/*` is cached a year. `/api/*` and `/collab*` go uncached to the server origin with the origin secret header. | free tier: 1 TB + 10M requests |
| `RecordA` / `RecordAAAA` | Route 53 alias records | `daw.bitcount.com` | → the distribution | free |

## Server stack: `mobdaw-daw-bitcount-server`

| Resource | Type | Physical id | Purpose | Cost / month |
|---|---|---|---|---|
| `Instance` | EC2 `t4g.small` (arm64, Amazon Linux 2023) | `i-08da489fc9003bf11` | Node 24 server (API + Hocuspocus WebSocket) behind Caddy (TLS, Let's Encrypt). IMDSv2 only, no SSH: managed with Session Manager / Run Command. | ~$12.26 |
| (root volume) | EBS gp3 8 GB, encrypted | (on the instance) | OS, Node, Caddy, releases. Disposable. | ~$0.64 |
| `DataVolume` | EBS gp3 10 GB, encrypted | `vol-04c2f2e441cf37b6b` | SQLite database and Caddy certificates at `/var/lib/mobdaw`. Outlives the instance, and is **snapshotted** if the stack replaces or deletes it. | ~$0.80 |
| `ElasticIp` | Elastic IP | `32.194.218.127` | the origin's fixed address | ~$3.65 (public IPv4) |
| `OriginRecord` | Route 53 A record | `origin.daw.bitcount.com` | → the Elastic IP. CloudFront's origin, and the name of Caddy's certificate. | free |
| `DataBucket` | S3 bucket | `mobdaw-daw-bitcount-server-databucket-nhrg8emlkl3e` | `samples/` (audio, uploaded and downloaded by browsers with presigned URLs; CORS for daw.bitcount.com), `deploy/` (server releases, old ones expire after 90 days), `backups/` (nightly SQLite copies, expire after 30 days). Private, SSE-S3, TLS only. **Retained** if the stack is deleted. | $0.023/GB stored |
| `DataBucketPolicy` | S3 bucket policy | (on the bucket) | denies non-TLS access | free |
| `InstanceRole` / `InstanceProfile` | IAM | `mobdaw-daw-bitcount-server-InstanceRole-…` | SSM managed-instance core. Read/write/delete `samples/*`, write `backups/*`, read `deploy/*`, list the bucket, read the two parameters below. | free |
| `Vpc`, `Subnet`, `InternetGateway`, `RouteTable`, `DefaultRoute`, `SubnetRoutes` | VPC networking | `vpc-0d50f309628505cdf`, `subnet-0611aa870de2b9828`, `igw-0fcae6c32215dc7b1`, `rtb-081833a04a8fcbfd7` | the account has no default VPC: one public subnet (10.42.1.0/24), no NAT | free |
| `SecurityGroup` | security group | `sg-0f7acdc166b8591e2` | inbound 80/443 only (Let's Encrypt and CloudFront). Caddy refuses requests without the origin secret. | free |

## Outside the stacks

| What | Where | Notes |
|---|---|---|
| Hosted zone `bitcount.com` | Route 53 | Pre-existing, not managed here ($0.50/month whether or not these stacks exist). |
| ACM validation CNAME `_<hash>.daw.bitcount.com` | that zone | Written by CloudFormation for the certificate; may remain after a teardown (harmless). |
| `/mobdaw/daw-bitcount/session-secret` | SSM Parameter Store (SecureString) | Signs sessions. Made once by `deploy-server.sh`. Rotating it signs everyone out. |
| `/mobdaw/daw-bitcount/origin-secret` | SSM Parameter Store (SecureString) | The `X-Mobdaw-Origin` value shared by CloudFront and Caddy. To rotate it: put a new value, re-run `deploy-server.sh` (the instance re-reads it on bootstrap; or restart Caddy after editing `/etc/caddy/caddy.env`), then `deploy.sh`. |
| Site bucket objects | `SiteBucket` | Uploaded by `deploy.sh`, not CloudFormation. `teardown.sh` empties the bucket. |
| Server releases | `DataBucket/deploy/` | Uploaded by `deploy-server.sh`. |
| Let's Encrypt certificate for `origin.daw.bitcount.com` | the data volume (`/var/lib/mobdaw/caddy`) | Renewed by Caddy. |
| CloudFront invalidations | per site deploy | The first 1,000 paths a month are free. |

**Expected total: about $17-18 a month**, almost all of it the instance and its public IPv4 address. S3 and
CloudFront add pennies for a small group of users.

**Cheaper options:**
- `INSTANCE_TYPE=t4g.micro deploy/aws/deploy-server.sh` (1 GB, ~$6/month) is fine for a handful of users.
- A Savings Plan cuts the instance cost by about a third.

**Teardown:**
- `deploy/aws/teardown.sh` removes the site stack.
- For the server, run `aws cloudformation delete-stack --stack-name mobdaw-daw-bitcount-server --region us-east-1`.
  It keeps the data bucket and snapshots the data volume. Delete those by hand to remove all data.
