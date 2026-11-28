import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const chart = fileURLToPath(new URL("../", import.meta.url));
const s3 = [
  "--set",
  "storage.driver=s3,replicaCount=3,autoscaling.enabled=true",
];

function renderRelease(release, ...options) {
  const yaml = execFileSync("helm", ["template", release, chart, ...options], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const documents = execFileSync("yq", ["-o=json", "-I=0", ".", "-"], {
    input: yaml,
    encoding: "utf8",
  });
  return documents.trim().split("\n").map(JSON.parse);
}

function render(...options) {
  return renderRelease("demo", ...options);
}

function workload(objects, kind) {
  const object = objects.find((resource) => resource.kind === kind);
  assert.ok(object, `Expected a rendered ${kind}`);
  return object;
}

const local = render();
const localDeployment = workload(local, "Deployment");
const localPod = localDeployment.spec.template.spec;
const [app] = localPod.containers;
for (const option of ["affinity", "nodeSelector", "tolerations"]) {
  assert.equal(localPod[option], undefined);
}
assert.equal(localDeployment.spec.replicas, 1);
assert.deepEqual(localDeployment.spec.strategy, {
  type: "Recreate",
  rollingUpdate: null,
});
const localClaim = workload(local, "PersistentVolumeClaim");
assert.deepEqual(localClaim.spec.accessModes, ["ReadWriteOnce"]);
assert.equal(
  localClaim.metadata.annotations["helm.sh/resource-policy"],
  "keep",
);
assert.deepEqual(
  localClaim.metadata.annotations["argocd.argoproj.io/sync-options"]
    ?.split(",")
    .sort(),
  ["Delete=false", "Prune=false"],
);
assert.ok(localPod.volumes.some((volume) => volume.persistentVolumeClaim));
assert.ok(localPod.securityContext.runAsNonRoot);
assert.ok(app.securityContext.readOnlyRootFilesystem);
assert.deepEqual(app.securityContext.capabilities.drop, ["ALL"]);
for (const path of ["/app/.next/cache", "/tmp"]) {
  const mount = app.volumeMounts.find((mount) => mount.mountPath === path);
  assert.ok(
    localPod.volumes.find((volume) => volume.name === mount?.name)?.emptyDir,
  );
}
assert.equal(app.livenessProbe.httpGet.path, "/api/health/live");
assert.equal(app.readinessProbe.httpGet.path, "/api/health/ready");
assert.ok(!local.some(({ kind }) => kind === "CronJob"));
assert.ok(
  !local.some(({ kind }) => kind === "Secret" || kind === "StatefulSet"),
);

for (const [setting, error] of [
  ["replicaCount=2", /local storage requires replicaCount=1/],
  ["strategy=RollingUpdate", /local storage requires Recreate/],
  ["autoscaling.enabled=true", /local storage cannot use autoscaling/],
  ["cron.backup.enabled=true", /backup requires blob storage/],
]) {
  assert.throws(() => render("--set", setting), error);
}

const external = render(...s3);
assert.ok(!external.some(({ kind }) => kind === "PersistentVolumeClaim"));
assert.deepEqual(workload(external, "Deployment").spec.strategy, {
  type: "RollingUpdate",
});
const externalRecreate = render(...s3, "--set", "strategy=Recreate");
assert.deepEqual(workload(externalRecreate, "Deployment").spec.strategy, {
  type: "Recreate",
  rollingUpdate: null,
});
assert.equal(workload(external, "HorizontalPodAutoscaler").spec.minReplicas, 1);
assert.equal(
  workload(render("--set", "storage.driver=blob,replicaCount=3"), "Deployment")
    .spec.replicas,
  3,
);
assert.throws(
  () => render(...s3, "--set", "cron.backup.enabled=true"),
  /backup requires blob storage/,
);

const placement = {
  affinity: {
    podAntiAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "signudoc",
              "app.kubernetes.io/instance": "demo",
            },
          },
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    },
  },
  nodeSelector: { "example.com/node-pool": "signing" },
  tolerations: [
    {
      key: "example.com/dedicated",
      operator: "Equal",
      value: "signing",
      effect: "NoSchedule",
    },
  ],
};
const placed = render(
  "--set",
  "storage.driver=s3,replicaCount=2",
  ...Object.entries(placement).flatMap(([key, value]) => [
    "--set-json",
    key + "=" + JSON.stringify(value),
  ]),
);
const placedDeployment = workload(placed, "Deployment");
assert.equal(placedDeployment.spec.replicas, 2);
const placedPod = placedDeployment.spec.template;
for (const [option, expected] of Object.entries(placement)) {
  assert.deepEqual(placedPod.spec[option], expected);
  assert.equal(workload(placed, "Job").spec.template.spec[option], undefined);
}
const [antiAffinity] =
  placedPod.spec.affinity.podAntiAffinity
    .requiredDuringSchedulingIgnoredDuringExecution;
