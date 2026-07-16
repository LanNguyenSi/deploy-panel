---
type: module
title: VPS onboarding and relay provisioning — TOFU-then-pin, SSRF-guarded, concurrency-locked
description: probeVps captures a SHA-256 host-key fingerprint on first contact and install/re-install pin against it (mismatch = host_key_rejected); non-admin probe/install requests get an SSRF guard plus a 5-req/60s rate limit while admins may target arbitrary hosts; persisted install metadata on Server drives re-install/update-image so they don't clobber hand-customized setups, guarded by per-server/per-actor concurrency locks.
tags: [ssh, onboarding, relay, security, module]
timestamp: 2026-07-16T05:46:15Z
sources:
  - backend/src/services/ssh-executor.ts
  - backend/src/services/install-relay.ts
  - backend/src/services/probe-vps.ts
  - backend/src/services/probe-guard.ts
  - backend/src/services/active-installs.ts
  - backend/prisma/schema.prisma
  - backend/src/routes/servers.ts
---

## TOFU-then-pin host-key model

Onboarding a new VPS is a two-step handshake, not a single connect: `POST /api/servers/probe-vps` runs a read-only diagnostic first, then `POST /api/servers/install-relay` runs the real install. Both go through `executeSshCommand` (`backend/src/services/ssh-executor.ts:283-376`) with `acceptAnyHostKey: true` — trust-on-first-use, since a containerized backend typically has an empty `known_hosts`.

`probeVps` (`backend/src/services/probe-vps.ts:249-282`) captures the SHA-256 fingerprint of whatever host key the probe connection presents, via the `onHostKey` callback wired into `hostVerifier` (ssh-executor.ts:219-244), and returns it as `hostKeySha256` on the outcome. The install route (`routes/servers.ts`) echoes this value back as `expectedHostKeySha256` in the install request and passes it through to `executeSshCommand` (routes/servers.ts:572-574), which then PINS: `buildConnectConfig`'s `hostVerifier` (ssh-executor.ts:219-244) rejects the handshake if the presented key's fingerprint doesn't match the pinned value, flagging `_hostKeyMismatch` on the config so `classifyConnectionError` (ssh-executor.ts:116-137) surfaces it as `SshError` with `kind: "host_key_rejected"` rather than a generic `connect_failed`. A MITM or DNS hijack that swaps hosts between the probe and the install call trips this — the install aborts before `install.sh` ever runs on the wrong box.

Re-install (`POST /api/servers/:id/install-relay`) does the same pin, but sourced from the persisted `Server.hostKeySha256` rather than a fresh probe (routes/servers.ts:826-827); legacy rows created before this field existed carry `null` and fall back to TOFU, capturing the fingerprint on that re-install for next time (routes/servers.ts:839-842).

## Non-admin actors are SSRF-guarded and rate-limited; admins are not

`probe-guard.ts` exists specifically because the probe and install routes accept an arbitrary `host:port` from the request body and open a real SSH connection to it — fine for an admin, but an open internal-network prober for a broker-issued non-admin actor (probe-guard.ts:1-19 doc comment). Two independent mitigations, both skipped when `actor.isAdmin`:

- **Resolve-and-check.** `assertHostAllowedForNonAdmin` (probe-guard.ts:86-102) rejects a literal private/loopback/link-local/IPv6-ULA/IPv4-mapped address up front via `isPrivateOrLoopbackHost` (probe-guard.ts:21-70), then resolves the hostname through `dns.lookup` and re-checks EVERY returned address — catching DNS-rebinding-style attacks where the hostname itself looks public but resolves to internal space. A DNS-lookup failure passes through as allowed (the SSH connect timeout is the backstop), which is a deliberate fail-open distinct from the stricter fail-closed posture `post-deploy-gate.ts`'s route probe uses for the same private-host check.
- **Sliding-window rate limit.** `consumeProbeQuota` (probe-guard.ts:130-141) caps a non-admin actor at 5 probe calls per 60-second window, keyed by `actor.userId`, in-memory only (single-instance; a multi-replica deploy is a known follow-up per the module doc comment).

Both `POST /api/servers/probe-vps` and `POST /api/servers/install-relay` apply the SAME `assertHostAllowedForNonAdmin` check (routes/servers.ts:360-361, :477-478) — the install route re-checks rather than trusting the probe's earlier check, so a non-admin can't bypass the guard by skipping straight to install.

## Persisted install metadata: re-install and update-image must not clobber hand-customization

`Server` persists four install-time facts (`backend/prisma/schema.prisma:14-47`): `hostKeySha256` (above), `relayMode` (the resolved `greenfield` / `existing-traefik` / `port-only` mode `install.sh` reports), `relayDir` (the VPS path holding the relay's compose file, defaulting to `/opt/agent-relay` when unset), and `relayComposeFile` (the compose filename, for operators who installed a customized prod override with `container_name: agent-relay` + Traefik labels rather than the installer default). Re-install and update-image read these back as defaults (`routes/servers.ts:760-778`) rather than assuming the installer default every time — an operator who manually customized `relayDir` or the compose filename would otherwise have that customization silently overwritten by a re-install or image-update call using the wrong path/file.

## Per-server / per-actor concurrency locks

`active-installs.ts`'s `activeInstalls` Set (a single in-memory registry, same single-instance caveat as the rate limiter) is keyed by operation-and-target strings: `reinstall:<serverId>`, `update-image:<serverId>`, plus per-actor keys. `isServerMutating` (active-installs.ts:24-29) checks only the per-server keys — re-install and update-image both mutate the same relay container, so an in-flight one of either blocks the other on the SAME server (routes/servers.ts:715-733, the "Two locks" comment), while re-installs of two DIFFERENT servers proceed in parallel. The per-actor key additionally rate-limits one actor to one in-flight install/re-install at a time regardless of target server (routes/servers.ts:514-521).

## What breaks it

- Any new route that opens an SSH connection to a caller-supplied host without going through `executeSshCommand`'s host-key handling AND, for non-admin callers, `assertHostAllowedForNonAdmin` — both the pin and the SSRF guard live in that path only.
- Skipping the install route's own `assertHostAllowedForNonAdmin` call on the assumption the probe already checked it — the two calls are for two different requests and neither trusts the other.
- Re-install or update-image defaulting `relayDir`/`relayComposeFile` to the installer default instead of the persisted `Server` value — that is exactly the hand-customized-setup clobber this metadata exists to prevent.
- Adding a new mutating install-family route without registering it in `active-installs.ts` under a per-server key — it would run concurrently with re-install/update-image against the same relay container with no lock.
