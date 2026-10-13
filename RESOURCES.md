# Cloud resources

Inventory of the cloud resources mobdaw provisions. Everything below is created by the one
CloudFormation stack in [`deploy/aws/site.yaml`](deploy/aws/site.yaml), deployed by
[`deploy/aws/deploy.sh`](deploy/aws/deploy.sh). How-to: [`docs/deploy-daw.bitcount.com.md`](docs/deploy-daw.bitcount.com.md).

> **Status: not yet created.** The stack was written and tested offline in a sandbox whose
> network policy blocked every AWS endpoint (`*.amazonaws.com`), so nothing has been
> provisioned yet. To create it, from the repo root, with AWS credentials for the account that
> owns the `bitcount.com` hosted zone:
>
> ```sh
> deploy/aws/deploy.sh
> ```

| | |
|---|---|
| Stack | `mobdaw-daw-bitcount` |
| Region | `us-east-1` (required: CloudFront only uses ACM certificates from us-east-1) |
| Site | https://daw.bitcount.com/ (static client only; no server, no sign-in/cloud features) |
| Tag | `project=mobdaw-demo` on the stack, propagated to every taggable resource |

## Resources in the stack

| Logical name | Type | Purpose | Demo cost / month |
|---|---|---|---|
| `SiteBucket` | `AWS::S3::Bucket` | Private bucket holding `client/dist` (~1 MB). Block Public Access on, SSE-S3 (AES256, bucket key), bucket-owner-enforced (no ACLs), versioning off. Name generated: `mobdaw-daw-bitcount-sitebucket-<random>`. | < $0.01 storage; GETs from CloudFront $0.0004 / 1k |
| `SiteBucketPolicy` | `AWS::S3::BucketPolicy` | Lets only this CloudFront distribution (OAC, `AWS:SourceArn`) `s3:GetObject`; denies non-TLS access. | free |
| `Certificate` | `AWS::CertificateManager::Certificate` | Public TLS cert for `daw.bitcount.com`, DNS-validated: CloudFormation writes the `_<hash>.daw.bitcount.com` CNAME into the zone and waits until ISSUED; ACM auto-renews it. | free |
| `OriginAccessControl` | `AWS::CloudFront::OriginAccessControl` | SigV4-signs CloudFront's requests to S3 (OAC, not legacy OAI). | free |
| `RootCachePolicy` | `AWS::CloudFront::CachePolicy` | Default behaviour (index.html, favicons): TTL 0-300 s honouring the origin's `Cache-Control: no-cache`; gzip + brotli. | free |
| `SecurityHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | HSTS, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, CSP, Permissions-Policy, COOP on every response. | free |
| `Distribution` | `AWS::CloudFront::Distribution` | CDN for `daw.bitcount.com`: HTTP/2+3, IPv6, redirect-to-https, TLS 1.2+, PriceClass_100 (NA + EU edges), compression, root object `index.html`; `/assets/*` uses the managed `CachingOptimized` policy (1 year; hashed file names). | free tier: 1 TB out + 10M requests always free; a demo stays at $0 |
| `RecordA` | `AWS::Route53::RecordSet` | `daw.bitcount.com` A alias → distribution. | free (alias queries to CloudFront are free) |
| `RecordAAAA` | `AWS::Route53::RecordSet` | `daw.bitcount.com` AAAA alias → distribution. | free |

Outside the stack but touched by it:

- **Hosted zone `bitcount.com`** (pre-existing, not managed here): $0.50/month whether or not this stack exists.
- **ACM validation CNAME** `_<hash>.daw.bitcount.com` in that zone: written by CloudFormation for the certificate. It may stay behind after the stack is deleted; it is harmless and can be removed by hand.
- **Objects in `SiteBucket`**: uploaded by `deploy.sh` (`aws s3 sync`), not by CloudFormation; `teardown.sh` empties the bucket before deleting the stack.
- **Managed cache policy `CachingOptimized`** (`658327ea-f89d-4fab-a63d-7e88639e58f6`): AWS-owned, referenced only.
- **CloudFront invalidations**: one per deploy (2 paths); the first 1,000 paths/month are free.

Expected total for a low-traffic demo: **≈ $0.00-0.05 / month** on top of the existing hosted zone.

## Provisioned

| Resource | Physical id | Status |
|---|---|---|
| Stack `mobdaw-daw-bitcount` (us-east-1) | — | pending first run |
| `SiteBucket` | — | pending first run |
| `SiteBucketPolicy` | — | pending first run |
| `Certificate` | — | pending first run |
| `OriginAccessControl` | — | pending first run |
| `RootCachePolicy` | — | pending first run |
| `SecurityHeadersPolicy` | — | pending first run |
| `Distribution` | — | pending first run |
| `RecordA` / `RecordAAAA` | — | pending first run |

After the first run, fill in the physical ids with the first command below.

## Seeing them

```sh
aws cloudformation describe-stack-resources --stack-name mobdaw-daw-bitcount --region us-east-1 \
  --query 'StackResources[].[LogicalResourceId,ResourceType,PhysicalResourceId,ResourceStatus]' --output table
aws cloudformation describe-stacks --stack-name mobdaw-daw-bitcount --region us-east-1 --query 'Stacks[0].Outputs'
```

Or by tag, across services: `aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=mobdaw-demo --region us-east-1`
(CloudFront appears there only via us-east-1, which is where this stack lives anyway).

## Deleting them

```sh
deploy/aws/teardown.sh      # prompts for the stack name; empties the bucket, deletes the stack and waits
```

CloudFront has to disable the distribution before deleting it, so the delete takes ~5-15 minutes.
Then optionally remove the leftover `_<hash>.daw.bitcount.com` validation CNAME from the zone.
