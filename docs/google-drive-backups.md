# Google Drive backup setup

Agentor can store encrypted backups in Google Drive using a separate Google OAuth client. This OAuth client is only for backups; it is unrelated to Agentor login or the agent CLI credentials used inside workers.

## Before you begin

- Configure a high-entropy `BACKUP_ENCRYPTION_KEY`, or securely preserve the generated `<DATA_DIR>/backup.key`.
- Store that key outside Agentor and outside the Google Drive folder holding the backups. Backups cannot be restored if the key is lost or changed.
- Sign in to Agentor as an administrator and open **Backup management**. Keep the **Google Drive OAuth installation** section available so you can copy its exact redirect URI.

## Create the Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Open **APIs & Services → Library**, find **Google Drive API**, and enable it.
3. Open **Google Auth Platform** and choose **User data**. A service account or **Application data** is not appropriate for this flow.
4. Under **Branding**, enter the application name, support email, and developer contact information.
5. Under **Audience**, select **External** unless every user belongs to the same Google Workspace organization. While the app is in Testing, add the Google account that will own the backups as a **Test user**.
6. Under **Data Access**, add this scope:

   ```text
   https://www.googleapis.com/auth/drive.file
   ```

   This lets Agentor manage files it creates or that are explicitly opened with the app; it does not grant access to every file in the account.
7. Under **Clients**, create an OAuth client with application type **Web application**.
8. Add the redirect URI shown by Agentor as an **Authorized redirect URI**. It follows this pattern:

   ```text
   https://your-agentor-domain.example/api/backup-providers/google/oauth/callback
   ```

   For example, a deployment at `https://agentor.dirigent.uk` uses:

   ```text
   https://agentor.dirigent.uk/api/backup-providers/google/oauth/callback
   ```

   The URI must match exactly, including scheme, hostname, port (if any), path, and trailing slash. No Authorized JavaScript origin is required.
9. Create the client and copy its **Client ID** and **Client secret**.

## Link Agentor to Google Drive

1. In Agentor, open **Backup management → Google Drive OAuth installation**.
2. Enter the Client ID, the exact redirect URI registered with Google, and the Client secret. Save the configuration.
3. Click **Link Google Drive**, sign in as the Google account that will own the backups, and approve the requested access.
4. Return to Backup management and confirm that Google Drive reports as linked or ready.
5. Create a small initial backup and wait for it to complete. Before relying on the setup, perform a restore into a disposable new worker and verify its contents.

The client secret and OAuth tokens are encrypted at rest. Agentor never displays the saved client secret again.

## Production and token lifetime

Google OAuth apps left in Testing can issue refresh tokens that expire after seven days for many scopes. That is useful during setup but unsuitable for unattended scheduled backups. Once testing is complete, publish the OAuth app to Production as appropriate for your organization and Google verification requirements.

## Troubleshooting

### `redirect_uri_mismatch`

Compare the URI in Google's error with both the Authorized redirect URI in the Google client and the redirect URI saved in Agentor, character for character. Also verify that Agentor's externally visible HTTPS URL is configured correctly behind any reverse proxy.

### The app is unavailable to the Google account

If the OAuth app is External and in Testing, add that account under **Audience → Test users**. Also confirm that the Google Drive API is enabled in the same Cloud project as the OAuth client.

### Linking worked but later backups cannot authenticate

Check whether the app is still in Testing and its refresh token has expired, whether access was revoked in the Google account, or whether the OAuth client was deleted or its secret changed. Relink the provider after correcting the cause.

### A backup exists but restore/decryption fails

Confirm the installation is using the exact `BACKUP_ENCRYPTION_KEY` or `<DATA_DIR>/backup.key` that encrypted the backup. Google OAuth credentials cannot replace a missing encryption key.
