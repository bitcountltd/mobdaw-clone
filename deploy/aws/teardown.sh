#!/usr/bin/env bash
# Delete everything deploy.sh created: empties the site bucket, then deletes the stack
# (bucket, CloudFront distribution, OAC, policies, ACM certificate, DNS records).
#
#   deploy/aws/teardown.sh          # asks for confirmation
#   deploy/aws/teardown.sh --yes    # no prompt
set -euo pipefail

REGION=us-east-1
STACK_NAME=${STACK_NAME:-mobdaw-daw-bitcount}
ASSUME_YES=0
export AWS_PAGER=""
export AWS_DEFAULT_REGION=$REGION

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --stack-name) STACK_NAME=${2:?--stack-name needs a value}; shift ;;
    -h|--help) echo "Usage: $(basename "$0") [--yes] [--stack-name NAME]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

aws sts get-caller-identity --query Arn --output text >/dev/null \
  || die "no usable AWS credentials (run 'aws configure' or 'aws sso login', or set AWS_PROFILE)"

STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)
if [ "$STATUS" = NONE ]; then
  echo "stack $STACK_NAME does not exist in $REGION; nothing to delete"
  exit 0
fi

BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$STACK_NAME" \
  --logical-resource-id SiteBucket --query 'StackResources[0].PhysicalResourceId' --output text 2>/dev/null || true)
URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='URL'].OutputValue" --output text 2>/dev/null || true)

echo "This permanently deletes stack '$STACK_NAME' ($STATUS) in $REGION:"
echo "  site:   ${URL:-?}"
echo "  bucket: ${BUCKET:-?} (all objects)"
echo "  plus the CloudFront distribution, ACM certificate and the A/AAAA records."
if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Type the stack name to confirm: "
  read -r answer
  [ "$answer" = "$STACK_NAME" ] || die "not confirmed; nothing deleted"
fi

if [ -n "$BUCKET" ] && [ "$BUCKET" != None ] && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "emptying s3://$BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --only-show-errors
fi

echo "deleting stack $STACK_NAME (disabling CloudFront takes ~5-15 min)"
aws cloudformation delete-stack --stack-name "$STACK_NAME"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" \
  || die "delete did not complete; see: aws cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --max-items 20"
echo "deleted"
