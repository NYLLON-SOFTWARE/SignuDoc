# Run SignuDoc on Kubernetes

The [Helm chart](../charts/signudoc) requires Kubernetes 1.27 or later, Helm 3 or 4, and an existing PostgreSQL database. Provision PostgreSQL, its credentials, and any TLS CA outside the chart. A managed database and a database operator in your own cluster both work with the same connection settings.

## Build the images

From the repository root, build and publish both targets from the same checkout. Replace the example repository with a registry your cluster can pull from.

```bash
image=registry.example.com/signudoc
version=$(git rev-parse --short=12 HEAD)

docker build --target runner --build-arg NEXT_DEPLOYMENT_ID="$version" -t "$image:$version" .
docker build --target migrate -t "$image:$version-migrate" .
docker push "$image:$version"
docker push "$image:$version-migrate"
```

The images use Node.js 24 on Debian slim and run as UID/GID 1000. The runner starts the Next.js standalone server on port 3000 and includes public assets, static bundles, PDF fonts and WebAssembly. The migrator runs `node db/migrate.mjs` with the production dependencies and SQL migrations. The builds need no database or application secrets. The Docker build accepts a `NODE_IMAGE` override if you pin the base to a digest.

`NEXT_STANDALONE=1` enables standalone output for `npm run build`. The runner target sets it automatically. In this mode the Next proxy buffers up to 25 MB to fit a 20 MiB PDF plus multipart overhead. Set an equal or higher body limit at your ingress. All replicas of a release should run the same published build. Pass the same `NEXT_DEPLOYMENT_ID` to each architecture in a multi-platform build, and change it on each release. Without the build argument Docker generates an ID during the build. The normal Vercel build continues to use the existing Vercel configuration.

The runner handles `SIGTERM` directly. The chart allows 30 seconds to drain requests. Give `/app/.next/cache` and `/tmp` writable ephemeral mounts when running with a read-only root. When using local storage, also mount a writable, durable volume at `/app/.data/storage`.

## Configure and install

Create the namespace and provision a Secret there before installing. The default Secret name is `signudoc-env`. Use your usual secret management tooling and keep credentials out of Helm values. These keys apply to a typical deployment.

| Secret key                     | Use                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | Required PostgreSQL URL. Use a role that can apply migrations if this is also the migration connection.                                                                  |
| `DATABASE_URL_UNPOOLED`        | Direct migration connection if `DATABASE_URL` uses a transaction pooler.                                                                                                 |
| `BETTER_AUTH_SECRET`           | Stable secret of at least 32 characters. Generate it once with `openssl rand -hex 32` and back it up. The default PDF seal key is encrypted using a key derived from it. |
| `SETUP_TOKEN`                  | Secret required to claim the first administrator account when set. Set this before exposing a new install.                                                               |
| `RESEND_API_KEY`               | Required to send email. Verify your sending domain in Resend.                                                                                                            |
| `CRON_SECRET`                  | Required when enabling a chart CronJob. Use a randomly generated secret.                                                                                                 |
| `BLOB_READ_WRITE_TOKEN`        | Required when using a private Vercel Blob store from Kubernetes.                                                                                                         |
| `BACKUP_BLOB_READ_WRITE_TOKEN` | Required when enabling the backup CronJob. Use a separate private Vercel Blob store.                                                                                     |

