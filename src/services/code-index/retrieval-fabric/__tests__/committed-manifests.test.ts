// Feature: retrieval-fabric
//
// Config-assertion gate over the committed declarative manifests at
// `sources/kube/omniroute-memory/`. This test is the drift tripwire for the
// retrieval fabric's serving tier: it parses the real committed YAML and
// asserts the digest pin, embedding topology, Qwen3 reranker (replacing the
// uncommitted `bge-reranker-base` drift), the dual-path real-inference
// readiness probes, and the serving-ceiling-coupled pod memory limit.
//
// Property 1 (dual-path real-inference readiness): the readiness probes MUST be
// `exec` probes running the committed real-inference scripts — NOT an
// `httpGet /v2/health/ready` readiness probe alone — so a wedged GPU serving
// path removes a replica from rotation even while `/v2/health/ready` is green.
//
// Requirements: 1.1-1.8, 2.1-2.3, 3.1, 3.2, 3.4, 5.1, 5.5, 6.6, 21.1, 21.2, 21.3

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { parse } from "yaml"
import { describe, it, expect, beforeAll } from "vitest"

// Resolve the committed manifests directory from this test file's location.
// The repo root is the Menagerie workspace root; Vitest runs with `--dir src`
// so cwd is `src/`, hence we resolve from __dirname rather than cwd.
const MANIFESTS_DIR = path.resolve(__dirname, "../../../../../sources/kube/omniroute-memory")

const DIGEST_PIN =
	"docker.io/openvino/model_server@sha256:e7a448ec4eb885cab232a5f5ff8b9f41fb3b6f69401633c2af83cac260c40e8e"
const MUTABLE_TAG = "openvino/model_server:latest-gpu"

const EMBEDDINGS_FILE = "ovms-embeddings-statefulset.yaml"
const RERANKER_FILE = "ovms-reranker-deployment.yaml"
const READINESS_FILE = "ovms-readiness-scripts-configmap.yaml"

interface Container {
	name?: string
	image?: string
	args?: string[]
	command?: string[]
	readinessProbe?: Record<string, unknown>
	livenessProbe?: Record<string, unknown>
	resources?: {
		limits?: Record<string, string>
		requests?: Record<string, string>
	}
}

interface PodSpec {
	containers?: Container[]
	initContainers?: Container[]
	nodeSelector?: Record<string, string>
	affinity?: Record<string, unknown>
	securityContext?: Record<string, unknown>
	volumes?: Array<Record<string, unknown>>
}

interface WorkloadManifest {
	kind?: string
	spec?: {
		replicas?: number
		podManagementPolicy?: string
		template?: { spec?: PodSpec }
		volumeClaimTemplates?: Array<Record<string, unknown>>
	}
}

function readManifest(file: string): string {
	const full = path.join(MANIFESTS_DIR, file)
	if (!existsSync(full)) {
		throw new Error(`Committed manifest not found (live-only drift?): ${full}`)
	}
	return readFileSync(full, "utf8")
}

function parseManifest<T>(file: string): T {
	return parse(readManifest(file)) as T
}

function findContainer(spec: PodSpec | undefined, name: string): Container {
	const container = spec?.containers?.find((c) => c.name === name)
	expect(container, `container "${name}" present`).toBeDefined()
	return container as Container
}

function findInitContainer(spec: PodSpec | undefined, name: string): Container {
	const container = spec?.initContainers?.find((c) => c.name === name)
	expect(container, `init container "${name}" present`).toBeDefined()
	return container as Container
}

