# Runbook: operations

`<prefix>` is `hrtstocks-<environment>`; region `asia-south1`.

## Start work manually

```bash
gcloud run jobs execute <prefix>-screening --region asia-south1 --wait                       # a new EOD run
gcloud run jobs execute <prefix>-screening --region asia-south1 \
  --update-env-vars RESUME_RUN_ID=<screening_runs.id>                                        # resume an interrupted run
gcloud run jobs execute <prefix>-buy-setup --region asia-south1 --update-env-vars RUN_ID=<published run id>
```

Researchers can also use **Run screening now** / **Run buy-setup analysis** in the app (they start the same jobs). A second start while one is running is a safe no-op (run lease).

## Schedule

The weekday EOD Cloud Scheduler job is created only with `enable_scheduler = true` (15:45 IST). Because the FYERS token is rotated by hand, enable it only when you
will rotate the token first each trading day; otherwise the scheduled run fails clearly (see [fyers-token.md](fyers-token.md)).
Pause/resume: `gcloud scheduler jobs pause|resume <prefix>-eod-screening --location asia-south1`.

## Watch and debug

- **Logs:** `gcloud run jobs executions list --job <prefix>-screening --region asia-south1`; Cloud Logging query `resource.type="cloud_run_job"`. Job logs are JSON lines with `severity`.
- **Errors:** Error Reporting groups job/app exceptions. **Alerts:** a failed job execution and web 5xx alert to `alert_emails`.
- **Run state:** in the app, Data health shows run status, batches, coverage and persistence errors (staff only). In SQL: `screening_runs`, `pipeline_batches`, `pipeline_audit_log`.
- **A run "failed" immediately with a FYERS message:** rotate the token.

## A run looks stuck

The job holds a lease (`screening_run_leases`). If an execution was killed, the lease expires on its own (3 minutes after the last heartbeat). To force-release after **confirming no execution is running**:

```sql
select run_type, status, run_id, expires_at from screening_run_leases;
update screening_run_leases set status = 'released' where run_type = 'eod_screening' and status = 'active';
```

Then resume with `RESUME_RUN_ID`. Batches abandoned by a dead execution are reset by the job itself after 8 minutes; a run gives up (marks `partial`) after `SCREENING_MAX_RUN_MINUTES` (default 40).

## Database

- Migrations run automatically in each deploy (`<prefix>-migrate`). Check: `node db/migrate.mjs --status` through the Cloud SQL Auth Proxy.
- Connect for maintenance through the **Cloud SQL Auth Proxy** (IAM-authorized); there are no allow-listed IPs.
- Backups: daily, 7 retained. Restore procedure: [rollback.md](rollback.md).

## Cost

Check the billing report; budget alerts email at 50/90/100 % and forecast (they do not stop spending). To stop cost quickly: pause the scheduler, and stop/scale the Cloud SQL instance
(`gcloud sql instances patch <name> --activation-policy=NEVER`) when not in use.