for (const [label, value] of Object.entries(
  antiAffinity.labelSelector.matchLabels,
)) {
  assert.equal(placedPod.metadata.labels[label], value);
}

const provisioned = render(
  "--set",
  "existingSecret=deployment-env,imagePullSecrets[0].name=registry-auth",
  "--set",
  "ingress.enabled=true,ingress.className=traefik,ingress.host=sign.example.org,ingress.tls[0].hosts[0]=sign.example.org,ingress.tls[0].secretName=sign-tls",
  "--set",
  "extraEnv[0].name=DATABASE_URL,extraEnv[0].valueFrom.secretKeyRef.name=postgres-app,extraEnv[0].valueFrom.secretKeyRef.key=uri",
  "--set",
  "extraVolumeMounts[0].name=postgres-ca,extraVolumeMounts[0].mountPath=/etc/postgres-ca,extraVolumes[0].name=postgres-ca,extraVolumes[0].secret.secretName=postgres-ca",
);
const ingress = workload(provisioned, "Ingress");
assert.equal(ingress.spec.ingressClassName, "traefik");
assert.equal(ingress.spec.tls[0].secretName, "sign-tls");
const migration = workload(provisioned, "Job");
assert.equal(
  migration.metadata.annotations["helm.sh/hook"],
  "pre-install,pre-upgrade",
);
assert.match(
  migration.metadata.annotations["helm.sh/hook-delete-policy"],
  /before-hook-creation/,
);
assert.ok(migration.spec.activeDeadlineSeconds > 0);
for (const pod of [
  workload(provisioned, "Deployment").spec.template.spec,
  migration.spec.template.spec,
]) {
  const [container] = pod.containers;
  assert.deepEqual(pod.imagePullSecrets, [{ name: "registry-auth" }]);
  assert.ok(
    container.envFrom.some(
      (source) => source.secretRef?.name === "deployment-env",
    ),
  );
  assert.deepEqual(
    container.env.find(({ name }) => name === "DATABASE_URL").valueFrom
      .secretKeyRef,
    {
      name: "postgres-app",
      key: "uri",
    },
  );
  assert.ok(
    container.volumeMounts.some(
      ({ mountPath }) => mountPath === "/etc/postgres-ca",
    ),
  );
  assert.ok(
    pod.volumes.some(({ secret }) => secret?.secretName === "postgres-ca"),
  );
}
assert.ok(
  !migration.spec.template.spec.containers[0].envFrom.some(
    (source) => source.configMapRef,
  ),
);
const argo = render("--set", "migration.mode=argocd");
const argoMigration = workload(argo, "Job");
assert.equal(
  argoMigration.metadata.annotations["argocd.argoproj.io/hook"],
  "PreSync",
);
assert.ok(
  Number(argoMigration.metadata.annotations["argocd.argoproj.io/sync-wave"]) <
    0,
);
assert.match(
  argoMigration.metadata.annotations["argocd.argoproj.io/hook-delete-policy"],
  /BeforeHookCreation/,
);
assert.ok(!argoMigration.metadata.annotations["helm.sh/hook"]);
assert.ok(
  !render("--set", "migration.mode=disabled").some(
    ({ kind }) => kind === "Job",
  ),
);

const scheduled = render(
  "--set",
  "storage.driver=blob,cron.backup.enabled=true,cron.retention.enabled=true,cron.retention.schedule=15 2 * * *,existingSecret=deployment-env",
);
const longRelease = renderRelease(
  "production.signudoc-in-a-longer-named-namespace",
  "--set",
  "cron.retention.enabled=true",
);
assert.match(
  workload(longRelease, "Service").metadata.name,
  /^[a-z][a-z0-9-]*$/,
);
assert.ok(workload(longRelease, "CronJob").metadata.name.length <= 52);

const jobs = scheduled.filter(({ kind }) => kind === "CronJob");
assert.equal(jobs.length, 2);
const [retention, backup] = ["retention", "backup"].map((name) =>
  jobs.find(({ metadata }) => metadata.name.endsWith(`-${name}`)),
);
assert.equal(retention.spec.schedule, "15 2 * * *");
assert.notEqual(retention.spec.schedule, backup.spec.schedule);
const service = workload(scheduled, "Service");
for (const [job, route] of [
  [retention, "retention"],
  [backup, "backup"],
]) {
  assert.equal(job.spec.concurrencyPolicy, "Forbid");
  const { activeDeadlineSeconds, backoffLimit, template } =
    job.spec.jobTemplate.spec;
  assert.ok(activeDeadlineSeconds > 0);
  assert.equal(backoffLimit, 0);
  const [container] = template.spec.containers;
  assert.deepEqual(
    container.env.find(({ name }) => name === "CRON_SECRET"),
    {
      name: "CRON_SECRET",
      valueFrom: {
        secretKeyRef: { name: "deployment-env", key: "CRON_SECRET" },
      },
    },
  );
  assert.equal(
    container.env.find(({ name }) => name === "JOB_URL").value,
    `http://${service.metadata.name}:${service.spec.ports[0].port}/api/internal/${route}`,
  );
}

