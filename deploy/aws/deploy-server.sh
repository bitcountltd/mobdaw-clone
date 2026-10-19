#!/usr/bin/env bash
# Provision / update the mobdaw cloud server for daw.bitcount.com and deploy a release to it.
#
#   deploy/aws/deploy-server.sh                  # secrets, stack, build, upload, switch, restart, health check
#   deploy/aws/deploy-server.sh --release-only   # skip the stack: build and roll out a new release
#
# Then deploy the site with deploy/aws/deploy.sh: it finds this stack and builds the client with the cloud features,
# routing /api/* and /collab* through CloudFront to this server. Admin commands: deploy/aws/server-admin.sh.
# Portable to macOS bash 3.2. Needs: aws cli v2, node 24 (esbuild from the repo's node_modules), openssl, jq.
set -euo pipefail

REGION=us-east-1
STACK_NAME=${SERVER_STACK_NAME:-mobdaw-daw-bitcount-server}
DOMAIN=${DOMAIN:-daw.bitcount.com}
ORIGIN_DOMAIN=${ORIGIN_DOMAIN:-origin.$DOMAIN}
PARAM_PREFIX=${PARAM_PREFIX:-/mobdaw/daw-bitcount}
HOSTED_ZONE_ID=${HOSTED_ZONE_ID:-}
INSTANCE_TYPE=${INSTANCE_TYPE:-t4g.small}
RELEASE_ONLY=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
export AWS_PAGER=""
export AWS_DEFAULT_REGION=$REGION

while [ $# -gt 0 ]; do
  case "$1" in
    --release-only) RELEASE_ONLY=1 ;;
    --zone-id) HOSTED_ZONE_ID=${2:?}; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
for c in aws node openssl jq; do command -v $c >/dev/null 2>&1 || die "$c not found"; done
node --version | grep -q '^v24\.' || die "node 24 is needed (found $(node --version))"
source "$SCRIPT_DIR/ssm-run.sh"

log "Checking AWS credentials"
aws sts get-caller-identity --query Arn --output text

if [ "$RELEASE_ONLY" -eq 0 ]; then
  # --- secrets: made once, kept in Parameter Store (the instance reads them at boot; never in a template) ----------
  log "Secrets in Parameter Store ($PARAM_PREFIX)"
  for name in session-secret origin-secret; do
    if aws ssm get-parameter --name "$PARAM_PREFIX/$name" >/dev/null 2>&1; then
      echo "$name: exists"
    else
      aws ssm put-parameter --name "$PARAM_PREFIX/$name" --type SecureString --value "$(openssl rand -hex 32)" \
        --description "mobdaw daw.bitcount.com $name" --tags Key=project,Value=mobdaw-demo >/dev/null
      echo "$name: created"
    fi
  done

  # --- stack ------------------------------------------------------------------------------------------------------
  if [ -z "$HOSTED_ZONE_ID" ]; then
    ZONE=${DOMAIN#*.}
    HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE" \
      --query "HostedZones[?Name=='${ZONE}.' && Config.PrivateZone==\`false\`].Id | [0]" --output text)
    [ -n "$HOSTED_ZONE_ID" ] && [ "$HOSTED_ZONE_ID" != None ] || die "no public hosted zone for $ZONE; pass --zone-id"
    HOSTED_ZONE_ID=${HOSTED_ZONE_ID#/hostedzone/}
  fi
  STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)
  case "$STATUS" in
    ROLLBACK_COMPLETE|ROLLBACK_FAILED|DELETE_FAILED)
      log "Stack $STACK_NAME is in $STATUS from a failed first create; deleting it before retrying"
      aws cloudformation delete-stack --stack-name "$STACK_NAME"
      aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" ;;
    *_IN_PROGRESS) die "stack $STACK_NAME is busy ($STATUS); wait and re-run" ;;
  esac
  log "Deploying stack $STACK_NAME (first run: ~5 min for the instance)"
  aws cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file "$SCRIPT_DIR/server.yaml" \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides "SiteDomain=$DOMAIN" "OriginDomain=$ORIGIN_DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" \
      "InstanceType=$INSTANCE_TYPE" "ParamPrefix=$PARAM_PREFIX" \
    --tags project=mobdaw-demo \
    --no-fail-on-empty-changeset \
    || die "stack deploy failed; see: aws cloudformation describe-stack-events --stack-name $STACK_NAME --max-items 20"
fi

output() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
INSTANCE=$(output InstanceId)
BUCKET=$(output DataBucketName)
echo "instance: $INSTANCE  bucket: $BUCKET"

# --- release ---------------------------------------------------------------------------------------------------
REL="$(date -u +%Y%m%d-%H%M%S)-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
log "Building release $REL"
(cd "$REPO_ROOT" && node deploy/aws/build-server.mjs "$TMP/$REL")
aws s3 cp --only-show-errors --recursive "$TMP/$REL" "s3://$BUCKET/deploy/releases/$REL/"
printf '%s' "$REL" > "$TMP/current.txt"
aws s3 cp --only-show-errors "$TMP/current.txt" "s3://$BUCKET/deploy/current.txt"

# --- roll out --------------------------------------------------------------------------------------------------
wait_for_ssm "$INSTANCE"
log "Switching the instance to $REL"
ssm_run "$INSTANCE" "
set -euo pipefail
cloud-init status --wait >/dev/null || true
test -f /etc/mobdaw.env || { echo 'bootstrap did not finish: see /var/log/mobdaw-bootstrap.log'; tail -n 30 /var/log/mobdaw-bootstrap.log; exit 1; }
mkdir -p /opt/mobdaw/releases/$REL
aws s3 cp --only-show-errors --recursive s3://$BUCKET/deploy/releases/$REL/ /opt/mobdaw/releases/$REL/
ln -sfn /opt/mobdaw/releases/$REL /opt/mobdaw/current
systemctl restart mobdaw
up=0
for i in \$(seq 1 30); do
  [ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/me || true)\" = 401 ] && { up=1; break; }
  sleep 1
done
[ \$up = 1 ] || { echo 'the server did not come up'; journalctl -u mobdaw -n 40 --no-pager; exit 1; }
systemctl is-active mobdaw caddy
# keep the last five releases
ls -1dt /opt/mobdaw/releases/* | tail -n +6 | xargs -r rm -rf
journalctl -u mobdaw -n 5 --no-pager
"

# --- health ----------------------------------------------------------------------------------------------------
log "Checking the origin (TLS + the origin header)"
SECRET=$(aws ssm get-parameter --with-decryption --name "$PARAM_PREFIX/origin-secret" --query Parameter.Value --output text)
CODE=""
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Mobdaw-Origin: $SECRET" "https://$ORIGIN_DOMAIN/api/me" || true)
  [ "$CODE" = 401 ] && break
  sleep 10   # first boot: DNS and the Let's Encrypt certificate take a minute or two
done
[ "$CODE" = 401 ] || die "https://$ORIGIN_DOMAIN/api/me answered '$CODE' (expected 401 when signed out); see journalctl -u caddy on the instance"
BARE=$(curl -s -o /dev/null -w '%{http_code}' "https://$ORIGIN_DOMAIN/api/me" || true)
[ "$BARE" = 403 ] || die "the origin answered $BARE without the CloudFront header (expected 403)"
echo "origin ok: 401 signed out through the header, 403 without it"

log "Done: release $REL on $INSTANCE. Next: deploy/aws/deploy.sh (routes the site to it)"
