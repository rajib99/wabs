#!/usr/bin/env bash
# Nightly pg_dump to R2 with 14-day retention. Reads settings from the app's .env.
# Cron (as the deploy user): 30 21 * * * cd /opt/biyeshadi && deploy/backup.sh >> /var/log/biyeshadi-backup.log 2>&1
# (21:30 UTC is 03:30 in Bangladesh.)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
BUCKET="${R2_BACKUP_BUCKET:?set R2_BACKUP_BUCKET, separate from the media bucket}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
NAME="biyeshadi-$(date -u +%Y%m%dT%H%M%SZ).dump"

aws_cli() {
  docker run --rm -i -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto amazon/aws-cli --endpoint-url "$ENDPOINT" "$@"
}

docker compose exec -T postgres pg_dump -U biyeshadi -d biyeshadi -Fc | aws_cli s3 cp - "s3://$BUCKET/$NAME"

SIZE="$(aws_cli s3api head-object --bucket "$BUCKET" --key "$NAME" --query ContentLength --output text)"
if [[ "$SIZE" -lt 1024 ]]; then
  echo "backup $NAME is suspiciously small ($SIZE bytes): keeping old backups" >&2
  exit 1
fi

CUTOFF="$(date -u -d "-$RETENTION_DAYS days" +%Y%m%d)"
aws_cli s3api list-objects-v2 --bucket "$BUCKET" --prefix biyeshadi- --query 'Contents[].Key' --output text | tr '\t' '\n' | while read -r key; do
  stamp="${key#biyeshadi-}"; stamp="${stamp%%T*}"
  if [[ "$stamp" =~ ^[0-9]{8}$ && "$stamp" -lt "$CUTOFF" ]]; then aws_cli s3 rm "s3://$BUCKET/$key"; fi
done
echo "backup ok: $NAME ($SIZE bytes)"
