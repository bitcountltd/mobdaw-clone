# Deploying mobdaw to daw.bitcount.com

**https://daw.bitcount.com/** is two CloudFormation stacks in us-east-1:

- **`mobdaw-daw-bitcount`** (`deploy/aws/site.yaml`): the client, a static build in a private S3 bucket behind
  CloudFront, with an ACM certificate and Route 53 alias records.
- **`mobdaw-daw-bitcount-server`** (`deploy/aws/server.yaml`): the cloud server (accounts, cloud projects, sharing,
  live collaboration, sample storage). One EC2 instance runs the Node server behind Caddy, with a data volume for
  SQLite and an S3 bucket for samples, releases and backups. CloudFront sends `/api/*` and `/collab*` to it (see
  "Cloud server" below).

The site works without the server stack: then it is static, projects live in the browser, and the cloud features
are hidden. What gets created and what it costs: [`RESOURCES.md`](../RESOURCES.md). The original wrongbad.com/mobdaw
deployment is separate and unchanged ([`deploy/README.md`](../deploy/README.md)).

Files:

| File | What |
|---|---|
| `deploy/aws/site.yaml` | CloudFormation template (bucket, OAC, CloudFront, headers policy, cert, DNS) |
| `deploy/aws/deploy.sh` | the site: stack create/update, build (cloud features on when the server stack exists), upload, invalidate |
| `deploy/aws/server.yaml` | CloudFormation template for the server (instance, data volume, bucket, role, DNS for the origin) |
| `deploy/aws/deploy-server.sh` | the server: secrets, stack, build a release, roll it out, health check |
| `deploy/aws/build-server.mjs` | bundles the server and admin CLI, dependencies included, into one file each |
| `deploy/aws/server-admin.sh` | runs the admin CLI on the instance (invites, make-admin, gift months ...) |
| `deploy/aws/ssm-run.sh` | Run Command helpers shared by the two scripts above |
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

## Cloud server

### How requests flow

```
browser ── https://daw.bitcount.com ── CloudFront ─┬─ /*            → S3 (the client)
                                                   └─ /api/*, /collab* → https://origin.daw.bitcount.com
                                                         (header X-Mobdaw-Origin: <secret>)
                                                         → Caddy :443 (Let's Encrypt) → node :8787
browser ── presigned GET/PUT ── https://<data bucket>.s3.us-east-1.amazonaws.com/samples/...
```

- **Caching:** the API and WebSocket behaviours use the managed `CachingDisabled` and `AllViewerExceptHostHeader`
  policies. Cookies, query strings and the WebSocket upgrade reach the server, and the Host header is the origin's.
- **Origin secret:** Caddy refuses (403) every request without the secret `X-Mobdaw-Origin` header that CloudFront
  adds. Ports 80/443 have to be open for Let's Encrypt, but the server is only usable through the CDN.
- **CSP:** with the server, `SecurityHeadersPolicy` adds `wss://daw.bitcount.com` and the bucket's S3 host to
  `connect-src` and `media-src`.
- **Secrets:** `session-secret` and `origin-secret` live in Parameter Store under `/mobdaw/daw-bitcount/`
  (SecureString). `deploy-server.sh` creates them once. The instance reads them at boot into `/etc/mobdaw.env` and
  `/etc/caddy/caddy.env`. `deploy.sh` passes the origin secret to CloudFront as a NoEcho parameter.

### Deploy

```sh
deploy/aws/deploy-server.sh    # the server: secrets, stack, release, health check
deploy/aws/deploy.sh           # the site: routes /api and /collab to it, builds the client with VITE_CLOUD=1
```

`deploy-server.sh`:
1. Creates the secrets if missing.
2. Deploys `server.yaml`. On the first run, the instance's user data installs Node 24 (checked against
   nodejs.org's SHA-256 list) and Caddy (checked against its release checksums), and formats and mounts the data
   volume at `/var/lib/mobdaw`.
3. Writes the systemd units: `mobdaw`, `caddy`, and a nightly `mobdaw-backup.timer`.
4. Bundles the server (`build-server.mjs`: one `main.mjs` plus `admin.mjs`, so there is no npm on the box) and
   uploads it to `s3://<bucket>/deploy/releases/<time>-<commit>/`, then points `deploy/current.txt` at it.
5. Over Run Command, switches `/opt/mobdaw/current` to it and restarts. It keeps the last five releases.
6. Checks the origin: 401 for `/api/me` through the header, 403 without it.

`--release-only` skips the secrets and the stack, for code-only updates.

### First admin account and invites

Registration is invite-only, and there is no billing: pro time is given as months (`gift`, or an invite's months).

```sh
deploy/aws/server-admin.sh create-invite --days 7 --months 12 --memo me   # prints https://daw.bitcount.com/#/register/<code>
# register with that link in the browser (your own username and password), then:
deploy/aws/server-admin.sh make-admin <username>
```

Admins can also make invites in the app (the admin page). Other commands: `gift <username> <months>`,
`list-invites`, `set-plan`, `tree`, `audit`.

Commands that ask for a password (`create-user`, `passwd`) need a terminal, so run them in a Session Manager shell:

```sh
aws ssm start-session --target <instance id> --region us-east-1
sudo -u mobdaw bash -c 'set -a; . /etc/mobdaw.env; node /opt/mobdaw/current/admin.mjs passwd <username>'
```

This needs the Session Manager plugin for the AWS CLI.

### On the instance

| | |
|---|---|
| Server | `systemctl status mobdaw`, `journalctl -u mobdaw -f` |
| TLS / proxy | `systemctl status caddy`, `journalctl -u caddy -f` (certificates in `/var/lib/mobdaw/caddy`) |
| Database | `/var/lib/mobdaw/db/mobdaw.db` (SQLite, on the data volume) |
| Backups | `systemctl list-timers mobdaw-backup.timer`: daily `VACUUM INTO`, copied to `s3://<bucket>/backups/` (kept 30 days) |
| Bootstrap log | `/var/log/mobdaw-bootstrap.log` |

**Disks:** the root disk is disposable. Everything that matters is on the data volume (snapshotted if the stack
replaces or deletes it) or in the bucket (retained if the stack is deleted). A new Amazon Linux image or instance type
replaces the instance on the next stack update. The new one mounts the same volume and pulls the current release.

**Restore a backup:**
1. `systemctl stop mobdaw`.
2. `aws s3 cp s3://<bucket>/backups/mobdaw-YYYY-MM-DD.db /var/lib/mobdaw/db/mobdaw.db`.
3. `chown mobdaw: /var/lib/mobdaw/db/mobdaw.db`.
4. Delete any `-wal`/`-shm` files next to it.
5. `systemctl start mobdaw`.

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
