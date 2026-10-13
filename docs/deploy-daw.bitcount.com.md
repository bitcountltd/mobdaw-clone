# Deploying the static demo to daw.bitcount.com

The redesigned client is a fully static site (the wasm engine, AudioWorklet, fonts and demo song
are all in `client/dist`; projects live in the browser). It is served from a private S3 bucket
through CloudFront at **https://daw.bitcount.com/**, with an ACM certificate and Route 53
alias records, all in one CloudFormation stack (`mobdaw-daw-bitcount`, us-east-1).
What gets created and what it costs: [`RESOURCES.md`](../RESOURCES.md).

There is no server behind this deployment, so the features that need one (sign-in, cloud
projects, sharing, collaboration) do not work there; everything on-device does. The original
wrongbad.com/mobdaw deployment (with the server) is unchanged: see [`deploy/README.md`](../deploy/README.md).

Files:

| File | What |
|---|---|
| `deploy/aws/site.yaml` | CloudFormation template (bucket, OAC, CloudFront, headers policy, cert, DNS) |
| `deploy/aws/deploy.sh` | one command: stack create/update, build, upload, invalidate |
| `deploy/aws/teardown.sh` | empty the bucket and delete the stack (asks first) |
| `deploy/aws/serve-local.mjs` | local static server with the same headers as CloudFront, for testing the CSP |
| `client/vite.config.ts` | `BASE_PATH` env picks the base (`/` here; default build stays `/mobdaw/`) |

## Prerequisites

- **AWS CLI v2** (`brew install awscli`), configured for the account that holds the
  `bitcount.com` public hosted zone (`aws configure`, or `aws sso login` + `AWS_PROFILE=...`).
  Check: `aws sts get-caller-identity`.
- **Node 24 + npm**, and the repo's dependencies (`npm ci` at the root; `deploy.sh` runs it if missing).
- **Rust** with the wasm target (`rustup target add wasm32-unknown-unknown`) to build the engine;
  or pass `--skip-wasm` to reuse an existing `client/src/audio/wasm/engine.wasm`.
- macOS bash 3.2 is fine; the scripts are POSIX-ish bash and shellcheck-clean.

### Minimal IAM policy for the deployer

