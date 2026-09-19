# Runbook: rollback

There is no previous production system to fall back to: QA is a new, empty deployment and no live data was migrated. Rollback therefore means
"go back to a previous revision of this deployment", or "tear it down".

## Application rollback (after a bad deploy)

```bash
# Web app: send traffic back to the previous revision
gcloud run revisions list --service <prefix>-app --region asia-south1
gcloud run services update-traffic <prefix>-app --region asia-south1 --to-revisions <previous-revision>=100

# Jobs: point back at the previous image (images are tagged by commit SHA)
gcloud run jobs update <prefix>-screening --region asia-south1 --image <registry>/pipeline:<previous-sha>
```

Firebase Hosting needs no action: it always rewrites to the Cloud Run service, which serves the revision you selected. (Terraform's Hosting release can be
re-applied from a previous commit if the rewrite itself was changed.)

## Database rollback

Migrations are **forward-only** and checksummed. To undo a bad schema change:

1. Prefer a new corrective migration (`db/migrations/00NN_...sql`), applied by the operator ([qa-deployment.md](qa-deployment.md) §3).
2. Restore from an automated backup into a **new** Cloud SQL instance (`gcloud sql backups list`, `gcloud sql backups restore` or a clone), then repoint `CLOUD_SQL_INSTANCE`. Point-in-time recovery is off by default (cost).
3. In QA the data is reproducible from fresh pipeline runs, so recreating the database (teardown §8, re-apply, migrate, seed, re-run the pipelines) is an acceptable recovery.

## Pipeline rollback

A failed or unpublished run never changes what users see: only a `published` snapshot is served. Re-running is safe and idempotent
(`docs/gcp/runbooks/operations.md`); resume an interrupted run with `RESUME_RUN_ID`.

## Full teardown

[qa-deployment.md](qa-deployment.md) §8.

## What cannot be rolled back automatically

- Any e-mail Identity Platform sends when a user requests a password reset.
- DNS records at the external DNS provider (the operator removes them).
