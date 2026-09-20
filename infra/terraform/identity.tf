# Identity Platform (Firebase Authentication) with e-mail/password sign-in.
#
# Invite-only: public sign-up is disabled at the provider (disabled_user_signup), so only
# accounts created by an administrator can exist. The application ALSO refuses anyone without a
# pre-provisioned profile (app/src/lib/auth-profile.ts). Open sign-up requires signup_mode = "open"
# and must not be enabled until e-mail verification, abuse controls, authorization tests and cost
# controls are ready.
#
# Identity Platform requires a billing account linked to the project. The free tier covers the
# first 50,000 monthly active users for e-mail/password (verify current terms before relying on it).
resource "google_identity_platform_config" "default" {
  project = var.gcp_project_id

  autodelete_anonymous_users = true

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }
  }

  client {
    permissions {
      disabled_user_signup   = var.signup_mode != "open"
      disabled_user_deletion = false
    }
  }

  # Only the production hostnames: no localhost, and never the raw Cloud Run URL.
  authorized_domains = distinct(concat(
    ["${local.hosting_site_id}.firebaseapp.com", "${local.hosting_site_id}.web.app"],
    var.custom_domain == null ? [] : [var.custom_domain],
  ))

  lifecycle {
    # The API echoes these disabled-by-default blocks back; they are off and this configuration never enables them.
    ignore_changes = [multi_tenant, sign_in[0].phone_number]
  }

  depends_on = [google_project_service.apis]
}

# Browser API key for the Firebase web SDK: an identifier, not a secret, but restricted to the two
# APIs sign-in needs and to this application's origins so it cannot be reused elsewhere.
resource "google_apikeys_key" "web" {
  name         = "${local.name_prefix}-web"
  display_name = "Web sign-in key (${var.environment})"
  project      = var.gcp_project_id

  restrictions {
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
    api_targets {
      service = "securetoken.googleapis.com"
    }
    browser_key_restrictions {
      allowed_referrers = concat(
        ["${local.hosting_default}/*", "https://${local.hosting_site_id}.firebaseapp.com/*"],
        var.custom_domain == null ? [] : ["https://${var.custom_domain}/*"],
      )
    }
  }

  depends_on = [google_project_service.apis]
}
