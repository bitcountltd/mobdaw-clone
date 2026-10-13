#!/usr/bin/env bash
# Deploy the mobdaw static client to https://daw.bitcount.com (S3 + CloudFront + ACM + Route 53).
#
#   deploy/aws/deploy.sh                 # provision/update the stack, build, upload, invalidate
#   deploy/aws/deploy.sh --skip-build    # upload the existing client/dist as is
#
# Idempotent: re-running updates the stack only if the template changed, then re-uploads.
# Portable to macOS bash 3.2. Needs: aws cli (v2 recommended), node/npm; cargo unless --skip-wasm.
set -euo pipefail

REGION=us-east-1                 # CloudFront requires the ACM certificate in us-east-1
STACK_NAME=${STACK_NAME:-mobdaw-daw-bitcount}
DOMAIN=${DOMAIN:-daw.bitcount.com}
HOSTED_ZONE_ID=${HOSTED_ZONE_ID:-}
SKIP_BUILD=0
SKIP_WASM=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
TEMPLATE="$SCRIPT_DIR/site.yaml"
DIST="$REPO_ROOT/client/dist"

export AWS_PAGER=""              # aws cli v2: never open a pager
export AWS_DEFAULT_REGION=$REGION

usage() {
  cat <<EOF
Usage: $(basename "$0") [--skip-build] [--skip-wasm] [--domain NAME] [--zone-id ID] [--stack-name NAME]

  --skip-build     do not build; upload client/dist as it is
  --skip-wasm      build the client but reuse client/src/audio/wasm/engine.wasm (no cargo)
  --domain NAME    site host name (default: $DOMAIN)
  --zone-id ID     Route 53 hosted zone id (default: looked up from the parent domain)
  --stack-name N   CloudFormation stack name (default: $STACK_NAME)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-wasm) SKIP_WASM=1 ;;
    --domain) DOMAIN=${2:?--domain needs a value}; shift ;;
    --zone-id) HOSTED_ZONE_ID=${2:?--zone-id needs a value}; shift ;;
    --stack-name) STACK_NAME=${2:?--stack-name needs a value}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws cli not found (install v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)"

# --- 1. credentials -------------------------------------------------------------------------
log "Checking AWS credentials"
IDENTITY=$(aws sts get-caller-identity --query '[Account,Arn]' --output text) \
  || die "no usable AWS credentials (run 'aws configure' or 'aws sso login', or set AWS_PROFILE)"
echo "account/identity: $IDENTITY"

# --- 2. hosted zone -------------------------------------------------------------------------
PARENT_ZONE=${PARENT_ZONE:-${DOMAIN#*.}}   # daw.bitcount.com -> bitcount.com
if [ -z "$HOSTED_ZONE_ID" ]; then
  log "Looking up the public Route 53 hosted zone for $PARENT_ZONE"
  ZONES=$(aws route53 list-hosted-zones-by-name --dns-name "$PARENT_ZONE" \
    --query "HostedZones[?Name=='${PARENT_ZONE}.' && Config.PrivateZone==\`false\`].Id" --output text)
  # shellcheck disable=SC2086
  set -- $ZONES
  if [ $# -eq 0 ] || [ "$1" = "None" ]; then
    die "no public hosted zone named '$PARENT_ZONE' in this account. Create it (or delegate the domain to Route 53) first, or pass --zone-id."
  fi
  [ $# -eq 1 ] || die "several public hosted zones are named '$PARENT_ZONE' ($ZONES); pass the right one with --zone-id"
  HOSTED_ZONE_ID=${1#/hostedzone/}
fi
echo "hosted zone: $HOSTED_ZONE_ID"

stack_status() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

# --- 3. stack -------------------------------------------------------------------------------
STATUS=$(stack_status)
case "$STATUS" in
  ROLLBACK_COMPLETE|ROLLBACK_FAILED|DELETE_FAILED)
    # A first create that failed leaves a stack that can only be deleted.
    log "Stack $STACK_NAME is in $STATUS from a failed first create; deleting it before retrying"
    aws cloudformation delete-stack --stack-name "$STACK_NAME"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
    STATUS=NONE ;;
  UPDATE_ROLLBACK_FAILED)
    die "stack $STACK_NAME is in UPDATE_ROLLBACK_FAILED; fix the cause (describe-stack-events), run 'aws cloudformation continue-update-rollback --stack-name $STACK_NAME --region $REGION', then re-run" ;;
  REVIEW_IN_PROGRESS) ;;  # a change set was made but never executed; deploy handles it
  *_IN_PROGRESS)
    die "stack $STACK_NAME is busy ($STATUS); wait for it to finish and re-run" ;;
esac

if [ "$STATUS" = NONE ] || [ "$STATUS" = REVIEW_IN_PROGRESS ]; then
  # Fail early, with a clear message, if the name already has records we would collide with.
  EXISTING=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --query "ResourceRecordSets[?Name=='${DOMAIN}.'].Type" --output text)
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    die "$DOMAIN already has DNS records ($EXISTING) in zone $HOSTED_ZONE_ID that this stack did not create. Delete them (Route 53 console) and re-run."
  fi
  log "Creating stack $STACK_NAME in $REGION (first run: ACM validation + CloudFront take ~5-15 min)"
else
  log "Updating stack $STACK_NAME ($STATUS)"
fi

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --parameter-overrides "DomainName=$DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" \
  --tags project=mobdaw-demo \
  --no-fail-on-empty-changeset \
  || die "stack deploy failed; see: aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --max-items 20"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET=$(output BucketName)
