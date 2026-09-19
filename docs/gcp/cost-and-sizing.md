# Cost, free tier and database sizing

Prices below were read on 2026-09-19 from the **Cloud Billing Catalog API** (list prices in USD for `asia-south1`, before any discount or credit); the billing account is billed in INR, so the invoice is converted (about 95.9 INR per USD on 2026-09-17).
Usage figures are assumptions, listed below. Actual cost is whatever Cloud Billing reports.

## Cost control that is built in

- Cloud Run service **scales to zero** (`min 0`), CPU is billed only while handling requests, and **max instances is 1** (`app_max_instances`).
- Cloud Run **Jobs** cost only while executing. No always-on compute and no always-on-CPU service exists.
- **No load balancer** and no Cloud Run domain mapping: the custom domain is served by Firebase Hosting.
- Cloud SQL: Enterprise `db-f1-micro`, **zonal, no HA**, 10 GB (the minimum), backups kept 7 days, no point-in-time recovery, deletion protection on.
- Cloud Scheduler is **off** (`enable_scheduler = false`): the FYERS token is rotated by hand each day, so runs are started manually until unattended runs are wanted.
- Artifact Registry keeps the 10 most recent images (older than 30 days deleted).
- The chart bucket aborts incomplete uploads after 7 days; age-based expiry is opt-in (`charts_max_age_days`).
- A **USD 30 / month billing budget** (created as INR 2,880 because the billing account is billed in INR) alerts at **50 / 75 / 90 / 100 %** through the billing account's own notifications (no Pub/Sub topic, no Cloud Function). **A budget only sends alerts; it does not stop or cap spending.**

## Estimated monthly cost (QA, `asia-south1`, 730 h/month)

| Service | Price used (catalog SKU) | Assumption | Monthly (USD) |
|---|---|---|---|
| **Cloud SQL** instance | PostgreSQL Enterprise zonal micro: $0.0126 / h | always on, 730 h | **9.20** |
| Cloud SQL storage | Standard (SSD) zonal: $0.204 / GiB-month | 10 GiB provisioned (the minimum; auto-increase on) | **2.04** |
| Cloud SQL backups | $0.096 / GiB-month | 7 daily backups of a small database, about 2 GiB stored | **0.19** |
| Cloud SQL public IPv4 | IP address reservation: $0.012 / h | charged for the whole month (assumed even though no authorized networks are set) | **8.76** |
| **Cloud Run** service | request-based CPU $0.000024 / s, memory $0.0000025 / GiB-s, min instances 0 | 5,000 requests, about 0.3 s each, 1 vCPU / 512 MiB, **no free tier assumed** | ~0.05 |
| **Cloud Run** jobs | $0.000018 / vCPU-s, $0.000002 / GiB-s | 20 screening runs x 30 min + a few FOME runs at 1 vCPU / 1 GiB, no free tier assumed | ~1.00 |
| **Cloud Storage** (bucket) | Standard Mumbai $0.023 / GiB-month | about 1 GiB of SVG charts (empty at first) | ~0.03 |
| **Artifact Registry** | $0.10 / GiB-month after 0.5 GiB free | 10 images kept, about 3 GiB | ~0.25 |
| **Secret Manager** | 6 active versions free, $0.06 per extra | 2 secrets, a few versions, a handful of accesses | 0.00 |
| **Firebase Hosting** | storage 0.33 GiB and 0.35 GiB/day free, then $0.026 / GiB and $0.15 / GiB | no static files; rewrite only; under 2 GiB served | ~0.00 (needs the pay-as-you-go plan) |
| **Networking** egress | internet egress from Mumbai, about $0.12–0.19 / GiB (not found as a catalog SKU; upper end assumed) | about 2 GiB/month to users; Cloud Run to Hosting is Google-internal | ~0.40 |
| Identity Platform, Cloud Logging, Cloud Monitoring | free MAU allowance; first 50 GiB of logs free; alert policies free | one user; a few MB of logs | 0.00 |
| **Total** | | | **about 22** (worst case about 25) |

Normal QA cost is therefore about **USD 22 / month (about INR 2,100)**, below the USD 30 limit. Cloud SQL (about 20 of the 22) dominates; everything else is under 2.
The estimate is sensitive to only two things: leaving the database running all month (assumed) and heavy egress (assumed small). Compute for a full-universe run could be higher than assumed on the first ingestion; even 10x the job assumption adds under USD 10.
If Cloud SQL alone were ever billed differently (for example the IPv4 line not applying), the total only goes down.

Remaining unknowns, all small: the exact internet-egress rate, the actual backup size, and the pay-as-you-go plan requirement for Hosting (no charge by itself).

## Database tiers

| Environment | Setting | Why |
|---|---|---|
| Local | PostgreSQL in Docker | no cloud dependency |
| **QA / MVP (now)** | Enterprise `db-f1-micro`, **single zone, no HA**, 10 GB | cheapest. Shared-core: **no SLA, non-production** |
| **Public production (not chosen yet)** | `cloud_sql_tier`, **no value selected** | pick after load testing |

### Choosing the production tier

The smallest **SLA-eligible** Enterprise tier is a dedicated-core machine (for example `db-custom-1-3840`); shared-core tiers are not covered by the SLA. Choose by measurement:

1. Run a full first-time ingestion and screening on a candidate tier.
2. Replay a realistic load: a full EOD `screening` execution (write-heavy) **while** a script of concurrent page reads hits the ledger, direction and buy-setup pages.
3. Watch Cloud SQL: CPU, memory, **connections vs. `max_connections`** (each web instance holds up to `DB_POOL_MAX`=4, each job a few), IOPS, and the slowest queries in Query Insights.
4. Pick the smallest tier that stays under ~60–70 % CPU and ~70 % memory with headroom on connections; re-test after changing `DB_POOL_MAX` or `app_max_instances`.

### Enabling high availability later

`cloud_sql_availability_type = "REGIONAL"` (adds a standby in another zone; roughly doubles instance cost, brief restart). Consider `point_in_time_recovery_enabled = true` in `cloud_sql.tf`, and a private-IP/VPC connection if IP-level isolation is required. Not enabled initially.