// Execute the rendered command against an HTTP server to catch lost Bearer
// headers or failures that Kubernetes would otherwise record as successes.
const retentionReport = {
  accountPurgeFailures: [],
  accountsPurged: 0,
  draftDeletionFailures: [],
  draftsDeleted: 0,
  expiredRecipientDownloadTokensDeleted: 0,
  finishedEnvelopeDeletionFailures: [],
  finishedEnvelopesDeleted: 0,
  finishedEnvelopeWarningsSent: 0,
  pendingFileDeletionsDone: 0,
  providerSigningSessionsEnded: 0,
  ranAt: 1770000000,
  schedule: {
    expiryNoticeFailures: [],
    expiryNoticesSent: 0,
    reminderFailures: [],
    remindersSent: 0,
    stoppedEarly: false,
  },
};
const backupReport = {
  databaseBackup: "private-body",
  databaseBackupsRemoved: 0,
  fileFailures: [],
  filesCopied: 0,
  filesRemoved: 0,
  filesUnchanged: 0,
  stoppedEarly: false,
};
const cases = [
  ["retention", 200, { ...retentionReport, futureCounter: 1 }, 0],
  ["backup", 200, { ...backupReport, futureCounter: 1 }, 0],
  ["retention", 200, { ...retentionReport, stoppedEarly: true }, 1],
  ["retention", 200, { ...retentionReport, status: "skipped" }, 1],
  ["retention", 200, { ...retentionReport, status: "failed" }, 1],
  ["retention", 200, { ranAt: 1, schedule: { stoppedEarly: false } }, 1],
  [
    "retention",
    200,
    { ...retentionReport, draftDeletionFailures: ["private-body"] },
    1,
  ],
  [
    "retention",
    200,
    {
      ...retentionReport,
      schedule: {
        ...retentionReport.schedule,
        reminderFailures: ["private-body"],
      },
    },
    1,
  ],
  ["backup", 200, { ...backupReport, databaseBackup: "" }, 1],
  ["backup", 200, { ...backupReport, databaseBackup: "  " }, 1],
  ["backup", 200, { ...backupReport, schedule: { stoppedEarly: true } }, 1],
  ["backup", 200, { ...backupReport, fileFailures: ["private-body"] }, 1],
  ["backup", 200, { databaseBackup: "private-body", stoppedEarly: false }, 1],
  ["retention", 204, undefined, 1],
  ["retention", 200, "private-body", 1],
  ["retention", 200, { status: "skipped", reason: "already_running" }, 1],
  ["retention", 200, { ...retentionReport, schedule: null }, 1],
  [
    "retention",
    200,
    {
      ...retentionReport,
      schedule: { ...retentionReport.schedule, stoppedEarly: true },
    },
    1,
  ],
  ["backup", 200, { status: "not_configured" }, 1],
  ["backup", 200, { ...backupReport, stoppedEarly: true }, 1],
  ["backup", 401, { error: "private-body" }, 1],
  ["backup", 302, undefined, 1],
  ["retention", 500, { error: "private-body" }, 1],
];
let status;
let body;
const requests = [];
const server = createServer((request, response) => {
  requests.push({
    path: request.url,
    method: request.method,
    auth: request.headers.authorization,
  });
  response.writeHead(status, { Location: "/must-not-follow" }).end(body);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const [route, responseStatus, responseBody, expected] of cases) {
    status = responseStatus;
    body =
      typeof responseBody === "string"
        ? responseBody
        : JSON.stringify(responseBody);
    const [caller] = (route === "retention" ? retention : backup).spec
      .jobTemplate.spec.template.spec.containers;
    const command = spawn(
      caller.command[0],
      [...caller.command.slice(1), ...caller.args],
      {
        env: {
          ...process.env,
          CRON_SECRET: "  test-bearer  ",
          JOB_URL: `http://127.0.0.1:${server.address().port}/api/internal/${route}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    command.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    command.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const [code] = await once(command, "close");
    assert.equal(
      code,
      expected,
      `${route} HTTP ${status} must exit ${expected}`,
    );
    assert.doesNotMatch(logs, /test-bearer|private-body/);
  }
  assert.deepEqual(
    requests,
    cases.map(([route]) => ({
      path: `/api/internal/${route}`,
      method: "POST",
      auth: "Bearer test-bearer",
    })),
  );
} finally {
  server.close();
}

for (const options of [[], s3, ["--set", "storage.existingClaim=documents"]]) {
  execFileSync("helm", ["lint", "--strict", chart, ...options], {
    stdio: "inherit",
  });
}
console.log("Chart rendering and scheduled HTTP checks passed.");