If you use your own PDF seal, also back up `SEAL_P12_BASE64` and `SEAL_P12_PASSWORD`. See the [self-hosting guide](self-hosting.md#signed-pdfs-and-the-seal) for seal options and the [environment reference](../.env.example) for more settings.

For example, save these nonsecret settings in `values-production.yaml`. The TLS Secret must exist or be issued by your ingress setup.

```yaml
image:
  repository: registry.example.com/signudoc
  tag: replace-with-the-built-tag
existingSecret: signudoc-env
appUrl: https://sign.example.com
storage:
  driver: local
  size: 10Gi
ingress:
  enabled: true
  className: your-ingress-class
  host: sign.example.com
  tls:
    - hosts: [sign.example.com]
      secretName: signudoc-tls
```

```bash
helm upgrade --install signudoc ./charts/signudoc \
  --namespace signudoc -f values-production.yaml --wait --timeout 10m
```

The Service is internal to the cluster. Configure your ingress to set `X-Forwarded-For` from trusted proxy hops and remove untrusted client-supplied forwarding headers. Use `imagePullSecrets` for private registries. `config` adds nonsecret environment values to the app ConfigMap. The app loads the existing Secret as environment variables, so restart it after changing that Secret. The `extraEnv`, `extraVolumes` and `extraVolumeMounts` lists apply to both app and migration pods. For example, use them to reference a database URL from another Secret and mount a PostgreSQL CA for certificate and hostname verification. Pre-create all referenced Secrets, ConfigMaps and registry credentials before the migration hook runs.

Visit `/setup` to create the first administrator. The startup and liveness probes use `/api/health/live`. The readiness probe uses `/api/health/ready`, which returns 204 after a successful `SELECT 1` and 503 if PostgreSQL is unavailable. Check the migration Job to confirm the schema was applied.

## Choose document storage

| Driver            | Configuration                                                                                                                                                                                                                                            | Replicas                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `local` (default) | The chart creates a `ReadWriteOnce` PVC, or uses a PVC supplied in `storage.existingClaim`. The volume must be writable by GID 1000.                                                                                                                     | Exactly one replica, `Recreate` strategy and autoscaling disabled. An upgrade briefly takes the app offline. |
| `blob`            | Set `storage.driver: blob` and supply `BLOB_READ_WRITE_TOKEN` in the existing Secret.                                                                                                                                                                    | Multiple replicas and optional CPU autoscaling.                                                              |
| `s3`              | Set `storage.driver: s3` with a runner image that supports S3. Configure `S3_BUCKET`, `S3_REGION`, and, for compatible services, `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`. Supply AWS credentials through a Secret or the workload's credential provider. | Multiple replicas and optional CPU autoscaling.                                                              |

Object storage deployments use no document PVC. The default 0.4.0 app code supports local and Blob storage. Select a build that includes the S3 driver explicitly before choosing `s3`. Changing the driver does not copy existing PDFs. During a storage move, stop writes and verify that existing object keys remain readable in the new backend before reopening the app.

Before switching a local install to object storage, verify a backup of the claim. If you use Argo CD, confirm the `Prune=false,Delete=false` annotation is on the live PVC first. Argo CD can prune an unprotected claim when the storage switch removes it from the desired resources. Remove the old claim manually only after verifying the migration and backup.

With shared PostgreSQL and object storage, replicas can serve the same documents. Budget database connections for each replica. Rate limits share the database and fall back to per-process memory during a database outage. Next.js caches are per pod. Email uses the shared Resend account and its delivery limits. Document finalization and other work can be interrupted by a hard kill, including eviction. Check application and provider logs before retrying an interrupted operation whose outcome is unknown.

## Place replicas on separate nodes

Use `affinity`, `nodeSelector` and `tolerations` to control scheduling for the app Deployment. Empty values leave placement to Kubernetes. This example requires two Blob-backed replicas to run on separate nodes. Change `app.kubernetes.io/instance` to the Helm release name.

```yaml
storage:
  driver: blob
replicaCount: 2
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: signudoc
            app.kubernetes.io/instance: signudoc
        topologyKey: kubernetes.io/hostname
```

Hard anti-affinity requires enough eligible nodes for every replica. With two replicas, the default rolling update also needs a spare eligible node for the new pod. If capacity is limited to the replica count, `strategy: Recreate` permits upgrades with planned downtime. [Kubernetes affinity and anti-affinity](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#inter-pod-affinity-and-anti-affinity).

## Migrations and recovery

With `migration.mode: helm`, a blocking `pre-install` and `pre-upgrade` Job runs the migrator before the Deployment changes. Repeated runs skip applied migrations. Hook policies replace the previous Job before another run. Successful jobs are cleaned up, and failed Jobs are available for inspection for up to a day. Set `migration.image` when the runner and migrator use different repositories or tag conventions. [Helm chart hooks](https://helm.sh/docs/topics/charts_hooks/).

For Argo CD, set `migration.mode: argocd`. A `PreSync` Job at wave `-1` must complete before the app sync. Provision the database, CA and credentials before a full sync, such as in a separate infrastructure application. Selective sync skips hooks. If you manage an equivalent migration gate elsewhere, `migration.mode: disabled` omits the Job. [Argo CD sync phases and waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/).

Back up the database and documents before upgrading. Old app pods may still be serving while new migrations run, so check schema compatibility or take a maintenance window. A Helm rollback changes workloads without undoing applied SQL. For recovery, restore a compatible database and document snapshot together and reuse the backed-up auth and seal secrets.

Use your database provider or operator for database backups and test restores. With S3, enable object versioning and set retention appropriate for your restore window. For local storage, include the PVC in your backups. Helm retains a chart-created claim on uninstall, and the chart marks the claim for retention during Argo CD pruning and application deletion. A retained claim can leave an Argo CD application OutOfSync until you manage or remove it. Check the PVC and volume reclaim policy before removing the namespace. [Argo CD sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/#no-prune-resources).

## Scheduled maintenance

Both schedules are disabled by default. Enable `cron.retention.enabled` to run one daily request to `/api/internal/retention`. It handles retention, reminders and notices for missed signing deadlines. On Blob storage, optionally enable `cron.backup.enabled` to call `/api/internal/backup` with a second Blob store configured. See [backup and restore](backup-and-restore.md) for the contents and limits of that backup.

Each CronJob calls the internal Service by HTTP POST using `Authorization: Bearer` with `CRON_SECRET` from the existing Secret. The caller requires a completed run summary. An HTTP error, skipped run, or run that stops early fails the Job. Requests have a deadline, and each CronJob forbids overlapping runs. Set `cron.retention.schedule`, `cron.backup.schedule`, and `cron.timeZone` to change the schedules. Enable only one scheduler for each endpoint when moving from Vercel or using another scheduler against the same data.

## Validate chart changes

With Node.js 24, Helm and [Mike Farah's yq](https://github.com/mikefarah/yq) v4 installed, run `node charts/signudoc/tests/validate.mjs`. This lints and renders the chart locally and checks the scheduled request against a local HTTP server.