DIST_ID=$(output DistributionId)
URL=$(output URL)
[ -n "$BUCKET" ] && [ "$BUCKET" != None ] || die "stack has no BucketName output"
echo "bucket: $BUCKET  distribution: $DIST_ID"

# --- 4. build -------------------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v npm >/dev/null 2>&1 || die "npm not found (install Node.js 24)"
  if [ ! -x "$REPO_ROOT/node_modules/.bin/vite" ] && [ ! -x "$REPO_ROOT/client/node_modules/.bin/vite" ]; then
    log "Installing npm dependencies"
    (cd "$REPO_ROOT" && npm ci)
  fi
  if [ "$SKIP_WASM" -eq 0 ]; then
    log "Building the wasm engine"
    (cd "$REPO_ROOT" && npm run build:wasm)
  fi
  [ -f "$REPO_ROOT/client/src/audio/wasm/engine.wasm" ] \
    || die "client/src/audio/wasm/engine.wasm is missing; run without --skip-wasm (needs cargo + wasm32-unknown-unknown)"
  log "Building the client (BASE_PATH=/)"
  (cd "$REPO_ROOT/client" && BASE_PATH=/ npx vite build)
fi

[ -f "$DIST/index.html" ] || die "$DIST/index.html not found; build first (drop --skip-build)"
grep -q '"/assets/' "$DIST/index.html" \
  || die "$DIST/index.html does not reference /assets/ at the root; rebuild with BASE_PATH=/ (drop --skip-build)"

# --- 5. upload ------------------------------------------------------------------------------
# One pass per file type so each object gets an explicit Content-Type (the CLI's guess for
# .wasm is not reliable). Order: hashed assets, then root files, index.html, then the service worker (it
# precaches index.html, so it must not reach anyone before the index.html it was built with), then prune.
IMMUTABLE='public,max-age=31536000,immutable'
NOCACHE='no-cache'
TYPED_EXTS='wasm js mjs css woff2 woff svg ico json html map txt webmanifest png'

content_type() {
  case "$1" in
    wasm) echo 'application/wasm' ;;
    js|mjs) echo 'text/javascript; charset=utf-8' ;;
    css) echo 'text/css; charset=utf-8' ;;
    woff2) echo 'font/woff2' ;;
    woff) echo 'font/woff' ;;
    svg) echo 'image/svg+xml' ;;
    ico) echo 'image/x-icon' ;;
    json|map) echo 'application/json' ;;
    html) echo 'text/html; charset=utf-8' ;;
    txt) echo 'text/plain; charset=utf-8' ;;
    webmanifest) echo 'application/manifest+json' ;;
    png) echo 'image/png' ;;
  esac
}

# upload SRC_DIR DEST_PREFIX CACHE_CONTROL [extra sync args...]
upload() {
  src=$1 dest=$2 cache=$3
  shift 3
  for ext in $TYPED_EXTS; do
    # Filters apply in order, last match wins: the caller's excludes must come after the include.
    aws s3 sync "$src" "s3://$BUCKET/$dest" --only-show-errors \
      --exclude '*' --include "*.$ext" ${1+"$@"} \
      --cache-control "$cache" --content-type "$(content_type "$ext")"
  done
  # Anything else: let the CLI guess the type.
  excl=()
  for ext in $TYPED_EXTS; do excl+=(--exclude "*.$ext"); done
  aws s3 sync "$src" "s3://$BUCKET/$dest" --only-show-errors ${1+"$@"} "${excl[@]}" --cache-control "$cache"
}

log "Uploading assets (immutable)"
if [ -d "$DIST/assets" ]; then upload "$DIST/assets" assets "$IMMUTABLE"; fi

log "Uploading root files (no-cache)"
upload "$DIST" "" "$NOCACHE" --exclude 'assets/*' --exclude 'index.html' --exclude 'sw.js'

log "Uploading index.html"
aws s3 cp "$DIST/index.html" "s3://$BUCKET/index.html" --only-show-errors \
  --cache-control "$NOCACHE" --content-type 'text/html; charset=utf-8'

if [ -f "$DIST/sw.js" ]; then
  log "Uploading the service worker (no-cache)"
  aws s3 cp "$DIST/sw.js" "s3://$BUCKET/sw.js" --only-show-errors \
    --cache-control "$NOCACHE" --content-type 'text/javascript; charset=utf-8'
fi

log "Removing files that are no longer in the build"
LOCAL_KEYS=$(mktemp); REMOTE_KEYS=$(mktemp)
trap 'rm -f "$LOCAL_KEYS" "$REMOTE_KEYS"' EXIT
(cd "$DIST" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) >"$LOCAL_KEYS"
aws s3api list-objects-v2 --bucket "$BUCKET" --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' | LC_ALL=C sort >"$REMOTE_KEYS" || true
STALE=0
while IFS= read -r key; do
  [ -n "$key" ] || continue
  aws s3 rm "s3://$BUCKET/$key" --only-show-errors
  echo "deleted $key"
  STALE=$((STALE + 1))
done <<EOF
$(LC_ALL=C comm -23 "$REMOTE_KEYS" "$LOCAL_KEYS")
EOF
echo "$STALE stale object(s) removed"

# --- 6. invalidate --------------------------------------------------------------------------
log "Invalidating /index.html, /, /sw.js and /manifest.webmanifest on CloudFront"
INV_ID=$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths /index.html / /sw.js /manifest.webmanifest --query 'Invalidation.Id' --output text)
echo "invalidation $INV_ID (completes in ~1 min; index.html is no-cache anyway)"

log "Done: $URL"
