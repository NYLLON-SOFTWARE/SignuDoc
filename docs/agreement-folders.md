# Agreement folders

Administrators can create folders and manage their membership under **Settings → Organization → Folders**. Folder members can open sent envelopes, view their audit trail and download their files. The sender can edit a draft or act on an envelope while they have access to its folder. Administrators can open any sent envelope. Recipient signing and download links use their own permissions.

Open a folder on the dashboard and choose **New envelope** to start there. Upload a PDF or use one of your existing templates. A copy stays in its original folder. Use an unfiled source to save a personal template.

Administrators can file a sent envelope or their own draft from its detail page. A move changes which folder members can open it and is recorded in the site audit trail. Move envelopes elsewhere before deleting a nonempty folder. Before removing a member, have them finish any drafts they still need.

The migration creates no folders and moves no envelopes. Unfiled envelopes continue to follow [Teams](teams.md) sharing. A folder's membership never grants access to other folders or to unfiled envelopes. A filed envelope is visible to members of its folder, and existing Teams membership gives no extra access to it.

Apply the schema migration and current application together. Once a folder contains envelopes, keep folder-aware authorization in any replacement release. Earlier releases do not enforce the folder boundary.
