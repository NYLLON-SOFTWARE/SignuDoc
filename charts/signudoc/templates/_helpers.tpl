{{- define "signudoc.fullname" -}}
{{- $name := .Release.Name -}}
{{- /* CronJob names may be at most 52 characters, including the -retention suffix. */ -}}
{{- if or (gt (len $name) 42) (not (regexMatch "^[a-z][a-z0-9-]*$" $name)) -}}
  {{- $dnsLabel := regexReplaceAll "[^a-z0-9-]+" $name "-" -}}
  {{- if regexMatch "^[0-9]" $dnsLabel -}}
    {{- $dnsLabel = printf "signudoc-%s" $dnsLabel -}}
  {{- end -}}
  {{- printf "%s-%s" ($dnsLabel | trunc 34 | trimSuffix "-") ($name | sha256sum | trunc 7) -}}
{{- else -}}
  {{- $name -}}
{{- end -}}
{{- end -}}

{{- define "signudoc.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "signudoc.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{- define "signudoc.strategy" -}}
{{- default (ternary "Recreate" "RollingUpdate" (eq .Values.storage.driver "local")) .Values.strategy -}}
{{- end -}}

{{- define "signudoc.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "signudoc.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "signudoc.validate" -}}
{{- if not (has .Values.storage.driver (list "local" "blob" "s3")) -}}
  {{- fail "storage.driver must be local, blob, or s3" -}}
{{- end -}}
{{- $strategy := include "signudoc.strategy" . -}}
{{- if not (has $strategy (list "Recreate" "RollingUpdate")) -}}
  {{- fail "strategy must be Recreate or RollingUpdate" -}}
{{- end -}}
{{- if eq .Values.storage.driver "local" -}}
  {{- if ne (int .Values.replicaCount) 1 -}}
    {{- fail "local storage requires replicaCount=1" -}}
  {{- end -}}
  {{- if ne $strategy "Recreate" -}}
    {{- fail "local storage requires Recreate" -}}
  {{- end -}}
  {{- if .Values.autoscaling.enabled -}}
    {{- fail "local storage cannot use autoscaling" -}}
  {{- end -}}
{{- else if .Values.storage.existingClaim -}}
  {{- fail "storage.existingClaim requires local storage" -}}
{{- end -}}
{{- if and .Values.cron.backup.enabled (ne .Values.storage.driver "blob") -}}
  {{- fail "backup requires blob storage" -}}
{{- end -}}
{{- if not (has .Values.migration.mode (list "helm" "argocd" "disabled")) -}}
  {{- fail "migration.mode must be helm, argocd, or disabled" -}}
{{- end -}}
{{- range .Values.extraEnv -}}
  {{- if has .name (list "NODE_ENV" "PORT" "HOSTNAME" "STORAGE_DRIVER" "STORAGE_LOCAL_DIR" "CRON_SECRET") -}}
    {{- fail (printf "%s is managed by the chart and cannot be set via extraEnv" .name) -}}
  {{- end -}}
{{- end -}}
{{- end -}}
