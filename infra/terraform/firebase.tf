# Custom domain -> Firebase Hosting (Google-managed TLS certificate) -> rewrite -> Cloud Run in var.gcp_region.
#
# There is deliberately NO Cloud Run domain-mapping resource and NO load balancer: Hosting is the only
# public entry point that is given a custom domain. Everything (pages, API routes, SSR) is forwarded to
# the Cloud Run service by one catch-all rewrite. Hosting forwards only the `__session` cookie (which is
# why the application's session cookie has that name) and strips others; the application marks every
# dynamic response `Cache-Control: private, no-store`, so Hosting's CDN never caches user data.
#
# HTTP is redirected to HTTPS by Hosting itself. Nothing here touches DNS: the records to add at the DNS
# provider are exposed by the `dns_records_required` output after apply. Only this one host name is
# involved -- the apex and every other manaoorugpt.com subdomain are untouched.

resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.gcp_project_id
  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_site" "app" {
  provider = google-beta
  project  = var.gcp_project_id
  site_id  = local.hosting_site_id

  depends_on = [google_firebase_project.this]
}

resource "google_firebase_hosting_custom_domain" "app" {
  provider = google-beta
  count    = var.custom_domain == null ? 0 : 1

  project       = var.gcp_project_id
  site_id       = google_firebase_hosting_site.app.site_id
  custom_domain = var.custom_domain

  # Do not block the apply on DNS: the operator adds the records afterwards (docs/gcp/runbooks/qa-deployment.md).
  wait_dns_verification = false
}

resource "google_firebase_hosting_version" "app" {
  provider = google-beta
  site_id  = google_firebase_hosting_site.app.site_id

  config {
    rewrites {
      glob = "**"
      run {
        service_id = google_cloud_run_v2_service.app.name
        region     = var.gcp_region
      }
    }
  }
}

resource "google_firebase_hosting_release" "app" {
  provider     = google-beta
  site_id      = google_firebase_hosting_site.app.site_id
  version_name = google_firebase_hosting_version.app.name
  message      = "Rewrite all traffic to Cloud Run (${local.name_prefix}-app)"
}
