# OmniRoute capacity cascade setup

Setup checked against remote host `celes@192.168.42.254` on 2026-10-10. No routing changes were made.

## Connectivity

- SSH succeeded; remote hostname: `esnixi`.
- Kubernetes is available through `/run/current-system/sw/bin/kubectl`.
- Deployment `omniroute` in namespace `omniroute` is ready (`1/1`).
- Service `omniroute` is a `ClusterIP` service on port `20128`, with endpoint `10.42.2.34:20128` at inspection time.

## Confirmed paths

- Writable Nix source: `/home/celes/sources/celesrenata/nix-flakes-refactored/home/programs/omniroute-mode.py` — exists, readable, and writable by `celes`.
- OmniRoute source checkout: `/home/celes/sources/omniroute-transcript-fix` — exists, readable, and writable by `celes`; no corrected alternate path was needed.
- Management key: `/run/secrets/omniroute_management_api_key` — exists and is readable by `celes` (`root:wheel`, mode `0440`). Its contents were not printed.
- Backup root: `/home/celes/.local/state/omniroute-routing` — created/confirmed as a writable directory (`celes:users`, mode `0700`).

## Management API access

The host already has a `kubectl` listener bound to loopback on `127.0.0.1:20128` and `[::1]:20128`. Authenticated probes through it returned HTTP 200 for `/healthz`, `/v1/models`, `/api/providers`, `/api/combos`, and `/api/pricing`.

If the existing forward is unavailable, establish host access in one terminal:

```sh
kubectl -n omniroute port-forward service/omniroute 20128:20128
```

Then invoke the management API from the remote host without displaying the key:

```sh
curl -sS -H "Authorization: Bearer $(cat /run/secrets/omniroute_management_api_key)" http://127.0.0.1:20128/api/providers
```

Equivalent templates can replace `/api/providers` with another management route such as `/api/combos` or `/api/pricing`.

## Missing or surprising items

- Nothing required is missing.
- Kubernetes service DNS did not resolve from the host during the check, as expected for host-side access to a ClusterIP service; the loopback port-forward is the confirmed access method.
- A port-forward was already active, although its process command line exposed only `kubectl` in `ps`; reachability and the Kubernetes service/endpoint mapping were independently confirmed.
