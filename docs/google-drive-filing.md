# Google Drive filing

When the final participant completes an envelope, SignuDoc starts copying the signed PDF and the sender's audit certificate to the configured Google Drive folder. A Drive outage leaves the completed agreement available in SignuDoc. The authenticated [daily cleanup schedule](self-hosting.md#daily-cleanup) retries any unfinished copies. Both paths use the configured envelope owner and completion time to determine eligibility.

## Authorize the folder

1. Enable the Google Drive and Google Picker APIs in the same Google Cloud project and create a Desktop app OAuth client. Set `SIGNUDOC_DRIVE_CLIENT_ID`, `SIGNUDOC_DRIVE_CLIENT_SECRET`, and `SIGNUDOC_DRIVE_FOLDER_ID` locally using the matching client credentials and the ID from the destination folder's URL. [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
2. On a machine where you can open a local browser, run `node scripts/authorize-google-drive.mjs`. Open the loopback URL shown by the command. Sign in as a Google user who can add files to the destination, approve the `drive.file` scope, and select the configured folder in Google Picker. The command checks that Google granted access to that exact folder and that the account can add files there. [Google Picker for desktop apps](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker) · [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
3. The command returns the path of a private file containing the refresh token. Import that file into the deployment's secret store as `SIGNUDOC_DRIVE_REFRESH_TOKEN` and remove the local copy once the deployment can use the secret. Keep the client ID and secret paired with the token.

## Configure SignuDoc

| Variable                       | Value                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `SIGNUDOC_DRIVE_FOLDER_ID`     | ID of the selected folder.                                                                                                  |
| `SIGNUDOC_DRIVE_OWNER_EMAIL`   | Verified SignuDoc email address of the envelope owner whose files should be copied.                                         |
| `SIGNUDOC_DRIVE_START_AT`      | ISO 8601 timestamp in UTC, such as `2026-01-01T00:00:00Z`. Set it to the intended go-live time to skip earlier completions. |
| `SIGNUDOC_DRIVE_CLIENT_ID`     | OAuth client used to obtain the refresh token.                                                                              |
| `SIGNUDOC_DRIVE_CLIENT_SECRET` | Matching OAuth client secret.                                                                                               |
| `SIGNUDOC_DRIVE_REFRESH_TOKEN` | Refresh token issued after the owner grants offline access.                                                                 |

Store the client secret and refresh token in deployment secrets. Set `CRON_SECRET` or `RETENTION_JOB_SECRET` for the scheduler. Once configured, complete a test envelope under the configured owner and verify that both PDFs appear in the selected folder after the final participant finishes. A retry reuses the reserved Drive file IDs to avoid duplicate copies. [Google Drive file creation](https://developers.google.com/workspace/drive/api/guides/create-file)

Drive copies inherit access from the destination folder. Copies in Drive have their own lifecycle, so apply your retention policy to the destination as well. Clear the filing configuration to stop future copies.
