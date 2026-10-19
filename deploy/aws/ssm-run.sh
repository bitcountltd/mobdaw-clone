# Run shell commands on the mobdaw server through SSM Run Command (no SSH). Sourced by deploy-server.sh and
# server-admin.sh; expects AWS_DEFAULT_REGION to be set.

# wait_for_ssm INSTANCE: until the instance's SSM agent reports in (a fresh instance takes a minute or two)
wait_for_ssm() {
  local id=$1 i status
  for i in $(seq 1 60); do
    status=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$id" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
    [ "$status" = Online ] && return 0
    [ "$i" -eq 1 ] && echo "waiting for the instance's SSM agent..."
    sleep 10
  done
  echo "the SSM agent on $id never came online" >&2
  return 1
}

# ssm_run INSTANCE SCRIPT: run SCRIPT as root with bash, print its output, fail if it fails
ssm_run() {
  local id=$1 script=$2 params cmd status i
  params=$(jq -n --arg s "$script" '{commands: ["bash -c " + ($s | @sh)], executionTimeout: ["900"]}')
  cmd=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --parameters "$params" --query Command.CommandId --output text)
  for i in $(seq 1 180); do
    status=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in Pending|InProgress|Delayed) sleep 3 ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query StandardOutputContent --output text
  local err
  err=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query StandardErrorContent --output text)
  [ -n "$err" ] && [ "$err" != None ] && printf '%s\n' "$err" >&2
  [ "$status" = Success ] || { echo "command $cmd: $status" >&2; return 1; }
}
