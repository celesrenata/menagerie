import { useEffect, useState } from "react"
import {
	DEFAULT_SKILL_HUB_ENABLED,
	DEFAULT_SKILL_HUB_MAX_SKILLS,
	SKILL_HUB_SKILL_MODES,
	type SkillHubSkillMode,
} from "@roo-code/types"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { vscode } from "@/utils/vscode"
import { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import { SetCachedStateField } from "./types"

interface HubCatalogEntry {
	id: string
	name: string
	description: string
}

interface SkillHubSettingsProps {
	skillHubEnabled?: boolean
	skillHubBaseUrl?: string
	skillHubMaxSkills?: number
	skillHubSkillModes?: Record<string, SkillHubSkillMode>
	/** Write-only edit buffer. Empty means "keep the stored key". */
	skillHubApiKey?: string
	skillHubApiKeySet?: boolean
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

const MODE_LABELS: Record<SkillHubSkillMode, string> = {
	on: "On (always offered)",
	off: "Off (never offered)",
	auto: "Auto (offered when relevant)",
}

const inputClass =
	"w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1"

/**
 * OmniRoute Skill Hub controls. Every input reads and writes the SettingsView `cachedState` through
 * `setCachedStateField`; nothing here touches live extension state, so edits stay buffered until Save.
 */
export const SkillHubSettings = ({
	skillHubEnabled,
	skillHubBaseUrl,
	skillHubMaxSkills,
	skillHubSkillModes,
	skillHubApiKey,
	skillHubApiKeySet,
	setCachedStateField,
}: SkillHubSettingsProps) => {
	const enabled = skillHubEnabled ?? DEFAULT_SKILL_HUB_ENABLED
	const modes = skillHubSkillModes ?? {}
	const [catalog, setCatalog] = useState<HubCatalogEntry[]>([])
	const [error, setError] = useState<string | undefined>()

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "skillHubCatalog") {
				return
			}
			setCatalog(Array.isArray(message.skillHubCatalog) ? message.skillHubCatalog : [])
			setError(typeof message.skillHubCatalogError === "string" ? message.skillHubCatalogError : undefined)
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	useEffect(() => {
		if (enabled && skillHubApiKeySet) {
			vscode.postMessage({ type: "requestSkillHubCatalog" })
		}
	}, [enabled, skillHubApiKeySet])

	const setMode = (id: string, mode: SkillHubSkillMode) => {
		const next = { ...modes }
		if (mode === "auto") {
			delete next[id]
		} else {
			next[id] = mode
		}
		setCachedStateField("skillHubSkillModes", next)
	}

	return (
		<div className="flex flex-col gap-3 mt-6" data-testid="skill-hub-settings">
			<h3 className="font-medium text-vscode-foreground m-0">OmniRoute Skill Hub</h3>
			<VSCodeCheckbox
				checked={enabled}
				onChange={(e: any) => setCachedStateField("skillHubEnabled", e.target.checked)}
				data-testid="skill-hub-enabled-checkbox">
				<span className="font-medium">Use skills from the hub</span>
			</VSCodeCheckbox>
			<div className="text-vscode-descriptionForeground text-sm">
				Manual On and Off always win. Auto skills fill the remaining slots with hub matches for the current
				task.
			</div>

			<label className="flex flex-col gap-1">
				<span className="font-medium">Hub URL</span>
				<input
					type="url"
					className={inputClass}
					value={skillHubBaseUrl ?? ""}
					placeholder="Blank uses the OmniRoute profile's origin"
					disabled={!enabled}
					onChange={(e) => setCachedStateField("skillHubBaseUrl", e.target.value)}
					data-testid="skill-hub-url-input"
				/>
			</label>

			<label className="flex flex-col gap-1">
				<span className="font-medium">Skill Hub key</span>
				<input
					type="password"
					autoComplete="off"
					className={inputClass}
					value={skillHubApiKey ?? ""}
					placeholder={skillHubApiKeySet ? "Key saved. Type to replace it." : "Paste a Skill Hub key"}
					disabled={!enabled}
					onChange={(e) => setCachedStateField("skillHubApiKey", e.target.value)}
					data-testid="skill-hub-key-input"
				/>
				<span className="text-vscode-descriptionForeground text-sm">
					Use a separate OmniRoute key with the read:catalog scope (needs an OmniRoute build with Skill Hub
					scopes), not your inference key. It is stored as a secret and never shown again.
				</span>
				{skillHubApiKeySet && (
					<button
						type="button"
						className="self-start text-vscode-textLink-foreground underline"
						disabled={!enabled}
						onClick={() => vscode.postMessage({ type: "clearSkillHubApiKey" })}
						data-testid="skill-hub-remove-key">
						Remove saved key
					</button>
				)}
			</label>

			<label className="flex flex-col gap-1">
				<span className="font-medium">Skills offered per task</span>
				<input
					type="number"
					min={0}
					max={50}
					className={inputClass}
					value={skillHubMaxSkills ?? DEFAULT_SKILL_HUB_MAX_SKILLS}
					disabled={!enabled}
					onChange={(e) => {
						const parsed = parseInt(e.target.value, 10)
						setCachedStateField(
							"skillHubMaxSkills",
							Number.isNaN(parsed) ? DEFAULT_SKILL_HUB_MAX_SKILLS : parsed,
						)
					}}
					data-testid="skill-hub-max-input"
				/>
			</label>

			{enabled && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<span className="font-medium">Hub skills</span>
						<button
							type="button"
							className="text-vscode-textLink-foreground underline"
							onClick={() => vscode.postMessage({ type: "requestSkillHubCatalog" })}
							data-testid="skill-hub-refresh">
							Refresh
						</button>
					</div>
					{error && (
						<div role="alert" className="text-vscode-errorForeground text-sm" data-testid="skill-hub-error">
							{error}
						</div>
					)}
					{!error && catalog.length === 0 && (
						<div className="text-vscode-descriptionForeground text-sm">
							No hub skills loaded. Save a key, then refresh.
						</div>
					)}
					{catalog.map((skill) => (
						<div key={skill.id} className="flex items-center justify-between gap-2">
							<div className="min-w-0">
								<div className="font-medium truncate">{skill.name}</div>
								<div className="text-vscode-descriptionForeground text-sm truncate">
									{skill.description}
								</div>
							</div>
							<select
								className="bg-vscode-dropdown-background text-vscode-dropdown-foreground border border-vscode-dropdown-border rounded px-1 py-1"
								aria-label={`Mode for ${skill.name}`}
								value={modes[skill.id] ?? "auto"}
								onChange={(e) => setMode(skill.id, e.target.value as SkillHubSkillMode)}
								data-testid={`skill-hub-mode-${skill.id}`}>
								{SKILL_HUB_SKILL_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{MODE_LABELS[mode]}
									</option>
								))}
							</select>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