describe("committed omniroute-memory manifests (retrieval-fabric config gate)", () => {
	beforeAll(() => {
		// VERIFY the resolved manifests directory exists at runtime; a missing
		// directory would mean the committed config is live-only drift.
		expect(existsSync(MANIFESTS_DIR), `manifests dir resolves: ${MANIFESTS_DIR}`).toBe(true)
	})

	describe("embedding StatefulSet (Req 1, 2, 6.6, 21)", () => {
		let manifest: WorkloadManifest
		let podSpec: PodSpec | undefined
		let ovms: Container
		let modelPull: Container

		beforeAll(() => {
			manifest = parseManifest<WorkloadManifest>(EMBEDDINGS_FILE)
			podSpec = manifest.spec?.template?.spec
			ovms = findContainer(podSpec, "ovms")
			modelPull = findInitContainer(podSpec, "model-pull")
		})

		it("is a StatefulSet committed as a file", () => {
			expect(manifest.kind).toBe("StatefulSet")
		})

		// Req 2.1 / 21: the live digest pin on BOTH the serving container and the
		// model-pull init container, and NEVER the mutable latest-gpu tag.
		it("pins the ovms container image to the live digest, never latest-gpu", () => {
			expect(ovms.image).toBe(DIGEST_PIN)
			expect(ovms.image).not.toContain("latest-gpu")
			expect(ovms.image).not.toBe(MUTABLE_TAG)
		})

		it("pins the model-pull init-container image to the same digest, never latest-gpu", () => {
			expect(modelPull.image).toBe(DIGEST_PIN)
			expect(modelPull.image).not.toContain("latest-gpu")
			expect(modelPull.image).not.toBe(MUTABLE_TAG)
		})

		// Req 1.3: no `image:` line references the mutable latest-gpu tag. (The
		// explanatory comments may mention the tag by name to document the pin;
		// we assert against actual image references, not prose.)
		it("has no latest-gpu image reference anywhere in the manifest", () => {
			const imageLines = readManifest(EMBEDDINGS_FILE)
				.split("\n")
				.filter((line) => /^\s*image:/.test(line))
			expect(imageLines.length).toBeGreaterThan(0)
			for (const line of imageLines) {
				expect(line).not.toContain("latest-gpu")
			}
		})

		// Req 1.4 / 2.2: topology preserved.
		it("preserves replicas: 4 and Parallel pod management", () => {
			expect(manifest.spec?.replicas).toBe(4)
			expect(manifest.spec?.podManagementPolicy).toBe("Parallel")
		})

		it("requires hostname anti-affinity over app=ovms-embeddings", () => {
			const affinity = podSpec?.affinity as
				| {
						podAntiAffinity?: {
							requiredDuringSchedulingIgnoredDuringExecution?: Array<{
								labelSelector?: { matchLabels?: Record<string, string> }
								topologyKey?: string
							}>
						}
				  }
				| undefined
			const required = affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution
			expect(required, "required (not preferred) anti-affinity").toBeDefined()
			const rule = required?.[0]
			expect(rule?.topologyKey).toBe("kubernetes.io/hostname")
			expect(rule?.labelSelector?.matchLabels?.app).toBe("ovms-embeddings")
		})

		it("requests and limits a single Intel i915 GPU with the GPU nodeSelector", () => {
			expect(ovms.resources?.limits?.["gpu.intel.com/i915"]).toBe("1")
			expect(ovms.resources?.requests?.["gpu.intel.com/i915"]).toBe("1")
			expect(podSpec?.nodeSelector?.["intel.feature.node.kubernetes.io/gpu"]).toBe("true")
		})

		it("declares a Longhorn 10Gi ReadWriteOnce models volumeClaimTemplate", () => {
			const vct = manifest.spec?.volumeClaimTemplates?.[0] as
				| {
						metadata?: { name?: string }
						spec?: {
							accessModes?: string[]
							storageClassName?: string
							resources?: { requests?: { storage?: string } }
						}
				  }
				| undefined
			expect(vct?.metadata?.name).toBe("models")
			expect(vct?.spec?.accessModes).toContain("ReadWriteOnce")
			expect(vct?.spec?.storageClassName).toBe("longhorn")
			expect(vct?.spec?.resources?.requests?.storage).toBe("10Gi")
		})

		it("runs the pod with fsGroup 5000", () => {
			expect(podSpec?.securityContext?.fsGroup).toBe(5000)
		})

		// Req 2.3: serving container + model-pull args preserved.
		it("passes the embedding model name and path to the serving container", () => {
			expect(ovms.args).toContain("--model_name=qwen3-embedding-0.6b")
			expect(ovms.args).toContain("--model_path=/models/OpenVINO/Qwen3-Embedding-0.6B-int8-ov")
		})

		it("passes the embedding pull args to the model-pull init container", () => {
			expect(modelPull.args).toContain("--source_model=OpenVINO/Qwen3-Embedding-0.6B-int8-ov")
			expect(modelPull.args).toContain("--task=embeddings")
			expect(modelPull.args).toContain("--pooling=LAST")
			expect(modelPull.args).toContain("--target_device=GPU")
		})

		// Property 1 / Req 5.1, 5.5, 22.9: readiness is the real-inference exec
		// probe, NOT an httpGet /v2/health/ready readiness probe; liveness HTTP is
		// retained so load-spreading is not destabilized.
		it("uses the real-inference exec readiness probe, not httpGet /v2/health/ready", () => {
			const readiness = ovms.readinessProbe as
				| { exec?: { command?: string[] }; httpGet?: { path?: string } }
				| undefined
			expect(readiness?.exec?.command).toEqual(["/opt/readiness/embed-probe.sh"])
			expect(readiness?.httpGet).toBeUndefined()
		})

		it("retains the httpGet /v2/health/live liveness probe", () => {
			const liveness = ovms.livenessProbe as { httpGet?: { path?: string } } | undefined
			expect(liveness?.httpGet?.path).toBe("/v2/health/live")
		})

		// Req 6.6: pod memory limit sized together with the serving ceiling, above
		// the legacy 8Gi.
		it("sets the pod memory limit to 10Gi, coupled to the serving ceiling", () => {
			expect(ovms.resources?.limits?.memory).toBe("10Gi")
			expect(ovms.resources?.limits?.memory).not.toBe("8Gi")
		})
	})

	describe("reranker Deployment (Req 3, 4.1, 5.3, 6.6, 21)", () => {
		let manifest: WorkloadManifest
		let podSpec: PodSpec | undefined
		let ovms: Container
		let modelPull: Container
		let chownInit: Container

		beforeAll(() => {
			manifest = parseManifest<WorkloadManifest>(RERANKER_FILE)
			podSpec = manifest.spec?.template?.spec
			ovms = findContainer(podSpec, "ovms")
			modelPull = findInitContainer(podSpec, "model-pull")
			chownInit = findInitContainer(podSpec, "model-volume-permissions")
		})

		// Req 3.1 / 3.4: the reranker is committed as a file.
		it("is a Deployment committed as a file", () => {
			expect(manifest.kind).toBe("Deployment")
		})

		// Req 3.1 / 3.2: the model is Qwen3-Reranker-0.6b, OVMS-native, and NEVER
		// the uncommitted bge-reranker-base drift.
		it("serves qwen3-reranker-0.6b, OVMS-native, via the serving container args", () => {
			expect(ovms.args).toContain("--model_name=qwen3-reranker-0.6b")
			expect(ovms.args).toContain("--model_path=/models/OpenVINO/Qwen3-Reranker-0.6B-int8-ov")
		})

		it("pulls the Qwen3 reranker model with task=rerank on GPU", () => {
			expect(modelPull.args).toContain("--source_model=OpenVINO/Qwen3-Reranker-0.6B-int8-ov")
			expect(modelPull.args).toContain("--task=rerank")
			expect(modelPull.args).toContain("--target_device=GPU")
		})

		it("has no bge-reranker-base reference anywhere in the raw file", () => {
			expect(readManifest(RERANKER_FILE).toLowerCase()).not.toContain("bge-reranker")
		})

		// Req 21: same digest pin, never latest-gpu.
		it("pins the serving and model-pull images to the same digest, never latest-gpu", () => {
			expect(ovms.image).toBe(DIGEST_PIN)
			expect(modelPull.image).toBe(DIGEST_PIN)
			const imageLines = readManifest(RERANKER_FILE)
				.split("\n")
				.filter((line) => /^\s*image:/.test(line))
			expect(imageLines.length).toBeGreaterThan(0)
			for (const line of imageLines) {
				expect(line).not.toContain("latest-gpu")
			}
		})

		// Property 1 / Req 5.3: readiness is the dual-path real-inference exec
		// probe, not httpGet-only.
		it("uses the real-inference rerank exec readiness probe, not httpGet-only", () => {
			const readiness = ovms.readinessProbe as
				| { exec?: { command?: string[] }; httpGet?: { path?: string } }
				| undefined
			expect(readiness?.exec?.command).toEqual(["/opt/readiness/rerank-probe.sh"])
			expect(readiness?.httpGet).toBeUndefined()
		})

		it("requests an Intel i915 GPU with the GPU nodeSelector", () => {
			expect(ovms.resources?.requests?.["gpu.intel.com/i915"]).toBe("1")
			expect(ovms.resources?.limits?.["gpu.intel.com/i915"]).toBe("1")
			expect(podSpec?.nodeSelector?.["intel.feature.node.kubernetes.io/gpu"]).toBe("true")
		})

		it("runs the pod with fsGroup 5000 and a chown init container", () => {
			expect(podSpec?.securityContext?.fsGroup).toBe(5000)
			expect(chownInit.command).toEqual(["sh", "-c", "chown -R 5000:5000 /models"])
		})

		it("mounts the reranker-models PVC claim", () => {
			const volumes = podSpec?.volumes ?? []
			const modelsVolume = volumes.find((v) => (v as { name?: string }).name === "models") as
				| { persistentVolumeClaim?: { claimName?: string } }
				| undefined
			expect(modelsVolume?.persistentVolumeClaim?.claimName).toBe("reranker-models")
		})

		// Req 6.6: pod memory coupled to the serving ceiling, same as embedding.
		it("sets the pod memory limit to 10Gi, coupled to the serving ceiling", () => {
			expect(ovms.resources?.limits?.memory).toBe("10Gi")
		})
	})

	describe("readiness scripts ConfigMap (Req 5.5 — committed as files, not drift)", () => {
		let manifest: { kind?: string; data?: Record<string, string> }

		beforeAll(() => {
			manifest = parseManifest<{ kind?: string; data?: Record<string, string> }>(READINESS_FILE)
		})

		it("is a ConfigMap carrying both probe scripts as committed files", () => {
			expect(manifest.kind).toBe("ConfigMap")
			expect(manifest.data).toBeDefined()
			expect(Object.keys(manifest.data ?? {})).toEqual(
				expect.arrayContaining(["embed-probe.sh", "rerank-probe.sh"]),
			)
		})

		// Property 1: the probes issue REAL inference requests, so a wedged GPU
		// path is caught even when /v2/health/ready is green.
		it("embed-probe.sh issues a real embedding request", () => {
			const script = manifest.data?.["embed-probe.sh"] ?? ""
			expect(script).toContain("/v3/embeddings")
			expect(script).toContain("qwen3-embedding-0.6b")
		})

		it("rerank-probe.sh issues a real rerank request", () => {
			const script = manifest.data?.["rerank-probe.sh"] ?? ""
			expect(script).toContain("/v3/rerank")
			expect(script).toContain("qwen3-reranker-0.6b")
		})
	})
})