CloudFormation acts with the caller's permissions (no service role), so the deployer needs the
permissions for every resource in the template. Replace `ACCOUNT_ID` and `ZONE_ID`
(`aws route53 list-hosted-zones-by-name --dns-name bitcount.com`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources", "cloudformation:DescribeStackResource",
        "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet",
        "cloudformation:GetTemplate"
      ],
      "Resource": "arn:aws:cloudformation:us-east-1:ACCOUNT_ID:stack/mobdaw-daw-bitcount/*"
    },
    {
      "Sid": "CloudFormationGlobal",
      "Effect": "Allow",
      "Action": ["cloudformation:GetTemplateSummary", "cloudformation:ValidateTemplate"],
      "Resource": "*"
    },
    {
      "Sid": "SiteBucket",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::mobdaw-daw-bitcount-sitebucket-*",
        "arn:aws:s3:::mobdaw-daw-bitcount-sitebucket-*/*"
      ]
    },
    {
      "Sid": "CloudFront",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateDistribution", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution",
        "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:TagResource",
        "cloudfront:UntagResource", "cloudfront:ListTagsForResource", "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation",
        "cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl", "cloudfront:GetOriginAccessControl",
        "cloudfront:CreateCachePolicy", "cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy",
        "cloudfront:GetCachePolicy",
        "cloudfront:CreateResponseHeadersPolicy", "cloudfront:UpdateResponseHeadersPolicy",
        "cloudfront:DeleteResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicy"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Certificate",
      "Effect": "Allow",
      "Action": [
        "acm:RequestCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate",
        "acm:ListCertificates", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
        "acm:ListTagsForCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DnsZone",
      "Effect": "Allow",
      "Action": ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone"],
      "Resource": "arn:aws:route53:::hostedzone/ZONE_ID"
    },
    {
      "Sid": "DnsGlobal",
      "Effect": "Allow",
      "Action": ["route53:ListHostedZonesByName", "route53:GetChange"],
      "Resource": "*"
    }
  ]
}
```

(`sts:GetCallerIdentity` needs no permission. CloudFront and ACM actions mostly do not support
resource-level scoping at create time, hence `*`.)

## Deploy

From the repo root:

```sh
deploy/aws/deploy.sh
```

It:

1. checks credentials (`aws sts get-caller-identity`);
2. finds the public hosted zone for `bitcount.com` (fails clearly if there is none; `--zone-id` overrides);
3. on a first run, checks that `daw.bitcount.com` has no records yet, then `aws cloudformation deploy`s
   `deploy/aws/site.yaml` as `mobdaw-daw-bitcount` in us-east-1 and waits. **The first run takes ~5-15 minutes**
   (certificate validation, then the distribution). A stack left in `ROLLBACK_COMPLETE` by a failed first
   create is deleted and re-created automatically;
4. builds the wasm engine and the client with `BASE_PATH=/` (`--skip-wasm`, `--skip-build` to skip);
5. uploads: `assets/*` first (`Cache-Control: public,max-age=31536000,immutable`), then the other root
   files (`no-cache`), then `index.html` last (`no-cache`), each with an explicit Content-Type
   (`application/wasm`, `text/javascript`, `font/woff2`, ...); only then deletes objects that are no longer
   in the build;
6. invalidates `/index.html` and `/`, and prints the URL.

Options: `--skip-build`, `--skip-wasm`, `--domain NAME`, `--zone-id ID`, `--stack-name NAME`
(also as env `DOMAIN`, `HOSTED_ZONE_ID`, `STACK_NAME`).

## Updates

Run the same command. The stack only changes if `site.yaml` did (an empty change set is not an
error). Hashed assets never change in place, so browsers and CloudFront keep them for a year;
`index.html` is `no-cache`, so a new build shows up on the next load (the invalidation clears the
edge copy too). A tab that was open across a deploy may fail to lazy-load an old chunk once it is
pruned; reloading fixes it.

To change headers (CSP etc.), edit `SecurityHeadersPolicy` in `site.yaml` (keep each value on one
line: `serve-local.mjs` reads them from there), test locally (below), then deploy.

To remove everything: `deploy/aws/teardown.sh` (asks you to type the stack name; `--yes` skips it).

## Test locally with the production headers

```sh
(cd client && BASE_PATH=/ npx vite build)
node deploy/aws/serve-local.mjs            # http://127.0.0.1:8080/, same CSP/headers/content types as CloudFront
node deploy/aws/serve-local.mjs --csp "default-src 'self'; ..."   # try a different policy
```

Open it, choose "open the demo", press Space, and watch DevTools: CSP problems show as console
errors starting with `Refused to ...`. Errors inside the AudioWorklet do not fire a
`securitypolicyviolation` event in the page; they surface as
`engine failed to start: engine processor failed to start` — e.g. without `'wasm-unsafe-eval'`.
Missing files return 403, like S3 behind OAC.

The CSP in use:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
media-src 'self' blob: data:; connect-src 'self' blob: data:; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- `'wasm-unsafe-eval'`: the worklet compiles the engine with `new WebAssembly.Module(bytes)`.
- `'unsafe-inline'` for styles only: `index.html` has a `style` attribute on `<body>` (and the UI sets
  inline styles); no inline scripts are allowed.
- `blob:` / `data:`: recorded takes, sample previews and exports are blob URLs; the CSS has small
  `data:` SVG images. Fonts are bundled (`@fontsource`), so there are no third-party origins.

`Permissions-Policy: microphone=(self), midi=(self), clipboard-write=(self), camera=(), geolocation=(), payment=(), usb=()`.

## Troubleshooting

- **Stack stuck on `Certificate` (CREATE_IN_PROGRESS for long).** ACM waits for the validation
  CNAME to resolve publicly. It only works if `bitcount.com`'s registrar delegates to the Route 53 zone
  you deployed against: compare `dig NS bitcount.com +short` with
  `aws route53 get-hosted-zone --id ZONE_ID --query DelegationSet.NameServers`. Also check
  `aws acm list-certificates --region us-east-1` / `describe-certificate` for the status and the
  CNAME it expects. A CAA record on `bitcount.com` must allow `amazon.com` if any CAA exists. It
  times out after a few hours and rolls back; fix and re-run.
- **`daw.bitcount.com already has DNS records`** (from `deploy.sh`) or
  **`Tried to create resource record set ... but it already exists`** (CloudFormation): a record with
  that name was made by hand. Delete it in Route 53 and re-run.
- **`CNAMEAlreadyExists` / "One or more of the CNAMEs you provided are already associated with a
  different resource"** (CloudFront): `daw.bitcount.com` is an alternate domain of another distribution
  (maybe in another account). Remove it there first (`aws cloudfront list-distributions --query
  "DistributionList.Items[?contains(Aliases.Items, 'daw.bitcount.com')].Id"`).
- **Stack in `ROLLBACK_COMPLETE`**: `deploy.sh` deletes and recreates it. Read why it failed first:
  `aws cloudformation describe-stack-events --stack-name mobdaw-daw-bitcount --region us-east-1 --max-items 20`.
- **Page loads but no sound / "engine failed to start"**: usually the CSP (see above) or a wrong
  Content-Type on the wasm. Check: `curl -sI https://daw.bitcount.com/assets/engine-*.wasm` (use the
  real name from the network tab) should say `content-type: application/wasm`; `curl -sI
  https://daw.bitcount.com/` should show the `content-security-policy` header.
- **Blank page, 403s for `/mobdaw/assets/...`**: the build used the default base. Rebuild with
  `BASE_PATH=/` (`deploy.sh` does and checks it).
- **Old version still shown**: `index.html` is `no-cache`; hard-reload. The invalidation takes ~1 minute.
- **AccessDenied on upload**: the IAM policy's bucket ARN pattern must match the generated name
  (`mobdaw-daw-bitcount-sitebucket-*`); it changes if you change `--stack-name`.
