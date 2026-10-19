#!/usr/bin/env bash
# Run the mobdaw admin CLI (server/scripts/admin.ts) on the daw.bitcount.com server, through SSM (no SSH):
#
#   deploy/aws/server-admin.sh create-invite --days 7 --months 12 --memo "for sam"   # prints a register link
#   deploy/aws/server-admin.sh make-admin <username>
#   deploy/aws/server-admin.sh gift <username> <months>
#   deploy/aws/server-admin.sh list-invites | tree | audit | set-plan ...
#
# Commands that ask for a password (create-user, passwd) need a terminal: use an SSM session instead,
#   aws ssm start-session --target <instance id> --region us-east-1
# then: sudo -u mobdaw bash -c 'set -a; . /etc/mobdaw.env; node /opt/mobdaw/current/admin.mjs passwd <username>'
set -euo pipefail
export AWS_PAGER="" AWS_DEFAULT_REGION=us-east-1
STACK_NAME=${SERVER_STACK_NAME:-mobdaw-daw-bitcount-server}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/ssm-run.sh"
[ $# -gt 0 ] || { sed -n '2,12p' "$0"; exit 2; }
case "$1" in create-user|passwd) echo "$1 asks for a password: run it in an SSM session (see --help)" >&2; exit 2 ;; esac

INSTANCE=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
ARGS=""
for a in "$@"; do ARGS="$ARGS $(printf '%q' "$a")"; done
ssm_run "$INSTANCE" "cd /var/lib/mobdaw && sudo -u mobdaw bash -c 'set -a; . /etc/mobdaw.env; set +a; exec node --disable-warning=ExperimentalWarning /opt/mobdaw/current/admin.mjs$ARGS'"
