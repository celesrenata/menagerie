# Final Cache Speedups — Pre-change Backups

- **UTC timestamp:** `20261011T212724Z`
- **Backup directory:** `/Users/celes/.local/state/omniroute-config/20261011T212724Z`
- **Cluster-equivalent backup root:** `/home/celes/.local/state/omniroute-routing`

## Captured successfully

- OmniRoute management API `GET /api/settings` (HTTP 200, valid JSON): `management-api/settings.json`
- OmniRoute management API `GET /api/combos` (HTTP 200, valid JSON): `management-api/combos.json`
- OmniRoute management API `GET /api/provider-nodes` (HTTP 200, valid JSON): `management-api/provider-nodes.json`
- Live image digest reference: `live-image-digest.txt`
  - `registry.celestium.life/library/omniroute@sha256:370472e70530dfbe74f94eb876178973eefdaa27301ed6bfdea8a308c0993fac`
- Workspace memory manifests:
  - `workspace-manifests/ovms-embeddings-proxy.yaml`
  - `workspace-manifests/ovms-embeddings-statefulset.yaml`
  - `workspace-manifests/ovms-readiness-scripts-configmap.yaml`
  - `workspace-manifests/ovms-reranker-deployment.yaml`

The management key was read from `/run/secrets/omniroute_management_api_key` for the read-only requests and was not copied, printed, or stored.

## Deferred / required before mutation

Nothing listed in this backup step was unreachable; all requested state available from this session was captured locally. Before **every** production mutation, take a fresh timestamped backup under `/home/celes/.local/state/omniroute-routing` on the cluster host (or `/Users/celes/.local/state/omniroute-config` from this session). Roll back on failed readback or canary.
